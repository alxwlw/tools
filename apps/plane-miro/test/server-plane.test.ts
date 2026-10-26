// Adapted from apps/plane-discord/test/server-plane.test.ts.
import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { Tenant } from '../src/config.ts';
import { jsonLog, type LogEntry } from '../src/log.ts';
import type { PlaneEvent } from '../src/plane/webhook.ts';
import { createHandler, MAX_PLANE_BODY, readBounded, type ServerDeps } from '../src/server.ts';
import { miroOauthHandler } from '../src/miro/oauth.ts';
import { Store } from '../src/store.ts';
import { fixture } from './fixtures.ts';
import { configOf } from './config-fixture.ts';
import { jwt, world } from './world.ts';

const WORKSPACE = '00000000-0000-4000-8000-000000000002';
const SECRET = 'test-secret';
const tenant = (id: string, workspaceId: string, webhookSecret: string): Tenant => ({
	id,
	workspace: 'example-ws',
	workspaceId,
	auth: { clientId: 'cid', clientSecret: 'csecret', appInstallationId: 'inst' },
	webhookSecret,
	miroTeamId: '3458764500000000001',
	embed: false,
	keepSource: true,
	silenceHours: 72,
	hiddenProjects: [],
});

function setup(opts: { store?: Store } = {}) {
	const store = opts.store ?? new Store(':memory:');
	const events: PlaneEvent[] = [];
	const logs: LogEntry[] = [];
	let clock = 1_000;
	const handler = createHandler({
		tenantsByWorkspace: new Map([
			[WORKSPACE, tenant('initech', WORKSPACE, SECRET)],
			['other-ws', tenant('other', 'other-ws', 'other-secret')],
		]),
		store,
		enqueue: (e) => events.push(e),
		log: (e) => logs.push(e),
		now: () => (clock += 7),
	});
	return { handler, store, events, logs };
}

const URL_ = 'http://localhost/plane/webhook';
const sign = (raw: string | Uint8Array, secret = SECRET) =>
	createHmac('sha256', secret).update(raw).digest('hex');
const post = (
	raw: string | Uint8Array,
	signature: string | null,
	headers: Record<string, string> = {},
) =>
	new Request(URL_, {
		method: 'POST',
		body: raw,
		headers: { ...(signature === null ? {} : { 'x-plane-signature': signature }), ...headers },
	});
const fixtureRequest = (name: string, headers: Record<string, string> = {}) => {
	const fx = fixture(name);
	return post(fx.raw, fx.headers['x-plane-signature']!, headers);
};
const edited = (name: string, edit: (body: any) => void): string => {
	const body = structuredClone(fixture(name).body) as any;
	edit(body);
	return JSON.stringify(body);
};
const CHANGED = 'plane-issue-renamed';
const CHANGED_KEY = `issue.changed:${(fixture(CHANGED).body as any).data.id}:name:${(fixture(CHANGED).body as any).data.last_activity_at}`;
const only = (logs: LogEntry[], event: string) => logs.filter((l) => l.event === event);

