import { describe, expect, test } from 'bun:test';

import { CACHE_TTL_MS, createRuntime, MISS_REFRESH_MS } from '../src/runtime.ts';
import { Store } from '../src/store.ts';
import { world } from './world.ts';

describe('createRuntime', () => {
	test('кэш живёт десять минут', () => {
		expect(CACHE_TTL_MS).toBe(600_000);
		expect(MISS_REFRESH_MS).toBe(30_000);
	});

	test('projects: без скрытых и архивных, кэш на CACHE_TTL_MS', async () => {
		const w = world({ hiddenProjects: ['p-hidden'] });
		let now = 0;
		const rt = createRuntime(w.tenant, {
			planeUrl: 'https://plane.example.com',
			store: new Store(':memory:'),
			plane: w.plane,
			miro: w.miro,
			now: () => now,
		});
		expect((await rt.projects()).map((p) => p.id)).toEqual(['p1']);
		await rt.projects();
		expect(w.plane.calls).toEqual(['listProjects']);
		now = CACHE_TTL_MS - 1;
		await rt.projects();
		expect(w.plane.calls).toHaveLength(1);
		now = CACHE_TTL_MS;
		await rt.projects();
		expect(w.plane.calls).toEqual(['listProjects', 'listProjects']);
	});

	test('keyOf и проверка проекта перечитывают список при промахе, но не чаще окна', async () => {
		const w = world();
		let now = 0;
		const rt = createRuntime(w.tenant, {
			planeUrl: 'https://plane.example.com',
			store: new Store(':memory:'),
			plane: w.plane,
			miro: w.miro,
			now: () => now,
			minGapMs: 1000,
		});
		await rt.projects();
		w.plane.projects.push({ id: 'p9', identifier: 'NEW', name: 'Новый', archived: false });
		now = 10;
		expect(await rt.keyOf('p9', 1)).toBe('NEW-1');
		expect((await rt.projects({ refresh: true })).map((p) => p.id)).toContain('p9');
		expect(w.plane.calls.filter((c) => c === 'listProjects')).toHaveLength(2);
		// a second miss inside the gap does not reload
		await expect(rt.keyOf('nope', 1)).rejects.toThrow('unknown project');
		now = 500;
		await expect(rt.keyOf('nope', 1)).rejects.toThrow('unknown project');
		expect(w.plane.calls.filter((c) => c === 'listProjects')).toHaveLength(2);
		now = 1010;
		await expect(rt.keyOf('nope', 1)).rejects.toThrow('unknown project');
		expect(w.plane.calls.filter((c) => c === 'listProjects')).toHaveLength(3);
	});

	test('isHidden: по списку тенанта', () => {
		const w = world({ hiddenProjects: ['p-hidden'] });
		expect(w.rt.isHidden('p-hidden')).toBe(true);
		expect(w.rt.isHidden('p1')).toBe(false);
	});

	test('keyOf: ключ из полного списка, скрытые и архивные проекты тоже; неизвестный проект бросает', async () => {
		const w = world({ hiddenProjects: ['p-hidden'] });
		expect(await w.rt.keyOf('p1', 7)).toBe('LAB-7');
		expect(await w.rt.keyOf('p-hidden', 3)).toBe('HID-3');
		expect(await w.rt.keyOf('p-arch', 1)).toBe('OLD-1');
		await expect(w.rt.keyOf('nope', 1)).rejects.toThrow('unknown project');
	});

	test('state: по проекту и id, неизвестный → null, список проекта в кэше', async () => {
		const w = world();
		expect(await w.rt.state('p1', 's-started')).toEqual({
			id: 's-started',
			name: 'In Progress',
			group: 'started',
		});
		expect(await w.rt.state('p1', 'nope')).toBeNull();
		expect(await w.rt.state('p2', 's-started')).toBeNull();
		expect(w.plane.calls).toEqual(['listStates', 'listStates']);
	});

	test('memberNames: имена в порядке id, неизвестные пропущены, участники в кэше', async () => {
		const w = world();
		expect(await w.rt.memberNames(['u2', 'ghost', 'u1'])).toEqual(['Борис', 'Аня']);
		expect(await w.rt.memberNames([])).toEqual([]);
		expect(w.plane.calls).toEqual(['listMembers']);
	});

	test('по умолчанию строит PlaneClient и MiroClient с токеном команды из Store', async () => {
		const w = world();
		const calls: string[] = [];
		const store = new Store(':memory:');
		const rt = createRuntime(w.tenant, {
			planeUrl: 'https://plane.example.com',
			store,
			fetch: async (url, init) => {
				calls.push(`${init.method} ${url} ${new Headers(init.headers).get('authorization')}`);
				if (url.endsWith('/auth/o/token/'))
					return Response.json({ access_token: 'bot', expires_in: 3600 });
				if (url.startsWith('https://api.miro.com/'))
					return Response.json({ id: 'b', name: 'Доска' });
				return Response.json([]);
			},
		});
		await expect(rt.miro.getBoard('b')).rejects.toThrow('not connected');
		store.putMiroToken(w.tenant.miroTeamId, '42', 'miro-token');
		expect(await rt.miro.getBoard('b')).toEqual({ id: 'b', name: 'Доска' });
		expect(calls.at(-1)).toBe('GET https://api.miro.com/v2/boards/b Bearer miro-token');
		await rt.plane.listProjects();
		expect(calls.some((c) => c.includes('example-ws') && c.endsWith('Bearer bot'))).toBe(true);
	});

	test('PlaneClient получает секреты и установку тенанта; часы runtime доходят до токена', async () => {
		const w = world();
		const seen: Array<{ url: string; auth: string | null; body: string }> = [];
		let tokens = 0;
		let now = 0;
		const rt = createRuntime(w.tenant, {
			planeUrl: 'https://plane.example.com',
			store: new Store(':memory:'),
			now: () => now,
			fetch: async (url, init) => {
				seen.push({
					url,
					auth: new Headers(init.headers).get('authorization'),
					body: String(init.body ?? ''),
				});
				if (url.endsWith('/auth/o/token/')) {
					tokens++;
					return Response.json({ access_token: `bot-${tokens}`, expires_in: 3600 });
				}
				if (url.includes('/members/')) return Response.json([]);
				return Response.json({ id: w.tenant.auth.appInstallationId, app_bot: 'bot-user' });
			},
		});
		expect(await rt.plane.botUserId()).toBe('bot-user');
		const basic = Buffer.from(`${w.tenant.auth.clientId}:${w.tenant.auth.clientSecret}`).toString(
			'base64',
		);
		expect(seen[0]?.auth).toBe(`Basic ${basic}`);
		expect(new URLSearchParams(seen[0]?.body).get('app_installation_id')).toBe(
			w.tenant.auth.appInstallationId,
		);
		expect(seen[1]?.url).toBe(
			`https://plane.example.com/auth/o/app-installation/?id=${w.tenant.auth.appInstallationId}`,
		);
		expect(seen[1]?.auth).toBe('Bearer bot-1');
		// 3600 s lifetime minus the renewal margin: still cached at 2999 s, renewed at 3000 s
		now = 2_999_000;
		await rt.plane.listMembers();
		expect(tokens).toBe(1);
		now = 3_000_000;
		await rt.plane.listMembers();
		expect(tokens).toBe(2);
	});
});
