/**
 * One sync run: fetch every connector → normalize & price → write to Wealthfolio.
 *
 * A failing connector is logged and skipped; the others still sync.
 */

import type { Config } from './config.ts';
import { type Connector, resolveConnector } from './connectors/base.ts';
import { abs, add, cmp, type Dec, isZero, sign, sub, toNumber } from './decimal.ts';
import { errorMessage } from './json.ts';
import type { Logger } from './log.ts';
import {
	type AccountData,
	type CashTransaction,
	HoldingsSnapshot,
	type Position,
	trackingMode,
} from './models.ts';
import { type Price, PriceOracle } from './pricing.ts';
import type { AssetState, State } from './state.ts';
import { isUsdStable } from './symbols.ts';
import {
	type NewWfActivity,
	PROVIDER,
	type WealthfolioClient,
	type WfAccount,
	type WfAsset,
} from './wealthfolio.ts';

export interface RunSummary {
	ok: string[];
	failed: { id: string; error: string }[];
	accounts: number;
	activities: number;
	totalUsd: number;
}

const DAY_MS = 86_400_000;
const STALE_QUOTE_DAYS = 4;
const KEEP_IDS_DAYS = 120;

export interface BuiltConnectors {
	connectors: Connector[];
	/** Connectors whose type/plugin could not be loaded; reported, the rest still run. */
	failed: { id: string; error: string }[];
}

export async function buildConnectors(
	config: Config,
	state: State,
	log: Logger,
): Promise<BuiltConnectors> {
	const out: BuiltConnectors = { connectors: [], failed: [] };
	for (const c of config.connectors.filter((x) => x.enabled)) {
		try {
			const connectorClass = await resolveConnector(c.type, config.pluginsDir);
			out.connectors.push(
				new connectorClass(c.id, c.type, c.name, c.options, {
					state: state.connector(c.id),
					log: log.child(c.id),
					saveState: () => state.save(),
				}),
			);
		} catch (e) {
			const error = errorMessage(e);
			log.error(`[${c.id}] cannot load connector '${c.type}': ${error}`);
			out.failed.push({ id: c.id, error });
		}
	}
	return out;
}

export class SyncEngine {
	private oracle: PriceOracle;
	private wfAccounts?: WfAccount[];
	private wfAssets?: WfAsset[];

	constructor(
		private readonly config: Config,
		private readonly state: State,
		private readonly wf: WealthfolioClient,
		private readonly log: Logger,
	) {
		this.oracle = new PriceOracle(config.pricing.exchanges, log.child('prices'));
	}

