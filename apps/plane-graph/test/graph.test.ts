import { describe, expect, test } from 'bun:test';
import type { Edge, GraphJson, RunSummary } from '../src/contract.ts';
import { buildGraph, buildSnapshot } from '../src/graph.ts';
import { type CopySpec, copyOf, idOf, keyOf } from './copy-builder.ts';

const now = new Date('2026-02-03T04:05:06.000Z');
const lastRun: RunSummary = {
	at: '2026-02-01T00:00:00.000Z',
	kind: 'daily',
	relationsAdded: 3,
	labelsAdded: 2,
};
const opts = {
	planeUrl: 'https://plane.example.com',
	workspaceSlug: 'example-ws',
	lastRun: null,
	now,
};

const graphOf = (spec: CopySpec) => buildGraph(copyOf(spec), opts);
const waves = (g: GraphJson) => Object.fromEntries(g.items.map((i) => [i.key, i.wave]));
const keys = (ids: string[]) => ids.map(keyOf);
const edgeKeys = (edges: Edge[]) => edges.map((e) => `${keyOf(e.from)} ${e.type} ${keyOf(e.to)}`);
const task = (key: string, extra: object = {}) => ({ key, ...extra });

describe('buildGraph', () => {
	test('цепочка', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2'), task('ABC-3')],
			edges: [
				['ABC-1', 'blocks', 'ABC-2'],
				['ABC-2', 'blocks', 'ABC-3'],
			],
		});
		expect(waves(g)).toEqual({ 'ABC-1': 0, 'ABC-2': 1, 'ABC-3': 2 });
		expect(g.canStart.map((c) => ({ area: c.area, items: keys(c.items) }))).toEqual([
			{ area: null, items: ['ABC-1'] },
		]);
		expect(g.cycles).toEqual([]);
		expect(g.hiddenOpen).toBe(0);
	});

	test('ромб', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2'), task('ABC-3'), task('ABC-4')],
			edges: [
				['ABC-1', 'blocks', 'ABC-2'],
				['ABC-1', 'blocks', 'ABC-3'],
				['ABC-2', 'blocks', 'ABC-4'],
				['ABC-3', 'blocks', 'ABC-4'],
			],
		});
		expect(waves(g)).toEqual({ 'ABC-1': 0, 'ABC-2': 1, 'ABC-3': 1, 'ABC-4': 2 });
	});

	test('самая длинная цепочка решает волну', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2'), task('ABC-3')],
			edges: [
				['ABC-1', 'blocks', 'ABC-2'],
				['ABC-2', 'blocks', 'ABC-3'],
				['ABC-1', 'blocks', 'ABC-3'],
			],
		});
		expect(waves(g)['ABC-3']).toBe(2);
	});

	test('закрытый блокер', () => {
		const g = graphOf({
			tasks: [task('ABC-1', { closed: true }), task('ABC-2')],
			edges: [['ABC-1', 'blocks', 'ABC-2']],
		});
		expect(g.items.map((i) => [i.key, i.closed, i.wave])).toEqual([
			['ABC-1', true, null],
			['ABC-2', false, 0],
		]);
		expect(edgeKeys(g.edges)).toEqual(['ABC-1 blocks ABC-2']);
	});

	test('отменённая задача тоже закрыта', () => {
		const g = graphOf({
			tasks: [task('ABC-1', { closed: 'cancelled' }), task('ABC-2')],
			edges: [['ABC-1', 'blocks', 'ABC-2']],
		});
		expect(g.items[0]).toMatchObject({ key: 'ABC-1', stateGroup: 'cancelled', closed: true });
	});

	test('закрытая задача не входит без открытой, которую она блокирует', () => {
		const g = graphOf({
			tasks: [task('ABC-1', { closed: true }), task('ABC-2', { closed: true }), task('ABC-3')],
			edges: [
				['ABC-1', 'blocks', 'ABC-2'],
				['ABC-1', 'relates', 'ABC-3'],
			],
		});
		expect(g.items.map((i) => i.key)).toEqual(['ABC-3']);
		expect(g.edges).toEqual([]);
		expect(g.hiddenOpen).toBe(0);
	});

	test('цикл', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2'), task('ABC-3')],
			edges: [
				['ABC-1', 'blocks', 'ABC-2'],
				['ABC-2', 'blocks', 'ABC-1'],
				['ABC-1', 'blocks', 'ABC-3'],
			],
		});
		expect(g.cycles.map(keys)).toEqual([['ABC-1', 'ABC-2']]);
		expect(g.items.map((i) => [i.key, i.inCycle, i.wave])).toEqual([
			['ABC-1', true, null],
			['ABC-2', true, null],
			['ABC-3', false, 1],
		]);
		expect(g.canStart).toEqual([]);
	});

	test('цикл между проектами, циклы по первому ключу', () => {
		const g = graphOf({
			tasks: [task('XYZ-1'), task('ABC-5'), task('ABC-2'), task('ABC-3')],
			edges: [
				['XYZ-1', 'blocks', 'ABC-5'],
				['ABC-5', 'blocks', 'XYZ-1'],
				['ABC-3', 'blocks', 'ABC-2'],
				['ABC-2', 'blocks', 'ABC-3'],
			],
		});
		expect(g.cycles.map(keys)).toEqual([
			['ABC-2', 'ABC-3'],
			['ABC-5', 'XYZ-1'],
		]);
	});

	test('циклы упорядочены по первому ключу, а не по порядку обхода', () => {
		const g = graphOf({
			tasks: [task('ABC-4'), task('ABC-3'), task('ABC-2'), task('ABC-1')],
			edges: [
				['ABC-1', 'blocks', 'ABC-2'],
				['ABC-2', 'blocks', 'ABC-1'],
				['ABC-3', 'blocks', 'ABC-4'],
				['ABC-4', 'blocks', 'ABC-3'],
				['ABC-2', 'blocks', 'ABC-3'],
			],
		});
		expect(g.cycles.map(keys)).toEqual([
			['ABC-1', 'ABC-2'],
			['ABC-3', 'ABC-4'],
		]);
	});

	test('петля', () => {
		const g = graphOf({ tasks: [task('ABC-1')], edges: [['ABC-1', 'blocks', 'ABC-1']] });
		expect(g.cycles.map(keys)).toEqual([['ABC-1']]);
		expect(g.items.map((i) => [i.key, i.inCycle, i.wave])).toEqual([['ABC-1', true, null]]);
	});

	test('цикл не завышает волну ниже него', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2'), task('ABC-3'), task('ABC-4')],
			edges: [
				['ABC-1', 'blocks', 'ABC-2'],
				['ABC-2', 'blocks', 'ABC-1'],
				['ABC-2', 'blocks', 'ABC-3'],
				['ABC-3', 'blocks', 'ABC-4'],
			],
		});
		expect(waves(g)).toEqual({ 'ABC-1': null, 'ABC-2': null, 'ABC-3': 1, 'ABC-4': 2 });
	});

	test('открытая задача, блокирующая закрытую, получает волну 0', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2', { closed: true })],
			edges: [['ABC-1', 'blocks', 'ABC-2']],
		});
		expect(g.items.map((i) => [i.key, i.wave])).toEqual([['ABC-1', 0]]);
		expect(g.hiddenOpen).toBe(0);
	});

	test('повторное ребро в копии даёт одно', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2', { parent: 'ABC-1' })],
			edges: [
				['ABC-1', 'parent', 'ABC-2'],
				['ABC-1', 'relates', 'ABC-2'],
				['ABC-1', 'relates', 'ABC-2'],
			],
		});
		expect(edgeKeys(g.edges)).toEqual(['ABC-1 parent ABC-2', 'ABC-1 relates ABC-2']);
	});

	test('только связана', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2')],
			edges: [['ABC-1', 'relates', 'ABC-2']],
		});
		expect(g.items.map((i) => [i.key, i.wave])).toEqual([
			['ABC-1', null],
			['ABC-2', null],
		]);
		expect(edgeKeys(g.edges)).toEqual(['ABC-1 relates ABC-2']);
		expect(g.canStart).toEqual([]);
	});

	test('родитель', () => {
		const g = graphOf({ tasks: [task('ABC-1'), task('ABC-2', { parent: 'ABC-1' })] });
		expect(edgeKeys(g.edges)).toEqual(['ABC-1 parent ABC-2']);
		expect(g.items.map((i) => i.wave)).toEqual([null, null]);
	});

	test('скрытые', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2'), task('ABC-3'), task('ABC-4')],
			edges: [
				['ABC-3', 'blocks', 'ABC-4'],
				['ABC-2', 'blocks', 'ABC-9'],
			],
		});
		expect(g.hiddenOpen).toBe(2);
		expect(g.items.map((i) => i.key)).toEqual(['ABC-3', 'ABC-4']);
	});

	test('конфликт областей', () => {
		const g = graphOf({
			tasks: [
				task('ABC-1', { labels: ['код:tools/x', 'bug'] }),
				task('ABC-2', { labels: ['код:tools/x'] }),
				task('ABC-3'),
				task('ABC-4', { labels: ['код:solo'] }),
			],
			edges: [
				['ABC-1', 'blocks', 'ABC-4'],
				['ABC-2', 'blocks', 'ABC-4'],
				['ABC-3', 'blocks', 'ABC-4'],
			],
		});
		expect(g.conflicts.map((c) => ({ ...c, items: keys(c.items) }))).toEqual([
			{ wave: 0, area: 'код:tools/x', items: ['ABC-1', 'ABC-2'] },
		]);
		expect(g.canStart.map((c) => ({ area: c.area, items: keys(c.items) }))).toEqual([
			{ area: 'код:tools/x', items: ['ABC-1', 'ABC-2'] },
			{ area: null, items: ['ABC-3'] },
		]);
		expect(g.items[0]!.areas).toEqual(['код:tools/x']);
	});

	test('области: метка без точного префикса не область, у задачи с несколькими областями они по алфавиту', () => {
		const g = graphOf({
			tasks: [task('ABC-1', { labels: ['код:b', 'код:a', 'коды:c', 'x код:d'] }), task('ABC-2')],
			edges: [['ABC-1', 'blocks', 'ABC-2']],
		});
		expect(g.items[0]!.areas).toEqual(['код:a', 'код:b']);
	});

	test('задача с несколькими областями в каждой группе, конфликты по волне и области', () => {
		const g = graphOf({
			tasks: [
				task('ABC-1', { labels: ['код:b', 'код:a'] }),
				task('ABC-2', { labels: ['код:b'] }),
				task('ABC-3', { labels: ['код:a'] }),
				task('ABC-4', { labels: ['код:z'] }),
				task('ABC-5', { labels: ['код:z'] }),
			],
			edges: [
				['ABC-1', 'blocks', 'ABC-4'],
				['ABC-2', 'blocks', 'ABC-4'],
				['ABC-3', 'blocks', 'ABC-5'],
			],
		});
		expect(g.canStart.map((c) => ({ area: c.area, items: keys(c.items) }))).toEqual([
			{ area: 'код:a', items: ['ABC-1', 'ABC-3'] },
			{ area: 'код:b', items: ['ABC-1', 'ABC-2'] },
		]);
		expect(g.conflicts.map((c) => ({ wave: c.wave, area: c.area, items: keys(c.items) }))).toEqual([
			{ wave: 0, area: 'код:a', items: ['ABC-1', 'ABC-3'] },
			{ wave: 0, area: 'код:b', items: ['ABC-1', 'ABC-2'] },
			{ wave: 1, area: 'код:z', items: ['ABC-4', 'ABC-5'] },
		]);
	});

	test('между проектами', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('XYZ-1')],
			edges: [['ABC-1', 'blocks', 'XYZ-1']],
		});
		expect(g.items.map((i) => i.key)).toEqual(['ABC-1', 'XYZ-1']);
		expect(edgeKeys(g.edges)).toEqual(['ABC-1 blocks XYZ-1']);
		expect(g.projects.map((p) => p.identifier)).toEqual(['ABC', 'XYZ']);
	});

	test('ссылка', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2')],
			edges: [['ABC-1', 'relates', 'ABC-2']],
		});
		expect(g.items[0]!.url).toBe('https://plane.example.com/example-ws/browse/ABC-1/');
		const slash = buildGraph(
			copyOf({ tasks: [task('ABC-1'), task('ABC-2')], edges: [['ABC-1', 'relates', 'ABC-2']] }),
			{
				...opts,
				planeUrl: 'https://plane.example.com/',
			},
		);
		expect(slash.items[0]!.url).toBe('https://plane.example.com/example-ws/browse/ABC-1/');
	});

	test('порядок по ключу числовой, рёбра по ключам', () => {
		const g = graphOf({
			tasks: [task('ABC-10'), task('ABC-2'), task('ABC-1')],
			edges: [
				['ABC-10', 'blocks', 'ABC-2'],
				['ABC-1', 'blocks', 'ABC-10'],
			],
		});
		expect(g.items.map((i) => i.key)).toEqual(['ABC-1', 'ABC-2', 'ABC-10']);
		expect(edgeKeys(g.edges)).toEqual(['ABC-1 blocks ABC-10', 'ABC-10 blocks ABC-2']);
	});

	test('метаданные: id, имя, время, прогон агента', () => {
		const g = buildGraph(
			copyOf({
				tasks: [task('ABC-1', { name: 'First' }), task('ABC-2')],
				edges: [['ABC-1', 'blocks', 'ABC-2']],
			}),
			{ ...opts, lastRun },
		);
		expect(g.generatedAt).toBe('2026-02-03T04:05:06.000Z');
		expect(g.syncedAt).toBe('2026-01-03T00:00:00.000Z');
		expect(g.lastAgentRun).toEqual(lastRun);
		expect(g.items[0]).toMatchObject({
			id: idOf('ABC-1'),
			name: 'First',
			projectId: 'project:ABC',
			stateGroup: 'started',
		});
	});

	test('цикл из трёх задач и хвост за ним', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2'), task('ABC-3'), task('ABC-4'), task('ABC-5')],
			edges: [
				['ABC-1', 'blocks', 'ABC-2'],
				['ABC-2', 'blocks', 'ABC-3'],
				['ABC-3', 'blocks', 'ABC-1'],
				['ABC-3', 'blocks', 'ABC-4'],
				['ABC-4', 'blocks', 'ABC-5'],
			],
		});
		expect(g.cycles.map(keys)).toEqual([['ABC-1', 'ABC-2', 'ABC-3']]);
		expect(waves(g)).toEqual({
			'ABC-1': null,
			'ABC-2': null,
			'ABC-3': null,
			'ABC-4': 1,
			'ABC-5': 2,
		});
	});

	test('ребро с удалённой задачей не вводит задачу в граф', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2'), task('ABC-3')],
			edges: [
				['ABC-9', 'blocks', 'ABC-2'],
				['ABC-3', 'relates', 'ABC-8'],
			],
		});
		expect(g.items).toEqual([]);
		expect(g.edges).toEqual([]);
		expect(g.hiddenOpen).toBe(3);
	});

	test('задача с удалённым родителем скрыта', () => {
		const g = graphOf({ tasks: [task('ABC-1', { parent: 'ABC-7' })] });
		expect(g.items).toEqual([]);
		expect(g.hiddenOpen).toBe(1);
	});

	test('задачи без области не дают конфликта', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2'), task('ABC-3')],
			edges: [
				['ABC-1', 'blocks', 'ABC-3'],
				['ABC-2', 'blocks', 'ABC-3'],
			],
		});
		expect(g.conflicts).toEqual([]);
		expect(g.canStart.map((c) => ({ area: c.area, items: keys(c.items) }))).toEqual([
			{ area: null, items: ['ABC-1', 'ABC-2'] },
		]);
	});

	test('конфликты по волне и области, canStart по имени области, null последним', () => {
		const g = graphOf({
			tasks: [
				task('ABC-1', { labels: ['код:a'] }),
				task('ABC-2', { labels: ['код:a'] }),
				task('ABC-3', { labels: ['код:b'] }),
				task('ABC-4', { labels: ['код:b'] }),
				task('ABC-5', { labels: ['код:a'] }),
				task('ABC-6', { labels: ['код:a'] }),
				task('ABC-7'),
				task('ABC-8'),
			],
			edges: [
				['ABC-3', 'blocks', 'ABC-1'],
				['ABC-4', 'blocks', 'ABC-2'],
				['ABC-5', 'blocks', 'ABC-8'],
				['ABC-6', 'blocks', 'ABC-8'],
				['ABC-7', 'blocks', 'ABC-8'],
			],
		});
		expect(g.conflicts.map((c) => ({ wave: c.wave, area: c.area, items: keys(c.items) }))).toEqual([
			{ wave: 0, area: 'код:a', items: ['ABC-5', 'ABC-6'] },
			{ wave: 0, area: 'код:b', items: ['ABC-3', 'ABC-4'] },
			{ wave: 1, area: 'код:a', items: ['ABC-1', 'ABC-2'] },
		]);
		expect(g.canStart.map((c) => ({ area: c.area, items: keys(c.items) }))).toEqual([
			{ area: 'код:a', items: ['ABC-5', 'ABC-6'] },
			{ area: 'код:b', items: ['ABC-3', 'ABC-4'] },
			{ area: null, items: ['ABC-7'] },
		]);
	});

	test('разные типы ребра между одной парой — по типу, не по порядку в копии', () => {
		const g = graphOf({
			tasks: [task('ABC-1'), task('ABC-2', { parent: 'ABC-1' })],
			edges: [['ABC-1', 'relates', 'ABC-2']],
		});
		expect(edgeKeys(g.edges)).toEqual(['ABC-1 parent ABC-2', 'ABC-1 relates ABC-2']);
	});

	test('неизвестный проект — ошибка', () => {
		const copy = copyOf({ tasks: [task('ABC-1')] });
		copy.projects = [];
		expect(() => buildGraph(copy, opts)).toThrow('unknown project');
	});

	test('неизвестное состояние — ошибка, не открытая задача', () => {
		const copy = copyOf({ tasks: [task('ABC-1')] });
		copy.states = [];
		expect(() => buildGraph(copy, opts)).toThrow('unknown state');
	});
});