describe('POST /plane/webhook', () => {
	test('подписанная доставка → 200, один enqueue, plane.accepted, lastEventAt выставлен', async () => {
		const { handler, store, events, logs } = setup();
		const res = await handler(fixtureRequest(CHANGED, { 'x-plane-delivery': 'd-1' }));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: 'workitem.changed', tenant: 'initech' });
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			event: 'plane.accepted',
			tenant: 'initech',
			kind: 'workitem.changed',
			eventKey: CHANGED_KEY,
		});
		expect(logs[0]!.level).toBeUndefined();
		// the fake clock moves 7 ms per reading: start, touchEvent, claim, end
		expect(store.silence('initech').lastEventAt).toBe(1_000 + 7 * 2);
		expect(logs[0]!.ms).toBe(7 * 3);
		expect(store.silence('other').lastEventAt).toBeNull();
	});

	test('повтор той же доставки → 200, enqueue не вызван, plane.duplicate', async () => {
		const { handler, events, logs } = setup();
		await handler(fixtureRequest(CHANGED, { 'x-plane-delivery': 'd-1' }));
		const res = await handler(fixtureRequest(CHANGED, { 'x-plane-delivery': 'd-1' }));
		expect(res.status).toBe(200);
		expect(events).toHaveLength(1);
		expect(only(logs, 'plane.duplicate')).toEqual([
			{
				event: 'plane.duplicate',
				tenant: 'initech',
				kind: 'workitem.changed',
				eventKey: CHANGED_KEY,
			},
		]);
	});

	test('вторая доставка того же комментария (другой x-plane-delivery) → 200, enqueue не вызван, plane.duplicate', async () => {
		const { handler, events, logs } = setup();
		await handler(fixtureRequest('plane-comment-miro-link', { 'x-plane-delivery': 'd-98' }));
		const res = await handler(
			fixtureRequest('plane-comment-miro-link-dup', { 'x-plane-delivery': 'd-99' }),
		);
		expect(res.status).toBe(200);
		expect(events).toHaveLength(1);
		expect(only(logs, 'plane.accepted')).toHaveLength(1);
		expect(only(logs, 'plane.duplicate')).toHaveLength(1);
	});

	test('тот же ключ у разных тенантов не дедуплицируется между ними', async () => {
		const { handler, events } = setup();
		const body = edited(CHANGED, (b) => (b.workspace_id = 'other-ws'));
		await handler(fixtureRequest(CHANGED));
		await handler(post(body, sign(body, 'other-secret')));
		expect(events.map((e) => e.tenant)).toEqual(['initech', 'other']);
	});

	test('неверная подпись → 200, без enqueue, level error, reason bad_signature', async () => {
		const { handler, store, events, logs } = setup();
		const fx = fixture(CHANGED);
		const wrong = [
			sign(fx.raw, 'rotated-secret'),
			sign(fx.raw, 'other-secret'),
			'',
			'zz',
			fx.headers['x-plane-signature']!.slice(2),
			null,
		];
		for (const signature of wrong) {
			const res = await handler(post(fx.raw, signature));
			expect(res.status).toBe(200);
			expect(await res.text()).toBe('ok');
		}
		// the signature of another tenant does not open this one, and a changed body breaks the right one
		expect((await handler(post(`${fx.raw} `, fx.headers['x-plane-signature']!))).status).toBe(200);
		expect(events).toEqual([]);
		const rejected = only(logs, 'plane.rejected');
		expect(rejected).toHaveLength(wrong.length + 1);
		for (const entry of rejected)
			expect(entry).toEqual({
				event: 'plane.rejected',
				level: 'error',
				reason: 'bad_signature',
				tenant: 'initech',
			});
		// an unsigned delivery is not a sign of life
		expect(store.silence('initech').lastEventAt).toBeNull();
	});

	test('неизвестный workspace_id, не JSON, тело больше 4 MiB → 200, plane.rejected с нужным reason', async () => {
		const { handler, events, logs } = setup();
		const unknown = edited(CHANGED, (b) => (b.workspace_id = 'ws-nobody'));
		const cases: Array<[Request, string, string | undefined]> = [
			[post(unknown, sign(unknown)), 'unknown_workspace', 'ws-nobody'],
			[post('not json', sign('not json')), 'unknown_workspace', undefined],
			[post('', null), 'unknown_workspace', undefined],
			[post('null', sign('null')), 'unknown_workspace', undefined],
			[post(`{"workspace_id":"${'w'.repeat(100)}"}`, null), 'unknown_workspace', 'w'.repeat(64)],
			[post(new Uint8Array([0xff, 0xfe, 0x00]), null), 'unknown_workspace', undefined],
			[post('x'.repeat(MAX_PLANE_BODY + 1), null), 'too_large', undefined],
		];
		for (const [req, reason, workspaceId] of cases) {
			logs.length = 0;
			const res = await handler(req);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe('ok');
			expect(logs).toEqual([
				{
					event: 'plane.rejected',
					level: 'error',
					reason,
					...(workspaceId ? { workspaceId } : {}),
				},
			]);
		}
		expect(events).toEqual([]);
	});

	test('лимит тела — 4 MiB; запрос без тела — plane.rejected, а не сбой', async () => {
		expect(MAX_PLANE_BODY).toBe(4_194_304);
		const { handler, logs } = setup();
		const res = await handler(new Request(URL_, { method: 'POST' }));
		expect(res.status).toBe(200);
		expect(logs).toEqual([
			{ event: 'plane.rejected', level: 'error', reason: 'unknown_workspace' },
		]);
	});

	test('тело из нескольких кусков собирается целиком: подпись сходится', async () => {
		const { handler, events } = setup();
		const fx = fixture(CHANGED);
		const bytes = new TextEncoder().encode(fx.raw);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, 100));
				controller.enqueue(bytes.slice(100, 700));
				controller.enqueue(bytes.slice(700));
				controller.close();
			},
		});
		const req = new Request(URL_, {
			method: 'POST',
			body: stream,
			duplex: 'half',
			headers: { 'x-plane-signature': fx.headers['x-plane-signature']! },
		} as RequestInit);
		expect((await handler(req)).status).toBe(200);
		expect(events).toHaveLength(1);
	});

	test('тело ровно 4 MiB не too_large; без content-length читается потоком и режется на лету', async () => {
		const { handler, logs } = setup();
		const exact = 'x'.repeat(MAX_PLANE_BODY);
		await handler(post(exact, null));
		expect(logs).toEqual([
			{ event: 'plane.rejected', level: 'error', reason: 'unknown_workspace' },
		]);

		logs.length = 0;
		let pulled = 0;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new Uint8Array(1024 * 1024));
				if (pulled > 50) controller.close();
			},
			cancel() {
				cancelled = true;
			},
		});
		const req = new Request(URL_, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
		expect(req.headers.get('content-length')).toBeNull();
		const res = await handler(req);
		expect(res.status).toBe(200);
		expect(logs).toEqual([{ event: 'plane.rejected', level: 'error', reason: 'too_large' }]);
		expect(cancelled).toBe(true);
		expect(pulled).toBeLessThan(10);
	});

	test('объявленный content-length больше лимита → too_large, хотя само тело маленькое', async () => {
		const { handler, logs } = setup();
		const req = new Request(URL_, {
			method: 'POST',
			body: 'tiny',
			headers: { 'content-length': String(MAX_PLANE_BODY + 1) },
		});
		expect(req.headers.get('content-length')).toBe(String(MAX_PLANE_BODY + 1));
		const res = await handler(req);
		expect(res.status).toBe(200);
		expect(logs).toEqual([{ event: 'plane.rejected', level: 'error', reason: 'too_large' }]);
	});

	test('подписанная доставка, которую разбор не принимает → 200, bad_payload, level error', async () => {
		const { handler, events, logs, store } = setup();
		const body = edited(CHANGED, (b) => (b.data.sequence_id = 1e300));
		const res = await handler(post(body, sign(body)));
		expect(res.status).toBe(200);
		expect(events).toEqual([]);
		expect(logs).toEqual([
			{
				event: 'plane.rejected',
				level: 'error',
				reason: 'bad_payload',
				tenant: 'initech',
				detail: 'data.sequence_id is not an integer',
			},
		]);
		// the signature was valid, so the webhook is alive
		expect(store.silence('initech').lastEventAt).not.toBeNull();
		for (const raw of ['null', '[]', '"s"', '7', '{"workspace_id":"' + WORKSPACE + '"}']) {
			logs.length = 0;
			const r = await handler(post(raw, sign(raw)));
			expect(r.status).toBe(200);
			expect(logs).toMatchObject([{ event: 'plane.rejected', level: 'error' }]);
		}
	});

	test('порядок: неподписанное тело с битым содержимым — bad_signature, не bad_payload; ключ дедупа не занят', async () => {
		const { handler, store, events, logs } = setup();
		const broken = [
			edited(CHANGED, (b) => (b.data.sequence_id = 1e300)),
			JSON.stringify({ workspace_id: WORKSPACE }),
		];
		for (const raw of broken) {
			logs.length = 0;
			expect((await handler(post(raw, sign(raw, 'wrong')))).status).toBe(200);
			expect(logs).toEqual([
				{ event: 'plane.rejected', level: 'error', reason: 'bad_signature', tenant: 'initech' },
			]);
			expect(store.silence('initech').lastEventAt).toBeNull();
		}
		// an unsigned copy of a valid delivery must not burn its dedup key
		const fx = fixture(CHANGED);
		logs.length = 0;
		await handler(post(fx.raw, sign(fx.raw, 'wrong')));
		expect(logs.map((l) => l.reason)).toEqual(['bad_signature']);
		expect(events).toEqual([]);
		logs.length = 0;
		await handler(post(fx.raw, fx.headers['x-plane-signature']!));
		expect(logs.map((l) => l.event)).toEqual(['plane.accepted']);
		expect(events).toHaveLength(1);
	});

	test('log бросает на любом вызове → ответ всё равно 200 (принятая, отвергнутая, дубликат, игнорируемая)', async () => {
		const store = new Store(':memory:');
		const events: PlaneEvent[] = [];
		const handler = createHandler({
			tenantsByWorkspace: new Map([[WORKSPACE, tenant('initech', WORKSPACE, SECRET)]]),
			store,
			enqueue: (e) => events.push(e),
			log: () => {
				throw new Error('EPIPE');
			},
		});
		const ignored = edited('plane-issue-state', (b) => (b.activity.field = 'description'));
		const requests: Array<() => Request> = [
			() => fixtureRequest(CHANGED), // accepted
			() => fixtureRequest(CHANGED), // duplicate
			() => post(ignored, sign(ignored)), // ignored
			() => post('{"workspace_id":"' + WORKSPACE + '"}', 'zz'), // bad_signature
			() => post('{"workspace_id":"nope"}', 'zz'), // unknown_workspace
		];
		for (const make of requests) {
			const res = await handler(make());
			expect(res.status).toBe(200);
			expect(await res.text()).toBe('ok');
		}
		expect(events).toHaveLength(1);
	});

	test('игнорируемая доставка → 200, plane.ignored, enqueue не вызван, ключ не занят', async () => {
		const { handler, events, logs, store } = setup();
		const body = edited('plane-issue-state', (b) => (b.activity.field = 'description'));
		const res = await handler(post(body, sign(body)));
		expect(res.status).toBe(200);
		expect(events).toEqual([]);
		expect(logs).toEqual([{ event: 'plane.ignored', tenant: 'initech' }]);
		expect(store.silence('initech').lastEventAt).not.toBeNull();
	});

	test('сбой внутри обработчика (store или enqueue бросает) → 200, reason internal, текст ошибки не в логе', async () => {
		const store = new Store(':memory:');
		store.claim = () => {
			throw new Error('SECRET-ERROR-TEXT');
		};
		const a = setup({ store });
		const res = await a.handler(fixtureRequest(CHANGED));
		expect(res.status).toBe(200);
		expect(a.logs).toEqual([{ event: 'plane.rejected', level: 'error', reason: 'internal' }]);

		const logs: LogEntry[] = [];
		const handler = createHandler({
			tenantsByWorkspace: new Map([[WORKSPACE, tenant('initech', WORKSPACE, SECRET)]]),
			store: new Store(':memory:'),
			enqueue: () => {
				throw new Error('SECRET-ERROR-TEXT');
			},
			log: (e) => logs.push(e),
		});
		expect((await handler(fixtureRequest(CHANGED))).status).toBe(200);
		expect(logs).toEqual([{ event: 'plane.rejected', level: 'error', reason: 'internal' }]);
	});

	test('now по умолчанию — Date.now', async () => {
		const logs: LogEntry[] = [];
		const store = new Store(':memory:');
		const handler = createHandler({
			tenantsByWorkspace: new Map([[WORKSPACE, tenant('initech', WORKSPACE, SECRET)]]),
			store,
			enqueue: () => {},
			log: (e) => logs.push(e),
		});
		const before = Date.now();
		await handler(fixtureRequest(CHANGED));
		const at = store.silence('initech').lastEventAt!;
		expect(at).toBeGreaterThanOrEqual(before);
		expect(at).toBeLessThanOrEqual(Date.now());
	});
});

