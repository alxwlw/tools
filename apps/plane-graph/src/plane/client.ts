// Adapted from apps/plane-miro/src/plane/client.ts.
import type { Fetch, PlaneAuth } from '@alxwlw/plane-app';

import type {
	Edge,
	ItemRow,
	LabelRow,
	ModuleRow,
	ProjectRow,
	StateGroup,
	StateRow,
} from '../contract.ts';
import { SlidingWindow } from '../rate.ts';

/** Reading Plane: everything the copy is built from. Implemented by PlaneClient and by test/fake-plane.ts. */
export interface PlaneReader {
	listProjects(): Promise<ProjectRow[]>;
	listStates(projectId: string): Promise<StateRow[]>;
	listLabels(projectId: string): Promise<LabelRow[]>;
	/** With `itemIds` read from the module's work items. */
	listModules(projectId: string): Promise<ModuleRow[]>;
	/** All pages. */
	listWorkItems(projectId: string): Promise<ItemRow[]>;
	/** 404 → null: the item is gone, or archived / draft, which Plane hides from this read. */
	getWorkItem(projectId: string, id: string): Promise<ItemRow | null>;
	getRelations(projectId: string, id: string): Promise<Edge[]>;
}

/**
 * A non-2xx answer the call did not expect, or status 0 for a transport failure or timeout.
 * Carries no response body: bodies can echo payload data into logs.
 */
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
	timeoutMs?: number;
	fetch?: Fetch;
	/** Every request waits here first; default — one SlidingWindow of PLANE_RATE_MAX per PLANE_RATE_WINDOW_MS. */
	limiter?: { acquire(): Promise<void> };
};

const PAGE_SIZE = '100';
/** As plane-hooks: ~1 % of the ~5000/min the bot token showed (design §10, decision 4). */
export const PLANE_RATE_MAX = 50;
export const PLANE_RATE_WINDOW_MS = 60_000;
const MAX_PAGES = 200;
export const DESCRIPTION_MAX = 4000;

const STATE_GROUPS: ReadonlySet<string> = new Set<StateGroup>([
	'backlog',
	'unstarted',
	'started',
	'completed',
	'cancelled',
	'triage',
]);

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The body of GET …/relations/: constant keys, values are arrays of work item ids (probe, design §10).
 * `blocked_by: [X]` → X blocks the item; `blocking: [Y]` → the item blocks Y; `relates_to` is symmetric, so the
 * pair is ordered by id. Every other key (duplicate, start_*, finish_*) is dropped. No duplicate edges.
 */
export function parseRelations(itemId: string, body: unknown): Edge[] {
	if (!isRecord(body)) throw new Error('Plane relations: unexpected shape');
	const list = (key: string): string[] => {
		const value = body[key];
		if (value === undefined) return [];
		if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v === ''))
			throw new Error(`Plane relations: "${key}" is not a list of ids`);
		return value as string[];
	};
	const edges = new Map<string, Edge>();
	const add = (edge: Edge) => edges.set(`${edge.type}|${edge.from}|${edge.to}`, edge);
	for (const other of list('blocked_by')) add({ from: other, to: itemId, type: 'blocks' });
	for (const other of list('blocking')) add({ from: itemId, to: other, type: 'blocks' });
	for (const other of list('relates_to')) {
		const [from, to] = itemId < other ? [itemId, other] : [other, itemId];
		add({ from, to, type: 'relates' });
	}
	return [...edges.values()];
}

export class PlaneClient implements PlaneReader {
	readonly #root: string;
	readonly #auth: PlaneAuth;
	readonly #timeoutMs: number;
	readonly #fetch: Fetch;
	readonly #limiter: { acquire(): Promise<void> };

	constructor(options: PlaneClientOptions) {
		const origin = options.baseUrl.replace(/\/+$/, '');
		this.#root = `${origin}/api/v1/workspaces/${encodeURIComponent(options.workspace)}`;
		this.#auth = options.auth;
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#limiter =
			options.limiter ?? new SlidingWindow({ max: PLANE_RATE_MAX, windowMs: PLANE_RATE_WINDOW_MS });
	}

