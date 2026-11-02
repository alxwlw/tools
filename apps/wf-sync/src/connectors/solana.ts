/**
 * Solana wallets over JSON-RPC: SOL + all SPL / Token-2022 balances.
 *
 * Options:
 *   address | addresses   — base58 wallet address(es)
 *   rpc                   — default https://api.mainnet-beta.solana.com (rate-limited;
 *                           a free Helius/QuickNode/Alchemy endpoint is more reliable)
 *   tokens                — extra mint → symbol map: { "<mint>": "JTO" }
 *   unknown_tokens        — "price" (default): keep unlisted mints that DefiLlama can price
 *                           with high confidence; "skip": only listed mints
 */

import { fromUnits, isZero } from '../decimal.ts';
import { arr, num, path, str } from '../json.ts';
import { type AccountData, HoldingsSnapshot } from '../models.ts';
import { Connector } from './base.ts';
import { rpcBatch } from './evm.ts';

export const KNOWN_MINTS: Record<string, string> = {
	EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
	Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
	JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
	DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
	jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: 'JTO',
	'4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAY',
	HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: 'PYTH',
	EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 'WIF',
	So11111111111111111111111111111111111111112: 'SOL', // wrapped SOL
	mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'MSOL',
	J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 'JITOSOL',
	'7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': 'STSOL',
	bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: 'BSOL',
};

const WSOL = 'So11111111111111111111111111111111111111112';

const TOKEN_PROGRAMS = [
	'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
	'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
];

export const isSolanaAddress = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export class SolanaConnector extends Connector {
	async fetch(): Promise<AccountData[]> {
		const rpc = this.optional<string>('rpc', 'https://api.mainnet-beta.solana.com');
		const known = { ...KNOWN_MINTS, ...this.optional<Record<string, string>>('tokens', {}) };
		const keepUnknown = this.optional<string>('unknown_tokens', 'price') !== 'skip';
		const list = this.optional<string[] | undefined>('addresses', undefined) ?? [
			this.opt('address'),
		];

		const accounts: AccountData[] = [];
		for (const address of list) {
			if (!isSolanaAddress(address))
				throw new Error(`[${this.id}] invalid Solana address: ${address}`);
			const [balance, ...tokenResults] = await rpcBatch(rpc, [
				{ method: 'getBalance', params: [address, { commitment: 'confirmed' }] },
				...TOKEN_PROGRAMS.map((programId) => ({
					method: 'getTokenAccountsByOwner',
					params: [address, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
				})),
			]);

			const snap = new HoldingsSnapshot();
			const lamports = BigInt(str(path(balance, 'value')) ?? '0');
			if (lamports > 0n) {
				snap.addPosition({
					symbol: 'SOL',
					quantity: fromUnits(lamports, 9),
					priceRef: 'coingecko:solana',
				});
			}

			for (const res of tokenResults) {
				for (const acc of arr(path(res, 'value'))) {
					const info = path(acc, 'account', 'data', 'parsed', 'info');
					const mint = str(path(info, 'mint'));
					const raw = str(path(info, 'tokenAmount', 'amount'));
					if (!mint || !raw || raw === '0') continue;
					const qty = fromUnits(BigInt(raw), num(path(info, 'tokenAmount', 'decimals')) ?? 0);
					if (isZero(qty)) continue;
					const symbol = known[mint];
					if (!symbol && !keepUnknown) continue;
					snap.addPosition({
						// Unknown mints get their symbol from the price oracle later (or are dropped).
						symbol: symbol ?? `SPL:${mint}`,
						quantity: qty,
						priceRef: mint === WSOL ? 'coingecko:solana' : `solana:${mint}`,
					});
				}
			}

			accounts.push({
				key: `${this.id}:${address}`,
				name: this.name ? `${this.name} ${short(address)}` : `Solana ${short(address)}`,
				currency: 'USD',
				accountType: 'CRYPTOCURRENCY',
				group: 'Wallets',
				holdings: snap,
			});
		}
		return accounts;
	}
}
