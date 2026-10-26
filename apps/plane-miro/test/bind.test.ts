import { describe, expect, test } from 'bun:test';

import { boardLink } from '../src/card.ts';
import { bindItem, type BindRequest, convertItems } from '../src/convert.ts';
import { MiroApiError } from '../src/miro/rest.ts';
import { PlaneApiError } from '../src/plane/client.ts';
import { BOARD, MIRO_WRITES, seedItem, sticky, world } from './world.ts';

const bind = (over: Partial<BindRequest> = {}): BindRequest => ({
	boardId: BOARD,
	boardName: 'Доска',
	itemId: '101',
	workItemId: 'w-ex',
	projectId: 'p1',
	author: 'Аня',
	...over,
});
const withItem = (over: Parameters<typeof world>[0] = {}) => {
	const w = world({ keepSource: false, ...over });
	seedItem(w.plane, 'w-ex', { assignees: ['u1'], stateId: 's-started' });
	return w;
};

describe('bindItem', () => {
	test('привязка: карточка задачи на месте стикера, текст — комментарием, ссылка в задаче, стикер удалён', async () => {
		const w = withItem();
		const r = await bindItem(w.rt, w.store, bind(), w.log);
		expect(r).toMatchObject({ itemId: '101', ok: true, key: 'LAB-7' });
		const cardId = (r as { cardId: string }).cardId;
		expect(w.miro.cardsOn(BOARD).find((c) => c.id === cardId)).toEqual({
			id: cardId,
			place: { x: 10, y: 20, parentId: '77' },
			card: {
				title: 'LAB-7 Существующая',
				status: 'connected',
				fields: [
					{ value: 'In Progress', fillColor: '#fff3bf', textColor: '#1a1a1a' },
					{ value: 'Аня' },
				],
			},
		});
		expect(w.plane.createdItems).toEqual([]);
		expect(w.plane.createdComments.map((c) => [c.workItemId, c.comment])).toEqual([
			[
				'w-ex',
				{
					comment_html: '<p>С доски Miro (Аня):</p><p>Первый стикер</p>',
					external_source: 'miro',
					external_id: 'uXjVb1=:101',
				},
			],
		]);
		expect(w.plane.links.get('w-ex')).toEqual([
			{ url: boardLink(BOARD, cardId), title: 'Miro: Доска / Фрейм' },
		]);
		expect(w.miro.item(BOARD, '101')).toBeNull();
		expect(w.miro.connector('c1')?.startItemId).toBe(cardId);
		expect(w.store.getSource('acme', BOARD, '101')).toEqual({
			workItemId: 'w-ex',
			projectId: 'p1',
			key: 'LAB-7',
			cardId,
		});
		expect(w.store.findCard(BOARD, cardId)).toMatchObject({ workItemId: 'w-ex', tenant: 'acme' });
	});

	test('комментарий: несколько абзацев и экранирование автора и текста', async () => {
		const w = withItem();
		await bindItem(w.rt, w.store, bind({ itemId: '102', author: 'А<б>' }), w.log);
		expect(w.plane.createdComments[0]?.comment.comment_html).toBe(
			'<p>С доски Miro (А&lt;б&gt;):</p><p>Второй</p><p>стикер</p>',
		);
	});

	test('повтор привязки — комментарий и ссылка не дублируются', async () => {
		const w = withItem();
		w.miro.failNext('deleteItem', new MiroApiError(503, 'DELETE', '/x'));
		expect((await bindItem(w.rt, w.store, bind(), w.log)).ok).toBe(false);
		expect((await bindItem(w.rt, w.store, bind(), w.log)).ok).toBe(true);
		expect(w.plane.createdComments).toHaveLength(1);
		expect(w.plane.links.get('w-ex')).toHaveLength(1);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect(w.miro.item(BOARD, '101')).toBeNull();
	});

	test('комментарий уже есть в Plane (по external_id) → второй не создаётся', async () => {
		const w = withItem();
		w.plane.comments.push({
			id: 'c-old',
			html: '<p>x</p>',
			externalSource: 'miro',
			externalId: `${BOARD}:101`,
			projectId: 'p1',
			workItemId: 'w-ex',
		});
		expect((await bindItem(w.rt, w.store, bind(), w.log)).ok).toBe(true);
		expect(w.plane.createdComments).toEqual([]);
	});

	test('стикер уже стал другой задачей → already_linked, ничего не меняется', async () => {
		const w = withItem({ keepSource: true });
		await convertItems(
			w.rt,
			w.store,
			{ boardId: BOARD, boardName: 'Доска', projectId: 'p1', author: 'Аня', itemIds: ['101'] },
			w.log,
		);
		const source = w.store.getSource('acme', BOARD, '101');
		const planeCalls = w.plane.calls.length;
		const cards = w.miro.cardsOn(BOARD);
		w.miro.calls.length = 0;
		expect(await bindItem(w.rt, w.store, bind(), w.log)).toEqual({
			itemId: '101',
			ok: false,
			error: 'already_linked',
		});
		expect(w.store.getSource('acme', BOARD, '101')).toEqual(source);
		expect(w.miro.cardsOn(BOARD)).toEqual(cards);
		expect(w.plane.createdComments).toEqual([]);
		expect(w.plane.calls).toHaveLength(planeCalls);
		expect(w.miro.calls.filter((c) => MIRO_WRITES.includes(c))).toEqual([]);
	});

	test('повторная привязка к той же задаче — успех без новых карточек', async () => {
		const w = withItem({ keepSource: true });
		const first = await bindItem(w.rt, w.store, bind(), w.log);
		const again = await bindItem(w.rt, w.store, bind(), w.log);
		expect(again).toEqual(first);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
	});

	test('пустой стикер привязывается без комментария', async () => {
		const w = withItem();
		w.board.items.set('109', sticky('109', '<p></p>', 1, 2));
		const r = await bindItem(w.rt, w.store, bind({ itemId: '109' }), w.log);
		expect(r.ok).toBe(true);
		expect(w.plane.createdComments).toEqual([]);
		expect(w.plane.calls).not.toContain('findCommentByExternalId');
		expect(w.miro.item(BOARD, '109')).toBeNull();
	});

	test('задачи нет (или она в другом проекте) → not_found, на доске ничего', async () => {
		const w = withItem();
		for (const over of [{ workItemId: 'nope' }, { projectId: 'p-hidden' }]) {
			expect(await bindItem(w.rt, w.store, bind(over), w.log)).toEqual({
				itemId: '101',
				ok: false,
				error: 'not_found',
			});
		}
		expect(w.store.getSource('acme', BOARD, '101')).toBeNull();
		expect(w.miro.calls.filter((c) => MIRO_WRITES.includes(c))).toEqual([]);
	});

	test('нет стикера → not_found, фрейм → unsupported_type, Plane не спрашивают', async () => {
		const w = withItem();
		expect(await bindItem(w.rt, w.store, bind({ itemId: '999' }), w.log)).toMatchObject({
			error: 'not_found',
		});
		expect(await bindItem(w.rt, w.store, bind({ itemId: '77' }), w.log)).toMatchObject({
			error: 'unsupported_type',
		});
		expect(w.plane.calls).toEqual([]);
	});

	test('keepSource: комментарий и ссылка есть, стикер и стрелка на месте, карточка справа', async () => {
		const w = withItem({ keepSource: true });
		const r = await bindItem(w.rt, w.store, bind(), w.log);
		const cardId = (r as { cardId: string }).cardId;
		expect(w.miro.cardsOn(BOARD)[0]?.place).toEqual({ x: 310, y: 20, parentId: '77' });
		expect(w.miro.item(BOARD, '101')).not.toBeNull();
		expect(w.miro.connector('c1')?.startItemId).toBe('101');
		expect(w.plane.createdComments).toHaveLength(1);
		expect(w.plane.links.get('w-ex')?.[0]?.url).toBe(boardLink(BOARD, cardId));
	});

	test('источник есть, задача удалена в Plane → not_found', async () => {
		const w = withItem();
		await bindItem(w.rt, w.store, bind(), w.log);
		w.plane.items.delete('w-ex');
		expect(await bindItem(w.rt, w.store, bind(), w.log)).toMatchObject({
			ok: false,
			error: 'not_found',
		});
	});

	test('ошибка комментария (Plane) → plane_failed, стикер остаётся, повтор доделывает', async () => {
		const w = withItem();
		w.plane.failNext('createComment', new PlaneApiError(500, 'POST', '/c'));
		expect(await bindItem(w.rt, w.store, bind(), w.log)).toMatchObject({
			ok: false,
			error: 'plane_failed',
		});
		expect(w.miro.item(BOARD, '101')).not.toBeNull();
		expect((await bindItem(w.rt, w.store, bind(), w.log)).ok).toBe(true);
		expect(w.plane.createdComments).toHaveLength(1);
		expect(w.miro.item(BOARD, '101')).toBeNull();
	});

	test('лог привязки: ключ и id, без текста и автора', async () => {
		const w = withItem();
		await bindItem(w.rt, w.store, bind(), w.log);
		expect(w.logs).toEqual([
			{ event: 'convert.item', tenant: 'acme', board: BOARD, item: '101', ok: true, key: 'LAB-7' },
		]);
	});
});