describe('прочие маршруты', () => {
	test('GET /plane/webhook → 405; GET /healthz → ok; /nope → 404', async () => {
		const { handler, logs } = setup();
		const get = (path: string, method = 'GET') =>
			handler(new Request(`http://localhost${path}`, { method }));
		const notAllowed = await get('/plane/webhook');
		expect(notAllowed.status).toBe(405);
		expect((await get('/plane/webhook', 'PUT')).status).toBe(405);
		const health = await get('/healthz');
		expect(health.status).toBe(200);
		expect(await health.text()).toBe('ok');
		expect((await get('/nope')).status).toBe(404);
		expect((await get('/plane/webhook/')).status).toBe(404);
		expect(logs).toEqual([]);
	});
});

describe('маршруты установки приложения', () => {
	const build = (withConfig: boolean) => {
		const logs: LogEntry[] = [];
		const handler = createHandler({
			tenantsByWorkspace: new Map(),
			store: new Store(':memory:'),
			enqueue: () => {},
			config: withConfig ? configOf() : undefined,
			log: (e) => logs.push(e),
		});
		return { handler, logs };
	};

	test('GET /plane/setup и /plane/oauth/callback доходят до своих обработчиков', async () => {
		const { handler, logs } = build(true);
		const setup = await handler(new Request('http://x/plane/setup?tenant=acme'));
		expect(setup.status).toBe(302);
		expect(setup.headers.get('location')).toContain('/auth/o/authorize-app/?client_id=');
		const missing = await handler(new Request('http://x/plane/setup?tenant=nobody'));
		expect(missing.status).toBe(404);
		const callback = await handler(
			new Request('http://x/plane/oauth/callback?app_installation_id=inst-1'),
		);
		expect(callback.status).toBe(200);
		expect(await callback.text()).toBe('app_installation_id=inst-1\n');
		expect(logs).toEqual([{ event: 'plane.installed', appInstallationId: 'inst-1' }]);
	});

	test('с config прочие пути не перехватываются: POST /nope — 404, POST /plane/webhook доходит до вебхука', async () => {
		const { handler, logs } = build(true);
		expect((await handler(new Request('http://x/nope', { method: 'POST' }))).status).toBe(404);
		const res = await handler(new Request('http://x/plane/webhook', { method: 'POST' }));
		expect(res.status).toBe(200);
		expect(logs).toEqual([
			{ event: 'plane.rejected', level: 'error', reason: 'unknown_workspace' },
		]);
	});

	test('не GET → 405; без config маршруты не существуют → 404', async () => {
		const { handler } = build(true);
		for (const path of ['/plane/setup?tenant=acme', '/plane/oauth/callback?app_installation_id=i'])
			expect((await handler(new Request(`http://x${path}`, { method: 'POST' }))).status).toBe(405);
		const bare = build(false).handler;
		for (const path of ['/plane/setup?tenant=acme', '/plane/oauth/callback?app_installation_id=i'])
			expect((await bare(new Request(`http://x${path}`))).status).toBe(404);
	});
});

