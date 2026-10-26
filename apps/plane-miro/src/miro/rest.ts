import type { Fetch } from '../plane/auth.ts';

export type MiroItem = {
	id: string;
	type: string;
	/** sticky_note, shape, text: data.content; card: data.title and data.description joined by <p>. As stored (HTML). */
	html: string;
	/** Relative to the parent frame's top-left when parentId is set, else to the board centre (Miro REST). */
	x: number;
	y: number;
	width: number | null;
	height: number | null;
	parentId: string | null;
};
export type CardField = { value: string; fillColor?: string; textColor?: string };
export type AppCardInput = { title: string; fields: CardField[]; status: 'connected' | 'disabled' };
export type Place = { x: number; y: number; parentId: string | null };
export type Connector = { id: string; startItemId: string | null; endItemId: string | null };

export interface MiroApi {
	/**
	 * 403 and 404 → null: the service account cannot see the board. Probe: a missing board is 404; a foreign *public*
	 * board is 200, so a non-null answer does not prove write access (createAppCard 403 is handled in Task 6).
	 */
	getBoard(boardId: string): Promise<{ id: string; name: string } | null>;
	/** 404 → null. */
	getItem(boardId: string, itemId: string): Promise<MiroItem | null>;
	/** 404 → null. */
	getFrameTitle(boardId: string, frameId: string): Promise<string | null>;
	/** GET /items/{id}/tags → {tags: [{id, type: 'tag', title, fillColor}]} → titles (probe). */
	getItemTags(boardId: string, itemId: string): Promise<string[]>;
	/** POST /v2/boards/{b}/app_cards → the new card id. */
	createAppCard(boardId: string, card: AppCardInput, place: Place): Promise<string>;
	/** PATCH with only the given fields under `data`; 404 → 'gone'. */
	updateAppCard(
		boardId: string,
		cardId: string,
		card: Partial<AppCardInput>,
	): Promise<'ok' | 'gone'>;
	/** Every page of GET /v2/boards/{b}/connectors (cursor). */
	listConnectors(boardId: string): Promise<Connector[]>;
	reattachConnector(
		boardId: string,
		connectorId: string,
		side: 'start' | 'end',
		itemId: string,
	): Promise<void>;
	/** 404 counts as done. */
	deleteItem(boardId: string, itemId: string): Promise<void>;
	/** GET /v1/oauth-token: 200 → true, 401 → false. */
	tokenValid(): Promise<boolean>;
}

/**
 * Carries the numeric `status` (`isRetryable` retries 0, 429 and 5xx); transport failure and timeout are status 0.
 * `path` is the route template with the board id replaced by `{board}`; the response body is never kept.
 */
export class MiroApiError extends Error {
	override name = 'MiroApiError';

	constructor(
		readonly status: number,
		readonly method: string,
		readonly path: string,
	) {
		super(`Miro ${method} ${path} → ${status}`);
	}
}

/** No service-account token is stored for the team yet. */
export class MiroNotConnected extends Error {
	override name = 'MiroNotConnected';

	constructor() {
		super('Miro service account is not connected');
	}
}

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const recOf = (v: unknown): Rec => (isRecord(v) ? v : {});
const strOf = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOf = (v: unknown): number | null =>
	typeof v === 'number' && Number.isFinite(v) ? v : null;

const enc = encodeURIComponent;
const PAGE_LIMIT = 50;
const MAX_PAGES = 200;
const OK = (status: number): boolean => status >= 200 && status < 300;

type Route = { path: string; label: string };
const boardRoute = (boardId: string, rest: string): Route => ({
	path: `/v2/boards/${enc(boardId)}${rest}`,
	label: `/v2/boards/{board}${rest}`,
});

function itemOf(raw: unknown): MiroItem {
	const o = recOf(raw);
	const data = recOf(o.data);
	const type = strOf(o.type) ?? '';
	let html = '';
	if (type === 'card' || type === 'app_card') {
		const title = strOf(data.title) ?? '';
		const description = strOf(data.description) ?? '';
		html = description === '' ? title : `${title}<p>${description}`;
	} else {
		html = strOf(data.content) ?? '';
	}
	const pos = recOf(o.position);
	const geo = recOf(o.geometry);
	return {
		id: strOf(o.id) ?? '',
		type,
		html,
		x: numOf(pos.x) ?? 0,
		y: numOf(pos.y) ?? 0,
		width: numOf(geo.width),
		height: numOf(geo.height),
		parentId: strOf(recOf(o.parent).id),
	};
}

export class MiroClient implements MiroApi {
	readonly #token: () => string | null;
	readonly #fetch: Fetch;
	readonly #timeoutMs: number;
	readonly #base: string;

	constructor(opts: {
		token: () => string | null;
		fetch?: Fetch;
		timeoutMs?: number;
		baseUrl?: string;
	}) {
		this.#token = opts.token;
		this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
		this.#timeoutMs = opts.timeoutMs ?? 10_000;
		this.#base = opts.baseUrl ?? 'https://api.miro.com';
	}

