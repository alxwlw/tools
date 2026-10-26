import type { Config } from './config.ts';
import { bindItem, convertItems, MAX_ITEMS } from './convert.ts';
import type { Log } from './log.ts';
import { verifyIdToken } from './miro/jwt.ts';
import { MiroApiError, MiroNotConnected } from './miro/rest.ts';
import { PlaneAuthError } from './plane/auth.ts';
import { PlaneApiError, type SearchHit } from './plane/client.ts';
import type { TenantRuntime } from './runtime.ts';
import { readBounded } from './server.ts';
import type { Store } from './store.ts';

export type ApiDeps = {
	config: Config;
	runtimes: ReadonlyMap<string, TenantRuntime>; // by tenant id
	store: Store;
	log: Log;
	nowSec?: () => number;
};

const PREFIX = '/miro/api/';
const BODY_MAX = 64 * 1024;
const SEARCH_MAX = 20;
const QUERY_MAX = 100;
const AUTHOR_MAX = 100;
const DEFAULT_AUTHOR = 'участник Miro';
const BOARD_ID = /^[A-Za-z0-9_=-]{1,64}$/;
const ITEM_ID = /^\d{1,24}$/;
const WORK_ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WORK_ITEM_KEY = /^[A-Za-z][A-Za-z0-9]{0,11}-\d{1,9}$/;
const METHODS: Record<string, string> = {
	projects: 'GET',
	search: 'GET',
	card: 'GET',
	convert: 'POST',
	bind: 'POST',
};

const reply = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	});

/** An answer decided while reading the request. */
class Reject extends Error {
	override name = 'Reject';

	constructor(
		readonly status: number,
		readonly code: string,
	) {
		super(code);
	}
}
const badRequest = () => new Reject(400, 'bad_request');

type Body = Record<string, unknown>;

async function readJson(req: Request): Promise<Body> {
	const bytes = await readBounded(req, BODY_MAX);
	if (bytes === null) throw new Reject(413, 'too_large');
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		// Not JSON: handled as a body without fields.
	}
	// Anything but an object has no fields, and a missing field is a bad_request in the checks that follow.
	return parsed instanceof Object ? (parsed as Body) : {};
}

function text(value: unknown, pattern: RegExp): string {
	if (typeof value !== 'string' || !pattern.test(value)) throw badRequest();
	return value;
}

function author(value: unknown): string {
	if (typeof value !== 'string') throw badRequest();
	const trimmed = value.trim();
	if (Array.from(trimmed).length > AUTHOR_MAX) throw badRequest();
	return trimmed === '' ? DEFAULT_AUTHOR : trimmed;
}

function itemIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ITEMS) throw badRequest();
	const ids = value.map((id) => text(id, ITEM_ID));
	if (new Set(ids).size !== ids.length) throw badRequest();
	return ids;
}

