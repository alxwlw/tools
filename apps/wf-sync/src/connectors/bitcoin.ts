/**
 * Bitcoin addresses through the public mempool.space API.
 *
 * Options:
 *   address | addresses   — bc1…, 1… or 3… addresses (one Wealthfolio account each)
 *
 * Only the listed addresses are read: a wallet that moves change to new addresses of its
 * own (most hardware wallets do) holds more than a single address shows.
 */

import { fromUnits, isZero } from '../decimal.ts';
import { path, str } from '../json.ts';
import { type AccountData, HoldingsSnapshot } from '../models.ts';
import { Connector } from './base.ts';

const API = 'https://mempool.space/api';

const isBitcoinAddress = (a: string) =>
	/^(bc1[02-9ac-hj-np-z]{6,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a);

export class BitcoinConnector extends Connector {
	async fetch(): Promise<AccountData[]> {
		const addresses = this.optional<string[] | undefined>('addresses', undefined) ?? [
			this.opt('address'),
		];
		for (const a of addresses) {
			if (!isBitcoinAddress(a)) throw new Error(`[${this.id}] invalid Bitcoin address: ${a}`);
		}

		const accounts: AccountData[] = [];
		for (const address of addresses) {
			const res = await this.http(`${this.optional<string>('api_url', API)}/address/${address}`);
			const sats = (stats: string, field: string) => BigInt(str(path(res, stats, field)) ?? '0');
			if (str(path(res, 'chain_stats', 'funded_txo_sum')) === undefined)
				throw new Error(`[${this.id}] ${address}: no balance in the answer`);
			const balance =
				sats('chain_stats', 'funded_txo_sum') -
				sats('chain_stats', 'spent_txo_sum') +
				sats('mempool_stats', 'funded_txo_sum') -
				sats('mempool_stats', 'spent_txo_sum');

			const holdings = new HoldingsSnapshot();
			const quantity = fromUnits(balance, 8);
			if (!isZero(quantity))
				holdings.addPosition({ symbol: 'BTC', quantity, priceRef: 'coingecko:bitcoin' });

			accounts.push({
				key: `${this.id}:${address}`,
				name: `${this.name ?? 'Bitcoin'} ${address.slice(0, 6)}…${address.slice(-4)}`,
				currency: 'USD',
				accountType: 'CRYPTOCURRENCY',
				group: 'Wallets',
				holdings,
			});
		}
		return accounts;
	}
}
