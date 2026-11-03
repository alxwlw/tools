import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { Config } from '../src/config.ts';
import { Connector } from '../src/connectors/base.ts';
import { SyncEngine } from '../src/engine.ts';
import { createLogger } from '../src/log.ts';
import {
	type AccountData,
	type CashTransaction,
	HoldingsSnapshot,
	type SpendingRule,
} from '../src/models.ts';
import { State } from '../src/state.ts';
import { WealthfolioClient } from '../src/wealthfolio.ts';
import { ctx, json, mockServer } from './helpers.ts';

/** In-memory fake of the parts of the Wealthfolio API wf-sync uses. */
function fakeWealthfolio() {
	const db = {
		accounts: [] as any[],
		assets: [] as any[],
		snapshots: [] as any[],
		activities: [] as any[],
		quotes: [] as any[],
		modes: [] as any[],
		spending: { enabled: true, accountIds: ['enrolled-by-hand'] },
		rules: [] as any[],
	};
	let n = 0;
	let failNextBulk = false;
	let failSpending = false;
	const server = mockServer(async (req, url) => {
		const p = url.pathname.replace('/api/v1', '');
		if (p === '/auth/status') return json({ requiresPassword: true });
		if (p === '/auth/login') {
			const { password } = (await req.json()) as any;
			if (password !== 'pw') return json({ error: 'bad' }, 401);
			return new Response(JSON.stringify({ authenticated: true }), {
				headers: {
					'set-cookie': 'wf_session=tok123; HttpOnly; Path=/',
					'content-type': 'application/json',
				},
			});
		}
		if (req.headers.get('authorization') !== 'Bearer tok123')
			return json({ error: 'unauthorized' }, 401);
		const body = req.method === 'GET' ? undefined : await req.json().catch(() => undefined);
		if (p === '/accounts' && req.method === 'GET') return json(db.accounts);
		if (p === '/accounts' && req.method === 'POST') {
			const a = { id: `acc${++n}`, ...(body as object) };
			db.accounts.push(a);
			return json(a);
		}
		if (p === '/assets' && req.method === 'GET') return json(db.assets);
		if (p === '/assets' && req.method === 'POST') {
			const a = { id: `asset${++n}`, ...(body as object) };
			db.assets.push(a);
			return json(a);
		}
		if (p === '/snapshots') return (db.snapshots.push(body), new Response(null, { status: 200 }));
		if (p === '/activities/bulk') {
			if (failNextBulk) {
				failNextBulk = false;
				return json({ code: 500, message: 'database is locked' }, 500);
			}
			const creates = (body as any).creates as any[];
			for (const c of creates) {
				if (db.activities.some((x) => x.idempotencyKey === c.idempotencyKey)) {
					// Same as the real server: the whole batch is rejected.
					return json({ code: 400, message: 'Duplicate activity detected' }, 400);
				}
			}
			db.activities.push(...creates);
			return json({ created: creates, updated: [], deleted: [], errors: [] });
		}
		if (p === '/activities/search') {
			const { page, pageSize, accountIdFilter } = body as any;
			const rows = db.activities.filter((x) => x.accountId === accountIdFilter);
			return json({
				data: rows.slice(page * pageSize, (page + 1) * pageSize),
				meta: { totalRowCount: rows.length },
			});
		}
		if (p.startsWith('/spending/') && failSpending) return json({ message: 'no such route' }, 404);
		if (p === '/spending/settings' && req.method === 'GET') return json(db.spending);
		if (p === '/spending/settings' && req.method === 'PUT') {
			Object.assign(db.spending, body);
			return json(db.spending);
		}
		if (p === '/spending/rules/upsert') return (db.rules.push(body), json(body));
		if (p === '/market-data/quotes/latest') return json({});
		if (p === '/market-data/sync') return new Response(null, { status: 200 });
		if (p.startsWith('/market-data/quotes/'))
			return (db.quotes.push(body), new Response(null, { status: 204 }));
		if (p.startsWith('/assets/pricing-mode/'))
			return (db.modes.push({ id: p.split('/').pop(), ...(body as object) }), json({}));
		return json({ error: `unhandled ${req.method} ${p}` }, 404);
	});
	return {
		...server,
		db,
		failBulkOnce: () => (failNextBulk = true),
		failSpending: (fail: boolean) => (failSpending = fail),
	};
}

