// Pure front-end logic: no DOM access, types from the contract only.
import type { Edge, GraphJson } from '../src/contract.ts';

export type Filters = { showClosed: boolean; project: string | null; area: string | null };

/**
 * The items and edges to draw. Closed items go first when they are hidden; then the items that match
 * every active filter are kept together with their neighbours along the remaining edges. Edges are
 * kept only between the surviving items.
 */
export function visible(g: GraphJson, f: Filters): { items: GraphJson['items']; edges: Edge[] } {
	const open = f.showClosed ? g.items : g.items.filter((i) => !i.closed);
	const ids = new Set(open.map((i) => i.id));
	const edges = g.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
	if (f.project === null && f.area === null) return { items: open, edges };

	const seeds = new Set(
		open
			.filter(
				(i) =>
					(f.project === null || i.projectId === f.project) &&
					(f.area === null || i.areas.includes(f.area)),
			)
			.map((i) => i.id),
	);
	// Neighbours are taken from the seeds only, so a neighbour's neighbour stays out.
	const keep = new Set(seeds);
	for (const e of edges) {
		if (seeds.has(e.from)) keep.add(e.to);
		if (seeds.has(e.to)) keep.add(e.from);
	}
	return {
		items: open.filter((i) => keep.has(i.id)),
		edges: edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
	};
}

/** Horizontal position of a wave column; null for an item without a wave. */
export function columnX(wave: number | null, maxWave: number, width: number): number | null {
	if (wave === null) return null;
	return 80 + (wave * (width - 160)) / Math.max(1, maxWave);
}

const PALETTE = [
	'#4e79a7',
	'#f28e2b',
	'#e15759',
	'#2bb3a5',
	'#59a14f',
	'#d4a72c',
	'#b07aa1',
	'#ff9da7',
	'#9c755f',
	'#bab0ac',
];

/** Project colour by its index in the project list; the palette repeats. */
export function projectColor(index: number): string {
	return PALETTE[index % PALETTE.length] as string;
}

export type Box = { x0: number; y0: number; x1: number; y1: number };
const LABEL_HALF_WIDTH = 30;
const LABEL_HEIGHT = 14;
const COLUMN_HALF_WIDTH = 45;
const COLUMN_TOP = 4;
const FIT_PAD = 10;

/**
 * The rectangle a fit has to show: node circles with their key labels (above the circle) and,
 * when there are wave columns, their header labels (about 90 px wide, centred on the column).
 */
export function fitBox(
	nodes: { x: number; y: number; r: number }[],
	columns: number[],
	height: number,
): Box {
	const xs: number[] = [];
	const ys: number[] = [];
	for (const n of nodes) {
		xs.push(n.x - Math.max(n.r, LABEL_HALF_WIDTH), n.x + Math.max(n.r, LABEL_HALF_WIDTH));
		ys.push(n.y - n.r - 4 - LABEL_HEIGHT, n.y + n.r);
	}
	for (const x of columns) {
		xs.push(x - COLUMN_HALF_WIDTH, x + COLUMN_HALF_WIDTH);
		ys.push(COLUMN_TOP, height - 40);
	}
	return {
		x0: Math.min(...xs) - FIT_PAD,
		y0: Math.min(...ys) - FIT_PAD,
		x1: Math.max(...xs) + FIT_PAD,
		y1: Math.max(...ys) + FIT_PAD,
	};
}

export type StartGroup = { area: string | null; items: string[]; notParallel: boolean };

/**
 * «Можно сейчас» as the panel shows it: only ids that are drawn, empty groups dropped. Only a group
 * of a known area with two or more tasks is «не параллельно»; tasks without an area share no known code.
 */
export function startGroups(
	canStart: GraphJson['canStart'],
	shown: ReadonlySet<string>,
): StartGroup[] {
	return canStart
		.map((g) => ({ area: g.area, items: g.items.filter((id) => shown.has(id)) }))
		.filter((g) => g.items.length > 0)
		.map((g) => ({ ...g, notParallel: g.area !== null && g.items.length >= 2 }));
}
