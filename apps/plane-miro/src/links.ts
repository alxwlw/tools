import { boardLink, cardFor, fieldsHash, linkTitle } from './card.ts';
import { besidePlace } from './convert.ts';
import type { Log } from './log.ts';
import { findMiroLinks, type MiroLink } from './miro/link.ts';
import { MiroNotConnected } from './miro/rest.ts';
import type { WorkItem } from './plane/client.ts';
import type { PlaneEvent } from './plane/webhook.ts';
import type { TenantRuntime } from './runtime.ts';
import type { Store } from './store.ts';

type Commented = Extract<PlaneEvent, { kind: 'comment.created' }>;
type Linked = Extract<PlaneEvent, { kind: 'link.created' }>;

/** Shared checks of both events; the work item of the event, or null when nothing is to be done. */
async function eligible(
	rt: TenantRuntime,
	event: Commented | Linked,
	links: readonly MiroLink[],
): Promise<WorkItem | null> {
	// The bot's own links come back as events with the bot as actor.
	if (event.actorId === (await rt.plane.botUserId())) return null;
	if (rt.isHidden(event.projectId)) return null;
	if (links.length === 0) return null;
	return rt.plane.getWorkItem(event.projectId, event.workItemId);
}

async function placeAll(
	rt: TenantRuntime,
	store: Store,
	event: Commented | Linked,
	links: readonly MiroLink[],
	log: Log,
): Promise<void> {
	const workItem = await eligible(rt, event, links);
	if (workItem === null) return;
	for (const link of links) await placeCardForLink(rt, store, workItem, link, log);
}

export function handleCommentLinks(
	rt: TenantRuntime,
	store: Store,
	event: Commented,
	log: Log,
): Promise<void> {
	return placeAll(
		rt,
		store,
		event,
		event.commentHtml === null ? [] : findMiroLinks(event.commentHtml),
		log,
	);
}

/** A link added to the work item's «Links» field (probe: the app webhook carries it). */
export function handleLinkCreated(
	rt: TenantRuntime,
	store: Store,
	event: Linked,
	log: Log,
): Promise<void> {
	return placeAll(rt, store, event, findMiroLinks(event.url), log);
}

/**
 * One board link → one card of the work item on that board. A card already there is not duplicated, but its
 * link is still ensured: a retry after a failed createLink must not end on «card exists» with no link.
 */
export async function placeCardForLink(
	rt: TenantRuntime,
	store: Store,
	workItem: WorkItem,
	link: MiroLink,
	log: Log,
): Promise<void> {
	try {
		const board = await rt.miro.getBoard(link.boardId);
		if (board === null) {
			log({
				event: 'link.board_no_access',
				level: 'warn',
				tenant: rt.tenant.id,
				boardId: link.boardId,
			});
			return;
		}
		const item = link.itemId === null ? null : await rt.miro.getItem(link.boardId, link.itemId);
		const existing = store.cardOnBoard(rt.tenant.id, workItem.id, link.boardId);
		let cardId: string;
		if (existing !== null) cardId = existing.cardId;
		else {
			const card = await cardFor(rt, workItem);
			const place = item === null ? { x: 0, y: 0, parentId: null } : besidePlace(item);
			cardId = await rt.miro.createAppCard(link.boardId, card, place);
			store.putCard({
				tenant: rt.tenant.id,
				boardId: link.boardId,
				cardId,
				workItemId: workItem.id,
				projectId: workItem.projectId,
				fieldsHash: fieldsHash(card),
			});
		}
		const frameId = item === null ? null : item.type === 'frame' ? item.id : item.parentId;
		const title = await linkTitle(rt, link.boardId, board.name, frameId);
		await rt.plane.createLink(workItem.projectId, workItem.id, {
			url: boardLink(link.boardId, cardId),
			title,
		});
		log({ event: 'link.card_placed', tenant: rt.tenant.id, boardId: link.boardId, cardId });
	} catch (error) {
		if (error instanceof MiroNotConnected) {
			log({ event: 'miro.not_connected', level: 'error', tenant: rt.tenant.id });
			return;
		}
		// Retryable errors (isRetryable) go to the queue as they are.
		throw error;
	}
}