describe('лог', () => {
	test('ни одна строка лога не содержит текст из тела доставки', async () => {
		const { handler, logs } = setup();
		const TEXT = 'ТОП-СЕКРЕТНЫЙ-ТЕКСТ-9137';
		const make = (name: string, edit: (b: any) => void) => edited(name, edit);
		const bodies = [
			make('plane-comment-miro-link', (b) => {
				b.data.comment_html = `<p>${TEXT}</p>`;
				b.data.comment_stripped = TEXT;
			}),
			make(CHANGED, (b) => {
				b.data.name = TEXT;
				b.data.description_html = `<p>${TEXT}</p>`;
				b.data.id = '00000000-0000-4000-8000-0000000000aa';
			}),
			make('plane-issue-link-created', (b) => {
				b.data.name = TEXT;
				b.activity.new_value = `https://x.example/?token=${TEXT}`;
			}),
			make('plane-issue-deleted', (b) => {
				b.activity.old_value = TEXT;
			}),
			// rejected after verification: the text sits in a rejected delivery
			make(CHANGED, (b) => {
				b.data.name = TEXT;
				b.data.sequence_id = TEXT;
			}),
		];
		for (const body of bodies) {
			await handler(post(body, sign(body)));
			await handler(post(body, sign(body))); // duplicate path
			await handler(post(body, 'bad')); // bad signature path
		}
		await handler(post(`${TEXT}{`, null));
		expect(logs.length).toBeGreaterThan(8);
		const kinds = new Set(logs.map((l) => (l.reason as string | undefined) ?? l.event));
		expect([...kinds].sort()).toEqual(
			[
				'bad_payload',
				'bad_signature',
				'plane.accepted',
				'plane.duplicate',
				'unknown_workspace',
			].sort(),
		);
		for (const entry of logs) {
			const line = JSON.stringify(entry);
			expect(line).not.toContain(TEXT);
			expect(line).not.toContain(SECRET);
			expect(line).not.toContain('other-secret');
		}
	});
});

