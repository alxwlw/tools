import { afterAll, describe, expect, test } from 'bun:test';

import { resolveConnector } from '../src/connectors/base.ts';
import { ExchangeConnector } from '../src/connectors/exchanges.ts';
import { MonobankConnector } from '../src/connectors/monobank.ts';
import { ZerionConnector } from '../src/connectors/zerion.ts';
import { createLogger } from '../src/log.ts';
import { PriceOracle } from '../src/pricing.ts';
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

// ---------------------------------------------------------------- Zerion

describe('zerion', () => {
	const evm = '0xAbCdEf0123456789aBcDeF0123456789abCDef01';
	const sol = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

	// Fields as the live API returns them.
	const position = (
		chain: string,
		symbol: string,
		quantity: string,
		price: number | null,
		more: { type?: string; name?: string; verified?: boolean; contract?: string } = {},
	) => ({
		type: 'positions',
		attributes: {
			name: more.name ?? 'Asset',
			position_type: more.type ?? 'wallet',
			quantity: { numeric: quantity },
			price,
			fungible_info: {
				symbol,
				flags: { verified: more.verified ?? true },
				implementations: [
					{ chain_id: 'other-chain', address: '0xnotthisone' },
					{ chain_id: chain, address: more.contract ?? null },
				],
			},
		},
		relationships: { chain: { data: { type: 'chains', id: chain } } },
	});

	const wallets: Record<string, unknown[]> = {};
	const nextPage: Record<string, string> = {};
	const api = mockServer((req, url) => {
		if (req.headers.get('authorization') !== `Basic ${btoa('key:')}`)
			return json({ errors: [{ title: 'Unauthorized' }] }, 401);
		const address = url.pathname.split('/')[2] ?? '';
		// The live API's answer for Solana.
		if (address === sol && url.searchParams.get('filter[positions]') === 'no_filter')
			return json({ errors: [{ title: 'Malformed parameter was sent' }] }, 400);
		if (url.searchParams.get('page') === '2') return json({ data: wallets[`${address}:2`] });
		return json({ data: wallets[address] ?? [], links: { next: nextPage[address] } });
	});
	afterAll(() => api.stop());

	const connector = (address: string, more: Record<string, unknown> = {}, name?: string) =>
		new ZerionConnector(
			'wallets',
			'zerion',
			name,
			{ api_key: 'key', addresses: [address], api_url: api.url, ...more },
			ctx(),
		);
	const positions = async (address: string) => {
		const [acc] = await connector(address).fetch();
		return acc!.holdings!.positions;
	};

	test('EVM: the same coin adds up across chains, wrapped coins collapse into it', async () => {
		wallets[evm] = [
			position('ethereum', 'ETH', '0.5', 2000),
			position('base', 'ETH', '0.25', 2000),
			position('base', 'WETH', '0.25', 2000, { contract: '0x4200' }),
			position('ethereum', 'WBTC', '0.1', 60000, { contract: '0x2260' }),
		];
		const [acc] = await connector(evm).fetch();
		expect(acc).toMatchObject({
			key: `wallets:${evm.toLowerCase()}`,
			name: 'EVM 0xAbCd…ef01',
			currency: 'USD',
			accountType: 'CRYPTOCURRENCY',
			group: 'Wallets',
		});
		expect(acc!.holdings!.positions).toMatchObject([
			{ symbol: 'ETH', quantity: '1', priceUsd: 2000 },
			{ symbol: 'BTC', quantity: '0.1', priceUsd: 60000 },
		]);
	});

	test('EVM asks for protocol positions too, and leaves trash out', async () => {
		wallets[evm] = [];
		api.calls.length = 0;
		await connector(evm).fetch();
		const params = new URL(`http://x${api.calls[0]!.path}`).searchParams;
		expect(params.get('filter[positions]')).toBe('no_filter');
		expect(params.get('filter[trash]')).toBe('only_non_trash');
		expect(params.get('currency')).toBe('usd');
	});

	test("Solana: the address keeps its case, the request is one the API accepts, rent isn't counted", async () => {
		wallets[sol] = [
			position('solana', 'SOL', '0.5', 90),
			position('solana', 'SOL', '0.05', 90, { type: 'locked', name: 'Rent' }),
		];
		const [acc] = await connector(sol, {}, 'Phantom').fetch();
		expect(acc).toMatchObject({ key: `wallets:${sol}`, name: 'Phantom 9WzD…AWWM' });
		expect(acc!.holdings!.positions).toMatchObject([{ symbol: 'SOL', quantity: '0.5' }]);
	});

	test('an unverified token without a price is dropped', async () => {
		wallets[evm] = [
			position('ethereum', 'ETH', '1', 2000),
			position('base', 'DOGE', '100000', null, { verified: false, contract: '0xdead' }),
		];
		expect((await positions(evm)).map((p) => p.symbol)).toEqual(['ETH']);
	});

	test('a priced unverified token keeps its own symbol: a fake USDT is not cash, a fake ETH adds nothing to ETH', async () => {
		wallets[evm] = [
			position('ethereum', 'ETH', '1', 2000),
			position('base', 'ETH', '500', 0.01, { verified: false, contract: '0xfake0123' }),
			position('base', 'USDT', '1000', 0.01, { verified: false, contract: '0xbad00123' }),
		];
		expect(await positions(evm)).toMatchObject([
			{ symbol: 'ETH', quantity: '1', priceUsd: 2000 },
			{ symbol: 'ETH-fake01', quantity: '500', name: 'ETH', priceUsd: 0.01 },
			{ symbol: 'USDT-bad001', quantity: '1000', name: 'USDT', priceUsd: 0.01 },
		]);
	});

	test('an unverified Solana LP token keeps its value, with the mint in its symbol', async () => {
		wallets[sol] = [
			position('solana', 'SOL-USDC', '0.11', 259, { verified: false, contract: '8HoQnePLq' }),
		];
		expect(await positions(sol)).toMatchObject([
			{ symbol: 'SOL-USDC-8HoQne', name: 'SOL-USDC', priceUsd: 259 },
		]);
	});

	test('a verified coin without a price stays for the engine to price', async () => {
		wallets[evm] = [position('ethereum', 'AAA', '1', null), position('base', 'AAA', '1', 5)];
		expect(await positions(evm)).toMatchObject([{ symbol: 'AAA', quantity: '2', priceUsd: 5 }]);
	});

	test('staked and deposited coins count, debt does not', async () => {
		wallets[evm] = [
			position('ethereum', 'ETH', '1', 2000),
			position('ethereum', 'ETH', '2', 2000, { type: 'staked' }),
			position('ethereum', 'USDC', '100', 1, { type: 'deposit' }),
			position('ethereum', 'DAI', '50', 1, { type: 'loan' }),
		];
		expect(await positions(evm)).toMatchObject([
			{ symbol: 'ETH', quantity: '3' },
			{ symbol: 'USDC', quantity: '100' },
		]);
	});

	test('zero balances are skipped', async () => {
		wallets[evm] = [position('ethereum', 'ETH', '0.000', 2000)];
		expect(await positions(evm)).toEqual([]);
	});

	test('follows links.next when the API paginates', async () => {
		wallets[evm] = [position('ethereum', 'ETH', '1', 2000)];
		wallets[`${evm}:2`] = [position('ethereum', 'BNB', '1', 600)];
		nextPage[evm] = `${api.url}/wallets/${evm}/positions/?page=2`;
		const symbols = (await positions(evm)).map((p) => p.symbol);
		delete nextPage[evm];
		expect(symbols).toEqual(['ETH', 'BNB']);
	});

	test('an API error fails the connector instead of writing an empty snapshot', async () => {
		wallets[evm] = [position('ethereum', 'ETH', '1', 2000)];
		await expect(connector(evm, { api_key: 'wrong' }).fetch()).rejects.toThrow('HTTP 401');
	});

	test('an address of neither kind is rejected before any request', async () => {
		api.calls.length = 0;
		await expect(connector('0x123').fetch()).rejects.toThrow('invalid wallet address');
		expect(api.calls).toEqual([]);
	});

	test('the connector is built in', async () => {
		expect(await resolveConnector('zerion')).toBe(ZerionConnector);
	});
});

describe('prices', () => {
	test("a connector's own price is used without a lookup, stablecoins stay at 1", async () => {
		const token = { symbol: 'SOL-USDC-8HOQNE', quantity: '1', priceUsd: 259 };
		const stable = { symbol: 'USDC', quantity: '1', priceUsd: 0.9993 };
		const prices = await new PriceOracle([], createLogger('test')).priceAll([token, stable]);
		expect(prices.get(token)?.usd).toBe(259);
		expect(prices.get(stable)?.usd).toBe(1);
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
