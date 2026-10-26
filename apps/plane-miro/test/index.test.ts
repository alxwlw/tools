import { afterEach, describe, expect, jest, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cpSync, mkdtempSync, appendFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fieldsHash } from '../src/card.ts';
import type { Tenant } from '../src/config.ts';
import {
	installProcessHandlers,
	intervalEvery,
	logUnhandled,
	type Service,
	type ServiceOptions,
	startService,
} from '../src/index.ts';
import type { LogEntry } from '../src/log.ts';
import { MiroNotConnected } from '../src/miro/rest.ts';
import type { Fetch, PlaneAuth } from '../src/plane/auth.ts';
import { PlaneClient } from '../src/plane/client.ts';
import { createRuntime } from '../src/runtime.ts';
import type { Store } from '../src/store.ts';
import { env, read } from './config-fixture.ts';
import { FakeMiro } from './fake-miro.ts';
import { FakePlane } from './fake-plane.ts';
import { fixture } from './fixtures.ts';
import { jwt, sticky } from './world.ts';

const WORKSPACE = '00000000-0000-4000-8000-000000000002';
const PROJECT = '00000000-0000-4000-8000-000000000007';
const STATE = '00000000-0000-4000-8000-000000000004';
const ITEM = '00000000-0000-4000-8000-000000000003';
const BOARD = 'uXjVb1=';
const WEBHOOK_SECRET = 'acme-webhook-secret';
const TENANTS = JSON.stringify({
	tenants: [
		{
			id: 'acme',
			workspace: 'example-ws',
			workspaceId: WORKSPACE,
			plane: { clientId: 'example-client-id', appInstallationId: 'inst-1' },
			miro: { teamId: '3458764500000000001' },
			embed: true,
		},
	],
});
const ENV: Record<string, string> = { ...env(), PLANE_MIRO_DB: ':memory:' };
const MIRO_SECRET = ENV.PLANE_MIRO_MIRO_CLIENT_SECRET as string;
const nowSec = () => Math.floor(Date.now() / 1000);
/** An id token the service accepts: the real clock, the app's secret, the tenant's team. */
const token = () => jwt({ exp: nowSec() + 600 }, MIRO_SECRET);

const running: Service[] = [];
afterEach(async () => {
	for (const service of running.splice(0)) await service.stop();
});

/** The tenant's runtime on FakePlane / FakeMiro; the card of work item ITEM on `BOARD` is seeded in the store. */
function world() {
	const plane = new FakePlane();
	plane.projects = [{ id: PROJECT, identifier: 'LAB', name: 'Лаборатория', archived: false }];
	plane.states.set(PROJECT, [{ id: STATE, name: 'In Progress', group: 'started' }]);
	const miro = new FakeMiro();
	miro.addBoard(BOARD, 'Доска');
	const lines: string[] = [];
	const entries = (): LogEntry[] => lines.map((l) => JSON.parse(l) as LogEntry);
	const ticks: Array<{ tick: () => void; ms: number }> = [];
	const stores: Store[] = [];
	const options: ServiceOptions = {
		listenPort: 0,
		readFile: read(TENANTS),
		write: (line) => lines.push(line),
		every: (tick, ms) => {
			ticks.push({ tick, ms });
			return () => {};
		},
		runtimeFor: (tenant: Tenant, store: Store) => {
			stores.push(store);
			return createRuntime(tenant, { planeUrl: 'https://plane.example.com', store, plane, miro });
		},
	};
	return { plane, miro, lines, entries, ticks, stores, options };
}

async function start(w = world(), environment: Record<string, string> = ENV) {
	const service = await startService(environment, w.options);
	running.push(service);
	return { w, service, url: (path: string) => `http://127.0.0.1:${service.port}${path}` };
}

const sign = (raw: string, secret = WEBHOOK_SECRET) =>
	createHmac('sha256', secret).update(raw).digest('hex');
/** The state-change delivery of the probe, re-signed with the tenant's secret. */
function stateDelivery(mutate: (body: any) => void = () => {}): RequestInit {
	const body = structuredClone(fixture('plane-issue-state').body) as any;
	mutate(body);
	const raw = JSON.stringify(body);
	return {
		method: 'POST',
		body: raw,
		headers: { 'x-plane-event': 'issue', 'x-plane-signature': sign(raw) },
	};
}

