import { describe, expect, test } from 'bun:test';

import { CACHE_TTL_MS, createRuntime, MISS_REFRESH_MS } from '../src/runtime.ts';
import { configOf } from './config-fixture.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const row = (id: string) => ({ id, identifier: id.toUpperCase(), name: id });

function world() {
	let clock = 1_000_000;
	const hits: string[] = [];
	let projects = [row('a')];
	let failProjects = false;
	let states = [{ id: 's1', name: 'Todo', group: 'backlog' }];
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		const { pathname } = new URL(url);
		hits.push(`${init.method} ${pathname}`);
		if (pathname === '/auth/o/token/') return json({ access_token: 't', expires_in: 36_000 });
		if (pathname.endsWith('/app-installation/')) return json({ app_bot: 'bot-1' });
		if (pathname.endsWith('/projects/')) {
			if (failProjects) return json({}, 500);
			return json({ results: projects, next_page_results: false });
		}
		if (pathname.endsWith('/states/')) return json({ results: states, next_page_results: false });
		if (pathname.endsWith('/members/')) {
			return json({ results: [{ id: 'u1', display_name: 'Ann' }], next_page_results: false });
		}
		return json({}, 404);
	};
	const runtime = createRuntime(configOf().tenants[0]!, {
		planeUrl: 'https://plane.example.com',
		fetch,
		now: () => clock,
	});
	const count = (suffix: string) => hits.filter((h) => h.endsWith(suffix)).length;
	return {
		runtime,
		count,
		advance: (ms: number) => (clock += ms),
		setProjects: (p: typeof projects) => (projects = p),
		setStates: (s: typeof states) => (states = s),
		failProjects: (v: boolean) => (failProjects = v),
	};
}

describe('createRuntime: кэши', () => {
	test('projects: второе чтение — из кэша, после TTL — заново', async () => {
		const w = world();
		await w.runtime.projects();
		await w.runtime.projects();
		expect(w.count('/projects/')).toBe(1);
		w.advance(CACHE_TTL_MS + 1);
		await w.runtime.projects();
		expect(w.count('/projects/')).toBe(2);
	});

	test('projects({refresh}) перечитывает сразу и отдаёт новый проект', async () => {
		const w = world();
		expect(await w.runtime.projects()).toEqual([row('a')]);
		w.setProjects([row('a'), row('b')]);
		w.advance(MISS_REFRESH_MS);
		expect((await w.runtime.projects({ refresh: true })).map((p) => p.id)).toEqual(['a', 'b']);
		expect(w.count('/projects/')).toBe(2);
	});

	test('projects({refresh}) чаще раза в MISS_REFRESH_MS не бьёт в Plane', async () => {
		const w = world();
		await w.runtime.projects({ refresh: true });
		w.setProjects([row('a'), row('b')]);
		w.advance(MISS_REFRESH_MS - 1);
		expect((await w.runtime.projects({ refresh: true })).map((p) => p.id)).toEqual(['a']);
		expect(w.count('/projects/')).toBe(1);
		w.advance(1);
		expect((await w.runtime.projects({ refresh: true })).map((p) => p.id)).toEqual(['a', 'b']);
		expect(w.count('/projects/')).toBe(2);
	});

	test('states: кэш по проекту, refresh перечитывает только его', async () => {
		const w = world();
		await w.runtime.states('p1');
		await w.runtime.states('p1');
		await w.runtime.states('p2');
		expect(w.count('/states/')).toBe(2);
		w.setStates([
			{ id: 's1', name: 'Todo', group: 'backlog' },
			{ id: 's2', name: 'Done', group: 'completed' },
		]);
		expect((await w.runtime.states('p1', { refresh: true })).map((s) => s.id)).toEqual([
			's1',
			's2',
		]);
		expect(w.count('/states/')).toBe(3);
		// states of p2 stayed cached
		expect((await w.runtime.states('p2')).map((s) => s.id)).toEqual(['s1']);
		expect(w.count('/states/')).toBe(3);
	});

	test('members: из кэша до TTL', async () => {
		const w = world();
		expect(await w.runtime.members()).toEqual([{ id: 'u1', displayName: 'Ann' }]);
		await w.runtime.members();
		expect(w.count('/members/')).toBe(1);
	});
});

describe('createRuntime: часы по умолчанию', () => {
	test('без now кэш живёт по настоящему времени: два чтения — один запрос', async () => {
		let projectsFetched = 0;
		const runtime = createRuntime(configOf().tenants[0]!, {
			planeUrl: 'https://plane.example.com',
			fetch: async (url) => {
				const { pathname } = new URL(url);
				if (pathname === '/auth/o/token/') return json({ access_token: 't', expires_in: 36_000 });
				projectsFetched++;
				return json({ results: [row('a')], next_page_results: false });
			},
		});
		await runtime.projects();
		await runtime.projects();
		expect(projectsFetched).toBe(1);
	});
});

describe('createRuntime: projectsCached и warm', () => {
	test('projectsCached: null на холодном старте, после загрузки — список, после сбоя обновления — прежний', async () => {
		const w = world();
		expect(w.runtime.projectsCached()).toBeNull();
		await w.runtime.projects();
		expect(w.runtime.projectsCached()).toEqual([row('a')]);
		w.failProjects(true);
		w.advance(CACHE_TTL_MS + 1);
		await expect(w.runtime.projects()).rejects.toThrow();
		expect(w.runtime.projectsCached()).toEqual([row('a')]);
	});

	test('warm: загружает проекты и пользователя бота; сбой Plane — отклонение', async () => {
		const w = world();
		await w.runtime.warm();
		expect(w.runtime.projectsCached()).toEqual([row('a')]);
		expect(w.count('/app-installation/')).toBe(1);
		const bad = world();
		bad.failProjects(true);
		await expect(bad.runtime.warm()).rejects.toThrow();
		expect(bad.runtime.projectsCached()).toBeNull();
	});

	test('warm перечитывает проекты мимо живого кэша', async () => {
		const w = world();
		await w.runtime.projects();
		w.setProjects([row('a'), row('b')]);
		await w.runtime.warm();
		expect(w.runtime.projectsCached()?.map((p) => p.id)).toEqual(['a', 'b']);
		expect((await w.runtime.projects()).map((p) => p.id)).toEqual(['a', 'b']);
	});
});
