import { describe, expect, test } from 'bun:test';

import { boardLink } from '../src/card.ts';
import { handleCommentLinks, handleLinkCreated, placeCardForLink } from '../src/links.ts';
import { MiroApiError, MiroNotConnected } from '../src/miro/rest.ts';
import { PlaneApiError } from '../src/plane/client.ts';
import { type PlaneEvent, parsePlaneDelivery } from '../src/plane/webhook.ts';
import { fixture } from './fixtures.ts';
import { BOARD, seedItem, world } from './world.ts';

type Commented = Extract<PlaneEvent, { kind: 'comment.created' }>;
type Linked = Extract<PlaneEvent, { kind: 'link.created' }>;
const BOARD2 = 'uXjVb2=';

const commented = (html: string | null, over: Partial<Commented> = {}): Commented => ({
	kind: 'comment.created',
	tenant: 'acme',
	eventKey: 'c1',
	actorId: 'u1',
	projectId: 'p1',
	workItemId: 'w1',
	commentId: 'cm1',
	commentHtml: html,
	...over,
});
const linked = (url: string, over: Partial<Linked> = {}): Linked => ({
	kind: 'link.created',
	tenant: 'acme',
	eventKey: 'l1',
	actorId: 'u1',
	projectId: 'p1',
	workItemId: 'w1',
	url,
	...over,
});
const href = (board: string, item?: string) =>
	`<p><a href="https://miro.com/app/board/${board}/${item === undefined ? '' : `?moveToWidget=${item}&amp;cot=14`}">x</a></p>`;

function setup() {
	const w = world();
	w.miro.addBoard(BOARD2, 'Вторая');
	seedItem(w.plane, 'w1', { name: 'Задача', stateId: 's-started' });
	return w;
}
const parsed = (name: string): PlaneEvent => {
	const fx = fixture(name);
	return parsePlaneDelivery('acme', new Headers(fx.headers), fx.raw) as PlaneEvent;
};