	async run(connectors: Connector[], opts: { dryRun?: boolean } = {}): Promise<RunSummary> {
		const summary: RunSummary = { ok: [], failed: [], accounts: 0, activities: 0, totalUsd: 0 };
		const today = new Date();

		if (!opts.dryRun) {
			await this.wf.login();
			await this.ensureBaseCurrency();
			await this.auditMarketAssets();
		}

		// 1. fetch
		const fetched: { connector: Connector; accounts: AccountData[] }[] = [];
		for (const c of connectors) {
			try {
				const accounts = await c.fetch();
				fetched.push({ connector: c, accounts });
			} catch (e) {
				const msg = errorMessage(e);
				this.log.error(`[${c.id}] fetch failed: ${msg}`);
				summary.failed.push({ id: c.id, error: msg });
			}
		}

		// 2. normalize + price every holdings snapshot together (one DefiLlama batch)
		const allPositions = fetched.flatMap((f) =>
			f.accounts.flatMap((a) => a.holdings?.positions ?? []),
		);
		const prices = await this.oracle.priceAll(allPositions);
		const symbolPrices = new Map<string, number>(); // normalized symbol → usd
		for (const f of fetched) {
			for (const a of f.accounts) {
				if (!a.holdings) continue;
				a.holdings = this.normalize(a, prices, symbolPrices);
				summary.totalUsd += valueUsd(a.holdings, symbolPrices);
			}
		}

		if (opts.dryRun) {
			for (const f of fetched) {
				for (const a of f.accounts) this.printAccount(a);
				summary.ok.push(f.connector.id);
			}
			return summary;
		}

		// 3. write
		const touchedMarketAssets = new Set<string>();
		for (const { connector, accounts } of fetched) {
			try {
				for (const a of accounts) {
					const accountId = await this.ensureAccount(a);
					if (a.transactions) await this.joinSpendingReports(connector, accountId);
					if (a.holdings) {
						const holdings = [];
						for (const p of a.holdings.positions) {
							const asset = await this.ensureAsset(p.symbol, p.name);
							if (asset.mode === 'MARKET') touchedMarketAssets.add(asset.id);
							holdings.push({
								assetId: asset.id,
								symbol: p.symbol,
								quantity: p.quantity,
								currency: 'USD',
							});
						}
						// No date: the server stamps "today" in the user's configured timezone.
						await this.wf.saveSnapshot(accountId, holdings, a.holdings.cash);
						this.log.info(
							`[${connector.id}] ${a.name}: snapshot with ${holdings.length} position(s), cash ${fmtCash(a.holdings.cash)}`,
						);
					} else if (a.transactions) {
						summary.activities += await this.importTransactions(connector.id, accountId, a);
					}
					summary.accounts++;
				}
				await this.seedSpendingRules(connector);
				await connector.onSynced?.();
				summary.ok.push(connector.id);
			} catch (e) {
				const msg = errorMessage(e);
				this.log.error(`[${connector.id}] write failed: ${msg}`);
				summary.failed.push({ id: connector.id, error: msg });
			} finally {
				this.state.save();
			}
		}

		// 4. prices: push our quotes for MANUAL assets, ask Wealthfolio to refresh MARKET ones
		for (const [symbol, usd] of symbolPrices) {
			const asset = this.state.assets[symbol];
			if (asset?.mode !== 'MANUAL') continue;
			try {
				await this.wf.putManualQuote(asset.id, usd, 'USD', today);
			} catch (e) {
				this.log.warn(`Could not save manual quote for ${symbol}: ${errorMessage(e)}`);
			}
		}
		if (touchedMarketAssets.size) {
			await this.wf
				.syncMarketData([...touchedMarketAssets])
				.catch((e: unknown) =>
					this.log.warn(`Market data sync request failed: ${errorMessage(e)}`),
				);
		}
		this.state.save();
		return summary;
	}

	// ---------------------------------------------------------------------------
	// normalization

	/** Stablecoins → USD cash (optional), drop dust. */
	private normalize(
		a: AccountData,
		prices: Map<Position, Price>,
		symbolPrices: Map<string, number>,
	): HoldingsSnapshot {
		const src = a.holdings!;
		const out = new HoldingsSnapshot();
		for (const [ccy, amt] of Object.entries(src.cash)) if (!isZero(amt)) out.addCash(ccy, amt);

		for (const p of src.positions) {
			const price = prices.get(p);
			const symbol = p.symbol.toUpperCase();
			if (this.config.stablecoinsAsCash && isUsdStable(symbol)) {
				out.addCash('USD', p.quantity);
				continue;
			}
			const value = price ? toNumber(p.quantity) * price.usd : undefined;
			if (value !== undefined && value < this.config.minValueUsd) {
				this.log.debug(`${a.name}: dust ${p.quantity} ${symbol} (~$${value.toFixed(2)}) skipped`);
				continue;
			}
			if (!price) {
				// Wealthfolio may still price it (Yahoo); otherwise it will show without value.
				this.log.warn(
					`${a.name}: no USD price found for ${symbol}; relying on Wealthfolio market data`,
				);
			} else if (!symbolPrices.has(symbol)) {
				symbolPrices.set(symbol, price.usd);
			}
			out.addPosition({ ...p, symbol });
		}
		return out;
	}

	// ---------------------------------------------------------------------------
	// accounts & assets

	private async ensureAccount(a: AccountData): Promise<string> {
		this.wfAccounts ??= await this.wf.listAccounts();
		const known = this.state.accounts[a.key];
		const existing =
			(known && this.wfAccounts.find((x) => x.id === known)) ||
			this.wfAccounts.find((x) => x.provider === PROVIDER && x.providerAccountId === a.key);
		if (existing) {
			const mode = trackingMode(a);
			if (
				existing.trackingMode &&
				existing.trackingMode !== mode &&
				existing.trackingMode !== 'NOT_SET'
			) {
				throw new Error(
					`Account "${existing.name}" is in ${existing.trackingMode} mode, wf-sync needs ${mode}`,
				);
			}
			this.state.accounts[a.key] = existing.id;
			return existing.id;
		}
		const created = await this.wf.createAccount({
			name: a.name,
			accountType: a.accountType,
			group: a.group,
			currency: a.currency,
			providerAccountId: a.key,
			trackingMode: trackingMode(a),
		});
		this.log.info(`Created Wealthfolio account "${a.name}" (${trackingMode(a)})`);
		this.wfAccounts.push(created);
		this.state.accounts[a.key] = created.id;
		return created.id;
	}