	async listProjects(): Promise<ProjectRow[]> {
		return (await this.#listAll('/projects/')).map((row) => ({
			id: field(row, 'id'),
			identifier: field(row, 'identifier'),
			name: field(row, 'name'),
		}));
	}

	async listStates(projectId: string): Promise<StateRow[]> {
		return (await this.#listAll(`${projectPath(projectId)}/states/`)).map((row) => {
			const group = field(row, 'group');
			if (!STATE_GROUPS.has(group)) throw new Error('Plane response: unknown state group');
			return { id: field(row, 'id'), projectId, group: group as StateGroup };
		});
	}

	async listLabels(projectId: string): Promise<LabelRow[]> {
		return (await this.#listAll(`${projectPath(projectId)}/labels/`)).map((row) => ({
			id: field(row, 'id'),
			projectId,
			name: field(row, 'name'),
		}));
	}

	async listModules(projectId: string): Promise<ModuleRow[]> {
		const modules = await this.#listAll(`${projectPath(projectId)}/modules/`);
		const out: ModuleRow[] = [];
		// One request per module, in order: the limiter keeps the pace.
		for (const row of modules) {
			const id = field(row, 'id');
			const members = await this.#listAll(
				`${projectPath(projectId)}/modules/${encodeURIComponent(id)}/module-issues/`,
			);
			out.push({
				id,
				projectId,
				name: field(row, 'name'),
				itemIds: members.map((member) => field(member, 'id')),
			});
		}
		return out;
	}

	async listWorkItems(projectId: string): Promise<ItemRow[]> {
		return (await this.#listAll(`${projectPath(projectId)}/work-items/`)).map(itemRow);
	}

	async getWorkItem(projectId: string, id: string): Promise<ItemRow | null> {
		const res = await this.#request(
			'GET',
			`${projectPath(projectId)}/work-items/${encodeURIComponent(id)}/`,
			[404],
		);
		return res.status === 404 ? null : itemRow(res.body);
	}

	async getRelations(projectId: string, id: string): Promise<Edge[]> {
		const res = await this.#request(
			'GET',
			`${projectPath(projectId)}/work-items/${encodeURIComponent(id)}/relations/`,
		);
		return parseRelations(id, res.body);
	}

	/**
	 * Follows Plane's cursor pages. A page says whether another follows (`next_page_results`) and where
	 * (`next_cursor`, like "100:1:0"). Continuation was not observed live — the probed project fit in one
	 * page — so a cursor that repeats stops the walk with an error instead of looping.
	 */
	async #listAll(path: string): Promise<Rec[]> {
		const out: Rec[] = [];
		const seen = new Set<string>();
		let cursor: string | null = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			const query = new URLSearchParams({ per_page: PAGE_SIZE });
			if (cursor !== null) query.set('cursor', cursor);
			const res = await this.#request('GET', `${path}?${query.toString()}`);
			if (Array.isArray(res.body)) return [...out, ...res.body.filter(isRecord)];
			if (!isRecord(res.body) || !Array.isArray(res.body.results))
				throw new Error(`Plane GET ${path}: unexpected list shape`);
			out.push(...res.body.results.filter(isRecord));
			if (res.body.next_page_results !== true) return out;
			const next = res.body.next_cursor;
			if (typeof next !== 'string' || next === '' || seen.has(next))
				throw new Error(`Plane GET ${path}: pagination does not advance`);
			seen.add(next);
			cursor = next;
		}
		throw new Error(`Plane GET ${path}: more than ${MAX_PAGES} pages`);
	}

	async #request(
		method: string,
		path: string,
		allowed: readonly number[] = [],
	): Promise<{ status: number; body: unknown }> {
		const cleanPath = path.split('?')[0] as string;
		for (let attempt = 0; ; attempt++) {
			// Waiting for a slot happens before the per-call timeout starts: a queued request never times out unsent.
			await this.#limiter.acquire();
			const headers = { ...(await this.#auth.headers()), Accept: 'application/json' };
			let res: Response;
			let text: string;
			try {
				res = await this.#fetch(`${this.#root}${path}`, {
					method,
					headers,
					signal: AbortSignal.timeout(this.#timeoutMs),
				});
				text = await res.text();
			} catch {
				// A refused connection, a reset or a timeout: status 0.
				throw new PlaneApiError(0, method, cleanPath);
			}
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

const projectPath = (projectId: string): string => `/projects/${encodeURIComponent(projectId)}`;

function field(value: unknown, key: string): string {
	const found = isRecord(value) ? value[key] : undefined;
	if (typeof found !== 'string' || found === '')
		throw new Error(`Plane response: no string field "${key}"`);
	return found;
}

/** Plain text of a description: `description_stripped`, else the HTML without tags; at most DESCRIPTION_MAX characters. */
function descriptionOf(row: Rec): string {
	const stripped = row.description_stripped;
	let text =
		typeof stripped === 'string' && stripped !== ''
			? stripped
			: typeof row.description_html === 'string'
				? row.description_html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
				: '';
	text = text.trim();
	if (text.length <= DESCRIPTION_MAX) return text;
	// Do not cut a surrogate pair in half.
	const cut = text.charCodeAt(DESCRIPTION_MAX - 1);
	return text.slice(0, cut >= 0xd800 && cut <= 0xdbff ? DESCRIPTION_MAX - 1 : DESCRIPTION_MAX);
}

function itemRow(value: unknown): ItemRow {
	const row = isRecord(value) ? value : {};
	const sequenceId = row.sequence_id;
	if (typeof sequenceId !== 'number' || !Number.isSafeInteger(sequenceId) || sequenceId < 0)
		throw new Error('Plane response: no integer field "sequence_id"');
	const parent = row.parent;
	if (parent !== null && parent !== undefined && (typeof parent !== 'string' || parent === ''))
		throw new Error('Plane response: "parent" is not an id');
	if (!Array.isArray(row.labels) || row.labels.some((l) => typeof l !== 'string' || l === ''))
		throw new Error('Plane response: "labels" is not a list of ids');
	return {
		id: field(row, 'id'),
		projectId: field(row, 'project'),
		sequenceId,
		name: field(row, 'name'),
		description: descriptionOf(row),
		stateId: field(row, 'state'),
		parentId: parent ?? null,
		labelIds: row.labels as string[],
		createdAt: field(row, 'created_at'),
		updatedAt: field(row, 'updated_at'),
	};
}
