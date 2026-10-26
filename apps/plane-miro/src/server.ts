// Adapted from apps/plane-discord/src/server.ts.
import type { Config, Tenant } from './config.ts';
import type { Log } from './log.ts';
import { oauthCallback, setupRedirect } from './plane/setup.ts';
import {
	BadDelivery,
	deliveryWorkspace,
	parsePlaneDelivery,
	type PlaneEvent,
	verifyPlaneSignature,
} from './plane/webhook.ts';
import type { Store } from './store.ts';

export const MAX_PLANE_BODY = 4 * 1024 * 1024;

export type ServerDeps = {
	tenantsByWorkspace: ReadonlyMap<string, Tenant>;
	store: Store;
	enqueue: (event: PlaneEvent) => void;
	/** GET /plane/setup and /plane/oauth/callback; absent → 404. */
	config?: Config;
	/** GET /miro/setup and /miro/oauth/callback; absent → 404. */
	miroOauth?: (req: Request, url: URL) => Promise<Response>;
	/** /miro/api/* (the front's API); absent → 404. */
	api?: (req: Request, url: URL) => Promise<Response>;
	/** Pages for Miro: /miro/app, /miro/panel, /miro/card, /miro/assets/*; null → 404. */
	web?: (url: URL) => Response | null;
	log: Log;
	now?: () => number;
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

/**
 * Every POST /plane/webhook is answered 200, accepted or not: a non-2xx makes Plane count a failure
 * and disable the webhook after five (design §5). What cannot be accepted is logged with level error.
 */
export function createHandler(deps: ServerDeps): (req: Request) => Promise<Response> {
	const now = deps.now ?? Date.now;
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
		const tenant = workspaceId === null ? undefined : deps.tenantsByWorkspace.get(workspaceId);
		if (!tenant) return rejected('unknown_workspace', { workspaceId: workspaceId?.slice(0, 64) });
		if (!verifyPlaneSignature(tenant.webhookSecret, req.headers.get('x-plane-signature'), bytes))
			return rejected('bad_signature', { tenant: tenant.id });
		deps.store.touchEvent(tenant.id, now());
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
		if (!deps.store.claim(`plane:${tenant.id}:${event.eventKey}`, now())) {
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

	// A hook that throws is a 500 with no error text (it may quote a token or a request body).
	async function guarded(
		route: string,
		run: () => Promise<Response> | Response | null,
	): Promise<Response> {
		try {
			return (await run()) ?? new Response('not found', { status: 404 });
		} catch {
			log({ event: 'http.failed', level: 'error', route, reason: 'internal' });
			return new Response('internal error', { status: 500 });
		}
	}

	return async (req) => {
		const url = new URL(req.url);
		const path = url.pathname;
		if (path === '/healthz') return ok();
		if (
			deps.config !== undefined &&
			(path === '/plane/setup' || path === '/plane/oauth/callback')
		) {
			if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
			return path === '/plane/setup' ? setupRedirect(deps.config, url) : oauthCallback(url, log);
		}
		const { miroOauth, api, web } = deps;
		if (miroOauth !== undefined && (path === '/miro/setup' || path === '/miro/oauth/callback'))
			return guarded('miro_oauth', () => miroOauth(req, url));
		if (api !== undefined && path.startsWith('/miro/api/'))
			return guarded('api', () => api(req, url));
		if (
			web !== undefined &&
			(path === '/miro/app' ||
				path === '/miro/panel' ||
				path === '/miro/card' ||
				path.startsWith('/miro/assets/'))
		) {
			if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
			return guarded('web', () => web(url));
		}
		if (path !== '/plane/webhook') return new Response('not found', { status: 404 });
		if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
		try {
			return await webhook(req);
		} catch {
			// Never leak the error text: it may quote the delivery.
			return rejected('internal');
		}
	};
}
