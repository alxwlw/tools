import { type PlaneApi, PlaneApiError, type Priority, type WorkItemRef } from './plane.ts';
import { ttl } from './ttl.ts';

export type Source = 'grafana' | 'vercel' | 'github';
export type IncidentLabel = 'alert' | 'deploy-failed';

/**
 * One event about one incident, whatever its origin. `key` names the incident
 * and becomes the work item's external_id; `occurrence` names one firing of it.
 */
export type IncidentSignal =
	| {
			status: 'firing';
			source: Source;
			key: string;
			occurrence: string;
			at: string;
			title: string;
			bodyHtml: string;
			/** Text of the firing marker comment. */
			noteHtml: string;
			priority: Extract<Priority, 'urgent' | 'high' | 'medium'>;
			label: IncidentLabel;
			/** Environment of an alert, for the Grafana annotation. */
			env?: string;
	  }
	| {
			status: 'resolved';
			source: Source;
			key: string;
			/** Absent for Vercel: derived from the work item's marker comments. */
			occurrence?: string;
			at: string;
			noteHtml: string;
			/** Same title as the firing work item: the annotation text of the resolution. */
			title?: string;
			env?: string;
	  };

export type IncidentAction = 'created' | 'commented' | 'reopened' | 'noop';
export type IncidentResult = { action: IncidentAction; workItemId: string | null };

export interface IncidentReporter {
	report(signal: IncidentSignal): Promise<IncidentResult>;
}

const CLOSED_GROUPS = new Set(['completed', 'cancelled']);
const META_TTL_MS = 10 * 60_000;
const FIRING = ':firing';
const RESOLVED = ':resolved';

/**
 * One Plane work item per incident key plus marker comments per occurrence
 * Every write carries an external_id, so a repeated
 * delivery is a no-op. For firing: work item creation is first, unarchive of an
 * archived item and the reopen check are next, marker is last (commit point).
 * Resolved never unarchives: an archived item takes the marker as it is.
 * Signals with the same key run strictly one after another: Plane's duplicate
 * check is read-then-insert, and two concurrent creates could both pass it.
 * Never closes or archives a work item.
 */
