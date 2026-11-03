/**
 * TRON wallets through the public TronGrid API: TRX, staked TRX and the TRC-20 tokens below.
 *
 * Options:
 *   address | addresses   — T… addresses (one Wealthfolio account each)
 *
 * The token list is explicit on purpose: TRC-20 balances are full of airdropped spam.
 * Without a key TronGrid answers 429 to quick requests; the HTTP layer waits and retries.
 */

import { fromUnits, isZero } from '../decimal.ts';
import { arr, path, str } from '../json.ts';
import { type AccountData, HoldingsSnapshot } from '../models.ts';
import { Connector } from './base.ts';

const API = 'https://api.trongrid.io';
const TOKENS: Record<string, { symbol: string; decimals: number }> = {
	TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: { symbol: 'USDT', decimals: 6 },
	TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: { symbol: 'USDC', decimals: 6 },
};

const isTronAddress = (a: string) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);

export class TronConnector extends Connector {
	async fetch(): Promise<AccountData[]> {
		const addresses = this.optional<string[] | undefined>('addresses', undefined) ?? [
			this.opt('address'),
		];
		for (const a of addresses) {
			if (!isTronAddress(a)) throw new Error(`[${this.id}] invalid TRON address: ${a}`);
		}

		const accounts: AccountData[] = [];
		for (const address of addresses) {
			const res = await this.http(
				`${this.optional<string>('api_url', API)}/v1/accounts/${address}`,
			);
			if (path(res, 'success') !== true) throw new Error(`[${this.id}] TronGrid: no account data`);
			// An address that was never activated has no record: an empty wallet.
			const account = arr(path(res, 'data'))[0];

			const holdings = new HoldingsSnapshot();
			const staked = arr(path(account, 'frozenV2')).reduce<bigint>(
				(sum, f) => sum + BigInt(str(path(f, 'amount')) ?? '0'),
				0n,
			);
			const trx = fromUnits(BigInt(str(path(account, 'balance')) ?? '0') + staked, 6);
			if (!isZero(trx))
				holdings.addPosition({ symbol: 'TRX', quantity: trx, priceRef: 'coingecko:tron' });

			for (const item of arr(path(account, 'trc20'))) {
				for (const [contract, raw] of Object.entries(item as Record<string, unknown>)) {
					const token = TOKENS[contract];
					const amount = str(raw);
					if (!token || !amount) continue;
					const quantity = fromUnits(BigInt(amount), token.decimals);
					if (isZero(quantity)) continue;
					holdings.addPosition({
						symbol: token.symbol,
						quantity,
						priceRef: `tron:${contract}`,
					});
				}
			}

			accounts.push({
				key: `${this.id}:${address}`,
				name: `${this.name ?? 'TRON'} ${address.slice(0, 4)}…${address.slice(-4)}`,
				currency: 'USD',
				accountType: 'CRYPTOCURRENCY',
				group: 'Wallets',
				holdings,
			});
		}
		return accounts;
	}
}