	async getBoard(boardId: string): Promise<{ id: string; name: string } | null> {
		const res = await this.#send('GET', boardRoute(boardId, ''));
		if (res.status === 403 || res.status === 404) return null;
		const o = recOf(this.#ok(res));
		return { id: strOf(o.id) ?? boardId, name: strOf(o.name) ?? '' };
	}

	async getItem(boardId: string, itemId: string): Promise<MiroItem | null> {
		const res = await this.#send('GET', boardRoute(boardId, `/items/${enc(itemId)}`));
		if (res.status === 404) return null;
		return itemOf(this.#ok(res));
	}

	async getFrameTitle(boardId: string, frameId: string): Promise<string | null> {
		const res = await this.#send('GET', boardRoute(boardId, `/frames/${enc(frameId)}`));
		if (res.status === 404) return null;
		return strOf(recOf(recOf(this.#ok(res)).data).title) ?? '';
	}

	async getItemTags(boardId: string, itemId: string): Promise<string[]> {
		const res = await this.#send('GET', boardRoute(boardId, `/items/${enc(itemId)}/tags`));
		const tags = recOf(this.#ok(res)).tags;
		if (!Array.isArray(tags)) return [];
		return tags.flatMap((t) => {
			const title = strOf(recOf(t).title);
			return title === null ? [] : [title];
		});
	}

	async createAppCard(boardId: string, card: AppCardInput, place: Place): Promise<string> {
		const route = boardRoute(boardId, '/app_cards');
		const res = await this.#send('POST', route, {
			data: { title: card.title, fields: card.fields, status: card.status },
			position: { x: place.x, y: place.y },
			...(place.parentId === null ? {} : { parent: { id: place.parentId } }),
		});
		const id = strOf(recOf(this.#ok(res)).id);
		if (id === null || id === '') throw new Error(`Miro POST ${route.label}: response has no id`);
		return id;
	}

	async updateAppCard(
		boardId: string,
		cardId: string,
		card: Partial<AppCardInput>,
	): Promise<'ok' | 'gone'> {
		const data: Partial<AppCardInput> = {};
		if (card.title !== undefined) data.title = card.title;
		if (card.fields !== undefined) data.fields = card.fields;
		if (card.status !== undefined) data.status = card.status;
		const res = await this.#send('PATCH', boardRoute(boardId, `/app_cards/${enc(cardId)}`), {
			data,
		});
		if (res.status === 404) return 'gone';
		this.#ok(res);
		return 'ok';
	}

	async listConnectors(boardId: string): Promise<Connector[]> {
		const out: Connector[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			const query: string = `?limit=${PAGE_LIMIT}${cursor === null ? '' : `&cursor=${enc(cursor)}`}`;
			const res = await this.#send('GET', boardRoute(boardId, `/connectors${query}`));
			const body = recOf(this.#ok(res));
			const rows = Array.isArray(body.data) ? body.data : [];
			for (const row of rows) {
				const r = recOf(row);
				const id = strOf(r.id);
				if (id === null) continue;
				out.push({
					id,
					startItemId: strOf(recOf(r.startItem).id),
					endItemId: strOf(recOf(r.endItem).id),
				});
			}
			const next = strOf(body.cursor);
			if (next === null || next === '' || next === cursor || rows.length === 0) return out;
			cursor = next;
		}
		return out;
	}

	async reattachConnector(
		boardId: string,
		connectorId: string,
		side: 'start' | 'end',
		itemId: string,
	): Promise<void> {
		const body = side === 'start' ? { startItem: { id: itemId } } : { endItem: { id: itemId } };
		this.#ok(
			await this.#send('PATCH', boardRoute(boardId, `/connectors/${enc(connectorId)}`), body),
		);
	}

	async deleteItem(boardId: string, itemId: string): Promise<void> {
		const res = await this.#send('DELETE', boardRoute(boardId, `/items/${enc(itemId)}`));
		if (res.status !== 404) this.#ok(res);
	}

	async tokenValid(): Promise<boolean> {
		const res = await this.#send('GET', { path: '/v1/oauth-token', label: '/v1/oauth-token' });
		if (res.status === 401) return false;
		this.#ok(res);
		return true;
	}

	/** The body of a 2xx reply; any other status throws. */
	#ok(res: Reply): unknown {
		if (!OK(res.status)) throw new MiroApiError(res.status, res.method, res.label);
		return res.body;
	}

	async #send(method: string, route: Route, body?: unknown): Promise<Reply> {
		const token = this.#token();
		if (token === null || token === '') throw new MiroNotConnected();
		let status: number;
		let text: string;
		try {
			const res = await this.#fetch(`${this.#base}${route.path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					accept: 'application/json',
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
			status = res.status;
			text = await res.text();
		} catch {
			throw new MiroApiError(0, method, route.label);
		}
		let parsed: unknown;
		try {
			parsed = text === '' ? undefined : JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		return { status, body: parsed, method, label: route.label };
	}
}

type Reply = { status: number; body: unknown; method: string; label: string };
