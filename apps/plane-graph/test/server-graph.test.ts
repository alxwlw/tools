import { describe, expect, test } from 'bun:test';

import type { Config, TenantConfig } from '../src/config.ts';
import type { AgentRunIn } from '../src/contract.ts';
import { buildGraph, buildSnapshot } from '../src/graph.ts';
import type { LogEntry } from '../src/log.ts';
import { createHandler, MAX_RUN_BODY } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { copyOf } from './copy-builder.ts';

const NOW = 1_800_000_000_000;
const PLANE_URL = 'https://plane.example.com';
const PUBLIC_URL = 'https://plane-graph.example.com';
const READ = 'read-key-1111';
const AGENT = 'agent-key-2222';
const EVIL_READ = '"><script>alert(1)</script>';

const tenant = (id: string, readKey: string, agentKey: string): TenantConfig => ({
	id,
	workspaceSlug: `${id}-ws`,
	workspaceId: `00000000-0000-4000-8000-00000000000${id.length}`,
	clientId: 'client',
	installationId: 'inst',
	planeSecret: 'plane-secret',
	webhookSecret: 'hook-secret',
	readKey,
	agentKey,
});
const config = (): Config => ({
	planeUrl: PLANE_URL,
	publicUrl: PUBLIC_URL,
	dbPath: ':memory:',
	port: 8080,
	tenants: new Map([
		['acme', tenant('acme', READ, AGENT)],
		['evil', tenant('evil', EVIL_READ, 'agent-key-4444')],
		['other', tenant('other', 'read-key-3333', 'agent-key-5555')],
	]),
});

const COPY = copyOf({
	tasks: [{ key: 'ABC-1' }, { key: 'ABC-2', labels: ['код:api'] }],
	edges: [['ABC-1', 'blocks', 'ABC-2']],
});

function setup(accept: (tenant: string, run: AgentRunIn) => Promise<boolean> = async () => true) {
	const store = new Store(':memory:');
	const { syncedAt, ...data } = COPY;
	store.replaceCopy('acme', data, syncedAt as string);
	const logs: LogEntry[] = [];
	const accepted: { tenant: string; run: AgentRunIn }[] = [];
	const handler = createHandler({
		config: config(),
		store,
		log: (e) => logs.push(e),
		now: () => NOW,
		enqueue: () => {},
		assets: new Map([['graph', 'console.log("graph")']]),
		acceptRun: (t, run) => {
			accepted.push({ tenant: t, run });
			return accept(t, run);
		},
	});
	return { handler, store, logs, accepted };
}

