// Adapted from apps/plane-miro/src/server.ts.
import { planeOauthCallback, planeSetupRedirect } from '@alxwlw/plane-app';

import { type Config, PLANE_SCOPES, type TenantConfig } from './config.ts';
import type { Log } from './log.ts';
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
	config: Config;
	store: Store;
	log: Log;
	now: () => number;
	enqueue: (event: PlaneEvent) => void;
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

	return async (req) => {
		const url = new URL(req.url);
		const path = url.pathname;
		if (path === '/healthz') return ok();
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
