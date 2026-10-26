import { describe, expect, test } from 'bun:test';

import { MiroApiError, MiroNotConnected } from '../src/miro/rest.ts';
import { createApi } from '../src/api.ts';
import { PlaneAuthError } from '../src/plane/auth.ts';
import { PlaneApiError } from '../src/plane/client.ts';
import { BOARD, jwt, MIRO_WRITES, NOW_SEC, seedItem, world } from './world.ts';

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as unknown });
const convertBody = (over: Record<string, unknown> = {}) => ({
	boardId: BOARD,
	projectId: 'p1',
	author: 'Аня',
	itemIds: ['101'],
	...over,
});

describe('JWT и команда', () => {
	test('без JWT, с чужой подписью, просроченный, не Bearer → 401; ни одного вызова Plane и Miro', async () => {
		const w = world();
		const tokens = [
			null,
			'garbage',
			jwt({}, 'чужой-секрет'),
			jwt({ exp: NOW_SEC - 1 }),
			jwt({ sub: 'чужое-приложение' }),
		];
		for (const token of tokens) {
			for (const [method, path, body] of [
				['GET', '/miro/api/projects'],
				['GET', '/miro/api/search?q=LAB-1'],
				['POST', '/miro/api/convert', convertBody()],
				['POST', '/miro/api/bind', {}],
				['GET', `/miro/api/card?board=${BOARD}&item=1`],
			] as const) {
				const res = await w.call(method, path, { token, ...(body ? { body } : {}) });
				expect([res.status, await res.json()], `${method} ${path}`).toEqual([
					401,
					{ error: 'unauthorized' },
				]);
			}
		}
		const basic = await w.call('GET', '/miro/api/projects', {
			token: null,
			headers: { authorization: `Basic ${jwt()}` },
		});
		expect(basic.status).toBe(401);
		expect(w.plane.calls).toEqual([]);
		expect(w.miro.calls).toEqual([]);
		expect(w.store.getSource('acme', BOARD, '101')).toBeNull();
	});

	test('ответы — application/json; charset=utf-8', async () => {
		const w = world();
		for (const res of [
			await w.call('GET', '/miro/api/projects'),
			await w.call('GET', '/miro/api/projects', { token: null }),
		])
			expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
	});

	test('команда не наша → 403 unknown_team, в логе только команда', async () => {
		const w = world();
		const res = await w.call('GET', '/miro/api/projects', { token: jwt({ team: '999' }) });
		expect(await json(res)).toEqual({ status: 403, body: { error: 'unknown_team' } });
		expect(w.logs).toEqual([{ event: 'api.unknown_team', team: '999' }]);
		expect(w.plane.calls).toEqual([]);
		expect(w.miro.calls).toEqual([]);
	});

	test('неизвестный путь → 404, чужой метод → 405', async () => {
		const w = world();
		expect((await json(await w.call('GET', '/miro/api/nothing'))).status).toBe(404);
		expect(await json(await w.call('GET', '/miro/api/convert'))).toEqual({
			status: 405,
			body: { error: 'method_not_allowed' },
		});
		expect((await w.call('POST', '/miro/api/projects', { body: {} })).status).toBe(405);
		expect((await w.call('POST', '/miro/api/search?q=a', { body: {} })).status).toBe(405);
		expect((await w.call('POST', '/miro/api/card', { body: {} })).status).toBe(405);
		expect((await w.call('GET', '/miro/api/bind')).status).toBe(405);
	});
});

describe('часы по умолчанию', () => {
	test('без nowSec берутся настоящие секунды: живой токен проходит, просроченный 10 дней назад — 401', async () => {
		const w = world();
		const api = createApi({
			config: w.config,
			runtimes: new Map([[w.tenant.id, w.rt]]),
			store: w.store,
			log: w.log,
		});
		const get = (token: string) =>
			api(
				new Request('http://x/miro/api/projects', {
					headers: { authorization: `Bearer ${token}` },
				}),
				new URL('http://x/miro/api/projects'),
			);
		const nowSec = Math.floor(Date.now() / 1000);
		expect((await get(jwt({ exp: nowSec + 600 }))).status).toBe(200);
		expect((await get(jwt({ exp: nowSec - 10 * 86_400 }))).status).toBe(401);
	});
});

