import type { StateSummary } from '../plane.ts';

const GROUP_RANK: Readonly<Record<string, number>> = {
	backlog: 0,
	unstarted: 1,
	started: 2,
	completed: 3,
};
/** `cancelled` and anything unknown sort after `completed`; none of them is ever a target. */
const OTHER_RANK = 4;
const MOVABLE_GROUPS = new Set(['backlog', 'unstarted', 'started']);

/** Order of states by `[group rank, sequence]`; negative — `a` comes first. */
export function compareStates(a: StateSummary, b: StateSummary): number {
	const rank = (s: StateSummary) => GROUP_RANK[s.group] ?? OTHER_RANK;
	return rank(a) - rank(b) || a.sequence - b.sequence;
}

/** A task may be moved while it is in backlog/unstarted/started and not in a hold state. */
export function isMovable(state: StateSummary, hold: readonly string[]): boolean {
	const name = state.name.toLowerCase();
	return MOVABLE_GROUPS.has(state.group) && !hold.some((h) => h.toLowerCase() === name);
}

/** A state a task may be moved onto: cancelled and unknown groups never are. */
export function isTarget(state: StateSummary): boolean {
	return state.group in GROUP_RANK;
}

export function stateByName(states: readonly StateSummary[], name: string): StateSummary | null {
	const wanted = name.toLowerCase();
	return states.find((s) => s.name.toLowerCase() === wanted) ?? null;
}
