import { afterAll, describe, expect, test } from 'bun:test';

import { resolveConnector } from '../src/connectors/base.ts';
import { EvmConnector } from '../src/connectors/evm.ts';
import { ExchangeConnector } from '../src/connectors/exchanges.ts';
import { MonobankConnector } from '../src/connectors/monobank.ts';
import { SolanaConnector } from '../src/connectors/solana.ts';
import { ctx, json, mockServer } from './helpers.ts';

// ---------------------------------------------------------------- exchanges

class FakeExchange extends ExchangeConnector {
	params: object[] = [];
	constructor(
		type: string,
		private balances: Record<string, Record<string, number>>,
		private earnApi: Record<string, any> = {},
		options: Record<string, unknown> = {},
	) {
		super(type, type, undefined, { api_key: 'k', secret: 's', ...options }, ctx());
	}
	protected override client(): any {
		return {
			fetchBalance: async (params: { type?: string; account?: string }) => {
				this.params.push(params);
				return { total: this.balances[params.type ?? params.account ?? 'default'] ?? {} };
			},
			...this.earnApi,
		};
	}
}

describe('exchanges', () => {
	test('binance sums spot+funding, Simple Earn, drops LD shares, fiat to cash', async () => {
		const ex = new FakeExchange(
			'binance',
			{ spot: { BTC: 0.5, LDBTC: 0.1, EUR: 100, USDT: 10 }, funding: { USDT: 5, BTC: 0 } },
			{
				sapiGetSimpleEarnFlexiblePosition: async () => ({
					rows: [{ asset: 'BTC', totalAmount: '0.1' }],
				}),
				sapiGetSimpleEarnLockedPosition: async () => ({ rows: [{ asset: 'ETH', amount: '2' }] }),
			},
		);
		const [acc] = await ex.fetch();
		const pos = Object.fromEntries(acc!.holdings!.positions.map((p) => [p.symbol, p.quantity]));
		expect(pos).toEqual({ BTC: '0.6', USDT: '15', ETH: '2' });
		expect(acc!.holdings!.cash).toEqual({ EUR: '100' });
		expect(acc!.name).toBe('Binance');
	});

	test('binance without earn maps LD prefix', async () => {
		const ex = new FakeExchange(
			'binance',
			{ spot: { LDBTC: 0.1 }, funding: {} },
			{},
			{ earn: false },
		);
		const [acc] = await ex.fetch();
		expect(acc!.holdings!.positions).toMatchObject([{ symbol: 'BTC', quantity: '0.1' }]);
	});

	test('kraken staking suffixes collapse', async () => {
		const ex = new FakeExchange('kraken', {
			default: { 'ETH2.S': 1, ETH: 0.5, 'DOT.S': 10, 'USD.HOLD': 20, XBT: 0.01 },
		});
		const [acc] = await ex.fetch();
		const pos = Object.fromEntries(acc!.holdings!.positions.map((p) => [p.symbol, p.quantity]));
		expect(pos).toEqual({ ETH: '1.5', DOT: '10', BTC: '0.01' });
		expect(acc!.holdings!.cash).toEqual({ USD: '20' });
	});

	test('whitebit selects wallets with `account` (ccxt strips `type`)', async () => {
		const ex = new FakeExchange('whitebit', { spot: { BTC: 1 }, main: { BTC: 2, USDT: 5 } });
		const [acc] = await ex.fetch();
		expect(ex.params).toEqual([{ account: 'spot' }, { account: 'main' }]);
		expect(acc!.holdings!.positions.find((p) => p.symbol === 'BTC')!.quantity).toBe('3');
	});

	test('binance: unreadable Earn falls back to LD shares instead of dropping them', async () => {
		const ex = new FakeExchange(
			'binance',
			{ spot: { LDBTC: 0.1, ETH: 1 }, funding: {} },
			{
				sapiGetSimpleEarnFlexiblePosition: async () => {
					throw new Error('no earn permission');
				},
			},
		);
		const [acc] = await ex.fetch();
		const pos = Object.fromEntries(acc!.holdings!.positions.map((p) => [p.symbol, p.quantity]));
		expect(pos).toEqual({ ETH: '1', BTC: '0.1' });
	});

	test('earn failure only warns', async () => {
		const ex = new FakeExchange(
			'okx',
			{ trading: { SOL: 3 }, funding: {} },
			{
				privateGetFinanceSavingsBalance: async () => {
					throw new Error('permission denied');
				},
			},
		);
		const [acc] = await ex.fetch();
		expect(acc!.holdings!.positions).toMatchObject([{ symbol: 'SOL', quantity: '3' }]);
	});
});

