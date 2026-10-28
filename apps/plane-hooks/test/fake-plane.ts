import {
	type CommentSummary,
	type LabelSummary,
	type LinkSummary,
	type NewComment,
	type NewRelease,
	type NewWorkItem,
	type PlaneApi,
	PlaneApiError,
	type ProjectSummary,
	type StateSummary,
	type Upsert,
	type WorkItemRef,
} from '../src/plane.ts';

/**
 * In-memory Plane. scripts/probe-plane.ts checks part of its semantics on the
 * real instance: a duplicate external_id answers 409 with the existing id (a
 * work item in its project; a comment repeated on the same work item), and a
 * lookup by external_id or by key answers 404 → null when nothing matches.
 *
 * Archive (probe rows 14, same on a Business and a Free workspace): archiving
 * answers 400 unless the item's state group is completed/cancelled; an archived
 * item answers 404 to its detail GET, yet the duplicate check (409, its id), the
 * external_id lookup and the comment list/create (201) still see it, and it is
 * listed under /archived-work-items/. Unarchive answers 204 and the detail is
 * back, still in its completed/cancelled state; unarchive of an item that is not
 * archived answers 404.
 *
 * Not checked by the probe, taken from Plane's source (`apps/api/plane/api/views/issue.py`):
 * the comment duplicate check spans the whole project, and a project the bot is
 * not a member of answers 403.
 *
 * Duplicate checks are read-then-insert with a yield in between — like Plane's
 * own view code — so concurrent calls race here exactly as they would in prod.
 * listComments answers newest first: callers must not rely on list order.
 *
 * Releases: whether Plane answers 409 to a duplicate release external_id is not probed, so createRelease always
 * creates — a caller that skips findReleaseByExternalId gets a second release here, as it might in prod.
 */
export type FakeWorkItem = NewWorkItem & {
	id: string;
	project: string;
	sequence: number;
	state: string;
};
export type FakeComment = NewComment & {
	id: string;
	project: string;
	workItemId: string;
	created_at: string;
};
export type FakeLink = {
	id: string;
	project: string;
	workItemId: string;
	url: string;
	title: string;
};

export type FakeRelease = NewRelease & { id: string; changelog: string; workItemIds: string[] };

export const STATES: StateSummary[] = [
	{ id: 'st-backlog', name: 'Backlog', group: 'backlog', sequence: 15000, default: true },
	{ id: 'st-started', name: 'In Progress', group: 'started', sequence: 35000, default: false },
	{ id: 'st-done', name: 'Done', group: 'completed', sequence: 45000, default: false },
	{ id: 'st-cancelled', name: 'Cancelled', group: 'cancelled', sequence: 55000, default: false },
];

/** [name, group, sequence] */
type StateRow = [string, string, number];
const MR_STATES: StateRow[] = [
	['Backlog', 'backlog', 15000],
	['Todo', 'unstarted', 25000],
	['In Progress', 'started', 35000],
	['In Review', 'started', 37000],
	['On staging', 'started', 40000],
	['Done', 'completed', 45000],
	['Cancelled', 'cancelled', 55000],
];
const without = (names: string[]) => MR_STATES.filter(([name]) => !names.includes(name));

/** State sets of the delivery projects, keyed by identifier. */
const DELIVERY_STATES: Record<string, StateRow[]> = {
	ENG: MR_STATES,
	OPS: without(['In Review', 'On staging']),
	QA: [...MR_STATES, ['Needs info', 'started', 38000], ['Ready for retest', 'started', 41000]],
	INC: MR_STATES,
};

