import type { PlaneAuth } from '@alxwlw/plane-app';
import { describe, expect, test } from 'bun:test';

import {
	apiKeyAuth,
	type NewRelease,
	type NewWorkItem,
	PLANE_HOOKS_SCOPES,
	PlaneApiError,
	PlaneClient,
	RELEASE_ITEMS_MAX,
} from '../src/plane.ts';

type Reply = { status: number; body?: unknown; raw?: string };
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

const ROOT = 'https://plane.test/api/v1/workspaces/example-ws';

function stub(replies: Reply[]) {
	const calls: Call[] = [];
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
		auth: apiKeyAuth('key-1'),
		fetch,
	});
	return { calls, client };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error('expected a rejection');
		},
		(err: unknown) => err,
	);
}

const item: NewWorkItem = {
	name: '[prod] ServiceDown',
	description_html: '<p>d</p>',
	priority: 'urgent',
	labels: ['label-1'],
	external_id: 'fp1',
	external_source: 'grafana',
};

describe('PlaneClient: создание с 409', () => {
	test('201 → created:true; URL, метод, ключ и тело запроса', async () => {
		const { calls, client } = stub([{ status: 201, body: { id: 'w1' } }]);
		expect(await client.createWorkItem('p1', item)).toEqual({ id: 'w1', created: true });
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/`);
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.headers['X-API-Key']).toBe('key-1');
		expect(calls[0]?.body).toEqual(item);
	});

	test('409 → created:false и id существующей задачи', async () => {
		const { client } = stub([{ status: 409, body: { error: 'exists', id: 'w0' } }]);
		expect(await client.createWorkItem('p1', item)).toEqual({ id: 'w0', created: false });
	});

	test('комментарий: 201 и 409', async () => {
		const comment = {
			comment_html: '<p>c</p>',
			external_id: 'fp1:t:firing',
			external_source: 'grafana',
		};
		const { calls, client } = stub([
			{ status: 201, body: { id: 'c1' } },
			{ status: 409, body: { error: 'exists', id: 'c1' } },
		]);
		expect(await client.createComment('p1', 'w1', comment)).toEqual({ id: 'c1', created: true });
		expect(await client.createComment('p1', 'w1', comment)).toEqual({ id: 'c1', created: false });
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/comments/`);
		expect(calls[0]?.body).toEqual(comment);
	});
});

