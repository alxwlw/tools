/** Thin client for the Wealthfolio self-hosted REST API (/api/v1). */

import { HttpError, request } from './http.ts';
import { arr, path, str } from './json.ts';
import type { Logger } from './log.ts';

export interface WfAccount {
	id: string;
	name: string;
	accountType: string;
	currency: string;
	provider?: string | null;
	providerAccountId?: string | null;
	trackingMode?: string;
	isActive?: boolean;
	isArchived?: boolean;
}

export interface WfAsset {
	id: string;
	kind: string;
	displayCode?: string | null;
	instrumentSymbol?: string | null;
	instrumentType?: string | null;
	quoteMode: 'MARKET' | 'MANUAL';
	quoteCcy: string;
	name?: string | null;
}

export interface NewWfActivity {
	accountId: string;
	activityType: string;
	subtype?: string;
	activityDate: string;
	amount: string;
	currency: string;
	notes?: string;
	metadata?: string;
	needsReview?: boolean;
	sourceSystem: string;
	sourceRecordId: string;
	sourceGroupId?: string;
	idempotencyKey: string;
	status?: string;
}

export interface SnapshotHolding {
	assetId: string;
	symbol: string;
	quantity: string;
	currency: string;
}

export const PROVIDER = 'WF_SYNC';

export class WealthfolioClient {
	private token?: string;

	constructor(
		readonly baseUrl: string,
		private readonly password: string | undefined,
		private readonly log: Logger,
	) {}

	async login(): Promise<void> {
		const status = await this.call<
			{ requiresPassword?: boolean; requires_password?: boolean } | undefined
		>('GET', '/auth/status', undefined, false).catch(() => undefined);
		if (!this.password) {
			this.log.debug(`No password configured; auth status: ${JSON.stringify(status)}`);
			return;
		}
		const res = await request(`${this.baseUrl}/api/v1/auth/login`, {
			method: 'POST',
			json: { password: this.password },
			retries: 0,
		});
		const body = await res.text();
		if (!res.ok) throw new HttpError(res.status, body, '/auth/login');
		const cookies = res.headers.getSetCookie();
		for (const c of cookies) {
			const m = /(?:^|;\s*)wf_session=([^;]+)/.exec(c);
			if (m?.[1]) this.token = m[1];
		}
		if (!this.token)
			throw new Error('Wealthfolio login succeeded but no session cookie was returned');
	}

	/**
	 * `idempotent: false` disables network retries: a timed-out POST may still have been
	 * committed, and resending it would create duplicates.
	 */
	private async call<T>(
		method: string,
		path: string,
		json?: unknown,
		retryAuth = true,
		idempotent = true,
	): Promise<T> {
		const headers: Record<string, string> = {};
		if (this.token) headers.authorization = `Bearer ${this.token}`;
		const res = await request(`${this.baseUrl}/api/v1${path}`, {
			method,
			json,
			headers,
			timeoutMs: 120_000,
			retries: idempotent ? 2 : 0,
		});
		if (res.status === 401 && retryAuth && this.password) {
			await this.login();
			return this.call<T>(method, path, json, false, idempotent);
		}
		const text = await res.text();
		if (!res.ok) throw new HttpError(res.status, text, `${method} ${path}`);
		return (text ? JSON.parse(text) : undefined) as T;
	}

	// --- settings ---------------------------------------------------------------
	async settings(): Promise<{ baseCurrency?: string }> {
		const s = await this.call<unknown>('GET', '/settings');
		return { baseCurrency: str(path(s, 'baseCurrency')) || undefined };
	}

	async updateSettings(patch: Record<string, unknown>): Promise<void> {
		await this.call<unknown>('PUT', '/settings', patch);
	}

	// --- accounts ---------------------------------------------------------------
	listAccounts(): Promise<WfAccount[]> {
		return this.call('GET', '/accounts');
	}