const get = (path: string, headers: Record<string, string> = {}) =>
	new Request(`http://localhost${path}`, { headers });
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const run = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	runId: 'run-77',
	kind: 'batch',
	startedAt: '2026-02-01T10:00:00.000Z',
	finishedAt: '2026-02-01T10:05:00.000Z',
	relationsAdded: [{ fromId: 'item:ABC-1', toId: 'item:ABC-2' }],
	labelsAdded: [{ itemId: 'item:ABC-2', label: 'код:api' }],
	skipped: 3,
	costUsd: 0.42,
	...over,
});
const postRun = (body: unknown, headers: Record<string, string> = bearer(AGENT)) =>
	new Request('http://localhost/t/acme/agent-runs', {
		method: 'POST',
		headers,
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
const UNAUTHORIZED = { error: 'unauthorized' };

describe('graph.json', () => {
	test('graph.json по ключу чтения', async () => {
		const { handler, store } = setup();
		const res = await handler(get(`/t/acme/graph.json?k=${READ}`));
		expect(res.status).toBe(200);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(await res.json()).toEqual(
			JSON.parse(
				JSON.stringify(
					buildGraph(store.copy('acme'), {
						planeUrl: PLANE_URL,
						workspaceSlug: 'acme-ws',
						lastRun: null,
						now: new Date(NOW),
					}),
				),
			),
		);
	});

	test('граф берёт данные своего тенанта', async () => {
		const { handler } = setup();
		const res = await handler(get('/t/other/graph.json?k=read-key-3333'));
		const body = (await res.json()) as { items: unknown[] };
		expect(res.status).toBe(200);
		expect(body.items).toEqual([]);
	});
});

describe('доступ', () => {
	test('не тот ключ', async () => {
		const { handler } = setup();
		const attempts = [
			get('/t/acme/graph.json'),
			get('/t/acme/graph.json?k='),
			get('/t/acme/graph.json?k=wrong'),
			get(`/t/acme/graph.json?k=${AGENT}`),
			get(`/t/acme/graph.json?k=${READ}x`),
			get('/t/acme/graph.json?k=read-key-3333'),
			get(`/t/acme/graph?k=${AGENT}`),
			get(`/t/acme/plane-block.html?k=${AGENT}`),
			get('/t/acme/snapshot.json', bearer(READ)),
			get('/t/acme/snapshot.json'),
			get('/t/acme/snapshot.json', { authorization: AGENT }),
			get('/t/acme/snapshot.json', bearer('')),
			get(`/t/acme/snapshot.json?k=${AGENT}`),
			postRun(run(), bearer(READ)),
			postRun(run(), {}),
		];
		for (const req of attempts) {
			const res = await handler(req);
			expect([req.method, new URL(req.url).pathname, res.status]).toEqual([
				req.method,
				new URL(req.url).pathname,
				401,
			]);
			expect(await res.json()).toEqual(UNAUTHORIZED);
		}
	});

	test('неизвестный тенант — 404, без проверки ключа', async () => {
		const { handler } = setup();
		for (const req of [
			get(`/t/nobody/graph.json?k=${READ}`),
			get('/t/nobody/graph.json'),
			get('/t/nobody/snapshot.json', bearer(AGENT)),
			new Request('http://localhost/t/nobody/agent-runs', { method: 'POST', body: '{}' }),
		]) {
			expect((await handler(req)).status).toBe(404);
		}
	});

	test('неизвестный путь и не тот метод', async () => {
		const { handler } = setup();
		expect((await handler(get(`/t/acme/nothing?k=${READ}`))).status).toBe(404);
		expect((await handler(get(`/t/acme/agent-runs`, bearer(AGENT)))).status).toBe(405);
		const wrong = new Request(`http://localhost/t/acme/graph.json?k=${READ}`, { method: 'POST' });
		expect((await handler(wrong)).status).toBe(405);
		const asset = new Request('http://localhost/assets/graph.js', { method: 'POST' });
		expect((await handler(asset)).status).toBe(405);
	});

	test('ключа нет в логе', async () => {
		const { handler, logs } = setup(async () => {
			throw new Error(`boom ${AGENT}`);
		});
		const requests = [
			get(`/t/acme/graph.json?k=${READ}`),
			get(`/t/acme/graph?k=${READ}`),
			get('/t/acme/graph.json?k=wrong-k-9999'),
			get('/t/acme/snapshot.json', bearer(AGENT)),
			get('/t/acme/snapshot.json', bearer('wrong-agent-8888')),
			postRun(run()),
			postRun(run(), bearer('wrong-agent-8888')),
		];
		const statuses: number[] = [];
		for (const req of requests) statuses.push((await handler(req)).status);
		expect(statuses).toEqual([200, 200, 401, 200, 401, 500, 401]);
		expect(logs).toEqual([
			{
				event: 'http.failed',
				level: 'error',
				route: 'agent-runs',
				tenant: 'acme',
				reason: 'internal',
			},
		]);
		const dump = JSON.stringify(logs);
		for (const secret of [READ, AGENT, 'wrong-k-9999', 'wrong-agent-8888', 'Bearer', '?k=']) {
			expect(dump).not.toContain(secret);
		}
	});
});

describe('снимок и проход агента', () => {
	test('снимок по ключу агента', async () => {
		const { handler, store } = setup();
		const res = await handler(get('/t/acme/snapshot.json', bearer(AGENT)));
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('access-control-allow-origin')).toBeNull();
		expect(await res.json()).toEqual(
			JSON.parse(
				JSON.stringify(
					buildSnapshot(store.copy('acme'), {
						workspaceSlug: 'acme-ws',
						lastRun: null,
						rejected: store.rejected('acme'),
						now: new Date(NOW),
					}),
				),
			),
		);
	});

	test('проход агента', async () => {
		const answers = [true, false];
		const { handler, accepted } = setup(async () => answers.shift() as boolean);
		const first = await handler(postRun({ ...run(), extra: 'dropped' }));
		expect(first.status).toBe(201);
		expect(await first.json()).toEqual({ ok: true });
		expect(accepted).toEqual([{ tenant: 'acme', run: run() as unknown as AgentRunIn }]);
		const again = await handler(postRun(run()));
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual({ ok: true });
		expect(accepted.length).toBe(2);
	});

	test('costUsd null и пустые списки принимаются', async () => {
		const { handler, accepted } = setup();
		const res = await handler(
			postRun(run({ costUsd: null, relationsAdded: [], labelsAdded: [], skipped: 0 })),
		);
		expect(res.status).toBe(201);
		expect(accepted[0]?.run.costUsd).toBeNull();
	});

	const BAD: [string, unknown, string][] = [
		['нет runId', run({ runId: undefined }), 'runId'],
		['пустой runId', run({ runId: '' }), 'runId'],
		['неверный kind', run({ kind: 'weekly' }), 'kind'],
		['startedAt не время', run({ startedAt: 'yesterday' }), 'startedAt'],
		['finishedAt не строка', run({ finishedAt: 5 }), 'finishedAt'],
		['relationsAdded не массив', run({ relationsAdded: {} }), 'relationsAdded'],
		['элемент relationsAdded не объект', run({ relationsAdded: [null] }), 'relationsAdded[0]'],
		[
			'fromId не строка',
			run({ relationsAdded: [{ fromId: 7, toId: 'item:ABC-2' }] }),
			'relationsAdded[0].fromId',
		],
		[
			'toId второй связи пуст',
			run({
				relationsAdded: [
					{ fromId: 'a', toId: 'b' },
					{ fromId: 'c', toId: '' },
				],
			}),
			'relationsAdded[1].toId',
		],
		['labelsAdded не массив', run({ labelsAdded: 'x' }), 'labelsAdded'],
		[
			'label не строка',
			run({
				labelsAdded: [
					{ itemId: 'a', label: 'x' },
					{ itemId: 'b', label: null },
				],
			}),
			'labelsAdded[1].label',
		],
		['itemId нет', run({ labelsAdded: [{ label: 'x' }] }), 'labelsAdded[0].itemId'],
		['skipped дробный', run({ skipped: 1.5 }), 'skipped'],
		['skipped отрицательный', run({ skipped: -1 }), 'skipped'],
		['costUsd строка', run({ costUsd: '1' }), 'costUsd'],
		['costUsd нет', run({ costUsd: undefined }), 'costUsd'],
		['costUsd отрицательный', run({ costUsd: -0.1 }), 'costUsd'],
		['тело — массив', [], 'body'],
		['тело — null', null, 'body'],
		['не JSON', '{oops', 'body'],
	];
	test.each(BAD)('400: %s', async (_name, body, detail) => {
		const { handler, accepted } = setup();
		const res = await handler(postRun(body));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'bad_request', detail });
		expect(accepted).toEqual([]);
	});

	test('первое неверное поле, а не последнее', async () => {
		const { handler } = setup();
		const res = await handler(postRun(run({ kind: 'x', skipped: -1, costUsd: 'z' })));
		expect(await res.json()).toEqual({ error: 'bad_request', detail: 'kind' });
	});

	test('тело больше 1 MiB — 400 body, с заголовком длины и без', async () => {
		const { handler, accepted } = setup();
		const big = JSON.stringify(run({ runId: 'x'.repeat(MAX_RUN_BODY) }));
		const sized = await handler(postRun(big));
		expect(sized.status).toBe(400);
		expect(await sized.json()).toEqual({ error: 'bad_request', detail: 'body' });
		const stream = new Request('http://localhost/t/acme/agent-runs', {
			method: 'POST',
			headers: bearer(AGENT),
			body: new ReadableStream({
				start(c) {
					c.enqueue(new TextEncoder().encode(big));
					c.close();
				},
			}),
			duplex: 'half',
		} as RequestInit);
		const streamed = await handler(stream);
		expect(streamed.status).toBe(400);
		expect(await streamed.json()).toEqual({ error: 'bad_request', detail: 'body' });
		expect(accepted).toEqual([]);
	});
});

