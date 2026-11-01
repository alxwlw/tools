import { describe, expect, test } from 'bun:test';

import type { Edge, GraphJson } from '../src/contract.ts';
import { columnX, fitBox, projectColor, startGroups, visible } from '../web/logic.ts';

type Item = GraphJson['items'][number];

const item = (key: string, over: Partial<Item> = {}): Item => ({
	id: `item:${key}`,
	key,
	name: `Задача ${key}`,
	projectId: 'project:ABC',
	stateGroup: 'started',
	closed: false,
	areas: [],
	url: `https://plane.example.com/ws/browse/${key}/`,
	wave: null,
	inCycle: false,
	...over,
});
const edge = (from: string, type: Edge['type'], to: string): Edge => ({
	from: `item:${from}`,
	to: `item:${to}`,
	type,
});
const graph = (items: Item[], edges: Edge[]): GraphJson => ({
	generatedAt: '2026-02-01T10:00:00.000Z',
	syncedAt: '2026-02-01T09:59:00.000Z',
	lastAgentRun: null,
	projects: [],
	items,
	edges,
	cycles: [],
	conflicts: [],
	canStart: [],
	hiddenOpen: 0,
});
const keys = (items: Item[]) => items.map((i) => i.key);
const ALL = { showClosed: true, project: null, area: null };

// ABC-1 (проект ABC) блокирует XYZ-1 (проект XYZ); XYZ-1 блокирует XYZ-2; ABC-9 закрыта и блокирует ABC-1.
const G = graph(
	[
		item('ABC-1', { areas: ['код:api'] }),
		item('ABC-9', { closed: true, stateGroup: 'completed' }),
		item('XYZ-1', { projectId: 'project:XYZ' }),
		item('XYZ-2', { projectId: 'project:XYZ', areas: ['код:web'] }),
		item('XYZ-3', { projectId: 'project:XYZ' }),
	],
	[
		edge('ABC-9', 'blocks', 'ABC-1'),
		edge('ABC-1', 'blocks', 'XYZ-1'),
		edge('XYZ-1', 'blocks', 'XYZ-2'),
		edge('XYZ-3', 'relates', 'XYZ-2'),
	],
);

describe('columnX', () => {
	test('задача без волны не получает колонки', () => {
		expect(columnX(null, 3, 1000)).toBeNull();
	});
	test('нулевая волна стоит на левом поле, последняя — на правом', () => {
		expect(columnX(0, 3, 1000)).toBe(80);
		expect(columnX(3, 3, 1000)).toBe(920);
	});
	test('промежуточная волна делит ширину поровну', () => {
		expect(columnX(1, 3, 1000)).toBe(80 + 280);
	});
	test('единственная колонка без деления на ноль', () => {
		expect(columnX(0, 0, 1000)).toBe(80);
		expect(columnX(1, 0, 1000)).toBe(920);
	});
});