	createAccount(a: {
		name: string;
		accountType: string;
		group?: string;
		currency: string;
		providerAccountId: string;
		trackingMode: 'HOLDINGS' | 'TRANSACTIONS';
	}): Promise<WfAccount> {
		return this.call(
			'POST',
			'/accounts',
			{ ...a, isDefault: false, isActive: true, isArchived: false, provider: PROVIDER },
			true,
			false,
		);
	}

	// --- assets -----------------------------------------------------------------
	listAssets(): Promise<WfAsset[]> {
		return this.call('GET', '/assets');
	}

	createCryptoAsset(
		symbol: string,
		name: string | undefined,
		quoteMode: 'MARKET' | 'MANUAL',
		quoteCcy = 'USD',
	): Promise<WfAsset> {
		return this.call(
			'POST',
			'/assets',
			{
				kind: 'INVESTMENT',
				name: name ?? symbol,
				displayCode: symbol,
				isActive: true,
				quoteMode,
				quoteCcy,
				instrumentType: 'CRYPTO',
				instrumentSymbol: symbol,
				notes: 'Created by wf-sync',
			},
			true,
			false,
		);
	}

	setQuoteMode(assetId: string, quoteMode: 'MARKET' | 'MANUAL'): Promise<unknown> {
		return this.call('PUT', `/assets/pricing-mode/${encodeURIComponent(assetId)}`, { quoteMode });
	}

	// --- holdings snapshots -------------------------------------------------------
	saveSnapshot(
		accountId: string,
		holdings: SnapshotHolding[],
		cash: Record<string, string>,
		date?: string,
	): Promise<void> {
		return this.call('POST', '/snapshots', {
			accountId,
			holdings: holdings.map((h) => ({
				assetId: h.assetId,
				symbol: h.symbol,
				quantity: h.quantity,
				currency: h.currency,
			})),
			cashBalances: cash,
			snapshotDate: date,
		});
	}

	// --- quotes -------------------------------------------------------------------
	latestQuotes(
		assetIds: string[],
	): Promise<
		Record<
			string,
			{ quote?: { timestamp: string } | null; isStale?: boolean; quoteDate?: string | null }
		>
	> {
		return this.call('POST', '/market-data/quotes/latest', { assetIds });
	}

	syncMarketData(assetIds?: string[]): Promise<void> {
		return this.call('POST', '/market-data/sync', {
			assetIds: assetIds ?? null,
			refetchAll: false,
		});
	}

	putManualQuote(assetId: string, price: number, currency: string, at: Date): Promise<void> {
		const px = String(price);
		return this.call('PUT', `/market-data/quotes/${encodeURIComponent(assetId)}`, {
			id: `${assetId}_wfsync`,
			assetId,
			timestamp: at.toISOString(),
			open: px,
			high: px,
			low: px,
			close: px,
			adjclose: px,
			volume: '0',
			currency,
			dataSource: 'MANUAL',
			createdAt: new Date().toISOString(),
			notes: 'wf-sync',
		});
	}

	// --- activities -----------------------------------------------------------------
	/** Throws on any rejection (HTTP error or per-row errors). Never retried: see call(). */
	async createActivities(creates: NewWfActivity[]): Promise<number> {
		const res = await this.call<unknown>(
			'POST',
			'/activities/bulk',
			{ creates, updates: [], deleteIds: [] },
			true,
			false,
		);
		const errors = arr(path(res, 'errors'));
		if (errors.length)
			throw new Error(`Wealthfolio rejected activities: ${JSON.stringify(errors).slice(0, 500)}`);
		return arr(path(res, 'created')).length;
	}

	/** Idempotency keys of every activity already stored for an account. */
	async existingIdempotencyKeys(accountId: string): Promise<Set<string>> {
		const keys = new Set<string>();
		for (let page = 0; page < 200; page++) {
			const res = await this.call<unknown>('POST', '/activities/search', {
				page,
				pageSize: 500,
				accountIdFilter: accountId,
			});
			const rows = arr(path(res, 'data'));
			for (const r of rows) {
				const key = str(path(r, 'idempotencyKey'));
				if (key) keys.add(key);
			}
			if (rows.length < 500) break;
		}
		return keys;
	}
}