const llama = mockServer((_req, url) => {
	const ids = url.pathname.split('/').pop()!.split(',');
	const coins: Record<string, any> = {};
	for (const id of ids) {
		if (id === 'coingecko:bitcoin') coins[id] = { price: 100000, symbol: 'BTC', confidence: 0.99 };
		if (id === 'solana:MintJTO') coins[id] = { price: 2, symbol: 'JTO', confidence: 0.99 };
	}
	return json({ coins });
});

class StaticConnector extends Connector {
	accounts: AccountData[] = [];
	synced = 0;
	async fetch() {
		return structuredClone(this.accounts).map((a) => {
			if (a.holdings) {
				const h = new HoldingsSnapshot();
				h.positions = a.holdings.positions;
				h.cash = a.holdings.cash;
				a.holdings = h;
			}
			a.transactions = a.transactions?.map((t) => ({ ...t, time: new Date(t.time) }));
			return a;
		});
	}
	override onSynced() {
		this.synced++;
	}
}

class CategorizingConnector extends StaticConnector {
	rules: SpendingRule[] = [{ id: 'r1', name: 'One', pattern: 'x$', categoryId: 'cat_groceries' }];
	override spendingRules() {
		return this.rules;
	}
}

function makeConfig(url: string, dir: string): Config {
	return {
		wealthfolioUrl: url,
		wealthfolioPassword: 'pw',
		baseCurrency: 'USD',
		intervalMinutes: 60,
		stateFile: join(dir, 'state.json'),
		minValueUsd: 1,
		stablecoinsAsCash: true,
		pricing: { manualSymbols: [], exchanges: [] },
		connectors: [],
	};
}