describe('PlaneClient: поиск', () => {
	test('по external_id: 404 → null, 200 → id, параметры закодированы', async () => {
		const { calls, client } = stub([
			{ status: 404, body: { error: 'nope' } },
			{ status: 200, body: { id: 'w1' } },
		]);
		expect(
			await client.findWorkItemByExternalId('p1', 'vercel', 'deploy:prj:production:main'),
		).toBeNull();
		expect(
			await client.findWorkItemByExternalId('p1', 'vercel', 'deploy:prj:production:main'),
		).toEqual({ id: 'w1' });
		expect(calls[0]?.url).toBe(
			`${ROOT}/projects/p1/work-items/?external_id=deploy%3Aprj%3Aproduction%3Amain&external_source=vercel`,
		);
	});

	test('по ключу: 404 → null, 200 → ref', async () => {
		const { calls, client } = stub([
			{ status: 404, raw: '<html>not found</html>' },
			{
				status: 200,
				body: { id: 'w12', project: 'p-ops', state: 's1', sequence_id: 12, name: 'x' },
			},
		]);
		expect(await client.getWorkItemByKey('OPS-99')).toBeNull();
		expect(await client.getWorkItemByKey('OPS-12')).toEqual({
			id: 'w12',
			project: 'p-ops',
			state: 's1',
			sequenceId: 12,
		});
		expect(calls[1]?.url).toBe(`${ROOT}/work-items/OPS-12/`);
	});

	test('getWorkItem и смена состояния', async () => {
		const { calls, client } = stub([
			{ status: 200, body: { id: 'w1', project: 'p1', state: 's-done', sequence_id: 7 } },
			{ status: 200, body: { id: 'w1', project: 'p1', state: 's-backlog' } },
		]);
		expect(await client.getWorkItem('p1', 'w1')).toEqual({
			id: 'w1',
			project: 'p1',
			state: 's-done',
			sequenceId: 7,
		});
		await client.setWorkItemState('p1', 'w1', 's-backlog');
		expect(calls[1]?.method).toBe('PATCH');
		expect(calls[1]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/`);
		expect(calls[1]?.body).toEqual({ state: 's-backlog' });
	});
});

describe('PlaneClient: архив', () => {
	test('archiveWorkItem: POST /work-items/{id}/archive/ без тела, ключ в заголовке', async () => {
		const { calls, client } = stub([{ status: 200, body: { archived_at: '2026-10-21' } }]);
		await client.archiveWorkItem('p1', 'w1');
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/archive/`);
		expect(calls[0]?.headers['X-API-Key']).toBe('key-1');
		expect(calls[0]?.body).toBeUndefined();
	});

	test('archiveWorkItem: 400 (задача не закрыта) → PlaneApiError 400', async () => {
		const { client } = stub([{ status: 400, body: { error: 'not closed' } }]);
		const err = await failure(client.archiveWorkItem('p1', 'w1'));
		expect(err).toBeInstanceOf(PlaneApiError);
		expect((err as PlaneApiError).status).toBe(400);
	});

	test('unarchiveWorkItem: DELETE /work-items/{id}/unarchive/, 204 с пустым телом', async () => {
		const { calls, client } = stub([{ status: 204 }]);
		await client.unarchiveWorkItem('p1', 'w1');
		expect(calls[0]?.method).toBe('DELETE');
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/unarchive/`);
		expect(calls[0]?.headers['X-API-Key']).toBe('key-1');
	});

	test('unarchiveWorkItem: 404 (не в архиве) → PlaneApiError 404, путь в сообщении', async () => {
		const { client } = stub([{ status: 404, body: { error: 'not found' } }]);
		const err = await failure(client.unarchiveWorkItem('p1', 'w1'));
		expect(err).toBeInstanceOf(PlaneApiError);
		expect((err as PlaneApiError).status).toBe(404);
		expect((err as Error).message).toBe('Plane DELETE /projects/p1/work-items/w1/unarchive/ → 404');
	});

	test('isWorkItemArchived: деталь 200 → false, архивный список не читается', async () => {
		const { calls, client } = stub([
			{
				status: 200,
				body: { id: 'w1', project: 'p1', state: 's1', sequence_id: 1, archived_at: null },
			},
		]);
		expect(await client.isWorkItemArchived('p1', 'w1')).toBe(false);
		expect(calls.map((c) => [c.method, c.url])).toEqual([
			['GET', `${ROOT}/projects/p1/work-items/w1/`],
		]);
	});

	test('isWorkItemArchived: деталь 404 → ищет id по страницам /archived-work-items/', async () => {
		const { calls, client } = stub([
			{ status: 404, body: { error: 'not found' } },
			{
				status: 200,
				body: { results: [{ id: 'w0' }], next_page_results: true, next_cursor: '100:1:0' },
			},
			{ status: 200, body: { results: [{ id: 'w1', archived_at: '2026-10-21' }] } },
		]);
		expect(await client.isWorkItemArchived('p1', 'w1')).toBe(true);
		expect(calls[1]?.url).toBe(`${ROOT}/projects/p1/archived-work-items/?per_page=100`);
		expect(calls[2]?.url).toBe(
			`${ROOT}/projects/p1/archived-work-items/?per_page=100&cursor=100%3A1%3A0`,
		);
	});

	test('isWorkItemArchived: деталь 404 и в архиве нет → false', async () => {
		const { client } = stub([
			{ status: 404, raw: '<html>not found</html>' },
			{ status: 200, body: { results: [{ id: 'w0' }] } },
		]);
		expect(await client.isWorkItemArchived('p1', 'w1')).toBe(false);
	});

	test('isWorkItemArchived: 429 на детали → PlaneApiError 429, список не читается', async () => {
		const { calls, client } = stub([{ status: 429, body: { error: 'slow down' } }]);
		const err = await failure(client.isWorkItemArchived('p1', 'w1'));
		expect((err as PlaneApiError).status).toBe(429);
		expect(calls).toHaveLength(1);
	});
});

describe('PlaneClient: списки', () => {
	test('комментарии: идёт по курсору через все страницы', async () => {
		const { calls, client } = stub([
			{
				status: 200,
				body: {
					results: [
						{
							id: 'c1',
							external_id: 'k:a:firing',
							external_source: 'plane-hooks',
							created_at: '2026-10-06T10:00:00Z',
						},
					],
					next_page_results: true,
					next_cursor: '100:1:0',
				},
			},
			{
				status: 200,
				body: {
					results: [
						{
							id: 'c2',
							external_id: null,
							external_source: '',
							created_at: '2026-10-06T10:05:00Z',
						},
					],
					next_page_results: false,
					next_cursor: '100:2:0',
				},
			},
		]);
		expect(await client.listComments('p1', 'w1')).toEqual([
			{
				id: 'c1',
				external_id: 'k:a:firing',
				external_source: 'plane-hooks',
				created_at: '2026-10-06T10:00:00Z',
			},
			{ id: 'c2', external_id: null, external_source: null, created_at: '2026-10-06T10:05:00Z' },
		]);
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/comments/?per_page=100`);
		expect(calls[1]?.url).toBe(
			`${ROOT}/projects/p1/work-items/w1/comments/?per_page=100&cursor=100%3A1%3A0`,
		);
	});

	test('состояния: голый массив', async () => {
		const { client } = stub([
			{
				status: 200,
				body: [
					{ id: 's1', group: 'backlog', default: true, name: 'Backlog', sequence: 15000 },
					{ id: 's2', group: 'completed', default: false, name: 'Done', sequence: 45000 },
				],
			},
		]);
		expect(await client.listStates('p1')).toEqual([
			{ id: 's1', name: 'Backlog', group: 'backlog', sequence: 15000, default: true },
			{ id: 's2', name: 'Done', group: 'completed', sequence: 45000, default: false },
		]);
	});

	test('идентификаторы проектов, метки, создание метки', async () => {
		const { calls, client } = stub([
			{
				status: 200,
				body: { results: [{ id: 'p1', identifier: 'OPS' }], next_page_results: false },
			},
			{ status: 200, body: { results: [{ id: 'l1', name: 'alert' }], next_page_results: false } },
			{ status: 201, body: { id: 'l2', name: 'deploy-failed' } },
		]);
		expect(await client.listProjectIdentifiers()).toEqual(['OPS']);
		expect(await client.listLabels('p1')).toEqual([{ id: 'l1', name: 'alert' }]);
		expect(await client.createLabel('p1', 'deploy-failed')).toEqual({
			id: 'l2',
			name: 'deploy-failed',
		});
		expect(calls[2]?.body).toEqual({ name: 'deploy-failed', color: '#d9534f' });
	});

	test('неожиданная форма списка → ошибка', async () => {
		const { client } = stub([{ status: 200, body: { foo: 1 } }]);
		expect(await failure(client.listStates('p1'))).toBeInstanceOf(Error);
	});
});