describe('GET /miro/api/projects', () => {
	test('скрытого и архивного проекта нет, keepSource тенанта в ответе', async () => {
		for (const keepSource of [true, false]) {
			const w = world({ keepSource, hiddenProjects: ['p-hidden'] });
			expect(await json(await w.call('GET', '/miro/api/projects'))).toEqual({
				status: 200,
				body: {
					projects: [{ id: 'p1', identifier: 'LAB', name: 'Лаборатория', archived: false }],
					keepSource,
				},
			});
		}
	});
});

describe('GET /miro/api/search', () => {
	const setup = () => {
		const w = world({ hiddenProjects: ['p-hidden'] });
		seedItem(w.plane, 'w-ex', { name: 'Починить насос' });
		seedItem(w.plane, 'w-hid', { projectId: 'p-hidden', sequenceId: 5, name: 'Починить секрет' });
		return w;
	};

	test('ключ → одна задача; регистр не важен', async () => {
		const w = setup();
		for (const q of ['LAB-7', ' lab-7 ']) {
			expect(
				await json(await w.call('GET', `/miro/api/search?q=${encodeURIComponent(q)}`)),
			).toEqual({
				status: 200,
				body: { items: [{ id: 'w-ex', projectId: 'p1', key: 'LAB-7', name: 'Починить насос' }] },
			});
		}
		expect(w.plane.calls.filter((c) => c === 'searchWorkItems')).toEqual([]);
	});

	test('нет такого ключа → пустой список', async () => {
		const w = setup();
		expect((await json(await w.call('GET', '/miro/api/search?q=LAB-99'))).body).toEqual({
			items: [],
		});
	});

	test('задача скрытого проекта не находится ни по ключу, ни по тексту', async () => {
		const w = setup();
		expect((await json(await w.call('GET', '/miro/api/search?q=HID-5'))).body).toEqual({
			items: [],
		});
		const byText = (
			await json(await w.call('GET', `/miro/api/search?q=${encodeURIComponent('Починить')}`))
		).body as { items: { id: string }[] };
		expect(byText.items.map((i) => i.id)).toEqual(['w-ex']);
	});

	test('текстовый поиск: не больше 20 результатов', async () => {
		const w = setup();
		for (let i = 0; i < 25; i++)
			seedItem(w.plane, `w-${i}`, { sequenceId: 100 + i, name: `нужная ${i}` });
		const body = (
			await json(await w.call('GET', `/miro/api/search?q=${encodeURIComponent('нужная')}`))
		).body as { items: { id: string }[] };
		expect(body.items).toHaveLength(20);
		expect(body.items[0]?.id).toBe('w-0');
	});

	test('запрос не по ключу идёт текстовым поиском; ключ с лишним — тоже', async () => {
		const w = setup();
		await w.call('GET', `/miro/api/search?q=${encodeURIComponent('LAB-7 насос')}`);
		await w.call('GET', '/miro/api/search?q=LAB-1234567890');
		await w.call('GET', '/miro/api/search?q=насос');
		expect(w.plane.calls.filter((c) => c === 'getWorkItemByKey')).toEqual([]);
		expect(w.plane.calls.filter((c) => c === 'searchWorkItems')).toHaveLength(3);
	});

	test('пустой, пробельный, отсутствующий и слишком длинный q → 400 bad_request, Plane не трогают', async () => {
		const w = setup();
		for (const path of [
			'/miro/api/search?q=',
			'/miro/api/search?q=%20%20',
			'/miro/api/search',
			`/miro/api/search?q=${'a'.repeat(101)}`,
		])
			expect(await json(await w.call('GET', path)), path).toEqual({
				status: 400,
				body: { error: 'bad_request' },
			});
		expect(w.plane.calls).toEqual([]);
		expect((await w.call('GET', `/miro/api/search?q=${'a'.repeat(100)}`)).status).toBe(200);
	});
});

