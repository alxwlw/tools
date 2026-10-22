import type { Tenant } from './config.ts';
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
	tenantsByWorkspace: ReadonlyMap<string, Tenant>;
	store: Store;
	enqueue: (event: PlaneEvent) => void;
	log: Log;
	now?: () => number;
};

const ok = () => new Response('ok', { status: 200 });

/** Reads at most MAX_PLANE_BODY bytes; null when the body is larger (the stream is cancelled). */
async function readBounded(req: Request): Promise<Uint8Array | null> {
	const declared = Number(req.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > MAX_PLANE_BODY) return null;
	if (!req.body) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	// Leaving the loop early cancels the stream.
	for await (const chunk of req.body as AsyncIterable<Uint8Array>) {
		size += chunk.byteLength;
		if (size > MAX_PLANE_BODY) return null;
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
	const rejected = (reason: string, extra: Record<string, string | undefined> = {}) => {
		deps.log({ event: 'plane.rejected', level: 'error', reason, ...extra });
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
			deps.log({ event: 'plane.ignored', tenant: tenant.id });
			return ok();
		}
		if (!deps.store.claim(`plane:${tenant.id}:${event.eventKey}`, now())) {
			deps.log({
				event: 'plane.duplicate',
				tenant: tenant.id,
				kind: event.kind,
				eventKey: event.eventKey,
			});
			return ok();
		}
		deps.enqueue(event);
		deps.log({
			event: 'plane.accepted',
			tenant: tenant.id,
			kind: event.kind,
			eventKey: event.eventKey,
			ms: now() - started,
		});
		return ok();
	}

	return async (req) => {
		const path = new URL(req.url).pathname;
		if (path === '/healthz') return ok();
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
