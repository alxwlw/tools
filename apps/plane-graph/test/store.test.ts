// Adapted from apps/plane-miro/test/store.test.ts.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunIn, CopyData, Edge, ItemRow } from '../src/contract.ts';
import { Store } from '../src/store.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'plane-graph-store-'));
	dirs.push(dir);
	return join(dir, 'state.sqlite');
}

function item(id: string, over: Partial<ItemRow> = {}): ItemRow {
	return {
		id,
		projectId: 'p1',
		sequenceId: 1,
		name: `name-${id}`,
		description: `desc-${id}`,
		stateId: 's1',
		parentId: null,
		labelIds: [],
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-02T00:00:00Z',
		...over,
	};
}

const blocks = (from: string, to: string): Edge => ({ from, to, type: 'blocks' });

function copyOf(over: Partial<CopyData> = {}): CopyData {
	return {
		projects: [{ id: 'p1', identifier: 'ABC', name: 'Alpha' }],
		states: [{ id: 's1', projectId: 'p1', group: 'started' }],
		labels: [{ id: 'l1', projectId: 'p1', name: 'код:api' }],
		modules: [{ id: 'm1', projectId: 'p1', name: 'Модуль', itemIds: ['A', 'B'] }],
		items: [item('A', { labelIds: ['l1'], parentId: 'B', sequenceId: 7 }), item('B')],
		edges: [blocks('A', 'B'), { from: 'A', to: 'B', type: 'relates' }],
		...over,
	};
}

function run(over: Partial<AgentRunIn> = {}): AgentRunIn {
	return {
		runId: 'r1',
		kind: 'batch',
		startedAt: '2026-02-01T00:00:00Z',
		finishedAt: '2026-02-01T00:05:00Z',
		relationsAdded: [
			{ fromId: 'A', toId: 'B' },
			{ fromId: 'C', toId: 'D' },
		],
		labelsAdded: [{ itemId: 'A', label: 'код:web' }],
		skipped: 3,
		costUsd: 0.5,
		...over,
	};
}

describe('Store: дедуп и heartbeat', () => {
	test('claim: первый раз true, второй false', () => {
		const store = new Store(':memory:');
		expect(store.claim('plane:acme:k1', 1000)).toBe(true);
		expect(store.claim('plane:acme:k1', 2000)).toBe(false);
		expect(store.claim('plane:acme:k2', 1000)).toBe(true);
	});

	test('prune удаляет ключи старше порога, свежие остаются', () => {
		const store = new Store(':memory:');
		store.claim('old', 1000);
		store.claim('edge', 5000);
		store.claim('fresh', 9000);
		// threshold = 10000 - 5000 = 5000: strictly older than that goes
		expect(store.prune(5000, 10_000)).toBe(1);
		expect(store.claim('old', 10_000)).toBe(true);
		expect(store.claim('edge', 10_000)).toBe(false);
		expect(store.claim('fresh', 10_000)).toBe(false);
	});

	test('heartbeat: touchEvent → lastEventAt, у каждого тенанта свой', () => {
		const store = new Store(':memory:');
		expect(store.lastEventAt('acme')).toBeNull();
		store.touchEvent('acme', 111);
		store.touchEvent('beta', 5);
		expect(store.lastEventAt('acme')).toBe(111);
		store.touchEvent('acme', 333);
		expect(store.lastEventAt('acme')).toBe(333);
		expect(store.lastEventAt('beta')).toBe(5);
	});
});

