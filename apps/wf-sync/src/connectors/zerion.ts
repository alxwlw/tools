/**
 * Wallets through the Zerion API: one request per address finds every token on every chain
 * Zerion covers, with its USD price, so there are no RPC endpoints or token lists to maintain.
 *
 * Options:
 *   api_key               — free at https://developers.zerion.io
 *   address | addresses   — 0x… or base58 Solana addresses (one Wealthfolio account each)
 *
 * Zerion's trash filter takes out most airdropped spam; what gets past it has no price and is
 * dropped here. Debt is not counted: a Holdings account has no negative quantities.
 */

import { isZero } from '../decimal.ts';
import { arr, num, path, str } from '../json.ts';
import { type AccountData, HoldingsSnapshot } from '../models.ts';
import { Connector } from './base.ts';

const API = 'https://api.zerion.io/v1';
const UNWRAPPED: Record<string, string> = { WETH: 'ETH', WBTC: 'BTC', WSOL: 'SOL' };

const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const isSolanaAddress = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

export class ZerionConnector extends Connector {
	async fetch(): Promise<AccountData[]> {
		const addresses = this.optional<string[] | undefined>('addresses', undefined) ?? [
			this.opt('address'),
		];
		for (const a of addresses) {
			if (!isEvmAddress(a) && !isSolanaAddress(a))
				throw new Error(`[${this.id}] invalid wallet address: ${a}`);
		}

		const accounts: AccountData[] = [];
		for (const address of addresses) {
			const evm = isEvmAddress(address);
			const label = `${address.slice(0, evm ? 6 : 4)}…${address.slice(-4)}`;
			const holdings = new HoldingsSnapshot();
			for (const item of await this.positions(address, evm)) this.add(holdings, label, item);
			accounts.push({
				key: `${this.id}:${evm ? address.toLowerCase() : address}`,
				name: `${this.name ?? (evm ? 'EVM' : 'Solana')} ${label}`,
				currency: 'USD',
				accountType: 'CRYPTOCURRENCY',
				group: 'Wallets',
				holdings,
			});
		}
		return accounts;
	}

	private async positions(address: string, evm: boolean): Promise<unknown[]> {
		const params = new URLSearchParams({ currency: 'usd', 'filter[trash]': 'only_non_trash' });
		// Solana answers 400 to no_filter: it has no protocol positions, only wallet balances.
		if (evm) params.set('filter[positions]', 'no_filter');
		const headers = { authorization: `Basic ${btoa(`${this.opt('api_key')}:`)}` };

		const items: unknown[] = [];
		let url: string | undefined =
			`${this.optional<string>('api_url', API)}/wallets/${address}/positions/?${params.toString()}`;
		while (url) {
			const page: unknown = await this.http(url, { headers });
			items.push(...arr(path(page, 'data')));
			url = str(path(page, 'links', 'next'));
		}
		return items;
	}

	private add(holdings: HoldingsSnapshot, label: string, item: unknown): void {
		const a = path(item, 'attributes');
		const symbol = str(path(a, 'fungible_info', 'symbol'));
		const quantity = str(path(a, 'quantity', 'numeric'));
		if (!symbol || !quantity || isZero(quantity)) return;
		if (path(a, 'position_type') === 'loan') {
			this.log.warn(`${label}: debt of ${quantity} ${symbol} is not counted`);
			return;
		}
		// The SOL locked in token accounts: no wallet app shows it as a balance.
		if (path(a, 'name') === 'Rent') return;

		const priceUsd = num(path(a, 'price'));
		if (path(a, 'fungible_info', 'flags', 'verified') === true) {
			holdings.addPosition({ symbol: UNWRAPPED[symbol] ?? symbol, quantity, priceUsd });
		} else if (priceUsd) {
			// Anyone can deploy a token named USDT or ETH: without the contract in its symbol it
			// would count as cash or add to the real coin. LP tokens are unverified too, so these stay.
			holdings.addPosition({
				symbol: `${symbol}-${contractTag(item)}`,
				name: symbol,
				quantity,
				priceUsd,
			});
		}
	}
}

function contractTag(item: unknown): string {
	const chain = str(path(item, 'relationships', 'chain', 'data', 'id'));
	const implementations = arr(path(item, 'attributes', 'fungible_info', 'implementations'));
	const contract = str(
		path(
			implementations.find((i) => path(i, 'chain_id') === chain),
			'address',
		),
	);
	return contract?.replace(/^0x/, '').slice(0, 6) ?? chain ?? 'unknown';
}