describe('PlaneClient: ошибки', () => {
	test('429 и 500 → PlaneApiError со статусом, без тела ответа в сообщении', async () => {
		const { client } = stub([
			{ status: 429, body: { detail: 'secret-ish body' } },
			{ status: 500, body: { detail: 'boom' } },
		]);
		const rateLimited = await failure(client.createWorkItem('p1', item));
		expect(rateLimited).toBeInstanceOf(PlaneApiError);
		expect((rateLimited as PlaneApiError).status).toBe(429);
		expect((rateLimited as PlaneApiError).message).not.toContain('secret-ish');
		const broken = await failure(client.createWorkItem('p1', item));
		expect((broken as PlaneApiError).status).toBe(500);
	});

	test('404 там, где его не ждут, — ошибка, а не null', async () => {
		const { client } = stub([{ status: 404, body: { error: 'nope' } }]);
		const err = await failure(client.getWorkItem('p1', 'w404'));
		expect((err as PlaneApiError).status).toBe(404);
	});

	test('200 не-JSON → ошибка именно о не-JSON', async () => {
		const { client } = stub([{ status: 200, raw: '<html>proxy page</html>' }]);
		const err = await failure(client.getWorkItem('p1', 'w1'));
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe(
			'Plane GET /projects/p1/work-items/w1/: response is not JSON',
		);
	});

	test('ошибка запроса с параметрами: в сообщении путь без query (external_id в лог не попадает)', async () => {
		const { client } = stub([{ status: 429, body: { detail: 'throttled' } }]);
		const err = await failure(
			client.findWorkItemByExternalId('p1', 'vercel', 'deploy:prj_x:production:secret-branch'),
		);
		expect((err as PlaneApiError).status).toBe(429);
		expect((err as PlaneApiError).message).toBe('Plane GET /projects/p1/work-items/ → 429');
		expect((err as PlaneApiError).message).not.toContain('?');
		expect((err as PlaneApiError).path).toBe('/projects/p1/work-items/');
	});

	test('таймаут прерывает запрос', async () => {
		const hang = (_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
			});
		const client = new PlaneClient({
			baseUrl: 'https://plane.test',
			workspace: 'example-ws',
			auth: apiKeyAuth('k'),
			timeoutMs: 20,
			fetch: hang,
		});
		expect(await failure(client.listStates('p1'))).toBeDefined();
	});
});

