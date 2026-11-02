/**
 * Centralized exchanges via ccxt (read-only API keys).
 *
 * Built-in types: binance, okx, kraken, whitebit. Any other ccxt exchange works
 * with `type: ccxt` + `exchange: <ccxt id>`.
 *
 * Options:
 *   api_key, secret       — read-only API key pair (required)
 *   password              — API passphrase (OKX)
 *   wallets               — balance types to sum; defaults per exchange below
 *   earn                  — include Earn / savings products (default true)
 *   exchange              — ccxt id, only for type "ccxt"
 */

import ccxt, { type Exchange } from 'ccxt';

import { fromFixed, isZero, toFixed } from '../decimal.ts';
import { arr, errorMessage, path, str } from '../json.ts';
import { type AccountData, HoldingsSnapshot } from '../models.ts';
import { isFiat, normalizeSymbol } from '../symbols.ts';
import { Connector } from './base.ts';

type ExchangeCtor = new (cfg: object) => Exchange;

const DEFAULT_WALLETS: Record<string, (string | null)[]> = {
	binance: ['spot', 'funding'],
	okx: ['trading', 'funding'],
	kraken: [null],
	whitebit: ['spot', 'main'],
};

/**
 * Param key that selects the wallet. ccxt's handleMarketTypeAndParams strips `type`
 * before WhiteBIT reads it, so WhiteBIT must get `account` or it always returns the
 * trade (spot) balance.
 */
const WALLET_PARAM: Record<string, string> = { whitebit: 'account' };

const PRETTY: Record<string, string> = {
	binance: 'Binance',
	okx: 'OKX',
	kraken: 'Kraken',
	whitebit: 'WhiteBIT',
};

export class ExchangeConnector extends Connector {
	private exchange?: Exchange;

	get exchangeId(): string {
		return this.type === 'ccxt' ? this.opt('exchange') : this.type;
	}

	protected client(): Exchange {
		if (this.exchange) return this.exchange;
		const exchangeClass = (ccxt as unknown as Record<string, ExchangeCtor | undefined>)[
			this.exchangeId
		];
		if (!exchangeClass) throw new Error(`[${this.id}] ccxt has no exchange '${this.exchangeId}'`);
		this.exchange = new exchangeClass({
			apiKey: this.opt('api_key'),
			secret: this.opt('secret'),
			password: this.optional<string | undefined>('password', undefined),
			enableRateLimit: true,
			timeout: 30_000,
		});
		return this.exchange;
	}

	async fetch(): Promise<AccountData[]> {
		const ex = this.client();
		const id = this.exchangeId;
		const wallets = this.optional<(string | null)[]>('wallets', DEFAULT_WALLETS[id] ?? [null]);
		const earn = this.optional<boolean>('earn', true);

		const totals = new Map<string, bigint>();
		const put = (code: string, amount: unknown) => {
			const value = typeof amount === 'number' ? amount : str(amount);
			if (value === undefined || value === '') return;
			const v = toFixed(value);
			if (v === 0n) return;
			totals.set(code, (totals.get(code) ?? 0n) + v);
		};

		// Binance "LD*" = flexible-earn shares in the spot wallet. Simple Earn reports the
		// same funds, so they're held aside and only used when Earn isn't read.
		const ldShares: [string, unknown][] = [];
		const paramKey = WALLET_PARAM[id] ?? 'type';
		for (const wallet of wallets) {
			const params = wallet ? { [paramKey]: wallet } : {};
			const bal = await ex.fetchBalance(params);
			const total = (bal.total ?? {}) as unknown as Record<string, number | undefined>;
			for (const [rawCode, amount] of Object.entries(total)) {
				const code = normalizeSymbol(id, rawCode);
				if (id === 'binance' && /^LD[A-Z0-9]{2,}$/.test(code)) {
					ldShares.push([code.slice(2), amount]);
					continue;
				}
				put(code, amount);
			}
			this.log.debug(
				`${id} wallet ${wallet ?? 'default'}: ${Object.keys(total).length} currencies`,
			);
		}

		const earnRows = earn ? await this.fetchEarn(ex, id) : null;
		for (const [code, amount] of earnRows ?? []) put(normalizeSymbol(id, code), amount);
		if (earnRows === null) {
			// Earn off or unreadable: count the LD shares so those funds don't vanish.
			for (const [code, amount] of ldShares) put(code, amount);
		}

		const snap = new HoldingsSnapshot();
		for (const [code, v] of totals) {
			const qty = fromFixed(v);
			if (isZero(qty)) continue;
			if (isFiat(code)) snap.addCash(code, qty);
			else snap.addPosition({ symbol: code, quantity: qty, priceExchange: id });
		}

		return [
			{
				key: this.id,
				name: this.displayName(PRETTY[id] ?? id),
				currency: 'USD',
				accountType: 'CRYPTOCURRENCY',
				group: 'Exchanges',
				holdings: snap,
			},
		];
	}

	/** Earn/savings balances that fetchBalance doesn't include. null = couldn't read (only warns). */
	private async fetchEarn(ex: Exchange, id: string): Promise<[string, string][] | null> {
		const out: [string, string][] = [];
		// ccxt's implicit endpoints aren't in its typings.
		const api = ex as unknown as Record<string, ((p?: object) => Promise<unknown>) | undefined>;
		const call = async (method: string, params?: object): Promise<unknown> => {
			const fn = api[method];
			if (!fn) throw new Error(`ccxt has no ${method}`);
			return fn.call(ex, params);
		};
		const row = (r: unknown, codeField: string, amountField: string): [string, string] | null => {
			const code = str(path(r, codeField));
			return code ? [code, str(path(r, amountField)) ?? '0'] : null;
		};
		try {
			if (id === 'binance') {
				for (const [method, field] of [
					['sapiGetSimpleEarnFlexiblePosition', 'totalAmount'],
					['sapiGetSimpleEarnLockedPosition', 'amount'],
				] as const) {
					for (let page = 1; page <= 20; page++) {
						const rows = arr(path(await call(method, { size: 100, current: page }), 'rows'));
						for (const r of rows) {
							const entry = row(r, 'asset', field);
							if (entry) out.push(entry);
						}
						if (rows.length < 100) break;
					}
				}
			} else if (id === 'okx') {
				for (const r of arr(path(await call('privateGetFinanceSavingsBalance'), 'data'))) {
					const entry = row(r, 'ccy', 'amt');
					if (entry) out.push(entry);
				}
			}
		} catch (e) {
			this.log.warn(
				`${id}: could not read Earn balances (${errorMessage(e)}). ` +
					'Check that the API key has read permission for Earn, or set earn: false.',
			);
			return null;
		}
		return out;
	}

	override async check(): Promise<string> {
		const [acc] = await this.fetch();
		const n = acc?.holdings?.positions.length ?? 0;
		const cash = Object.entries(acc?.holdings?.cash ?? {})
			.map(([c, a]) => `${a} ${c}`)
			.join(', ');
		return `${n} asset(s)${cash ? `, cash: ${cash}` : ''}`;
	}
}

export { DEFAULT_WALLETS };
