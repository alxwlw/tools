import { describe, expect, test } from 'bun:test';
import type { AgentRunIn, CopyView } from '../src/contract.ts';
import type { LogEntry } from '../src/log.ts';
import { PlaneApiError } from '../src/plane/client.ts';
import type { PlaneEvent } from '../src/plane/webhook.ts';
import { SerialQueue } from '../src/queue.ts';
import { Store } from '../src/store.ts';
import {
	acceptRun,
	checkMarks,
	createRefresher,
	nextReconcileAt,
	reconcile,
	refreshItem,
	type SyncDeps,
} from '../src/sync.ts';
import { copyOf, idOf, type CopySpec } from './copy-builder.ts';
import { FakePlane } from './fake-plane.ts';

const TENANT = 'acme';
const NOW = new Date('2026-11-01T10:00:00.000Z');

const SPEC: CopySpec = {
	tasks: [
		{ key: 'ABC-1', labels: ['код:api'], modules: ['Alpha'] },
		{ key: 'ABC-2', parent: 'ABC-1', modules: ['Alpha'] },
		{ key: 'DEF-1', closed: true },
	],
	edges: [
		['ABC-1', 'blocks', 'ABC-2'],
		['ABC-2', 'relates', 'DEF-1'],
	],
};

/** Plane in memory with the content of a copy; relations are reported from both ends, like Plane does. */
function seed(plane: FakePlane, view: CopyView): void {
	plane.projects = structuredClone(view.projects);
	plane.states = structuredClone(view.states);
	plane.labels = structuredClone(view.labels);
	plane.modules = structuredClone(view.modules);
	plane.items = new Map(view.items.map((i) => [i.id, structuredClone(i)]));
	plane.relations = new Map();
	for (const e of view.edges) {
		for (const id of [e.from, e.to])
			plane.relations.set(id, [...(plane.relations.get(id) ?? []), e]);
	}
}

function setup(spec: CopySpec = SPEC) {
	const plane = new FakePlane();
	seed(plane, copyOf(spec));
	const store = new Store(':memory:');
	const logs: LogEntry[] = [];
	const reconciles: number[] = [];
	const deps: SyncDeps = {
		tenant: TENANT,
		plane,
		store,
		log: (e) => logs.push(e),
		now: () => NOW,
		requestReconcile: () => reconciles.push(1),
	};
	const queue = new SerialQueue({ log: () => {}, delaysMs: [] });
	const refresh = createRefresher(deps, queue);
	return { plane, store, logs, deps, queue, refresh, reconciles };
}

const touched = (projectId: string | null, ...ids: string[]): PlaneEvent => ({
	kind: 'item.touched',
	tenant: TENANT,
	eventKey: `k:${ids.join(',')}`,
	projectId,
	workItemIds: ids,
});

function run(over: Partial<AgentRunIn> = {}): AgentRunIn {
	return {
		runId: 'r1',
		kind: 'batch',
		startedAt: '2026-11-01T09:00:00Z',
		finishedAt: '2026-11-01T09:05:00Z',
		relationsAdded: [],
		labelsAdded: [],
		skipped: 0,
		costUsd: null,
		...over,
	};
}

const byId = <T extends { id: string }>(rows: T[]) =>
	[...rows].sort((a, b) => a.id.localeCompare(b.id));
const edgeKey = (e: { type: string; from: string; to: string }) => `${e.type}|${e.from}|${e.to}`;

