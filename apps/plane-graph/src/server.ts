// Adapted from apps/plane-miro/src/server.ts.
import { planeOauthCallback, planeSetupRedirect } from '@alxwlw/plane-app';

import { agentKeyOk, parseAgentRun, readKeyOk } from './access.ts';
import { type Config, PLANE_SCOPES, type TenantConfig } from './config.ts';
import type { AgentRunIn } from './contract.ts';
import { buildGraph, buildSnapshot } from './graph.ts';
import type { Log } from './log.ts';
import { graphPage, planeBlock } from './page.ts';
import {
	BadDelivery,
	deliveryWorkspace,
	parsePlaneDelivery,
	type PlaneEvent,
	verifyPlaneSignature,
} from './plane/webhook.ts';
import type { Store } from './store.ts';
import { createWeb, type WebAssets } from './web.ts';

export const MAX_PLANE_BODY = 4 * 1024 * 1024;
export const MAX_RUN_BODY = 1024 * 1024;

export type ServerDeps = {
	config: Config;
	store: Store;
	log: Log;
	now: () => number;
	enqueue: (event: PlaneEvent) => void;
	assets: WebAssets;
	/** true = a new run, false = a runId seen before. */
	acceptRun: (tenant: string, run: AgentRunIn) => Promise<boolean>;
};

const ok = () => new Response('ok', { status: 200 });

/** Reads at most `max` bytes (default MAX_PLANE_BODY); null when the body is larger (the stream is cancelled). */
export async function readBounded(
	req: Request,
	max: number = MAX_PLANE_BODY,
): Promise<Uint8Array | null> {
	const declared = Number(req.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > max) return null;
	if (!req.body) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	// Leaving the loop early cancels the stream.
	for await (const chunk of req.body as AsyncIterable<Uint8Array>) {
		size += chunk.byteLength;
		if (size > max) return null;
		chunks.push(chunk);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'x-content-type-options': 'nosniff',
			...headers,
		},
	});
const unauthorized = () => json({ error: 'unauthorized' }, 401);
const badRequest = (detail: string) => json({ error: 'bad_request', detail }, 400);

const TENANT_ROUTE =
	/^\/t\/([a-z][a-z0-9]{0,15})\/(graph|graph\.json|plane-block\.html|snapshot\.json|agent-runs)$/;

const text = (body: string, status: number): Response =>
	new Response(body, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
	});

/**
 * Every POST /plane/webhook is answered 200, accepted or not: a non-2xx makes Plane count a failure
 * and disable the webhook after five (design §5). What cannot be accepted is logged with level error.
 */
