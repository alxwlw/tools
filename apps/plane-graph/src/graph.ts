// Pure builders of the task-order graph and the agent snapshot from the local copy.
import type {
	CopyView,
	Edge,
	GraphJson,
	ItemRow,
	RunSummary,
	SnapshotJson,
	StateGroup,
} from './contract.ts';

const AREA_PREFIX = 'код:';

type Node = {
	row: ItemRow;
	key: string;
	group: StateGroup;
	closed: boolean;
	labels: string[];
};

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Resolves the copy into nodes by item id; skips items whose state or project is not in the copy yet
 * (their group is unknown; the next sync heals the copy), so they are in no output. */
function indexItems(copy: CopyView): Map<string, Node> {
	const groups = new Map(copy.states.map((s) => [s.id, s.group]));
	const identifiers = new Map(copy.projects.map((p) => [p.id, p.identifier]));
	const labelNames = new Map(copy.labels.map((l) => [l.id, l.name]));
	const nodes = new Map<string, Node>();
	for (const row of copy.items) {
		const group = groups.get(row.stateId);
		if (group === undefined) continue;
		const identifier = identifiers.get(row.projectId);
		if (identifier === undefined) continue;
		const labels: string[] = [];
		for (const id of row.labelIds) {
			const name = labelNames.get(id);
			if (name !== undefined) labels.push(name);
		}
		nodes.set(row.id, {
			row,
			key: `${identifier}-${row.sequenceId}`,
			group,
			closed: group === 'completed' || group === 'cancelled',
			labels: labels.toSorted(compareText),
		});
	}
	return nodes;
}

/** Items ordered by project identifier, then sequence number (so ABC-2 precedes ABC-10). */
function byKey(a: Node, b: Node): number {
	const ai = a.key.slice(0, a.key.lastIndexOf('-'));
	const bi = b.key.slice(0, b.key.lastIndexOf('-'));
	return compareText(ai, bi) || a.row.sequenceId - b.row.sequenceId;
}

function compareEdges(nodes: Map<string, Node>, a: Edge, b: Edge): number {
	const key = (id: string) => nodes.get(id)!;
	return (
		byKey(key(a.from), key(b.from)) || byKey(key(a.to), key(b.to)) || compareText(a.type, b.type)
	);
}

/** Copy edges plus parent edges, only where both ends are in `ids`; sorted, without duplicates. */
function collectEdges(copy: CopyView, nodes: Map<string, Node>, ids: ReadonlySet<string>): Edge[] {
	const seen = new Set<string>();
	const edges: Edge[] = [];
	const add = (edge: Edge) => {
		if (!ids.has(edge.from) || !ids.has(edge.to)) return;
		const id = `${edge.type}\u0000${edge.from}\u0000${edge.to}`;
		if (seen.has(id)) return;
		seen.add(id);
		edges.push({ from: edge.from, to: edge.to, type: edge.type });
	};
	for (const edge of copy.edges) add(edge);
	for (const node of nodes.values()) {
		if (node.row.parentId !== null)
			add({ from: node.row.parentId, to: node.row.id, type: 'parent' });
	}
	return edges.toSorted((a, b) => compareEdges(nodes, a, b));
}

/** Tarjan's strongly connected components over `adj`, iterative; returns the component index per vertex. */
function components(
	vertices: readonly string[],
	adj: ReadonlyMap<string, string[]>,
): Map<string, number> {
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const comp = new Map<string, number>();
	let counter = 0;
	let compCount = 0;
	for (const root of vertices) {
		if (index.has(root)) continue;
		const work: { v: string; next: number }[] = [{ v: root, next: 0 }];
		index.set(root, counter);
		low.set(root, counter);
		counter++;
		stack.push(root);
		onStack.add(root);
		while (work.length > 0) {
			const frame = work[work.length - 1]!;
			const out = adj.get(frame.v) ?? [];
			if (frame.next < out.length) {
				const w = out[frame.next++]!;
				if (!index.has(w)) {
					index.set(w, counter);
					low.set(w, counter);
					counter++;
					stack.push(w);
					onStack.add(w);
					work.push({ v: w, next: 0 });
				} else if (onStack.has(w)) {
					low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
				}
				continue;
			}
			work.pop();
			const parent = work[work.length - 1];
			if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!));
			if (low.get(frame.v) === index.get(frame.v)) {
				for (;;) {
					const w = stack.pop()!;
					onStack.delete(w);
					comp.set(w, compCount);
					if (w === frame.v) break;
				}
				compCount++;
			}
		}
	}
	return comp;
}

