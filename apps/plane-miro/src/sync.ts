import { cardFor, fieldsHash } from './card.ts';
import type { Log } from './log.ts';
import { MiroApiError, MiroNotConnected } from './miro/rest.ts';
import type { PlaneEvent } from './plane/webhook.ts';
import { isRetryable } from './queue.ts';
import type { TenantRuntime } from './runtime.ts';
import type { Store } from './store.ts';

type Changed = Extract<PlaneEvent, { kind: 'workitem.changed' }>;
type Deleted = Extract<PlaneEvent, { kind: 'workitem.deleted' }>;

/**
 * What to do with an error from one card: 'retry' (remember it, go on, throw the first at the end),
 * 'skip' (a non-retryable 4xx, logged), 'stop' (Miro is not connected, logged); anything else propagates.
 */
function classify(
	err: unknown,
	log: Log,
	event: Changed | Deleted,
	boardId: string,
	cardId: string,
): 'retry' | 'skip' | 'stop' {
	if (err instanceof MiroNotConnected) {
		log({ event: 'miro.not_connected', level: 'error', tenant: event.tenant });
		return 'stop';
	}
	if (err instanceof MiroApiError && isRetryable(err)) return 'retry';
	if (err instanceof MiroApiError) {
		log({
			event: 'card.update_failed',
			level: 'error',
			tenant: event.tenant,
			boardId,
			cardId,
			status: err.status,
		});
		return 'skip';
	}
	if (isRetryable(err)) return 'retry';
	throw err;
}

/** A Plane change of a work item: refresh its cards on every board; a card unchanged since the last write is skipped. */
export async function syncWorkItem(
	rt: TenantRuntime,
	store: Store,
	event: Changed,
	log: Log,
): Promise<void> {
	const { item } = event;
	const cards = store.cardsOfItem(event.tenant, item.id);
	if (cards.length === 0 || rt.isHidden(item.projectId)) return;
	const card = await cardFor(rt, item);
	const hash = fieldsHash(card);
	let first: Error | undefined;
	for (const row of cards) {
		if (row.fieldsHash === hash) continue;
		try {
			const result = await rt.miro.updateAppCard(row.boardId, row.cardId, card);
			if (result === 'gone') {
				store.deleteCard(row.boardId, row.cardId);
				log({ event: 'card.gone', tenant: event.tenant, boardId: row.boardId, cardId: row.cardId });
			} else store.setFieldsHash(row.boardId, row.cardId, hash);
		} catch (err) {
			const verdict = classify(err, log, event, row.boardId, row.cardId);
			if (verdict === 'stop') return;
			if (verdict === 'retry') first ??= asError(err);
		}
	}
	if (first !== undefined) throw first;
}

/** The work item is gone from Plane: mark its cards disabled and drop the links. */
export async function disableWorkItem(
	rt: TenantRuntime,
	store: Store,
	event: Deleted,
	log: Log,
): Promise<void> {
	let first: Error | undefined;
	for (const row of store.cardsOfItem(event.tenant, event.workItemId)) {
		try {
			await rt.miro.updateAppCard(row.boardId, row.cardId, { status: 'disabled' });
			store.deleteCard(row.boardId, row.cardId);
		} catch (err) {
			const verdict = classify(err, log, event, row.boardId, row.cardId);
			if (verdict === 'stop') return;
			if (verdict === 'retry') first ??= asError(err);
			// another 4xx: the item is gone, a retry cannot help
			else store.deleteCard(row.boardId, row.cardId);
		}
	}
	if (first !== undefined) throw first;
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));
