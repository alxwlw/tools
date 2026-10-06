import { isRecord } from "./payload.ts";

export type Priority = "urgent" | "high" | "medium" | "low" | "none";

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

/** `created: false` — Plane answered 409: an object with this external_id already exists, and `id` is that object. */
export type Upsert = { id: string; created: boolean };

export type WorkItemRef = { id: string; project: string; state: string };
export type CommentSummary = { id: string; external_id: string | null; created_at: string };
export type StateSummary = { id: string; group: string; default: boolean };
export type LabelSummary = { id: string; name: string };

/**
 * The Plane calls plane-hooks makes — spec «Контракт с API Plane», verified by
 * scripts/probe-plane.ts. Project-scoped calls take the project id explicitly.
 */
export interface PlaneApi {
	createWorkItem(projectId: string, item: NewWorkItem): Promise<Upsert>;
	findWorkItemByExternalId(projectId: string, source: string, externalId: string): Promise<{ id: string } | null>;
	getWorkItem(projectId: string, workItemId: string): Promise<WorkItemRef>;
	setWorkItemState(projectId: string, workItemId: string, stateId: string): Promise<void>;
	createComment(projectId: string, workItemId: string, comment: NewComment): Promise<Upsert>;
	listComments(projectId: string, workItemId: string): Promise<CommentSummary[]>;
	/** `key` is `OPS-12`; null when Plane answers 404. */
	getWorkItemByKey(key: string): Promise<WorkItemRef | null>;
	listProjectIdentifiers(): Promise<string[]>;
	listStates(projectId: string): Promise<StateSummary[]>;
	listLabels(projectId: string): Promise<LabelSummary[]>;
	createLabel(projectId: string, name: string): Promise<LabelSummary>;
}

/** A non-2xx answer the call did not expect. Carries no response body: bodies can echo payload data into logs. */
export class PlaneApiError extends Error {
	override name = "PlaneApiError";

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
	apiKey: string;
	timeoutMs?: number;
	fetch?: Fetch;
};

const PAGE_SIZE = "100";
const MAX_PAGES = 50;
const LABEL_COLOR = "#d9534f";

export class PlaneClient implements PlaneApi {
	readonly #root: string;
	readonly #apiKey: string;
	readonly #timeoutMs: number;
	readonly #fetch: Fetch;

	constructor(options: PlaneClientOptions) {
		this.#root = `${options.baseUrl.replace(/\/+$/, "")}/api/v1/workspaces/${encodeURIComponent(options.workspace)}`;
		this.#apiKey = options.apiKey;
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
	}

	createWorkItem(projectId: string, item: NewWorkItem): Promise<Upsert> {
		return this.#upsert(`/projects/${projectId}/work-items/`, item);
	}

	async findWorkItemByExternalId(projectId: string, source: string, externalId: string): Promise<{ id: string } | null> {
		const query = new URLSearchParams({ external_id: externalId, external_source: source });
		const res = await this.#request("GET", `/projects/${projectId}/work-items/?${query}`, undefined, [404]);
		return res.status === 404 ? null : { id: field(res.body, "id") };
	}

	async getWorkItem(projectId: string, workItemId: string): Promise<WorkItemRef> {
		const res = await this.#request("GET", `/projects/${projectId}/work-items/${workItemId}/`);
		return workItemRef(res.body);
	}

	async setWorkItemState(projectId: string, workItemId: string, stateId: string): Promise<void> {
		await this.#request("PATCH", `/projects/${projectId}/work-items/${workItemId}/`, { state: stateId });
	}

	createComment(projectId: string, workItemId: string, comment: NewComment): Promise<Upsert> {
		return this.#upsert(`/projects/${projectId}/work-items/${workItemId}/comments/`, comment);
	}

	async listComments(projectId: string, workItemId: string): Promise<CommentSummary[]> {
		const rows = await this.#listAll(`/projects/${projectId}/work-items/${workItemId}/comments/`);
		return rows.map((row) => ({
			id: field(row, "id"),
			external_id: typeof row.external_id === "string" && row.external_id !== "" ? row.external_id : null,
			created_at: field(row, "created_at"),
		}));
	}

	async getWorkItemByKey(key: string): Promise<WorkItemRef | null> {
		const res = await this.#request("GET", `/work-items/${encodeURIComponent(key)}/`, undefined, [404]);
		return res.status === 404 ? null : workItemRef(res.body);
	}

	async listProjectIdentifiers(): Promise<string[]> {
		return (await this.#listAll("/projects/")).map((row) => field(row, "identifier"));
	}

	async listStates(projectId: string): Promise<StateSummary[]> {
		return (await this.#listAll(`/projects/${projectId}/states/`)).map((row) => ({
			id: field(row, "id"),
			group: field(row, "group"),
			default: row.default === true,
		}));
	}

	async listLabels(projectId: string): Promise<LabelSummary[]> {
		return (await this.#listAll(`/projects/${projectId}/labels/`)).map((row) => ({
			id: field(row, "id"),
			name: field(row, "name"),
		}));
	}

	async createLabel(projectId: string, name: string): Promise<LabelSummary> {
		const res = await this.#request("POST", `/projects/${projectId}/labels/`, { name, color: LABEL_COLOR });
		return { id: field(res.body, "id"), name: field(res.body, "name") };
	}

	async #upsert(path: string, body: unknown): Promise<Upsert> {
		const res = await this.#request("POST", path, body, [409]);
		return { id: field(res.body, "id"), created: res.status !== 409 };
	}

	/** Follows Plane's cursor pages (`next_page_results` / `next_cursor`); a bare array is the whole list. */
	async #listAll(path: string): Promise<Record<string, unknown>[]> {
		const out: Record<string, unknown>[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			const query = new URLSearchParams({ per_page: PAGE_SIZE });
			if (cursor !== null) query.set("cursor", cursor);
			const res = await this.#request("GET", `${path}?${query}`);
			if (Array.isArray(res.body)) return [...out, ...res.body.filter(isRecord)];
			if (!isRecord(res.body) || !Array.isArray(res.body.results)) {
				throw new Error(`Plane GET ${path}: unexpected list shape`);
			}
			out.push(...res.body.results.filter(isRecord));
			if (res.body.next_page_results !== true || typeof res.body.next_cursor !== "string") return out;
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
		const res = await this.#fetch(`${this.#root}${path}`, {
			method,
			headers: { "X-API-Key": this.#apiKey, "Content-Type": "application/json", Accept: "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		const text = await res.text();
		const cleanPath = path.split("?")[0] as string;
		if (!res.ok && !allowed.includes(res.status)) throw new PlaneApiError(res.status, method, cleanPath);
		let parsed: unknown = null;
		if (text !== "") {
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
	if (typeof found !== "string" || found === "") throw new Error(`Plane response: no string field "${key}"`);
	return found;
}

function workItemRef(value: unknown): WorkItemRef {
	return { id: field(value, "id"), project: field(value, "project"), state: field(value, "state") };
}