describe('ограничитель темпа', () => {
	test('каждый запрос сначала получает место у ограничителя, и только потом уходит в fetch', async () => {
		const events: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const client = new PlaneClient({
			baseUrl: 'https://plane.test',
			workspace: 'example-ws',
			auth: apiKeyAuth('key-1'),
			limiter: {
				acquire: async () => {
					events.push('acquire');
					await gate;
				},
			},
			fetch: async () => {
				events.push('fetch');
				return new Response(JSON.stringify({ results: [], next_page_results: false }), {
					status: 200,
				});
			},
		});
		const pending = client.listStates('p-ops');
		await Bun.sleep(5);
		expect(events).toEqual(['acquire']);
		release();
		await pending;
		expect(events).toEqual(['acquire', 'fetch']);
	});

	// Negative guard: passes without a limiter; it catches a timeout signal created before acquire(), which would already have expired by the time the call runs.
	test('ожидание в очереди не съедает таймаут вызова', async () => {
		const client = new PlaneClient({
			baseUrl: 'https://plane.test',
			workspace: 'example-ws',
			auth: apiKeyAuth('key-1'),
			timeoutMs: 20,
			limiter: { acquire: () => Bun.sleep(60) },
			fetch: async (_url, init) => {
				if (init.signal?.aborted) throw new Error('aborted before the request was sent');
				return new Response(JSON.stringify({ results: [], next_page_results: false }), {
					status: 200,
				});
			},
		});
		await expect(client.listStates('p-ops')).resolves.toEqual([]);
	});
});

const release: NewRelease = {
	name: '2026-10-06 · 89abcde',
	status: 'released',
	release_date: '2026-10-06',
	external_source: 'github-deploy',
	external_id: 'example-org/app@89abcdef0123456789abcdef0123456789abcdef',
};

describe('PlaneClient: релизы', () => {
	test('поиск по external_id идёт по всем страницам списка релизов workspace', async () => {
		const { calls, client } = stub([
			{
				status: 200,
				body: {
					results: [
						{ id: 'r1', external_source: 'github-deploy', external_id: 'example-org/app@other' },
					],
					next_page_results: true,
					next_cursor: '100:1:0',
				},
			},
			{
				status: 200,
				body: {
					results: [
						{ id: 'r9', external_source: null, external_id: null },
						{ id: 'r2', external_source: 'github-deploy', external_id: release.external_id },
					],
					next_page_results: false,
				},
			},
		]);
		expect(await client.findReleaseByExternalId('github-deploy', release.external_id)).toEqual({
			id: 'r2',
		});
		expect(calls[0]?.url).toBe(`${ROOT}/releases/?per_page=100`);
		expect(calls[1]?.url).toBe(`${ROOT}/releases/?per_page=100&cursor=100%3A1%3A0`);
	});

	test('поиск: совпадает только пара source + id', async () => {
		const { client } = stub([
			{
				status: 200,
				body: [{ id: 'r1', external_source: 'manual', external_id: release.external_id }],
			},
		]);
		expect(await client.findReleaseByExternalId('github-deploy', release.external_id)).toBeNull();
	});

	test('создание: POST /releases/, 201 → created:true; 409 → id существующего', async () => {
		const { calls, client } = stub([
			{ status: 201, body: { id: 'r1' } },
			{ status: 409, body: { error: 'exists', id: 'r1' } },
		]);
		expect(await client.createRelease(release)).toEqual({ id: 'r1', created: true });
		expect(calls[0]).toMatchObject({ url: `${ROOT}/releases/`, method: 'POST', body: release });
		expect(await client.createRelease(release)).toEqual({ id: 'r1', created: false });
	});

	test('changelog: PATCH /releases/{id}/changelog/ с description_html', async () => {
		const { calls, client } = stub([{ status: 200, body: { id: 'c1' } }]);
		await client.updateReleaseChangelog('r1', '<p>x</p>');
		expect(calls[0]).toMatchObject({
			url: `${ROOT}/releases/r1/changelog/`,
			method: 'PATCH',
			body: { description_html: '<p>x</p>' },
		});
	});

	test('привязка задач: POST /releases/{id}/work-items/ с work_item_ids', async () => {
		const { calls, client } = stub([{ status: 200, body: null }]);
		await client.addReleaseWorkItems('r1', ['w1', 'w2']);
		expect(calls[0]).toMatchObject({
			url: `${ROOT}/releases/r1/work-items/`,
			method: 'POST',
			body: { work_item_ids: ['w1', 'w2'] },
		});
	});

	test('привязка: пустой список — ни одного запроса; больше лимита — RangeError до запроса', async () => {
		const { calls, client } = stub([]);
		await client.addReleaseWorkItems('r1', []);
		const many = Array.from({ length: RELEASE_ITEMS_MAX + 1 }, (_, i) => `w${i}`);
		expect(await failure(client.addReleaseWorkItems('r1', many))).toBeInstanceOf(RangeError);
		expect(calls).toEqual([]);
	});

	test('403 на релизы (токен — Guest) → PlaneApiError 403', async () => {
		const { client } = stub([{ status: 403, body: { detail: 'forbidden' } }]);
		const err = await failure(client.createRelease(release));
		expect(err).toBeInstanceOf(PlaneApiError);
		expect((err as PlaneApiError).status).toBe(403);
	});
});

