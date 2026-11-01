// Adapted from apps/plane-miro/test/index.test.ts.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CopyView } from '../src/contract.ts';
import {
	installProcessHandlers,
	logUnhandled,
	type Service,
	type ServiceOptions,
	startService,
} from '../src/index.ts';
import type { LogEntry } from '../src/log.ts';
import { Store } from '../src/store.ts';
import { copyOf, idOf } from './copy-builder.ts';
import { FakePlane } from './fake-plane.ts';
import { fixture } from './fixtures.ts';

const WORKSPACE = '00000000-0000-4000-8000-000000000002';
const WEBHOOK_SECRET = 'acme-webhook-secret';
const READ_KEY = 'acme-read-key';
const AGENT_KEY = 'acme-agent-key';
const PLANE_SECRET = 'acme-plane-secret';
const TENANTS = JSON.stringify({
	tenants: [
		{
			id: 'acme',
			workspaceSlug: 'example-ws',
			workspaceId: WORKSPACE,
			clientId: 'example-client-id',
			installationId: 'inst-1',
		},
	],
});
const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const MIN = 60_000;

const dirs: string[] = [];
const running: Service[] = [];
afterEach(async () => {
	for (const service of running.splice(0)) await service.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Plane in memory with the content of a copy; relations are reported from both ends, like Plane does. */
function seed(plane: FakePlane, view: CopyView): void {
	plane.projects = structuredClone(view.projects);
	plane.states = structuredClone(view.states);
	plane.labels = structuredClone(view.labels);
	plane.modules = structuredClone(view.modules);
	plane.items = new Map(view.items.map((i) => [i.id, structuredClone(i)]));
	for (const e of view.edges) {
		for (const id of [e.from, e.to])
			plane.relations.set(id, [...(plane.relations.get(id) ?? []), e]);
	}
}

type Timer = { fire: () => void; ms: number; cancelled: boolean; fired: boolean };

/** One tenant on FakePlane; the clock, the reconcile timers and the periodic ticks are driven by hand. */
function world(withRelation = false) {
	const plane = new FakePlane();
	seed(
		plane,
		copyOf({
			tasks: [{ key: 'ABC-1' }, { key: 'ABC-2' }, { key: 'ABC-3' }],
			edges: withRelation ? [['ABC-1', 'blocks', 'ABC-2']] : [['ABC-1', 'relates', 'ABC-3']],
		}),
	);
	const dir = mkdtempSync(join(tmpdir(), 'plane-graph-index-'));
	dirs.push(dir);
	const dbPath = join(dir, 'graph.sqlite');
	const clock = { ms: T0 };
	const lines: string[] = [];
	const timers: Timer[] = [];
	const ticks: Array<{ tick: () => void; ms: number }> = [];
	const options: ServiceOptions = {
		listenPort: 0,
		readFile: () => TENANTS,
		write: (line) => lines.push(line),
		now: () => clock.ms,
		plane: () => plane,
		after: (fire, ms) => {
			const timer: Timer = { fire: () => {}, ms, cancelled: false, fired: false };
			timer.fire = () => {
				timer.fired = true;
				fire();
			};
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		every: (tick, ms) => {
			ticks.push({ tick, ms });
			return () => {};
		},
	};
	const env: Record<string, string> = {
		PLANE_GRAPH_PLANE_URL: 'https://plane.example.com',
		PLANE_GRAPH_PUBLIC_URL: 'https://plane-graph.example.com',
		PLANE_GRAPH_DB: dbPath,
		PLANE_GRAPH_ACME_PLANE_SECRET: PLANE_SECRET,
		PLANE_GRAPH_ACME_WEBHOOK_SECRET: WEBHOOK_SECRET,
		PLANE_GRAPH_ACME_READ_KEY: READ_KEY,
		PLANE_GRAPH_ACME_AGENT_KEY: AGENT_KEY,
	};
	const entries = (): LogEntry[] => lines.map((l) => JSON.parse(l) as LogEntry);
	/** The reconcile timer that is armed now (not cancelled, not fired). */
	const armed = (): Timer[] => timers.filter((t) => !t.cancelled && !t.fired);
	const tickOf = (ms: number) => ticks.find((t) => t.ms === ms)?.tick as () => void;
	return { plane, dbPath, clock, lines, entries, timers, armed, tickOf, options, env };
}

async function start(w = world()) {
	const service = await startService(w.env, w.options);
	running.push(service);
	await service.idle();
	const url = (path: string) => `http://127.0.0.1:${service.port}${path}`;
	const graph = async () =>
		(await (await fetch(url(`/t/acme/graph.json?k=${READ_KEY}`))).json()) as {
			items: Array<{ key: string; closed: boolean }>;
		};
	return { w, service, url, graph };
}

const sign = (raw: string) => createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
/** The state-change delivery of the probe, re-signed with the tenant's secret and aimed at `key`. */
function delivery(key: string, activityAt: string): RequestInit {
	const body = structuredClone(fixture('plane-issue-state').body) as any;
	body.data.id = idOf(key);
	body.data.project = 'project:ABC';
	body.data.last_activity_at = activityAt;
	const raw = JSON.stringify(body);
	return {
		method: 'POST',
		body: raw,
		headers: { 'x-plane-event': 'issue', 'x-plane-signature': sign(raw) },
	};
}
/** Lets pending microtasks and I/O callbacks run; no wall-clock wait. */
const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const count = (plane: FakePlane, method: string) => plane.calls.filter((c) => c === method).length;

describe('startService', () => {
	test('старт: /healthz → ok, строка listening с id тенантов, без секретов', async () => {
		const { w, url, service } = await start();
		const res = await fetch(url('/healthz'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
		expect(w.entries().find((e) => e.event === 'listening')).toEqual({
			ts: expect.any(String),
			event: 'listening',
			port: service.port,
			tenants: [{ id: 'acme' }],
		});
		for (const secret of [WEBHOOK_SECRET, PLANE_SECRET, READ_KEY, AGENT_KEY, WORKSPACE])
			expect(w.lines.join('\n')).not.toContain(secret);
	});

	test('старт сверяет копию и отдаёт граф', async () => {
		const { graph, w } = await start();
		expect((await graph()).items.map((i) => i.key).sort()).toEqual(['ABC-1', 'ABC-3']);
		expect(w.entries().find((e) => e.event === 'sync.done')).toMatchObject({
			tenant: 'acme',
			items: 3,
			edges: 1,
		});
	});

	test('подписанная доставка обновляет граф', async () => {
		const { w, url, graph, service } = await start(world(true));
		expect((await graph()).items.find((i) => i.key === 'ABC-1')?.closed).toBe(false);
		const item = w.plane.items.get(idOf('ABC-1'))!;
		item.stateId = 'state:ABC:completed';
		const res = await fetch(url('/plane/webhook'), delivery('ABC-1', '2026-11-01T10:05:00.000Z'));
		expect(res.status).toBe(200);
		await service.idle();
		expect((await graph()).items.find((i) => i.key === 'ABC-1')?.closed).toBe(true);
	});

	test('проход агента подтверждает метку', async () => {
		const { w, url, service } = await start(world(true));
		const reader = new Store(w.dbPath);
		expect(reader.marks('acme')).toEqual([]);
		const run = {
			runId: 'run-1',
			kind: 'batch',
			startedAt: '2026-11-01T09:00:00.000Z',
			finishedAt: '2026-11-01T09:30:00.000Z',
			relationsAdded: [{ fromId: idOf('ABC-1'), toId: idOf('ABC-2') }],
			labelsAdded: [],
			skipped: 0,
			costUsd: null,
		};
		const res = await fetch(url('/t/acme/agent-runs'), {
			method: 'POST',
			body: JSON.stringify(run),
			headers: { authorization: `Bearer ${AGENT_KEY}` },
		});
		expect(res.status).toBe(201);
		await service.idle();
		expect(reader.marks('acme')).toEqual([
			{
				kind: 'relation',
				fromId: idOf('ABC-1'),
				toId: idOf('ABC-2'),
				runId: 'run-1',
				addedAt: expect.any(String),
				confirmedAt: new Date(T0).toISOString(),
				rejectedAt: null,
			},
		]);
		reader.close();
	});

	test('доставка для чужого тенанта в очередь не попадает', async () => {
		const { w, url, service } = await start();
		const before = w.plane.calls.length;
		const body = structuredClone(fixture('plane-issue-state').body) as any;
		body.workspace_id = '00000000-0000-4000-8000-0000000000ff';
		const raw = JSON.stringify(body);
		await fetch(url('/plane/webhook'), {
			method: 'POST',
			body: raw,
			headers: { 'x-plane-signature': sign(raw) },
		});
		await service.idle();
		expect(w.plane.calls.length).toBe(before);
		expect(w.entries().find((e) => e.event === 'plane.rejected')).toMatchObject({
			reason: 'unknown_workspace',
		});
	});
});

describe('сверка по таймеру', () => {
	test('после удачной сверки следующая — в 03:00 UTC', async () => {
		const { w } = await start();
		const [timer, ...rest] = w.armed();
		expect(rest).toEqual([]);
		expect(timer?.ms).toBe(Date.parse('2026-11-02T03:00:00.000Z') - T0);
	});

	test('сверка упала — следующая через 10 минут', async () => {
		const w = world();
		w.plane.failNext('listProjects', new Error('boom'));
		const { graph, service } = await start(w);
		expect((await graph()).items).toEqual([]);
		expect(w.entries().find((e) => e.event === 'sync.failed')).toMatchObject({
			level: 'error',
			tenant: 'acme',
		});
		const [timer, ...rest] = w.armed();
		expect(rest).toEqual([]);
		expect(timer?.ms).toBe(10 * MIN);
		w.clock.ms += 10 * MIN;
		timer?.fire();
		await service.idle();
		expect((await graph()).items.map((i) => i.key).sort()).toEqual(['ABC-1', 'ABC-3']);
		expect(count(w.plane, 'listProjects')).toBe(2);
	});

	test('сверка идёт задачей очереди тенанта: не рядом с обновлением задачи', async () => {
		const { w, url, service } = await start();
		const order: string[] = [];
		const realGet = w.plane.getWorkItem.bind(w.plane);
		const realList = w.plane.listProjects.bind(w.plane);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		w.plane.getWorkItem = async (p, id) => {
			order.push('refresh:start');
			await gate;
			order.push('refresh:end');
			return realGet(p, id);
		};
		w.plane.listProjects = () => {
			order.push('reconcile');
			return realList();
		};
		await fetch(url('/plane/webhook'), delivery('ABC-1', '2026-11-01T10:06:00.000Z'));
		await flush();
		w.armed()[0]?.fire();
		await flush();
		expect(order).toEqual(['refresh:start']);
		release();
		await service.idle();
		expect(order).toEqual(['refresh:start', 'refresh:end', 'reconcile']);
	});

	/** An item in a state the copy does not know: its refresh asks for an early reconcile. */
	async function staleDelivery(
		w: ReturnType<typeof world>,
		url: (p: string) => string,
		at: string,
	) {
		w.plane.items.get(idOf('ABC-1'))!.stateId = 'state:ABC:unknown';
		await fetch(url('/plane/webhook'), delivery('ABC-1', at));
	}

	test('ранняя сверка: две просьбы подряд дают одну лишнюю сверку, через 10 минут после прошлой', async () => {
		const { w, url, service } = await start();
		await staleDelivery(w, url, '2026-11-01T10:01:00.000Z');
		await staleDelivery(w, url, '2026-11-01T10:02:00.000Z');
		await service.idle();
		expect(w.entries().filter((e) => e.event === 'sync.stale_copy')).toHaveLength(2);
		const [early, ...rest] = w.armed();
		expect(rest).toEqual([]);
		expect(early?.ms).toBe(10 * MIN);
		// the daily timer and one early timer: the second request did not arm another
		expect(w.timers).toHaveLength(2);
		w.clock.ms += 10 * MIN;
		early?.fire();
		await service.idle();
		expect(count(w.plane, 'listProjects')).toBe(2);
		expect(w.armed().map((t) => t.ms)).toEqual([
			Date.parse('2026-11-02T03:00:00.000Z') - w.clock.ms,
		]);
	});

	test('ранняя сверка в пределах 10 минут от прошлой ждёт отметки 10 минут', async () => {
		const { w, url, service } = await start();
		w.clock.ms += 3 * MIN;
		await staleDelivery(w, url, '2026-11-01T10:03:00.000Z');
		await service.idle();
		expect(w.armed().map((t) => t.ms)).toEqual([7 * MIN]);
	});

	test('ранняя сверка после 10 минут тишины начинается сразу', async () => {
		const { w, url, service } = await start();
		w.clock.ms += 30 * MIN;
		await staleDelivery(w, url, '2026-11-01T10:30:00.000Z');
		await service.idle();
		expect(w.armed().map((t) => t.ms)).toEqual([0]);
	});

	test('остановка снимает таймер сверки и не даёт новому взвестись', async () => {
		const { w, service } = await start();
		const [timer] = w.armed();
		await service.stop();
		running.splice(0);
		expect(timer?.cancelled).toBe(true);
		expect(w.armed()).toEqual([]);
	});

	test('остановка во время сверки: после её конца новый таймер не взводится', async () => {
		const w = world();
		w.options.drainMs = 0;
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const realList = w.plane.listProjects.bind(w.plane);
		w.plane.listProjects = async () => {
			await gate;
			return realList();
		};
		const service = await startService(w.env, w.options);
		await service.stop();
		release();
		await service.idle();
		expect(w.timers).toEqual([]);
	});
});

describe('периодические проверки', () => {
	test('сторож: тик через 15 минут пишет plane.silent после долгой тишины', async () => {
		const { w } = await start();
		w.clock.ms += 100 * 3_600_000;
		w.tickOf(15 * MIN)();
		const events = w.entries().map((e) => e.event);
		expect(events).toContain('plane.silent');
		expect(events).toContain('watchdog.stale_sync');
	});

	test('чистка: тик раз в час удаляет ключи старше 30 суток', async () => {
		const { w } = await start();
		const keys = new Store(w.dbPath);
		const old = T0 - 31 * 24 * 3_600_000;
		expect(keys.claim('plane:acme:old', old)).toBe(true);
		w.tickOf(60 * MIN)();
		expect(keys.claim('plane:acme:old', T0)).toBe(true);
		keys.close();
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