describe('POST /miro/api/convert', () => {
	test('успех: результаты по элементам, название доски из getBoard', async () => {
		const w = world({ keepSource: false });
		const { status, body } = await json(
			await w.call('POST', '/miro/api/convert', { body: convertBody({ itemIds: ['101', '77'] }) }),
		);
		expect(status).toBe(200);
		expect(body).toEqual({
			results: [
				{ itemId: '101', ok: true, key: 'LAB-1', cardId: expect.any(String) },
				{ itemId: '77', ok: false, error: 'unsupported_type' },
			],
		});
		expect(w.plane.links.get('fake-w-1')?.[0]?.title).toBe('Miro: Доска / Фрейм');
	});

	test('доска не видна служебному аккаунту → 409 board_no_access, задач нет', async () => {
		const w = world();
		w.miro.noAccess.add(BOARD);
		expect(await json(await w.call('POST', '/miro/api/convert', { body: convertBody() }))).toEqual({
			status: 409,
			body: { error: 'board_no_access' },
		});
		expect(w.plane.createdItems).toEqual([]);
		expect(w.miro.calls.filter((c) => MIRO_WRITES.includes(c))).toEqual([]);
	});

	test('токена Miro нет → 503 miro_not_connected', async () => {
		const w = world();
		w.miro.failNext('getBoard', new MiroNotConnected());
		expect(await json(await w.call('POST', '/miro/api/convert', { body: convertBody() }))).toEqual({
			status: 503,
			body: { error: 'miro_not_connected' },
		});
	});

	test('токен Miro пропал посреди запроса → 503, а не результат элемента', async () => {
		const w = world();
		w.miro.failNext('getItem', new MiroNotConnected());
		expect((await w.call('POST', '/miro/api/convert', { body: convertBody() })).status).toBe(503);
	});

	test('скрытый, архивный или чужой проект → 400 unknown_project', async () => {
		const w = world({ hiddenProjects: ['p-hidden'] });
		for (const projectId of ['p-hidden', 'p-arch', 'нет-такого']) {
			expect(
				await json(await w.call('POST', '/miro/api/convert', { body: convertBody({ projectId }) })),
				projectId,
			).toEqual({ status: 400, body: { error: 'unknown_project' } });
		}
		expect(w.miro.calls).toEqual([]);
		expect(w.plane.createdItems).toEqual([]);
	});

	test('51 элемент, повтор id, нецифровой id, плохая доска, плохое тело → 400 bad_request; ни одного вызова', async () => {
		const w = world();
		const many = Array.from({ length: 51 }, (_, i) => String(1000 + i));
		const cases: Array<[string, unknown]> = [
			['51 элемент', convertBody({ itemIds: many })],
			['повтор id', convertBody({ itemIds: ['101', '101'] })],
			['нецифровой id', convertBody({ itemIds: ['10a'] })],
			['id из 25 цифр', convertBody({ itemIds: ['1'.repeat(25)] })],
			['id не строка', convertBody({ itemIds: [101] })],
			['пустой список', convertBody({ itemIds: [] })],
			['itemIds не массив', convertBody({ itemIds: '101' })],
			['доска с косой чертой', convertBody({ boardId: 'a/b' })],
			['доска 65 символов', convertBody({ boardId: 'a'.repeat(65) })],
			['доска не строка', convertBody({ boardId: 7 })],
			['projectId не строка', convertBody({ projectId: 7 })],
			['author не строка', convertBody({ author: 7 })],
			['author длиннее 100', convertBody({ author: 'я'.repeat(101) })],
			['массив вместо объекта', []],
			['null', null],
		];
		for (const [name, body] of cases)
			expect(await json(await w.call('POST', '/miro/api/convert', { body })), name).toEqual({
				status: 400,
				body: { error: 'bad_request' },
			});
		for (const raw of ['{', '', 'не json', 'null', '7', '"s"', 'true', '[]', '[{"boardId":"b"}]'])
			expect(await json(await w.call('POST', '/miro/api/convert', { raw })), raw).toEqual({
				status: 400,
				body: { error: 'bad_request' },
			});
		expect(w.plane.calls).toEqual([]);
		expect(w.miro.calls).toEqual([]);
	});

	test('границы: 50 элементов проходят, id из 24 цифр и доска из 64 символов — тоже', async () => {
		const w = world();
		const fifty = Array.from({ length: 50 }, (_, i) => String(2000 + i));
		w.miro.addBoard('b'.repeat(64));
		const res = await w.call('POST', '/miro/api/convert', {
			body: convertBody({ itemIds: fifty }),
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { results: unknown[] }).results).toHaveLength(50);
		const wide = await w.call('POST', '/miro/api/convert', {
			body: convertBody({ boardId: 'b'.repeat(64), itemIds: ['1'.repeat(24)] }),
		});
		expect(wide.status).toBe(200);
	});

	test('author: пустой → «участник Miro», пробелы обрезаются, 100 символов проходят', async () => {
		const w = world();
		await w.call('POST', '/miro/api/convert', { body: convertBody({ author: '   ' }) });
		await w.call('POST', '/miro/api/convert', {
			body: convertBody({ author: '  Борис  ', itemIds: ['102'] }),
		});
		const descs = w.plane.createdItems.map((i) => i.item.description_html);
		expect(descs[0]?.endsWith('<p>С доски Miro: участник Miro</p>')).toBe(true);
		expect(descs[1]?.endsWith('<p>С доски Miro: Борис</p>')).toBe(true);
		const edge = await w.call('POST', '/miro/api/convert', {
			body: convertBody({ author: 'я'.repeat(100), itemIds: ['999'] }),
		});
		expect(edge.status).toBe(200);
	});

	test('тело больше 64 KiB → 413 (по заголовку и по потоку)', async () => {
		const w = world();
		const big = JSON.stringify(convertBody({ author: 'я'.repeat(70_000) }));
		expect(await json(await w.call('POST', '/miro/api/convert', { raw: big }))).toEqual({
			status: 413,
			body: { error: 'too_large' },
		});
		const declared = await w.call('POST', '/miro/api/convert', {
			raw: '{}',
			headers: { 'content-length': String(65 * 1024) },
		});
		expect(declared.status).toBe(413);
		// ASCII body of an exact size: one byte over the limit is refused, the limit itself passes
		const sized = (n: number) => {
			const base = JSON.stringify(convertBody({ author: '' })).length;
			return JSON.stringify(convertBody({ author: ' '.repeat(n - base) }));
		};
		expect(sized(64 * 1024 + 1).length).toBe(64 * 1024 + 1);
		expect((await w.call('POST', '/miro/api/convert', { raw: sized(64 * 1024 + 1) })).status).toBe(
			413,
		);
		expect(sized(64 * 1024).length).toBe(64 * 1024);
		expect((await w.call('POST', '/miro/api/convert', { raw: sized(64 * 1024) })).status).toBe(200);
		// only the request that fits created something
		expect(w.plane.createdItems).toHaveLength(1);
	});

	test('ошибка Plane вне элементов → 502 plane_failed, в логе api.failed без тел', async () => {
		const w = world();
		w.plane.failNext('listProjects', new PlaneApiError(503, 'GET', '/projects/'));
		expect(await json(await w.call('POST', '/miro/api/convert', { body: convertBody() }))).toEqual({
			status: 502,
			body: { error: 'plane_failed' },
		});
		expect(w.logs).toEqual([
			{
				event: 'api.failed',
				level: 'error',
				tenant: 'acme',
				route: 'convert',
				error: 'plane_failed',
				detail: 'Plane GET /projects/ → 503',
			},
		]);
	});

	test('ошибка Miro вне элементов → 502 miro_failed', async () => {
		const w = world();
		w.miro.failNext('getBoard', new MiroApiError(503, 'GET', '/v2/boards/{board}'));
		expect(await json(await w.call('POST', '/miro/api/convert', { body: convertBody() }))).toEqual({
			status: 502,
			body: { error: 'miro_failed' },
		});
		expect(w.plane.createdItems).toEqual([]);
	});

	test('ошибка авторизации Plane вне элементов → 502 plane_failed', async () => {
		const w = world();
		w.plane.failNext('listProjects', new PlaneAuthError(401));
		expect(await json(await w.call('GET', '/miro/api/projects'))).toEqual({
			status: 502,
			body: { error: 'plane_failed' },
		});
		expect(w.logs[0]).toMatchObject({
			event: 'api.failed',
			route: 'projects',
			detail: expect.any(String),
		});
	});

	test('чужая ошибка (баг) не маскируется под plane_failed', async () => {
		const w = world();
		w.plane.failNext('listProjects', new TypeError('bug'));
		await expect(w.call('POST', '/miro/api/convert', { body: convertBody() })).rejects.toThrow(
			'bug',
		);
	});
});

