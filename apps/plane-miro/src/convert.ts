import { boardLink, cardFor, fieldsHash, linkTitle } from './card.ts';
import { esc, truncate } from './html.ts';
import type { Log } from './log.ts';
import {
	type Connector,
	MiroApiError,
	type MiroItem,
	MiroNotConnected,
	type Place,
} from './miro/rest.ts';
import { plainText } from './miro/text.ts';
import type { WorkItem } from './plane/client.ts';
import { embedBlock } from './plane/embed.ts';
import type { TenantRuntime } from './runtime.ts';
import type { Store } from './store.ts';
import { ttl } from './ttl.ts';

/** Item types that carry text a work item can be made of. */
export const CONVERTIBLE: readonly string[] = ['sticky_note', 'card', 'shape', 'text'];
/** Only these two have tags in Miro. */
const TAGGED: readonly string[] = ['sticky_note', 'card'];
export const MAX_ITEMS = 50;
export const CARD_WIDTH = 320;
const DEFAULT_WIDTH = 200;
const GAP = 40;
const NAME_MAX = 255;
const SOURCE = 'miro';

/** To the right of the item: x + (width ?? 200) / 2 + 40 + CARD_WIDTH / 2, same y and parent. */
export function besidePlace(item: MiroItem): Place {
	return {
		x: item.x + (item.width ?? DEFAULT_WIDTH) / 2 + GAP + CARD_WIDTH / 2,
		y: item.y,
		parentId: item.parentId,
	};
}

/**
 * `board_no_access`: createAppCard answered 403 — probe: a Free board beyond the team's three is view-only,
 * `insufficientPermissions`. `already_linked`: the sticker is a source of another work item, or its external id
 * belongs to an item Plane hides from reads (archived, draft, triage). `not_found`: no such sticker; the bind target
 * does not exist or is in another project; or the work item vanished before the re-read after the card.
 * `miro_failed` also covers a card deleted on the board while the item was converted (the retry places a new one).
 * `unknown_project`: the sticker's recorded work item is in a project the tenant hides — the request-level answer
 * to a hidden project, given per item.
 */
export type ItemError =
	| 'not_found'
	| 'unsupported_type'
	| 'empty_text'
	| 'already_linked'
	| 'unknown_project'
	| 'board_no_access'
	| 'plane_failed'
	| 'miro_failed';
export type ItemResult =
	| { itemId: string; ok: true; key: string; cardId: string }
	| { itemId: string; ok: false; error: ItemError };
export type ConvertRequest = {
	boardId: string;
	boardName: string;
	projectId: string;
	author: string;
	itemIds: readonly string[];
};
export type BindRequest = {
	boardId: string;
	boardName: string;
	itemId: string;
	workItemId: string;
	projectId: string;
	author: string;
};

/** One item's failure. `detail` is the cause's message (client errors carry method, route and status, never a body). */
class ItemFailure extends Error {
	override name = 'ItemFailure';
	readonly detail: string | undefined;

	constructor(
		readonly code: ItemError,
		cause?: unknown,
	) {
		super(code);
		this.detail = cause instanceof Error ? cause.message : undefined;
	}
}

const plane = async <T>(run: () => Promise<T>): Promise<T> => {
	try {
		return await run();
	} catch (error) {
		throw new ItemFailure('plane_failed', error);
	}
};

/** MiroNotConnected is not an item's fault: it passes through and ends the request. */
const miro = async <T>(
	run: () => Promise<T>,
	onForbidden: ItemError = 'miro_failed',
): Promise<T> => {
	try {
		return await run();
	} catch (error) {
		if (error instanceof MiroNotConnected) throw error;
		throw new ItemFailure(
			error instanceof MiroApiError && error.status === 403 ? onForbidden : 'miro_failed',
			error,
		);
	}
};

type Mode =
	| { kind: 'convert'; projectId: string }
	| { kind: 'bind'; projectId: string; workItemId: string };
type Ctx = {
	rt: TenantRuntime;
	store: Store;
	log: Log;
	boardId: string;
	boardName: string;
	author: string;
	/** The board's connectors, listed once per request (a failed listing is retried by the next item). */
	connectors: () => Promise<Connector[]>;
};

/** Runs `run` after every earlier call with the same key has settled, so a double click cannot make two cards. */
const tails = new Map<string, Promise<void>>();
function exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
	const previous = tails.get(key) ?? Promise.resolve();
	const result = previous.then(run);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	tails.set(key, tail);
	void tail.then(() => {
		if (tails.get(key) === tail) tails.delete(key);
	});
	return result;
}

/** Items with a conversion running or queued; empty when idle. */
export const lockedItems = (): number => tails.size;

function ctxOf(
	rt: TenantRuntime,
	store: Store,
	log: Log,
	req: { boardId: string; boardName: string; author: string },
): Ctx {
	return {
		rt,
		store,
		log,
		boardId: req.boardId,
		boardName: req.boardName,
		author: req.author,
		connectors: ttl(() => rt.miro.listConnectors(req.boardId), Number.POSITIVE_INFINITY),
	};
}

