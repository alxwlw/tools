import type { PlaneAuth } from '@alxwlw/plane-app';

import { isRecord } from './payload.ts';
import { SlidingWindow } from './rate.ts';

export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

export type NewWorkItem = {
	name: string;
	description_html: string;
	priority: Priority;
	labels: string[];
	external_id: string;
	external_source: string;
};

export type NewComment = {
	comment_html: string;
	external_id: string;
	external_source: string;
};

export type NewRelease = {
	name: string;
	status: 'released';
	/** YYYY-MM-DD — what the Plane UI labels "Target date". */
	release_date: string;
	external_source: string;
	external_id: string;
};

/** `created: false` — Plane answered 409: an object with this external_id already exists, and `id` is that object. */
export type Upsert = { id: string; created: boolean };

/** `sequenceId` is the number in the key (`ENG-12` → 12). */
export type WorkItemRef = { id: string; project: string; state: string; sequenceId: number };
export type CommentSummary = {
	id: string;
	external_id: string | null;
	external_source: string | null;
	/** The comment text as Plane stores it; null when the list row carries none. */
	comment_html: string | null;
	created_at: string;
};
export type StateSummary = {
	id: string;
	name: string;
	group: string;
	sequence: number;
	default: boolean;
};
export type ProjectSummary = { id: string; identifier: string };
export type LinkSummary = { id: string; url: string };

/** Scopes of the "plane-hooks" Plane App registration. Plane exposes no releases scope to Apps, so none is requested. */
export const PLANE_HOOKS_SCOPES: readonly string[] = [
	'projects:read',
	'projects.work_items:read',
	'projects.work_items:write',
	'projects.work_items.comments:read',
	'projects.work_items.comments:write',
	'projects.work_items.links:read',
	'projects.work_items.links:write',
	'projects.states:read',
	'projects.labels:read',
	'projects.labels:write',
];

export type LabelSummary = { id: string; name: string };

/**
 * The Plane calls plane-hooks makes, verified by
 * scripts/probe-plane.ts. Project-scoped calls take the project id explicitly.
 * Releases are workspace-level: no project id.
 */
export interface PlaneApi {
	createWorkItem(projectId: string, item: NewWorkItem): Promise<Upsert>;
	findWorkItemByExternalId(
		projectId: string,
		source: string,
		externalId: string,
	): Promise<{ id: string } | null>;
	/** Plane hides an archived item from this read: 404. */
	getWorkItem(projectId: string, workItemId: string): Promise<WorkItemRef>;
	/** Plane answers 400 unless the item's state group is completed/cancelled. plane-hooks itself never archives. */
	archiveWorkItem(projectId: string, workItemId: string): Promise<void>;
	/** Plane answers 404 when the item is not archived. */
	unarchiveWorkItem(projectId: string, workItemId: string): Promise<void>;
	/** False for an id Plane does not know at all. */
	isWorkItemArchived(projectId: string, workItemId: string): Promise<boolean>;
	setWorkItemState(projectId: string, workItemId: string, stateId: string): Promise<void>;
	createComment(projectId: string, workItemId: string, comment: NewComment): Promise<Upsert>;
	listComments(projectId: string, workItemId: string): Promise<CommentSummary[]>;
	updateComment(
		projectId: string,
		workItemId: string,
		commentId: string,
		html: string,
	): Promise<void>;
	listLinks(projectId: string, workItemId: string): Promise<LinkSummary[]>;
	/** A duplicate URL (Plane answers 400 and the URL is already listed) is 'exists'; any other 400 throws. */
	createLink(
		projectId: string,
		workItemId: string,
		link: { url: string; title: string },
	): Promise<'created' | 'exists'>;
	listProjects(): Promise<ProjectSummary[]>;
	/** `key` is `OPS-12`; null when Plane answers 404. */
	getWorkItemByKey(key: string): Promise<WorkItemRef | null>;
	listStates(projectId: string): Promise<StateSummary[]>;
	listLabels(projectId: string): Promise<LabelSummary[]>;
	createLabel(projectId: string, name: string): Promise<LabelSummary>;
	/** Workspace-level. The list documents no external_id filter, so this scans every page. */
	findReleaseByExternalId(source: string, externalId: string): Promise<{ id: string } | null>;
	createRelease(release: NewRelease): Promise<Upsert>;
	updateReleaseChangelog(releaseId: string, html: string): Promise<void>;
	/** 0 ids — no request; more than RELEASE_ITEMS_MAX — RangeError before any request. */
	addReleaseWorkItems(releaseId: string, workItemIds: readonly string[]): Promise<void>;
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

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type PlaneClientOptions = {
	baseUrl: string;
	workspace: string;
	auth: PlaneAuth;
	timeoutMs?: number;
	fetch?: Fetch;
	/** Every request waits here first; default — one SlidingWindow of PLANE_RATE_MAX per PLANE_RATE_WINDOW_MS. */
	limiter?: { acquire(): Promise<void> };
};

const PAGE_SIZE = '100';
/** Plane's default API_KEY_RATE_LIMIT is 60/minute per key; 50 leaves room for whatever else uses the token. */
export const PLANE_RATE_MAX = 50;
export const PLANE_RATE_WINDOW_MS = 60_000;
const MAX_PAGES = 50;
const LABEL_COLOR = '#d9534f';
/** Plane takes at most this many work item ids in one attach call. */
export const RELEASE_ITEMS_MAX = 100;

export class PlaneClient implements PlaneApi {
	readonly #root: string;
	readonly #auth: PlaneAuth;
	readonly #timeoutMs: number;
	readonly #fetch: Fetch;
	readonly #limiter: { acquire(): Promise<void> };

