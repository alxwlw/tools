import {
	type CommentSummary,
	type LabelSummary,
	type NewComment,
	type NewRelease,
	type NewWorkItem,
	type PlaneApi,
	PlaneApiError,
	type StateSummary,
	type Upsert,
	type WorkItemRef,
} from "../src/plane.ts";

/**
 * In-memory Plane. scripts/probe-plane.ts checks part of its semantics on the
 * real instance: a duplicate external_id answers 409 with the existing id (a
 * work item in its project; a comment repeated on the same work item), and a
 * lookup by external_id or by key answers 404 → null when nothing matches.
 *
 * Not checked by the probe, taken from Plane's source (`apps/api/plane/api/views/issue.py`):
 * the comment duplicate check spans the whole project, a project the bot is not
 * a member of answers 403, and an `archived` item stays visible to the duplicate
 * check, the external_id lookup and PATCH (`Issue.objects`) and keeps taking and
 * listing comments (the comment endpoints never load the item), while its detail
 * GET answers 404 (`issue_objects`). Archiving is not reachable through the
 * external API, so no probe row can create an archived item.
 *
 * Duplicate checks are read-then-insert with a yield in between — like Plane's
 * own view code — so concurrent calls race here exactly as they would in prod.
 * listComments answers newest first: callers must not rely on list order.
 *
 * Releases: whether Plane answers 409 to a duplicate release external_id is not probed, so createRelease always
 * creates — a caller that skips findReleaseByExternalId gets a second release here, as it might in prod.
 */
export type FakeWorkItem = NewWorkItem & { id: string; project: string; sequence: number; state: string };
export type FakeComment = NewComment & { id: string; project: string; workItemId: string; created_at: string };

export type FakeRelease = NewRelease & { id: string; changelog: string; workItemIds: string[] };

