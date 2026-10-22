import { describe, expect, test } from 'bun:test';
import type { PlaneAuth } from '../src/plane/auth.ts';
import {
	PLANE_RATE_MAX,
	PLANE_RATE_WINDOW_MS,
	PlaneApiError,
	PlaneClient,
} from '../src/plane/client.ts';

type Reply = { status: number; body?: unknown; raw?: string };
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

const ROOT = 'https://plane.test/api/v1/workspaces/example-ws';

/** Auth whose token is `tok-N`, N counting the invalidations so far. */
function fakeAuth() {
	const state = { invalidations: 0 };
	const auth: PlaneAuth = {
		headers: async () => ({ Authorization: `Bearer tok-${state.invalidations}` }),
		invalidate: () => {
			state.invalidations++;
		},
	};
	return { auth, state };
}

function stub(replies: Reply[]) {
	const calls: Call[] = [];
	const { auth, state } = fakeAuth();
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({
			url,
			method: init.method ?? 'GET',
			headers: init.headers as Record<string, string>,
			body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
		});
		const reply = replies.shift();
		if (!reply) throw new Error(`unexpected request ${init.method} ${url}`);
		const text = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
		return new Response(text, { status: reply.status });
	};
	const client = new PlaneClient({
		baseUrl: 'https://plane.test/',
		workspace: 'example-ws',
		auth,
		appInstallationId: 'inst-1',
		fetch,
		limiter: { acquire: async () => {} },
	});
	return { calls, client, state };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error('expected a rejection');
		},
		(err: unknown) => err,
	);
}

const workItemRow = {
	id: 'w1',
	project: 'p1',
	sequence_id: 40,
	name: 'Task',
	state: 's1',
	assignees: ['u1', 'u2'],
	priority: 'high',
	description_html: '<p>d</p>',
};

