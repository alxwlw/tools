import { describe, expect, test } from 'bun:test';

import { boardLink } from '../src/card.ts';
import {
	besidePlace,
	CARD_WIDTH,
	convertItems,
	type ConvertRequest,
	lockedItems,
} from '../src/convert.ts';
import { MiroApiError, MiroNotConnected } from '../src/miro/rest.ts';
import { PlaneApiError } from '../src/plane/client.ts';
import { BOARD, MIRO_WRITES, seedItem, sticky, world } from './world.ts';

const req = (ids: string[], over: Partial<ConvertRequest> = {}): ConvertRequest => ({
	boardId: BOARD,
	boardName: 'Доска',
	projectId: 'p1',
	author: 'Аня',
	itemIds: ids,
	...over,
});
const writes = (calls: readonly string[]) => calls.filter((c) => MIRO_WRITES.includes(c));

describe('convertItems', () => {
	test('два стикера → две задачи, карточки на их местах, стрелка на карточке, стикеры удалены', async () => {
		const w = world({ keepSource: false });
		const r = await convertItems(w.rt, w.store, req(['101', '102']), w.log);
		expect(r.map((x) => x.ok)).toEqual([true, true]);
		expect(w.plane.createdItems.map((i) => i.item.external_id)).toEqual([
			'uXjVb1=:101',
			'uXjVb1=:102',
		]);
		expect(w.plane.createdItems.map((i) => i.item.external_source)).toEqual(['miro', 'miro']);
		const first = r[0] as { cardId: string; key: string };
		const second = r[1] as { cardId: string };
		expect(first.key).toBe('LAB-1');
		expect(w.miro.cardsOn(BOARD).find((c) => c.id === first.cardId)).toMatchObject({
			place: { x: 10, y: 20, parentId: '77' },
			card: { title: 'LAB-1 Первый стикер', status: 'connected' },
		});
		expect(w.miro.cardsOn(BOARD).find((c) => c.id === second.cardId)?.place).toEqual({
			x: 300,
			y: 20,
			parentId: '77',
		});
		expect(w.miro.connector('c1')).toEqual({
			id: 'c1',
			startItemId: first.cardId,
			endItemId: second.cardId,
		});
		expect(w.miro.connector('c3')).toEqual({ id: 'c3', startItemId: '500', endItemId: '501' });
		expect(w.miro.item(BOARD, '101')).toBeNull();
		expect(w.miro.item(BOARD, '102')).toBeNull();
		expect(w.store.getSource('acme', BOARD, '101')).toEqual({
			workItemId: 'fake-w-1',
			projectId: 'p1',
			key: 'LAB-1',
			cardId: first.cardId,
		});
		expect(w.store.findCard(BOARD, first.cardId)).toMatchObject({
			tenant: 'acme',
			workItemId: 'fake-w-1',
			projectId: 'p1',
		});
		expect(w.store.findCard(BOARD, first.cardId)?.fieldsHash).toMatch(/^[0-9a-f]{64}$/);
	});

	test('коннекторы доски запрашиваются один раз на запрос', async () => {
		const w = world({ keepSource: false });
		await convertItems(w.rt, w.store, req(['101', '102']), w.log);
		expect(w.miro.calls.filter((c) => c === 'listConnectors')).toHaveLength(1);
		expect(w.miro.calls.filter((c) => c === 'reattachConnector')).toHaveLength(2);
	});

	test('название — первая строка (до 255), описание — абзацы, теги и автор', async () => {
		const w = world();
		const long = 'я'.repeat(300);
		w.board.items.set('103', sticky('103', `<p>${long}</p><p>вторая &amp; &lt;b&gt;</p>`, 1, 2));
		w.board.tags.set('103', ['срочно', 'miro']);
		const r = await convertItems(w.rt, w.store, req(['103'], { author: 'Аня <&> Co' }), w.log);
		expect(r[0]?.ok).toBe(true);
		const created = w.plane.createdItems[0]!.item;
		expect(created.name).toBe(`${'я'.repeat(254)}…`);
		expect(created.description_html).toBe(
			`<p>${long}</p><p>вторая &amp; &lt;b&gt;</p><p>Теги Miro: срочно, miro</p><p>С доски Miro: Аня &lt;&amp;&gt; Co</p>`,
		);
	});

	test('без тегов — абзаца про теги нет; теги берут только у стикера и карточки', async () => {
		const w = world();
		w.board.items.set('104', { ...sticky('104', '<p>Фигура</p>', 1, 2), type: 'shape' });
		w.board.items.set('105', { ...sticky('105', '<p>Текст</p>', 1, 2), type: 'text' });
		w.board.items.set('106', { ...sticky('106', '<p>Карточка</p>', 1, 2), type: 'card' });
		w.board.tags.set('106', ['t']);
		await convertItems(w.rt, w.store, req(['104', '105', '106', '101']), w.log);
		expect(w.miro.calls.filter((c) => c === 'getItemTags')).toHaveLength(2);
		const descs = w.plane.createdItems.map((i) => i.item.description_html);
		expect(descs[0]).toBe('<p>Фигура</p><p>С доски Miro: Аня</p>');
		expect(descs[2]).toBe('<p>Карточка</p><p>Теги Miro: t</p><p>С доски Miro: Аня</p>');
		expect(descs[3]).toBe('<p>Первый стикер</p><p>С доски Miro: Аня</p>');
	});

	test('пустой стикер → empty_text, задачи нет, стикер на месте', async () => {
		const w = world();
		w.board.items.set('107', sticky('107', '<p> &nbsp; </p>', 1, 2));
		expect(await convertItems(w.rt, w.store, req(['107']), w.log)).toEqual([
			{ itemId: '107', ok: false, error: 'empty_text' },
		]);
		expect(w.plane.calls).toEqual([]);
		expect(w.miro.calls).toEqual(['getItem']);
		expect(w.miro.item(BOARD, '107')).not.toBeNull();
	});

	test('фрейм → unsupported_type, нет такого элемента → not_found', async () => {
		const w = world();
		expect(await convertItems(w.rt, w.store, req(['77', '999']), w.log)).toEqual([
			{ itemId: '77', ok: false, error: 'unsupported_type' },
			{ itemId: '999', ok: false, error: 'not_found' },
		]);
		expect(w.plane.calls).toEqual([]);
	});

	test('Plane упал → plane_failed, на доске ничего не изменилось', async () => {
		const w = world({ keepSource: false });
		w.plane.failNext('createWorkItem', new PlaneApiError(503, 'POST', '/x'));
		const r = await convertItems(w.rt, w.store, req(['101']), w.log);
		expect(r).toEqual([{ itemId: '101', ok: false, error: 'plane_failed' }]);
		expect(writes(w.miro.calls)).toEqual([]);
		expect(w.miro.item(BOARD, '101')).not.toBeNull();
		expect(w.store.getSource('acme', BOARD, '101')).toBeNull();
		expect(w.logs).toEqual([
			{
				event: 'convert.item',
				tenant: 'acme',
				board: BOARD,
				item: '101',
				ok: false,
				error: 'plane_failed',
				detail: 'Plane POST /x → 503',
			},
		]);
	});

	test('ошибка одного элемента не останавливает остальные; успех в лог без текста', async () => {
		const w = world();
		w.plane.failNext('createWorkItem', new PlaneApiError(503, 'POST', '/x'));
		const r = await convertItems(w.rt, w.store, req(['101', '102']), w.log);
		expect(r.map((x) => x.ok)).toEqual([false, true]);
		expect(w.logs[1]).toEqual({
			event: 'convert.item',
			tenant: 'acme',
			board: BOARD,
			item: '102',
			ok: true,
			key: 'LAB-1',
		});
		expect(JSON.stringify(w.logs)).not.toContain('стикер');
	});

	test('карточка не встала (Miro 503) → miro_failed, стикер на месте; повтор: одна задача, одна карточка, стикер удалён', async () => {
		const w = world({ keepSource: false });
		w.miro.failNext('createAppCard', new MiroApiError(503, 'POST', '/v2/boards/x/app_cards'));
		const first = (await convertItems(w.rt, w.store, req(['101']), w.log))[0];
		expect(first).toMatchObject({ ok: false, error: 'miro_failed' });
		expect(w.miro.item(BOARD, '101')).not.toBeNull();
		expect(w.store.getSource('acme', BOARD, '101')).toMatchObject({ cardId: null });
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]?.ok).toBe(true);
		expect(w.plane.createdItems).toHaveLength(1);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect(w.miro.item(BOARD, '101')).toBeNull();
	});

	test('keepSource: карточка справа от стикера, стикер и стрелка на месте', async () => {
		const w = world({ keepSource: true });
		const r = await convertItems(w.rt, w.store, req(['101']), w.log);
		const cardId = (r[0] as { cardId: string }).cardId;
		expect(w.miro.cardsOn(BOARD).find((c) => c.id === cardId)?.place).toEqual({
			x: 10 + 100 + 40 + CARD_WIDTH / 2,
			y: 20,
			parentId: '77',
		});
		expect(w.miro.item(BOARD, '101')).not.toBeNull();
		expect(w.miro.connector('c1')?.startItemId).toBe('101');
		expect(w.miro.calls).not.toContain('listConnectors');
		expect(w.miro.calls).not.toContain('deleteItem');
	});

	test('besidePlace: ширина по умолчанию 200, родитель и y сохраняются', () => {
		const item = { id: '1', type: 'text', html: 'x', x: 0, y: 5, width: null, height: null };
		expect(besidePlace({ ...item, parentId: null })).toEqual({
			x: 100 + 40 + CARD_WIDTH / 2,
			y: 5,
			parentId: null,
		});
		expect(besidePlace({ ...item, width: 60, parentId: '9' })).toEqual({
			x: 30 + 40 + CARD_WIDTH / 2,
			y: 5,
			parentId: '9',
		});
	});

	test('элемент без фрейма: карточка без родителя', async () => {
		const w = world({ keepSource: false });
		w.board.items.set('108', sticky('108', '<p>Вне фрейма</p>', 5, 6, null));
		const r = await convertItems(w.rt, w.store, req(['108']), w.log);
		const cardId = (r[0] as { cardId: string }).cardId;
		expect(w.miro.cardsOn(BOARD).find((c) => c.id === cardId)?.place).toEqual({
			x: 5,
			y: 6,
			parentId: null,
		});
		expect(w.plane.links.get('fake-w-1')?.[0]?.title).toBe('Miro: Доска');
	});

	test('карточка: 403 → board_no_access, задача одна, повтор после доступа ставит карточку', async () => {
		const w = world({ keepSource: false });
		w.miro.failNext('createAppCard', new MiroApiError(403, 'POST', '/v2/boards/{board}/app_cards'));
		expect(await convertItems(w.rt, w.store, req(['101']), w.log)).toEqual([
			{ itemId: '101', ok: false, error: 'board_no_access' },
		]);
		expect(w.plane.createdItems).toHaveLength(1);
		expect(w.store.getSource('acme', BOARD, '101')).toMatchObject({ cardId: null });
		expect(w.miro.item(BOARD, '101')).not.toBeNull();
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]?.ok).toBe(true);
		expect(w.plane.createdItems).toHaveLength(1);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
	});

	test('MiroNotConnected не превращается в ошибку элемента', async () => {
		const w = world();
		w.miro.failNext('getItem', new MiroNotConnected());
		await expect(convertItems(w.rt, w.store, req(['101']), w.log)).rejects.toBeInstanceOf(
			MiroNotConnected,
		);
		expect(w.logs).toEqual([]);
	});

	test('ссылка в задаче — moveToWidget карточки с названием места; повтор не ломается на дубле', async () => {
		const w = world({ keepSource: false });
		w.miro.failNext('deleteItem', new MiroApiError(503, 'DELETE', '/x'));
		const first = (await convertItems(w.rt, w.store, req(['101']), w.log))[0];
		expect(first).toMatchObject({ ok: false, error: 'miro_failed' });
		const cardId = w.store.getSource('acme', BOARD, '101')!.cardId!;
		const expected = [{ url: boardLink(BOARD, cardId), title: 'Miro: Доска / Фрейм' }];
		expect(w.plane.links.get('fake-w-1')).toEqual(expected);
		const again = await convertItems(w.rt, w.store, req(['101']), w.log);
		expect(again[0]).toMatchObject({ ok: true, cardId });
		expect(w.plane.links.get('fake-w-1')).toEqual(expected);
		expect(w.miro.item(BOARD, '101')).toBeNull();
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
	});

	test('ошибка ссылки (Plane) → plane_failed, сделанное остаётся, повтор доделывает', async () => {
		const w = world({ keepSource: false });
		w.plane.failNext('createLink', new PlaneApiError(500, 'POST', '/l'));
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]).toMatchObject({
			ok: false,
			error: 'plane_failed',
		});
		expect(w.miro.item(BOARD, '101')).not.toBeNull();
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]?.ok).toBe(true);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect(w.plane.links.get('fake-w-1')).toHaveLength(1);
	});

	test('ошибка названия фрейма (Miro) → miro_failed до ссылки', async () => {
		const w = world();
		w.miro.failNext('getFrameTitle', new MiroApiError(503, 'GET', '/f'));
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]).toMatchObject({
			ok: false,
			error: 'miro_failed',
		});
		expect(w.plane.links.size).toBe(0);
	});

	test('embed: блок со ссылкой на карточку добавлен один раз; у тенанта без embed описание не трогается', async () => {
		const w = world({ keepSource: true, embed: true });
		const r = await convertItems(w.rt, w.store, req(['101']), w.log);
		const url = boardLink(BOARD, (r[0] as { cardId: string }).cardId);
		const html = w.plane.descriptions.get('fake-w-1')!;
		expect(
			html.startsWith('<p>Первый стикер</p><p>С доски Miro: Аня</p><external-embed-component'),
		).toBe(true);
		expect(html).toContain(`src="${url}"`);
		expect(html.split('<external-embed-component')).toHaveLength(2);
		await convertItems(w.rt, w.store, req(['101']), w.log);
		expect(w.plane.descriptions.get('fake-w-1')).toBe(html);
		expect(w.plane.calls.filter((c) => c === 'updateDescription')).toHaveLength(1);

		const off = world({ keepSource: true, embed: false });
		await convertItems(off.rt, off.store, req(['101']), off.log);
		expect(off.plane.calls).not.toContain('updateDescription');
		expect(off.plane.descriptions.size).toBe(0);
	});

	test('embed: у задачи без описания блок встаёт в пустое описание', async () => {
		const w = world({ keepSource: true, embed: true });
		await convertItems(w.rt, w.store, req(['101']), w.log);
		// the source is known from now on; the description is emptied in Plane
		w.plane.items.get('fake-w-1')!.descriptionHtml = null;
		await convertItems(w.rt, w.store, req(['101']), w.log);
		expect(w.plane.descriptions.get('fake-w-1')!.startsWith('<external-embed-component')).toBe(
			true,
		);
	});

	test('embed: задача пропала между шагами → not_found, описание не трогается', async () => {
		const w = world({ keepSource: true, embed: true });
		const read = w.plane.getWorkItem.bind(w.plane);
		let reads = 0;
		// the first read follows createWorkItem; the second is the fresh one of the Embed step
		w.plane.getWorkItem = async (projectId, workItemId) =>
			++reads === 2 ? null : read(projectId, workItemId);
		expect(await convertItems(w.rt, w.store, req(['101']), w.log)).toEqual([
			{ itemId: '101', ok: false, error: 'not_found' },
		]);
		expect(w.plane.calls).not.toContain('updateDescription');
	});

	test('устаревший cardId (строка карточки удалена) → новая карточка и новый cardId в источнике', async () => {
		const w = world({ keepSource: true });
		const old = (await convertItems(w.rt, w.store, req(['101']), w.log))[0] as { cardId: string };
		w.store.deleteCard(BOARD, old.cardId);
		const next = (await convertItems(w.rt, w.store, req(['101']), w.log))[0] as { cardId: string };
		expect(next.cardId).not.toBe(old.cardId);
		expect(w.store.getSource('acme', BOARD, '101')?.cardId).toBe(next.cardId);
		expect(w.store.findCard(BOARD, next.cardId)).not.toBeNull();
		expect(w.plane.createdItems).toHaveLength(1);
	});

	test('живая карточка не создаётся второй раз при повторе', async () => {
		const w = world({ keepSource: true });
		await convertItems(w.rt, w.store, req(['101']), w.log);
		await convertItems(w.rt, w.store, req(['101']), w.log);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect(w.miro.calls.filter((c) => c === 'createAppCard')).toHaveLength(1);
	});

	test('внешний id принадлежит архивной задаче (409, чтение пусто) → already_linked, ничего не создано', async () => {
		const w = world({ keepSource: false });
		seedItem(w.plane, 'w-arch');
		Object.assign(w.plane.items.get('w-arch')!, {
			externalSource: 'miro',
			externalId: `${BOARD}:101`,
		});
		w.plane.archived.add('w-arch');
		expect(await convertItems(w.rt, w.store, req(['101']), w.log)).toEqual([
			{ itemId: '101', ok: false, error: 'already_linked' },
		]);
		expect(w.store.getSource('acme', BOARD, '101')).toBeNull();
		expect(w.miro.cardsOn(BOARD)).toEqual([]);
		expect(writes(w.miro.calls)).toEqual([]);
		expect(w.plane.links.size).toBe(0);
		expect(w.miro.item(BOARD, '101')).not.toBeNull();
	});

	const addP2 = (w: ReturnType<typeof world>) => {
		w.plane.projects.push({ id: 'p2', identifier: 'TWO', name: 'Второй', archived: false });
		w.plane.states.set('p2', [{ id: 's2', name: 'Todo', group: 'unstarted' }]);
	};

	test('источник есть, задача удалена, в запросе другой проект → новая задача в записанном проекте, источник и карточка новые', async () => {
		const w = world({ keepSource: true });
		addP2(w);
		const old = (await convertItems(w.rt, w.store, req(['101']), w.log))[0] as { cardId: string };
		w.plane.items.delete('fake-w-1');
		const r = (await convertItems(w.rt, w.store, req(['101'], { projectId: 'p2' }), w.log))[0];
		expect(r).toMatchObject({ ok: true, key: 'LAB-2' });
		expect(w.plane.createdItems.map((i) => [i.id, i.projectId])).toEqual([
			['fake-w-1', 'p1'],
			['fake-w-2', 'p1'],
		]);
		const next = (r as { cardId: string }).cardId;
		expect(next).not.toBe(old.cardId);
		expect(w.store.getSource('acme', BOARD, '101')).toEqual({
			workItemId: 'fake-w-2',
			projectId: 'p1',
			key: 'LAB-2',
			cardId: next,
		});
		expect(w.plane.links.get('fake-w-2')?.[0]?.url).toContain(next);
	});

	test('источник есть, задача заархивирована, в запросе другой проект → already_linked, второй задачи нет, источник и карточка целы', async () => {
		const w = world({ keepSource: true });
		addP2(w);
		await convertItems(w.rt, w.store, req(['101']), w.log);
		const source = w.store.getSource('acme', BOARD, '101');
		w.plane.archived.add('fake-w-1');
		expect(await convertItems(w.rt, w.store, req(['101'], { projectId: 'p2' }), w.log)).toEqual([
			{ itemId: '101', ok: false, error: 'already_linked' },
		]);
		expect(w.plane.createdItems).toHaveLength(1);
		expect(w.store.getSource('acme', BOARD, '101')).toEqual(source);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
	});

	test('источник с пустым ключом, задача заархивирована, другой проект → already_linked, задача одна', async () => {
		const w = world({ keepSource: true });
		addP2(w);
		w.plane.failNext('getWorkItem', new PlaneApiError(503, 'GET', '/x'));
		await convertItems(w.rt, w.store, req(['101']), w.log);
		w.plane.archived.add('fake-w-1');
		expect(await convertItems(w.rt, w.store, req(['101'], { projectId: 'p2' }), w.log)).toEqual([
			{ itemId: '101', ok: false, error: 'already_linked' },
		]);
		expect(w.plane.createdItems).toHaveLength(1);
		expect(w.store.getSource('acme', BOARD, '101')).toMatchObject({
			workItemId: 'fake-w-1',
			key: '',
		});
	});

	test('409 называет записанную задачу, а повторное чтение уже видит её (un-archive между чтениями) → already_linked, карточка и источник целы', async () => {
		const w = world({ keepSource: true, embed: true });
		const first = (await convertItems(w.rt, w.store, req(['101']), w.log))[0] as { cardId: string };
		w.plane.archived.add('fake-w-1');
		const create = w.plane.createWorkItem.bind(w.plane);
		w.plane.createWorkItem = async (projectId, item) => {
			const answer = await create(projectId, item);
			w.plane.archived.delete('fake-w-1');
			return answer;
		};
		expect(await convertItems(w.rt, w.store, req(['101']), w.log)).toEqual([
			{ itemId: '101', ok: false, error: 'already_linked' },
		]);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect(w.store.getSource('acme', BOARD, '101')?.cardId).toBe(first.cardId);
		expect(w.plane.links.get('fake-w-1')).toHaveLength(1);
		expect(w.plane.descriptions.get('fake-w-1')!.split('moveToWidget')).toHaveLength(2);
	});

	test('created:true никогда не читается как «скрытая записанная задача», даже с тем же id', async () => {
		const w = world({ keepSource: true });
		await convertItems(w.rt, w.store, req(['101']), w.log);
		w.plane.items.delete('fake-w-1');
		const create = w.plane.createWorkItem.bind(w.plane);
		// the answer a recreate would give if Plane reused the id: still a creation
		w.plane.createWorkItem = async (projectId, item) => {
			const answer = await create(projectId, item);
			w.plane.items.set('fake-w-1', { ...w.plane.items.get(answer.id)!, id: 'fake-w-1' });
			return { id: 'fake-w-1', created: true };
		};
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]).toMatchObject({ ok: true });
	});

	test('архив и возврат: после un-archive повтор берёт первую карточку, ссылка и Embed не дублируются', async () => {
		const w = world({ keepSource: true, embed: true });
		const first = (await convertItems(w.rt, w.store, req(['101']), w.log))[0] as { cardId: string };
		w.plane.archived.add('fake-w-1');
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]).toMatchObject({
			error: 'already_linked',
		});
		w.plane.archived.delete('fake-w-1');
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]).toMatchObject({
			ok: true,
			cardId: first.cardId,
		});
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect(w.plane.links.get('fake-w-1')).toHaveLength(1);
		expect(w.plane.descriptions.get('fake-w-1')!.split('moveToWidget')).toHaveLength(2);
	});

	test('задача создана, чтение не удалось (источник уже записан) → повтор берёт её же, одна карточка', async () => {
		const w = world({ keepSource: true });
		w.plane.failNext('getWorkItem', new PlaneApiError(503, 'GET', '/x'));
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]).toMatchObject({
			ok: false,
			error: 'plane_failed',
		});
		expect(w.store.getSource('acme', BOARD, '101')).toEqual({
			workItemId: 'fake-w-1',
			projectId: 'p1',
			key: '',
			cardId: null,
		});
		expect(w.miro.cardsOn(BOARD)).toEqual([]);
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]).toMatchObject({
			ok: true,
			key: 'LAB-1',
		});
		expect(w.plane.createdItems).toHaveLength(1);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect(w.store.getSource('acme', BOARD, '101')?.key).toBe('LAB-1');
	});

	test('повтор с другим проектом работает в записанном: одна задача в p1, одна карточка, ключ верный', async () => {
		const w = world({ keepSource: true });
		w.plane.projects.push({ id: 'p2', identifier: 'TWO', name: 'Второй', archived: false });
		w.plane.states.set('p2', [{ id: 's2', name: 'Todo', group: 'unstarted' }]);
		w.plane.failNext('getWorkItem', new PlaneApiError(503, 'GET', '/x'));
		await convertItems(w.rt, w.store, req(['101']), w.log);
		const r = await convertItems(w.rt, w.store, req(['101'], { projectId: 'p2' }), w.log);
		expect(r[0]).toMatchObject({ ok: true, key: 'LAB-1' });
		expect(w.plane.createdItems.map((i) => i.projectId)).toEqual(['p1']);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect(w.store.getSource('acme', BOARD, '101')).toMatchObject({ projectId: 'p1' });
	});

	test('задача с таким внешним id уже есть в Plane, строки источника нет → 409, берётся она же', async () => {
		const w = world({ keepSource: true });
		seedItem(w.plane, 'w-old', { sequenceId: 3 });
		Object.assign(w.plane.items.get('w-old')!, {
			externalSource: 'miro',
			externalId: `${BOARD}:101`,
		});
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]).toMatchObject({
			ok: true,
			key: 'LAB-3',
		});
		expect(w.plane.createdItems).toHaveLength(0);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect(w.store.getSource('acme', BOARD, '101')).toMatchObject({ workItemId: 'w-old' });
	});

	test('ключ не вычислился (keyOf упал) → источник с пустым ключом, повтор считает ключ', async () => {
		const w = world({ keepSource: true });
		w.plane.failNext('listProjects', new PlaneApiError(503, 'GET', '/projects/'));
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]).toMatchObject({
			ok: false,
			error: 'plane_failed',
		});
		expect(w.store.getSource('acme', BOARD, '101')).toMatchObject({ key: '' });
		expect(w.miro.cardsOn(BOARD)).toEqual([]);
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]).toMatchObject({
			ok: true,
			key: 'LAB-1',
		});
	});

	test('два одновременных запроса на один стикер → одна задача и одна карточка', async () => {
		const w = world({ keepSource: false });
		const [a, b] = await Promise.all([
			convertItems(w.rt, w.store, req(['101']), w.log),
			convertItems(w.rt, w.store, req(['101']), w.log),
		]);
		expect(w.plane.createdItems).toHaveLength(1);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
		expect([a[0]?.ok, b[0]?.ok]).toEqual([true, false]);
		expect(b[0]).toMatchObject({ error: 'not_found' });
	});

	test('403, пришедший не от Miro, не становится board_no_access', async () => {
		const w = world();
		w.miro.failNext('createAppCard', new PlaneApiError(403, 'POST', '/x'));
		expect((await convertItems(w.rt, w.store, req(['101']), w.log))[0]).toMatchObject({
			ok: false,
			error: 'miro_failed',
		});
	});

	test('замки снимаются, когда запросы закончились (успех, ошибка, не найден)', async () => {
		const w = world({ keepSource: false });
		w.plane.failNext('createWorkItem', new PlaneApiError(503, 'POST', '/x'));
		await Promise.all([
			convertItems(w.rt, w.store, req(['101']), w.log),
			convertItems(w.rt, w.store, req(['101', '102', '999']), w.log),
		]);
		await new Promise((resolve) => setImmediate(resolve));
		expect(lockedItems()).toBe(0);
	});

	test('третий запрос ждёт второго, даже когда первый уже закончился', async () => {
		const w = world({ keepSource: true });
		const read = w.miro.getItem.bind(w.miro);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		let reads = 0;
		// the second getItem (the second request, after the first finished) stands until released
		w.miro.getItem = async (boardId, itemId) => {
			if (++reads === 2) await gate;
			return read(boardId, itemId);
		};
		const first = convertItems(w.rt, w.store, req(['101']), w.log);
		const second = convertItems(w.rt, w.store, req(['101']), w.log);
		await first;
		await new Promise((resolve) => setImmediate(resolve));
		expect(reads).toBe(2);
		const third = convertItems(w.rt, w.store, req(['101']), w.log);
		await new Promise((resolve) => setImmediate(resolve));
		expect(reads).toBe(2);
		release();
		await Promise.all([second, third]);
		expect(reads).toBe(3);
		expect(w.miro.cardsOn(BOARD)).toHaveLength(1);
	});

	test('замок снимается после ошибки: следующий запрос на тот же стикер идёт', async () => {
		const w = world({ keepSource: false });
		w.plane.failNext('createWorkItem', new PlaneApiError(503, 'POST', '/x'));
		const [a, b] = await Promise.all([
			convertItems(w.rt, w.store, req(['101']), w.log),
			convertItems(w.rt, w.store, req(['101']), w.log),
		]);
		expect(a[0]).toMatchObject({ ok: false, error: 'plane_failed' });
		expect(b[0]?.ok).toBe(true);
		expect((await convertItems(w.rt, w.store, req(['102']), w.log))[0]?.ok).toBe(true);
	});

	test('замок по стикеру: запрос на другой доске не ждёт зависший запрос первой', async () => {
		const w = world({ keepSource: false });
		const other = w.miro.addBoard('other=', 'Другая');
		other.items.set('101', sticky('101', '<p>Тоже 101</p>', 1, 1, null));
		const read = w.miro.getItem.bind(w.miro);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		w.miro.getItem = async (boardId, itemId) => {
			if (boardId === BOARD) await gate;
			return read(boardId, itemId);
		};
		const held = convertItems(w.rt, w.store, req(['101']), w.log);
		const free = await convertItems(
			w.rt,
			w.store,
			req(['101'], { boardId: 'other=', boardName: 'Другая' }),
			w.log,
		);
		expect(free[0]?.ok).toBe(true);
		release();
		expect((await held)[0]?.ok).toBe(true);
	});

	test('стикер на другой доске того же тенанта не мешает: ключи по доске', async () => {
		const w = world({ keepSource: false });
		const other = w.miro.addBoard('other=', 'Другая');
		other.items.set('101', sticky('101', '<p>Тоже 101</p>', 1, 1, null));
		const [a, b] = await Promise.all([
			convertItems(w.rt, w.store, req(['101']), w.log),
			convertItems(w.rt, w.store, req(['101'], { boardId: 'other=', boardName: 'Другая' }), w.log),
		]);
		expect([a[0]?.ok, b[0]?.ok]).toEqual([true, true]);
		expect(w.plane.createdItems).toHaveLength(2);
	});
});