describe('страницы и код графа', () => {
	test('страница и оболочка', async () => {
		const { handler } = setup();
		const page = await handler(get(`/t/acme/graph?k=${READ}`));
		expect(page.status).toBe(200);
		expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(page.headers.get('cache-control')).toBe('no-store');
		expect(page.headers.get('content-disposition')).toBeNull();
		const html = await page.text();
		expect(html).toContain('<title>Граф задач</title>');
		expect(html).toContain('src="/assets/graph.js"');
		expect(html).toContain(`data-graph="/t/acme/graph.json?k=${READ}"`);

		const block = await handler(get(`/t/acme/plane-block.html?k=${READ}`));
		expect(block.status).toBe(200);
		expect(block.headers.get('content-disposition')).toBe(
			'attachment; filename="plane-graph.html"',
		);
		const shell = await block.text();
		expect(shell).toContain(`src="${PUBLIC_URL}/assets/graph.js"`);
		expect(shell).toContain(`data-graph="${PUBLIC_URL}/t/acme/graph.json?k=${READ}"`);
		expect(shell.startsWith('<!doctype html>')).toBe(true);
		expect(shell).toContain('<meta charset="utf-8">');
		expect(shell).toContain('<div id="graph"></div>');
	});

	test('ключ в странице экранирован', async () => {
		const { handler } = setup();
		for (const name of ['graph', 'plane-block.html']) {
			const res = await handler(get(`/t/evil/${name}?k=${encodeURIComponent(EVIL_READ)}`));
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).not.toContain('"><script>alert');
			expect(html).not.toContain('<script>alert');
			expect(html).toContain(`graph.json?k=${encodeURIComponent(EVIL_READ)}"`);
		}
	});

	test('код графа', async () => {
		const { handler } = setup();
		const res = await handler(get('/assets/graph.js'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(res.headers.get('cache-control')).toBe('no-cache');
		expect(await res.text()).toBe('console.log("graph")');
		expect((await handler(get('/assets/other.js'))).status).toBe(404);
	});
});