export function createHandler(deps: ServerDeps): (req: Request) => Promise<Response> {
	const { config, store, now } = deps;
	const byWorkspace = new Map<string, TenantConfig>();
	for (const tenant of config.tenants.values()) byWorkspace.set(tenant.workspaceId, tenant);
	// Logging is best-effort: a throwing sink (EPIPE on stdout) must not turn a delivery into a 5xx.
	const log: Log = (entry) => {
		try {
			deps.log(entry);
		} catch {
			// nothing else to do with a broken log
		}
	};
	const rejected = (reason: string, extra: Record<string, string | undefined> = {}) => {
		log({ event: 'plane.rejected', level: 'error', reason, ...extra });
		return ok();
	};

	async function webhook(req: Request): Promise<Response> {
		const started = now();
		const bytes = await readBounded(req);
		if (bytes === null) return rejected('too_large');
		const raw = new TextDecoder().decode(bytes);
		const workspaceId = deliveryWorkspace(raw);
		const tenant = workspaceId === null ? undefined : byWorkspace.get(workspaceId);
		if (!tenant) return rejected('unknown_workspace', { workspaceId: workspaceId?.slice(0, 64) });
		if (!verifyPlaneSignature(tenant.webhookSecret, req.headers.get('x-plane-signature'), bytes))
			return rejected('bad_signature', { tenant: tenant.id });
		store.touchEvent(tenant.id, now());
		let event: PlaneEvent | null;
		try {
			event = parsePlaneDelivery(tenant.id, req.headers, raw);
		} catch (error) {
			if (!(error instanceof BadDelivery)) throw error;
			return rejected('bad_payload', { tenant: tenant.id, detail: error.message });
		}
		if (event === null) {
			log({ event: 'plane.ignored', tenant: tenant.id });
			return ok();
		}
		if (!store.claim(`plane:${tenant.id}:${event.eventKey}`, now())) {
			log({
				event: 'plane.duplicate',
				tenant: tenant.id,
				kind: event.kind,
				eventKey: event.eventKey,
			});
			return ok();
		}
		deps.enqueue(event);
		log({
			event: 'plane.accepted',
			tenant: tenant.id,
			kind: event.kind,
			eventKey: event.eventKey,
			ms: now() - started,
		});
		return ok();
	}

	/** GET /plane/setup?tenant=<id> → 302 to the Plane consent screen; unknown tenant → 404. */
	function setup(url: URL): Response {
		const tenant = config.tenants.get(url.searchParams.get('tenant') ?? '');
		if (tenant === undefined) return text('not found', 404);
		return planeSetupRedirect({
			planeUrl: config.planeUrl,
			publicUrl: config.publicUrl,
			clientId: tenant.clientId,
			scopes: PLANE_SCOPES,
		});
	}

	const web = createWeb(deps.assets);

	/** Only failures are logged, by route and tenant: never the query string nor headers (they carry keys). */
	async function guarded(
		route: string,
		tenant: string,
		run: () => Promise<Response> | Response,
	): Promise<Response> {
		try {
			return await run();
		} catch {
			log({ event: 'http.failed', level: 'error', route, tenant, reason: 'internal' });
			return text('internal error', 500);
		}
	}

	function graph(tenant: TenantConfig, name: string): Response {
		const k = encodeURIComponent(tenant.readKey);
		const dataPath = `/t/${tenant.id}/graph.json?k=${k}`;
		const nowDate = new Date(now());
		if (name === 'graph.json') {
			const body = buildGraph(store.copy(tenant.id), {
				planeUrl: config.planeUrl,
				workspaceSlug: tenant.workspaceSlug,
				lastRun: store.lastRun(tenant.id),
				now: nowDate,
			});
			return json(body, 200, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
		}
		const html = (body: string, extra: Record<string, string> = {}) =>
			new Response(body, {
				status: 200,
				headers: {
					'content-type': 'text/html; charset=utf-8',
					'cache-control': 'no-store',
					'referrer-policy': 'no-referrer',
					'x-content-type-options': 'nosniff',
					...extra,
				},
			});
		if (name === 'graph')
			return html(graphPage({ scriptUrl: '/assets/graph.js', dataUrl: dataPath }));
		return html(
			planeBlock({
				scriptUrl: `${config.publicUrl}/assets/graph.js`,
				dataUrl: `${config.publicUrl}${dataPath}`,
			}),
			{ 'content-disposition': 'attachment; filename="plane-graph.html"' },
		);
	}

	function snapshot(tenant: TenantConfig): Response {
		const body = buildSnapshot(store.copy(tenant.id), {
			workspaceSlug: tenant.workspaceSlug,
			lastRun: store.lastRun(tenant.id),
			rejected: store.rejected(tenant.id),
			now: new Date(now()),
		});
		return json(body, 200, { 'cache-control': 'no-store' });
	}

	async function agentRun(tenant: TenantConfig, req: Request): Promise<Response> {
		const bytes = await readBounded(req, MAX_RUN_BODY);
		if (bytes === null) return badRequest('body');
		let body: unknown;
		try {
			body = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return badRequest('body');
		}
		const run = parseAgentRun(body);
		if ('error' in run) return badRequest(run.error);
		return json({ ok: true }, (await deps.acceptRun(tenant.id, run)) ? 201 : 200);
	}

	/** /t/<tenant>/<name>: unknown tenant → 404, wrong method → 405, wrong or missing key → 401. */
	function tenantRoute(
		tenantId: string,
		name: string,
		req: Request,
		url: URL,
	): Promise<Response> | Response {
		const tenant = config.tenants.get(tenantId);
		if (tenant === undefined) return text('not found', 404);
		const post = name === 'agent-runs';
		if (req.method !== (post ? 'POST' : 'GET')) return text('method not allowed', 405);
		const agent = post || name === 'snapshot.json';
		if (!(agent ? agentKeyOk(tenant, req) : readKeyOk(tenant, url))) return unauthorized();
		return guarded(name, tenant.id, () =>
			post ? agentRun(tenant, req) : agent ? snapshot(tenant) : graph(tenant, name),
		);
	}

	return async (req) => {
		const url = new URL(req.url);
		const path = url.pathname;
		if (path === '/healthz') return ok();
		const asset = web(url);
		if (asset !== null) {
			if (req.method !== 'GET') return text('method not allowed', 405);
			return asset;
		}
		const route = TENANT_ROUTE.exec(path);
		if (route !== null) return tenantRoute(route[1] as string, route[2] as string, req, url);
		if (path === '/plane/setup' || path === '/plane/oauth/callback') {
			if (req.method !== 'GET') return text('method not allowed', 405);
			return path === '/plane/setup' ? setup(url) : planeOauthCallback(url, log);
		}
		if (path !== '/plane/webhook') return text('not found', 404);
		if (req.method !== 'POST') return text('method not allowed', 405);
		try {
			return await webhook(req);
		} catch {
			// Never leak the error text: it may quote the delivery.
			return rejected('internal');
		}
	};
}