describe('engine', () => {
	const wf = fakeWealthfolio();
	const dir = mkdtempSync(join(tmpdir(), 'wfsync-'));
	const config = makeConfig(wf.url, dir);
	const state = new State(config.stateFile);
	const log = createLogger('test');
	const client = new WealthfolioClient(wf.url, 'pw', log);

	beforeAll(() => {
		process.env.WF_SYNC_LLAMA_URL = llama.url;
	});
	afterAll(() => {
		wf.stop();
		llama.stop();
		delete process.env.WF_SYNC_LLAMA_URL;
	});

	test('holdings: stables → cash, dust dropped, one asset per symbol', async () => {
		const a = new StaticConnector('ex', 'x', undefined, {}, ctx(state.connector('ex')));
		const h1 = new HoldingsSnapshot();
		h1.addPosition({ symbol: 'BTC', quantity: '0.5', priceRef: 'coingecko:bitcoin' });
		h1.addPosition({ symbol: 'USDT', quantity: '100' });
		h1.addPosition({ symbol: 'BTC2', quantity: '0.000001', priceRef: 'coingecko:bitcoin' }); // $0.10 dust
		h1.addCash('EUR', '50');
		const h2 = new HoldingsSnapshot();
		h2.addPosition({ symbol: 'BTC', quantity: '0.1', priceRef: 'coingecko:bitcoin' });
		h2.addPosition({ symbol: 'JTO', quantity: '10', priceRef: 'solana:MintJTO' });
		a.accounts = [
			{ key: 'ex', name: 'Exchange', currency: 'USD', accountType: 'CRYPTOCURRENCY', holdings: h1 },
			{
				key: 'wallet',
				name: 'Wallet',
				currency: 'USD',
				accountType: 'CRYPTOCURRENCY',
				holdings: h2,
			},
		];

		const engine = new SyncEngine(config, state, client, log);
		const summary = await engine.run([a]);
		expect(summary.failed).toEqual([]);
		expect(summary.totalUsd).toBeCloseTo(50000 + 100 + 10000 + 20, 5);

		expect(
			wf.db.accounts.map((x) => [x.name, x.trackingMode, x.provider, x.providerAccountId]),
		).toEqual([
			['Exchange', 'HOLDINGS', 'WF_SYNC', 'ex'],
			['Wallet', 'HOLDINGS', 'WF_SYNC', 'wallet'],
		]);
		expect(wf.db.assets.map((x) => x.instrumentSymbol).sort()).toEqual(['BTC', 'JTO']);
		const btcId = wf.db.assets.find((x) => x.instrumentSymbol === 'BTC')!.id;
		expect(wf.db.snapshots[0]).toMatchObject({
			holdings: [{ assetId: btcId, symbol: 'BTC', quantity: '0.5', currency: 'USD' }],
			cashBalances: { EUR: '50', USD: '100' },
		});
		expect(wf.db.snapshots[1].holdings.map((h: any) => h.symbol)).toEqual(['BTC', 'JTO']);
		expect(wf.db.snapshots[1].holdings[0].assetId).toBe(btcId);
		expect(a.synced).toBe(1);

		// Second run reuses accounts and assets.
		await new SyncEngine(config, new State(config.stateFile), client, log).run([a]);
		expect(wf.db.accounts).toHaveLength(2);
		expect(wf.db.assets).toHaveLength(2);
		expect(wf.db.snapshots).toHaveLength(4);
	});

	test('transactions: opening balance, dedupe, drift adjustment', async () => {
		const st = new State(config.stateFile);
		const bank = new StaticConnector('bank', 'x', undefined, {}, ctx(st.connector('bank')));
		const t = (
			id: string,
			h: number,
			amount: string,
			balanceAfter: string,
			extra: Partial<CashTransaction> = {},
		): CashTransaction => ({
			id,
			time: new Date(Date.UTC(2026, 9, 1, h)),
			amount,
			currency: 'UAH',
			balanceAfter,
			description: id,
			...extra,
		});
		const card: AccountData = {
			key: 'bank:card',
			name: 'Card',
			currency: 'UAH',
			accountType: 'CASH',
			currentBalance: '1300',
			transactions: [
				t('b', 11, '-100', '800', { metadata: { transfer: true, transferGroup: 'g1' } }),
				t('a', 10, '-100', '900'),
				t('c', 12, '500', '1300'),
			],
		};
		bank.accounts = [card];

		await new SyncEngine(config, st, client, log).run([bank]);
		const acts = wf.db.activities.filter((x) => x.idempotencyKey.startsWith('wfsync:bank:card'));
		expect(acts.map((x) => [x.activityType, x.amount, x.sourceRecordId])).toEqual([
			['CREDIT', '1000', 'opening'],
			['WITHDRAWAL', '100', 'a'],
			['TRANSFER_OUT', '100', 'b'],
			['DEPOSIT', '500', 'c'],
		]);
		expect(acts[2].sourceGroupId).toBe('g1');
		expect(acts[0].activityDate).toBe('2026-10-01T09:59:59.000Z');
		expect(wf.db.accounts.find((x) => x.providerAccountId === 'bank:card')).toMatchObject({
			trackingMode: 'TRANSACTIONS',
			accountType: 'CASH',
		});

		// Same window again + one new op: only the new one is imported.
		bank.accounts = [
			{ ...card, transactions: [...card.transactions!, t('d', 13, '-300', '1000')] },
		];
		await new SyncEngine(config, new State(config.stateFile), client, log).run([bank]);
		const after = wf.db.activities.filter((x) => x.idempotencyKey.startsWith('wfsync:bank:card'));
		expect(after.map((x) => x.sourceRecordId)).toEqual(['opening', 'a', 'b', 'c', 'd']);

		// Source says balance is 950 but our books say 1000 → adjustment flagged for review.
		bank.accounts = [{ ...card, currentBalance: '950', transactions: [t('e', 14, '0.00', '950')] }];
		await new SyncEngine(config, new State(config.stateFile), client, log).run([bank]);
		const adj = wf.db.activities
			.filter((x) => x.idempotencyKey.startsWith('wfsync:bank:card'))
			.at(-1);
		expect(adj).toMatchObject({ activityType: 'WITHDRAWAL', amount: '50', needsReview: true });
	});

	test('failed write: opening balance is retried, not lost', async () => {
		const st = new State(join(dir, 's2.json'));
		const bank = new StaticConnector('bank2', 'x', undefined, {}, ctx(st.connector('bank2')));
		bank.accounts = [
			{
				key: 'bank2:card',
				name: 'Card2',
				currency: 'UAH',
				accountType: 'CASH',
				currentBalance: '150',
				transactions: [
					{
						id: 'x1',
						time: new Date(Date.UTC(2026, 9, 2)),
						amount: '50',
						currency: 'UAH',
						balanceAfter: '150',
					},
				],
			},
		];
		const cfg = { ...config, stateFile: join(dir, 's2.json') };
		wf.failBulkOnce();
		const s1 = await new SyncEngine(cfg, st, client, log).run([bank]);
		expect(s1.failed.map((f) => f.id)).toEqual(['bank2']);
		expect(bank.synced).toBe(0);

		await new SyncEngine(cfg, new State(cfg.stateFile), client, log).run([bank]);
		const acts = wf.db.activities.filter((x) => x.idempotencyKey.startsWith('wfsync:bank2:card'));
		expect(acts.map((x) => [x.activityType, x.amount])).toEqual([
			['CREDIT', '100'],
			['DEPOSIT', '50'],
		]);
	});

	test('activities already in Wealthfolio but missing from state are skipped, not a permanent error', async () => {
		const cfg = { ...config, stateFile: join(dir, 's3.json') };
		const mkBank = (st: State) => {
			const b = new StaticConnector('bank3', 'x', undefined, {}, ctx(st.connector('bank3')));
			b.accounts = [
				{
					key: 'bank3:card',
					name: 'Card3',
					currency: 'UAH',
					accountType: 'CASH',
					currentBalance: '70',
					transactions: [
						{
							id: 'y1',
							time: new Date(Date.UTC(2026, 9, 3, 1)),
							amount: '-30',
							currency: 'UAH',
							balanceAfter: '100',
						},
						{
							id: 'y2',
							time: new Date(Date.UTC(2026, 9, 3, 2)),
							amount: '-30',
							currency: 'UAH',
							balanceAfter: '70',
						},
					],
				},
			];
			return b;
		};
		await new SyncEngine(cfg, new State(cfg.stateFile), client, log).run([
			mkBank(new State(cfg.stateFile)),
		]);
		// Simulate a lost state.json, plus one new operation.
		const fresh = new State(join(dir, 's3-lost.json'));
		const b = mkBank(fresh);
		b.accounts[0]!.transactions!.push({
			id: 'y3',
			time: new Date(Date.UTC(2026, 9, 3, 3)),
			amount: '-20',
			currency: 'UAH',
			balanceAfter: '50',
		});
		b.accounts[0]!.currentBalance = '50';
		const s = await new SyncEngine(
			{ ...cfg, stateFile: join(dir, 's3-lost.json') },
			fresh,
			client,
			log,
		).run([b]);
		expect(s.failed).toEqual([]);
		const acts = wf.db.activities.filter((x) => x.idempotencyKey.startsWith('wfsync:bank3:card'));
		expect(acts.map((x) => x.sourceRecordId)).toEqual(['opening', 'y1', 'y2', 'y3']);
	});

	test("a failing connector doesn't stop the others", async () => {
		class Broken extends Connector {
			async fetch(): Promise<AccountData[]> {
				throw new Error('boom');
			}
		}
		const ok = new StaticConnector('ok', 'x', undefined, {}, ctx());
		ok.accounts = [
			{
				key: 'ok',
				name: 'OK',
				currency: 'USD',
				accountType: 'CASH',
				holdings: Object.assign(new HoldingsSnapshot(), { cash: { USD: '1' } }),
			},
		];
		const s = await new SyncEngine(config, new State(config.stateFile), client, log).run([
			new Broken('broken', 'x', undefined, {}, ctx()),
			ok,
		]);
		expect(s.failed).toEqual([{ id: 'broken', error: 'boom' }]);
		expect(s.ok).toEqual(['ok']);
	});

	test('dry run writes nothing', async () => {
		const before = wf.calls.length;
		const ok = new StaticConnector('dry', 'x', undefined, {}, ctx());
		ok.accounts = [
			{
				key: 'dry',
				name: 'Dry',
				currency: 'USD',
				accountType: 'CASH',
				holdings: new HoldingsSnapshot(),
			},
		];
		const orig = console.log;
		console.log = () => {};
		try {
			await new SyncEngine(config, new State(config.stateFile), client, log).run([ok], {
				dryRun: true,
			});
		} finally {
			console.log = orig;
		}
		expect(wf.calls.length).toBe(before);
	});

	describe('spending reports', () => {
		const card = (key: string): AccountData => ({
			key,
			name: key,
			currency: 'UAH',
			accountType: 'CASH',
			transactions: [
				{
					id: `${key}-1`,
					time: new Date('2026-01-10T10:00:00Z'),
					amount: '-5',
					currency: 'UAH',
					balanceAfter: '95',
				},
			],
		});
		const jar = (key: string): AccountData => ({
			key,
			name: key,
			currency: 'UAH',
			accountType: 'CASH',
			holdings: new HoldingsSnapshot(),
		});
		const accountId = (key: string) => wf.db.accounts.find((a) => a.providerAccountId === key).id;
		const run = (c: Connector) => new SyncEngine(config, state, client, log).run([c]);
		const connector = (id: string) => new CategorizingConnector(id, 'x', undefined, {}, ctx());

		test('a card joins the reports before its operations arrive, a jar and others stay out', async () => {
			const c = connector('cat1');
			c.accounts = [card('cat1-card'), jar('cat1-jar')];
			const plain = new StaticConnector('cat1-plain', 'x', undefined, {}, ctx());
			plain.accounts = [card('cat1-plain-card')];
			const from = wf.calls.length;
			await run(c);
			await run(plain);

			expect(wf.db.spending.accountIds).toContain('enrolled-by-hand');
			expect(wf.db.spending.accountIds).toContain(accountId('cat1-card'));
			expect(wf.db.spending.accountIds).not.toContain(accountId('cat1-jar'));
			expect(wf.db.spending.accountIds).not.toContain(accountId('cat1-plain-card'));

			const paths = wf.calls.slice(from).map((x) => `${x.method} ${x.path}`);
			const enrol = paths.indexOf('PUT /api/v1/spending/settings');
			const firstImport = paths.indexOf('POST /api/v1/activities/bulk');
			expect(enrol).toBeGreaterThan(-1);
			expect(enrol).toBeLessThan(firstImport);
		});

		test('rules are seeded as low-priority regex rules, after the import', async () => {
			const c = connector('cat2');
			c.accounts = [card('cat2-card')];
			const from = wf.calls.length;
			await run(c);
			const rule = wf.db.rules.at(-1);
			expect(rule).toEqual({
				id: 'r1',
				name: 'One',
				pattern: 'x$',
				categoryId: 'cat_groceries',
				matchType: 'regex',
				taxonomyId: 'spending_categories',
				activityType: 'WITHDRAWAL',
				priority: -100,
				isGlobal: true,
			});
			const paths = wf.calls.slice(from).map((x) => x.path);
			expect(paths.indexOf('/api/v1/spending/rules/upsert')).toBeGreaterThan(
				paths.indexOf('/api/v1/activities/bulk'),
			);
		});

		test('later runs leave what you changed in the UI, until the rule table changes', async () => {
			const c = connector('cat3');
			c.accounts = [card('cat3-card')];
			await run(c);
			const rules = wf.db.rules.length;
			wf.db.spending.accountIds = wf.db.spending.accountIds.filter(
				(a) => a !== accountId('cat3-card'),
			);

			await run(c);
			expect(wf.db.spending.accountIds).not.toContain(accountId('cat3-card'));
			expect(wf.db.rules.length).toBe(rules);

			c.rules = [{ id: 'r1', name: 'One', pattern: 'y$', categoryId: 'cat_travel' }];
			await run(c);
			expect(wf.db.rules.length).toBe(rules + 1);
			expect(wf.db.rules.at(-1).pattern).toBe('y$');
		});

		test('a failure only warns: the balances still land, and the next run tries again', async () => {
			const c = connector('cat4');
			c.accounts = [card('cat4-card')];
			wf.failSpending(true);
			const failed = await run(c);
			wf.failSpending(false);
			expect(failed.failed).toEqual([]);
			expect(failed.ok).toEqual(['cat4']);
			expect(c.synced).toBe(1);
			expect(wf.db.activities.some((a) => a.sourceRecordId === 'cat4-card-1')).toBe(true);
			expect(wf.db.spending.accountIds).not.toContain(accountId('cat4-card'));
			const rules = wf.db.rules.length;

			await run(c);
			expect(wf.db.spending.accountIds).toContain(accountId('cat4-card'));
			expect(wf.db.rules.length).toBe(rules + 1);
		});
	});
});
