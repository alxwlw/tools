// Adapted from apps/plane-miro/test/plane-client.test.ts.
import type { PlaneAuth } from '@alxwlw/plane-app';
import { describe, expect, test } from 'bun:test';

import {
	DESCRIPTION_MAX,
	parseRelations,
	PLANE_RATE_MAX,
	PLANE_RATE_WINDOW_MS,
	PlaneApiError,
	PlaneClient,
} from '../src/plane/client.ts';
import { fixture } from './fixtures.ts';

type Reply = { status: number; body?: unknown; raw?: string };
type Call = { url: string; method: string; headers: Record<string, string> };

const ROOT = 'https://plane.test/api/v1/workspaces/example-ws';
const body = (name: string): any => fixture(name).body;
const rows = (name: string): any[] => body(name).results;
/** A REST list page around `results`. */
const page = (results: unknown[], next: string | null) => ({
	results,
	next_page_results: next !== null,
	next_cursor: next ?? '100:1:0',
});

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

function stub(
	replies: Reply[],
	limiter: { acquire(): Promise<void> } = { acquire: async () => {} },
) {
	const calls: Call[] = [];
	const { auth, state } = fakeAuth();
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({
			url,
			method: init.method ?? 'GET',
			headers: init.headers as Record<string, string>,
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
		fetch,
		limiter,
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

describe('parseRelations', () => {
	test('parseRelations разворачивает блокирует и связана', () => {
		const relations = body('plane-relations');
		const blocking = (relations.blocking as string[])[0] as string;
		const blockedBy = (relations.blocked_by as string[])[0] as string;
		const relatesTo = (relations.relates_to as string[])[0] as string;
		const item = '00000000-0000-4000-8000-0000000000aa';
		expect(new Set([item, blocking, blockedBy, relatesTo]).size).toBe(3);
		expect(parseRelations(item, relations)).toEqual([
			{ from: blockedBy, to: item, type: 'blocks' },
			{ from: item, to: blocking, type: 'blocks' },
			// relates is symmetric: the smaller id first, whichever side the item is on
			{ from: relatesTo, to: item, type: 'relates' },
		]);
		expect(parseRelations('0', { relates_to: ['1'] })).toEqual([
			{ from: '0', to: '1', type: 'relates' },
		]);
	});

	test('прочие виды связей отбрасываются, повторы схлопываются', () => {
		expect(
			parseRelations('b', {
				blocking: ['c', 'c'],
				blocked_by: [],
				start_after: ['x'],
				start_before: ['x'],
				finish_after: ['x'],
				finish_before: ['x'],
				duplicate: ['x'],
				relates_to: ['a', 'a'],
			}),
		).toEqual([
			{ from: 'b', to: 'c', type: 'blocks' },
			{ from: 'a', to: 'b', type: 'relates' },
		]);
		expect(parseRelations('b', {})).toEqual([]);
	});

	test('тело не той формы — ошибка', () => {
		for (const bad of [null, [], 'x', { blocking: 'a' }, { blocked_by: [1] }, { relates_to: [''] }])
			expect(() => parseRelations('b', bad)).toThrow('Plane relations');
	});
});

describe('PlaneClient: чтение', () => {
	test('listWorkItems идёт по всем страницам', async () => {
		const all = rows('plane-work-items-page');
		const first = structuredClone(all[0]);
		first.parent = all[1].id;
		first.labels = ['lab-1', 'lab-2'];
		first.description_stripped = 'я'.repeat(DESCRIPTION_MAX + 50);
		const { calls, client } = stub([
			{ status: 200, body: page([first], '100:1:0') },
			{ status: 200, body: page([all[1], all[2]], null) },
		]);
		const items = await client.listWorkItems('p1');
		expect(items.map((i) => i.id)).toEqual([all[0].id, all[1].id, all[2].id]);
		expect(items[0]).toEqual({
			id: all[0].id,
			projectId: all[0].project,
			sequenceId: 66,
			name: all[0].name,
			description: 'я'.repeat(DESCRIPTION_MAX),
			stateId: all[0].state,
			parentId: all[1].id,
			labelIds: ['lab-1', 'lab-2'],
			createdAt: all[0].created_at,
			updatedAt: all[0].updated_at,
		});
		expect(items[1]).toMatchObject({ sequenceId: 65, parentId: null, labelIds: [] });
		expect(calls.map((c) => c.url)).toEqual([
			`${ROOT}/projects/p1/work-items/?per_page=100`,
			`${ROOT}/projects/p1/work-items/?per_page=100&cursor=100%3A1%3A0`,
		]);
	});

	test('курсор, который не меняется, обрывает обход ошибкой, а не зацикливает его', async () => {
		const row = rows('plane-work-items-page')[0];
		const { calls, client } = stub(
			Array.from({ length: 5 }, () => ({ status: 200, body: page([row], '100:1:0') })),
		);
		const err = await failure(client.listWorkItems('p1'));
		expect((err as Error).message).toBe(
			'Plane GET /projects/p1/work-items/: pagination does not advance',
		);
		expect(calls).toHaveLength(2);
		// a missing cursor on a page that promises another one is the same dead end
		const lost = stub([{ status: 200, body: { results: [row], next_page_results: true } }]);
		expect(((await failure(lost.client.listWorkItems('p1'))) as Error).message).toContain(
			'does not advance',
		);
	});

	test('описание: description_stripped, иначе HTML без тегов; пробелы схлопнуты', async () => {
		const [a, b, c] = rows('plane-work-items-page');
		a.description_stripped = '';
		a.description_html = '<p>Один <b>два</b></p>\n<p>три</p>';
		b.description_stripped = null;
		b.description_html = null;
		c.description_stripped = 'готово';
		c.description_html = '<p>другое</p>';
		const { client } = stub([{ status: 200, body: page([a, b, c], null) }]);
		expect((await client.listWorkItems('p1')).map((i) => i.description)).toEqual([
			'Один два три',
			'',
			'готово',
		]);
	});

	test('строка задачи не той формы — ошибка с именем поля', async () => {
		const row = rows('plane-work-items-page')[0];
		const cases: Array<[(r: any) => void, string]> = [
			[(r) => (r.sequence_id = '66'), 'sequence_id'],
			[(r) => (r.state = null), '"state"'],
			[(r) => (r.parent = 7), '"parent"'],
			[(r) => (r.labels = [1]), '"labels"'],
			[(r) => delete r.created_at, '"created_at"'],
		];
		for (const [edit, needle] of cases) {
			const bad = structuredClone(row);
			edit(bad);
			const { client } = stub([{ status: 200, body: page([bad], null) }]);
			expect(((await failure(client.listWorkItems('p1'))) as Error).message).toContain(needle);
		}
	});

	test('getWorkItem читает одну задачу; 404 — null', async () => {
		const row = rows('plane-work-items-page')[0];
		const { calls, client } = stub([
			{ status: 200, body: row },
			{ status: 404, raw: '<html>not found</html>' },
		]);
		expect(await client.getWorkItem('p1', row.id)).toMatchObject({ id: row.id, sequenceId: 66 });
		expect(await client.getWorkItem('p1', 'gone')).toBeNull();
		expect(calls.map((c) => c.url)).toEqual([
			`${ROOT}/projects/p1/work-items/${row.id}/`,
			`${ROOT}/projects/p1/work-items/gone/`,
		]);
		const other = stub([{ status: 500, body: { detail: 'SECRET-BODY' } }]);
		const err = await failure(other.client.getWorkItem('p1', 'x'));
		expect(err).toBeInstanceOf(PlaneApiError);
		expect(err).toMatchObject({ status: 500, method: 'GET', path: '/projects/p1/work-items/x/' });
		expect((err as Error).message).not.toContain('SECRET-BODY');
	});

	test('getRelations читает /relations/ задачи и разбирает тело', async () => {
		const relations = body('plane-relations');
		const { calls, client } = stub([{ status: 200, body: relations }]);
		const edges = await client.getRelations('p1', 'i1');
		expect(edges).toEqual(parseRelations('i1', relations));
		expect(edges).toHaveLength(3);
		expect(calls[0]!.url).toBe(`${ROOT}/projects/p1/work-items/i1/relations/`);
	});

	test('проекты, состояния, метки: поля строк и projectId из запроса', async () => {
		const { calls, client } = stub([
			{
				status: 200,
				body: page([{ id: 'p1', identifier: 'ABC', name: 'Alpha', archived_at: null }], null),
			},
			{ status: 200, body: page([{ id: 's1', name: 'Todo', group: 'unstarted' }], null) },
			{ status: 200, body: page(rows('plane-labels'), null) },
		]);
		expect(await client.listProjects()).toEqual([{ id: 'p1', identifier: 'ABC', name: 'Alpha' }]);
		expect(await client.listStates('p1')).toEqual([
			{ id: 's1', projectId: 'p1', group: 'unstarted' },
		]);
		const labels = await client.listLabels('p1');
		expect(labels).toHaveLength(3);
		expect(labels[0]).toEqual({
			id: rows('plane-labels')[0].id,
			projectId: 'p1',
			name: rows('plane-labels')[0].name,
		});
		expect(calls.map((c) => c.url.replace(ROOT, '').split('?')[0])).toEqual([
			'/projects/',
			'/projects/p1/states/',
			'/projects/p1/labels/',
		]);
		const bad = stub([
			{ status: 200, body: page([{ id: 's1', name: 'x', group: 'weird' }], null) },
		]);
		expect(((await failure(bad.client.listStates('p1'))) as Error).message).toContain(
			'state group',
		);
	});

	test('listModules берёт состав каждого модуля из module-issues', async () => {
		const mods = rows('plane-modules');
		const members = rows('plane-module-items');
		const { calls, client } = stub([
			{ status: 200, body: page(mods, null) },
			{ status: 200, body: page(members, null) },
			{ status: 200, body: page([], null) },
		]);
		const out = await client.listModules('p1');
		expect(out).toEqual([
			{ id: mods[0].id, projectId: 'p1', name: mods[0].name, itemIds: members.map((m) => m.id) },
			{ id: mods[1].id, projectId: 'p1', name: mods[1].name, itemIds: [] },
		]);
		expect(calls.map((c) => c.url.replace(ROOT, '').split('?')[0])).toEqual([
			'/projects/p1/modules/',
			`/projects/p1/modules/${mods[0].id}/module-issues/`,
			`/projects/p1/modules/${mods[1].id}/module-issues/`,
		]);
	});
});

describe('PlaneClient: 401, лимитер, сбои', () => {
	test('401 посреди работы: invalidate, новый токен, один повтор, успех', async () => {
		const { calls, client, state } = stub([
			{ status: 401, body: { detail: 'expired' } },
			{ status: 200, body: page([], null) },
		]);
		expect(await client.listProjects()).toEqual([]);
		expect(state.invalidations).toBe(1);
		expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer tok-0', 'Bearer tok-1']);
	});

	test('второй 401 подряд — PlaneApiError 401, без третьей попытки', async () => {
		const { calls, client, state } = stub([
			{ status: 401 },
			{ status: 401 },
			{ status: 200, body: [] },
		]);
		expect(await failure(client.listProjects())).toMatchObject({
			status: 401,
			method: 'GET',
			path: '/projects/',
		});
		expect(calls).toHaveLength(2);
		expect(state.invalidations).toBe(1);
	});

	test('лимитер вызывается на каждый запрос', async () => {
		let acquired = 0;
		const { calls, client } = stub(
			[
				{ status: 200, body: page([{ id: 'm1', name: 'M' }], null) },
				{ status: 200, body: page([], null) },
				{ status: 401 },
				{ status: 200, body: page([], null) },
			],
			{
				acquire: async () => {
					acquired++;
					expect(calls).toHaveLength(acquired - 1);
				},
			},
		);
		await client.listModules('p1');
		expect(acquired).toBe(2);
		await client.listProjects(); // a 401 retry takes its own slot
		expect(acquired).toBe(4);
		expect(calls).toHaveLength(4);
	});

	test('лимит бота: 50 запросов в минуту', () => {
		expect(PLANE_RATE_MAX).toBe(50);
		expect(PLANE_RATE_WINDOW_MS).toBe(60_000);
	});

	test('обрыв соединения и не-JSON в ответе 200 — ошибки без текста ответа', async () => {
		const failing = new PlaneClient({
			baseUrl: 'https://plane.test',
			workspace: 'example-ws',
			auth: fakeAuth().auth,
			limiter: { acquire: async () => {} },
			fetch: async () => {
				throw new Error('SECRET-CAUSE');
			},
		});
		const err = await failure(failing.listProjects());
		expect(err).toMatchObject({ status: 0, method: 'GET', path: '/projects/' });
		expect((err as Error).message).not.toContain('SECRET-CAUSE');
		const html = stub([{ status: 200, raw: '<html>SECRET-PAGE</html>' }]);
		const bad = (await failure(html.client.listProjects())) as Error;
		expect(bad.message).toBe('Plane GET /projects/: response is not JSON');
		const shape = stub([{ status: 200, body: { nope: [] } }]);
		expect(((await failure(shape.client.listProjects())) as Error).message).toContain(
			'unexpected list shape',
		);
	});
});
