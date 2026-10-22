import { SlidingWindow } from '../rate.ts';
import type { Fetch, PlaneAuth } from './auth.ts';

export type ProjectSummary = { id: string; identifier: string; name: string };
export type StateSummary = { id: string; name: string; group: string };
export type MemberSummary = { id: string; displayName: string };
export type WorkItem = {
	id: string;
	projectId: string;
	sequenceId: number;
	name: string;
	stateId: string;
	assignees: string[];
	priority: string;
	descriptionHtml: string | null;
};
export type CommentDetail = {
	id: string;
	html: string;
	actorId: string;
	externalSource: string | null;
	externalId: string | null;
};
export type NewWorkItem = {
	name: string;
	description_html: string;
	external_id: string;
	external_source: string;
};
export type NewComment = { comment_html: string; external_id: string; external_source: string };
/** `created: false` — Plane answered 409: an object with this external_id already exists, and `id` is that object. */
export type Upsert = { id: string; created: boolean };

export interface PlaneApi {
	/** GET /auth/o/app-installation/?id= → app_bot (one per installation). Memoised on success. */
	botUserId(): Promise<string>;
	listProjects(): Promise<ProjectSummary[]>;
	listStates(projectId: string): Promise<StateSummary[]>;
	listMembers(): Promise<MemberSummary[]>;
	getWorkItem(projectId: string, workItemId: string): Promise<WorkItem>;
	/** `LAB-40`; 404 → null. */
	getWorkItemByKey(key: string): Promise<WorkItem | null>;
	/** Which of `moduleIds` contain the item: GET /projects/{p}/modules/{m}/module-issues/ per module, every page. */
	getWorkItemModules(
		projectId: string,
		workItemId: string,
		moduleIds: readonly string[],
	): Promise<string[]>;
	getComment(projectId: string, workItemId: string, commentId: string): Promise<CommentDetail>;
	findWorkItemByExternalId(
		projectId: string,
		source: string,
		externalId: string,
	): Promise<{ id: string } | null>;
	/** 409 → { created: false, id of the existing item }. */
	createWorkItem(projectId: string, item: NewWorkItem): Promise<Upsert>;
	/** Plane does not dedupe comments by external_id: scans every page of the item's comments. */
	findCommentByExternalId(
		projectId: string,
		workItemId: string,
		source: string,
		externalId: string,
	): Promise<{ id: string } | null>;
	createComment(projectId: string, workItemId: string, comment: NewComment): Promise<Upsert>;
	createRunActivity(runId: string, body: string): Promise<void>;
}

/** A non-2xx answer the call did not expect. Carries no response body: bodies can echo payload data into logs. */
export class PlaneApiError extends Error {
	override name = 'PlaneApiError';

	constructor(
		readonly status: number,
		readonly method: string,
		readonly path: string,
	) {
		super(`Plane ${method} ${path} → ${status}`);
	}
}

export type PlaneClientOptions = {
	baseUrl: string;
	workspace: string;
	auth: PlaneAuth;
	appInstallationId: string;
	timeoutMs?: number;
	fetch?: Fetch;
	/** Every request waits here first; default — one SlidingWindow of PLANE_RATE_MAX per PLANE_RATE_WINDOW_MS. */
	limiter?: { acquire(): Promise<void> };
};