export async function convertItems(
	rt: TenantRuntime,
	store: Store,
	req: ConvertRequest,
	log: Log,
): Promise<ItemResult[]> {
	const ctx = ctxOf(rt, store, log, req);
	const out: ItemResult[] = [];
	for (const itemId of req.itemIds)
		out.push(await processItem(ctx, itemId, { kind: 'convert', projectId: req.projectId }));
	return out;
}

export function bindItem(
	rt: TenantRuntime,
	store: Store,
	req: BindRequest,
	log: Log,
): Promise<ItemResult> {
	return processItem(ctxOf(rt, store, log, req), req.itemId, {
		kind: 'bind',
		projectId: req.projectId,
		workItemId: req.workItemId,
	});
}

async function processItem(ctx: Ctx, itemId: string, mode: Mode): Promise<ItemResult> {
	const { rt, boardId } = ctx;
	const where = { tenant: rt.tenant.id, board: boardId, item: itemId };
	try {
		const done = await exclusive(`${where.tenant}\n${boardId}\n${itemId}`, () =>
			attempt(ctx, itemId, mode),
		);
		ctx.log({ event: 'convert.item', ...where, ok: true, key: done.key });
		return { itemId, ok: true, ...done };
	} catch (error) {
		if (!(error instanceof ItemFailure)) throw error;
		ctx.log({
			event: 'convert.item',
			...where,
			ok: false,
			error: error.code,
			...(error.detail === undefined ? {} : { detail: error.detail }),
		});
		return { itemId, ok: false, error: error.code };
	}
}

/** The steps of one item in order; every step skips what an earlier run already did. */
async function attempt(
	ctx: Ctx,
	itemId: string,
	mode: Mode,
): Promise<{ key: string; cardId: string }> {
	const { rt, store, boardId } = ctx;
	const tenant = rt.tenant;

	// 1. The item.
	const item = await miro(() => rt.miro.getItem(boardId, itemId));
	if (item === null) throw new ItemFailure('not_found');
	if (!CONVERTIBLE.includes(item.type)) throw new ItemFailure('unsupported_type');
	const text = plainText(item.html);
	if (mode.kind === 'convert' && text === '') throw new ItemFailure('empty_text');
	const lines = text === '' ? [] : text.split('\n');

	// 2. The work item: the recorded source, a bound one, or a new one.
	const {
		workItem,
		key,
		cardId: recordedCard,
	} = await resolveWorkItem(ctx, itemId, item, lines, mode);
	const { id: workItemId, projectId } = workItem;

	// 3. The card, unless a live one is recorded (a card row deleted after Miro answered 404 is not live).
	let cardId = recordedCard;
	if (cardId !== null && store.findCard(boardId, cardId) === null) cardId = null;
	if (cardId === null) {
		const card = await plane(() => cardFor(rt, workItem));
		const place = tenant.keepSource
			? besidePlace(item)
			: { x: item.x, y: item.y, parentId: item.parentId };
		cardId = await miro(() => rt.miro.createAppCard(boardId, card, place), 'board_no_access');
		store.setSourceCard(tenant.id, boardId, itemId, cardId);
		store.putCard({
			tenant: tenant.id,
			boardId,
			cardId,
			workItemId,
			projectId,
			fieldsHash: fieldsHash(card),
		});
	}
	const url = boardLink(boardId, cardId);

	// 4. The link in the work item.
	const title = await miro(() => linkTitle(rt, boardId, ctx.boardName, item.parentId));
	await plane(() => rt.plane.createLink(projectId, workItemId, { url, title }));

	// 5. The card as of a read made after its row exists: a sync of a change that landed while the card was being
	// made found no row to update. Every run checks it, so a retry also refreshes a card an earlier run left stale.
	const fresh = await plane(() => rt.plane.getWorkItem(projectId, workItemId));
	if (fresh === null) throw new ItemFailure('not_found');
	const shown = await plane(() => cardFor(rt, fresh));
	const hash = fieldsHash(shown);
	if (store.findCard(boardId, cardId)?.fieldsHash !== hash) {
		if ((await miro(() => rt.miro.updateAppCard(boardId, cardId, shown))) === 'gone') {
			// deleted on the board in the meantime: the retry places a new card
			store.deleteCard(boardId, cardId);
			throw new ItemFailure('miro_failed');
		}
		store.setFieldsHash(boardId, cardId, hash);
	}

	// 6. The Embed block, once per URL.
	if (tenant.embed) {
		const html = fresh.descriptionHtml ?? '';
		if (!html.includes(url))
			await plane(() => rt.plane.updateDescription(projectId, workItemId, html + embedBlock(url)));
	}

	// 7. Binding only: the sticker's text becomes a comment, once per sticker.
	if (mode.kind === 'bind' && lines.length > 0) {
		const externalId = `${boardId}:${itemId}`;
		const found = await plane(() =>
			rt.plane.findCommentByExternalId(projectId, workItemId, SOURCE, externalId),
		);
		if (found === null)
			await plane(() =>
				rt.plane.createComment(projectId, workItemId, {
					comment_html: `<p>С доски Miro (${esc(ctx.author)}):</p>${paragraphs(lines)}`,
					external_source: SOURCE,
					external_id: externalId,
				}),
			);
	}

	// 8. Without keepSource the arrows move to the card and the sticker goes, last.
	if (!tenant.keepSource) {
		const target = cardId;
		for (const c of await miro(ctx.connectors)) {
			if (c.startItemId === itemId)
				await miro(() => rt.miro.reattachConnector(boardId, c.id, 'start', target));
			if (c.endItemId === itemId)
				await miro(() => rt.miro.reattachConnector(boardId, c.id, 'end', target));
		}
		await miro(() => rt.miro.deleteItem(boardId, itemId));
	}
	return { key, cardId };
}

