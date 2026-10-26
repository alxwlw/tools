// Adapted from apps/plane-discord/test/fake-plane.ts.
import type {
	MemberSummary,
	NewComment,
	NewWorkItem,
	PlaneApi,
	ProjectSummary,
	SearchHit,
	StateSummary,
	Upsert,
	WorkItem,
} from '../src/plane/client.ts';
import { PlaneApiError } from '../src/plane/client.ts';

type StoredComment = {
	id: string;
	html: string;
	externalSource: string | null;
	externalId: string | null;
	projectId: string;
	workItemId: string;
};

/**
 * Plane in memory. Seed `projects`, `states`, `members`, `items`, `comments` directly; what the code
 * under test did lands in `createdItems`, `createdComments`, `descriptions`, `links` and `calls`.
 */
export class FakePlane implements PlaneApi {
	botId = 'bot-1';
	projects: ProjectSummary[] = [];
	/** projectId → states */
	states = new Map<string, StateSummary[]>();
	members: MemberSummary[] = [];
	/** Work items by id; the key `LAB-40` is `<project identifier>-<sequenceId>`. */
	items = new Map<string, WorkItem & { externalSource?: string; externalId?: string }>();
	/** workItemId → links, in creation order. */
	links = new Map<string, Array<{ url: string; title: string }>>();
	comments: StoredComment[] = [];
	/** workItemId → the last description written by updateDescription. */
	descriptions = new Map<string, string>();
	createdItems: Array<{ projectId: string; item: NewWorkItem; id: string }> = [];
	createdComments: Array<{
		projectId: string;
		workItemId: string;
		comment: NewComment;
		id: string;
	}> = [];
	/** Names of the PlaneApi methods called, in order. */
	calls: string[] = [];
	#failures = new Map<keyof PlaneApi, Error[]>();
	#seq = 0;

	/** The next call of `method` throws `error` (queued: several calls fail in turn). */
	failNext(method: keyof PlaneApi, error: Error): void {
		this.#failures.set(method, [...(this.#failures.get(method) ?? []), error]);
	}

	#enter(method: keyof PlaneApi): void {
		this.calls.push(method);
		const error = this.#failures.get(method)?.shift();
		if (error) throw error;
	}

	async botUserId(): Promise<string> {
		this.#enter('botUserId');
		return this.botId;
	}

	async listProjects(): Promise<ProjectSummary[]> {
		this.#enter('listProjects');
		return [...this.projects];
	}

	async listStates(projectId: string): Promise<StateSummary[]> {
		this.#enter('listStates');
		return [...(this.states.get(projectId) ?? [])];
	}

	async listMembers(): Promise<MemberSummary[]> {
		this.#enter('listMembers');
		return [...this.members];
	}

	/** Missing item, or one of another project → null, as Plane's 404. */
	async getWorkItem(projectId: string, workItemId: string): Promise<WorkItem | null> {
		this.#enter('getWorkItem');
		const item = this.items.get(workItemId);
		return item && item.projectId === projectId ? item : null;
	}

	async getWorkItemByKey(key: string): Promise<WorkItem | null> {
		this.#enter('getWorkItemByKey');
		return [...this.items.values()].find((item) => this.#keyOf(item) === key) ?? null;
	}

	/** Case-insensitive substring of the name, or exactly the key. */
	async searchWorkItems(query: string): Promise<SearchHit[]> {
		this.#enter('searchWorkItems');
		const q = query.toLowerCase();
		return [...this.items.values()]
			.map((item) => ({ item, key: this.#keyOf(item) }))
			.filter(({ item, key }) => item.name.toLowerCase().includes(q) || key?.toLowerCase() === q)
			.map(({ item, key }) => ({
				id: item.id,
				projectId: item.projectId,
				key: key ?? '',
				name: item.name,
			}));
	}

	#keyOf(item: WorkItem): string | null {
		const project = this.projects.find((p) => p.id === item.projectId);
		return project ? `${project.identifier}-${item.sequenceId}` : null;
	}

	/** 409 on a repeated external_id in the project: `created: false` and the existing id. */
	async createWorkItem(projectId: string, item: NewWorkItem): Promise<Upsert> {
		this.#enter('createWorkItem');
		for (const existing of this.items.values()) {
			if (
				existing.projectId === projectId &&
				existing.externalSource === item.external_source &&
				existing.externalId === item.external_id
			)
				return { id: existing.id, created: false };
		}
		const id = `fake-w-${++this.#seq}`;
		this.items.set(id, {
			id,
			projectId,
			sequenceId: this.#seq,
			name: item.name,
			stateId: this.states.get(projectId)?.[0]?.id ?? '',
			assignees: [],
			descriptionHtml: item.description_html,
			externalSource: item.external_source,
			externalId: item.external_id,
		});
		this.createdItems.push({ projectId, item, id });
		return { id, created: true };
	}

	async updateDescription(projectId: string, workItemId: string, html: string): Promise<void> {
		this.#enter('updateDescription');
		const item = this.items.get(workItemId);
		if (!item || item.projectId !== projectId)
			throw new PlaneApiError(404, 'PATCH', `/projects/${projectId}/work-items/${workItemId}/`);
		item.descriptionHtml = html;
		this.descriptions.set(workItemId, html);
	}

	/** Looks at every comment of the item, as the real scan does. */
	async findCommentByExternalId(
		_projectId: string,
		workItemId: string,
		source: string,
		externalId: string,
	): Promise<{ id: string } | null> {
		this.#enter('findCommentByExternalId');
		const found = this.comments.find(
			(c) =>
				c.workItemId === workItemId && c.externalSource === source && c.externalId === externalId,
		);
		return found ? { id: found.id } : null;
	}

	/** Plane does not dedupe comments: a repeat creates a second one. */
	async createComment(projectId: string, workItemId: string, comment: NewComment): Promise<Upsert> {
		this.#enter('createComment');
		const id = `fake-c-${++this.#seq}`;
		this.comments.push({
			id,
			html: comment.comment_html,
			externalSource: comment.external_source,
			externalId: comment.external_id,
			projectId,
			workItemId,
		});
		this.createdComments.push({ projectId, workItemId, comment, id });
		return { id, created: true };
	}

	/** The same URL on the same work item → 'exists', as Plane's 400. */
	async createLink(
		_projectId: string,
		workItemId: string,
		link: { url: string; title: string },
	): Promise<'created' | 'exists'> {
		this.#enter('createLink');
		const list = this.links.get(workItemId) ?? [];
		if (list.some((l) => l.url === link.url)) return 'exists';
		this.links.set(workItemId, [...list, { ...link }]);
		return 'created';
	}
}
