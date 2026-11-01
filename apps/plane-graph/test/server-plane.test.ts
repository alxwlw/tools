// Adapted from apps/plane-miro/test/server-plane.test.ts, narrowed to intake.
import { createHmac } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { type Config, PLANE_SCOPES, type TenantConfig } from '../src/config.ts';
import type { LogEntry } from '../src/log.ts';
import type { PlaneEvent } from '../src/plane/webhook.ts';
import { createHandler, MAX_PLANE_BODY, readBounded } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { fixture } from './fixtures.ts';

const WORKSPACE = '00000000-0000-4000-8000-000000000002';
const SECRET = 'test-secret';
const tenant = (id: string, workspaceId: string, webhookSecret: string): TenantConfig => ({
	id,
	workspaceSlug: 'example-ws',
	workspaceId,
	clientId: 'client&id',
	installationId: 'inst',
	planeSecret: 'plane-secret',
	webhookSecret,
	readKey: 'read-key',
	agentKey: 'agent-key',
});
const config = (): Config => ({
	planeUrl: 'https://plane.example.com',
	publicUrl: 'https://plane-graph.example.com',
	dbPath: ':memory:',
	port: 8080,
	tenants: new Map([
		['initech', tenant('initech', WORKSPACE, SECRET)],
		['other', tenant('other', '00000000-0000-4000-8000-0000000000ff', 'other-secret')],
	]),
});

