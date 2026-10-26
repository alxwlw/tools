import { describe, expect, test } from 'bun:test';

import { cardFor, fieldsHash } from '../src/card.ts';
import { MiroApiError, MiroNotConnected } from '../src/miro/rest.ts';
import type { PlaneEvent } from '../src/plane/webhook.ts';
import { disableWorkItem, syncWorkItem } from '../src/sync.ts';
import { BOARD, world } from './world.ts';

const BOARD2 = 'uXjVb2=';
const item = {
	id: 'w1',
	projectId: 'p1',
	sequenceId: 7,
	name: 'Задача',
	stateId: 's-started',
	assignees: ['u1'],
};
const changed = (
	over: Partial<typeof item> = {},
): Extract<PlaneEvent, { kind: 'workitem.changed' }> => ({
	kind: 'workitem.changed',
	tenant: 'acme',
	eventKey: 'e1',
	item: { ...item, ...over },
});
const deleted: Extract<PlaneEvent, { kind: 'workitem.deleted' }> = {
	kind: 'workitem.deleted',
	tenant: 'acme',
	eventKey: 'e2',
	workItemId: 'w1',
};

/** Work item w1 with a card on each of two boards; the card ids are 900 (BOARD) and 901 (BOARD2). */
async function setup(projectId = 'p1') {
	const w = world();
	w.miro.addBoard(BOARD2, 'Вторая');
	const old = await cardFor(w.rt, { ...item, projectId, stateId: 's-backlog', assignees: [] });
	const place = { x: 0, y: 0, parentId: null };
	w.miro.boards.get(BOARD)?.cards.set('900', { card: old, place });
	w.miro.boards.get(BOARD2)?.cards.set('901', { card: old, place });
	for (const [boardId, cardId] of [
		[BOARD, '900'],
		[BOARD2, '901'],
	] as const)
		w.store.putCard({
			tenant: 'acme',
			boardId,
			cardId,
			workItemId: 'w1',
			projectId,
			fieldsHash: fieldsHash(old),
		});
	w.miro.calls.length = 0;
	return w;
}
const patches = (calls: readonly string[]) => calls.filter((c) => c === 'updateAppCard');
const ids = (w: Awaited<ReturnType<typeof setup>>) =>
	w.store.cardsOfItem('acme', 'w1').map((c) => c.cardId);

describe('syncWorkItem', () => {
	test('смена статуса → обновлены карточки задачи на двух досках', async () => {
		const w = await setup();
		await syncWorkItem(w.rt, w.store, changed(), w.log);
		expect(patches(w.miro.calls)).toHaveLength(2);
		for (const id of [BOARD, BOARD2])
			expect(w.miro.cardsOn(id)[0]?.card).toMatchObject({
				title: 'LAB-7 Задача',
				fields: [{ value: 'In Progress', fillColor: '#fff3bf' }, { value: 'Аня' }],
			});
		const expected = fieldsHash(await cardFor(w.rt, item));
		expect(w.store.cardsOfItem('acme', 'w1').map((c) => c.fieldsHash)).toEqual([
			expected,
			expected,
		]);
		expect(w.logs).toEqual([]);
	});

	test('та же доставка ещё раз → ни одного PATCH', async () => {
		const w = await setup();
		await syncWorkItem(w.rt, w.store, changed(), w.log);
		w.miro.calls.length = 0;
		await syncWorkItem(w.rt, w.store, changed(), w.log);
		expect(w.miro.calls).toEqual([]);
	});

	test('задача без карточек → ни одного вызова Plane и Miro', async () => {
		const w = world();
		await syncWorkItem(w.rt, w.store, changed(), w.log);
		expect(w.plane.calls).toEqual([]);
		expect(w.miro.calls).toEqual([]);
	});

	test('скрытый проект → ни одного вызова Plane и Miro, карточки на месте', async () => {
		const w = await setup('p-hidden');
		w.plane.calls.length = 0;
		await syncWorkItem(w.rt, w.store, changed({ projectId: 'p-hidden' }), w.log);
		expect(w.plane.calls).toEqual([]);
		expect(w.miro.calls).toEqual([]);
		expect(ids(w)).toEqual(['900', '901']);
	});

	test('карточку удалили руками (404) → связь удалена, вторая обновлена, исключения нет', async () => {
		const w = await setup();
		w.miro.boards.get(BOARD)?.cards.delete('900'); // the fake answers 'gone' for a missing card
		await syncWorkItem(w.rt, w.store, changed(), w.log);
		expect(ids(w)).toEqual(['901']);
		expect(w.miro.cardsOn(BOARD2)[0]?.card.fields[0]?.value).toBe('In Progress');
		expect(w.logs).toEqual([{ event: 'card.gone', tenant: 'acme', boardId: BOARD, cardId: '900' }]);
	});

	test('503 на одной карточке → вторая обновлена, затем ошибка; повтор трогает только первую', async () => {
		const w = await setup();
		const err = new MiroApiError(503, 'PATCH', '/v2/boards/{board}/app_cards/{id}');
		w.miro.failNext('updateAppCard', err);
		await expect(syncWorkItem(w.rt, w.store, changed(), w.log)).rejects.toBe(err);
		expect(patches(w.miro.calls)).toHaveLength(2);
		expect(w.miro.cardsOn(BOARD2)[0]?.card.fields[0]?.value).toBe('In Progress');
		expect(w.miro.cardsOn(BOARD)[0]?.card.fields[0]?.value).toBe('Backlog');
		w.miro.calls.length = 0;
		await syncWorkItem(w.rt, w.store, changed(), w.log);
		expect(patches(w.miro.calls)).toHaveLength(1);
		expect(w.store.cardsOfItem('acme', 'w1').map((c) => c.fieldsHash)).toEqual([
			fieldsHash(await cardFor(w.rt, item)),
			fieldsHash(await cardFor(w.rt, item)),
		]);
	});

	test('400 на одной карточке → лог card.update_failed со статусом, вторая обновлена, исключения нет', async () => {
		const w = await setup();
		w.miro.failNext('updateAppCard', new MiroApiError(400, 'PATCH', '/p'));
		await syncWorkItem(w.rt, w.store, changed(), w.log);
		expect(w.logs).toEqual([
			{
				event: 'card.update_failed',
				level: 'error',
				tenant: 'acme',
				boardId: BOARD,
				cardId: '900',
				status: 400,
			},
		]);
		expect(ids(w)).toEqual(['900', '901']);
		expect(w.store.findCard(BOARD, '900')?.fieldsHash).not.toBe(
			w.store.findCard(BOARD2, '901')?.fieldsHash,
		);
		expect(w.miro.cardsOn(BOARD2)[0]?.card.fields[0]?.value).toBe('In Progress');
	});

	test('обрыв сети (TypeError) на одной карточке → вторая обновлена, затем ошибка', async () => {
		const w = await setup();
		const err = new TypeError('fetch failed');
		w.miro.failNext('updateAppCard', err);
		await expect(syncWorkItem(w.rt, w.store, changed(), w.log)).rejects.toBe(err);
		expect(w.miro.cardsOn(BOARD2)[0]?.card.fields[0]?.value).toBe('In Progress');
		expect(w.logs).toEqual([]);
	});

	test('токена Miro нет → лог miro.not_connected, без исключения', async () => {
		const w = await setup();
		w.miro.failNext('updateAppCard', new MiroNotConnected());
		await syncWorkItem(w.rt, w.store, changed(), w.log);
		expect(w.logs).toEqual([{ event: 'miro.not_connected', level: 'error', tenant: 'acme' }]);
		expect(patches(w.miro.calls)).toHaveLength(1);
		expect(ids(w)).toEqual(['900', '901']);
	});

	test('непредвиденная ошибка (не повторяемая, не Miro 4xx) → летит наружу', async () => {
		const w = await setup();
		const err = new RangeError('bug');
		w.miro.failNext('updateAppCard', err);
		await expect(syncWorkItem(w.rt, w.store, changed(), w.log)).rejects.toBe(err);
	});

	test('проект не найден в Plane → ошибка cardFor летит наружу до обращения к Miro', async () => {
		const w = await setup();
		await expect(
			syncWorkItem(w.rt, w.store, changed({ projectId: 'p-nowhere' }), w.log),
		).rejects.toThrow();
		expect(w.miro.calls).toEqual([]);
	});
});