	constructor(options: PlaneClientOptions) {
		this.#root = `${options.baseUrl.replace(/\/+$/, '')}/api/v1/workspaces/${encodeURIComponent(options.workspace)}`;
		this.#auth = options.auth;
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#limiter =
			options.limiter ?? new SlidingWindow({ max: PLANE_RATE_MAX, windowMs: PLANE_RATE_WINDOW_MS });
	}

	createWorkItem(projectId: string, item: NewWorkItem): Promise<Upsert> {
		return this.#upsert(`/projects/${projectId}/work-items/`, item);
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

	async getWorkItem(projectId: string, workItemId: string): Promise<WorkItemRef> {
		const res = await this.#request('GET', `/projects/${projectId}/work-items/${workItemId}/`);
		return workItemRef(res.body);
	}

	async archiveWorkItem(projectId: string, workItemId: string): Promise<void> {
		await this.#request('POST', `/projects/${projectId}/work-items/${workItemId}/archive/`);
	}

	async unarchiveWorkItem(projectId: string, workItemId: string): Promise<void> {
		await this.#request('DELETE', `/projects/${projectId}/work-items/${workItemId}/unarchive/`);
	}

	/**
	 * The detail read answers 404 for an archived item, and /archived-work-items/{id}/ answers 404
	 * even for one: only the archived list names it. So the list is scanned on a 404 only, and a
	 * project with more than MAX_PAGES pages of archived items throws here.
	 */
	async isWorkItemArchived(projectId: string, workItemId: string): Promise<boolean> {
		const res = await this.#request(
			'GET',
			`/projects/${projectId}/work-items/${workItemId}/`,
			undefined,
			[404],
		);
		if (res.status !== 404) return false;
		const archived = await this.#listAll(`/projects/${projectId}/archived-work-items/`);
		return archived.some((row) => row.id === workItemId);
	}

