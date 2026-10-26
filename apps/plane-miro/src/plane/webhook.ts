// Adapted from apps/plane-discord/src/plane/webhook.ts.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type WorkItemSnapshot = {
	id: string;
	projectId: string;
	sequenceId: number;
	name: string;
	stateId: string;
	assignees: string[];
};
export type PlaneEvent =
	| { kind: 'workitem.changed'; tenant: string; eventKey: string; item: WorkItemSnapshot }
	| { kind: 'workitem.deleted'; tenant: string; eventKey: string; workItemId: string }
	| {
			kind: 'comment.created';
			tenant: string;
			eventKey: string;
			actorId: string;
			projectId: string;
			workItemId: string;
			commentId: string;
			commentHtml: string | null;
	  }
	| {
			kind: 'link.created';
			tenant: string;
			eventKey: string;
			actorId: string;
			projectId: string;
			workItemId: string;
			url: string;
	  };

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

function htmlOrNull(v: unknown, where: string): string | null {
	if (v === null || v === undefined) return null;
	if (typeof v !== 'string') throw new BadDelivery(`${where} is not a string`);
	return v;
}

function ids(v: unknown, where: string, objects: boolean): string[] {
	if (!Array.isArray(v)) throw new BadDelivery(`${where} is not an array`);
	return (v as unknown[]).map((entry) => {
		const id = objects ? (isObj(entry) ? entry.id : undefined) : entry;
		if (typeof id !== 'string' || id === '') throw new BadDelivery(`${where} has a bad entry`);
		return id;
	});
}

function snapshot(data: Obj): WorkItemSnapshot {
	const sequenceId = data.sequence_id;
	if (typeof sequenceId !== 'number' || !Number.isSafeInteger(sequenceId) || sequenceId < 0)
		throw new BadDelivery('data.sequence_id is not an integer');
	return {
		id: str(data, 'id', 'data'),
		projectId: str(data, 'project', 'data'),
		sequenceId,
		name: str(data, 'name', 'data'),
		stateId: str(obj(data, 'state', 'data'), 'id', 'data.state'),
		assignees: ids(data.assignees, 'data.assignees', true),
	};
}

/** Link key part: a hash, so that neither the URL (often a capability URL) nor its length reaches a key or a log line. */
function linkDigest(identifier: unknown, url: string): string {
	const id = typeof identifier === 'string' ? identifier : '';
	return createHash('sha256').update(`${id}|${url}`).digest('hex').slice(0, 32);
}

// Fields of an issue/updated activity that the card shows. Plane sends one change as two deliveries,
// a "machine" twin (state_id, assignee_ids: the request keys) and a "human" twin (state, assignees);
// both are accepted, and the card writer writes only the fields that changed.
const CARD_FIELDS: ReadonlySet<string> = new Set([
	'name',
	'state',
	'state_id',
	'assignees',
	'assignee_ids',
]);

/**
 * A verified delivery → event; null for what the service ignores (other entities, other fields, archive).
 * The signed body is authoritative: the unsigned x-plane-event header is not consulted.
 * The event key comes from the content, not from x-plane-delivery or a body hash: Plane sends many
 * changes as two deliveries with different ids and bodies (design §10).
 */
export function parsePlaneDelivery(
	tenant: string,
	_headers: Headers,
	raw: string,
): PlaneEvent | null {
	const body = parseJson(raw);
	if (!isObj(body)) throw new BadDelivery('body is not an object');
	const { event, action } = body;
	if (typeof event !== 'string' || typeof action !== 'string')
		throw new BadDelivery('event or action is not a string');
	// Everything the service ignores is decided before the shape of data is demanded.
	if (event !== 'issue' && event !== 'issue_comment') return null;
	if (event === 'issue' && action === 'deleted') {
		// Probe 2026-10-26: one delivery, data = {id}, activity.field = "issue". Plane sends the removal of a link,
		// attachment, module, cycle or reaction the same way, with another field: those leave the work item alive.
		if (!isObj(body.activity) || body.activity.field !== 'issue') return null;
		const workItemId = str(obj(body, 'data', 'body'), 'id', 'data');
		return {
			kind: 'workitem.deleted',
			tenant,
			eventKey: `issue.deleted:${workItemId}`,
			workItemId,
		};
	}
	if (action !== 'created' && action !== 'updated') return null;
	const activity = obj(body, 'activity', 'body');
	const field = activity.field;
	if (field !== null && typeof field !== 'string')
		throw new BadDelivery('activity.field is not a string');

	if (event === 'issue_comment') {
		if (action !== 'created') return null;
		const data = obj(body, 'data', 'body');
		const commentId = str(data, 'id', 'data');
		return {
			kind: 'comment.created',
			tenant,
			eventKey: `comment.created:${commentId}`,
			actorId: str(obj(activity, 'actor', 'activity'), 'id', 'activity.actor'),
			projectId: str(data, 'project', 'data'),
			workItemId: str(data, 'issue', 'data'),
			commentId,
			commentHtml: htmlOrNull(data.comment_html, 'data.comment_html'),
		};
	}

	if (action === 'created') {
		// A link added to a work item arrives as issue/created with field "link", the URL in new_value;
		// a link put by the bot through the API arrives the same way, with the bot as actor.
		if (field !== 'link') return null;
		const data = obj(body, 'data', 'body');
		const workItemId = str(data, 'id', 'data');
		const url = str(activity, 'new_value', 'activity');
		return {
			kind: 'link.created',
			tenant,
			eventKey: `issue.link:${workItemId}:${linkDigest(activity.new_identifier, url)}`,
			actorId: str(obj(activity, 'actor', 'activity'), 'id', 'activity.actor'),
			projectId: str(data, 'project', 'data'),
			workItemId,
			url,
		};
	}

	if (field === null || !CARD_FIELDS.has(field)) return null;
	const data = obj(body, 'data', 'body');
	const item = snapshot(data);
	return {
		kind: 'workitem.changed',
		tenant,
		eventKey: `issue.changed:${item.id}:${field}:${str(data, 'last_activity_at', 'data')}`,
		item,
	};
}
