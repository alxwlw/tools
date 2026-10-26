import { describe, expect, test } from 'bun:test';
import { isRetryable } from '../src/queue.ts';
import { MiroApiError, MiroClient, MiroNotConnected, type AppCardInput } from '../src/miro/rest.ts';
import { apiFixture } from './fixtures.ts';

const BOARD = 'uXjVb1=';
type Sent = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
	timeoutSignal: boolean;
};
type Spec = { status: number; text: string };
type Reply = Spec | Error;
const json = (body: unknown, status = 200): Spec => ({ status, text: JSON.stringify(body) });

/** A client whose fetch answers from `replies` in order (the last one repeats) and records the requests. */
function client(replies: Reply[], token: string | null = 'tok') {
	const sent: Sent[] = [];
	const c = new MiroClient({
		token: () => token,
		fetch: async (url, init) => {
			sent.push({
				url,
				method: String(init.method),
				headers: init.headers as Record<string, string>,
				body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
				timeoutSignal: init.signal instanceof AbortSignal,
			});
			const r = replies[Math.min(sent.length, replies.length) - 1]!;
			if (r instanceof Error) throw r;
			return new Response(r.text, { status: r.status });
		},
	});
	return { c, sent };
}
const card: AppCardInput = { title: 'LAB-1 x', fields: [{ value: 'Todo' }], status: 'connected' };
const err = async (p: Promise<unknown>): Promise<MiroApiError> => {
	try {
		await p;
	} catch (e) {
		return e as MiroApiError;
	}
	throw new Error('did not throw');
};