type Resolved = { workItem: WorkItem; key: string; cardId: string | null };

/**
 * The work item of a sticker. A recorded source wins, in its own project whatever the request names. When its
 * item reads as missing, a create in that project tells deleted (created: the source is overwritten, its card
 * link cleared) from hidden (409 on the recorded id: already_linked, source and card kept). Otherwise the item
 * is bound (bind) or created (convert): the source is recorded the moment Plane confirms the create, before any
 * read that can fail, so a retry cannot create a second item in another project. A source whose key is empty
 * gets its key computed.
 */
async function resolveWorkItem(
	ctx: Ctx,
	itemId: string,
	item: MiroItem,
	lines: readonly string[],
	mode: Mode,
): Promise<Resolved> {
	const { rt, store, boardId } = ctx;
	const tenantId = rt.tenant.id;
	const recordKey = async (workItem: WorkItem): Promise<string> => {
		const key = await plane(() => rt.keyOf(workItem.projectId, workItem.sequenceId));
		store.putSource(tenantId, boardId, itemId, {
			workItemId: workItem.id,
			projectId: workItem.projectId,
			key,
		});
		return key;
	};

	const recorded = store.getSource(tenantId, boardId, itemId);
	// A project hidden after the sticker was converted: its item is not read, and no card or link is made for it.
	if (recorded !== null && rt.isHidden(recorded.projectId)) throw new ItemFailure('unknown_project');
	if (recorded !== null && mode.kind === 'bind' && mode.workItemId !== recorded.workItemId)
		throw new ItemFailure('already_linked');
	if (recorded !== null) {
		const live = await plane(() => rt.plane.getWorkItem(recorded.projectId, recorded.workItemId));
		if (live !== null) {
			if (recorded.key !== '')
				return { workItem: live, key: recorded.key, cardId: recorded.cardId };
			return { workItem: live, key: await recordKey(live), cardId: null };
		}
	}

	if (mode.kind === 'bind') {
		const target = await plane(() => rt.plane.getWorkItem(mode.projectId, mode.workItemId));
		if (target === null) throw new ItemFailure('not_found');
		return { workItem: target, key: await recordKey(target), cardId: null };
	}
	// A recorded source whose item reads as missing stays in its project: Plane's external-id conflict is per
	// project, and an archived item must answer 409 there instead of getting a twin elsewhere.
	const projectId = recorded?.projectId ?? mode.projectId;
	const tags = TAGGED.includes(item.type)
		? await miro(() => rt.miro.getItemTags(boardId, itemId))
		: [];
	const created = await plane(() =>
		rt.plane.createWorkItem(projectId, {
			name: truncate(lines[0] as string, NAME_MAX),
			description_html: descriptionOf(lines, tags, ctx.author),
			external_source: SOURCE,
			external_id: `${boardId}:${itemId}`,
		}),
	);
	if (created.created)
		store.putSource(tenantId, boardId, itemId, { workItemId: created.id, projectId, key: '' });
	// The 409 names the recorded item: it is hidden, not gone. Decided by the 409's id, not by a second read,
	// which can see the item again after an un-archive in between; the source and its card stay as they are.
	if (!created.created && created.id === recorded?.workItemId)
		throw new ItemFailure('already_linked');
	const workItem = await plane(() => rt.plane.getWorkItem(projectId, created.id));
	// null after a 409: the external id belongs to an item Plane hides from reads (archived, draft, triage); when
	// that is the recorded item, the source and its card stay as they are
	if (workItem === null) throw new ItemFailure('already_linked');
	return { workItem, key: await recordKey(workItem), cardId: null };
}

const paragraphs = (lines: readonly string[]): string =>
	lines.map((line) => `<p>${esc(line)}</p>`).join('');

function descriptionOf(lines: readonly string[], tags: readonly string[], author: string): string {
	return (
		paragraphs(lines) +
		(tags.length === 0 ? '' : `<p>Теги Miro: ${esc(tags.join(', '))}</p>`) +
		`<p>С доски Miro: ${esc(author)}</p>`
	);
}