export function createIncidentReporter(deps: {
	plane: PlaneApi;
	projectId: string;
}): IncidentReporter {
	const { plane, projectId } = deps;
	const states = ttl(() => plane.listStates(projectId), META_TTL_MS);
	const labelIds: Record<IncidentLabel, () => Promise<string>> = {
		alert: ttl(() => ensureLabel('alert'), META_TTL_MS),
		'deploy-failed': ttl(() => ensureLabel('deploy-failed'), META_TTL_MS),
	};
	const queues = new Map<string, Promise<unknown>>();

	async function ensureLabel(name: IncidentLabel): Promise<string> {
		const existing = (await plane.listLabels(projectId)).find((label) => label.name === name);
		return existing ? existing.id : (await plane.createLabel(projectId, name)).id;
	}

	function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
		const previous = queues.get(key) ?? Promise.resolve();
		const result = previous.then(run);
		const tail = result.catch(() => undefined);
		queues.set(key, tail);
		void tail.then(() => {
			if (queues.get(key) === tail) queues.delete(key);
		});
		return result;
	}

	async function firing(
		signal: Extract<IncidentSignal, { status: 'firing' }>,
	): Promise<IncidentResult> {
		const item = await plane.createWorkItem(projectId, {
			name: signal.title,
			description_html: signal.bodyHtml,
			priority: signal.priority,
			labels: [await labelIds[signal.label]()],
			external_id: signal.key,
			external_source: signal.source,
		});
		const marker = {
			comment_html: signal.noteHtml,
			external_id: `${signal.key}:${signal.occurrence}${FIRING}`,
			external_source: signal.source,
		};
		if (item.created) {
			await plane.createComment(projectId, item.id, marker);
			return { action: 'created', workItemId: item.id };
		}
		// An archived item is hidden from the detail read, so it is brought back before the reopen check.
		// A lost unarchive response is harmless: the next delivery sees the item no longer archived.
		if (await plane.isWorkItemArchived(projectId, item.id)) {
			await plane.unarchiveWorkItem(projectId, item.id);
		}
		// The marker is the commit point and goes last: a delivery that failed before it redoes the
		// reopen check, one that failed after it (lost response) finds the marker and is a replay.
		const comments = await plane.listComments(projectId, item.id);
		if (comments.some((comment) => comment.external_id === marker.external_id)) {
			return { action: 'noop', workItemId: item.id };
		}
		const reopened = await reopenIfClosed(item.id);
		await plane.createComment(projectId, item.id, marker);
		return { action: reopened ? 'reopened' : 'commented', workItemId: item.id };
	}

	/** Moves a completed/cancelled work item back to the project's default state. */
	async function reopenIfClosed(workItemId: string): Promise<boolean> {
		let current: WorkItemRef;
		try {
			current = await plane.getWorkItem(projectId, workItemId);
		} catch (err) {
			// Safety net: firing unarchives first, but an item archived (or hidden) between that check and this
			// read answers 404 here — the marker is still written, the item is left as it is.
			if (err instanceof PlaneApiError && err.status === 404) return false;
			throw err;
		}
		const all = await states();
		// A state created after the cache was filled has no known group: treat it as open.
		const group = all.find((state) => state.id === current.state)?.group;
		if (group === undefined || !CLOSED_GROUPS.has(group)) return false;
		const initial = all.find((state) => state.default);
		if (!initial) throw new Error(`Plane project ${projectId} has no default state`);
		await plane.setWorkItemState(projectId, workItemId, initial.id);
		return true;
	}

	async function resolved(
		signal: Extract<IncidentSignal, { status: 'resolved' }>,
	): Promise<IncidentResult> {
		const item = await plane.findWorkItemByExternalId(projectId, signal.source, signal.key);
		if (item === null) return { action: 'noop', workItemId: null };
		const occurrence = signal.occurrence ?? (await openOccurrence(item.id, signal.key));
		if (occurrence === null) return { action: 'noop', workItemId: item.id };
		const marker = await plane.createComment(projectId, item.id, {
			comment_html: signal.noteHtml,
			external_id: `${signal.key}:${occurrence}${RESOLVED}`,
			external_source: signal.source,
		});
		return { action: marker.created ? 'commented' : 'noop', workItemId: item.id };
	}

	/** The latest (by created_at) firing occurrence of `key` with no resolved marker yet; null if none. */
	async function openOccurrence(workItemId: string, key: string): Promise<string | null> {
		const prefix = `${key}:`;
		const markers = (await plane.listComments(projectId, workItemId)).flatMap((comment) =>
			comment.external_id?.startsWith(prefix)
				? [{ externalId: comment.external_id, at: Date.parse(comment.created_at) }]
				: [],
		);
		const latestFiring = markers
			.filter((marker) => marker.externalId.endsWith(FIRING))
			.sort((a, b) => a.at - b.at)
			.at(-1);
		if (!latestFiring) return null;
		const occurrence = latestFiring.externalId.slice(prefix.length, -FIRING.length);
		return markers.some((marker) => marker.externalId === `${prefix}${occurrence}${RESOLVED}`)
			? null
			: occurrence;
	}

	return {
		report(signal) {
			return serialized(`${signal.source}\u0000${signal.key}`, () =>
				signal.status === 'firing' ? firing(signal) : resolved(signal),
			);
		},
	};
}

/** Plane project id of an incident project identifier; a missing project is an error the caller turns into a retry. */
export async function resolveIncidentProject(plane: PlaneApi, identifier: string): Promise<string> {
	const project = (await plane.listProjects()).find((item) => item.identifier === identifier);
	if (!project) throw new Error(`incident project ${identifier} not found`);
	return project.id;
}