describe('PlaneClient: бот-токен Plane App', () => {
	function authStub(replies: Reply[]) {
		let issued = 0;
		let invalidated = 0;
		const auth: PlaneAuth = {
			headers: async () => ({ Authorization: `Bearer tok-${++issued}` }),
			invalidate: () => {
				invalidated++;
			},
		};
		const calls: Call[] = [];
		const client = new PlaneClient({
			baseUrl: 'https://plane.test',
			workspace: 'example-ws',
			auth,
			fetch: async (url, init) => {
				calls.push({
					url,
					method: init.method ?? 'GET',
					headers: init.headers as Record<string, string>,
					body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
				});
				const reply = replies.shift();
				if (!reply) throw new Error('unexpected request');
				return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
					status: reply.status,
				});
			},
		});
		return { calls, client, invalidated: () => invalidated };
	}

	test('заголовки авторизации берутся у PlaneAuth на каждый запрос', async () => {
		const { calls, client } = authStub([
			{ status: 200, body: [] },
			{ status: 200, body: [] },
		]);
		await client.listLabels('p1');
		await client.listLabels('p1');
		expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
		expect(calls[0]?.headers['X-API-Key']).toBeUndefined();
	});

	test('401 сбрасывает токен и повторяет запрос один раз', async () => {
		const { calls, client, invalidated } = authStub([
			{ status: 401, body: { detail: 'expired' } },
			{ status: 200, body: [{ id: 'l1', name: 'bug' }] },
		]);
		expect(await client.listLabels('p1')).toEqual([{ id: 'l1', name: 'bug' }]);
		expect(invalidated()).toBe(1);
		expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
	});

	test('второй 401 подряд — PlaneApiError 401, токен сброшен один раз', async () => {
		const { calls, client, invalidated } = authStub([{ status: 401 }, { status: 401 }]);
		const err = await failure(client.listLabels('p1'));
		expect(err).toBeInstanceOf(PlaneApiError);
		expect((err as PlaneApiError).status).toBe(401);
		expect(invalidated()).toBe(1);
		expect(calls).toHaveLength(2);
	});

	test('apiKeyAuth отдаёт заголовок X-API-Key', async () => {
		expect(await apiKeyAuth('k-9').headers()).toEqual({ 'X-API-Key': 'k-9' });
	});

	test('скоупы Plane App — ровно десять из Global Constraints', () => {
		expect(PLANE_HOOKS_SCOPES).toEqual([
			'projects:read',
			'projects.work_items:read',
			'projects.work_items:write',
			'projects.work_items.comments:read',
			'projects.work_items.comments:write',
			'projects.work_items.links:read',
			'projects.work_items.links:write',
			'projects.states:read',
			'projects.labels:read',
			'projects.labels:write',
		]);
	});
});