describe('handleCommentLinks', () => {
	test('ссылка на элемент → карточка справа от него, ссылка «Miro: Доска / Фрейм» в задаче', async () => {
		const w = setup();
		await handleCommentLinks(w.rt, w.store, commented(href(BOARD, '101')), w.log);
		const cards = w.miro.cardsOn(BOARD);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.place).toEqual({ x: 10 + 100 + 40 + 160, y: 20, parentId: '77' });
		expect(cards[0]?.card.title).toBe('LAB-7 Задача');
		const cardId = cards[0]?.id as string;
		expect(w.plane.links.get('w1')).toEqual([
			{ url: boardLink(BOARD, cardId), title: 'Miro: Доска / Фрейм' },
		]);
		expect(w.store.cardOnBoard('acme', 'w1', BOARD)).toMatchObject({
			cardId,
			projectId: 'p1',
		});
		expect(w.store.cardOnBoard('acme', 'w1', BOARD)?.fieldsHash).toMatch(/^[0-9a-f]{64}$/);
	});

	test('ссылка на фрейм → название фрейма берётся у самого фрейма', async () => {
		const w = setup();
		await handleCommentLinks(w.rt, w.store, commented(href(BOARD, '77')), w.log);
		expect(w.plane.links.get('w1')?.[0]?.title).toBe('Miro: Доска / Фрейм');
		expect(w.miro.cardsOn(BOARD)[0]?.place.parentId).toBeNull();
	});

	test('ссылка на доску без элемента → карточка в центре доски', async () => {
		const w = setup();
		await handleCommentLinks(w.rt, w.store, commented(href(BOARD2)), w.log);
		expect(w.miro.cardsOn(BOARD2)[0]?.place).toEqual({ x: 0, y: 0, parentId: null });
		expect(w.plane.links.get('w1')?.[0]?.title).toBe('Miro: Вторая');
	});

	test('элемент не найден → центр доски', async () => {
		const w = setup();
		await handleCommentLinks(w.rt, w.store, commented(href(BOARD, '999')), w.log);
		expect(w.miro.cardsOn(BOARD)[0]?.place).toEqual({ x: 0, y: 0, parentId: null });
		expect(w.plane.links.get('w1')?.[0]?.title).toBe('Miro: Доска');
	});

	test('две ссылки на разные доски → две карточки, на одну доску дважды → одна', async () => {
		const w = setup();
		await handleCommentLinks(
			w.rt,
			w.store,
			commented(href(BOARD) + href(BOARD2) + href(BOARD)),
			w.log,
		);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect(w.miro.cardsOn(BOARD2)).toHaveLength(1);
	});

	test('у задачи уже есть карточка на этой доске → новая не ставится, ссылка уже есть', async () => {
		const w = setup();
		await handleCommentLinks(w.rt, w.store, commented(href(BOARD, '101')), w.log);
		const before = w.miro.calls.filter((c) => c === 'createAppCard').length;
		await handleCommentLinks(w.rt, w.store, commented(href(BOARD, '102')), w.log);
		expect(before).toBe(1);
		expect(w.miro.calls.filter((c) => c === 'createAppCard')).toHaveLength(1);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect(w.plane.links.get('w1')).toHaveLength(1);
	});

	test('повтор после сбоя createLink → вторая карточка не ставится, ссылка создаётся', async () => {
		const w = setup();
		w.plane.failNext('createLink', new PlaneApiError(503, 'POST', '/links/'));
		const ev = commented(href(BOARD, '101'));
		await expect(handleCommentLinks(w.rt, w.store, ev, w.log)).rejects.toThrow();
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect(w.plane.links.get('w1')).toBeUndefined();
		await handleCommentLinks(w.rt, w.store, ev, w.log);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		const cardId = w.miro.cardsOn(BOARD)[0]?.id as string;
		expect(w.plane.links.get('w1')).toEqual([
			{ url: boardLink(BOARD, cardId), title: 'Miro: Доска / Фрейм' },
		]);
	});

	test('комментарий бота приложения → ничего', async () => {
		const w = setup();
		await handleCommentLinks(
			w.rt,
			w.store,
			commented(href(BOARD, '101'), { actorId: w.plane.botId }),
			w.log,
		);
		expect(w.miro.calls).toEqual([]);
		expect(w.plane.createdComments).toEqual([]);
		expect(w.plane.links.size).toBe(0);
	});

	test('скрытый проект → ничего', async () => {
		const w = setup();
		await handleCommentLinks(
			w.rt,
			w.store,
			commented(href(BOARD, '101'), { projectId: 'p-hidden' }),
			w.log,
		);
		expect(w.miro.calls).toEqual([]);
		expect(w.plane.calls).not.toContain('getWorkItem');
	});

	test('без ссылок или с пустым телом → ничего', async () => {
		const w = setup();
		await handleCommentLinks(w.rt, w.store, commented('<p>просто текст</p>'), w.log);
		await handleCommentLinks(w.rt, w.store, commented(null), w.log);
		expect(w.miro.calls).toEqual([]);
		expect(w.plane.calls).not.toContain('getWorkItem');
	});

	test('задача не найдена → ничего', async () => {
		const w = setup();
		await handleCommentLinks(
			w.rt,
			w.store,
			commented(href(BOARD, '101'), { workItemId: 'nope' }),
			w.log,
		);
		expect(w.miro.calls).toEqual([]);
	});

	test('доска не видна служебному аккаунту → лог link.board_no_access, без исключения', async () => {
		const w = setup();
		w.miro.noAccess.add(BOARD);
		await handleCommentLinks(w.rt, w.store, commented(href(BOARD, '101')), w.log);
		expect(w.logs).toContainEqual({
			event: 'link.board_no_access',
			level: 'warn',
			tenant: 'acme',
			boardId: BOARD,
		});
		expect(w.miro.calls).not.toContain('createAppCard');
		expect(w.plane.links.size).toBe(0);
	});

	test('Miro не подключён → лог miro.not_connected, без исключения', async () => {
		const w = setup();
		w.miro.failNext('getBoard', new MiroNotConnected());
		await handleCommentLinks(w.rt, w.store, commented(href(BOARD, '101')), w.log);
		expect(w.logs).toContainEqual({ event: 'miro.not_connected', level: 'error', tenant: 'acme' });
	});

	test('повторяемая ошибка Miro уходит наружу, неповторяемая тоже', async () => {
		const w = setup();
		w.miro.failNext('createAppCard', new MiroApiError(503, 'POST', '/v2/boards/{board}/app_cards'));
		await expect(
			handleCommentLinks(w.rt, w.store, commented(href(BOARD)), w.log),
		).rejects.toBeInstanceOf(MiroApiError);
		expect(w.store.cardOnBoard('acme', 'w1', BOARD)).toBeNull();
	});

	test('фикстура пробы plane-comment-miro-link.json → карточка на доске из ссылки', async () => {
		const w = setup();
		w.miro.addBoard('uXjVexample1=', 'Проба');
		const event = parsed('plane-comment-miro-link') as Commented;
		expect(event.kind).toBe('comment.created');
		await handleCommentLinks(w.rt, w.store, { ...event, projectId: 'p1', workItemId: 'w1' }, w.log);
		expect(w.miro.cardsOn('uXjVexample1=')).toHaveLength(1);
		// the item 3458764500000000001 is not on the fake board → centre
		expect(w.miro.cardsOn('uXjVexample1=')[0]?.place).toEqual({ x: 0, y: 0, parentId: null });
		expect(w.plane.links.get('w1')?.[0]?.title).toBe('Miro: Проба');
	});

	test('фикстура с дублем ссылки (plane-comment-miro-link-dup.json) → одна карточка', async () => {
		const w = setup();
		w.miro.addBoard('uXjVexample1=', 'Проба');
		const event = parsed('plane-comment-miro-link-dup') as Commented;
		await handleCommentLinks(w.rt, w.store, { ...event, projectId: 'p1', workItemId: 'w1' }, w.log);
		expect(w.miro.cardsOn('uXjVexample1=')).toHaveLength(1);
	});
});

