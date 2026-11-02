/**
 * EVM wallets over public JSON-RPC: native coin + ERC-20 tokens on several chains.
 *
 * Options:
 *   address | addresses   — one or more 0x… addresses (one Wealthfolio account each)
 *   chains                — default: ethereum, arbitrum, base, optimism, polygon, bsc
 *   rpc                   — per-chain RPC override: { ethereum: "https://…" }
 *   tokens                — extra tokens: { base: [{ address: "0x…", symbol: "AERO" }] }
 *   split_by_chain        — one account per address+chain instead of per address (default false)
 *
 * Token lists are explicit on purpose: without an indexer, RPC can't enumerate
 * holdings, and an explicit list keeps airdropped spam out of your net worth.
 */

import { fromUnits, isZero } from '../decimal.ts';
import { requestJson } from '../http.ts';
import { obj } from '../json.ts';
import { type AccountData, HoldingsSnapshot } from '../models.ts';
import { Connector } from './base.ts';

export interface TokenSpec {
	address: string;
	symbol: string;
	/** Read from the contract when omitted. */
	decimals?: number;
}

interface ChainSpec {
	rpc: string;
	native: { symbol: string; priceRef: string };
	llama: string; // DefiLlama chain slug
	tokens: TokenSpec[];
}

export const CHAINS: Record<string, ChainSpec> = {
	ethereum: {
		rpc: 'https://ethereum-rpc.publicnode.com',
		native: { symbol: 'ETH', priceRef: 'coingecko:ethereum' },
		llama: 'ethereum',
		tokens: [
			{ address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
			{ address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
			{ address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', decimals: 18 },
			{ address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
			{ address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', decimals: 8 },
		],
	},
	arbitrum: {
		rpc: 'https://arbitrum-one-rpc.publicnode.com',
		native: { symbol: 'ETH', priceRef: 'coingecko:ethereum' },
		llama: 'arbitrum',
		tokens: [
			{ address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
			{ address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 },
			{ address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', decimals: 18 },
		],
	},
	base: {
		rpc: 'https://base-rpc.publicnode.com',
		native: { symbol: 'ETH', priceRef: 'coingecko:ethereum' },
		llama: 'base',
		tokens: [
			{ address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
		],
	},
	optimism: {
		rpc: 'https://optimism-rpc.publicnode.com',
		native: { symbol: 'ETH', priceRef: 'coingecko:ethereum' },
		llama: 'optimism',
		tokens: [
			{ address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6 },
			{ address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', decimals: 6 },
			{ address: '0x4200000000000000000000000000000000000042', symbol: 'OP', decimals: 18 },
		],
	},
	polygon: {
		rpc: 'https://polygon-bor-rpc.publicnode.com',
		native: { symbol: 'POL', priceRef: 'coingecko:polygon-ecosystem-token' },
		llama: 'polygon',
		tokens: [
			{ address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6 },
			{ address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', decimals: 6 },
		],
	},
	bsc: {
		rpc: 'https://bsc-rpc.publicnode.com',
		native: { symbol: 'BNB', priceRef: 'coingecko:binancecoin' },
		llama: 'bsc',
		tokens: [
			{ address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
			{ address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 },
		],
	},
};

const DEFAULT_CHAINS = ['ethereum', 'arbitrum', 'base', 'optimism', 'polygon', 'bsc'];
const BALANCE_OF = '0x70a08231';
const DECIMALS = '0x313ce567';

interface RpcCall {
	method: string;
	params: unknown[];
}

/**
 * JSON-RPC batch. Throws if the batch or any call fails: a failed call must not be
 * mistaken for a zero balance (that would write an empty snapshot).
 */
export async function rpcBatch(url: string, calls: RpcCall[]): Promise<unknown[]> {
	if (calls.length === 0) return [];
	const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }));
	const res = await requestJson(url, { method: 'POST', json: body, timeoutMs: 30_000 });
	if (!Array.isArray(res)) {
		const err: unknown = obj(res).error ?? res;
		throw new Error(`RPC ${url}: batch rejected: ${JSON.stringify(err).slice(0, 200)}`);
	}
	const out = Array.from<unknown>({ length: calls.length });
	const seen = new Set<number>();
	for (const item of res as unknown[]) {
		const r = obj(item);
		const id = r.id;
		if (typeof id !== 'number' || id < 0 || id >= calls.length) continue;
		if (r.error) {
			const method = calls[id]?.method ?? '?';
			throw new Error(`RPC ${url}: ${method} failed: ${JSON.stringify(r.error).slice(0, 200)}`);
		}
		out[id] = r.result;
		seen.add(id);
	}
	if (seen.size !== calls.length)
		throw new Error(`RPC ${url}: ${calls.length - seen.size} call(s) got no response`);
	return out;
}

export const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const pad32 = (addr: string) => addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const hexToBigInt = (h: unknown) => (typeof h === 'string' && h !== '0x' ? BigInt(h) : 0n);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export class EvmConnector extends Connector {
	async fetch(): Promise<AccountData[]> {
		const addresses = this.addresses();
		const chains = this.optional<string[]>('chains', DEFAULT_CHAINS);
		const rpcOverride = this.optional<Record<string, string>>('rpc', {});
		const extraTokens = this.optional<Record<string, TokenSpec[]>>('tokens', {});
		const split = this.optional<boolean>('split_by_chain', false);

		const accounts: AccountData[] = [];
		for (const address of addresses) {
			const perAddress = new HoldingsSnapshot();
			for (const chainName of chains) {
				const chain = CHAINS[chainName];
				const rpc = rpcOverride[chainName] ?? chain?.rpc;
				if (!rpc) {
					this.log.warn(`Unknown chain '${chainName}' without an rpc override — skipped`);
					continue;
				}
				const tokens = [...(chain?.tokens ?? []), ...(extraTokens[chainName] ?? [])];
				const snap = await this.fetchChain(address, chainName, rpc, chain, tokens);
				if (split) {
					const acc = this.account(
						`${address}:${chainName}`,
						`${short(address)} (${chainName})`,
						snap,
					);
					const known = this.stored<string[]>('knownAccounts', () => []);
					// A chain that went to zero still needs an (empty) snapshot, or the old holdings stay visible.
					if (snap.positions.length || known.includes(acc.key)) {
						if (!known.includes(acc.key)) known.push(acc.key);
						accounts.push(acc);
					}
				} else {
					perAddress.merge(snap);
				}
			}
			if (!split) accounts.push(this.account(address, short(address), perAddress));
		}
		return accounts;
	}

	private addresses(): string[] {
		const list = this.optional<string[] | undefined>('addresses', undefined) ?? [
			this.opt('address'),
		];
		for (const a of list)
			if (!isEvmAddress(a)) throw new Error(`[${this.id}] invalid EVM address: ${a}`);
		return list;
	}

	private account(suffix: string, label: string, snap: HoldingsSnapshot): AccountData {
		return {
			key: `${this.id}:${suffix.toLowerCase()}`,
			name: this.name ? `${this.name} ${label}` : `EVM ${label}`,
			currency: 'USD',
			accountType: 'CRYPTOCURRENCY',
			group: 'Wallets',
			holdings: snap,
		};
	}

	private async fetchChain(
		address: string,
		chainName: string,
		rpc: string,
		chain: ChainSpec | undefined,
		tokens: TokenSpec[],
	): Promise<HoldingsSnapshot> {
		const snap = new HoldingsSnapshot();
		const needDecimals = tokens.filter((t) => t.decimals === undefined);
		const calls: RpcCall[] = [
			{ method: 'eth_getBalance', params: [address, 'latest'] },
			...tokens.map((t) => ({
				method: 'eth_call',
				params: [{ to: t.address, data: BALANCE_OF + pad32(address) }, 'latest'],
			})),
			...needDecimals.map((t) => ({
				method: 'eth_call',
				params: [{ to: t.address, data: DECIMALS }, 'latest'],
			})),
		];
		const results = await rpcBatch(rpc, calls);

		const native = fromUnits(hexToBigInt(results[0]), 18);
		if (!isZero(native)) {
			snap.addPosition({
				symbol: chain?.native.symbol ?? this.optional<string>('native_symbol', 'ETH'),
				quantity: native,
				priceRef: chain?.native.priceRef,
			});
		}

		const decimalsByAddr = new Map<string, number>();
		needDecimals.forEach((t, i) => {
			const raw = results[1 + tokens.length + i];
			if (typeof raw !== 'string' || raw === '0x') {
				throw new Error(
					`${chainName}: ${t.symbol} (${t.address}) has no decimals() — set decimals in config`,
				);
			}
			decimalsByAddr.set(t.address.toLowerCase(), Number(BigInt(raw)));
		});

		tokens.forEach((t, i) => {
			const raw = hexToBigInt(results[1 + i]);
			if (raw === 0n) return;
			const decimals = t.decimals ?? decimalsByAddr.get(t.address.toLowerCase()) ?? 18;
			const symbol =
				t.symbol.toUpperCase() === 'WETH'
					? 'ETH'
					: t.symbol.toUpperCase() === 'WBTC'
						? 'BTC'
						: t.symbol;
			snap.addPosition({
				symbol: symbol.toUpperCase(),
				quantity: fromUnits(raw, decimals),
				priceRef: `${chain?.llama ?? chainName}:${t.address.toLowerCase()}`,
			});
		});

		this.log.debug(
			`${short(address)} on ${chainName}: ${snap.positions.length} non-zero balance(s)`,
		);
		return snap;
	}
}