describe('visible', () => {
	test('закрытые скрыты по умолчанию вместе с их рёбрами', () => {
		const r = visible(G, { ...ALL, showClosed: false });
		expect(keys(r.items)).toEqual(['ABC-1', 'XYZ-1', 'XYZ-2', 'XYZ-3']);
		expect(r.edges).toEqual([
			edge('ABC-1', 'blocks', 'XYZ-1'),
			edge('XYZ-1', 'blocks', 'XYZ-2'),
			edge('XYZ-3', 'relates', 'XYZ-2'),
		]);
	});
	test('ребро к скрытой закрытой задаче убирается, даже если открытый конец виден', () => {
		const g = graph(
			[item('ABC-1'), item('ABC-2', { closed: true, stateGroup: 'completed' })],
			[edge('ABC-1', 'blocks', 'ABC-2')],
		);
		const r = visible(g, { ...ALL, showClosed: false });
		expect(keys(r.items)).toEqual(['ABC-1']);
		expect(r.edges).toEqual([]);
	});
	test('с переключателем закрытые остаются и все рёбра на месте', () => {
		const r = visible(G, ALL);
		expect(keys(r.items)).toEqual(['ABC-1', 'ABC-9', 'XYZ-1', 'XYZ-2', 'XYZ-3']);
		expect(r.edges).toEqual(G.edges);
	});
	test('фильтр проекта оставляет соседа из другого проекта, но не соседа соседа', () => {
		const r = visible(G, { ...ALL, showClosed: false, project: 'project:ABC' });
		expect(keys(r.items)).toEqual(['ABC-1', 'XYZ-1']);
		expect(r.edges).toEqual([edge('ABC-1', 'blocks', 'XYZ-1')]);
	});
	test('с закрытыми фильтр проекта берёт и закрытые задачи проекта', () => {
		const r = visible(G, { ...ALL, project: 'project:ABC' });
		expect(keys(r.items)).toEqual(['ABC-1', 'ABC-9', 'XYZ-1']);
		expect(r.edges).toEqual([edge('ABC-9', 'blocks', 'ABC-1'), edge('ABC-1', 'blocks', 'XYZ-1')]);
	});
	test('фильтр области оставляет задачи с областью и их соседей', () => {
		const r = visible(G, { ...ALL, showClosed: false, area: 'код:web' });
		expect(keys(r.items)).toEqual(['XYZ-1', 'XYZ-2', 'XYZ-3']);
		expect(r.edges).toEqual([edge('XYZ-1', 'blocks', 'XYZ-2'), edge('XYZ-3', 'relates', 'XYZ-2')]);
	});
	test('проект и область вместе: исходные задачи должны подходить под оба', () => {
		const r = visible(G, { showClosed: false, project: 'project:XYZ', area: 'код:web' });
		expect(keys(r.items)).toEqual(['XYZ-1', 'XYZ-2', 'XYZ-3']);
		const none = visible(G, { showClosed: false, project: 'project:ABC', area: 'код:web' });
		expect(none).toEqual({ items: [], edges: [] });
	});
});

describe('projectColor', () => {
	test('палитра идёт по кругу из десяти цветов', () => {
		expect(projectColor(10)).toBe(projectColor(0));
		expect(projectColor(0)).toBe('#4e79a7');
		expect(projectColor(9)).toBe('#bab0ac');
		expect(projectColor(11)).toBe('#f28e2b');
	});
});

describe('fitBox', () => {
	test('охватывает подписи первой и последней колонок, а не только узлы', () => {
		const W = 1000;
		const box = fitBox(
			[
				{ x: 200, y: 200, r: 6 },
				{ x: 700, y: 300, r: 6 },
			],
			[80, W - 80],
			520,
		);
		// «МОЖНО СЕЙЧАС» about 90 px wide, centred on x = 80, and the last header on x = 920.
		expect(box.x0).toBeLessThanOrEqual(80 - 45);
		expect(box.x1).toBeGreaterThanOrEqual(W - 80 + 45);
		expect(box.y0).toBeLessThanOrEqual(4);
	});
	test('подпись узла над кружком входит в рамку', () => {
		const box = fitBox([{ x: 300, y: 100, r: 10 }], [], 520);
		expect(box.y0).toBeLessThanOrEqual(100 - 10 - 4 - 14);
		expect(box.y1).toBeGreaterThanOrEqual(110);
		expect(box.x0).toBeLessThanOrEqual(300 - 30);
		expect(box.x1).toBeGreaterThanOrEqual(300 + 30);
	});
});

describe('startGroups', () => {
	const shown = new Set(['a', 'b', 'c', 'd', 'e']);
	test('область с двумя задачами помечена «не параллельно»', () => {
		const r = startGroups([{ area: 'код:api', items: ['a', 'b'] }], shown);
		expect(r).toEqual([{ area: 'код:api', items: ['a', 'b'], notParallel: true }]);
	});
	test('группа без области с двумя задачами не помечена', () => {
		const r = startGroups([{ area: null, items: ['c', 'd'] }], shown);
		expect(r).toEqual([{ area: null, items: ['c', 'd'], notParallel: false }]);
	});
	test('группа из одной задачи не помечена', () => {
		const r = startGroups([{ area: 'код:web', items: ['e'] }], shown);
		expect(r).toEqual([{ area: 'код:web', items: ['e'], notParallel: false }]);
	});
	test('скрытые задачи отбрасываются, пустая группа пропадает, остаток из одной не помечен', () => {
		const r = startGroups(
			[
				{ area: 'код:api', items: ['a', 'zz'] },
				{ area: 'код:db', items: ['yy'] },
			],
			shown,
		);
		expect(r).toEqual([{ area: 'код:api', items: ['a'], notParallel: false }]);
	});
});