describe('PlaneClient: 401 и повтор', () => {
	test('401 посреди работы: invalidate, новый токен, один повтор, успех', async () => {
		const { calls, client, state } = stub([
			{ status: 401, body: { detail: 'expired' } },
			{ status: 200, body: workItemRow },
		]);
		const item = await client.getWorkItem('p1', 'w1');
		expect(item.id).toBe('w1');
		expect(state.invalidations).toBe(1);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.headers.Authorization).toBe('Bearer tok-0');
		expect(calls[1]?.headers.Authorization).toBe('Bearer tok-1');
		expect(calls[1]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/`);
	});

	test('два 401 подряд — PlaneApiError 401, третьего запроса нет', async () => {
		const { calls, client, state } = stub([
			{ status: 401 },
			{ status: 401 },
			{ status: 200, body: workItemRow },
		]);
		const err = await failure(client.getWorkItem('p1', 'w1'));
		expect(err).toBeInstanceOf(PlaneApiError);
		expect((err as PlaneApiError).status).toBe(401);
		expect(calls).toHaveLength(2);
		expect(state.invalidations).toBe(1);
	});
});

describe('PlaneClient: создание', () => {
	test('createWorkItem: 201 → created true; 409 → created false и id существующей', async () => {
		const item = {
			name: 'n',
			description_html: '<p>d</p>',
			external_id: 'm1',
			external_source: 'discord',
		};
		const { calls, client } = stub([
			{ status: 201, body: { id: 'w1' } },
			{ status: 409, body: { id: 'w0', error: 'exists' } },
		]);
		expect(await client.createWorkItem('p1', item)).toEqual({ id: 'w1', created: true });
		expect(await client.createWorkItem('p1', item)).toEqual({ id: 'w0', created: false });
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/`);
		expect(calls[0]?.body).toEqual(item);
	});

	test('createComment: URL и тело; 409 → created false', async () => {
		const comment = { comment_html: '<p>c</p>', external_id: 'm1', external_source: 'discord' };
		const { calls, client } = stub([{ status: 409, body: { id: 'c0' } }]);
		expect(await client.createComment('p1', 'w1', comment)).toEqual({ id: 'c0', created: false });
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/comments/`);
		expect(calls[0]?.body).toEqual(comment);
	});

	test('createRunActivity: POST runs/{id}/activities/ с type response и body', async () => {
		const { calls, client } = stub([{ status: 201, body: { id: 'a1' } }]);
		await client.createRunActivity('run 1', 'Готово');
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.url).toBe(`${ROOT}/runs/run%201/activities/`);
		expect(calls[0]?.body).toEqual({
			type: 'response',
			content: { type: 'response', body: 'Готово' },
		});
	});
});

describe('PlaneClient: чтение', () => {
	test('getWorkItemByKey: 404 → null; найденная задача разобрана', async () => {
		const { calls, client } = stub([
			{ status: 404, raw: '<html>not found</html>' },
			{ status: 200, body: workItemRow },
		]);
		expect(await client.getWorkItemByKey('NOPE-1')).toBeNull();
		expect(await client.getWorkItemByKey('LAB-40')).toEqual({
			id: 'w1',
			projectId: 'p1',
			sequenceId: 40,
			name: 'Task',
			stateId: 's1',
			assignees: ['u1', 'u2'],
			priority: 'high',
			descriptionHtml: '<p>d</p>',
		});
		expect(calls[0]?.url).toBe(`${ROOT}/work-items/NOPE-1/`);
	});

	test('getComment: поля из реального ответа GET комментария', async () => {
		const { calls, client } = stub([
			{
				status: 200,
				body: {
					id: 'c1',
					comment_html: '<p>hi</p>',
					actor: 'u9',
					external_source: 'discord',
					external_id: 'x7',
				},
			},
		]);
		expect(await client.getComment('p1', 'w1', 'c1')).toEqual({
			id: 'c1',
			html: '<p>hi</p>',
			actorId: 'u9',
			externalSource: 'discord',
			externalId: 'x7',
		});
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/comments/c1/`);
	});

	test('findWorkItemByExternalId: фильтр в query; 404 → null', async () => {
		const { calls, client } = stub([{ status: 200, body: { id: 'w5' } }, { status: 404 }]);
		expect(await client.findWorkItemByExternalId('p1', 'discord', 'm 1')).toEqual({ id: 'w5' });
		expect(await client.findWorkItemByExternalId('p1', 'discord', 'm2')).toBeNull();
		expect(calls[0]?.url).toBe(
			`${ROOT}/projects/p1/work-items/?external_id=m+1&external_source=discord`,
		);
	});

	test('findCommentByExternalId находит на второй странице', async () => {
		const { calls, client } = stub([
			{
				status: 200,
				body: {
					results: [{ id: 'c1', external_source: 'discord', external_id: 'other' }],
					next_page_results: true,
					next_cursor: 'cur-2',
				},
			},
			{
				status: 200,
				body: {
					results: [
						{ id: 'c2', external_source: 'github', external_id: 'm1' },
						{ id: 'c3', external_source: 'discord', external_id: 'm1' },
					],
					next_page_results: false,
				},
			},
		]);
		expect(await client.findCommentByExternalId('p1', 'w1', 'discord', 'm1')).toEqual({ id: 'c3' });
		expect(calls).toHaveLength(2);
		expect(calls[1]?.url).toBe(
			`${ROOT}/projects/p1/work-items/w1/comments/?per_page=100&cursor=cur-2`,
		);
	});

	test('findCommentByExternalId: нет такого → null', async () => {
		const { client } = stub([
			{ status: 200, body: [{ id: 'c1', external_id: 'a', external_source: 'discord' }] },
		]);
		expect(await client.findCommentByExternalId('p1', 'w1', 'discord', 'zzz')).toBeNull();
	});

	test('botUserId: app-installation → app_bot; второй вызов без запроса', async () => {
		const { calls, client } = stub([{ status: 200, body: [{ app_bot: 'bot-1', status: 'x' }] }]);
		expect(await client.botUserId()).toBe('bot-1');
		expect(await client.botUserId()).toBe('bot-1');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://plane.test/auth/o/app-installation/?id=inst-1');
		expect(calls[0]?.headers.Authorization).toBe('Bearer tok-0');
	});

	test('botUserId: сбой не запоминается, следующий вызов спрашивает снова', async () => {
		const { calls, client } = stub([{ status: 500 }, { status: 200, body: { app_bot: 'bot-1' } }]);
		await failure(client.botUserId());
		expect(await client.botUserId()).toBe('bot-1');
		expect(calls).toHaveLength(2);
	});

	test('getWorkItemModules: из двух модулей возвращает тот, в module-issues которого задача; задача на второй странице', async () => {
		const { calls, client } = stub([
			{ status: 200, body: { results: [{ id: 'other' }], next_page_results: false } },
			{
				status: 200,
				body: { results: [{ id: 'x' }], next_page_results: true, next_cursor: 'c2' },
			},
			{ status: 200, body: { results: [{ id: 'y' }, { id: 'w1' }], next_page_results: false } },
		]);
		expect(await client.getWorkItemModules('p1', 'w1', ['m-a', 'm-b'])).toEqual(['m-b']);
		expect(calls.map((c) => c.url)).toEqual([
			`${ROOT}/projects/p1/modules/m-a/module-issues/?per_page=100`,
			`${ROOT}/projects/p1/modules/m-b/module-issues/?per_page=100`,
			`${ROOT}/projects/p1/modules/m-b/module-issues/?per_page=100&cursor=c2`,
		]);
	});

	test('listProjects, listStates, listMembers: поля переименованы (display_name → displayName)', async () => {
		const { calls, client } = stub([
			{ status: 200, body: [{ id: 'p1', identifier: 'LAB', name: 'Ops', extra: 1 }] },
			{ status: 200, body: { results: [{ id: 's1', name: 'Done', group: 'completed' }] } },
			{ status: 200, body: [{ id: 'u1', display_name: 'ann', is_bot: false }] },
		]);
		expect(await client.listProjects()).toEqual([{ id: 'p1', identifier: 'LAB', name: 'Ops' }]);
		expect(await client.listStates('p1')).toEqual([{ id: 's1', name: 'Done', group: 'completed' }]);
		expect(await client.listMembers()).toEqual([{ id: 'u1', displayName: 'ann' }]);
		expect(calls[1]?.url).toBe(`${ROOT}/projects/p1/states/?per_page=100`);
		expect(calls[2]?.url).toBe(`${ROOT}/members/?per_page=100`);
	});
});