describe('Store: копия', () => {
	test('копия читается как записана', () => {
		const store = new Store(':memory:');
		expect(store.copy('acme')).toEqual({
			syncedAt: null,
			projects: [],
			states: [],
			labels: [],
			modules: [],
			items: [],
			edges: [],
		});
		const data = copyOf();
		store.replaceCopy('acme', data, '2026-03-01T00:00:00Z');
		expect(store.copy('acme')).toEqual({ ...data, syncedAt: '2026-03-01T00:00:00Z' });
	});

	test('replaceProjectLabels меняет метки одного проекта и не трогает чужие', () => {
		const store = new Store(':memory:');
		store.replaceCopy(
			'acme',
			copyOf({
				labels: [
					{ id: 'l1', projectId: 'p1', name: 'код:api' },
					{ id: 'l9', projectId: 'p2', name: 'другой' },
				],
			}),
			'2026-03-01T00:00:00Z',
		);
		store.replaceProjectLabels('acme', 'p1', [
			{ id: 'l1', projectId: 'p1', name: 'код:api' },
			{ id: 'l2', projectId: 'p1', name: 'код:web' },
		]);
		store.replaceProjectLabels('other', 'p1', [{ id: 'l1', projectId: 'p1', name: 'x' }]);
		expect(store.copy('acme').labels).toEqual([
			{ id: 'l1', projectId: 'p1', name: 'код:api' },
			{ id: 'l2', projectId: 'p1', name: 'код:web' },
			{ id: 'l9', projectId: 'p2', name: 'другой' },
		]);
	});

	test('вторая сверка заменяет копию целиком', () => {
		const store = new Store(':memory:');
		store.replaceCopy('acme', copyOf(), '2026-03-01T00:00:00Z');
		const second = copyOf({
			items: [item('Z')],
			edges: [],
			labels: [],
			modules: [],
			states: [],
			projects: [],
		});
		store.replaceCopy('acme', second, '2026-03-02T00:00:00Z');
		expect(store.copy('acme')).toEqual({ ...second, syncedAt: '2026-03-02T00:00:00Z' });
	});

	test('оборванная сверка не трогает копию', () => {
		const store = new Store(':memory:');
		store.replaceCopy('acme', copyOf(), '2026-03-01T00:00:00Z');
		const before = store.copy('acme');
		expect(() =>
			store.replaceCopy('acme', copyOf({ items: [item('X'), item('X')] }), '2026-03-02T00:00:00Z'),
		).toThrow();
		expect(store.copy('acme')).toEqual(before);
	});

	test('ребро parent в копию не пишется и сверку обрывает', () => {
		const store = new Store(':memory:');
		store.replaceCopy('acme', copyOf(), '2026-03-01T00:00:00Z');
		const before = store.copy('acme');
		expect(() =>
			store.replaceCopy(
				'acme',
				copyOf({ edges: [{ from: 'A', to: 'B', type: 'parent' }] }),
				'2026-03-02T00:00:00Z',
			),
		).toThrow();
		expect(store.copy('acme')).toEqual(before);
	});

	test('putItem меняет только рёбра этой задачи', () => {
		const store = new Store(':memory:');
		store.replaceCopy(
			'acme',
			copyOf({
				items: [item('A'), item('B'), item('C'), item('D')],
				edges: [blocks('A', 'B'), blocks('C', 'D')],
			}),
			'2026-03-01T00:00:00Z',
		);
		store.putItem('acme', item('B', { name: 'new name' }), [blocks('B', 'D')]);
		const view = store.copy('acme');
		expect(view.edges).toEqual([blocks('B', 'D'), blocks('C', 'D')]);
		expect(view.items.find((i) => i.id === 'B')?.name).toBe('new name');
		expect(view.items).toHaveLength(4);
		expect(view.syncedAt).toBe('2026-03-01T00:00:00Z');
	});

	test('putItem добавляет новую задачу', () => {
		const store = new Store(':memory:');
		store.putItem('acme', item('N'), [blocks('N', 'M')]);
		const view = store.copy('acme');
		expect(view.items.map((i) => i.id)).toEqual(['N']);
		expect(view.edges).toEqual([blocks('N', 'M')]);
	});

	test('deleteItem убирает рёбра в обе стороны', () => {
		const store = new Store(':memory:');
		store.replaceCopy(
			'acme',
			copyOf({
				items: [item('A'), item('B'), item('C'), item('D')],
				edges: [blocks('A', 'B'), blocks('B', 'C'), blocks('C', 'D')],
			}),
			'2026-03-01T00:00:00Z',
		);
		store.deleteItem('acme', 'B');
		const view = store.copy('acme');
		expect(view.items.map((i) => i.id)).toEqual(['A', 'C', 'D']);
		expect(view.edges).toEqual([blocks('C', 'D')]);
	});

	test('тенанты не видят друг друга', () => {
		const store = new Store(':memory:');
		store.replaceCopy('acme', copyOf(), '2026-03-01T00:00:00Z');
		store.replaceCopy('beta', copyOf({ items: [item('Q')], edges: [] }), '2026-03-02T00:00:00Z');
		store.putItem('beta', item('R'), [blocks('R', 'Q')]);
		store.deleteItem('beta', 'A');
		expect(store.copy('acme').items.map((i) => i.id)).toEqual(['A', 'B']);
		expect(store.copy('acme').edges).toHaveLength(2);
		expect(store.copy('beta').items.map((i) => i.id)).toEqual(['Q', 'R']);
		expect(store.copy('beta').syncedAt).toBe('2026-03-02T00:00:00Z');
		store.putRun('acme', run(), '2026-02-01T01:00:00Z');
		expect(store.marks('beta')).toEqual([]);
		expect(store.lastRun('beta')).toBeNull();
		expect(store.putRun('beta', run(), '2026-02-01T02:00:00Z')).toBe(true);
	});
});

