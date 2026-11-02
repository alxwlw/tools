/**
 * USD prices for positions, used for the dust filter and for assets Wealthfolio
 * can't price itself (MANUAL quote mode).
 *
 * Order: USD stablecoins = 1 → DefiLlama by coin id / contract → public
 * exchange tickers (no API key) on the holding's own exchange, then others.
 */

import ccxt, { type Exchange, type Ticker, type Tickers } from 'ccxt';

import { requestJson } from './http.ts';
import { errorMessage, num, obj, path, str } from './json.ts';
import type { Logger } from './log.ts';
import type { Position } from './models.ts';
import { isUsdStable } from './symbols.ts';

export interface Price {
	usd: number;
	source: string;
	/** Symbol reported by the source (DefiLlama), used for unlisted Solana mints. */
	symbol?: string;
	confidence?: number;
}

const LLAMA = 'https://coins.llama.fi/prices/current';

export class PriceOracle {
	private tickers = new Map<string, Promise<Tickers | null>>();
	private llamaCache = new Map<string, Price | null>();

	constructor(
		private readonly exchanges: string[],
		private readonly log: Logger,
	) {}

	async priceAll(positions: Position[]): Promise<Map<Position, Price>> {
		const out = new Map<Position, Price>();
		const refs = [
			...new Set(positions.map((p) => p.priceRef).filter((r): r is string => Boolean(r))),
		];
		await this.loadLlama(refs);

		for (const p of positions) {
			if (isUsdStable(p.symbol)) {
				out.set(p, { usd: 1, source: 'stable' });
				continue;
			}
			const llama = p.priceRef ? this.llamaCache.get(p.priceRef) : undefined;
			if (llama && (llama.confidence ?? 1) >= 0.9) {
				out.set(p, llama);
				continue;
			}
			if (p.symbol.startsWith('SPL:')) continue; // unlisted mint: only DefiLlama can identify it
			const fromEx = await this.fromExchanges(p.symbol, p.priceExchange);
			if (fromEx) out.set(p, fromEx);
		}
		return out;
	}

	private async loadLlama(refs: string[]): Promise<void> {
		const missing = refs.filter((r) => !this.llamaCache.has(r));
		for (let i = 0; i < missing.length; i += 80) {
			const chunk = missing.slice(i, i + 80);
			try {
				const res = await requestJson(
					`${process.env.WF_SYNC_LLAMA_URL ?? LLAMA}/${chunk.join(',')}?searchWidth=6h`,
				);
				const coins = obj(path(res, 'coins'));
				for (const ref of chunk) {
					const c = coins[ref] ?? coins[ref.toLowerCase()];
					const usd = num(path(c, 'price'));
					this.llamaCache.set(
						ref,
						usd === undefined
							? null
							: {
									usd,
									source: 'defillama',
									symbol: str(path(c, 'symbol')),
									confidence: num(path(c, 'confidence')),
								},
					);
				}
			} catch (e) {
				this.log.warn(`DefiLlama price lookup failed: ${errorMessage(e)}`);
			}
		}
	}

	private async fromExchanges(symbol: string, preferred?: string): Promise<Price | null> {
		const order = [
			...new Set([preferred, ...this.exchanges].filter((x): x is string => Boolean(x))),
		];
		for (const id of order) {
			const tickers = await this.loadTickers(id);
			if (!tickers) continue;
			for (const quote of ['USDT', 'USD', 'USDC']) {
				const t: Ticker | undefined = tickers[`${symbol}/${quote}`];
				const mid = t?.bid && t.ask ? (t.bid + t.ask) / 2 : undefined;
				const px = t?.last ?? t?.close ?? mid;
				if (px && Number.isFinite(px) && px > 0)
					return { usd: px, source: `${id}:${symbol}/${quote}` };
			}
		}
		return null;
	}

	private loadTickers(id: string): Promise<Tickers | null> {
		let p = this.tickers.get(id);
		if (!p) {
			p = (async () => {
				const exchangeClass = (
					ccxt as unknown as Record<string, (new (c: object) => Exchange) | undefined>
				)[id];
				if (!exchangeClass) return null;
				try {
					const ex = new exchangeClass({ enableRateLimit: true, timeout: 30_000 });
					return await ex.fetchTickers();
				} catch (e) {
					this.log.warn(`Public tickers from ${id} unavailable: ${errorMessage(e)}`);
					return null;
				}
			})();
			this.tickers.set(id, p);
		}
		return p;
	}
}