describe('jsonLog', () => {
	test('одна JSON-строка на запись: ts первым, поля записи следом, level сохраняется', () => {
		const lines: string[] = [];
		const log = jsonLog(
			(line) => lines.push(line),
			() => new Date('2026-10-22T12:00:00.000Z'),
		);
		log({ event: 'plane.rejected', level: 'error', reason: 'bad_signature', tenant: 'initech' });
		log({ event: 'plane.accepted', ms: 3, note: undefined });
		expect(lines).toEqual([
			'{"ts":"2026-10-22T12:00:00.000Z","event":"plane.rejected","level":"error","reason":"bad_signature","tenant":"initech"}',
			'{"ts":"2026-10-22T12:00:00.000Z","event":"plane.accepted","ms":3}',
		]);
	});
	test('по умолчанию пишет строку в stdout', () => {
		const written: string[] = [];
		const original = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			written.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			jsonLog()({ event: 'x' });
		} finally {
			process.stdout.write = original;
		}
		expect(written).toHaveLength(1);
		expect(written[0]!.endsWith('\n')).toBe(true);
		expect(JSON.parse(written[0]!)).toMatchObject({ event: 'x' });
		expect(Date.now() - Date.parse(JSON.parse(written[0]!).ts)).toBeLessThan(60_000);
	});
});