/** The copy in a comparable order. */
function normalized(view: CopyView): CopyView {
	return {
		...view,
		projects: byId(view.projects),
		states: byId(view.states),
		labels: byId(view.labels),
		modules: byId(view.modules),
		items: byId(view.items),
		edges: [...view.edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
	};
}

describe('reconcile', () => {
	test('сверка заполняет копию', async () => {
		const { deps, store, logs } = setup();
		expect(await reconcile(deps)).toBe(true);
		const expected = copyOf({ ...SPEC, syncedAt: NOW.toISOString() });
		expect(normalized(store.copy(TENANT))).toEqual(normalized(expected));
		const done = logs.find((l) => l.event === 'sync.done');
		expect(done).toMatchObject({ tenant: TENANT, projects: 2, items: 3, edges: 2 });
	});

	test('оборванная сверка оставляет прежнюю копию', async () => {
		const { deps, store, plane, logs } = setup();
		await reconcile(deps);
		const before = store.copy(TENANT);
		plane.items.get(idOf('ABC-1'))!.name = 'Renamed';
		plane.failNext('getRelations', new PlaneApiError(500, 'GET', '/relations/'));
		expect(await reconcile(deps)).toBe(false);
		expect(store.copy(TENANT)).toEqual(before);
		const failed = logs.find((l) => l.event === 'sync.failed');
		expect(failed).toMatchObject({
			level: 'error',
			tenant: TENANT,
			error: 'Plane GET /relations/ → 500',
		});
	});
});

describe('reconcile: журнал', () => {
	test('sync.done несёт длительность по часам зависимостей', async () => {
		const { deps, logs } = setup();
		const times = [0, 250].map((ms) => new Date(NOW.getTime() + ms));
		let i = 0;
		await reconcile({ ...deps, now: () => times[Math.min(i++, 1)]! });
		expect(logs.find((l) => l.event === 'sync.done')).toMatchObject({ ms: 250 });
	});
});

describe('refreshItem и очередь событий', () => {
	test('событие обновляет задачу и её рёбра', async () => {
		const { deps, store, plane, refresh, queue } = setup();
		await reconcile(deps);
		plane.items.get(idOf('ABC-1'))!.name = 'Renamed';
		plane.relations.set(idOf('ABC-1'), [
			{ from: idOf('ABC-1'), to: idOf('ABC-2'), type: 'blocks' },
			{ from: idOf('DEF-1'), to: idOf('ABC-1'), type: 'blocks' },
		]);
		refresh(touched('project:ABC', idOf('ABC-1')));
		await queue.idle();
		const copy = store.copy(TENANT);
		expect(copy.items.find((i) => i.id === idOf('ABC-1'))?.name).toBe('Renamed');
		expect(copy.edges.map(edgeKey).sort()).toEqual(
			[
				`blocks|${idOf('ABC-1')}|${idOf('ABC-2')}`,
				`blocks|${idOf('DEF-1')}|${idOf('ABC-1')}`,
				`relates|${idOf('ABC-2')}|${idOf('DEF-1')}`,
			].sort(),
		);
	});

	test('исчезнувшая задача удаляется с рёбрами', async () => {
		const { deps, store, plane } = setup();
		await reconcile(deps);
		plane.items.delete(idOf('ABC-2'));
		await refreshItem(deps, 'project:ABC', idOf('ABC-2'));
		const copy = store.copy(TENANT);
		expect(copy.items.map((i) => i.id).sort()).toEqual([idOf('ABC-1'), idOf('DEF-1')]);
		expect(copy.edges).toEqual([]);
	});

	test('удаление по событию убирает задачу и проверяет метки', async () => {
		const { deps, store, refresh, queue } = setup();
		await reconcile(deps);
		store.putRun(
			TENANT,
			run({ relationsAdded: [{ fromId: idOf('ABC-1'), toId: idOf('ABC-2') }] }),
			'x',
		);
		checkMarks(deps);
		refresh({ kind: 'item.deleted', tenant: TENANT, eventKey: 'd', workItemId: idOf('ABC-2') });
		await queue.idle();
		expect(store.copy(TENANT).items.map((i) => i.id)).not.toContain(idOf('ABC-2'));
		expect(store.rejected(TENANT).relations).toEqual([
			{ fromId: idOf('ABC-1'), toId: idOf('ABC-2') },
		]);
	});

	test('очередь склеивает повторы', async () => {
		const { deps, plane, refresh, queue } = setup();
		await reconcile(deps);
		plane.calls = [];
		for (let i = 0; i < 3; i++) refresh(touched('project:ABC', idOf('ABC-1')));
		await queue.idle();
		expect(plane.calls.filter((c) => c === 'getWorkItem')).toHaveLength(1);
	});

	test('событие после начала чтения ставит ещё одно чтение', async () => {
		const { deps, plane, refresh, queue } = setup();
		await reconcile(deps);
		plane.calls = [];
		refresh(touched('project:ABC', idOf('ABC-1')));
		// the first job has yielded and left `pending`: its read is under way
		await Promise.resolve();
		await Promise.resolve();
		refresh(touched('project:ABC', idOf('ABC-1')));
		await queue.idle();
		expect(plane.calls.filter((c) => c === 'getWorkItem')).toHaveLength(2);
	});

	test('снятие связи без проекта: задача в копии', async () => {
		const { deps, store, plane, refresh, queue } = setup();
		await reconcile(deps);
		plane.relations.set(idOf('ABC-1'), []);
		plane.relations.set(idOf('ABC-2'), [
			{ from: idOf('ABC-2'), to: idOf('DEF-1'), type: 'relates' },
		]);
		plane.calls = [];
		refresh(touched(null, idOf('ABC-1')));
		await queue.idle();
		expect(plane.calls).toEqual(['getWorkItem', 'getRelations']);
		expect(store.copy(TENANT).edges.map(edgeKey)).toEqual([
			`relates|${idOf('ABC-2')}|${idOf('DEF-1')}`,
		]);
	});

	test('снятие связи без проекта: задачи нет в копии', async () => {
		const { deps, plane, refresh, queue, logs } = setup();
		await reconcile(deps);
		plane.calls = [];
		refresh(touched(null, 'item:nowhere'));
		await queue.idle();
		expect(plane.calls).toEqual([]);
		expect(logs.filter((l) => l.event === 'plane.unknown_item')).toEqual([
			{ event: 'plane.unknown_item', tenant: TENANT, workItemId: 'item:nowhere' },
		]);
	});

	test('задача с неизвестным состоянием кладётся в копию и просит сверку', async () => {
		const { deps, store, plane, logs, reconciles } = setup();
		await reconcile(deps);
		const item = plane.items.get(idOf('ABC-1'))!;
		item.stateId = 'state:new';
		await refreshItem(deps, 'project:ABC', idOf('ABC-1'));
		expect(store.copy(TENANT).items.find((i) => i.id === idOf('ABC-1'))?.stateId).toBe('state:new');
		expect(logs.filter((l) => l.event === 'sync.stale_copy')).toEqual([
			{
				event: 'sync.stale_copy',
				level: 'warn',
				tenant: TENANT,
				workItemId: idOf('ABC-1'),
				projectId: 'project:ABC',
				stateId: 'state:new',
			},
		]);
		expect(reconciles).toHaveLength(1);
	});

	test('задача с неизвестным проектом просит сверку', async () => {
		const { deps, plane, reconciles } = setup();
		await reconcile(deps);
		plane.items.get(idOf('ABC-1'))!.projectId = 'project:new';
		await refreshItem(deps, 'project:new', idOf('ABC-1'));
		expect(reconciles).toHaveLength(1);
	});

	test('известные состояние и проект не просят сверку', async () => {
		const { deps, reconciles, logs } = setup();
		await reconcile(deps);
		await refreshItem(deps, 'project:ABC', idOf('ABC-1'));
		expect(reconciles).toHaveLength(0);
		expect(logs.filter((l) => l.event === 'sync.stale_copy')).toEqual([]);
	});

	test('сбой постановки в очередь логируется и не выбрасывается', () => {
		const { deps, logs } = setup();
		const broken = {
			push: () => {
				throw new Error('boom');
			},
		} as unknown as SerialQueue;
		const refresh = createRefresher(deps, broken);
		expect(() => refresh(touched('project:ABC', idOf('ABC-1')))).not.toThrow();
		expect(logs).toEqual([
			{ event: 'sync.enqueue_failed', level: 'error', tenant: TENANT, error: 'boom' },
		]);
	});

	test('ошибка Plane в событии не выбрасывается из обработчика', async () => {
		const { deps, plane, refresh, queue } = setup();
		await reconcile(deps);
		plane.failNext('getWorkItem', new PlaneApiError(404, 'GET', '/x'));
		expect(() => refresh(touched('project:ABC', idOf('ABC-1')))).not.toThrow();
		await queue.idle();
	});
});

describe('метки агента', () => {
	test('метка агента: не видна → видна → пропала', async () => {
		const { deps, store, plane, queue, refresh } = setup();
		await reconcile(deps);
		const a = idOf('ABC-2');
		const b = idOf('DEF-1');
		const labelId = 'label:ABC:код:x';
		plane.labels.push({ id: labelId, projectId: 'project:ABC', name: 'код:x' });
		await reconcile(deps);
		const accepted = await acceptRun(
			deps,
			run({
				relationsAdded: [{ fromId: a, toId: b }],
				labelsAdded: [{ itemId: a, label: 'код:x' }],
			}),
			refresh,
		);
		expect(accepted).toBe(true);
		await queue.idle();
		// Plane has neither the link nor the label yet
		expect(store.marks(TENANT).map((m) => [m.confirmedAt, m.rejectedAt])).toEqual([
			[null, null],
			[null, null],
		]);

		// both appear
		plane.relations.set(a, [{ from: a, to: b, type: 'blocks' }]);
		plane.relations.set(b, [{ from: a, to: b, type: 'blocks' }]);
		plane.items.get(a)!.labelIds = [labelId];
		await refreshItem(deps, 'project:ABC', a);
		expect(store.marks(TENANT).map((m) => [m.confirmedAt, m.rejectedAt])).toEqual([
			[NOW.toISOString(), null],
			[NOW.toISOString(), null],
		]);

		// both vanish
		plane.relations.set(a, []);
		plane.relations.set(b, []);
		plane.items.get(a)!.labelIds = [];
		await refreshItem(deps, 'project:ABC', a);
		expect(store.marks(TENANT).map((m) => [m.confirmedAt, m.rejectedAt])).toEqual([
			[NOW.toISOString(), NOW.toISOString()],
			[NOW.toISOString(), NOW.toISOString()],
		]);
		expect(store.rejected(TENANT)).toEqual({
			relations: [{ fromId: a, toId: b }],
			labels: [{ itemId: a, label: 'код:x' }],
		});
	});

	test('отвергнутая метка логируется без названий', async () => {
		const { deps, store, plane, logs } = setup();
		await reconcile(deps);
		const a = idOf('ABC-1');
		const b = idOf('ABC-2');
		store.putRun(TENANT, run({ relationsAdded: [{ fromId: a, toId: b }] }), 'x');
		checkMarks(deps);
		plane.relations.set(a, []);
		plane.relations.set(b, []);
		await refreshItem(deps, 'project:ABC', a);
		expect(logs.filter((l) => l.event === 'mark.rejected')).toEqual([
			{ event: 'mark.rejected', tenant: TENANT, kind: 'relation', runId: 'r1', fromId: a, toId: b },
		]);
	});

	test('повторная проверка не сбрасывает подтверждение и отказ', async () => {
		const { deps, store } = setup();
		await reconcile(deps);
		const a = idOf('ABC-1');
		const b = idOf('ABC-2');
		store.putRun(TENANT, run({ relationsAdded: [{ fromId: a, toId: b }] }), 'x');
		checkMarks(deps);
		const first = store.marks(TENANT)[0]!.confirmedAt;
		checkMarks(deps, [a]);
		expect(store.marks(TENANT)[0]).toMatchObject({ confirmedAt: first, rejectedAt: null });
	});

	test('подтверждение ставится один раз и не сдвигается', async () => {
		const { deps, store } = setup();
		await reconcile(deps);
		store.putRun(
			TENANT,
			run({ relationsAdded: [{ fromId: idOf('ABC-1'), toId: idOf('ABC-2') }] }),
			'x',
		);
		checkMarks(deps);
		const later = { ...deps, now: () => new Date('2026-11-02T10:00:00.000Z') };
		checkMarks(later);
		expect(store.marks(TENANT)[0]?.confirmedAt).toBe(NOW.toISOString());
	});

	test('сверка проверяет метки: связь исчезла из Plane', async () => {
		const { deps, store, plane } = setup();
		await reconcile(deps);
		store.putRun(
			TENANT,
			run({ relationsAdded: [{ fromId: idOf('ABC-1'), toId: idOf('ABC-2') }] }),
			'x',
		);
		await reconcile(deps);
		expect(store.marks(TENANT)[0]).toMatchObject({
			confirmedAt: NOW.toISOString(),
			rejectedAt: null,
		});
		plane.relations.set(idOf('ABC-1'), []);
		plane.relations.set(idOf('ABC-2'), []);
		await reconcile(deps);
		expect(store.marks(TENANT)[0]?.rejectedAt).toBe(NOW.toISOString());
	});

	test('задача исчезла при чтении: подтверждённая метка отвергается', async () => {
		const { deps, store, plane } = setup();
		await reconcile(deps);
		store.putRun(
			TENANT,
			run({ relationsAdded: [{ fromId: idOf('ABC-1'), toId: idOf('ABC-2') }] }),
			'x',
		);
		checkMarks(deps);
		plane.items.delete(idOf('ABC-2'));
		await refreshItem(deps, 'project:ABC', idOf('ABC-2'));
		expect(store.rejected(TENANT).relations).toEqual([
			{ fromId: idOf('ABC-1'), toId: idOf('ABC-2') },
		]);
	});

	test('метка на задачу вне копии не подтверждается', async () => {
		const { deps, store } = setup();
		await reconcile(deps);
		store.putRun(TENANT, run({ labelsAdded: [{ itemId: 'item:nowhere', label: 'код:x' }] }), 'x');
		checkMarks(deps);
		expect(store.marks(TENANT)[0]).toMatchObject({ confirmedAt: null, rejectedAt: null });
	});

	test('отказ ставится один раз', async () => {
		const { deps, store, logs } = setup();
		await reconcile(deps);
		const a = idOf('ABC-1');
		store.putRun(TENANT, run({ relationsAdded: [{ fromId: a, toId: idOf('DEF-1') }] }), 'x');
		store.setMark(
			TENANT,
			{ kind: 'relation', fromId: a, toId: idOf('DEF-1') },
			{ confirmedAt: 'c', rejectedAt: 'r' },
		);
		checkMarks(deps);
		expect(store.marks(TENANT)[0]?.rejectedAt).toBe('r');
		expect(logs.filter((l) => l.event === 'mark.rejected')).toEqual([]);
	});

	test('проход с одними метками просит чтение их задач', async () => {
		const { deps } = setup();
		const events: PlaneEvent[] = [];
		await acceptRun(deps, run({ labelsAdded: [{ itemId: 'solo', label: 'код:x' }] }), (ev) =>
			events.push(ev),
		);
		expect(events.map((e) => (e.kind === 'item.touched' ? e.workItemIds : []))).toEqual([['solo']]);
	});

	test('пустой проход не просит чтения', async () => {
		const { deps } = setup();
		const events: PlaneEvent[] = [];
		expect(await acceptRun(deps, run(), (ev) => events.push(ev))).toBe(true);
		expect(events).toEqual([]);
	});

	test('повтор прохода не перечитывает задачи', async () => {
		const { deps, plane, queue, refresh } = setup();
		await reconcile(deps);
		const r = run({ relationsAdded: [{ fromId: idOf('ABC-1'), toId: idOf('ABC-2') }] });
		expect(await acceptRun(deps, r, refresh)).toBe(true);
		await queue.idle();
		const calls = [...plane.calls];
		expect(await acceptRun(deps, r, refresh)).toBe(false);
		await queue.idle();
		expect(plane.calls).toEqual(calls);
	});

	test('новый проход просит чтение каждой задачи один раз', async () => {
		const { deps } = setup();
		const events: PlaneEvent[] = [];
		const r = run({
			runId: 'r9',
			relationsAdded: [
				{ fromId: 'a', toId: 'b' },
				{ fromId: 'b', toId: 'c' },
			],
			labelsAdded: [{ itemId: 'a', label: 'код:x' }],
		});
		await acceptRun(deps, r, (ev) => events.push(ev));
		expect(events).toEqual([
			{
				kind: 'item.touched',
				tenant: TENANT,
				eventKey: 'agent-run:r9',
				projectId: null,
				workItemIds: ['a', 'b', 'c'],
			},
		]);
	});
});

describe('nextReconcileAt', () => {
	test('успех — ближайшие 03:00 UTC, провал — через 10 минут', () => {
		const at = (s: string, ok: boolean) => nextReconcileAt(new Date(s), ok).toISOString();
		expect(at('2026-11-01T05:00:00.000Z', true)).toBe('2026-11-02T03:00:00.000Z');
		expect(at('2026-11-01T02:00:00.000Z', true)).toBe('2026-11-01T03:00:00.000Z');
		expect(at('2026-11-01T03:00:00.000Z', true)).toBe('2026-11-02T03:00:00.000Z');
		expect(at('2026-11-01T05:00:00.000Z', false)).toBe('2026-11-01T05:10:00.000Z');
	});
});