function statesOf(identifier: string, rows: StateRow[]): StateSummary[] {
	const prefix = identifier.toLowerCase();
	return rows.map(([name, group, sequence]) => ({
		id: `${prefix}-${name.toLowerCase().replaceAll(' ', '-')}`,
		name,
		group,
		sequence,
		default: name === 'Backlog',
	}));
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class FakePlane implements PlaneApi {
	readonly workItems: FakeWorkItem[] = [];
	readonly comments: FakeComment[] = [];
	readonly releases: FakeRelease[] = [];
	readonly labels = new Map<string, LabelSummary[]>();
	readonly calls: string[] = [];
	readonly forbiddenProjects = new Set<string>();
	/** Archived work item ids: only `getWorkItem` stops seeing them (404). */
	readonly archived = new Set<string>();
	/** Link rows; `createLink` answers 'exists' for a URL a work item already has. */
	readonly links: FakeLink[] = [];
	readonly #projects: Map<string, string>;
	readonly #states = new Map<string, StateSummary[]>();
	readonly #failures = new Map<keyof PlaneApi, Error>();
	#sequence = 0;
	#clock = Date.parse('2026-10-06T00:00:00Z');

	/** `projects`: identifier → project id. */
	constructor(projects: Record<string, string> = { OPS: 'p-ops' }) {
		this.#projects = new Map(Object.entries(projects));
	}

	/** ENG, OPS, QA and INC with the delivery state sets (ids look like `eng-in-review`). */
	static delivery(): FakePlane {
		const plane = new FakePlane({ ENG: 'p-eng', OPS: 'p-ops', QA: 'p-qa', INC: 'p-inc' });
		for (const [identifier, rows] of Object.entries(DELIVERY_STATES)) {
			plane.#states.set(plane.#projects.get(identifier) as string, statesOf(identifier, rows));
		}
		return plane;
	}

	/** A work item by key (`ENG-12`) in the state called `state`; returns its id. */
	addWorkItem(key: string, state: string): string {
		const match = /^([A-Z0-9]+)-(\d+)$/.exec(key);
		const project = match ? this.#projects.get(match[1] as string) : undefined;
		if (!match || project === undefined) throw new Error(`no project for key ${key}`);
		const found = this.#statesOf(project).find((s) => s.name === state);
		if (!found) throw new Error(`no state "${state}" in ${match[1]}`);
		const sequence = Number(match[2]);
		if (this.workItems.some((w) => w.project === project && w.sequence === sequence))
			throw new Error(`${key} exists`);
		const item = this.seedWorkItem(project, { state: found.id, sequence });
		return item.id;
	}

	/** The next call of `method` rejects with `error`. */
	failNext(method: keyof PlaneApi, error: Error = new PlaneApiError(500, 'FAKE', method)): void {
		this.#failures.set(method, error);
	}

	seedWorkItem(project: string, fields: Partial<FakeWorkItem> = {}): FakeWorkItem {
		const sequence = ++this.#sequence;
		// The key number skips numbers a project already uses (an explicit `addWorkItem('ENG-3', …)`).
		let keyNumber = fields.sequence ?? sequence;
		while (
			fields.sequence === undefined &&
			this.workItems.some((w) => w.project === project && w.sequence === keyNumber)
		)
			keyNumber++;
		const item: FakeWorkItem = {
			id: `w${sequence}`,
			project,
			sequence: keyNumber,
			state: this.#defaultState(project),
			name: `seeded ${sequence}`,
			description_html: '',
			priority: 'none',
			labels: [],
			external_id: `seed-${sequence}`,
			external_source: 'seed',
			...fields,
		};
		this.workItems.push(item);
		return item;
	}

	seedComment(workItemId: string, externalId: string | null, createdAt: string): FakeComment {
		const item = this.workItems.find((w) => w.id === workItemId);
		if (!item) throw new Error(`no work item ${workItemId}`);
		const comment: FakeComment = {
			id: `c${++this.#sequence}`,
			project: item.project,
			workItemId,
			comment_html: '<p>seeded</p>',
			external_id: externalId ?? '',
			external_source: externalId === null ? '' : 'seed',
			created_at: createdAt,
		};
		this.comments.push(comment);
		return comment;
	}

	commentsOf(workItemId: string): FakeComment[] {
		return this.comments.filter((c) => c.workItemId === workItemId);
	}

	async createWorkItem(projectId: string, item: NewWorkItem): Promise<Upsert> {
		this.#enter('createWorkItem', projectId);
		const existing = this.workItems.find(
			(w) =>
				w.project === projectId &&
				w.external_id === item.external_id &&
				w.external_source === item.external_source,
		);
		await tick();
		if (existing) return { id: existing.id, created: false };
		const created = this.seedWorkItem(projectId, { ...item, state: this.#defaultState(projectId) });
		return { id: created.id, created: true };
	}

	async findWorkItemByExternalId(
		projectId: string,
		source: string,
		externalId: string,
	): Promise<{ id: string } | null> {
		this.#enter('findWorkItemByExternalId', projectId);
		const found = this.workItems.find(
			(w) =>
				w.project === projectId && w.external_id === externalId && w.external_source === source,
		);
		return found ? { id: found.id } : null;
	}

	async getWorkItem(projectId: string, workItemId: string): Promise<WorkItemRef> {
		this.#enter('getWorkItem', projectId);
		const item = this.#item(projectId, workItemId);
		if (this.archived.has(item.id))
			throw new PlaneApiError(404, 'GET', `/work-items/${workItemId}/`);
		return { id: item.id, project: item.project, state: item.state, sequenceId: item.sequence };
	}

	async archiveWorkItem(projectId: string, workItemId: string): Promise<void> {
		this.#enter('archiveWorkItem', projectId);
		const item = this.#item(projectId, workItemId);
		const group = this.#statesOf(projectId).find((s) => s.id === item.state)?.group;
		if (group !== 'completed' && group !== 'cancelled')
			throw new PlaneApiError(400, 'POST', `/work-items/${workItemId}/archive/`);
		this.archived.add(item.id);
	}

	async unarchiveWorkItem(projectId: string, workItemId: string): Promise<void> {
		this.#enter('unarchiveWorkItem', projectId);
		const item = this.#item(projectId, workItemId);
		if (!this.archived.delete(item.id))
			throw new PlaneApiError(404, 'DELETE', `/work-items/${workItemId}/unarchive/`);
	}

	async isWorkItemArchived(projectId: string, workItemId: string): Promise<boolean> {
		this.#enter('isWorkItemArchived', projectId);
		// Like the client: an id Plane does not know is not archived.
		const item = this.workItems.find((w) => w.id === workItemId && w.project === projectId);
		return item !== undefined && this.archived.has(item.id);
	}

	async setWorkItemState(projectId: string, workItemId: string, stateId: string): Promise<void> {
		this.#enter('setWorkItemState', projectId);
		this.#item(projectId, workItemId).state = stateId;
	}

	async createComment(projectId: string, workItemId: string, comment: NewComment): Promise<Upsert> {
		this.#enter('createComment', projectId);
		this.#item(projectId, workItemId);
		const existing = this.comments.find(
			(c) =>
				c.project === projectId &&
				c.external_id === comment.external_id &&
				c.external_source === comment.external_source,
		);
		await tick();
		if (existing) return { id: existing.id, created: false };
		this.#clock += 1000;
		const created: FakeComment = {
			...comment,
			id: `c${++this.#sequence}`,
			project: projectId,
			workItemId,
			created_at: new Date(this.#clock).toISOString(),
		};
		this.comments.push(created);
		return { id: created.id, created: true };
	}

	async listComments(projectId: string, workItemId: string): Promise<CommentSummary[]> {
		this.#enter('listComments', projectId);
		this.#item(projectId, workItemId);
		return this.commentsOf(workItemId)
			.map((c) => ({
				id: c.id,
				external_id: c.external_id === '' ? null : c.external_id,
				external_source: c.external_source === '' ? null : c.external_source,
				comment_html: c.comment_html,
				created_at: c.created_at,
			}))
			.reverse();
	}

	async updateComment(
		projectId: string,
		workItemId: string,
		commentId: string,
		html: string,
	): Promise<void> {
		this.#enter('updateComment', projectId);
		this.#item(projectId, workItemId);
		const comment = this.comments.find((c) => c.id === commentId && c.workItemId === workItemId);
		if (!comment) throw new PlaneApiError(404, 'PATCH', `/comments/${commentId}/`);
		comment.comment_html = html;
	}

	async listLinks(projectId: string, workItemId: string): Promise<LinkSummary[]> {
		this.#enter('listLinks', projectId);
		this.#item(projectId, workItemId);
		return this.links
			.filter((l) => l.workItemId === workItemId)
			.map((l) => ({ id: l.id, url: l.url }));
	}

	async createLink(
		projectId: string,
		workItemId: string,
		link: { url: string; title: string },
	): Promise<'created' | 'exists'> {
		this.#enter('createLink', projectId);
		this.#item(projectId, workItemId);
		if (this.links.some((l) => l.workItemId === workItemId && l.url === link.url)) return 'exists';
		this.links.push({ id: `k${++this.#sequence}`, project: projectId, workItemId, ...link });
		return 'created';
	}

	async listProjects(): Promise<ProjectSummary[]> {
		this.#enter('listProjects');
		return [...this.#projects].map(([identifier, id]) => ({ id, identifier }));
	}

	async getWorkItemByKey(key: string): Promise<WorkItemRef | null> {
		this.#enter('getWorkItemByKey');
		const match = /^([A-Z0-9]+)-(\d+)$/.exec(key);
		const project = match ? this.#projects.get(match[1] as string) : undefined;
		if (!match || project === undefined) return null;
		if (this.forbiddenProjects.has(project))
			throw new PlaneApiError(403, 'GET', `/work-items/${key}/`);
		const item = this.workItems.find(
			(w) => w.project === project && w.sequence === Number(match[2]),
		);
		return item
			? { id: item.id, project: item.project, state: item.state, sequenceId: item.sequence }
			: null;
	}

	async listProjectIdentifiers(): Promise<string[]> {
		this.#enter('listProjectIdentifiers');
		return [...this.#projects.keys()];
	}

	async listStates(projectId: string): Promise<StateSummary[]> {
		this.#enter('listStates', projectId);
		return this.#statesOf(projectId).map((s) => ({ ...s }));
	}

	async listLabels(projectId: string): Promise<LabelSummary[]> {
		this.#enter('listLabels', projectId);
		return [...(this.labels.get(projectId) ?? [])];
	}

	async createLabel(projectId: string, name: string): Promise<LabelSummary> {
		this.#enter('createLabel', projectId);
		const label = { id: `l${++this.#sequence}`, name };
		this.labels.set(projectId, [...(this.labels.get(projectId) ?? []), label]);
		return label;
	}

	async findReleaseByExternalId(
		source: string,
		externalId: string,
	): Promise<{ id: string } | null> {
		this.#enter('findReleaseByExternalId');
		const found = this.releases.find(
			(r) => r.external_source === source && r.external_id === externalId,
		);
		return found ? { id: found.id } : null;
	}

	async createRelease(release: NewRelease): Promise<Upsert> {
		this.#enter('createRelease');
		await tick();
		const created: FakeRelease = {
			...release,
			id: `r${++this.#sequence}`,
			changelog: '',
			workItemIds: [],
		};
		this.releases.push(created);
		return { id: created.id, created: true };
	}

	async updateReleaseChangelog(releaseId: string, html: string): Promise<void> {
		this.#enter('updateReleaseChangelog');
		this.#release(releaseId).changelog = html;
	}

	async addReleaseWorkItems(releaseId: string, workItemIds: readonly string[]): Promise<void> {
		this.#enter('addReleaseWorkItems');
		const release = this.#release(releaseId);
		for (const id of workItemIds)
			if (!release.workItemIds.includes(id)) release.workItemIds.push(id);
	}

	#statesOf(projectId: string): StateSummary[] {
		return this.#states.get(projectId) ?? STATES;
	}

	#defaultState(projectId: string): string {
		return (this.#statesOf(projectId).find((s) => s.default) as StateSummary).id;
	}

	#enter(method: keyof PlaneApi, projectId?: string): void {
		this.calls.push(method);
		const failure = this.#failures.get(method);
		if (failure) {
			this.#failures.delete(method);
			throw failure;
		}
		if (projectId !== undefined && this.forbiddenProjects.has(projectId)) {
			throw new PlaneApiError(403, 'FAKE', method);
		}
	}

	#release(releaseId: string): FakeRelease {
		const release = this.releases.find((r) => r.id === releaseId);
		if (!release) throw new PlaneApiError(404, 'FAKE', `/releases/${releaseId}/`);
		return release;
	}

	#item(projectId: string, workItemId: string): FakeWorkItem {
		const item = this.workItems.find((w) => w.id === workItemId && w.project === projectId);
		if (!item) throw new PlaneApiError(404, 'FAKE', `/work-items/${workItemId}/`);
		return item;
	}
}
