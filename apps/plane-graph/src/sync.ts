// Sync layer: Plane reader -> SQLite store. Reconcile, webhook-driven refreshes, agent mark checks.
import type { AgentRunIn, CopyData, Edge, ItemRow, MarkKey } from './contract.ts';
import type { Log } from './log.ts';
import type { PlaneReader } from './plane/client.ts';
import type { PlaneEvent } from './plane/webhook.ts';
import type { SerialQueue } from './queue.ts';
import type { Store } from './store.ts';

export interface SyncDeps {
	tenant: string;
	plane: PlaneReader;
	store: Store;
	log: Log;
	now: () => Date;
	/** Asks for an early reconcile (the copy lacks a state or project of a refreshed item). */
	requestReconcile: () => void;
}

const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const RECONCILE_HOUR_UTC = 3;

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Reads the whole workspace into memory, then swaps the copy in one `replaceCopy`. Any failure logs
 * `sync.failed` (error) and returns false with the old copy untouched.
 *
 * Callers run it as a job of the tenant's `SerialQueue`, never beside it: `replaceCopy` after a long read
 * would overwrite `refreshItem` writes made meanwhile.
 */
export async function reconcile(d: SyncDeps): Promise<boolean> {
	const started = d.now().getTime();
	try {
		const projects = await d.plane.listProjects();
		const data: CopyData = {
			projects,
			states: [],
			labels: [],
			modules: [],
			items: [],
			edges: [],
		};
		for (const p of projects) {
			data.states.push(...(await d.plane.listStates(p.id)));
			data.labels.push(...(await d.plane.listLabels(p.id)));
			data.modules.push(...(await d.plane.listModules(p.id)));
			data.items.push(...(await d.plane.listWorkItems(p.id)));
		}
		// relations are read per item; both ends report an edge, so keep one of each
		const edges = new Map<string, Edge>();
		for (const item of data.items) {
			for (const e of await d.plane.getRelations(item.projectId, item.id)) {
				edges.set(`${e.type}|${e.from}|${e.to}`, e);
			}
		}
		data.edges = [...edges.values()];
		d.store.replaceCopy(d.tenant, data, d.now().toISOString());
		d.log({
			event: 'sync.done',
			tenant: d.tenant,
			projects: data.projects.length,
			items: data.items.length,
			edges: data.edges.length,
			ms: d.now().getTime() - started,
		});
	} catch (err) {
		d.log({ event: 'sync.failed', level: 'error', tenant: d.tenant, error: describeError(err) });
		return false;
	}
	checkMarks(d);
	return true;
}

/** Re-reads one item and its relations; an item Plane no longer returns is deleted from the copy. */
export async function refreshItem(d: SyncDeps, projectId: string, itemId: string): Promise<void> {
	const item = await d.plane.getWorkItem(projectId, itemId);
	if (item === null) {
		d.store.deleteItem(d.tenant, itemId);
		checkMarks(d, [itemId]);
		return;
	}
	const edges = await d.plane.getRelations(projectId, itemId);
	warnIfStale(d, item);
	d.store.putItem(d.tenant, item, edges);
	const neighbours = edges.map((e) => (e.from === itemId ? e.to : e.from));
	checkMarks(d, [itemId, ...neighbours]);
}

/** An item whose state or project the copy does not know is kept, but the copy is stale: ask for a reconcile. */
function warnIfStale(d: SyncDeps, item: ItemRow): void {
	const copy = d.store.copy(d.tenant);
	const knownState = copy.states.some((s) => s.id === item.stateId);
	const knownProject = copy.projects.some((p) => p.id === item.projectId);
	if (knownState && knownProject) return;
	d.log({
		event: 'sync.stale_copy',
		level: 'warn',
		tenant: d.tenant,
		workItemId: item.id,
		projectId: item.projectId,
		stateId: item.stateId,
	});
	d.requestReconcile();
}

/**
 * Compares the agent's marks with the copy. Seen -> `confirmedAt` (first time only); gone after it was
 * seen -> `rejectedAt` and a log line; never seen -> nothing (the agent may be ahead of Plane).
 */