describe('disableWorkItem', () => {
	test('задача удалена → карточки disabled, связей нет', async () => {
		const w = await setup();
		await disableWorkItem(w.rt, w.store, deleted, w.log);
		expect(w.miro.cardsOn(BOARD)[0]?.card.status).toBe('disabled');
		expect(w.miro.cardsOn(BOARD2)[0]?.card.status).toBe('disabled');
		expect(ids(w)).toEqual([]);
	});

	test('скрытый проект не мешает: событие удаления без проекта отключает карточки', async () => {
		const w = await setup('p-hidden');
		await disableWorkItem(w.rt, w.store, deleted, w.log);
		expect(w.miro.cardsOn(BOARD)[0]?.card.status).toBe('disabled');
		expect(ids(w)).toEqual([]);
	});

	test('карточки на доске уже нет (404) → связь удалена, вторая отключена', async () => {
		const w = await setup();
		w.miro.boards.get(BOARD)?.cards.delete('900');
		await disableWorkItem(w.rt, w.store, deleted, w.log);
		expect(ids(w)).toEqual([]);
		expect(w.miro.cardsOn(BOARD2)[0]?.card.status).toBe('disabled');
	});

	test('503 на первой → связь остаётся, вторая отключена, затем ошибка; повтор доделывает первую', async () => {
		const w = await setup();
		const err = new MiroApiError(503, 'PATCH', '/p');
		w.miro.failNext('updateAppCard', err);
		await expect(disableWorkItem(w.rt, w.store, deleted, w.log)).rejects.toBe(err);
		expect(ids(w)).toEqual(['900']);
		expect(w.miro.cardsOn(BOARD2)[0]?.card.status).toBe('disabled');
		await disableWorkItem(w.rt, w.store, deleted, w.log);
		expect(w.miro.cardsOn(BOARD)[0]?.card.status).toBe('disabled');
		expect(ids(w)).toEqual([]);
	});

	test('400 на первой → card.update_failed и связь удалена, вторая отключена', async () => {
		const w = await setup();
		w.miro.failNext('updateAppCard', new MiroApiError(403, 'PATCH', '/p'));
		await disableWorkItem(w.rt, w.store, deleted, w.log);
		expect(w.logs).toEqual([
			{
				event: 'card.update_failed',
				level: 'error',
				tenant: 'acme',
				boardId: BOARD,
				cardId: '900',
				status: 403,
			},
		]);
		expect(ids(w)).toEqual([]);
		expect(w.miro.cardsOn(BOARD2)[0]?.card.status).toBe('disabled');
	});

	test('токена Miro нет → лог miro.not_connected, связи остаются, без исключения', async () => {
		const w = await setup();
		w.miro.failNext('updateAppCard', new MiroNotConnected());
		await disableWorkItem(w.rt, w.store, deleted, w.log);
		expect(w.logs).toEqual([{ event: 'miro.not_connected', level: 'error', tenant: 'acme' }]);
		expect(ids(w)).toEqual(['900', '901']);
	});
});