describe('Store: проходы агента и метки', () => {
	test('проход пишется один раз', () => {
		const store = new Store(':memory:');
		expect(store.putRun('acme', run(), '2026-02-01T01:00:00Z')).toBe(true);
		expect(store.putRun('acme', run(), '2026-02-01T02:00:00Z')).toBe(false);
		expect(store.marks('acme')).toEqual([
			{
				kind: 'label',
				itemId: 'A',
				label: 'код:web',
				runId: 'r1',
				addedAt: '2026-02-01T01:00:00Z',
				confirmedAt: null,
				rejectedAt: null,
			},
			{
				kind: 'relation',
				fromId: 'A',
				toId: 'B',
				runId: 'r1',
				addedAt: '2026-02-01T01:00:00Z',
				confirmedAt: null,
				rejectedAt: null,
			},
			{
				kind: 'relation',
				fromId: 'C',
				toId: 'D',
				runId: 'r1',
				addedAt: '2026-02-01T01:00:00Z',
				confirmedAt: null,
				rejectedAt: null,
			},
		]);
		expect(store.lastRun('acme')).toEqual({
			at: '2026-02-01T00:05:00Z',
			kind: 'batch',
			relationsAdded: 2,
			labelsAdded: 1,
		});
	});

	test('lastRun — проход с самым поздним finishedAt', () => {
		const store = new Store(':memory:');
		expect(store.lastRun('acme')).toBeNull();
		store.putRun(
			'acme',
			run({ runId: 'late', kind: 'daily', finishedAt: '2026-03-01T00:00:00Z' }),
			'x',
		);
		store.putRun('acme', run({ runId: 'early', kind: 'first' }), 'y');
		expect(store.lastRun('acme')?.kind).toBe('daily');
		expect(store.lastRun('acme')?.at).toBe('2026-03-01T00:00:00Z');
	});

	test('метка из второго прохода не затирает существующую', () => {
		const store = new Store(':memory:');
		store.putRun('acme', run(), '2026-02-01T01:00:00Z');
		store.setMark('acme', { kind: 'relation', fromId: 'A', toId: 'B' }, { confirmedAt: 'c1' });
		store.setMark('acme', { kind: 'label', itemId: 'A', label: 'код:web' }, { rejectedAt: 'r1' });
		expect(
			store.putRun(
				'acme',
				run({
					runId: 'r2',
					relationsAdded: [{ fromId: 'A', toId: 'B' }],
					labelsAdded: [{ itemId: 'A', label: 'код:web' }],
				}),
				'2026-02-02T01:00:00Z',
			),
		).toBe(true);
		const marks = store.marks('acme');
		expect(marks).toHaveLength(3);
		expect(marks.find((m) => m.kind === 'relation' && m.fromId === 'A')).toMatchObject({
			runId: 'r1',
			addedAt: '2026-02-01T01:00:00Z',
			confirmedAt: 'c1',
			rejectedAt: null,
		});
		expect(marks.find((m) => m.kind === 'label')).toMatchObject({
			runId: 'r1',
			confirmedAt: null,
			rejectedAt: 'r1',
		});
		// the second run still counts in its own summary
		expect(store.lastRun('acme')?.relationsAdded).toBe(1);
	});

	test('метка, прошедшая дважды в одном проходе, одна', () => {
		const store = new Store(':memory:');
		store.putRun(
			'acme',
			run({
				relationsAdded: [
					{ fromId: 'A', toId: 'B' },
					{ fromId: 'A', toId: 'B' },
				],
				labelsAdded: [],
			}),
			'now',
		);
		expect(store.marks('acme')).toHaveLength(1);
	});

	test('marks по задачам', () => {
		const store = new Store(':memory:');
		store.putRun('acme', run(), '2026-02-01T01:00:00Z');
		const ids = (itemIds: readonly string[]) =>
			store
				.marks('acme', itemIds)
				.map((m) => (m.kind === 'relation' ? `${m.fromId}>${m.toId}` : `${m.itemId}#${m.label}`));
		expect(ids(['B'])).toEqual(['A>B']);
		expect(ids(['A'])).toEqual(['A#код:web', 'A>B']);
		expect(ids(['D'])).toEqual(['C>D']);
		expect(ids(['A', 'D'])).toEqual(['A#код:web', 'A>B', 'C>D']);
		expect(ids(['Z'])).toEqual([]);
		expect(ids([])).toEqual([]);
		expect(store.marks('acme')).toHaveLength(3);
	});

	test('setMark проставляет только переданное и не трогает чужие метки', () => {
		const store = new Store(':memory:');
		store.putRun('acme', run(), '2026-02-01T01:00:00Z');
		store.setMark('acme', { kind: 'relation', fromId: 'A', toId: 'B' }, { confirmedAt: 'c1' });
		store.setMark('acme', { kind: 'relation', fromId: 'A', toId: 'B' }, { rejectedAt: 'r1' });
		store.setMark('acme', { kind: 'relation', fromId: 'B', toId: 'A' }, { rejectedAt: 'rev' });
		const marks = store.marks('acme');
		expect(marks.find((m) => m.kind === 'relation' && m.fromId === 'A')).toMatchObject({
			confirmedAt: 'c1',
			rejectedAt: 'r1',
		});
		expect(marks.filter((m) => m.rejectedAt !== null)).toHaveLength(1);
	});

	test('rejected только отвергнутые', () => {
		const store = new Store(':memory:');
		store.putRun('acme', run(), '2026-02-01T01:00:00Z');
		expect(store.rejected('acme')).toEqual({ relations: [], labels: [] });
		store.setMark('acme', { kind: 'relation', fromId: 'C', toId: 'D' }, { rejectedAt: 'r1' });
		store.setMark('acme', { kind: 'label', itemId: 'A', label: 'код:web' }, { rejectedAt: 'r2' });
		store.setMark('acme', { kind: 'relation', fromId: 'A', toId: 'B' }, { confirmedAt: 'c1' });
		expect(store.rejected('acme')).toEqual({
			relations: [{ fromId: 'C', toId: 'D' }],
			labels: [{ itemId: 'A', label: 'код:web' }],
		});
		expect(store.rejected('beta')).toEqual({ relations: [], labels: [] });
	});
});

