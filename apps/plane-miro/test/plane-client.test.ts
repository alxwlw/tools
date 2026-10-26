// Adapted from apps/plane-discord/test/plane-client.test.ts.
import { describe, expect, test } from 'bun:test';
import type { PlaneAuth } from '../src/plane/auth.ts';
import {
	PLANE_RATE_MAX,
	PLANE_RATE_WINDOW_MS,
	PlaneApiError,
	PlaneClient,
} from '../src/plane/client.ts';
import { isRetryable } from '../src/queue.ts';
import { apiFixture } from './fixtures.ts';

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
const link = { url: 'https://miro.com/app/board/uXjVexample1=/', title: 'Miro: Доска' };

describe('PlaneClient: 401 и повтор', () => {
	test('401 посреди работы: invalidate, новый токен, один повтор, успех', async () => {
		const { calls, client, state } = stub([
			{ status: 401, body: { detail: 'expired' } },
			{ status: 200, body: workItemRow },
		]);
		const item = await client.getWorkItem('p1', 'w1');
		expect(item?.id).toBe('w1');
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

describe('PlaneClient: создание и запись', () => {
	test('createWorkItem: 201 → created true; 409 → created false и id существующей', async () => {
		const item = {
			name: 'n',
			description_html: '<p>d</p>',
			external_id: 'b1:i1',
			external_source: 'miro',
		};
		const { calls, client } = stub([
			{ status: 201, body: { id: 'w1' } },
			{ status: 409, body: { id: 'w-old', error: 'exists' } },
		]);
		expect(await client.createWorkItem('p1', item)).toEqual({ id: 'w1', created: true });
		expect(await client.createWorkItem('p1', item)).toEqual({ id: 'w-old', created: false });
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/`);
		expect(calls[0]?.body).toEqual(item);
	});

	test('createComment: URL и тело; 409 → created false', async () => {
		const comment = { comment_html: '<p>c</p>', external_id: 'm1', external_source: 'miro' };
		const { calls, client } = stub([{ status: 409, body: { id: 'c0' } }]);
		expect(await client.createComment('p1', 'w1', comment)).toEqual({ id: 'c0', created: false });
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/comments/`);
		expect(calls[0]?.body).toEqual(comment);
	});

	test('updateDescription: PATCH work-items/<id>/ c description_html', async () => {
		const { calls, client } = stub([{ status: 200, body: workItemRow }]);
		await client.updateDescription('p1', 'w1', '<p>x</p>');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe('PATCH');
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/`);
		expect(calls[0]?.body).toEqual({ description_html: '<p>x</p>' });
	});

	test('updateDescription: 404 → PlaneApiError, а не тихий успех', async () => {
		const { client } = stub([{ status: 404 }]);
		const err = await failure(client.updateDescription('p1', 'gone', '<p>x</p>'));
		expect((err as PlaneApiError).status).toBe(404);
	});

	test('createLink: 201 → created, тело {url, title}', async () => {
		const { calls, client } = stub([{ status: 201, body: { id: 'l1' } }]);
		expect(await client.createLink('p1', 'w1', link)).toBe('created');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/links/`);
		expect(calls[0]?.body).toEqual(link);
	});

	test('createLink: 400 и такой URL уже есть в списке → exists', async () => {
		const { calls, client } = stub([
			{ status: 400, body: { error: 'url exists' } },
			{
				status: 200,
				body: [
					{ id: 'l0', url: 'https://other.example.com/' },
					{ id: 'l1', url: link.url },
				],
			},
		]);
		expect(await client.createLink('p1', 'w1', link)).toBe('exists');
		expect(calls[1]?.method).toBe('GET');
		expect(calls[1]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/links/?per_page=100`);
	});

	test('createLink: 400, а URL в списке нет → PlaneApiError 400', async () => {
		const { client } = stub([
			{ status: 400, body: { error: 'bad' } },
			{ status: 200, body: [{ id: 'l0', url: `${link.url}x` }] },
		]);
		const err = await failure(client.createLink('p1', 'w1', link));
		expect(err).toBeInstanceOf(PlaneApiError);
		expect(err).toMatchObject({ status: 400, method: 'POST' });
	});

	test('createLink: 400 и URL на второй странице списка → exists', async () => {
		const { calls, client } = stub([
			{ status: 400 },
			{
				status: 200,
				body: {
					results: [{ url: 'https://a.example.com/' }],
					next_page_results: true,
					next_cursor: 'c2',
				},
			},
			{ status: 200, body: { results: [{ url: link.url }], next_page_results: false } },
		]);
		expect(await client.createLink('p1', 'w1', link)).toBe('exists');
		expect(calls).toHaveLength(3);
	});

	test('createLink: другой статус (500) → ошибка, список не запрашивается', async () => {
		const { calls, client } = stub([{ status: 500 }]);
		expect(((await failure(client.createLink('p1', 'w1', link))) as PlaneApiError).status).toBe(
			500,
		);
		expect(calls).toHaveLength(1);
	});
});

describe('PlaneClient: чтение', () => {
	test('getWorkItem: 404 → null; найденная задача разобрана без priority', async () => {
		const { client } = stub([
			{ status: 404, raw: '<html>gone</html>' },
			{ status: 200, body: workItemRow },
		]);
		expect(await client.getWorkItem('p1', 'gone')).toBeNull();
		expect(await client.getWorkItem('p1', 'w1')).toEqual({
			id: 'w1',
			projectId: 'p1',
			sequenceId: 40,
			name: 'Task',
			stateId: 's1',
			assignees: ['u1', 'u2'],
			descriptionHtml: '<p>d</p>',
		});
	});

	test('getWorkItemByKey: 404 → null; найденная задача разобрана', async () => {
		const { calls, client } = stub([
			{ status: 404, raw: '<html>not found</html>' },
			{ status: 200, body: workItemRow },
		]);
		expect(await client.getWorkItemByKey('NOPE-1')).toBeNull();
		expect((await client.getWorkItemByKey('LAB-40'))?.sequenceId).toBe(40);
		expect(calls[0]?.url).toBe(`${ROOT}/work-items/NOPE-1/`);
	});

	test('searchWorkItems: ответ пробы → ключ из идентификатора проекта и номера', async () => {
		const { calls, client } = stub([{ status: 200, body: apiFixture('plane-search') }]);
		const hits = await client.searchWorkItems('x y');
		expect(calls[0]?.url).toBe(`${ROOT}/work-items/search/?search=x+y`);
		expect(hits[0]).toEqual({
			id: expect.any(String),
			projectId: expect.any(String),
			key: expect.stringMatching(/^[A-Z][A-Z0-9]*-\d+$/),
			name: expect.any(String),
		});
		// Distinct projects with the same number stay distinct hits.
		expect(hits.map((h) => h.key)).toEqual([
			'ACME-103',
			'ACME-102',
			'ACME-57',
			'BETA-57',
			'GAMMA-12',
			'DELTA-46',
		]);
		expect(hits[3]?.projectId).not.toBe(hits[2]?.projectId);
		expect(hits[3]?.name).toBe('Name4');
	});

	test('searchWorkItems: нет issues или строка без поля — ошибка формы, пустой список — []', async () => {
		const { client } = stub([
			{ status: 200, body: { issues: [] } },
			{ status: 200, body: { nope: 1 } },
			{ status: 200, body: { issues: [{ id: 'a', name: 'n', sequence_id: 1, project_id: 'p' }] } },
		]);
		expect(await client.searchWorkItems('q')).toEqual([]);
		expect(String(await failure(client.searchWorkItems('q')))).toContain('unexpected search shape');
		expect(String(await failure(client.searchWorkItems('q')))).toContain('project__identifier');
	});

	test('searchWorkItems: не-объекты в issues отбрасываются; строка без sequence_id — ошибка, а не NaN', async () => {
		const row = { id: 'a', name: 'n', sequence_id: 1, project__identifier: 'ACME', project_id: 'p' };
		const { client } = stub([
			{ status: 200, body: { issues: [null, 'x', [], row] } },
			{ status: 200, body: { issues: [{ ...row, sequence_id: '1' }] } },
		]);
		expect(await client.searchWorkItems('q')).toEqual([
			{ id: 'a', projectId: 'p', key: 'ACME-1', name: 'n' },
		]);
		expect(String(await failure(client.searchWorkItems('q')))).toContain('sequence_id');
	});

	test('findCommentByExternalId находит на второй странице', async () => {
		const { calls, client } = stub([
			{
				status: 200,
				body: {
					results: [{ id: 'c1', external_source: 'miro', external_id: 'other' }],
					next_page_results: true,
					next_cursor: 'cur-2',
				},
			},
			{
				status: 200,
				body: {
					results: [
						{ id: 'c2', external_source: 'github', external_id: 'm1' },
						{ id: 'c3', external_source: 'miro', external_id: 'm1' },
					],
					next_page_results: false,
				},
			},
		]);
		expect(await client.findCommentByExternalId('p1', 'w1', 'miro', 'm1')).toEqual({ id: 'c3' });
		expect(calls).toHaveLength(2);
		expect(calls[1]?.url).toBe(
			`${ROOT}/projects/p1/work-items/w1/comments/?per_page=100&cursor=cur-2`,
		);
	});

	test('findCommentByExternalId: нет такого → null', async () => {
		const { client } = stub([
			{ status: 200, body: [{ id: 'c1', external_id: 'a', external_source: 'miro' }] },
		]);
		expect(await client.findCommentByExternalId('p1', 'w1', 'miro', 'zzz')).toBeNull();
	});

	test('botUserId: app-installation → app_bot; второй вызов без запроса', async () => {
		const { calls, client } = stub([
			{ status: 200, body: [{ id: 'inst-1', app_bot: 'bot-1', status: 'x' }] },
		]);
		expect(await client.botUserId()).toBe('bot-1');
		expect(await client.botUserId()).toBe('bot-1');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://plane.test/auth/o/app-installation/?id=inst-1');
		expect(calls[0]?.headers.Authorization).toBe('Bearer tok-0');
	});

	test('botUserId: из массива берётся строка своей установки, а не первая; нет такой — ошибка', async () => {
		const { client } = stub([
			{
				status: 200,
				body: [
					{ id: 'other', app_bot: 'bot-X' },
					{ id: 'inst-1', app_bot: 'bot-1' },
				],
			},
		]);
		expect(await client.botUserId()).toBe('bot-1');
		const missing = stub([{ status: 200, body: [{ id: 'other', app_bot: 'bot-X' }] }]);
		expect(String(await failure(missing.client.botUserId()))).toContain('no row');
	});

	test('botUserId: сбой не запоминается, следующий вызов спрашивает снова', async () => {
		const { calls, client } = stub([{ status: 500 }, { status: 200, body: { app_bot: 'bot-1' } }]);
		await failure(client.botUserId());
		expect(await client.botUserId()).toBe('bot-1');
		expect(calls).toHaveLength(2);
	});

	test('listProjects, listStates, listMembers: поля переименованы (display_name → displayName), archived по archived_at', async () => {
		const { calls, client } = stub([
			{
				status: 200,
				body: [
					{ id: 'p1', identifier: 'LAB', name: 'Ops', archived_at: null, extra: 1 },
					{ id: 'p2', identifier: 'OLD', name: 'Old', archived_at: '2026-10-01T00:00:00Z' },
					{ id: 'p3', identifier: 'NEW', name: 'New' },
				],
			},
			{ status: 200, body: { results: [{ id: 's1', name: 'Done', group: 'completed' }] } },
			{
				status: 200,
				body: [
					{ id: 'u1', display_name: 'ann', is_bot: false },
					{
						id: 'u2',
						display_name: 'bo',
						avatar_url: 'https://cdn.example.com/a.png',
						avatar: 'x',
					},
					{ id: 'u3', display_name: 'cy', avatar: '/media/c.png' },
					{ id: 'u4', display_name: 'di', avatar_url: null },
					{ id: 'u5', display_name: 'ed', avatar_url: '', avatar: '/media/e.png' },
				],
			},
		]);
		expect(await client.listProjects()).toEqual([
			{ id: 'p1', identifier: 'LAB', name: 'Ops', archived: false },
			{ id: 'p2', identifier: 'OLD', name: 'Old', archived: true },
			{ id: 'p3', identifier: 'NEW', name: 'New', archived: false },
		]);
		expect(await client.listStates('p1')).toEqual([{ id: 's1', name: 'Done', group: 'completed' }]);
		expect(await client.listMembers()).toEqual([
			{ id: 'u1', displayName: 'ann', avatarUrl: null },
			{ id: 'u2', displayName: 'bo', avatarUrl: 'https://cdn.example.com/a.png' },
			{ id: 'u3', displayName: 'cy', avatarUrl: '/media/c.png' },
			{ id: 'u4', displayName: 'di', avatarUrl: null },
			{ id: 'u5', displayName: 'ed', avatarUrl: '/media/e.png' },
		]);
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

	test('id в путях экранируются', async () => {
		const { calls, client } = stub([
			{ status: 200, body: { ...workItemRow } },
			{ status: 200, body: [] },
			{ status: 201, body: { id: 'w' } },
			{ status: 200, body: [] },
			{ status: 201, body: { id: 'c' } },
			{ status: 404 },
			{ status: 200, body: workItemRow },
			{ status: 201 },
			{ status: 200, body: { issues: [] } },
		]);
		const comment = { comment_html: 'h', external_id: 'm1', external_source: 'miro' };
		await client.getWorkItem('p/1', 'w/1');
		await client.listStates('p/1');
		await client.createWorkItem('p/1', {
			name: 'n',
			description_html: 'h',
			external_id: 'm1',
			external_source: 'miro',
		});
		await client.findCommentByExternalId('p/1', 'w/1', 'miro', 'm1');
		await client.createComment('p/1', 'w/1', comment);
		await client.getWorkItemByKey('LAB/40');
		await client.updateDescription('p/1', 'w/1', 'h');
		await client.createLink('p/1', 'w/1', link);
		await client.searchWorkItems('a&b');
		expect(calls.map((c) => c.url)).toEqual([
			`${ROOT}/projects/p%2F1/work-items/w%2F1/`,
			`${ROOT}/projects/p%2F1/states/?per_page=100`,
			`${ROOT}/projects/p%2F1/work-items/`,
			`${ROOT}/projects/p%2F1/work-items/w%2F1/comments/?per_page=100`,
			`${ROOT}/projects/p%2F1/work-items/w%2F1/comments/`,
			`${ROOT}/work-items/LAB%2F40/`,
			`${ROOT}/projects/p%2F1/work-items/w%2F1/`,
			`${ROOT}/projects/p%2F1/work-items/w%2F1/links/`,
			`${ROOT}/work-items/search/?search=a%26b`,
		]);
		const wsUrls: string[] = [];
		const wsClient = new PlaneClient({
			baseUrl: 'https://plane.test/',
			workspace: 'ex/ws',
			auth: fakeAuth().auth,
			appInstallationId: 'inst-1',
			fetch: async (url: string): Promise<Response> => {
				wsUrls.push(url);
				return new Response('', { status: 404 });
			},
			limiter: { acquire: async () => {} },
		});
		await wsClient.getWorkItemByKey('LAB-1');
		expect(wsUrls).toEqual(['https://plane.test/api/v1/workspaces/ex%2Fws/work-items/LAB-1/']);
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
		expect((await client.getWorkItem('p1', 'w1'))?.assignees).toEqual(['u1']);
		expect(String(await failure(client.getWorkItem('p1', 'w1')))).toContain('Plane response: no');
		expect(String(await failure(client.getWorkItem('p1', 'w1')))).toContain('Plane response: no');
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
		const signals: Array<AbortSignal | null | undefined> = [];
		const { client } = limited((_u, init) => {
			signals.push(init.signal);
			return new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
			});
		}, 20);
		const error = await failure(client.listProjects());
		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(signals[0]?.aborted).toBe(true);
		expect(error).toBeInstanceOf(PlaneApiError);
		expect(error).toMatchObject({ status: 0, method: 'GET', path: '/projects/' });
	});

	test('отказ соединения и обрыв чтения тела — PlaneApiError со статусом 0, который очередь повторяет', async () => {
		const refused = limited(async () => {
			throw Object.assign(new TypeError('Unable to connect'), { code: 'ConnectionRefused' });
		}, 1000).client;
		const e1 = await failure(refused.listProjects());
		expect(e1).toBeInstanceOf(PlaneApiError);
		expect(e1).toMatchObject({ status: 0, method: 'GET', path: '/projects/' });
		expect(isRetryable(e1)).toBe(true);
		expect(String((e1 as Error).message)).not.toContain('connect');

		const cut = limited(
			async () =>
				({
					status: 200,
					ok: true,
					text: async () => {
						throw new DOMException('aborted', 'AbortError');
					},
				}) as unknown as Response,
			1000,
		).client;
		const e2 = await failure(cut.listProjects());
		expect(e2).toMatchObject({ status: 0, method: 'GET' });
		expect(e2).toBeInstanceOf(PlaneApiError);
	});
});