describe('PlaneClient: ошибки', () => {
	test('PlaneApiError несёт статус, метод и путь без query, без тела', async () => {
		const { client } = stub([{ status: 500, body: { detail: 'secret-body-xyz' } }]);
		const err = await failure(client.listProjects());
		expect(err).toBeInstanceOf(PlaneApiError);
		const api = err as PlaneApiError;
		expect([api.status, api.method, api.path]).toEqual([500, 'GET', '/projects/']);
		expect(api.message).toBe('Plane GET /projects/ → 500');
	});

	test('2xx не JSON — ошибка; список нестандартной формы — ошибка', async () => {
		const { client } = stub([
			{ status: 200, raw: '<html>' },
			{ status: 200, body: { unexpected: true } },
		]);
		expect(String(await failure(client.getWorkItem('p1', 'w1')))).toContain('not JSON');
		expect(String(await failure(client.listProjects()))).toContain('unexpected list shape');
	});

	test('задача без sequence_id — ошибка, а не 0', async () => {
		const { sequence_id: _drop, ...broken } = workItemRow;
		const { client } = stub([{ status: 200, body: broken }]);
		expect(String(await failure(client.getWorkItem('p1', 'w1')))).toContain('sequence_id');
	});
});

describe('PlaneClient: лимит запросов', () => {
	test('по умолчанию 50 за 60 с; без limiter запрос проходит', async () => {
		expect(PLANE_RATE_MAX).toBe(50);
		expect(PLANE_RATE_WINDOW_MS).toBe(60_000);
		const { auth } = fakeAuth();
		const client = new PlaneClient({
			baseUrl: 'https://plane.test',
			workspace: 'example-ws',
			auth,
			appInstallationId: 'inst-1',
			fetch: async () => new Response('[]', { status: 200 }),
		});
		expect(await client.listProjects()).toEqual([]);
	});
});