type Waves = { wave: Map<string, number>; cycles: string[][] };

/** Waves over open "blocks": SCCs, then the longest chain of ancestor components. */
function computeWaves(copy: CopyView, nodes: Map<string, Node>): Waves {
	const open = [...nodes.values()].filter((n) => !n.closed).toSorted(byKey);
	const adj = new Map<string, string[]>(open.map((n) => [n.row.id, []]));
	const inBlocks = new Set<string>();
	const selfLoops = new Set<string>();
	for (const e of copy.edges) {
		if (e.type !== 'blocks') continue;
		const from = nodes.get(e.from);
		const to = nodes.get(e.to);
		if (!from || !to) continue;
		// A closed counterpart still puts the open end into "blocks", but adds no ordering.
		if (!from.closed) inBlocks.add(from.row.id);
		if (!to.closed) inBlocks.add(to.row.id);
		if (from.closed || to.closed) continue;
		adj.get(from.row.id)!.push(to.row.id);
		if (from.row.id === to.row.id) selfLoops.add(from.row.id);
	}
	const comp = components(
		open.map((n) => n.row.id),
		adj,
	);
	const members = new Map<number, string[]>();
	for (const [id, c] of comp) members.set(c, [...(members.get(c) ?? []), id]);
	const cyclic = new Set<number>();
	const cycles: string[][] = [];
	for (const [c, ids] of members) {
		if (ids.length < 2 && !selfLoops.has(ids[0]!)) continue;
		cyclic.add(c);
		cycles.push(ids.toSorted((a, b) => byKey(nodes.get(a)!, nodes.get(b)!)));
	}
	cycles.sort((a, b) => byKey(nodes.get(a[0]!)!, nodes.get(b[0]!)!));

	// Tarjan numbers components in reverse topological order, so walking the numbers downwards visits every
	// component after all of its ancestors; depth = longest chain of ancestor components.
	const succ = new Map<number, Set<number>>([...members.keys()].map((c) => [c, new Set()]));
	for (const [from, outs] of adj) {
		for (const to of outs) {
			const a = comp.get(from)!;
			const b = comp.get(to)!;
			if (a !== b) succ.get(a)!.add(b);
		}
	}
	const depth = new Map<number, number>([...members.keys()].map((c) => [c, 0]));
	for (let c = members.size - 1; c >= 0; c--) {
		for (const next of succ.get(c)!) {
			depth.set(next, Math.max(depth.get(next)!, depth.get(c)! + 1));
		}
	}
	const wave = new Map<string, number>();
	for (const id of inBlocks) {
		const c = comp.get(id)!;
		if (!cyclic.has(c)) wave.set(id, depth.get(c)!);
	}
	return { wave, cycles };
}