describe('buildSnapshot', () => {
	test('снимок', () => {
		const copy = copyOf({
			tasks: [
				task('ABC-1', {
					name: 'One',
					description: 'Desc one',
					modules: ['M2', 'M1'],
					labels: ['код:x', 'bug'],
				}),
				task('ABC-2', { closed: true, parent: 'ABC-1' }),
				task('ABC-3'),
				task('XYZ-1'),
			],
			edges: [
				['ABC-1', 'blocks', 'ABC-3'],
				['ABC-3', 'relates', 'XYZ-1'],
				['ABC-3', 'blocks', 'ABC-9'],
			],
			moduleItems: { M1: ['ABC-9', 'ABC-3'] },
			syncedAt: null,
		});
		const rejected = {
			relations: [{ fromId: idOf('ABC-3'), toId: idOf('ABC-1') }],
			labels: [{ itemId: idOf('ABC-1'), label: 'код:y' }],
		};
		const s = buildSnapshot(copy, { workspaceSlug: 'example-ws', lastRun, rejected, now });
		expect(s.generatedAt).toBe('2026-02-03T04:05:06.000Z');
		expect(s.syncedAt).toBeNull();
		expect(s.workspaceSlug).toBe('example-ws');
		expect(s.lastAgentRun).toBe(lastRun);
		expect(s.rejected).toBe(rejected);
		expect(s.projects.map((p) => p.identifier)).toEqual(['ABC', 'XYZ']);
		expect(s.labels.map((l) => l.name)).toEqual(['bug', 'код:x']);
		expect(s.items.map((i) => [i.key, i.closed])).toEqual([
			['ABC-1', false],
			['ABC-2', true],
			['ABC-3', false],
			['XYZ-1', false],
		]);
		expect(s.items[0]).toEqual({
			id: idOf('ABC-1'),
			key: 'ABC-1',
			projectId: 'project:ABC',
			name: 'One',
			description: 'Desc one',
			stateGroup: 'started',
			closed: false,
			parentId: null,
			modules: ['M1', 'M2'],
			labels: ['bug', 'код:x'],
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-02T00:00:00.000Z',
		});
		expect(s.items[1]).toMatchObject({
			stateGroup: 'completed',
			parentId: idOf('ABC-1'),
			modules: [],
		});
		expect(s.items[2]!.modules).toEqual(['M1']);
		expect(edgeKeys(s.edges)).toEqual([
			'ABC-1 parent ABC-2',
			'ABC-1 blocks ABC-3',
			'ABC-3 relates XYZ-1',
		]);
	});

	test('метки снимка по имени, затем по id; родитель-призрак отброшен', () => {
		const copy = copyOf({
			tasks: [
				task('XYZ-1', { labels: ['a', 'same'] }),
				task('ABC-1', { labels: ['b', 'same'], parent: 'ABC-7' }),
			],
		});
		const s = buildSnapshot(copy, {
			workspaceSlug: 'example-ws',
			lastRun: null,
			rejected: { relations: [], labels: [] },
			now,
		});
		expect(s.labels.map((l) => l.id)).toEqual([
			'label:XYZ:a',
			'label:ABC:b',
			'label:ABC:same',
			'label:XYZ:same',
		]);
		expect(s.items[0]).toMatchObject({ key: 'ABC-1', parentId: null });
		expect(s.edges).toEqual([]);
	});
});
