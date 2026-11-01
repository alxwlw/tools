import { describe, expect, test } from 'bun:test';

import type { Edge, GraphJson } from '../src/contract.ts';
import { columnX, projectColor, visible } from '../web/logic.ts';

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