describe('PlaneClient: списки', () => {
	const projectRow = (id: string) => ({ id, identifier: id.toUpperCase(), name: id });

	test('курсоры: пока next_page_results true и курсор строка; стоп при false, при нестроковом курсоре', async () => {
		const { calls, client } = stub([
			{
				status: 200,
				body: { results: [projectRow('a')], next_page_results: true, next_cursor: 'c2' },
			},
			// next_page_results false with a cursor present: the list ends here.
			{
				status: 200,
				body: { results: [projectRow('b')], next_page_results: false, next_cursor: 'c3' },
			},
			{
				status: 200,
				body: { results: [projectRow('c')], next_page_results: true, next_cursor: null },
			},
		]);
		expect((await client.listProjects()).map((p) => p.id)).toEqual(['a', 'b']);
		expect(calls).toHaveLength(2);
		expect((await client.listProjects()).map((p) => p.id)).toEqual(['c']);
		expect(calls).toHaveLength(3);
	});

	test('страница, потом голый массив: строки обеих; не-объекты в списках отбрасываются', async () => {
		const { client } = stub([
			{
				status: 200,
				body: {
					results: [projectRow('a'), null, 'text', ['arr']],
					next_page_results: true,
					next_cursor: 'c2',
				},
			},
			{ status: 200, body: [projectRow('b'), 7, null, ['arr']] },
		]);
		expect((await client.listProjects()).map((p) => p.id)).toEqual(['a', 'b']);
	});

	test('пустое тело вместо списка — ошибка формы, а не TypeError', async () => {
		const { client } = stub([{ status: 200 }]);
		expect(String(await failure(client.listProjects()))).toContain('unexpected list shape');
	});

	test('больше 50 страниц — ошибка после ровно 50 запросов', async () => {
		let n = 0;
		const { auth } = fakeAuth();
		const client = new PlaneClient({
			baseUrl: 'https://plane.test',
			workspace: 'example-ws',
			auth,
			appInstallationId: 'inst-1',
			limiter: { acquire: async () => {} },
			fetch: async () => {
				n++;
				return new Response(
					JSON.stringify({ results: [], next_page_results: true, next_cursor: `c${n}` }),
					{ status: 200 },
				);
			},
		});
		expect(String(await failure(client.listProjects()))).toContain('more than 50 pages');
		expect(n).toBe(50);
	});

	test('getWorkItemModules узнаёт задачу по id, issue и issue_id', async () => {
		for (const row of [{ id: 'w1' }, { issue: 'w1' }, { issue_id: 'w1' }]) {
			const { client } = stub([{ status: 200, body: [row] }]);
			expect(await client.getWorkItemModules('p1', 'w1', ['m-a'])).toEqual(['m-a']);
		}
		const { client } = stub([{ status: 200, body: [{ id: 'x', issue: 'y', issue_id: 'z' }] }]);
		expect(await client.getWorkItemModules('p1', 'w1', ['m-a'])).toEqual([]);
	});

	test('поля: нет строки или пустая строка — ошибка; assignees фильтруются до строк', async () => {
		const { client } = stub([
			{ status: 200, body: [{ id: 'p1', identifier: '', name: 'n' }] },
			{ status: 200, body: [{ identifier: 'A', name: 'n' }] },
			{ status: 200, body: { ...workItemRow, assignees: ['u1', null, 5] } },
			{ status: 200, body: [] },
			{ status: 200 },
		]);
		expect(String(await failure(client.listProjects()))).toContain('"identifier"');
		expect(String(await failure(client.listProjects()))).toContain('"id"');
		expect((await client.getWorkItem('p1', 'w1')).assignees).toEqual(['u1']);
		expect(String(await failure(client.getWorkItem('p1', 'w1')))).toContain('Plane response: no');
		expect(String(await failure(client.getWorkItem('p1', 'w1')))).toContain('Plane response: no');
	});

	test('getComment: пустой или не строковый external_id → null', async () => {
		const base = { id: 'c1', comment_html: '<p>x</p>', actor: 'u1' };
		const { client } = stub([
			{ status: 200, body: { ...base, external_id: '', external_source: 7 } },
		]);
		const got = await client.getComment('p1', 'w1', 'c1');
		expect([got.externalId, got.externalSource]).toEqual([null, null]);
	});
});

describe('PlaneClient: лимитер и таймаут', () => {
	function limited(fetch: (u: string, i: RequestInit) => Promise<Response>, timeoutMs?: number) {
		const { auth } = fakeAuth();
		const acquired: string[] = [];
		const order: string[] = [];
		const client = new PlaneClient({
			baseUrl: 'https://plane.test',
			workspace: 'example-ws',
			auth,
			appInstallationId: 'inst-1',
			timeoutMs,
			fetch: async (u, i) => {
				order.push('fetch');
				return fetch(u, i);
			},
			limiter: {
				acquire: async () => {
					acquired.push('acquire');
					order.push('acquire');
				},
			},
		});
		return { client, acquired, order };
	}

	test('acquire перед каждым запросом, в том числе перед повтором после 401', async () => {
		const statuses = [401, 200];
		const { client, order } = limited(
			async () => new Response('[]', { status: statuses.shift() ?? 500 }),
		);
		await client.listProjects();
		expect(order).toEqual(['acquire', 'fetch', 'acquire', 'fetch']);
	});

	test('timeoutMs обрывает запрос, который не отвечает', async () => {
		const { client } = limited(
			(_u, init) =>
				new Promise<Response>((_resolve, reject) => {
					(init.signal as AbortSignal).addEventListener('abort', () =>
						reject(new Error('aborted')),
					);
				}),
			20,
		);
		expect(String(await failure(client.listProjects()))).toContain('aborted');
	});
});