export function checkMarks(d: SyncDeps, itemIds?: readonly string[]): void {
	const marks = d.store.marks(d.tenant, itemIds);
	if (marks.length === 0) return;
	const copy = d.store.copy(d.tenant);
	const blocks = new Set(
		copy.edges.filter((e) => e.type === 'blocks').map((e) => `${e.from}|${e.to}`),
	);
	const labelName = new Map(copy.labels.map((l) => [l.id, l.name]));
	const labelsOf = new Map(
		copy.items.map((i) => [i.id, new Set(i.labelIds.map((id) => labelName.get(id)))]),
	);
	const present = (key: MarkKey): boolean =>
		key.kind === 'relation'
			? blocks.has(`${key.fromId}|${key.toId}`)
			: (labelsOf.get(key.itemId)?.has(key.label) ?? false);
	const nowIso = d.now().toISOString();
	for (const m of marks) {
		if (present(m)) {
			if (m.confirmedAt === null) d.store.setMark(d.tenant, m, { confirmedAt: nowIso });
		} else if (m.confirmedAt !== null && m.rejectedAt === null) {
			d.store.setMark(d.tenant, m, { rejectedAt: nowIso });
			d.log({
				event: 'mark.rejected',
				tenant: d.tenant,
				kind: m.kind,
				runId: m.runId,
				...(m.kind === 'relation' ? { fromId: m.fromId, toId: m.toId } : { itemId: m.itemId }),
			});
		}
	}
}

/**
 * Stores an agent run. A new run asks `refresh` (the function `createRefresher` returns) to re-read every task
 * it touched, so the marks get confirmed without waiting for a webhook. A repeated runId changes nothing.
 */
export function acceptRun(
	d: SyncDeps,
	run: AgentRunIn,
	refresh: (ev: PlaneEvent) => void,
): Promise<boolean> {
	// a throw (store failure) becomes a rejection, like in an async function
	return new Promise((resolve) => resolve(acceptRunNow(d, run, refresh)));
}

function acceptRunNow(d: SyncDeps, run: AgentRunIn, refresh: (ev: PlaneEvent) => void): boolean {
	if (!d.store.putRun(d.tenant, run, d.now().toISOString())) return false;
	const ids = new Set<string>();
	for (const r of run.relationsAdded) {
		ids.add(r.fromId);
		ids.add(r.toId);
	}
	for (const l of run.labelsAdded) ids.add(l.itemId);
	if (ids.size > 0) {
		refresh({
			kind: 'item.touched',
			tenant: d.tenant,
			eventKey: `agent-run:${run.runId}`,
			projectId: null,
			workItemIds: [...ids],
		});
	}
	return true;
}

/**
 * The `enqueue` of the server: turns Plane events into jobs of the tenant's queue. It never throws, the
 * delivery key is already claimed when it is called.
 */
export function createRefresher(d: SyncDeps, queue: SerialQueue): (ev: PlaneEvent) => void {
	const pending = new Set<string>();

	const refreshJob =
		(ev: Extract<PlaneEvent, { kind: 'item.touched' }>, id: string) => async () => {
			// Yield before leaving `pending`: events that arrive in this tick still fold into this read, later
			// ones (the read has started) schedule another.
			await Promise.resolve();
			pending.delete(id);
			const projectId =
				ev.projectId ?? d.store.copy(d.tenant).items.find((i) => i.id === id)?.projectId ?? null;
			if (projectId === null) {
				d.log({ event: 'plane.unknown_item', tenant: d.tenant, workItemId: id });
				return;
			}
			await refreshItem(d, projectId, id);
		};

	return (ev) => {
		try {
			if (ev.kind === 'item.deleted') {
				queue.push(`delete:${ev.workItemId}`, () => {
					d.store.deleteItem(d.tenant, ev.workItemId);
					checkMarks(d, [ev.workItemId]);
					return Promise.resolve();
				});
				return;
			}
			for (const id of new Set(ev.workItemIds)) {
				if (pending.has(id)) continue;
				pending.add(id);
				queue.push(`refresh:${id}`, refreshJob(ev, id));
			}
		} catch (err) {
			d.log({
				event: 'sync.enqueue_failed',
				level: 'error',
				tenant: d.tenant,
				error: describeError(err),
			});
		}
	};
}

/** ok -> the next 03:00 UTC after `now`; after a failure -> now + 10 minutes. */
export function nextReconcileAt(now: Date, lastOk: boolean): Date {
	if (!lastOk) return new Date(now.getTime() + RETRY_AFTER_FAILURE_MS);
	const next = new Date(now);
	next.setUTCHours(RECONCILE_HOUR_UTC, 0, 0, 0);
	if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
	return next;
}