	// ---------------------------------------------------------------------------
	// spending reports: a report without categories loses no money, so failures only warn

	/**
	 * Once per account and before its operations arrive: Wealthfolio applies its rules on
	 * arrival, to accounts in the reports only. Taking one out in the UI later stays that way.
	 */
	private async joinSpendingReports(connector: Connector, accountId: string): Promise<void> {
		if (!connector.spendingRules?.().length) return;
		const joined = (this.state.connector(connector.id).spendingAccounts ??= {}) as Record<
			string,
			boolean
		>;
		if (joined[accountId]) return;
		try {
			const { accountIds } = await this.wf.spendingAccounts();
			await this.wf.setSpendingAccounts([...new Set([...accountIds, accountId])]);
			joined[accountId] = true;
		} catch (e) {
			this.log.warn(`[${connector.id}] could not join spending reports: ${errorMessage(e)}`);
		}
	}

	/** Once per version of the rules, so a rule changed in the UI stays changed until then. */
	private async seedSpendingRules(connector: Connector): Promise<void> {
		const rules = connector.spendingRules?.() ?? [];
		if (!rules.length) return;
		const cstate = this.state.connector(connector.id);
		const version = String(Bun.hash(JSON.stringify(rules)));
		if (cstate.spendingRules === version) return;
		try {
			for (const rule of rules) await this.wf.upsertSpendingRule(rule);
			cstate.spendingRules = version;
		} catch (e) {
			this.log.warn(`[${connector.id}] could not seed spending rules: ${errorMessage(e)}`);
		}
	}

	private async ensureAsset(symbol: string, name?: string): Promise<AssetState> {
		const cached = this.state.assets[symbol];
		this.wfAssets ??= await this.wf.listAssets();
		if (cached && this.wfAssets.some((x) => x.id === cached.id)) return cached;

		const found = this.wfAssets.find(
			(x) =>
				x.instrumentType === 'CRYPTO' &&
				(x.instrumentSymbol ?? x.displayCode)?.toUpperCase() === symbol &&
				x.quoteCcy === 'USD',
		);
		if (found) {
			// createdAt = first seen by wf-sync, so pre-existing assets get the same grace period.
			const s: AssetState = { id: found.id, mode: found.quoteMode, createdAt: Date.now() };
			this.state.assets[symbol] = s;
			return s;
		}
		const mode = this.config.pricing.manualSymbols.includes(symbol) ? 'MANUAL' : 'MARKET';
		const created = await this.wf.createCryptoAsset(symbol, name, mode);
		this.wfAssets.push(created);
		const s: AssetState = { id: created.id, mode, createdAt: Date.now() };
		this.state.assets[symbol] = s;
		this.log.info(`Created asset ${symbol} (${mode})`);
		return s;
	}

	/** A fresh Wealthfolio (onboarding skipped) has no base currency, and then no valuation runs at all. */
	private async ensureBaseCurrency(): Promise<void> {
		try {
			const s = await this.wf.settings();
			if (s.baseCurrency) return;
			await this.wf.updateSettings({ baseCurrency: this.config.baseCurrency });
			this.log.warn(
				`Wealthfolio had no base currency; set it to ${this.config.baseCurrency} (base_currency in config)`,
			);
		} catch (e) {
			this.log.warn(`Could not check Wealthfolio base currency: ${errorMessage(e)}`);
		}
	}