describe('PlaneClient: проекты, ссылки, правка комментария', () => {
	test('listProjects — id и идентификатор', async () => {
		const { calls, client } = stub([
			{
				status: 200,
				body: {
					results: [
						{ id: 'p-eng', identifier: 'ENG', name: 'Engineering' },
						{ id: 'p-qa', identifier: 'QA', name: 'Quality' },
					],
					next_page_results: false,
				},
			},
		]);
		expect(await client.listProjects()).toEqual([
			{ id: 'p-eng', identifier: 'ENG' },
			{ id: 'p-qa', identifier: 'QA' },
		]);
		expect(calls[0]?.url).toBe(`${ROOT}/projects/?per_page=100`);
	});

	test('listStates без sequence — ошибка разбора', async () => {
		const { client } = stub([
			{ status: 200, body: [{ id: 's1', name: 'Todo', group: 'unstarted', default: false }] },
		]);
		expect(await failure(client.listStates('p1'))).toBeInstanceOf(Error);
	});

	test('listStates: sequence строкой или бесконечность — ошибка разбора', async () => {
		const row = '"id": "s1", "name": "Todo", "group": "unstarted", "default": false';
		const asString = stub([{ status: 200, raw: `[{${row}, "sequence": "25000"}]` }]);
		expect(await failure(asString.client.listStates('p1'))).toBeInstanceOf(Error);
		const infinite = stub([{ status: 200, raw: `[{${row}, "sequence": 1e999}]` }]);
		expect(await failure(infinite.client.listStates('p1'))).toBeInstanceOf(Error);
	});

	test('listComments: external_source не строка — null', async () => {
		const { client } = stub([
			{
				status: 200,
				body: [
					{ id: 'c1', external_id: 'x', external_source: 5, created_at: '2026-10-06T10:00:00Z' },
				],
			},
		]);
		expect((await client.listComments('p1', 'w1'))[0]?.external_source).toBeNull();
	});

	const link = { url: 'https://github.com/acme/api/pull/12', title: 'GitHub: acme/api#12' };
	const linksPath = `${ROOT}/projects/p1/work-items/w1/links/`;

	test('createLink: 201 — created, тело {url, title}', async () => {
		const { calls, client } = stub([{ status: 201, body: { id: 'k1', ...link } }]);
		expect(await client.createLink('p1', 'w1', link)).toBe('created');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.url).toBe(linksPath);
		expect(calls[0]?.body).toEqual(link);
	});

	test('createLink: 400, а URL уже в списке ссылок — exists', async () => {
		const { calls, client } = stub([
			{ status: 400, body: { error: 'URL already exists' } },
			{
				status: 200,
				body: { results: [{ id: 'k1', url: link.url }], next_page_results: false },
			},
		]);
		expect(await client.createLink('p1', 'w1', link)).toBe('exists');
		expect(calls[1]?.method).toBe('GET');
		expect(calls[1]?.url).toBe(`${linksPath}?per_page=100`);
	});

	test('createLink: другой 400 (URL в списке нет) — PlaneApiError 400', async () => {
		const { client } = stub([
			{ status: 400, body: { url: ['Enter a valid URL.'] } },
			{
				status: 200,
				body: {
					results: [{ id: 'k1', url: 'https://example.com/other' }],
					next_page_results: false,
				},
			},
		]);
		const err = await failure(client.createLink('p1', 'w1', link));
		expect(err).toBeInstanceOf(PlaneApiError);
		expect((err as PlaneApiError).status).toBe(400);
	});

	test('listLinks — id и url', async () => {
		const { client } = stub([
			{ status: 200, body: [{ id: 'k1', url: link.url, title: link.title }] },
		]);
		expect(await client.listLinks('p1', 'w1')).toEqual([{ id: 'k1', url: link.url }]);
	});

	test('updateComment — PATCH comment_html', async () => {
		const { calls, client } = stub([{ status: 200, body: { id: 'c1' } }]);
		await client.updateComment('p1', 'w1', 'c1', '<p>новый</p>');
		expect(calls[0]?.method).toBe('PATCH');
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/comments/c1/`);
		expect(calls[0]?.body).toEqual({ comment_html: '<p>новый</p>' });
	});
});