/** The front's API: every call carries the id token of the Miro user and acts on that Miro team's tenant. */
export function createApi(deps: ApiDeps): (req: Request, url: URL) => Promise<Response> {
	const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));

	/** The board must be visible to the service account and the project one the tenant offers. */
	async function boardAndProject(rt: TenantRuntime, boardId: string, projectId: unknown) {
		const id = text(projectId, /^.{1,64}$/);
		const offered = (list: { id: string }[]) => list.some((p) => p.id === id);
		if (!offered(await rt.projects()) && !offered(await rt.projects({ refresh: true })))
			throw new Reject(400, 'unknown_project');
		const board = await rt.miro.getBoard(boardId);
		if (board === null) throw new Reject(409, 'board_no_access');
		return { projectId: id, boardName: board.name };
	}

	async function projects(rt: TenantRuntime): Promise<Response> {
		return reply(200, { projects: await rt.projects(), keepSource: rt.tenant.keepSource });
	}

	async function search(rt: TenantRuntime, url: URL): Promise<Response> {
		const q = (url.searchParams.get('q') ?? '').trim();
		if (q === '' || Array.from(q).length > QUERY_MAX) throw badRequest();
		const visible = new Set((await rt.projects()).map((p) => p.id));
		let hits: SearchHit[];
		if (WORK_ITEM_KEY.test(q)) {
			const key = q.toUpperCase();
			const found = await rt.plane.getWorkItemByKey(key);
			hits =
				found === null ? [] : [{ id: found.id, projectId: found.projectId, key, name: found.name }];
		} else {
			hits = await rt.plane.searchWorkItems(q);
		}
		return reply(200, { items: hits.filter((h) => visible.has(h.projectId)).slice(0, SEARCH_MAX) });
	}

	async function convert(rt: TenantRuntime, req: Request): Promise<Response> {
		const body = await readJson(req);
		const boardId = text(body.boardId, BOARD_ID);
		const who = author(body.author);
		const ids = itemIds(body.itemIds);
		const { projectId, boardName } = await boardAndProject(rt, boardId, body.projectId);
		const results = await convertItems(
			rt,
			deps.store,
			{ boardId, boardName, projectId, author: who, itemIds: ids },
			deps.log,
		);
		return reply(200, { results });
	}

	async function bind(rt: TenantRuntime, req: Request): Promise<Response> {
		const body = await readJson(req);
		const boardId = text(body.boardId, BOARD_ID);
		const itemId = text(body.itemId, ITEM_ID);
		const workItemId = text(body.workItemId, WORK_ITEM_ID);
		const who = author(body.author);
		const { projectId, boardName } = await boardAndProject(rt, boardId, body.projectId);
		const result = await bindItem(
			rt,
			deps.store,
			{ boardId, boardName, itemId, workItemId, projectId, author: who },
			deps.log,
		);
		return reply(200, { result });
	}

	async function card(rt: TenantRuntime, url: URL): Promise<Response> {
		const row = deps.store.findCard(
			text(url.searchParams.get('board'), BOARD_ID),
			text(url.searchParams.get('item'), ITEM_ID),
		);
		const unknown = new Reject(404, 'unknown_card');
		if (row === null || row.tenant !== rt.tenant.id || rt.isHidden(row.projectId)) throw unknown;
		const workItem = await rt.plane.getWorkItem(row.projectId, row.workItemId);
		if (workItem === null) throw unknown;
		const [key, state, assignees] = await Promise.all([
			rt.keyOf(workItem.projectId, workItem.sequenceId),
			rt.state(workItem.projectId, workItem.stateId),
			rt.memberNames(workItem.assignees),
		]);
		return reply(200, {
			key,
			name: workItem.name,
			state: state?.name ?? '—',
			assignees,
			url: `${deps.config.planeUrl}/${rt.tenant.workspace}/browse/${key}/`,
		});
	}

	return async (req, url) => {
		const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
		const identity =
			token === undefined
				? null
				: verifyIdToken(token, {
						clientId: deps.config.miro.clientId,
						clientSecret: deps.config.miro.clientSecret,
						nowSec: nowSec(),
					});
		if (identity === null) return reply(401, { error: 'unauthorized' });
		const rt = [...deps.runtimes.values()].find((r) => r.tenant.miroTeamId === identity.teamId);
		if (rt === undefined) {
			deps.log({ event: 'api.unknown_team', team: identity.teamId });
			return reply(403, { error: 'unknown_team' });
		}
		const route = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : '';
		const method = Object.hasOwn(METHODS, route) ? METHODS[route] : undefined;
		if (method === undefined) return reply(404, { error: 'not_found' });
		if (req.method !== method) return reply(405, { error: 'method_not_allowed' });
		try {
			switch (route) {
				case 'projects':
					return await projects(rt);
				case 'search':
					return await search(rt, url);
				case 'card':
					return await card(rt, url);
				case 'convert':
					return await convert(rt, req);
				default:
					return await bind(rt, req);
			}
		} catch (error) {
			if (error instanceof Reject) {
				deps.log({ event: 'api.rejected', tenant: rt.tenant.id, route, error: error.code });
				return reply(error.status, { error: error.code });
			}
			if (error instanceof MiroNotConnected) return reply(503, { error: 'miro_not_connected' });
			const code =
				error instanceof MiroApiError
					? 'miro_failed'
					: error instanceof PlaneApiError || error instanceof PlaneAuthError
						? 'plane_failed'
						: null;
			if (code === null) throw error;
			deps.log({
				event: 'api.failed',
				level: 'error',
				tenant: rt.tenant.id,
				route,
				error: code,
				detail: (error as Error).message,
			});
			return reply(502, { error: code });
		}
	};
}