export function buildGraph(
	copy: CopyView,
	o: { planeUrl: string; workspaceSlug: string; lastRun: RunSummary | null; now: Date },
): GraphJson {
	const nodes = indexItems(copy);
	const { wave, cycles } = computeWaves(copy, nodes);

	// Open items with an edge to a live item enter; closed ones only as blockers of an open item
	// (which has that very edge, so it entered).
	const entered = new Set<string>();
	const touched = new Set<string>();
	for (const e of copy.edges) {
		if (nodes.has(e.from) && nodes.has(e.to)) {
			touched.add(e.from);
			touched.add(e.to);
		}
	}
	for (const node of nodes.values()) {
		if (node.row.parentId !== null && nodes.has(node.row.parentId)) {
			touched.add(node.row.id);
			touched.add(node.row.parentId);
		}
	}
	for (const node of nodes.values()) {
		if (!node.closed && touched.has(node.row.id)) entered.add(node.row.id);
	}
	for (const e of copy.edges) {
		const from = nodes.get(e.from);
		if (e.type === 'blocks' && from && nodes.get(e.to)?.closed === false) {
			entered.add(from.row.id);
		}
	}

	const cycleIds = new Set(cycles.flat());
	const base = o.planeUrl.replace(/\/+$/, '');
	const shown = [...entered].map((id) => nodes.get(id)!).toSorted(byKey);
	const items: GraphJson['items'] = shown.map((n) => ({
		id: n.row.id,
		key: n.key,
		name: n.row.name,
		projectId: n.row.projectId,
		stateGroup: n.group,
		closed: n.closed,
		areas: n.labels.filter((l) => l.startsWith(AREA_PREFIX)),
		url: `${base}/${o.workspaceSlug}/browse/${n.key}/`,
		wave: wave.get(n.row.id) ?? null,
		inCycle: cycleIds.has(n.row.id),
	}));

	// Group open wave items by (wave, area); a wave-0 item with several areas appears in each group.
	const groups = new Map<string, { wave: number; area: string | null; nodes: Node[] }>();
	for (const n of shown) {
		const w = wave.get(n.row.id);
		if (w === undefined) continue;
		const areas = n.labels.filter((l) => l.startsWith(AREA_PREFIX));
		for (const area of areas.length > 0 ? areas : [null]) {
			const id = `${w}\u0000${area}`;
			const group = groups.get(id) ?? { wave: w, area, nodes: [] };
			group.nodes.push(n);
			groups.set(id, group);
		}
	}
	const all = [...groups.values()];
	const conflicts = all
		.filter((g): g is typeof g & { area: string } => g.area !== null && g.nodes.length >= 2)
		.toSorted((a, b) => a.wave - b.wave || compareText(a.area, b.area))
		.map((g) => ({ wave: g.wave, area: g.area, items: g.nodes.map((n) => n.row.id) }));
	const canStart = all
		.filter((g) => g.wave === 0)
		.toSorted((a, b) => (a.area === null ? 1 : b.area === null ? -1 : compareText(a.area, b.area)))
		.map((g) => ({ area: g.area, items: g.nodes.map((n) => n.row.id) }));

	return {
		generatedAt: o.now.toISOString(),
		syncedAt: copy.syncedAt,
		lastAgentRun: o.lastRun,
		projects: copy.projects.toSorted((a, b) => compareText(a.identifier, b.identifier)),
		items,
		edges: collectEdges(copy, nodes, entered),
		cycles,
		conflicts,
		canStart,
		hiddenOpen: [...nodes.values()].filter((n) => !n.closed && !entered.has(n.row.id)).length,
	};
}

export function buildSnapshot(
	copy: CopyView,
	o: {
		workspaceSlug: string;
		lastRun: RunSummary | null;
		rejected: SnapshotJson['rejected'];
		now: Date;
	},
): SnapshotJson {
	const nodes = indexItems(copy);
	const moduleNames = new Map<string, string[]>();
	for (const m of copy.modules) {
		for (const id of m.itemIds) {
			if (nodes.has(id)) moduleNames.set(id, [...(moduleNames.get(id) ?? []), m.name]);
		}
	}
	const items: SnapshotJson['items'] = [...nodes.values()].toSorted(byKey).map((n) => ({
		id: n.row.id,
		key: n.key,
		projectId: n.row.projectId,
		name: n.row.name,
		description: n.row.description,
		stateGroup: n.group,
		closed: n.closed,
		parentId: n.row.parentId !== null && nodes.has(n.row.parentId) ? n.row.parentId : null,
		modules: (moduleNames.get(n.row.id) ?? []).toSorted(compareText),
		labels: n.labels,
		createdAt: n.row.createdAt,
		updatedAt: n.row.updatedAt,
	}));
	return {
		generatedAt: o.now.toISOString(),
		syncedAt: copy.syncedAt,
		workspaceSlug: o.workspaceSlug,
		lastAgentRun: o.lastRun,
		projects: copy.projects.toSorted((a, b) => compareText(a.identifier, b.identifier)),
		labels: copy.labels.toSorted((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id)),
		items,
		edges: collectEdges(copy, nodes, new Set(nodes.keys())),
		rejected: o.rejected,
	};
}
