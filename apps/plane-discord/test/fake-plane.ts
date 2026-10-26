import type {
	CommentDetail,
	MemberSummary,
	NewComment,
	NewWorkItem,
	PlaneApi,
	ProjectSummary,
	StateSummary,
	Upsert,
	WorkItem,
} from '../src/plane/client.ts';
import { PlaneApiError } from '../src/plane/client.ts';

type StoredComment = CommentDetail & { projectId: string; workItemId: string };

/**
 * Plane in memory. Seed `projects`, `states`, `members`, `items`, `comments`, `modules` directly;
 * what the code under test created lands in `createdItems`, `createdComments` and `activities`.
 */
export class FakePlane implements PlaneApi {
	botId = 'bot-1';
	projects: ProjectSummary[] = [];
	/** projectId → states */
	states = new Map<string, StateSummary[]>();
	members: MemberSummary[] = [];
	/** Work items by id; the key `LAB-40` is `<project identifier>-<sequenceId>`. */
	items = new Map<string, WorkItem & { externalSource?: string; externalId?: string }>();
	comments: StoredComment[] = [];
	/** moduleId → work item ids in it */
	modules = new Map<string, Set<string>>();
	createdItems: Array<{ projectId: string; item: NewWorkItem; id: string }> = [];
	createdComments: Array<{
		projectId: string;
		workItemId: string;
		comment: NewComment;
		id: string;
	}> = [];
	activities: Array<{ runId: string; body: string }> = [];
	#seq = 0;

	async botUserId(): Promise<string> {
		return this.botId;
	}

	async listProjects(): Promise<ProjectSummary[]> {
		return [...this.projects];
	}

	async listStates(projectId: string): Promise<StateSummary[]> {
		return [...(this.states.get(projectId) ?? [])];
	}

	async listMembers(): Promise<MemberSummary[]> {
		return [...this.members];
	}

	async getWorkItem(projectId: string, workItemId: string): Promise<WorkItem> {
		const item = this.items.get(workItemId);
		if (!item || item.projectId !== projectId)
			throw new PlaneApiError(404, 'GET', `/projects/${projectId}/work-items/${workItemId}/`);
		return item;
	}

	async getWorkItemByKey(key: string): Promise<WorkItem | null> {
		for (const item of this.items.values()) {
			const project = this.projects.find((p) => p.id === item.projectId);
			if (project && `${project.identifier}-${item.sequenceId}` === key) return item;
		}
		return null;
	}

	async getWorkItemModules(
		_projectId: string,
		workItemId: string,
		moduleIds: readonly string[],
	): Promise<string[]> {
		return moduleIds.filter((m) => this.modules.get(m)?.has(workItemId));
	}

	async getComment(
		_projectId: string,
		workItemId: string,
		commentId: string,
	): Promise<CommentDetail> {
		const found = this.comments.find((c) => c.id === commentId && c.workItemId === workItemId);
		if (!found) throw new Error(`fake plane: no comment ${commentId}`);
		return found;
	}

	async findWorkItemByExternalId(
		projectId: string,
		source: string,
		externalId: string,
	): Promise<{ id: string } | null> {
		for (const item of this.items.values()) {
			if (
				item.projectId === projectId &&
				item.externalSource === source &&
				item.externalId === externalId
			)
				return { id: item.id };
		}
		return null;
	}

	/** 409 on a repeated external_id in the project: `created: false` and the existing id. */
	async createWorkItem(projectId: string, item: NewWorkItem): Promise<Upsert> {
		const existing = await this.findWorkItemByExternalId(
			projectId,
			item.external_source,
			item.external_id,
		);
		if (existing) return { id: existing.id, created: false };
		const id = `fake-w-${++this.#seq}`;
		this.items.set(id, {
			id,
			projectId,
			sequenceId: this.#seq,
			name: item.name,
			stateId: this.states.get(projectId)?.[0]?.id ?? '',
			assignees: [],
			priority: 'none',
			descriptionHtml: item.description_html,
			externalSource: item.external_source,
			externalId: item.external_id,
		});
		this.createdItems.push({ projectId, item, id });
		return { id, created: true };
	}

	/** Looks at every comment of the item, as the real scan does. */
	async findCommentByExternalId(
		_projectId: string,
		workItemId: string,
		source: string,
		externalId: string,
	): Promise<{ id: string } | null> {
		const found = this.comments.find(
			(c) =>
				c.workItemId === workItemId && c.externalSource === source && c.externalId === externalId,
		);
		return found ? { id: found.id } : null;
	}

	/** Plane does not dedupe comments: a repeat creates a second one. */
	async createComment(projectId: string, workItemId: string, comment: NewComment): Promise<Upsert> {
		const id = `fake-c-${++this.#seq}`;
		this.comments.push({
			id,
			html: comment.comment_html,
			actorId: this.botId,
			externalSource: comment.external_source,
			externalId: comment.external_id,
			projectId,
			workItemId,
		});
		this.createdComments.push({ projectId, workItemId, comment, id });
		return { id, created: true };
	}

	async createRunActivity(runId: string, body: string): Promise<void> {
		this.activities.push({ runId, body });
	}
}