export const STATES: StateSummary[] = [
	{ id: "st-backlog", group: "backlog", default: true },
	{ id: "st-started", group: "started", default: false },
	{ id: "st-done", group: "completed", default: false },
	{ id: "st-cancelled", group: "cancelled", default: false },
];

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class FakePlane implements PlaneApi {
	readonly workItems: FakeWorkItem[] = [];
	readonly comments: FakeComment[] = [];
	readonly releases: FakeRelease[] = [];
	readonly labels = new Map<string, LabelSummary[]>();
	readonly calls: string[] = [];
	readonly forbiddenProjects = new Set<string>();
	/** Work item ids archived in the UI: only `getWorkItem` stops seeing them. */
	readonly archived = new Set<string>();
	readonly #projects: Map<string, string>;
	readonly #failures = new Map<keyof PlaneApi, Error>();
	#sequence = 0;
	#clock = Date.parse("2026-10-06T00:00:00Z");

	/** `projects`: identifier → project id. */
	constructor(projects: Record<string, string> = { OPS: "p-ops" }) {
		this.#projects = new Map(Object.entries(projects));
	}

	/** The next call of `method` rejects with `error`. */
	failNext(method: keyof PlaneApi, error: Error = new PlaneApiError(500, "FAKE", method)): void {
		this.#failures.set(method, error);
	}

	seedWorkItem(project: string, fields: Partial<FakeWorkItem> = {}): FakeWorkItem {
		const sequence = ++this.#sequence;
		const item: FakeWorkItem = {
			id: `w${sequence}`,
			project,
			sequence,
			state: "st-backlog",
			name: `seeded ${sequence}`,
			description_html: "",
			priority: "none",
			labels: [],
			external_id: `seed-${sequence}`,
			external_source: "seed",
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
			comment_html: "<p>seeded</p>",
			external_id: externalId ?? "",
			external_source: externalId === null ? "" : "seed",
			created_at: createdAt,
		};
		this.comments.push(comment);
		return comment;
	}

	commentsOf(workItemId: string): FakeComment[] {
		return this.comments.filter((c) => c.workItemId === workItemId);
	}

	async createWorkItem(projectId: string, item: NewWorkItem): Promise<Upsert> {
		this.#enter("createWorkItem", projectId);
		const existing = this.workItems.find(
			(w) => w.project === projectId && w.external_id === item.external_id && w.external_source === item.external_source,
		);
		await tick();
		if (existing) return { id: existing.id, created: false };
		const created = this.seedWorkItem(projectId, { ...item, state: "st-backlog" });
		return { id: created.id, created: true };
	}

	async findWorkItemByExternalId(projectId: string, source: string, externalId: string): Promise<{ id: string } | null> {
		this.#enter("findWorkItemByExternalId", projectId);
		const found = this.workItems.find(
			(w) => w.project === projectId && w.external_id === externalId && w.external_source === source,
		);
		return found ? { id: found.id } : null;
	}

	async getWorkItem(projectId: string, workItemId: string): Promise<WorkItemRef> {
		this.#enter("getWorkItem", projectId);
		const item = this.#item(projectId, workItemId);
		if (this.archived.has(item.id)) throw new PlaneApiError(404, "GET", `/work-items/${workItemId}/`);
		return { id: item.id, project: item.project, state: item.state };
	}

	async setWorkItemState(projectId: string, workItemId: string, stateId: string): Promise<void> {
		this.#enter("setWorkItemState", projectId);
		this.#item(projectId, workItemId).state = stateId;
	}

	async createComment(projectId: string, workItemId: string, comment: NewComment): Promise<Upsert> {
		this.#enter("createComment", projectId);
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
		this.#enter("listComments", projectId);
		this.#item(projectId, workItemId);
		return this.commentsOf(workItemId)
			.map((c) => ({ id: c.id, external_id: c.external_id === "" ? null : c.external_id, created_at: c.created_at }))
			.reverse();
	}

	async getWorkItemByKey(key: string): Promise<WorkItemRef | null> {
		this.#enter("getWorkItemByKey");
		const match = /^([A-Z0-9]+)-(\d+)$/.exec(key);
		const project = match ? this.#projects.get(match[1] as string) : undefined;
		if (!match || project === undefined) return null;
		if (this.forbiddenProjects.has(project)) throw new PlaneApiError(403, "GET", `/work-items/${key}/`);
		const item = this.workItems.find((w) => w.project === project && w.sequence === Number(match[2]));
		return item ? { id: item.id, project: item.project, state: item.state } : null;
	}

	async listProjectIdentifiers(): Promise<string[]> {
		this.#enter("listProjectIdentifiers");
		return [...this.#projects.keys()];
	}

	async listStates(projectId: string): Promise<StateSummary[]> {
		this.#enter("listStates", projectId);
		return STATES.map((s) => ({ ...s }));
	}

	async listLabels(projectId: string): Promise<LabelSummary[]> {
		this.#enter("listLabels", projectId);
		return [...(this.labels.get(projectId) ?? [])];
	}

	async createLabel(projectId: string, name: string): Promise<LabelSummary> {
		this.#enter("createLabel", projectId);
		const label = { id: `l${++this.#sequence}`, name };
		this.labels.set(projectId, [...(this.labels.get(projectId) ?? []), label]);
		return label;
	}

	async findReleaseByExternalId(source: string, externalId: string): Promise<{ id: string } | null> {
		this.#enter("findReleaseByExternalId");
		const found = this.releases.find((r) => r.external_source === source && r.external_id === externalId);
		return found ? { id: found.id } : null;
	}

	async createRelease(release: NewRelease): Promise<Upsert> {
		this.#enter("createRelease");
		await tick();
		const created: FakeRelease = { ...release, id: `r${++this.#sequence}`, changelog: "", workItemIds: [] };
		this.releases.push(created);
		return { id: created.id, created: true };
	}

	async updateReleaseChangelog(releaseId: string, html: string): Promise<void> {
		this.#enter("updateReleaseChangelog");
		this.#release(releaseId).changelog = html;
	}

	async addReleaseWorkItems(releaseId: string, workItemIds: readonly string[]): Promise<void> {
		this.#enter("addReleaseWorkItems");
		const release = this.#release(releaseId);
		for (const id of workItemIds) if (!release.workItemIds.includes(id)) release.workItemIds.push(id);
	}

	#enter(method: keyof PlaneApi, projectId?: string): void {
		this.calls.push(method);
		const failure = this.#failures.get(method);
		if (failure) {
			this.#failures.delete(method);
			throw failure;
		}
		if (projectId !== undefined && this.forbiddenProjects.has(projectId)) {
			throw new PlaneApiError(403, "FAKE", method);
		}
	}

	#release(releaseId: string): FakeRelease {
		const release = this.releases.find((r) => r.id === releaseId);
		if (!release) throw new PlaneApiError(404, "FAKE", `/releases/${releaseId}/`);
		return release;
	}

	#item(projectId: string, workItemId: string): FakeWorkItem {
		const item = this.workItems.find((w) => w.id === workItemId && w.project === projectId);
		if (!item) throw new PlaneApiError(404, "FAKE", `/work-items/${workItemId}/`);
		return item;
	}
}