describe('Store: файл', () => {
	test('файл базы переживает переоткрытие', () => {
		const path = tmpPath();
		const a = new Store(path);
		a.claim('k', 1000);
		a.touchEvent('acme', 42);
		a.replaceCopy('acme', copyOf(), '2026-03-01T00:00:00Z');
		a.putRun('acme', run(), 'now');
		a.close();
		expect(() => a.lastEventAt('acme')).toThrow();
		const b = new Store(path);
		expect(b.claim('k', 2000)).toBe(false);
		expect(b.lastEventAt('acme')).toBe(42);
		expect(b.copy('acme').items).toHaveLength(2);
		expect(b.marks('acme')).toHaveLength(3);
		b.close();
	});

	test('close сворачивает WAL: файла -wal на диске нет', () => {
		const path = tmpPath();
		const store = new Store(path);
		store.touchEvent('acme', 1);
		store.close();
		expect(existsSync(`${path}-wal`)).toBe(false);
	});

	test('файловая база открывается в режиме WAL', () => {
		const path = tmpPath();
		new Store(path).close();
		const probe = new Database(path, { readonly: true });
		expect(
			probe.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode,
		).toBe('wal');
		probe.close();
	});
});

describe('Store: переименование метки', () => {
	const T1 = '2026-02-02T00:00:00Z';
	const T2 = '2026-02-03T00:00:00Z';
	const labelWeb = (abc: string) => [
		{ id: 'label:ABC:код:web', projectId: 'project:ABC', name: abc },
		{ id: 'label:XYZ:код:web', projectId: 'project:XYZ', name: 'код:web' },
	];
	const twoProjects = (abcName: string, over: Partial<CopyData> = {}): CopyData => ({
		projects: [
			{ id: 'project:ABC', identifier: 'ABC', name: 'Alpha' },
			{ id: 'project:XYZ', identifier: 'XYZ', name: 'Xi' },
		],
		states: [],
		labels: labelWeb(abcName),
		modules: [],
		items: [
			item('item:ABC-1', { projectId: 'project:ABC', labelIds: ['label:ABC:код:web'] }),
			item('item:XYZ-1', { projectId: 'project:XYZ', labelIds: ['label:XYZ:код:web'] }),
		],
		edges: [],
		...over,
	});
	const labelsOf = (store: Store) =>
		store
			.marks('acme')
			.flatMap((m) =>
				m.kind === 'label'
					? [
							{
								itemId: m.itemId,
								label: m.label,
								confirmedAt: m.confirmedAt,
								rejectedAt: m.rejectedAt,
							},
						]
					: [],
			)
			.sort((a, b) => a.itemId.localeCompare(b.itemId));
	function seeded(): Store {
		const store = new Store(':memory:');
		store.replaceCopy('acme', twoProjects('код:web'), '2026-03-01T00:00:00Z');
		store.putRun(
			'acme',
			run({
				relationsAdded: [],
				labelsAdded: [
					{ itemId: 'item:ABC-1', label: 'код:web' },
					{ itemId: 'item:XYZ-1', label: 'код:web' },
				],
			}),
			'2026-02-01T01:00:00Z',
		);
		for (const itemId of ['item:ABC-1', 'item:XYZ-1']) {
			store.setMark('acme', { kind: 'label', itemId, label: 'код:web' }, { confirmedAt: T1 });
		}
		return store;
	}
	const moved = [
		{ itemId: 'item:ABC-1', label: 'код:app', confirmedAt: T1, rejectedAt: null },
		{ itemId: 'item:XYZ-1', label: 'код:web', confirmedAt: T1, rejectedAt: null },
	];
	const renamed = [
		{
			projectId: 'project:ABC',
			labelId: 'label:ABC:код:web',
			from: 'код:web',
			to: 'код:app',
			marks: 1,
		},
	];

	test('переименованная метка уносит пометки своего проекта', () => {
		const store = seeded();
		const renames = store.replaceCopy('acme', twoProjects('код:app'), '2026-03-02T00:00:00Z');
		expect(renames).toEqual(renamed);
		expect(labelsOf(store)).toEqual(moved);
	});

	test('replaceProjectLabels переносит пометки так же', () => {
		const store = seeded();
		const renames = store.replaceProjectLabels('acme', 'project:ABC', [
			{ id: 'label:ABC:код:web', projectId: 'project:ABC', name: 'код:app' },
		]);
		expect(renames).toEqual(renamed);
		expect(labelsOf(store)).toEqual(moved);
	});

	test('пометка с новым именем уже есть — после переноса она одна', () => {
		const store = seeded();
		store.putRun(
			'acme',
			run({
				runId: 'r2',
				relationsAdded: [],
				labelsAdded: [{ itemId: 'item:ABC-1', label: 'код:app' }],
			}),
			'2026-02-02T01:00:00Z',
		);
		store.setMark(
			'acme',
			{ kind: 'label', itemId: 'item:ABC-1', label: 'код:app' },
			{ confirmedAt: T2 },
		);
		const renames = store.replaceCopy('acme', twoProjects('код:app'), '2026-03-02T00:00:00Z');
		expect(renames[0]?.marks).toBe(1);
		expect(labelsOf(store).filter((m) => m.itemId === 'item:ABC-1')).toEqual([
			{ itemId: 'item:ABC-1', label: 'код:app', confirmedAt: T2, rejectedAt: null },
		]);
	});

	test('новая, удалённая и прежняя метка — не переименование', () => {
		const store = seeded();
		const renames = store.replaceCopy(
			'acme',
			twoProjects('код:web', {
				labels: [
					{ id: 'label:ABC:код:db', projectId: 'project:ABC', name: 'код:db' },
					{ id: 'label:XYZ:код:web', projectId: 'project:XYZ', name: 'код:web' },
				],
			}),
			'2026-03-02T00:00:00Z',
		);
		expect(renames).toEqual([]);
		expect(store.marks('acme').map((m) => m.kind === 'label' && m.label)).toEqual([
			'код:web',
			'код:web',
		]);
	});

	test('метка с тем же id в другом проекте — не переименование', () => {
		const store = seeded();
		const renames = store.replaceCopy(
			'acme',
			twoProjects('код:web', {
				labels: [
					{ id: 'label:ABC:код:web', projectId: 'project:XYZ', name: 'код:app' },
					{ id: 'label:XYZ:код:web', projectId: 'project:XYZ', name: 'код:web' },
				],
			}),
			'2026-03-02T00:00:00Z',
		);
		expect(renames).toEqual([]);
		expect(labelsOf(store).map((m) => m.label)).toEqual(['код:web', 'код:web']);
	});

	describe('цепочка и обмен имён в одном проекте', () => {
		const pair = (a: string, b: string): CopyData =>
			twoProjects('код:web', {
				labels: [
					{ id: 'label:ABC:a', projectId: 'project:ABC', name: a },
					{ id: 'label:ABC:b', projectId: 'project:ABC', name: b },
				],
				items: [
					item('i1', { projectId: 'project:ABC', labelIds: ['label:ABC:a'] }),
					item('i2', { projectId: 'project:ABC', labelIds: ['label:ABC:b'] }),
				],
			});
		function pairSeeded(a: string, b: string): Store {
			const store = new Store(':memory:');
			store.replaceCopy('acme', pair(a, b), '2026-03-01T00:00:00Z');
			store.putRun(
				'acme',
				run({
					relationsAdded: [],
					labelsAdded: [
						{ itemId: 'i1', label: a },
						{ itemId: 'i2', label: b },
					],
				}),
				'2026-02-01T01:00:00Z',
			);
			return store;
		}

		test('одно имя уходит, а другое его занимает: пометки не склеиваются', () => {
			const store = pairSeeded('x', 'y');
			const renames = store.replaceCopy('acme', pair('y', 'z'), '2026-03-02T00:00:00Z');
			expect(renames.map((r) => [r.from, r.to, r.marks])).toEqual([
				['x', 'y', 1],
				['y', 'z', 1],
			]);
			expect(labelsOf(store).map((m) => [m.itemId, m.label])).toEqual([
				['i1', 'y'],
				['i2', 'z'],
			]);
		});

		test('обмен именами: каждая пометка идёт за своей меткой', () => {
			const store = pairSeeded('x', 'y');
			const renames = store.replaceCopy('acme', pair('y', 'x'), '2026-03-02T00:00:00Z');
			expect(renames.map((r) => [r.from, r.to, r.marks])).toEqual([
				['x', 'y', 1],
				['y', 'x', 1],
			]);
			expect(labelsOf(store).map((m) => [m.itemId, m.label])).toEqual([
				['i1', 'y'],
				['i2', 'x'],
			]);
		});

		test('на одной задаче обе пометки цепочки: каждая доезжает до своего имени', () => {
			const store = pairSeeded('x', 'y');
			store.putRun(
				'acme',
				run({
					runId: 'r2',
					relationsAdded: [],
					labelsAdded: [{ itemId: 'i1', label: 'y' }],
				}),
				'2026-02-02T01:00:00Z',
			);
			const renames = store.replaceCopy('acme', pair('y', 'z'), '2026-03-02T00:00:00Z');
			expect(renames.map((r) => r.marks)).toEqual([1, 2]);
			expect(labelsOf(store).map((m) => [m.itemId, m.label])).toEqual([
				['i1', 'y'],
				['i1', 'z'],
				['i2', 'z'],
			]);
		});
	});
});