describe('POST /miro/api/bind', () => {
	const body = (over: Record<string, unknown> = {}) => ({
		boardId: BOARD,
		itemId: '101',
		workItemId: 'w-ex',
		projectId: 'p1',
		author: 'Аня',
		...over,
	});

	test('привязка: result с ключом и карточкой', async () => {
		const w = world({ keepSource: false });
		seedItem(w.plane, 'w-ex');
		expect(await json(await w.call('POST', '/miro/api/bind', { body: body() }))).toEqual({
			status: 200,
			body: { result: { itemId: '101', ok: true, key: 'LAB-7', cardId: expect.any(String) } },
		});
		expect(w.plane.createdComments).toHaveLength(1);
		expect(w.plane.links.get('w-ex')?.[0]?.title).toBe('Miro: Доска / Фрейм');
	});

	test('нет такой задачи → 200 с ошибкой элемента', async () => {
		const w = world();
		expect(
			(
				await json(
					await w.call('POST', '/miro/api/bind', { body: body({ workItemId: 'missing' }) }),
				)
			).body,
		).toEqual({ result: { itemId: '101', ok: false, error: 'not_found' } });
	});

	test('плохие поля → 400; скрытый проект → unknown_project; доска не видна → 409', async () => {
		const w = world({ hiddenProjects: ['p-hidden'] });
		for (const over of [{ itemId: 'x' }, { workItemId: 7 }, { boardId: '' }, { workItemId: '' }])
			expect(
				(await json(await w.call('POST', '/miro/api/bind', { body: body(over) }))).body,
			).toEqual({ error: 'bad_request' });
		expect(
			(
				await json(
					await w.call('POST', '/miro/api/bind', { body: body({ projectId: 'p-hidden' }) }),
				)
			).body,
		).toEqual({ error: 'unknown_project' });
		expect(w.miro.calls).toEqual([]);
		w.miro.noAccess.add(BOARD);
		expect(await json(await w.call('POST', '/miro/api/bind', { body: body() }))).toEqual({
			status: 409,
			body: { error: 'board_no_access' },
		});
	});
});