const PAGE_SIZE = '100';
/** As plane-hooks: ~1 % of the ~5000/min the bot token showed (design §10, decision 4). */
export const PLANE_RATE_MAX = 50;
export const PLANE_RATE_WINDOW_MS = 60_000;
const MAX_PAGES = 50;

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export class PlaneClient implements PlaneApi {
	readonly #origin: string;
	readonly #root: string;
	readonly #installationId: string;
	readonly #auth: PlaneAuth;
	readonly #timeoutMs: number;
	readonly #fetch: Fetch;
	readonly #limiter: { acquire(): Promise<void> };
	#botUserId: Promise<string> | null = null;

	constructor(options: PlaneClientOptions) {
		this.#origin = options.baseUrl.replace(/\/+$/, '');
		this.#root = `${this.#origin}/api/v1/workspaces/${encodeURIComponent(options.workspace)}`;
		this.#installationId = options.appInstallationId;
		this.#auth = options.auth;
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#limiter =
			options.limiter ?? new SlidingWindow({ max: PLANE_RATE_MAX, windowMs: PLANE_RATE_WINDOW_MS });
	}

	botUserId(): Promise<string> {
		if (this.#botUserId === null) {
			const pending = this.#loadBotUserId();
			// A failure is not memoised: the next call asks again.
			pending.catch(() => {
				if (this.#botUserId === pending) this.#botUserId = null;
			});
			this.#botUserId = pending;
		}
		return this.#botUserId;
	}

	async #loadBotUserId(): Promise<string> {
		const query = new URLSearchParams({ id: this.#installationId });
		const res = await this.#request(
			'GET',
			`/auth/o/app-installation/?${query.toString()}`,
			undefined,
			[],
			this.#origin,
		);
		// The endpoint answers one installation, as an object or a one-row array.
		return field(Array.isArray(res.body) ? res.body[0] : res.body, 'app_bot');
	}

	async listProjects(): Promise<ProjectSummary[]> {
		return (await this.#listAll('/projects/')).map((row) => ({
			id: field(row, 'id'),
			identifier: field(row, 'identifier'),
			name: field(row, 'name'),
		}));
	}

	async listStates(projectId: string): Promise<StateSummary[]> {
		return (await this.#listAll(`/projects/${projectId}/states/`)).map((row) => ({
			id: field(row, 'id'),
			name: field(row, 'name'),
			group: field(row, 'group'),
		}));
	}

	async listMembers(): Promise<MemberSummary[]> {
		return (await this.#listAll('/members/')).map((row) => ({
			id: field(row, 'id'),
			displayName: field(row, 'display_name'),
		}));
	}

	async getWorkItem(projectId: string, workItemId: string): Promise<WorkItem> {
		const res = await this.#request('GET', `/projects/${projectId}/work-items/${workItemId}/`);
		return workItem(res.body);
	}

	async getWorkItemByKey(key: string): Promise<WorkItem | null> {
		const res = await this.#request(
			'GET',
			`/work-items/${encodeURIComponent(key)}/`,
			undefined,
			[404],
		);
		return res.status === 404 ? null : workItem(res.body);
	}

	async getWorkItemModules(
		projectId: string,
		workItemId: string,
		moduleIds: readonly string[],
	): Promise<string[]> {
		const found: string[] = [];
		for (const moduleId of moduleIds) {
			const rows = await this.#listAll(`/projects/${projectId}/modules/${moduleId}/module-issues/`);
			// The rows name the work item by id (probe 2026-10-22); `issue` / `issue_id` are the relation spellings.
			if (rows.some((row) => [row.id, row.issue, row.issue_id].includes(workItemId))) {
				found.push(moduleId);
			}
		}
		return found;
	}

	async getComment(
		projectId: string,
		workItemId: string,
		commentId: string,
	): Promise<CommentDetail> {
		const res = await this.#request(
			'GET',
			`/projects/${projectId}/work-items/${workItemId}/comments/${commentId}/`,
		);
		return {
			id: field(res.body, 'id'),
			html: field(res.body, 'comment_html'),
			actorId: field(res.body, 'actor'),
			externalSource: optString(res.body, 'external_source'),
			externalId: optString(res.body, 'external_id'),
		};
	}

	async findWorkItemByExternalId(
		projectId: string,
		source: string,
		externalId: string,
	): Promise<{ id: string } | null> {
		const query = new URLSearchParams({ external_id: externalId, external_source: source });
		const res = await this.#request(
			'GET',
			`/projects/${projectId}/work-items/?${query.toString()}`,
			undefined,
			[404],
		);
		return res.status === 404 ? null : { id: field(res.body, 'id') };
	}

	createWorkItem(projectId: string, item: NewWorkItem): Promise<Upsert> {
		return this.#upsert(`/projects/${projectId}/work-items/`, item);
	}

	async findCommentByExternalId(
		projectId: string,
		workItemId: string,
		source: string,
		externalId: string,
	): Promise<{ id: string } | null> {
		const rows = await this.#listAll(`/projects/${projectId}/work-items/${workItemId}/comments/`);
		const found = rows.find(
			(row) => row.external_source === source && row.external_id === externalId,
		);
		return found ? { id: field(found, 'id') } : null;
	}

	createComment(projectId: string, workItemId: string, comment: NewComment): Promise<Upsert> {
		return this.#upsert(`/projects/${projectId}/work-items/${workItemId}/comments/`, comment);
	}

	async createRunActivity(runId: string, body: string): Promise<void> {
		await this.#request('POST', `/runs/${encodeURIComponent(runId)}/activities/`, {
			type: 'response',
			content: { type: 'response', body },
		});
	}

	async #upsert(path: string, body: unknown): Promise<Upsert> {
		const res = await this.#request('POST', path, body, [409]);
		return { id: field(res.body, 'id'), created: res.status !== 409 };
	}

	/** Follows Plane's cursor pages (`next_page_results` / `next_cursor`); a bare array is the whole list. */
	async #listAll(path: string): Promise<Rec[]> {
		const out: Rec[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			const query = new URLSearchParams({ per_page: PAGE_SIZE });
			if (cursor !== null) query.set('cursor', cursor);
			const res = await this.#request('GET', `${path}?${query.toString()}`);
			if (Array.isArray(res.body)) return [...out, ...res.body.filter(isRecord)];
			if (!isRecord(res.body) || !Array.isArray(res.body.results)) {
				throw new Error(`Plane GET ${path}: unexpected list shape`);
			}
			out.push(...res.body.results.filter(isRecord));
			if (res.body.next_page_results !== true || typeof res.body.next_cursor !== 'string')
				return out;
			cursor = res.body.next_cursor;
		}
		throw new Error(`Plane GET ${path}: more than ${MAX_PAGES} pages`);
	}

	/** `root` is the workspace API root unless the call lives elsewhere (the installation lookup). */
	async #request(
		method: string,
		path: string,
		body?: unknown,
		allowed: readonly number[] = [],
		root: string = this.#root,
	): Promise<{ status: number; body: unknown }> {
		const cleanPath = path.split('?')[0] as string;
		for (let attempt = 0; ; attempt++) {
			// Waiting for a slot happens before the per-call timeout starts: a queued request never times out unsent.
			await this.#limiter.acquire();
			const res = await this.#fetch(`${root}${path}`, {
				method,
				headers: {
					...(await this.#auth.headers()),
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
			const text = await res.text();
			// An expired bot token (10 h): drop it and retry once with a fresh one.
			if (res.status === 401 && attempt === 0) {
				this.#auth.invalidate();
				continue;
			}
			if (!res.ok && !allowed.includes(res.status))
				throw new PlaneApiError(res.status, method, cleanPath);
			let parsed: unknown = null;
			if (text !== '') {
				try {
					parsed = JSON.parse(text);
				} catch {
					// An expected non-2xx (404 from a proxy page) may be HTML; a 2xx must be JSON.
					if (res.ok) throw new Error(`Plane ${method} ${cleanPath}: response is not JSON`);
				}
			}
			return { status: res.status, body: parsed };
		}
	}
}

function field(value: unknown, key: string): string {
	const found = isRecord(value) ? value[key] : undefined;
	if (typeof found !== 'string' || found === '')
		throw new Error(`Plane response: no string field "${key}"`);
	return found;
}

function optString(value: unknown, key: string): string | null {
	const found = isRecord(value) ? value[key] : undefined;
	return typeof found === 'string' && found !== '' ? found : null;
}

function workItem(value: unknown): WorkItem {
	const row = isRecord(value) ? value : {};
	const sequenceId = row.sequence_id;
	if (typeof sequenceId !== 'number')
		throw new Error('Plane response: no number field "sequence_id"');
	return {
		id: field(row, 'id'),
		projectId: field(row, 'project'),
		sequenceId,
		name: field(row, 'name'),
		stateId: field(row, 'state'),
		assignees: Array.isArray(row.assignees)
			? row.assignees.filter((a): a is string => typeof a === 'string')
			: [],
		priority: field(row, 'priority'),
		descriptionHtml: optString(row, 'description_html'),
	};
}