function setup(opts: { store?: Store; enqueue?: (e: PlaneEvent) => void } = {}) {
	const store = opts.store ?? new Store(':memory:');
	const events: PlaneEvent[] = [];
	const logs: LogEntry[] = [];
	let clock = 1_000;
	const handler = createHandler({
		config: config(),
		store,
		enqueue: opts.enqueue ?? ((e) => events.push(e)),
		log: (e) => logs.push(e),
		now: () => (clock += 7),
		assets: new Map(),
		acceptRun: async () => true,
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
const TOUCH = 'plane-relation-created';
const TOUCH_KEY = `issue.touched:${(fixture(TOUCH).body as any).data.id}:blocking:${(fixture(TOUCH).body as any).data.last_activity_at}`;
const only = (logs: LogEntry[], event: string) => logs.filter((l) => l.event === event);

describe('POST /plane/webhook', () => {
	test('подписанная доставка → 200, один enqueue, plane.accepted, время события выставлено', async () => {
		const { handler, store, events, logs } = setup();
		const res = await handler(fixtureRequest(TOUCH));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			kind: 'item.touched',
			tenant: 'initech',
			eventKey: TOUCH_KEY,
		});
		expect(logs).toEqual([
			{
				event: 'plane.accepted',
				tenant: 'initech',
				kind: 'item.touched',
				eventKey: TOUCH_KEY,
				ms: 7 * 3,
			},
		]);
		// the fake clock moves 7 ms per reading: start, touchEvent, claim, end
		expect(store.lastEventAt('initech')).toBe(1_000 + 7 * 2);
		expect(store.lastEventAt('other')).toBeNull();
	});

	test('удаление задачи принимается как item.deleted, снятие связи — как item.touched', async () => {
		const { handler, events } = setup();
		await handler(fixtureRequest('plane-issue-deleted'));
		await handler(fixtureRequest('plane-relation-deleted'));
		await handler(fixtureRequest('plane-relates-deleted'));
		expect(events.map((e) => e.kind)).toEqual(['item.deleted', 'item.touched', 'item.touched']);
	});

	test('повтор той же доставки → 200, enqueue не вызван, plane.duplicate', async () => {
		const { handler, events, logs } = setup();
		await handler(fixtureRequest(TOUCH));
		const res = await handler(fixtureRequest(TOUCH));
		expect(res.status).toBe(200);
		expect(events).toHaveLength(1);
		expect(only(logs, 'plane.duplicate')).toEqual([
			{ event: 'plane.duplicate', tenant: 'initech', kind: 'item.touched', eventKey: TOUCH_KEY },
		]);
	});

	test('тот же ключ у разных тенантов не дедуплицируется между ними', async () => {
		const { handler, events } = setup();
		const other = edited(TOUCH, (b) => (b.workspace_id = '00000000-0000-4000-8000-0000000000ff'));
		await handler(fixtureRequest(TOUCH));
		await handler(post(other, sign(other, 'other-secret')));
		expect(events.map((e) => e.tenant)).toEqual(['initech', 'other']);
	});

	test('неверная подпись → 200, без enqueue, level error, reason bad_signature', async () => {
		const { handler, store, events, logs } = setup();
		const fx = fixture(TOUCH);
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
		// a changed body breaks the right signature
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
		expect(store.lastEventAt('initech')).toBeNull();
	});

	test('неизвестный workspace_id, не JSON, тело больше 4 MiB → 200, plane.rejected с нужным reason', async () => {
		const { handler, events, logs } = setup();
		const unknown = edited(TOUCH, (b) => (b.workspace_id = 'ws-nobody'));
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
		const fx = fixture(TOUCH);
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
		await handler(post('x'.repeat(MAX_PLANE_BODY), null));
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
		expect((await handler(req)).status).toBe(200);
		expect(logs).toEqual([{ event: 'plane.rejected', level: 'error', reason: 'too_large' }]);
		expect(await readBounded(new Request(URL_, { method: 'POST', body: 'abcd' }), 3)).toBeNull();
		expect(await readBounded(new Request(URL_, { method: 'POST', body: 'abc' }), 3)).toEqual(
			new TextEncoder().encode('abc'),
		);
	});

	test('подписанная доставка, которую разбор не принимает → 200, bad_payload, level error', async () => {
		const { handler, events, logs, store } = setup();
		const body = edited(TOUCH, (b) => delete b.data.project);
		const res = await handler(post(body, sign(body)));
		expect(res.status).toBe(200);
		expect(events).toEqual([]);
		expect(logs).toEqual([
			{
				event: 'plane.rejected',
				level: 'error',
				reason: 'bad_payload',
				tenant: 'initech',
				detail: 'data.project is not a string',
			},
		]);
		// the signature was valid, so the webhook is alive
		expect(store.lastEventAt('initech')).not.toBeNull();
		for (const raw of ['null', '[]', '"s"', '7', `{"workspace_id":"${WORKSPACE}"}`]) {
			logs.length = 0;
			const r = await handler(post(raw, sign(raw)));
			expect(r.status).toBe(200);
			expect(logs).toMatchObject([{ event: 'plane.rejected', level: 'error' }]);
		}
	});

	test('порядок: неподписанное тело с битым содержимым — bad_signature, не bad_payload; ключ дедупа не занят', async () => {
		const { handler, store, events, logs } = setup();
		const broken = [
			edited(TOUCH, (b) => delete b.data.project),
			JSON.stringify({ workspace_id: WORKSPACE }),
		];
		for (const raw of broken) {
			logs.length = 0;
			expect((await handler(post(raw, sign(raw, 'wrong')))).status).toBe(200);
			expect(logs).toEqual([
				{ event: 'plane.rejected', level: 'error', reason: 'bad_signature', tenant: 'initech' },
			]);
			expect(store.lastEventAt('initech')).toBeNull();
		}
		// an unsigned copy of a valid delivery must not burn its dedup key
		const fx = fixture(TOUCH);
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
		const events: PlaneEvent[] = [];
		const handler = createHandler({
			config: config(),
			store: new Store(':memory:'),
			enqueue: (e) => events.push(e),
			now: Date.now,
			assets: new Map(),
			acceptRun: async () => true,
			log: () => {
				throw new Error('EPIPE');
			},
		});
		const ignored = edited(TOUCH, (b) => (b.event = 'issue_comment'));
		const requests: Array<() => Request> = [
			() => fixtureRequest(TOUCH), // accepted
			() => fixtureRequest(TOUCH), // duplicate
			() => post(ignored, sign(ignored)), // ignored
			() => post(`{"workspace_id":"${WORKSPACE}"}`, 'zz'), // bad_signature
			() => post('{"workspace_id":"nope"}', 'zz'), // unknown_workspace
		];
		for (const make of requests) {
			const res = await handler(make());
			expect(res.status).toBe(200);
			expect(await res.text()).toBe('ok');
		}
		expect(events).toHaveLength(1);
	});

	test('комментарий → 200, plane.ignored, enqueue не вызван, ключ не занят', async () => {
		const { handler, events, logs, store } = setup();
		const body = edited(TOUCH, (b) => (b.event = 'issue_comment'));
		const res = await handler(post(body, sign(body)));
		expect(res.status).toBe(200);
		expect(events).toEqual([]);
		expect(logs).toEqual([{ event: 'plane.ignored', tenant: 'initech' }]);
		expect(store.lastEventAt('initech')).not.toBeNull();
	});

	test('сбой внутри обработчика (store или enqueue бросает) → 200, reason internal, текст ошибки не в логе', async () => {
		const store = new Store(':memory:');
		store.claim = () => {
			throw new Error('SECRET-ERROR-TEXT');
		};
		const a = setup({ store });
		const res = await a.handler(fixtureRequest(TOUCH));
		expect(res.status).toBe(200);
		expect(a.logs).toEqual([{ event: 'plane.rejected', level: 'error', reason: 'internal' }]);

		const b = setup({
			enqueue: () => {
				throw new Error('SECRET-ERROR-TEXT');
			},
		});
		expect((await b.handler(fixtureRequest(TOUCH))).status).toBe(200);
		expect(b.logs).toEqual([{ event: 'plane.rejected', level: 'error', reason: 'internal' }]);
	});
});

describe('прочие маршруты', () => {
	test('GET /plane/webhook → 405; GET /healthz → ok; /nope → 404', async () => {
		const { handler, logs } = setup();
		const get = (path: string, method = 'GET') =>
			handler(new Request(`http://localhost${path}`, { method }));
		expect((await get('/plane/webhook')).status).toBe(405);
		expect((await get('/plane/webhook', 'PUT')).status).toBe(405);
		const health = await get('/healthz');
		expect(health.status).toBe(200);
		expect(await health.text()).toBe('ok');
		const nope = await get('/nope');
		expect(nope.status).toBe(404);
		expect(nope.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(nope.headers.get('x-content-type-options')).toBe('nosniff');
		expect((await get('/plane/webhook/')).status).toBe(404);
		expect(logs).toEqual([]);
	});
});

describe('маршруты установки приложения', () => {
	test('GET /plane/setup ведёт на экран согласия со всеми скоупами; чужой тенант — 404', async () => {
		const { handler } = setup();
		const res = await handler(new Request('http://x/plane/setup?tenant=initech'));
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get('location')!);
		expect(location.origin + location.pathname).toBe(
			'https://plane.example.com/auth/o/authorize-app/',
		);
		expect(location.searchParams.get('client_id')).toBe('client&id');
		expect(location.searchParams.get('redirect_uri')).toBe(
			'https://plane-graph.example.com/plane/oauth/callback',
		);
		expect(location.searchParams.get('scope')).toBe(PLANE_SCOPES.join(' '));
		expect((await handler(new Request('http://x/plane/setup?tenant=nobody'))).status).toBe(404);
		expect((await handler(new Request('http://x/plane/setup'))).status).toBe(404);
	});

	test('GET /plane/oauth/callback называет installation id и пишет plane.installed', async () => {
		const { handler, logs } = setup();
		const res = await handler(
			new Request('http://x/plane/oauth/callback?app_installation_id=inst-1'),
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('app_installation_id=inst-1\n');
		expect(logs).toEqual([{ event: 'plane.installed', appInstallationId: 'inst-1' }]);
		const missing = await handler(new Request('http://x/plane/oauth/callback'));
		expect(missing.status).toBe(400);
	});

	test('не GET → 405', async () => {
		const { handler } = setup();
		for (const path of [
			'/plane/setup?tenant=initech',
			'/plane/oauth/callback?app_installation_id=i',
		])
			expect((await handler(new Request(`http://x${path}`, { method: 'POST' }))).status).toBe(405);
	});
});

describe('лог', () => {
	test('ни одна строка лога не содержит текст, имена, почту автора и секреты из доставки', async () => {
		const { handler, logs } = setup();
		const TEXT = 'ТОП-СЕКРЕТНЫЙ-ТЕКСТ-9137';
		const EMAIL = 'secret.author@example.org';
		const bodies = [
			edited(TOUCH, (b) => {
				b.data.name = TEXT;
				b.data.description_html = `<p>${TEXT}</p>`;
				b.activity.actor.email = EMAIL;
				b.activity.actor.display_name = TEXT;
				b.activity.old_value = TEXT;
				b.activity.new_value = TEXT;
			}),
			edited('plane-relation-deleted', (b) => {
				b.activity.old_value = TEXT;
				b.activity.actor.email = EMAIL;
			}),
			edited('plane-issue-deleted', (b) => {
				b.activity.actor.email = EMAIL;
				b.activity.actor.first_name = TEXT;
			}),
			// rejected after verification: the text sits in a rejected delivery
			edited(TOUCH, (b) => {
				b.data.name = TEXT;
				b.activity.actor.email = EMAIL;
				delete b.data.project;
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
			expect(line).not.toContain(EMAIL);
			expect(line).not.toContain(SECRET);
			expect(line).not.toContain('other-secret');
		}
	});
});
