// Builds a CopyView from a short description; tests speak in task keys, ids are derived from them.
import type { CopyView, Edge, EdgeType, ItemRow, ModuleRow, StateGroup } from '../src/contract.ts';

export type TaskSpec = {
	key: string;
	/** true = completed, 'cancelled' = cancelled; default open (started). */
	closed?: boolean | 'cancelled';
	state?: StateGroup;
	labels?: string[];
	/** Key of the parent task. */
	parent?: string;
	modules?: string[];
	name?: string;
	description?: string;
};
export type CopySpec = {
	tasks: TaskSpec[];
	/** [from, type, to] by key; a key without a task makes an edge to a deleted task. */
	edges?: [string, EdgeType, string][];
	/** Extra module members by key (may name deleted tasks). */
	moduleItems?: Record<string, string[]>;
	syncedAt?: string | null;
};

const GROUPS: StateGroup[] = [
	'backlog',
	'unstarted',
	'started',
	'completed',
	'cancelled',
	'triage',
];

export const idOf = (key: string) => `item:${key}`;
export const keyOf = (id: string) => id.replace(/^item:/, '');

const split = (key: string) => {
	const at = key.lastIndexOf('-');
	return { identifier: key.slice(0, at), sequenceId: Number(key.slice(at + 1)) };
};

export function copyOf(spec: CopySpec): CopyView {
	const identifiers = [...new Set(spec.tasks.map((t) => split(t.key).identifier))];
	const labels = new Map<string, { id: string; projectId: string; name: string }>();
	const modules = new Map<string, ModuleRow>();
	const items: ItemRow[] = spec.tasks.map((t) => {
		const { identifier, sequenceId } = split(t.key);
		const projectId = `project:${identifier}`;
		const group =
			t.state ?? (t.closed === 'cancelled' ? 'cancelled' : t.closed ? 'completed' : 'started');
		const labelIds = (t.labels ?? []).map((name) => {
			const id = `label:${identifier}:${name}`;
			labels.set(id, { id, projectId, name });
			return id;
		});
		for (const name of t.modules ?? []) {
			const id = `module:${identifier}:${name}`;
			const module = modules.get(id) ?? { id, projectId, name, itemIds: [] };
			module.itemIds.push(idOf(t.key));
			modules.set(id, module);
		}
		return {
			id: idOf(t.key),
			projectId,
			sequenceId,
			name: t.name ?? `Task ${t.key}`,
			description: t.description ?? '',
			stateId: `state:${identifier}:${group}`,
			parentId: t.parent === undefined ? null : idOf(t.parent),
			labelIds,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-02T00:00:00.000Z',
		};
	});
	for (const [name, keys] of Object.entries(spec.moduleItems ?? {})) {
		const id = `module:ABC:${name}`;
		const module = modules.get(id) ?? { id, projectId: 'project:ABC', name, itemIds: [] };
		module.itemIds.push(...keys.map(idOf));
		modules.set(id, module);
	}
	const edges: Edge[] = (spec.edges ?? []).map(([from, type, to]) => ({
		from: idOf(from),
		to: idOf(to),
		type,
	}));
	return {
		projects: identifiers.map((identifier) => ({
			id: `project:${identifier}`,
			identifier,
			name: `Project ${identifier}`,
		})),
		states: identifiers.flatMap((identifier) =>
			GROUPS.map((group) => ({
				id: `state:${identifier}:${group}`,
				projectId: `project:${identifier}`,
				group,
			})),
		),
		labels: [...labels.values()],
		modules: [...modules.values()],
		items,
		edges,
		syncedAt: spec.syncedAt === undefined ? '2026-01-03T00:00:00.000Z' : spec.syncedAt,
	};
}