describe('GET /miro/api/card', () => {
	const setup = () => {
		const w = world({ hiddenProjects: ['p-hidden'] });
		seedItem(w.plane, 'w-ex', { assignees: ['u1', 'u2'], stateId: 's-started', name: 'Починить' });
		w.store.putCard({
			tenant: 'acme',
			boardId: BOARD,
			cardId: '555',
			workItemId: 'w-ex',
			projectId: 'p1',
			fieldsHash: null,
		});
		return w;
	};
	const path = (item = '555', board = BOARD) =>
		`/miro/api/card?board=${encodeURIComponent(board)}&item=${item}`;

	test('своя карточка → ключ, название, статус, исполнители, ссылка', async () => {
		const w = setup();
		expect(await json(await w.call('GET', path()))).toEqual({
			status: 200,
			body: {
				key: 'LAB-7',
				name: 'Починить',
				state: 'In Progress',
				assignees: ['Аня', 'Борис'],
				url: 'https://plane.example.com/example-ws/browse/LAB-7/',
			},
		});
	});

	test('статус неизвестен → «—»', async () => {
		const w = setup();
		w.plane.items.get('w-ex')!.stateId = 'нет';
		expect(((await json(await w.call('GET', path()))).body as { state: string }).state).toBe('—');
	});

	test('карточка другого тенанта, неизвестная, скрытого проекта, удалённой задачи → 404 unknown_card', async () => {
		const w = setup();
		w.store.putCard({
			tenant: 'beta',
			boardId: BOARD,
			cardId: '556',
			workItemId: 'w-ex',
			projectId: 'p1',
			fieldsHash: null,
		});
		seedItem(w.plane, 'w-hid', { projectId: 'p-hidden' });
		w.store.putCard({
			tenant: 'acme',
			boardId: BOARD,
			cardId: '557',
			workItemId: 'w-hid',
			projectId: 'p-hidden',
			fieldsHash: null,
		});
		w.store.putCard({
			tenant: 'acme',
			boardId: BOARD,
			cardId: '558',
			workItemId: 'w-gone',
			projectId: 'p1',
			fieldsHash: null,
		});
		for (const item of ['556', '999', '557', '558'])
			expect(await json(await w.call('GET', path(item))), item).toEqual({
				status: 404,
				body: { error: 'unknown_card' },
			});
	});

	test('без board или item, с мусором в них → 400 bad_request', async () => {
		const w = setup();
		for (const p of [
			'/miro/api/card',
			`/miro/api/card?board=${BOARD}`,
			'/miro/api/card?item=555',
			'/miro/api/card?board=a%2Fb&item=555',
			`/miro/api/card?board=${BOARD}&item=5x`,
		])
			expect((await json(await w.call('GET', p))).body, p).toEqual({ error: 'bad_request' });
	});
});
