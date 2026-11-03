/**
 * Monobank personal API (https://api.monobank.ua/docs/).
 *
 * Options:
 *   token            — personal X-Token from https://api.monobank.ua/ (required)
 *   history_days     — how far back the first import goes (default 31)
 *   accounts         — optional filter: list of account ids, IBANs or last 4 card digits
 *   jars             — sync jars ("банки") as savings accounts (default true)
 *   categories       — sort card spending into Wealthfolio's categories by MCC (default true)
 *
 * Cards become TRANSACTIONS-mode cash accounts: every statement item is imported
 * once (WITHDRAWAL / DEPOSIT, or TRANSFER_* for moves between your own cards and
 * jars). Balances are own funds: credit limit is subtracted.
 *
 * The API allows one request per 60 s per token, so a first import of
 * several cards takes a few minutes.
 */

import { fromUnits } from '../decimal.ts';
import { HttpError, request, sleep } from '../http.ts';
import { num } from '../json.ts';
import {
	type AccountData,
	type CashTransaction,
	HoldingsSnapshot,
	type SpendingRule,
} from '../models.ts';
import { Connector } from './base.ts';
import { MCC_RULES, mccTag } from './mcc.ts';

const API = 'https://api.monobank.ua';
const MIN_INTERVAL_MS = 61_000;
const MAX_WINDOW_S = 31 * 24 * 3600; // API limit: 31 days + 1 hour
const IDLE_LOOKBACK_S = 7 * 24 * 3600; // well inside one window, so an idle card costs one request
const PAGE_LIMIT = 500;

export const CURRENCIES: Record<number, string> = {
	980: 'UAH',
	840: 'USD',
	978: 'EUR',
	985: 'PLN',
	826: 'GBP',
	756: 'CHF',
	203: 'CZK',
	949: 'TRY',
	398: 'KZT',
	981: 'GEL',
	124: 'CAD',
	392: 'JPY',
};

export interface MonoAccount {
	id: string;
	sendId?: string;
	balance: number;
	creditLimit: number;
	type: string;
	currencyCode: number;
	maskedPan?: string[];
	iban?: string;
}

export interface MonoJar {
	id: string;
	title: string;
	currencyCode: number;
	balance: number;
	goal?: number;
}

export interface MonoStatementItem {
	id: string;
	time: number;
	description: string;
	mcc: number;
	originalMcc?: number;
	hold: boolean;
	amount: number;
	operationAmount: number;
	currencyCode: number;
	commissionRate: number;
	cashbackAmount: number;
	balance: number;
	comment?: string;
	counterIban?: string;
	counterName?: string;
}

const JAR_RE = /^(на банку|з банки|поповнення банки|to jar|from jar)/i;

export class MonobankConnector extends Connector {
	private ownIbans = new Set<string>();
	/** Set by fetch(); committed by onSynced() after Wealthfolio accepted the data. */
	private pendingCursors: Record<string, number> = {};

	// api_url / min_interval_ms exist for tests and proxies; defaults match the real API.
	private get apiBase(): string {
		return this.optional<string>('api_url', API).replace(/\/+$/, '');
	}

	private get minInterval(): number {
		return this.optional<number>('min_interval_ms', MIN_INTERVAL_MS);
	}

	private get categories(): boolean {
		return this.optional<boolean>('categories', true);
	}

	override spendingRules(): SpendingRule[] {
		return this.categories ? MCC_RULES : [];
	}

	private async api<T>(path: string): Promise<T> {
		// Persisted so restarts and daemon loops respect the limiter too.
		const last = num(this.ctx.state.lastCallAt) ?? 0;
		const wait = last + this.minInterval - Date.now();
		if (wait > 0) {
			this.log.debug(`rate limit: waiting ${Math.ceil(wait / 1000)}s`);
			await sleep(wait);
		}
		for (let attempt = 0; ; attempt++) {
			this.ctx.state.lastCallAt = Date.now();
			this.ctx.saveState();
			const res = await request(`${this.apiBase}${path}`, {
				headers: { 'X-Token': this.opt('token') },
				retries: 1,
				retryOn429: false,
			});
			const text = await res.text();
			if (res.status === 429 && attempt < 2) {
				this.log.warn('Monobank 429 (too many requests), retrying after the rate-limit interval');
				await sleep(this.minInterval);
				continue;
			}
			if (!res.ok) throw new HttpError(res.status, text, `${this.apiBase}${path}`);
			return JSON.parse(text) as T;
		}
	}