describe('MiroClient', () => {
	test('каждый запрос с Bearer токеном служебного аккаунта', async () => {
		const { c, sent } = client([json(apiFixture('miro-board'))]);
		await c.getBoard(BOARD);
		expect(sent[0]!.headers.authorization).toBe('Bearer tok');
		expect(sent[0]!.headers.accept).toBe('application/json');
		expect(sent[0]!.timeoutSignal).toBe(true);
		expect(sent[0]!.method).toBe('GET');
		expect(sent[0]!.url).toBe('https://api.miro.com/v2/boards/uXjVb1%3D');
	});

	test('токена нет → MiroNotConnected, запросов нет', async () => {
		const { c: noToken, sent } = client([json({})], null);
		await expect(noToken.getBoard(BOARD)).rejects.toBeInstanceOf(MiroNotConnected);
		expect(sent.length).toBe(0);
	});

	test('getBoard: 200 → id и имя; 403 и 404 → null; 500 → ошибка', async () => {
		expect(await client([json(apiFixture('miro-board'))]).c.getBoard(BOARD)).toEqual({
			id: 'uXjVexample1=',
			name: 'Name1',
		});
		expect(await client([json({}, 403)]).c.getBoard(BOARD)).toBeNull();
		expect(await client([json({}, 404)]).c.getBoard(BOARD)).toBeNull();
		expect((await err(client([json({}, 500)]).c.getBoard(BOARD))).status).toBe(500);
	});

	test('getItem: стикер во фрейме → parentId и html из data.content', async () => {
		const { c, sent } = client([json(apiFixture('miro-sticky'))]);
		expect(await c.getItem(BOARD, '101')).toEqual({
			id: '3458764500000000001',
			type: 'sticky_note',
			html: 'Name1',
			x: 158.30241762547712,
			y: 160,
			width: 199,
			height: 228,
			parentId: '3458764500000000002',
		});
		expect(sent[0]!.url).toBe('https://api.miro.com/v2/boards/uXjVb1%3D/items/101');
		expect(await client([json({}, 404)]).c.getItem(BOARD, '101')).toBeNull();
	});

	test('getItem: карточка — заголовок и описание через <p>; элемент без родителя и размеров', async () => {
		const body = {
			id: '5',
			type: 'card',
			data: { title: 'T', description: 'D' },
			position: { x: 1, y: 2 },
		};
		expect(await client([json(body)]).c.getItem(BOARD, '5')).toEqual({
			id: '5',
			type: 'card',
			html: 'T<p>D',
			x: 1,
			y: 2,
			width: null,
			height: null,
			parentId: null,
		});
		const noDescription = { ...body, data: { title: 'T' } };
		expect((await client([json(noDescription)]).c.getItem(BOARD, '5'))!.html).toBe('T');
	});

	test('getItemTags: тело miro-tags.json → заголовки тегов', async () => {
		const { c, sent } = client([json(apiFixture('miro-tags'))]);
		expect(await c.getItemTags(BOARD, '101')).toEqual(['Name1']);
		expect(sent[0]!.url).toBe('https://api.miro.com/v2/boards/uXjVb1%3D/items/101/tags');
		expect(
			await client([json({ tags: [{ id: '1' }, 7, { title: 'b' }] })]).c.getItemTags(BOARD, '1'),
		).toEqual(['b']);
	});

	test('getFrameTitle: тело фрейма по OpenAPI (data.title) → заголовок; 404 → null', async () => {
		const { c, sent } = client([json({ id: '77', type: 'frame', data: { title: 'Спринт 1' } })]);
		expect(await c.getFrameTitle(BOARD, '77')).toBe('Спринт 1');
		expect(sent[0]!.url).toBe('https://api.miro.com/v2/boards/uXjVb1%3D/frames/77');
		expect(await client([json({}, 404)]).c.getFrameTitle(BOARD, '77')).toBeNull();
	});

	test('createAppCard: тело data{title, fields, status}, position, parent', async () => {
		const { c, sent } = client([json({ id: '900' }, 201)]);
		const id = await c.createAppCard(BOARD, card, { x: 1, y: 2, parentId: '77' });
		expect(id).toBe('900');
		expect(sent[0]!.method).toBe('POST');
		expect(sent[0]!.url).toBe('https://api.miro.com/v2/boards/uXjVb1%3D/app_cards');
		expect(sent[0]!.headers['content-type']).toBe('application/json');
		expect(sent[0]!.body).toEqual({
			data: { title: 'LAB-1 x', fields: [{ value: 'Todo' }], status: 'connected' },
			position: { x: 1, y: 2 },
			parent: { id: '77' },
		});
	});

	test('createAppCard: без фрейма в теле нет parent; ответ без id — ошибка', async () => {
		const { c, sent } = client([json({ id: '900' }, 201)]);
		await c.createAppCard(BOARD, card, { x: 0, y: 0, parentId: null });
		expect(sent[0]!.body).toEqual({ data: card, position: { x: 0, y: 0 } });
		await expect(
			client([json({}, 201)]).c.createAppCard(BOARD, card, { x: 0, y: 0, parentId: null }),
		).rejects.toThrow('no id');
	});

	test('updateAppCard: в data только переданные поля; 404 → gone', async () => {
		const { c, sent } = client([json({ id: '900' })]);
		expect(await c.updateAppCard(BOARD, '900', { status: 'disabled' })).toBe('ok');
		expect(sent[0]!.method).toBe('PATCH');
		expect(sent[0]!.url).toBe('https://api.miro.com/v2/boards/uXjVb1%3D/app_cards/900');
		expect(sent[0]!.body).toEqual({ data: { status: 'disabled' } });
		expect(await client([json({}, 404)]).c.updateAppCard(BOARD, '900', card)).toBe('gone');
		expect((await err(client([json({}, 403)]).c.updateAppCard(BOARD, '900', card))).status).toBe(
			403,
		);
	});

	test('listConnectors: две страницы по cursor', async () => {
		const page1 = apiFixture('miro-connectors') as { data: unknown[] };
		const page2 = {
			data: [
				{ id: 'c2', startItem: { id: 'a' } },
				{ id: 'c3', endItem: { id: 'b' } },
			],
		};
		const { c, sent } = client([json({ ...page1, cursor: 'CUR=' }), json(page2)]);
		expect(await c.listConnectors(BOARD)).toEqual([
			{
				id: '3458764500000000001',
				startItemId: '3458764500000000002',
				endItemId: '3458764500000000003',
			},
			{ id: 'c2', startItemId: 'a', endItemId: null },
			{ id: 'c3', startItemId: null, endItemId: 'b' },
		]);
		expect(sent.map((s) => s.url)).toEqual([
			'https://api.miro.com/v2/boards/uXjVb1%3D/connectors?limit=50',
			'https://api.miro.com/v2/boards/uXjVb1%3D/connectors?limit=50&cursor=CUR%3D',
		]);
	});

	test('listConnectors: один и тот же cursor не зацикливает', async () => {
		const page = { data: [{ id: 'c1' }], cursor: 'SAME' };
		const { c, sent } = client([json(page)]);
		expect((await c.listConnectors(BOARD)).length).toBe(2);
		expect(sent.length).toBe(2);
	});

	test('reattachConnector: PATCH с startItem или endItem', async () => {
		const { c, sent } = client([json({})]);
		await c.reattachConnector(BOARD, 'c1', 'start', '900');
		await c.reattachConnector(BOARD, 'c1', 'end', '901');
		expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([
			[
				'PATCH',
				'https://api.miro.com/v2/boards/uXjVb1%3D/connectors/c1',
				{ startItem: { id: '900' } },
			],
			[
				'PATCH',
				'https://api.miro.com/v2/boards/uXjVb1%3D/connectors/c1',
				{ endItem: { id: '901' } },
			],
		]);
		expect(
			(await err(client([json({}, 404)]).c.reattachConnector(BOARD, 'c1', 'end', '1'))).status,
		).toBe(404);
	});

	test('deleteItem: 404 — не ошибка; 500 — ошибка', async () => {
		const { c, sent } = client([json({}, 404)]);
		await c.deleteItem(BOARD, '101');
		expect([sent[0]!.method, sent[0]!.url]).toEqual([
			'DELETE',
			'https://api.miro.com/v2/boards/uXjVb1%3D/items/101',
		]);
		await client([{ status: 204, text: '' }]).c.deleteItem(BOARD, '101');
		expect((await err(client([json({}, 500)]).c.deleteItem(BOARD, '101'))).status).toBe(500);
	});

	test('tokenValid: 200 → true, 401 → false, 500 → ошибка', async () => {
		const { c, sent } = client([json({ type: 'oauth_token' })]);
		expect(await c.tokenValid()).toBe(true);
		expect(sent[0]!.url).toBe('https://api.miro.com/v1/oauth-token');
		expect(await client([json({}, 401)]).c.tokenValid()).toBe(false);
		expect((await err(client([json({}, 500)]).c.tokenValid())).status).toBe(500);
	});

	test('429 и 503 → MiroApiError со status; isRetryable — true; 403 — нет', async () => {
		const e429 = await err(client([json({}, 429)]).c.getItem(BOARD, '1'));
		const e503 = await err(client([json({}, 503)]).c.deleteItem(BOARD, '1'));
		expect(e429).toBeInstanceOf(MiroApiError);
		expect([e429.status, e503.status]).toEqual([429, 503]);
		expect(isRetryable(e429)).toBe(true);
		expect(isRetryable(e503)).toBe(true);
		expect(isRetryable(await err(client([json({}, 403)]).c.getItem(BOARD, '1')))).toBe(false);
	});

	test('обрыв и таймаут → MiroApiError(0); сообщение — метод и путь без id доски, без тела ответа', async () => {
		const down = await err(
			client([new TypeError('connect ECONNREFUSED')]).c.createAppCard(BOARD, card, {
				x: 0,
				y: 0,
				parentId: null,
			}),
		);
		expect(down.status).toBe(0);
		expect(isRetryable(down)).toBe(true);
		expect(down.message).toBe('Miro POST /v2/boards/{board}/app_cards → 0');
		const secret = await err(
			client([{ status: 500, text: 'SECRET-BODY' }]).c.getItem(BOARD, '101'),
		);
		expect(secret.message).toBe('Miro GET /v2/boards/{board}/items/101 → 500');
		const slow = new MiroClient({
			token: () => 'tok',
			timeoutMs: 5,
			fetch: (_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
				}),
		});
		const timeout = await err(slow.getBoard(BOARD));
		expect([timeout.status, timeout.message]).toEqual([0, 'Miro GET /v2/boards/{board} → 0']);
	});

	test('пустой токен — как отсутствующий', async () => {
		const { c, sent } = client([json({})], '');
		await expect(c.getBoard(BOARD)).rejects.toBeInstanceOf(MiroNotConnected);
		expect(sent.length).toBe(0);
	});

	test('ответ без полей: значения по умолчанию, не undefined', async () => {
		expect(await client([json({})]).c.getItem(BOARD, '1')).toEqual({
			id: '',
			type: '',
			html: '',
			x: 0,
			y: 0,
			width: null,
			height: null,
			parentId: null,
		});
		expect(await client([json({ type: 'app_card' })]).c.getItem(BOARD, '1')).toMatchObject({
			type: 'app_card',
			html: '',
		});
		expect(await client([json({ type: 'text', data: {} })]).c.getItem(BOARD, '1')).toMatchObject({
			html: '',
		});
		expect(await client([json({})]).c.getBoard(BOARD)).toEqual({ id: BOARD, name: '' });
		expect(await client([json({})]).c.getFrameTitle(BOARD, '7')).toBe('');
		expect(await client([json({})]).c.getItemTags(BOARD, '7')).toEqual([]);
		expect(await client([json({})]).c.listConnectors(BOARD)).toEqual([]);
	});

	test('app_card: заголовок и описание, как у card', async () => {
		const body = { type: 'app_card', data: { title: 'T', description: 'D' } };
		expect((await client([json(body)]).c.getItem(BOARD, '1'))!.html).toBe('T<p>D');
	});

	test('updateAppCard: title и fields уходят, когда заданы', async () => {
		const { c, sent } = client([json({})]);
		await c.updateAppCard(BOARD, '9', card);
		expect(sent[0]!.body).toEqual({ data: card });
		await c.updateAppCard(BOARD, '9', { title: 'only' });
		expect(sent[1]!.body).toEqual({ data: { title: 'only' } });
		await c.updateAppCard(BOARD, '9', { fields: [] });
		expect(sent[2]!.body).toEqual({ data: { fields: [] } });
	});

	test('createAppCard: пустой id в ответе — ошибка', async () => {
		const place = { x: 0, y: 0, parentId: null };
		await expect(
			client([json({ id: '' }, 201)]).c.createAppCard(BOARD, card, place),
		).rejects.toThrow('no id');
	});

	test('граница 2xx: 299 — успех, 300 — ошибка', async () => {
		expect(await client([{ status: 299, text: '{}' }]).c.updateAppCard(BOARD, '9', card)).toBe(
			'ok',
		);
		for (const status of [300])
			expect(
				(await err(client([{ status, text: '{}' }]).c.updateAppCard(BOARD, '9', card))).status,
			).toBe(status);
	});

	test('listConnectors: пустой cursor — конец; каждая страница одним запросом', async () => {
		const { c, sent } = client([json({ data: [{ id: 'c1' }], cursor: '' })]);
		expect((await c.listConnectors(BOARD)).length).toBe(1);
		expect(sent.length).toBe(1);
	});

	test('число в position вместо строки или NaN не принимается', async () => {
		const body = { id: '1', position: { x: 'a', y: null }, geometry: { width: '5' } };
		expect(await client([json(body)]).c.getItem(BOARD, '1')).toMatchObject({
			x: 0,
			y: 0,
			width: null,
		});
	});
});
