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