describe('startService', () => {
	test('сервис: /healthz → ok, строка listening с id тенантов без воркспейсов и секретов', async () => {
		const { w, url, service } = await start();
		const res = await fetch(url('/healthz'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
		const listening = w.entries().find((e) => e.event === 'listening');
		expect(listening).toEqual({
			ts: expect.any(String),
			event: 'listening',
			port: service.port,
			tenants: [{ id: 'acme' }],
		});
		for (const secret of [WEBHOOK_SECRET, MIRO_SECRET, 'acme-plane-secret', WORKSPACE])
			expect(w.lines.join('\n')).not.toContain(secret);
	});

	test('сервис: подписанная доставка смены статуса → карточка на доске обновлена', async () => {
		const w = world();
		const old = {
			title: 'LAB-102 plane-miro probe A2',
			fields: [{ value: 'Backlog' }, { value: '—' }],
		};
		w.options.runtimeFor = (tenant, store) => {
			store.putCard({
				tenant: 'acme',
				boardId: BOARD,
				cardId: '900',
				workItemId: ITEM,
				projectId: PROJECT,
				fieldsHash: fieldsHash({ ...old, status: 'connected' }),
			});
			return createRuntime(tenant, {
				planeUrl: 'https://plane.example.com',
				store,
				plane: w.plane,
				miro: w.miro,
			});
		};
		w.miro.boards.get(BOARD)?.cards.set('900', {
			card: { ...old, status: 'connected' },
			place: { x: 0, y: 0, parentId: null },
		});
		const { service, url } = await start(w);
		const res = await fetch(url('/plane/webhook'), stateDelivery());
		expect(res.status).toBe(200);
		await service.idle();
		expect(w.miro.calls).toContain('updateAppCard');
		expect(w.miro.cardsOn(BOARD)[0]?.card).toMatchObject({
			title: 'LAB-102 plane-miro probe A2',
			fields: [{ value: 'In Progress', fillColor: '#fff3bf' }, { value: '—' }],
		});
		expect(w.entries().find((e) => e.event === 'plane.accepted')).toMatchObject({
			tenant: 'acme',
			kind: 'workitem.changed',
		});
	});

	test('сервис: удаление задачи → карточка disabled', async () => {
		const w = world();
		w.options.runtimeFor = (tenant, store) => {
			store.putCard({
				tenant: 'acme',
				boardId: BOARD,
				cardId: '900',
				workItemId: ITEM,
				projectId: PROJECT,
				fieldsHash: 'x',
			});
			return createRuntime(tenant, {
				planeUrl: 'https://plane.example.com',
				store,
				plane: w.plane,
				miro: w.miro,
			});
		};
		w.miro.boards.get(BOARD)?.cards.set('900', {
			card: { title: 't', fields: [], status: 'connected' },
			place: { x: 0, y: 0, parentId: null },
		});
		const { service, url } = await start(w);
		const body = structuredClone(fixture('plane-issue-deleted').body) as any;
		body.workspace_id = WORKSPACE;
		body.data.id = ITEM;
		const raw = JSON.stringify(body);
		await fetch(url('/plane/webhook'), {
			method: 'POST',
			body: raw,
			headers: { 'x-plane-event': 'issue', 'x-plane-signature': sign(raw) },
		});
		await service.idle();
		expect(w.miro.cardsOn(BOARD)[0]?.card.status).toBe('disabled');
	});

	test('сервис: ссылка на Miro в комментарии и в «Ссылках» задачи ставит карточку на доску', async () => {
		const w = world();
		const linkBoard = 'uXjVexample1=';
		w.miro.addBoard(linkBoard, 'Общая');
		const COMMENT_PROJECT = '00000000-0000-4000-8000-000000000006';
		const LINK_PROJECT = '00000000-0000-4000-8000-000000000008';
		w.plane.projects.push(
			{ id: COMMENT_PROJECT, identifier: 'CMT', name: 'Комментарии', archived: false },
			{ id: LINK_PROJECT, identifier: 'LNK', name: 'Ссылки', archived: false },
		);
		for (const [id, projectId, sequenceId] of [
			['00000000-0000-4000-8000-000000000008', COMMENT_PROJECT, 11],
			['00000000-0000-4000-8000-000000000003', LINK_PROJECT, 22],
		] as const)
			w.plane.items.set(id, {
				id,
				projectId,
				sequenceId,
				name: 'Задача',
				stateId: 's-none',
				assignees: [],
				descriptionHtml: null,
			});
		const { service, url } = await start(w);
		for (const name of ['plane-comment-miro-link', 'plane-issue-link-created']) {
			const body = structuredClone(fixture(name).body) as any;
			body.workspace_id = WORKSPACE;
			const raw = JSON.stringify(body);
			const res = await fetch(url('/plane/webhook'), {
				method: 'POST',
				body: raw,
				headers: { 'x-plane-event': body.event, 'x-plane-signature': sign(raw) },
			});
			expect(res.status).toBe(200);
		}
		await service.idle();
		expect(w.miro.cardsOn(linkBoard).map((c) => c.card.title)).toEqual([
			'CMT-11 Задача',
			'LNK-22 Задача',
		]);
	});

	test('сервис: /miro/panel отдаёт страницу, /miro/api/projects без JWT → 401', async () => {
		const { url } = await start();
		const panel = await fetch(url('/miro/panel'));
		expect(panel.status).toBe(200);
		expect(panel.headers.get('content-security-policy')).toBe('frame-ancestors https://miro.com');
		expect(await panel.text()).toContain('<');
		const asset = await fetch(url('/miro/assets/panel.js'));
		expect(asset.status).toBe(200);
		expect(asset.headers.get('content-type')).toContain('javascript');
		const anonymous = await fetch(url('/miro/api/projects'));
		expect(anonymous.status).toBe(401);
		const signed = await fetch(url('/miro/api/projects'), {
			headers: { authorization: `Bearer ${token()}` },
		});
		expect(signed.status).toBe(200);
		expect(await signed.json()).toMatchObject({
			projects: [{ id: PROJECT, identifier: 'LAB' }],
		});
	});

	test('сервис: /miro/setup и /plane/setup подключены, чужой путь → 404', async () => {
		const { url } = await start();
		const miro = await fetch(url('/miro/setup?tenant=acme'), { redirect: 'manual' });
		expect(miro.status).toBe(302);
		expect(miro.headers.get('location')).toContain('miro.com');
		const plane = await fetch(url('/plane/setup?tenant=acme'), { redirect: 'manual' });
		expect(plane.status).toBe(302);
		expect((await fetch(url('/nope'))).status).toBe(404);
	});

	test('плохой конфиг → исключение с именами переменных, порт не занят, журнал пуст', async () => {
		const w = world();
		const { PLANE_MIRO_ACME_WEBHOOK_SECRET: _a, PLANE_MIRO_PUBLIC_URL: _b, ...partial } = ENV;
		const failed = await startService(partial, w.options).catch((error: Error) => error);
		expect(failed).toBeInstanceOf(Error);
		expect((failed as Error).message).toContain('PLANE_MIRO_ACME_WEBHOOK_SECRET');
		expect((failed as Error).message).toContain('PLANE_MIRO_PUBLIC_URL');
		expect(w.lines).toEqual([]);
		expect(w.stores).toEqual([]);
	});

	test('ошибка сборки фронта → исключение, порт не открыт, журнал пуст', async () => {
		const webDir = mkdtempSync(join(tmpdir(), 'plane-miro-web-'));
		try {
			cpSync(join(import.meta.dir, '..', 'web'), webDir, { recursive: true });
			appendFileSync(join(webDir, 'panel.ts'), '\nconst = ;\n');
			const w = world();
			w.options.webDir = webDir;
			await expect(startService(ENV, w.options)).rejects.toThrow();
			expect(w.lines).toEqual([]);
			expect(w.stores).toEqual([]);
		} finally {
			rmSync(webDir, { recursive: true, force: true });
		}
	});

	test('запуск процесса с плохим конфигом → код 1 и имена переменных в stderr', async () => {
		const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'index.ts')], {
			env: { PATH: process.env.PATH ?? '' },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		expect(code).toBe(1);
		expect(stderr).toContain('PLANE_MIRO_PLANE_URL');
	});

	test('логгер, который бросает, не роняет ни запуск, ни ответ', async () => {
		const w = world();
		w.options.write = () => {
			throw new Error('EPIPE');
		};
		const { url } = await start(w);
		expect((await fetch(url('/healthz'))).status).toBe(200);
	});
});

describe('startService: сквозная конвертация дольше idleTimeout (F3)', () => {
	const STICKERS = 11;
	const itemIds = Array.from({ length: STICKERS }, (_, i) => String(201 + i));
	const planeFetch: Fetch = async (input, init) => {
		const path = new URL(input).pathname.replace(/^.*\/workspaces\/[^/]+/, '');
		const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
		const list = (rows: unknown[]) => reply({ results: rows, next_page_results: false });
		if (path === '/projects/') return list([{ id: 'p1', identifier: 'LAB', name: 'Лаборатория' }]);
		if (path === '/projects/p1/states/')
			return list([{ id: 's1', name: 'Backlog', group: 'backlog' }]);
		if (init.method === 'POST' && path === '/projects/p1/work-items/')
			return reply({ id: `w-${(JSON.parse(String(init.body)) as any).external_id}` }, 201);
		if (init.method === 'POST' && path.endsWith('/links/')) return reply({}, 201);
		if (init.method === 'GET' && path.startsWith('/projects/p1/work-items/'))
			return reply({
				id: path.split('/')[4],
				project: 'p1',
				sequence_id: 7,
				name: 'Задача',
				state: 's1',
				assignees: [],
				description_html: '<p></p>',
			});
		if (init.method === 'PATCH') return reply({});
		return reply({}, 404);
	};
	const auth: PlaneAuth = { headers: async () => ({}), invalidate() {} };
	/** Stands in for the real 50-per-minute window: every Plane request waits, so the whole call outlives the idle timeout. */
	const SLOW_MS = 100;
	const slow = { acquire: () => new Promise<void>((resolve) => setTimeout(resolve, SLOW_MS)) };

	function slowWorld() {
		const w = world();
		w.options.idleTimeoutS = 1;
		w.options.runtimeFor = (tenant, store) =>
			createRuntime(tenant, {
				planeUrl: 'https://plane.example.com',
				store,
				miro: w.miro,
				plane: new PlaneClient({
					baseUrl: 'https://plane.example.com',
					workspace: tenant.workspace,
					appInstallationId: 'inst-1',
					auth,
					fetch: planeFetch,
					limiter: slow,
				}),
			});
		const board = w.miro.boards.get(BOARD);
		for (const id of itemIds) board?.items.set(id, sticky(id, `<p>Стикер ${id}</p>`, 10, 20, null));
		return w;
	}

	test('11 стикеров, реальный PlaneClient с медленным лимитером, idleTimeout 1 с → 200 и 11 результатов', async () => {
		const { url } = await start(slowWorld());
		const started = Date.now();
		const res = await fetch(url('/miro/api/convert'), {
			method: 'POST',
			headers: { authorization: `Bearer ${token()}` },
			body: JSON.stringify({ boardId: BOARD, projectId: 'p1', author: 'Аня', itemIds }),
		});
		const elapsed = Date.now() - started;
		expect(res.status).toBe(200);
		const { results } = (await res.json()) as { results: Array<{ ok: boolean; key: string }> };
		expect(results).toHaveLength(STICKERS);
		expect(results.every((r) => r.ok)).toBe(true);
		// longer than the idle timeout plus Bun's slack of about 2 s
		expect(elapsed).toBeGreaterThan(4_000);
	}, 30_000);

	/** Writes a raw HTTP request, reads everything the server sends; `closed` says whether the server hung up within `waitMs`. */
	const probe = (port: number, request: string, waitMs: number) =>
		new Promise<{ closed: boolean; received: string }>((resolve) => {
			const socket = connect(port, '127.0.0.1');
			let received = '';
			const gaveUp = setTimeout(() => {
				socket.destroy();
				resolve({ closed: false, received });
			}, waitMs);
			socket.on('connect', () => socket.write(request));
			socket.on('data', (chunk) => (received += String(chunk)));
			socket.on('error', () => {});
			socket.on('close', () => {
				clearTimeout(gaveUp);
				resolve({ closed: true, received });
			});
		});
	const post = (auth: string, body: string, declared = body.length, path = '/miro/api/convert') =>
		`POST ${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${auth}\r\nContent-Length: ${declared}\r\n\r\n${body}`;

	test('запрос без действительного JWT с зависшим телом отсекается idleTimeout', async () => {
		const { service } = await start(slowWorld());
		const { closed } = await probe(service.port, post('bad', '', 10), 8_000);
		expect(closed).toBe(true);
	}, 15_000);

	test('запрос с действительным JWT и зависшим телом idleTimeout не отсекает', async () => {
		const { service } = await start(slowWorld());
		const { closed } = await probe(service.port, post(token(), '', 10), 6_000);
		expect(closed).toBe(false);
	}, 15_000);

	test('JWT действителен: bind с зависшим телом idleTimeout тоже не отсекает', async () => {
		const { service } = await start(slowWorld());
		const { closed } = await probe(service.port, post(token(), '', 10, '/miro/api/bind'), 6_000);
		expect(closed).toBe(false);
	}, 15_000);

	test('после ответа на convert соединение снова под idleTimeout', async () => {
		const { service } = await start(slowWorld());
		const { closed, received } = await probe(service.port, post(token(), '{}'), 8_000);
		expect(received).toContain('400 Bad Request');
		expect(closed).toBe(true);
	}, 15_000);
});

describe('startService: таймеры', () => {
	test('периоды: сторож 15 мин, чистка раз в сутки', async () => {
		const { w } = await start();
		expect(w.ticks.map((t) => t.ms)).toEqual([15 * 60_000, 24 * 60 * 60_000]);
	});

	test('тик сторожа: нет токена Miro → miro.not_connected один раз за два тика', async () => {
		const w = world();
		w.miro.failNext('tokenValid', new MiroNotConnected());
		w.miro.failNext('tokenValid', new MiroNotConnected());
		await start(w);
		for (let i = 0; i < 2; i++) {
			w.ticks[0]?.tick();
			for (let j = 0; j < 4; j++) await new Promise((resolve) => setImmediate(resolve));
		}
		expect(w.miro.calls.filter((c) => c === 'tokenValid')).toHaveLength(2);
		expect(w.entries().filter((e) => e.event === 'miro.not_connected')).toMatchObject([
			{ level: 'error', tenant: 'acme' },
		]);
	});

	test('задача очереди не выполнена → job.dropped на уровне error с меткой <kind>:<tenant>', async () => {
		const w = world();
		w.options.runtimeFor = (tenant, store) => {
			store.putCard({
				tenant: 'acme',
				boardId: BOARD,
				cardId: '900',
				workItemId: ITEM,
				projectId: PROJECT,
				fieldsHash: 'x',
			});
			const rt = createRuntime(tenant, {
				planeUrl: 'https://plane.example.com',
				store,
				plane: w.plane,
				miro: w.miro,
			});
			rt.state = () => Promise.reject(new Error('x'));
			return rt;
		};
		const { service, url } = await start(w);
		await fetch(url('/plane/webhook'), stateDelivery());
		await service.idle();
		expect(w.entries().find((e) => e.event === 'job.dropped')).toMatchObject({
			level: 'error',
			label: 'workitem.changed:acme',
		});
	});

	test('тик чистки: ключ дедупликации старше 30 суток забыт, моложе — нет', async () => {
		const DAY = 24 * 60 * 60_000;
		let clock = 100 * DAY;
		const w = world();
		w.options.now = () => clock;
		await start(w);
		const store = w.stores[0] as Store;
		expect(store.claim('old', clock)).toBe(true);
		clock += DAY + 3_600_000;
		expect(store.claim('edge', clock)).toBe(true);
		clock += 2 * DAY - 3_600_000;
		expect(store.claim('young', clock)).toBe(true);
		clock += 28 * DAY;
		w.ticks[1]?.tick();
		// aged 29 d 23 h: still inside the window
		expect(store.claim('edge', clock)).toBe(false);
		expect(store.claim('old', clock)).toBe(true);
		expect(store.claim('young', clock)).toBe(false);
	});

	test('тик чистки на закрытом хранилище → prune.failed, а не исключение', async () => {
		const w = world();
		const { service } = await start(w);
		running.pop();
		await service.stop();
		w.ticks[1]?.tick();
		expect(w.entries().find((e) => e.event === 'prune.failed')).toMatchObject({ level: 'error' });
	});
});

describe('startService: остановка', () => {
	test('stop: порт закрыт, таймеры сняты, хранилище закрыто', async () => {
		const w = world();
		let cancelled = 0;
		w.options.every = () => () => void cancelled++;
		const { service } = await start(w);
		running.pop();
		await service.stop();
		expect(cancelled).toBe(2);
		expect(() => (w.stores[0] as Store).claim('k')).toThrow();
		await new Promise<void>((resolve, reject) => {
			const socket = connect(service.port, '127.0.0.1');
			socket.on('connect', () => {
				socket.destroy();
				reject(new Error('the port still accepts connections'));
			});
			socket.on('error', () => resolve());
		});
	});

	test('задача висит: stop() с drainMs отпускает', async () => {
		const w = world();
		w.options.drainMs = 20;
		const gate = Promise.withResolvers<void>();
		w.options.runtimeFor = (tenant, store) => {
			store.putCard({
				tenant: 'acme',
				boardId: BOARD,
				cardId: '900',
				workItemId: ITEM,
				projectId: PROJECT,
				fieldsHash: 'x',
			});
			const plane = new FakePlane();
			plane.projects = w.plane.projects;
			plane.states = w.plane.states;
			const stuck = createRuntime(tenant, {
				planeUrl: 'https://plane.example.com',
				store,
				plane,
				miro: w.miro,
			});
			stuck.state = async () => {
				await gate.promise;
				return null;
			};
			return stuck;
		};
		const { service, url } = await start(w);
		running.pop();
		await fetch(url('/plane/webhook'), stateDelivery());
		await service.stop();
		gate.resolve();
		await service.idle();
	});
});

describe('intervalEvery', () => {
	test('тикает каждые ms, отмена останавливает', () => {
		jest.useFakeTimers();
		try {
			let ticks = 0;
			const cancel = intervalEvery(() => void ticks++, 5);
			jest.advanceTimersByTime(4);
			expect(ticks).toBe(0);
			jest.advanceTimersByTime(6);
			expect(ticks).toBe(2);
			cancel();
			jest.advanceTimersByTime(50);
			expect(ticks).toBe(2);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('installProcessHandlers', () => {
	test('rejection логируется, процесс жив; SIGTERM и SIGINT вызывают shutdown', () => {
		const proc = new EventEmitter();
		const lines: unknown[] = [];
		let shutdowns = 0;
		installProcessHandlers(
			proc,
			(entry) => lines.push(entry),
			() => void shutdowns++,
		);
		proc.emit('unhandledRejection', new RangeError('x'));
		expect(lines).toEqual([{ event: 'unhandled.rejection', level: 'error', error: 'RangeError' }]);
		expect(shutdowns).toBe(0);
		proc.emit('SIGTERM');
		expect(shutdowns).toBe(1);
		proc.emit('SIGINT');
		expect(shutdowns).toBe(2);
	});
});

describe('logUnhandled', () => {
	test('пишет класс ошибки, не текст; сбой журнала не пробрасывается', () => {
		const lines: unknown[] = [];
		logUnhandled((entry) => lines.push(entry))(new RangeError('секрет в тексте'));
		expect(lines).toEqual([{ event: 'unhandled.rejection', level: 'error', error: 'RangeError' }]);
		logUnhandled((entry) => lines.push(entry))('не ошибка');
		expect(lines[1]).toEqual({ event: 'unhandled.rejection', level: 'error', error: 'unknown' });
		const broken = logUnhandled(() => {
			throw new Error('EPIPE');
		});
		expect(() => broken(new Error('x'))).not.toThrow();
	});
});