	async setWorkItemState(projectId: string, workItemId: string, stateId: string): Promise<void> {
		await this.#request('PATCH', `/projects/${projectId}/work-items/${workItemId}/`, {
			state: stateId,
		});
	}

	createComment(projectId: string, workItemId: string, comment: NewComment): Promise<Upsert> {
		return this.#upsert(`/projects/${projectId}/work-items/${workItemId}/comments/`, comment);
	}

	async listComments(projectId: string, workItemId: string): Promise<CommentSummary[]> {
		const rows = await this.#listAll(`/projects/${projectId}/work-items/${workItemId}/comments/`);
		return rows.map((row) => ({
			id: field(row, 'id'),
			external_id:
				typeof row.external_id === 'string' && row.external_id !== '' ? row.external_id : null,
			external_source: optionalString(row.external_source),
			comment_html: optionalString(row.comment_html),
			created_at: field(row, 'created_at'),
		}));
	}

	async updateComment(
		projectId: string,
		workItemId: string,
		commentId: string,
		html: string,
	): Promise<void> {
		await this.#request(
			'PATCH',
			`/projects/${projectId}/work-items/${workItemId}/comments/${commentId}/`,
			{ comment_html: html },
		);
	}

	async listLinks(projectId: string, workItemId: string): Promise<LinkSummary[]> {
		const rows = await this.#listAll(`/projects/${projectId}/work-items/${workItemId}/links/`);
		return rows.map((row) => ({ id: field(row, 'id'), url: field(row, 'url') }));
	}

	async createLink(
		projectId: string,
		workItemId: string,
		link: { url: string; title: string },
	): Promise<'created' | 'exists'> {
		const path = `/projects/${projectId}/work-items/${workItemId}/links/`;
		const res = await this.#request('POST', path, link, [400]);
		if (res.status !== 400) return 'created';
		// Plane answers 400 for a URL the work item already has, and for anything else it dislikes.
		const rows = await this.#listAll(path);
		if (rows.some((row) => row.url === link.url)) return 'exists';
		throw new PlaneApiError(400, 'POST', path);
	}

	async listProjects(): Promise<ProjectSummary[]> {
		return (await this.#listAll('/projects/')).map((row) => ({
			id: field(row, 'id'),
			identifier: field(row, 'identifier'),
		}));
	}

	async getWorkItemByKey(key: string): Promise<WorkItemRef | null> {
		const res = await this.#request(
			'GET',
			`/work-items/${encodeURIComponent(key)}/`,
			undefined,
			[404],
		);
		return res.status === 404 ? null : workItemRef(res.body);
	}

	async listStates(projectId: string): Promise<StateSummary[]> {
		return (await this.#listAll(`/projects/${projectId}/states/`)).map((row) => ({
			id: field(row, 'id'),
			name: field(row, 'name'),
			group: field(row, 'group'),
			sequence: numericField(row, 'sequence'),
			default: row.default === true,
		}));
	}

	async listLabels(projectId: string): Promise<LabelSummary[]> {
		return (await this.#listAll(`/projects/${projectId}/labels/`)).map((row) => ({
			id: field(row, 'id'),
			name: field(row, 'name'),
		}));
	}

	async createLabel(projectId: string, name: string): Promise<LabelSummary> {
		const res = await this.#request('POST', `/projects/${projectId}/labels/`, {
			name,
			color: LABEL_COLOR,
		});
		return { id: field(res.body, 'id'), name: field(res.body, 'name') };
	}

	async findReleaseByExternalId(
		source: string,
		externalId: string,
	): Promise<{ id: string } | null> {
		const found = (await this.#listAll('/releases/')).find(
			(row) => row.external_source === source && row.external_id === externalId,
		);
		return found ? { id: field(found, 'id') } : null;
	}

	createRelease(release: NewRelease): Promise<Upsert> {
		return this.#upsert('/releases/', release);
	}

	async updateReleaseChangelog(releaseId: string, html: string): Promise<void> {
		await this.#request('PATCH', `/releases/${releaseId}/changelog/`, { description_html: html });
	}

	async addReleaseWorkItems(releaseId: string, workItemIds: readonly string[]): Promise<void> {
		if (workItemIds.length === 0) return;
		if (workItemIds.length > RELEASE_ITEMS_MAX) {
			throw new RangeError(
				`at most ${RELEASE_ITEMS_MAX} work items per attach call, got ${workItemIds.length}`,
			);
		}
		await this.#request('POST', `/releases/${releaseId}/work-items/`, {
			work_item_ids: workItemIds,
		});
	}

	async #upsert(path: string, body: unknown): Promise<Upsert> {
		const res = await this.#request('POST', path, body, [409]);
		return { id: field(res.body, 'id'), created: res.status !== 409 };
	}

	/** Follows Plane's cursor pages (`next_page_results` / `next_cursor`); a bare array is the whole list. */
	async #listAll(path: string): Promise<Record<string, unknown>[]> {
		const out: Record<string, unknown>[] = [];
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

	async #request(
		method: string,
		path: string,
		body?: unknown,
		allowed: readonly number[] = [],
	): Promise<{ status: number; body: unknown }> {
		const url = `${this.#root}${path}`;
		let res: Response;
		// A 401 means the bot token was revoked or expired early: drop it and repeat the request once.
		for (let attempt = 0; ; attempt++) {
			// Waiting for a slot happens before the per-call timeout starts: a queued request never times out unsent.
			await this.#limiter.acquire();
			res = await this.#fetch(url, {
				method,
				headers: {
					...(await this.#auth.headers()),
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
			if (res.status !== 401 || attempt > 0) break;
			this.#auth.invalidate();
		}
		const text = await res.text();
		const cleanPath = path.split('?')[0] as string;
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

function field(value: unknown, key: string): string {
	const found = isRecord(value) ? value[key] : undefined;
	if (typeof found !== 'string' || found === '')
		throw new Error(`Plane response: no string field "${key}"`);
	return found;
}

function numberField(value: unknown, key: string): number {
	const found = isRecord(value) ? value[key] : undefined;
	if (typeof found !== 'number' || !Number.isFinite(found))
		throw new Error(`Plane response: no number field "${key}"`);
	return found;
}

/** A number, or a numeric string: a Plane instance (Commercial v3.3.0) sends a state's `sequence` as "15000". */
function numericField(value: unknown, key: string): number {
	const found = isRecord(value) ? value[key] : undefined;
	if (typeof found === 'string' && found.trim() !== '') {
		const parsed = Number(found);
		if (Number.isFinite(parsed)) return parsed;
	}
	return numberField(value, key);
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

function workItemRef(value: unknown): WorkItemRef {
	return {
		id: field(value, 'id'),
		project: field(value, 'project'),
		state: field(value, 'state'),
		sequenceId: numberField(value, 'sequence_id'),
	};
}