describe('handleLinkCreated', () => {
	test('ссылка из поля «Ссылки» (plane-issue-link-created.json) → карточка; та же ссылка от бота → ничего', async () => {
		const w = setup();
		w.miro.addBoard('uXjVexample1=', 'Проба');
		const event = parsed('plane-issue-link-created') as Linked;
		expect(event.kind).toBe('link.created');
		const mine = { ...event, projectId: 'p1', workItemId: 'w1' };
		await handleLinkCreated(w.rt, w.store, { ...mine, actorId: w.plane.botId }, w.log);
		expect(w.miro.calls).toEqual([]);
		await handleLinkCreated(w.rt, w.store, mine, w.log);
		expect(w.miro.cardsOn('uXjVexample1=')).toHaveLength(1);
		const bot = parsed('plane-issue-link-created-bot') as Linked;
		expect(bot.url).toContain('moveToWidget=3458764500000000001');
	});

	test('ссылка не на Miro → ничего', async () => {
		const w = setup();
		await handleLinkCreated(w.rt, w.store, linked('https://example.com/a'), w.log);
		expect(w.miro.calls).toEqual([]);
	});

	test('ссылка на элемент доски → карточка рядом', async () => {
		const w = setup();
		await handleLinkCreated(
			w.rt,
			w.store,
			linked(`https://miro.com/app/board/${BOARD}/?moveToWidget=102`),
			w.log,
		);
		expect(w.miro.cardsOn(BOARD)[0]?.place).toEqual({
			x: 300 + 100 + 40 + 160,
			y: 20,
			parentId: '77',
		});
	});
});

describe('placeCardForLink', () => {
	test('вызывается напрямую: карточка и ссылка', async () => {
		const w = setup();
		const item = w.plane.items.get('w1');
		if (item === undefined) throw new Error('seed');
		await placeCardForLink(w.rt, w.store, item, { boardId: BOARD, itemId: null }, w.log);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
	});
});