	/**
	 * MARKET assets Wealthfolio has never managed to price (e.g. a token Yahoo doesn't
	 * list) are switched to MANUAL so wf-sync's own prices are used. An asset that had
	 * quotes and merely went stale (provider outage, server down) is left alone.
	 */
	private async auditMarketAssets(): Promise<void> {
		const market = Object.entries(this.state.assets).filter(
			([, a]) => a.mode === 'MARKET' && Date.now() - (a.createdAt ?? 0) > 6 * 3600_000,
		);
		if (!market.length) return;
		let latest: Awaited<ReturnType<WealthfolioClient['latestQuotes']>>;
		try {
			latest = await this.wf.latestQuotes(market.map(([, a]) => a.id));
		} catch (e) {
			this.log.warn(`Could not read latest quotes: ${errorMessage(e)}`);
			return;
		}
		for (const [symbol, a] of market) {
			const q = latest[a.id];
			if (q?.quote) {
				const ts = Date.parse(q.quote.timestamp);
				if (Number.isFinite(ts) && Date.now() - ts > STALE_QUOTE_DAYS * DAY_MS) {
					this.log.warn(
						`${symbol}: last market quote is from ${q.quote.timestamp}; check Wealthfolio market data`,
					);
				}
				continue;
			}
			try {
				await this.wf.setQuoteMode(a.id, 'MANUAL');
				a.mode = 'MANUAL';
				this.log.info(
					`${symbol}: no market quotes from Wealthfolio providers — switched to wf-sync prices (MANUAL)`,
				);
			} catch (e) {
				this.log.warn(`${symbol}: could not switch to MANUAL: ${errorMessage(e)}`);
			}
		}
	}

	// ---------------------------------------------------------------------------
	// transactions

	private async importTransactions(
		connectorId: string,
		accountId: string,
		a: AccountData,
	): Promise<number> {
		const cstate = this.state.connector(connectorId);
		// Our own persisted JSON, so the shape is trusted.
		cstate.books ??= {};
		const books = cstate.books as Record<string, { ids: Record<string, number>; balance?: Dec }>;
		const book = (books[a.key] ??= { ids: {} });
		const txns = [...(a.transactions ?? [])].sort((x, y) => x.time.getTime() - y.time.getTime());
		const fresh = txns.filter((t) => !(t.id in book.ids));
		const creates: NewWfActivity[] = [];

		// First import: back out the balance before the earliest operation. Kept local until the
		// write succeeds — if it fails, the next run must try the opening balance again.
		let running: Dec;
		if (book.balance === undefined) {
			const first = txns[0];
			let opening: Dec = '0';
			let at = new Date();
			if (first?.balanceAfter !== undefined) {
				opening = sub(first.balanceAfter, first.amount);
				at = new Date(first.time.getTime() - 1000);
			} else if (a.currentBalance !== undefined) {
				opening = txns.reduce((s, t) => sub(s, t.amount), a.currentBalance);
				if (first) at = new Date(first.time.getTime() - 1000);
			}
			if (!isZero(opening))
				creates.push(
					this.adjustment(accountId, a, opening, at, 'opening', 'Opening balance (wf-sync)', false),
				);
			running = opening;
		} else {
			running = book.balance;
		}

		for (const t of fresh) {
			creates.push(this.toActivity(accountId, a, t));
			running = add(running, t.amount);
		}

		// Reconcile against the source's own balance figure.
		const last = txns.at(-1);
		const target = last?.balanceAfter ?? (txns.length === 0 ? a.currentBalance : undefined);
		if (target !== undefined) {
			const drift = sub(target, running);
			if (cmp(abs(drift), '0.005') > 0) {
				this.log.warn(
					`${a.name}: balance drift ${drift} ${a.currency}, adding an adjustment for review`,
				);
				// Deterministic id: recomputing the same drift after a crash dedupes instead of doubling.
				const adjId = `adj-${last?.id ?? 'balance'}-${target}`;
				creates.push(
					this.adjustment(
						accountId,
						a,
						drift,
						new Date(),
						adjId,
						'Balance adjustment (wf-sync)',
						true,
					),
				);
				running = target;
			}
		}

		const written = creates.length ? await this.writeActivities(accountId, creates) : 0;
		const now = Date.now();
		for (const t of fresh) book.ids[t.id] = Math.floor(t.time.getTime() / 1000);
		book.ids = Object.fromEntries(
			Object.entries(book.ids).filter(([, ts]) => now - ts * 1000 <= KEEP_IDS_DAYS * DAY_MS),
		);
		book.balance = running;

		if (written)
			this.log.info(`${a.name}: wrote ${written} activit(ies), balance ${running} ${a.currency}`);
		return written;
	}

