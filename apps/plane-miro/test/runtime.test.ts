import { describe, expect, test } from 'bun:test';

import { CACHE_TTL_MS, createRuntime } from '../src/runtime.ts';
import { Store } from '../src/store.ts';
import { world } from './world.ts';

describe('createRuntime', () => {
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
});
