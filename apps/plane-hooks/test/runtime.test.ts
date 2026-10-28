import { describe, expect, test } from 'bun:test';

import type { GitHubAppConfig, Tenant } from '../src/config.ts';
import type { GitHubApp } from '../src/github/app.ts';
import { eventDeps, githubDeployFact } from '../src/jobs.ts';
import type { LogEntry } from '../src/log.ts';
import { CACHE_TTL_MS, createRuntimes, type RuntimeDeps } from '../src/runtime.ts';
import { Store } from '../src/store.ts';
import { serviceConfigOf, TEST_KEY_PEM, tenantOf } from './config-fixture.ts';
import { FakeGitHub } from './fake-github.ts';
import { FakePlane } from './fake-plane.ts';

const app = (name: string, appId: number, owner: string): Tenant['github'][number] => ({
	name,
	appId,
	owner,
	privateKeyPem: TEST_KEY_PEM,
	webhookSecret: `${name}-secret`,
});

/** One FakeGitHub per App, so a client tells which App it came from; `installed` lists repos per App. */
function setup(tenants: Tenant[], installed: Record<string, string[]> = {}) {
	const logs: LogEntry[] = [];
	const lookups: string[] = [];
	const hubs = new Map<string, FakeGitHub>();
	let clock = Date.parse('2026-10-28T12:00:00Z');
	const plane = FakePlane.delivery();
	const githubApp = (config: GitHubAppConfig): GitHubApp => {
		const hub = new FakeGitHub();
		hubs.set(config.name, hub);
		return {
			config,
			client: () => hub,
			installationFor: async (repo) => {
				lookups.push(`${config.name} ${repo}`);
				return (installed[config.name] ?? []).includes(repo) ? config.appId * 10 : null;
			},
			health: async () => ({ appOk: true, failed: 0 }),
		};
	};
	const deps: RuntimeDeps = {
		store: new Store(':memory:'),
		log: (entry) => logs.push(entry),
		now: () => clock,
		plane: () => plane,
		githubApp,
	};
	const runtimes = createRuntimes(serviceConfigOf(tenants), deps);
	return {
		runtimes,
		plane,
		logs,
		lookups,
		hub: (name: string) => hubs.get(name),
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

const twoApps = () =>
	tenantOf({ github: [app('acme', 1_000_001, 'acme'), app('beta', 1_000_002, 'Beta-Org')] });

describe('runtime: GitHub по владельцу репозитория', () => {
	test('runtime: github(repo) — App владельца репозитория; чужой владелец — null', async () => {
		const w = setup([twoApps()], { acme: ['acme/api'], beta: ['beta-org/web'] });
		const sync = w.runtimes.tenants.get('acme')?.sync;
		expect(await sync?.github('acme/api')).toBe(w.hub('acme') as FakeGitHub);
		// The owner matches without regard to case.
		expect(await sync?.github('beta-org/web')).toBe(w.hub('beta') as FakeGitHub);
		expect(await sync?.github('other/repo')).toBeNull();
		// The owner's App, but not installed on that repository.
		expect(await sync?.github('acme/secret')).toBeNull();
		expect(w.lookups).toEqual(['acme acme/api', 'beta beta-org/web', 'acme acme/secret']);
	});

	test('установка репозитория кешируется на 10 минут, потом спрашивается снова', async () => {
		const w = setup([tenantOf()], { acme: ['acme/api'] });
		const sync = w.runtimes.tenants.get('acme')?.sync;
		await sync?.github('acme/api');
		await sync?.github('ACME/API');
		w.advance(CACHE_TTL_MS - 1);
		await sync?.github('acme/api');
		expect(w.lookups).toEqual(['acme acme/api']);
		w.advance(1);
		await sync?.github('acme/api');
		expect(w.lookups).toEqual(['acme acme/api', 'acme acme/api']);
	});

	test('apps — по id App, с runtime его тенанта', () => {
		const w = setup([twoApps(), tenantOf({ id: 'gamma', github: [app('gamma', 7, 'gamma')] })]);
		expect([...w.runtimes.apps.keys()]).toEqual([1_000_001, 1_000_002, 7]);
		expect(w.runtimes.apps.get(1_000_002)?.runtime.tenant.id).toBe('acme');
		expect(w.runtimes.apps.get(7)?.runtime.tenant.id).toBe('gamma');
		expect(w.runtimes.apps.get(7)?.app.config.name).toBe('gamma');
	});
});

describe('runtime: кеши и предупреждения', () => {
	test('проекты и состояния — ttl 10 минут', async () => {
		const w = setup([tenantOf()]);
		const sync = w.runtimes.tenants.get('acme')?.sync;
		await sync?.projects();
		await sync?.projects();
		await sync?.states('p-eng');
		await sync?.states('p-eng');
		await sync?.states('p-qa');
		const count = (method: string) => w.plane.calls.filter((call) => call === method).length;
		expect([count('listProjects'), count('listStates')]).toEqual([1, 2]);
		w.advance(CACHE_TTL_MS);
		await sync?.projects();
		await sync?.states('p-eng');
		expect([count('listProjects'), count('listStates')]).toEqual([2, 3]);
	});

	test('warnOnce — одна строка на причину на процесс', () => {
		const w = setup([tenantOf()]);
		const sync = w.runtimes.tenants.get('acme')?.sync;
		sync?.warnOnce('state_missing:QA:Done', { project: 'QA', state: 'Done' });
		sync?.warnOnce('state_missing:QA:Done', { project: 'QA', state: 'Done' });
		sync?.warnOnce('no_app:acme/web', { repo: 'acme/web' });
		expect(w.logs).toEqual([
			{
				event: 'warning',
				level: 'warn',
				tenant: 'acme',
				reason: 'state_missing:QA:Done',
				project: 'QA',
				state: 'Done',
			},
			{
				event: 'warning',
				level: 'warn',
				tenant: 'acme',
				reason: 'no_app:acme/web',
				repo: 'acme/web',
			},
		]);
	});

	test('containsVia — на событие: каждое событие спрашивает GitHub заново', async () => {
		const w = setup([tenantOf()], { acme: ['acme/api'] });
		const runtime = w.runtimes.tenants.get('acme');
		if (runtime === undefined) throw new Error('no runtime');
		const hub = w.hub('acme') as FakeGitHub;
		hub.commit('s0', [], 'init');
		hub.deploy('acme/api', 'staging', 's0', 'success');
		const first = eventDeps(runtime);
		await first.contains('acme/api', 'staging', 's0');
		await first.contains('acme/api', 'staging', 's0');
		const listed = () => hub.calls.filter((call) => call.startsWith('listDeployments')).length;
		expect(listed()).toBe(1);
		const second = eventDeps(runtime);
		expect(second.contains).not.toBe(first.contains);
		await second.contains('acme/api', 'staging', 's0');
		expect(listed()).toBe(2);
		// Everything else is the runtime's own.
		expect(second.github).toBe(runtime.sync.github);
		expect(second.cursor).toBe(runtime.sync.cursor);
	});

	test('тенант без incidents — сообщение об инциденте ничего не делает', async () => {
		const w = setup([
			tenantOf({ incidents: null, inputs: { grafana: null, vercel: 'v', dokploy: null } }),
		]);
		const result = await w.runtimes.tenants.get('acme')?.incidents.report({
			status: 'resolved',
			source: 'vercel',
			key: 'deploy:x',
			at: '2026-10-28T12:00:00.000Z',
			noteHtml: '<p>x</p>',
		});
		expect(result).toEqual({ action: 'noop', workItemId: null });
		expect(w.plane.calls).toEqual([]);
	});

	test('инциденты: проект ищется раз в 10 минут, метки — одним репортёром на проект', async () => {
		const w = setup([tenantOf()]);
		const incidents = w.runtimes.tenants.get('acme')?.incidents;
		const firing = (key: string) => ({
			status: 'firing' as const,
			source: 'grafana' as const,
			key,
			occurrence: '2026-10-28T10:00:00Z',
			at: '2026-10-28T10:00:00Z',
			title: key,
			bodyHtml: '',
			noteHtml: '<p>x</p>',
			priority: 'high' as const,
			label: 'alert' as const,
		});
		await incidents?.report(firing('fp-1'));
		await incidents?.report(firing('fp-2'));
		const count = (method: string) => w.plane.calls.filter((call) => call === method).length;
		expect([count('listProjects'), count('listLabels')]).toEqual([1, 1]);
		expect(w.plane.workItems.filter((i) => i.project === 'p-inc')).toHaveLength(2);
	});
});

describe('runtime: настоящие клиенты', () => {
	test('Plane — бот-токен установки тенанта со скоупами приложения, затем запрос в воркспейс', async () => {
		const requests: Array<{ url: string; body: string; auth: string }> = [];
		const fetch = async (url: string, init: RequestInit) => {
			const auth = (init.headers as Record<string, string>).Authorization ?? '';
			requests.push({ url, body: typeof init.body === 'string' ? init.body : '', auth });
			if (url.endsWith('/auth/o/token/'))
				return new Response(JSON.stringify({ access_token: 'bot-token', expires_in: 36_000 }));
			return new Response(
				JSON.stringify({ results: [{ id: 'p1', identifier: 'ENG' }], next_page_results: false }),
			);
		};
		const runtimes = createRuntimes(serviceConfigOf([tenantOf()]), {
			store: new Store(':memory:'),
			log: () => {},
			fetch,
		});
		expect(await runtimes.tenants.get('acme')?.plane.listProjects()).toEqual([
			{ id: 'p1', identifier: 'ENG' },
		]);
		expect(requests.map((r) => r.url)).toEqual([
			'https://plane.example.com/auth/o/token/',
			'https://plane.example.com/api/v1/workspaces/example-ws/projects/?per_page=100',
		]);
		const token = new URLSearchParams(requests[0]?.body);
		expect(token.get('app_installation_id')).toBe('00000000-0000-4000-8000-000000000002');
		expect(token.get('scope')?.split(' ')).toContain('projects.work_items.links:write');
		// The tenant's client id and secret (Basic), then the bot token on the API call.
		expect(requests.map((r) => r.auth)).toEqual([
			`Basic ${Buffer.from('example-client-id:plane-secret').toString('base64')}`,
			'Bearer bot-token',
		]);
		expect(runtimes.apps.get(1_000_001)?.app.config.webhookSecret).toBe('gh-secret');
	});
});

describe('githubDeployFact', () => {
	test('at — created_at статуса (event.at), не создание деплоя и не время обработки', () => {
		const fact = githubDeployFact({
			kind: 'deployment_status',
			appId: 1,
			deliveryId: 'd',
			installationId: 2,
			deployment: {
				id: 501,
				repo: 'acme/api',
				sha: 'abc',
				environment: 'staging',
				creator: 'github-actions[bot]',
				description: null,
			},
			state: 'success',
			logUrl: 'https://example.com/run/1',
			at: '2026-10-28T10:06:00.000Z',
		});
		expect(fact).toEqual({
			repo: 'acme/api',
			environment: 'staging',
			sha: 'abc',
			deploymentId: 501,
			logUrl: 'https://example.com/run/1',
			at: '2026-10-28T10:06:00.000Z',
		});
	});
});