	/**
	 * Bulk insert. If Wealthfolio already has some of these (it committed an earlier
	 * batch but our state wasn't saved — crash, timeout, lost state.json), the whole
	 * batch is rejected on the idempotency key; drop the ones it has and retry once.
	 */
	private async writeActivities(accountId: string, creates: NewWfActivity[]): Promise<number> {
		try {
			await this.wf.createActivities(creates);
			return creates.length;
		} catch (e) {
			if (!/duplicate|unique constraint|idempotency/i.test(errorMessage(e))) throw e;
		}
		const existing = await this.wf.existingIdempotencyKeys(accountId);
		const missing = creates.filter((c) => !existing.has(c.idempotencyKey));
		this.log.warn(
			`${creates.length - missing.length} activit(ies) were already in Wealthfolio; writing the other ${missing.length}`,
		);
		if (missing.length) await this.wf.createActivities(missing);
		return missing.length;
	}

	private toActivity(accountId: string, a: AccountData, t: CashTransaction): NewWfActivity {
		const transfer = Boolean(t.metadata?.transfer);
		const inflow = sign(t.amount) > 0;
		return {
			accountId,
			activityType: transfer
				? inflow
					? 'TRANSFER_IN'
					: 'TRANSFER_OUT'
				: inflow
					? 'DEPOSIT'
					: 'WITHDRAWAL',
			activityDate: t.time.toISOString(),
			amount: abs(t.amount),
			currency: t.currency || a.currency,
			notes: t.description || undefined,
			metadata: t.metadata ? JSON.stringify(t.metadata) : undefined,
			sourceSystem: PROVIDER,
			sourceRecordId: t.id,
			sourceGroupId:
				typeof t.metadata?.transferGroup === 'string' ? t.metadata.transferGroup : undefined,
			idempotencyKey: `wfsync:${a.key}:${t.id}`,
			status: 'POSTED',
		};
	}

	/**
	 * Balance correction. Only some Wealthfolio types move cash (ADJUSTMENT does not):
	 *  - positive → CREDIT (no subtype): ignored by spending analytics;
	 *  - negative opening balance → TRANSFER_OUT: money that left before the history window;
	 *  - negative drift → WITHDRAWAL flagged for review: most likely a real expense the
	 *    statement didn't show (e.g. a hold settled for a different amount).
	 */
	private adjustment(
		accountId: string,
		a: AccountData,
		amount: Dec,
		at: Date,
		id: string,
		note: string,
		review: boolean,
	): NewWfActivity {
		const positive = sign(amount) > 0;
		const isOpening = id === 'opening';
		return {
			accountId,
			activityType: positive ? 'CREDIT' : isOpening ? 'TRANSFER_OUT' : 'WITHDRAWAL',
			activityDate: at.toISOString(),
			amount: abs(amount),
			currency: a.currency,
			notes: note,
			needsReview: review,
			sourceSystem: PROVIDER,
			sourceRecordId: id,
			sourceGroupId: !positive && isOpening ? `wfsync:opening:${a.key}` : undefined,
			idempotencyKey: `wfsync:${a.key}:${id}`,
			status: 'POSTED',
		};
	}

	private printAccount(a: AccountData): void {
		const mode = trackingMode(a);
		console.log(`\n■ ${a.name}  [${a.key}]  ${mode} ${a.currency}`);
		if (a.holdings) {
			for (const p of a.holdings.positions) console.log(`    ${p.symbol.padEnd(10)} ${p.quantity}`);
			for (const [c, v] of Object.entries(a.holdings.cash))
				console.log(`    ${c.padEnd(10)} ${v} (cash)`);
		}
		if (a.transactions) {
			console.log(
				`    ${a.transactions.length} operation(s) in window, balance ${a.currentBalance} ${a.currency}`,
			);
			for (const t of a.transactions.slice(-5)) {
				console.log(
					`    ${t.time.toISOString().slice(0, 16)} ${t.amount.padStart(12)}  ${t.description ?? ''}`,
				);
			}
		}
	}
}

/** USD value of a snapshot: USD cash + priced positions (other fiat isn't converted). */
export function valueUsd(snap: HoldingsSnapshot, symbolPrices: Map<string, number>): number {
	let total = toNumber(snap.cash.USD ?? '0');
	for (const p of snap.positions) total += toNumber(p.quantity) * (symbolPrices.get(p.symbol) ?? 0);
	return total;
}

export const isoDate = (d: Date) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fmtCash = (cash: Record<string, Dec>) =>
	Object.entries(cash)
		.map(([c, v]) => `${v} ${c}`)
		.join(', ') || '—';