	async fetch(): Promise<AccountData[]> {
		const info = await this.api<{ accounts: MonoAccount[]; jars?: MonoJar[] }>(
			'/personal/client-info',
		);
		const filter = this.optional<string[] | undefined>('accounts', undefined);
		const accounts = info.accounts.filter(
			(a) => !filter || filter.some((f) => matchesAccount(a, f)),
		);
		this.ownIbans = new Set(
			info.accounts.map((a) => a.iban).filter((x): x is string => Boolean(x)),
		);

		const out: AccountData[] = [];
		const cursors = this.stored<Record<string, number>>('cursors', () => ({}));
		const historyDays = this.optional<number>('history_days', 31);
		const now = Math.floor(Date.now() / 1000);

		for (const acc of accounts) {
			const currency = CURRENCIES[acc.currencyCode] ?? String(acc.currencyCode);
			const from = cursors[acc.id] ? cursors[acc.id]! - 3600 : now - historyDays * 86400;
			const items = await this.statement(acc.id, from, now);
			const latest = items.reduce((m, it) => Math.max(m, it.time), cursors[acc.id] ?? 0);
			// Everything up to now was read. Without a floor an idle card reads back to its last
			// operation, or its whole history, every pass, at one request a minute.
			this.pendingCursors[acc.id] = Math.max(latest, now - IDLE_LOOKBACK_S);

			out.push({
				key: `${this.id}:${acc.id}`,
				name: this.displayName('Monobank') + ' ' + accountLabel(acc, currency),
				currency,
				accountType: 'CASH',
				group: 'Banks',
				transactions: items.map((it) => this.toTransaction(it, acc, currency)),
				currentBalance: fromUnits(acc.balance - acc.creditLimit, 2),
			});
		}

		if (this.optional<boolean>('jars', true)) {
			for (const jar of info.jars ?? []) {
				const currency = CURRENCIES[jar.currencyCode] ?? String(jar.currencyCode);
				const snap = new HoldingsSnapshot();
				snap.addCash(currency, fromUnits(jar.balance, 2));
				out.push({
					key: `${this.id}:jar:${jar.id}`,
					name: `${this.displayName('Monobank')} банка «${jar.title}»`,
					currency,
					accountType: 'CASH',
					group: 'Savings',
					holdings: snap,
				});
			}
		}
		return out;
	}

	/** Statement for [from, to], split into ≤31-day windows and paged by 500. Oldest first. */
	async statement(accountId: string, from: number, to: number): Promise<MonoStatementItem[]> {
		const byId = new Map<string, MonoStatementItem>();
		let windowEnd = to;
		while (windowEnd > from) {
			const windowStart = Math.max(from, windowEnd - MAX_WINDOW_S);
			let pageEnd = windowEnd;
			for (;;) {
				const page = await this.api<MonoStatementItem[]>(
					`/personal/statement/${accountId}/${windowStart}/${pageEnd}`,
				);
				for (const it of page) byId.set(it.id, it);
				if (page.length < PAGE_LIMIT) break;
				// Items come newest first; continue below the oldest one (same second re-fetched, deduped by id).
				const oldest = Math.min(...page.map((p) => p.time));
				if (oldest >= pageEnd) break;
				pageEnd = oldest;
			}
			windowEnd = windowStart;
		}
		// Map keeps first-seen order, which is the API's newest-first order across windows and
		// pages. Reversing it keeps same-second operations (a purchase and its fee) in their real
		// order; the stable sort only guards against window overlap.
		return [...byId.values()].reverse().sort((a, b) => a.time - b.time);
	}

	private toTransaction(
		it: MonoStatementItem,
		acc: MonoAccount,
		currency: string,
	): CashTransaction {
		const isOwnTransfer =
			(it.counterIban && this.ownIbans.has(it.counterIban)) || JAR_RE.test(it.description);
		const note = [it.description, it.comment].filter(Boolean).join(' — ');
		return {
			id: it.id,
			time: new Date(it.time * 1000),
			amount: fromUnits(it.amount, 2),
			currency,
			description: this.categories ? `${note} ${mccTag(it.mcc)}` : note,
			balanceAfter: fromUnits(it.balance - acc.creditLimit, 2),
			mcc: it.mcc,
			metadata: {
				hold: it.hold,
				mcc: it.mcc,
				operationAmount: fromUnits(it.operationAmount, 2),
				operationCurrency: CURRENCIES[it.currencyCode] ?? it.currencyCode,
				cashback: fromUnits(it.cashbackAmount, 2),
				commission: fromUnits(it.commissionRate, 2),
				counterName: it.counterName,
				...(isOwnTransfer
					? {
							transfer: true,
							transferGroup: `monobank:${Math.floor(it.time / 60)}:${Math.abs(it.amount)}`,
						}
					: {}),
			},
		};
	}

	/** Engine calls this after the data was written to Wealthfolio. */
	override onSynced(): void {
		Object.assign(
			this.stored<Record<string, number>>('cursors', () => ({})),
			this.pendingCursors,
		);
		this.pendingCursors = {};
	}
}

export function matchesAccount(a: MonoAccount, filter: string): boolean {
	const f = filter.replace(/\s/g, '');
	return (
		a.id === f ||
		a.iban === f ||
		(a.maskedPan ?? []).some((p) => p.endsWith(f.slice(-4)) && /^\d{4}$/.test(f))
	);
}

function accountLabel(acc: MonoAccount, currency: string): string {
	const pan = acc.maskedPan?.[0];
	const last4 = pan
		? `*${pan.slice(-4)}`
		: acc.iban
			? `…${acc.iban.slice(-4)}`
			: acc.id.slice(0, 6);
	return `${acc.type} ${currency} ${last4}`;
}
