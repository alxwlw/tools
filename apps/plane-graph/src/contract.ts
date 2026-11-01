// Data contracts of plane-graph. Types only: the browser code imports this file with `import type`,
// so it must not import runtime modules nor use Bun/node types.

export type StateGroup = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled' | 'triage';
/** blocks: from = blocker, to = blocked; parent: from = parent. */
export type EdgeType = 'blocks' | 'relates' | 'parent';
/** from/to are work item ids. */
export type Edge = { from: string; to: string; type: EdgeType };
export type RunSummary = {
	at: string;
	kind: 'batch' | 'daily' | 'first';
	relationsAdded: number;
	labelsAdded: number;
};

// GET /t/<tenant>/graph.json
export interface GraphJson {
	generatedAt: string;
	syncedAt: string | null;
	lastAgentRun: RunSummary | null;
	projects: { id: string; identifier: string; name: string }[];
	items: {
		id: string;
		key: string;
		name: string;
		projectId: string;
		stateGroup: StateGroup;
		closed: boolean;
		/** Names of labels with the area prefix, alphabetical. */
		areas: string[];
		/** <PLANE_URL>/<workspaceSlug>/browse/<KEY>/ */
		url: string;
		/** Open items in "blocks" outside a cycle only; 0 = can start now. */
		wave: number | null;
		inCycle: boolean;
	}[];
	/** Only between items of `items`. */
	edges: Edge[];
	/** Strongly connected components of open "blocks" of size >= 2, and self-loops. */
	cycles: string[][];
	/** Two or more open items of one wave sharing an area. */
	conflicts: { wave: number; area: string; items: string[] }[];
	/** Wave 0 by area; null = no area, last. */
	canStart: { area: string | null; items: string[] }[];
	/** Open items that did not make it into `items`. */
	hiddenOpen: number;
}

// GET /t/<tenant>/snapshot.json
export interface SnapshotJson {
	generatedAt: string;
	syncedAt: string | null;
	workspaceSlug: string;
	lastAgentRun: RunSummary | null;
	projects: { id: string; identifier: string; name: string }[];
	labels: { id: string; projectId: string; name: string }[];
	/** All non-deleted items. */
	items: {
		id: string;
		key: string;
		projectId: string;
		name: string;
		description: string;
		stateGroup: StateGroup;
		closed: boolean;
		parentId: string | null;
		modules: string[];
		labels: string[];
		createdAt: string;
		updatedAt: string;
	}[];
	edges: Edge[];
	rejected: {
		relations: { fromId: string; toId: string }[];
		labels: { itemId: string; label: string }[];
	};
}

// POST /t/<tenant>/agent-runs
export interface AgentRunIn {
	runId: string;
	kind: 'batch' | 'daily' | 'first';
	startedAt: string;
	finishedAt: string;
	/** fromId blocks toId. */
	relationsAdded: { fromId: string; toId: string }[];
	labelsAdded: { itemId: string; label: string }[];
	skipped: number;
	costUsd: number | null;
}

// The local copy of Plane data.
export interface ProjectRow {
	id: string;
	identifier: string;
	name: string;
}
export interface StateRow {
	id: string;
	projectId: string;
	group: StateGroup;
}
export interface LabelRow {
	id: string;
	projectId: string;
	name: string;
}
export interface ModuleRow {
	id: string;
	projectId: string;
	name: string;
	itemIds: string[];
}
export interface ItemRow {
	id: string;
	projectId: string;
	sequenceId: number;
	name: string;
	description: string;
	stateId: string;
	parentId: string | null;
	labelIds: string[];
	createdAt: string;
	updatedAt: string;
}
/** The copy keeps only `blocks` and `relates` edges; `parent` edges are built from `parentId`. */
export interface CopyData {
	projects: ProjectRow[];
	states: StateRow[];
	labels: LabelRow[];
	modules: ModuleRow[];
	items: ItemRow[];
	edges: Edge[];
}
export interface CopyView extends CopyData {
	syncedAt: string | null;
}

export type MarkKey =
	| { kind: 'relation'; fromId: string; toId: string }
	| { kind: 'label'; itemId: string; label: string };
export type AgentMark = MarkKey & {
	runId: string;
	addedAt: string;
	confirmedAt: string | null;
	rejectedAt: string | null;
};