describe('маршруты Miro', () => {
	type Hooks = Partial<Pick<ServerDeps, 'miroOauth' | 'api' | 'web'>>;
	const build = (hooks: Hooks) => {
		const logs: LogEntry[] = [];
		const handler = createHandler({
			tenantsByWorkspace: new Map(),
			store: new Store(':memory:'),
			enqueue: () => {},
			log: (e) => logs.push(e),
			...hooks,
		});
		return { handler, logs };
	};
	const get = (handler: (req: Request) => Promise<Response>, path: string, method = 'GET') =>
		handler(new Request(`http://x${path}`, { method }));
	const OAUTH = ['/miro/setup?tenant=acme', '/miro/oauth/callback?code=c'];
	const WEB = ['/miro/app', '/miro/panel', '/miro/card', '/miro/assets/panel.js'];

	test('без хуков все пути Miro — 404', async () => {
		const { handler, logs } = build({});
		for (const path of [...OAUTH, ...WEB, '/miro/api/projects', '/miro/api/search?q=x'])
			expect((await get(handler, path)).status, path).toBe(404);
		expect(logs).toEqual([]);
	});

	test('miroOauth получает запрос и URL setup и callback; ответ хука возвращается как есть', async () => {
		const seen: string[] = [];
		const { handler } = build({
			miroOauth: async (req, url) => {
				seen.push(`${req.method} ${url.pathname}${url.search}`);
				return new Response('oauth', { status: 302, headers: { location: '/somewhere' } });
			},
		});
		for (const path of OAUTH) {
			const res = await get(handler, path);
			expect(res.status).toBe(302);
			expect(res.headers.get('location')).toBe('/somewhere');
		}
		expect(seen).toEqual(['GET /miro/setup?tenant=acme', 'GET /miro/oauth/callback?code=c']);
		// other /miro/ paths do not reach it
		expect((await get(handler, '/miro/oauthx')).status).toBe(404);
		expect(seen).toHaveLength(2);
	});

	test('createHandler с miroOauthHandler: setup — 302, callback — токен, другой метод — 405', async () => {
		const config = configOf();
		const store = new Store(':memory:');
		const fetched: string[] = [];
		const { handler } = build({
			miroOauth: miroOauthHandler({
				config,
				store,
				log: () => {},
				fetch: async (url) => {
					fetched.push(url);
					return Response.json({
						access_token: 'at-1',
						team_id: '3458764500000000001',
						user_id: '42',
					});
				},
			}),
		});
		const setupRes = await get(handler, '/miro/setup?tenant=acme');
		expect(setupRes.status).toBe(302);
		const state = new URL(setupRes.headers.get('location')!).searchParams.get('state')!;
		const done = await get(
			handler,
			`/miro/oauth/callback?code=c1&state=${encodeURIComponent(state)}`,
		);
		expect(done.status).toBe(302);
		expect(done.headers.get('location')).toBe(
			`https://miro.com/app-install-completed/?client_id=${config.miro.clientId}&team_id=3458764500000000001`,
		);
		expect(store.getMiroToken('3458764500000000001')).toBe('at-1');
		expect((await get(handler, '/miro/oauth/callback?code=c1', 'POST')).status).toBe(405);
		expect(fetched.length).toBe(1);
	});

	test('api получает все методы под /miro/api/, и только их', async () => {
		const seen: string[] = [];
		const { handler } = build({
			api: async (req, url) => {
				seen.push(`${req.method} ${url.pathname}`);
				return Response.json({ ok: true });
			},
		});
		expect(await (await get(handler, '/miro/api/projects')).json()).toEqual({ ok: true });
		await get(handler, '/miro/api/convert', 'POST');
		await get(handler, '/miro/api/bind', 'POST');
		expect(seen).toEqual([
			'GET /miro/api/projects',
			'POST /miro/api/convert',
			'POST /miro/api/bind',
		]);
		for (const path of ['/miro/api', '/miro/apix/projects', '/miro/app/api/x'])
			expect((await get(handler, path)).status, path).toBe(404);
		expect(seen).toHaveLength(3);
	});

	test('createHandler с createApi: JWT в заголовке → JSON, без него → 401 и ни одного вызова Plane', async () => {
		const w = world();
		const { handler } = build({ api: w.api });
		const ok = await handler(
			new Request('http://x/miro/api/projects', { headers: { authorization: `Bearer ${jwt()}` } }),
		);
		expect(ok.status).toBe(200);
		expect(ok.headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(((await ok.json()) as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual(
			['p1'],
		);
		const calls = w.plane.calls.length;
		const denied = await handler(new Request('http://x/miro/api/projects'));
		expect([denied.status, await denied.json()]).toEqual([401, { error: 'unauthorized' }]);
		expect(w.plane.calls).toHaveLength(calls);
		const post = await handler(
			new Request('http://x/miro/api/convert', { method: 'POST', body: '{}' }),
		);
		expect(post.status).toBe(401);
		expect(w.miro.calls).toEqual([]);
	});

	test('readBounded: content-length не число — тело читается потоком, а не отвергается', async () => {
		const req = (headers: Record<string, string>) =>
			new Request('http://x/', { method: 'POST', body: '{"a":1}', headers });
		expect(
			new TextDecoder().decode((await readBounded(req({ 'content-length': 'Infinity' })))!),
		).toBe('{"a":1}');
		expect(await readBounded(req({ 'content-length': '100' }), 99)).toBeNull();
		expect(await readBounded(req({}), 6)).toBeNull();
		expect(await readBounded(req({}), 7)).not.toBeNull();
	});

	test('web: страница из хука; null → 404; не GET → 405 без вызова хука', async () => {
		const seen: string[] = [];
		const { handler } = build({
			web: (url) => {
				seen.push(url.pathname);
				return url.pathname === '/miro/assets/panel.js' ? null : new Response('page');
			},
		});
		for (const path of ['/miro/app', '/miro/panel', '/miro/card']) {
			const res = await get(handler, path);
			expect([res.status, await res.text()]).toEqual([200, 'page']);
		}
		expect((await get(handler, '/miro/assets/panel.js')).status).toBe(404);
		expect((await get(handler, '/miro/assets/other.js')).status).toBe(200);
		expect(seen).toEqual([
			'/miro/app',
			'/miro/panel',
			'/miro/card',
			'/miro/assets/panel.js',
			'/miro/assets/other.js',
		]);
		seen.length = 0;
		expect((await get(handler, '/miro/app', 'POST')).status).toBe(405);
		expect(seen).toEqual([]);
		expect((await get(handler, '/miro/panels')).status).toBe(404);
		expect((await get(handler, '/miro/assets')).status).toBe(404);
	});

	test('хук бросает → 500 без текста ошибки, в логе http.failed с маршрутом', async () => {
		const boom = () => {
			throw new Error('SECRET-ERROR-TEXT');
		};
		const { handler, logs } = build({
			miroOauth: async () => boom(),
			api: async () => boom(),
			web: boom,
		});
		for (const [path, route] of [
			['/miro/setup?tenant=acme', 'miro_oauth'],
			['/miro/api/projects', 'api'],
			['/miro/app', 'web'],
		] as const) {
			logs.length = 0;
			const res = await get(handler, path);
			expect(res.status).toBe(500);
			expect(await res.text()).toBe('internal error');
			expect(logs).toEqual([{ event: 'http.failed', level: 'error', route, reason: 'internal' }]);
		}
	});

	test('вебхук и healthz не зависят от хуков Miro', async () => {
		const { handler } = build({
			api: async () => new Response('api'),
			web: () => new Response('web'),
		});
		expect(await (await get(handler, '/healthz')).text()).toBe('ok');
		expect((await get(handler, '/plane/webhook')).status).toBe(405);
	});
});