// ---------------------------------------------------------------- EVM

describe('evm', () => {
	const addr = '0x1111111111111111111111111111111111111111';
	const rpc = mockServer(async (req) => {
		const batch = (await req.json()) as any[];
		return json(
			batch.map((c) => {
				if (c.method === 'eth_getBalance')
					return { jsonrpc: '2.0', id: c.id, result: '0xde0b6b3a7640000' }; // 1 ETH
				const { to, data } = c.params[0];
				if (data.startsWith('0x313ce567')) return { jsonrpc: '2.0', id: c.id, result: '0x12' }; // 18
				if (to.toLowerCase() === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
					return {
						jsonrpc: '2.0',
						id: c.id,
						result: '0x' + 2_500_000n.toString(16).padStart(64, '0'),
					}; // 2.5 USDC
				if (to === '0x00000000000000000000000000000000000000aa')
					return {
						jsonrpc: '2.0',
						id: c.id,
						result: '0x' + (3n * 10n ** 18n).toString(16).padStart(64, '0'),
					};
				return { jsonrpc: '2.0', id: c.id, result: '0x' + '0'.repeat(64) };
			}),
		);
	});
	afterAll(() => rpc.stop());

	test('native + default + custom tokens, merged per address', async () => {
		const c = new EvmConnector(
			'evm',
			'evm',
			undefined,
			{
				address: addr,
				chains: ['ethereum', 'base'],
				rpc: { ethereum: rpc.url, base: rpc.url },
				tokens: {
					base: [{ address: '0x00000000000000000000000000000000000000aa', symbol: 'aero' }],
				},
			},
			ctx(),
		);
		const [acc] = await c.fetch();
		const pos = Object.fromEntries(acc!.holdings!.positions.map((p) => [p.symbol, p.quantity]));
		expect(pos).toEqual({ ETH: '2', USDC: '2.5', AERO: '3' });
		expect(acc!.key).toBe(`evm:${addr}`);
		expect(acc!.holdings!.positions.find((p) => p.symbol === 'AERO')!.priceRef).toBe(
			'base:0x00000000000000000000000000000000000000aa',
		);
	});

	test('an RPC error fails the connector instead of reading as zero', async () => {
		const bad = mockServer(async (req) => {
			const batch = (await req.json()) as any[];
			return json(
				batch.map((c) => ({
					jsonrpc: '2.0',
					id: c.id,
					error: { code: -32005, message: 'rate limited' },
				})),
			);
		});
		const c = new EvmConnector(
			'evm',
			'evm',
			undefined,
			{ address: addr, chains: ['ethereum'], rpc: { ethereum: bad.url } },
			ctx(),
		);
		await expect(c.fetch()).rejects.toThrow(/rate limited/);
		bad.stop();
	});

	test('split_by_chain keeps emitting a chain that went to zero', async () => {
		let empty = false;
		const srv = mockServer(async (req) => {
			const batch = (await req.json()) as any[];
			return json(
				batch.map((c) => ({
					jsonrpc: '2.0',
					id: c.id,
					result:
						c.method === 'eth_getBalance'
							? empty
								? '0x0'
								: '0xde0b6b3a7640000'
							: '0x' + '0'.repeat(64),
				})),
			);
		});
		const state: Record<string, any> = {};
		const mk = () =>
			new EvmConnector(
				'evm',
				'evm',
				undefined,
				{ address: addr, chains: ['base'], rpc: { base: srv.url }, split_by_chain: true },
				ctx(state),
			);
		expect((await mk().fetch()).map((a) => a.holdings!.positions.length)).toEqual([1]);
		empty = true;
		const again = await mk().fetch();
		expect(again).toHaveLength(1);
		expect(again[0]!.holdings!.positions).toEqual([]);
		srv.stop();
	});

	test('rejects bad address', async () => {
		const c = new EvmConnector('evm', 'evm', undefined, { address: '0x123' }, ctx());
		await expect(c.fetch()).rejects.toThrow(/invalid EVM address/);
	});
});

// ---------------------------------------------------------------- Solana

describe('solana', () => {
	const owner = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
	const rpc = mockServer(async (req) => {
		const batch = (await req.json()) as any[];
		return json(
			batch.map((c) => {
				if (c.method === 'getBalance')
					return { jsonrpc: '2.0', id: c.id, result: { value: 2_500_000_000 } };
				const pid = c.params[1].programId;
				if (
					![
						'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
						'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					].includes(pid)
				) {
					return {
						jsonrpc: '2.0',
						id: c.id,
						error: { code: -32602, message: 'Invalid param: could not find program' },
					};
				}
				const legacy = pid.startsWith('Tokenkeg');
				const tok = (mint: string, amount: string, decimals: number) => ({
					account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } },
				});
				return {
					jsonrpc: '2.0',
					id: c.id,
					result: {
						value: legacy
							? [
									tok('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '1000000', 6),
									tok('UnknownMint1111111111111111111111111111111', '5', 0),
									tok('ZeroMint11111111111111111111111111111111111', '0', 6),
								]
							: [],
					},
				};
			}),
		);
	});
	afterAll(() => rpc.stop());

	test('SOL + known + unknown mints', async () => {
		const c = new SolanaConnector(
			'sol',
			'solana',
			'Phantom',
			{ address: owner, rpc: rpc.url },
			ctx(),
		);
		const [acc] = await c.fetch();
		const pos = Object.fromEntries(acc!.holdings!.positions.map((p) => [p.symbol, p.quantity]));
		expect(pos).toEqual({
			SOL: '2.5',
			USDC: '1',
			'SPL:UnknownMint1111111111111111111111111111111': '5',
		});
		expect(acc!.name).toBe('Phantom 9WzD…AWWM');
	});

	test('unknown_tokens: skip', async () => {
		const c = new SolanaConnector(
			'sol',
			'solana',
			undefined,
			{ address: owner, rpc: rpc.url, unknown_tokens: 'skip' },
			ctx(),
		);
		const [acc] = await c.fetch();
		expect(acc!.holdings!.positions.map((p) => p.symbol)).toEqual(['SOL', 'USDC']);
	});
});

// ---------------------------------------------------------------- Monobank

describe('monobank', () => {
	const now = Math.floor(Date.now() / 1000);
	const items = Array.from({ length: 3 }, (_, i) => ({
		id: `tx${i}`,
		time: now - (3 - i) * 3600,
		description: i === 1 ? 'На банку «Відпустка»' : `Shop ${i}`,
		mcc: 5411,
		hold: false,
		amount: i === 2 ? 50000 : -10000, // -100, -100, +500 UAH
		operationAmount: i === 2 ? 50000 : -10000,
		currencyCode: 980,
		commissionRate: 0,
		cashbackAmount: 0,
		balance: [90000, 80000, 130000][i]! + 100000, // includes 1000 UAH credit limit
	}));
	const server = mockServer((req, url) => {
		if (req.headers.get('x-token') !== 'tok')
			return json({ errorDescription: "Unknown 'X-Token'" }, 403);
		if (url.pathname === '/personal/client-info') {
			return json({
				accounts: [
					{
						id: 'acc1',
						balance: 230000,
						creditLimit: 100000,
						type: 'black',
						currencyCode: 980,
						maskedPan: ['537541******1234'],
						iban: 'UA01',
					},
					{
						id: 'acc2',
						balance: 0,
						creditLimit: 0,
						type: 'white',
						currencyCode: 840,
						maskedPan: ['444111******9999'],
						iban: 'UA02',
					},
				],
				jars: [
					{ id: 'jar1', title: 'Відпустка', currencyCode: 980, balance: 10000, goal: 1000000 },
				],
			});
		}
		if (url.pathname.startsWith('/personal/statement/acc1/')) return json([...items].reverse());
		if (url.pathname.startsWith('/personal/statement/')) return json([]);
		return json({}, 404);
	});
	afterAll(() => server.stop());

	test('cards as transaction accounts, own funds, jar transfers, jars as snapshots', async () => {
		const state: Record<string, any> = {};
		const c = new MonobankConnector(
			'mono',
			'monobank',
			undefined,
			{ token: 'tok', api_url: server.url, min_interval_ms: 0, accounts: ['1234'] },
			ctx(state),
		);
		const accs = await c.fetch();
		expect(accs.map((a) => a.key)).toEqual(['mono:acc1', 'mono:jar:jar1']);
		const card = accs[0]!;
		expect(card.currency).toBe('UAH');
		expect(card.currentBalance).toBe('1300');
		expect(card.name).toBe('Monobank black UAH *1234');
		expect(card.transactions!.map((t) => [t.id, t.amount, t.balanceAfter])).toEqual([
			['tx0', '-100', '900'],
			['tx1', '-100', '800'],
			['tx2', '500', '1300'],
		]);
		expect(card.transactions![1]!.metadata!.transfer).toBe(true);
		expect(card.transactions![0]!.metadata!.transfer).toBeUndefined();
		expect(accs[1]!.holdings!.cash).toEqual({ UAH: '100' });

		expect(state.cursors).toEqual({}); // only committed after a successful write
		c.onSynced();
		expect(state.cursors.acc1).toBe(items[2]!.time);
	});

	test("same-second operations keep the API's order", async () => {
		const t = now - 100;
		const srv = mockServer((_req, url) => {
			if (url.pathname === '/personal/client-info') {
				return json({
					accounts: [{ id: 'x', balance: 0, creditLimit: 0, type: 'black', currencyCode: 980 }],
				});
			}
			// newest first, as the API returns: the fee (zzz) was booked after the purchase (aaa)
			return json([
				{
					id: 'zzz-fee',
					time: t,
					description: 'fee',
					mcc: 0,
					hold: false,
					amount: -100,
					operationAmount: -100,
					currencyCode: 980,
					commissionRate: 0,
					cashbackAmount: 0,
					balance: 0,
				},
				{
					id: 'aaa-buy',
					time: t,
					description: 'buy',
					mcc: 0,
					hold: false,
					amount: -1000,
					operationAmount: -1000,
					currencyCode: 980,
					commissionRate: 0,
					cashbackAmount: 0,
					balance: 100,
				},
			]);
		});
		const c = new MonobankConnector(
			'm',
			'monobank',
			undefined,
			{ token: 'tok', api_url: srv.url, min_interval_ms: 0, jars: false },
			ctx(),
		);
		const [acc] = await c.fetch();
		expect(acc!.transactions!.map((x) => x.id)).toEqual(['aaa-buy', 'zzz-fee']);
		srv.stop();
	});

	test('bad token surfaces an error', async () => {
		const c = new MonobankConnector(
			'mono',
			'monobank',
			undefined,
			{ token: 'bad', api_url: server.url, min_interval_ms: 0 },
			ctx(),
		);
		await expect(c.fetch()).rejects.toThrow(/403/);
	});
});

// ---------------------------------------------------------------- plugins

test('plugin loading by path', async () => {
	const Cls = await resolveConnector('./example-bank.ts', `${import.meta.dir}/../plugins`);
	const c = new Cls('ex', './example-bank.ts', 'Test', { balance: 42, currency: 'EUR' }, ctx());
	const [acc] = await c.fetch();
	expect(acc!.holdings!.cash).toEqual({ EUR: '42' });
	await expect(resolveConnector('nope')).rejects.toThrow(/Unknown connector type/);
});
