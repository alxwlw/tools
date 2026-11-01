// Adapted from apps/plane-miro/src/plane/webhook.ts.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A delivery only says which work item to re-read: the item is parsed from REST, never from the body
 * (the body carries `state` as an object, REST as a UUID). The relation's second item gets its own delivery.
 */
export type PlaneEvent =
	| {
			kind: 'item.touched';
			tenant: string;
			eventKey: string;
			projectId: string | null;
			workItemIds: string[];
	  }
	| { kind: 'item.deleted'; tenant: string; eventKey: string; workItemId: string };

/** A verified delivery that does not have the documented shape. Messages name fields, never values. */
export class BadDelivery extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/** workspace_id of a delivery, read before verification only to pick the tenant; null for non-JSON. */
export function deliveryWorkspace(raw: string): string | null {
	const body = parseJson(raw);
	return isObj(body) && typeof body.workspace_id === 'string' ? body.workspace_id : null;
}

const SIGNATURE = /^[0-9a-f]{64}$/i;

/** HMAC-SHA256 hex of the raw body, timing-safe; malformed or missing signature → false. */
export function verifyPlaneSignature(
	secret: string,
	signatureHex: string | null,
	raw: Uint8Array,
): boolean {
	if (signatureHex === null || !SIGNATURE.test(signatureHex)) return false;
	const expected = createHmac('sha256', secret).update(raw).digest();
	return timingSafeEqual(expected, Buffer.from(signatureHex, 'hex'));
}

function str(obj: Obj, key: string, where: string): string {
	const v = obj[key];
	if (typeof v !== 'string' || v === '') throw new BadDelivery(`${where}.${key} is not a string`);
	return v;
}

function obj(parent: Obj, key: string, where: string): Obj {
	const v = parent[key];
	if (!isObj(v)) throw new BadDelivery(`${where}.${key} is not an object`);
	return v;
}

const digest = (text: string): string =>
	createHash('sha256').update(text).digest('hex').slice(0, 32);

/**
 * A verified delivery → event; null for what the service ignores (comments, other entities, other actions).
 * The signed body is authoritative: the unsigned x-plane-event header is not consulted.
 * Probe findings (design §10): a relation has no event of its own. Adding one arrives as issue/updated,
 * removing one as issue/deleted with data = {id} and activity.field naming the relation — the item lives.
 * Only activity.field "issue" is a real deletion.
 */
export function parsePlaneDelivery(
	tenant: string,
	headers: Headers,
	raw: string,
): PlaneEvent | null {
	const body = parseJson(raw);
	if (!isObj(body)) throw new BadDelivery('body is not an object');
	const { event, action } = body;
	if (typeof event !== 'string' || typeof action !== 'string')
		throw new BadDelivery('event or action is not a string');
	// Everything the service ignores is decided before the shape of data is demanded.
	if (event !== 'issue') return null;
	if (action !== 'created' && action !== 'updated' && action !== 'deleted') return null;

	const activity = obj(body, 'activity', 'body');
	const field = activity.field;
	if (field !== null && typeof field !== 'string')
		throw new BadDelivery('activity.field is not a string');
	const data = obj(body, 'data', 'body');
	const id = str(data, 'id', 'data');

	if (action === 'deleted') {
		if (field === 'issue')
			return { kind: 'item.deleted', tenant, eventKey: `issue.deleted:${id}`, workItemId: id };
		// A relation (or link, module…) removed: data holds only the id. The body has no timestamp, so the
		// key is the delivery id, else the body itself: a retry is a duplicate, a second removal is not.
		const unique = headers.get('x-plane-delivery') ?? digest(raw);
		return {
			kind: 'item.touched',
			tenant,
			eventKey: `issue.touched:${id}:${field ?? ''}:${unique}`,
			projectId: null,
			workItemIds: [id],
		};
	}
	return {
		kind: 'item.touched',
		tenant,
		eventKey: `issue.touched:${id}:${field ?? ''}:${str(data, 'last_activity_at', 'data')}`,
		projectId: str(data, 'project', 'data'),
		workItemIds: [id],
	};
}
