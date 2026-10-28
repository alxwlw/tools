import { describe, expect, test } from 'bun:test';

import { PlaneAuthError } from '@alxwlw/plane-app';

import type { GitHubAppConfig, Tenant } from '../src/config.ts';
import type { GitHubApp } from '../src/github/app.ts';
import type { LogEntry } from '../src/log.ts';
import { PlaneApiError } from '../src/plane.ts';
import { createRuntimes, type RuntimeDeps } from '../src/runtime.ts';
import { Store } from '../src/store.ts';
import { checkHealth, watchdogState } from '../src/watchdog.ts';
import { serviceConfigOf, tenantOf } from './config-fixture.ts';
import { FakePlane } from './fake-plane.ts';

const HOUR = 3_600_000;
const START = Date.parse('2026-10-28T00:00:00Z');

/** Runtimes over fakes; `health` answers for every App and records the window it was asked for. */
function setup(
	tenants: Tenant[] = [tenantOf()],
	over: Partial<RuntimeDeps> = {},
	health: () => Promise<{ appOk: boolean; failed: number }> = async () => ({
		appOk: true,
		failed: 0,
	}),
) {
	const logs: LogEntry[] = [];
	const windows: string[] = [];
	const planes = new Map(tenants.map((t) => [t.id, FakePlane.delivery()]));
	const githubApp = (config: GitHubAppConfig): GitHubApp => ({
		config,
		client: () => {
			throw new Error('no client in the watchdog');
		},
		installationFor: async () => null,
		health: (sinceIso) => {
			windows.push(sinceIso);
			return health();
		},
	});
	const runtimes = createRuntimes(serviceConfigOf(tenants), {
		store: new Store(':memory:'),
		log: () => {},
		plane: (tenant) => planes.get(tenant.id) as FakePlane,
		githubApp,
		...over,
	});
	const state = watchdogState();
	const check = (now: number) =>
		checkHealth({ runtimes, log: (e) => logs.push(e), now, startedAt: START, state });
	const plane = (id = 'acme') => planes.get(id) as FakePlane;
	return { runtimes, logs, windows, check, plane, state };
}

describe('сторож: Plane', () => {
	test('сторож: Plane 401 — plane.auth_failed один раз, потом plane.auth_ok', async () => {
		// The real bot-token client: the token endpoint refuses the installation (revoked app).
		let refuse = true;
		const fetch = async (url: string) => {
			if (url.endsWith('/auth/o/token/'))
				return refuse
					? new Response('{"error":"invalid_client"}', { status: 401 })
					: new Response(JSON.stringify({ access_token: 't', expires_in: 36_000 }));
			return new Response(JSON.stringify({ results: [], next_page_results: false }));
		};
		const w = setup([tenantOf({ github: [] })], { plane: undefined, fetch });
		await w.check(START + HOUR);
		await w.check(START + 2 * HOUR);
		expect(w.logs).toEqual([{ event: 'plane.auth_failed', level: 'error', tenant: 'acme' }]);
		refuse = false;
		await w.check(START + 3 * HOUR);
		await w.check(START + 4 * HOUR);
		expect(w.logs).toEqual([
			{ event: 'plane.auth_failed', level: 'error', tenant: 'acme' },
			{ event: 'plane.auth_ok', tenant: 'acme' },
		]);
	});

	test('403 Plane — тоже auth_failed; сеть (PlaneAuthError 0) и 5xx — watchdog.failed без смены состояния', async () => {
		const w = setup([tenantOf({ github: [] })]);
		w.plane().failNext('listProjects', new PlaneAuthError(0));
		await w.check(START + HOUR);
		w.plane().failNext('listProjects', new PlaneApiError(502, 'GET', '/projects/'));
		await w.check(START + 2 * HOUR);
		expect(w.logs).toEqual([
			{
				event: 'watchdog.failed',
				level: 'error',
				tenant: 'acme',
				check: 'plane',
				error: 'PlaneAuthError',
			},
			{
				event: 'watchdog.failed',
				level: 'error',
				tenant: 'acme',
				check: 'plane',
				error: 'PlaneApiError',
			},
		]);
		expect(w.state.planeOk.has('acme')).toBe(false);
		w.plane().failNext('listProjects', new PlaneApiError(403, 'GET', '/projects/'));
		await w.check(START + 3 * HOUR);
		expect(w.logs.at(-1)).toEqual({ event: 'plane.auth_failed', level: 'error', tenant: 'acme' });
		w.plane().failNext('listProjects', new PlaneAuthError(400));
		await w.check(START + 4 * HOUR);
		expect(w.logs).toHaveLength(3);
		expect(w.state.planeOk.get('acme')).toBe(false);
	});

	test('сбой одного тенанта не останавливает другого', async () => {
		const w = setup([tenantOf({ github: [] }), tenantOf({ id: 'beta', github: [] })]);
		w.plane('acme').failNext('listProjects', new TypeError('fetch failed'));
		w.plane('beta').failNext('listProjects', new PlaneApiError(401, 'GET', '/projects/'));
		await w.check(START + HOUR);
		expect(w.logs).toEqual([
			{
				event: 'watchdog.failed',
				level: 'error',
				tenant: 'acme',
				check: 'plane',
				error: 'TypeError',
			},
			{ event: 'plane.auth_failed', level: 'error', tenant: 'beta' },
		]);
	});
});

describe('сторож: GitHub App', () => {
	test('сторож: App удалён (GET /app 401) — github.app_unreachable', async () => {
		// The real App client: GET /app with the App JWT.
		let status = 401;
		const fetch = async (url: string) => {
			if (url === 'https://api.github.com/app') return new Response('{}', { status });
			if (url.startsWith('https://api.github.com/app/hook/deliveries')) return new Response('[]');
			return new Response('{}', { status: 404 });
		};
		const w = setup([tenantOf()], {
			githubApp: undefined,
			fetch,
			plane: () => FakePlane.delivery(),
		});
		await w.check(START + HOUR);
		await w.check(START + 2 * HOUR);
		expect(w.logs).toEqual([
			{ event: 'github.app_unreachable', level: 'error', tenant: 'acme', app: 'acme' },
		]);
		status = 200;
		await w.check(START + 3 * HOUR);
		expect(w.logs.at(-1)).toEqual({ event: 'github.app_ok', tenant: 'acme', app: 'acme' });
		expect(w.logs).toHaveLength(2);
	});

	test('упавшие доставки — github.deliveries_failed с числом', async () => {
		let failed = 3;
		const w = setup([tenantOf()], {}, async () => ({ appOk: true, failed }));
		await w.check(START + HOUR);
		expect(w.logs).toEqual([
			{ event: 'github.deliveries_failed', level: 'error', tenant: 'acme', app: 'acme', failed: 3 },
		]);
		failed = 1;
		await w.check(START + 2 * HOUR);
		expect(w.logs).toHaveLength(1);
		failed = 0;
		await w.check(START + 3 * HOUR);
		expect(w.logs.at(-1)).toEqual({ event: 'github.deliveries_ok', tenant: 'acme', app: 'acme' });
		// Each window starts where the last counted one ended, as a valid ISO time; the first at the start.
		expect(w.windows).toEqual([
			'2026-10-28T00:00:00.000Z',
			'2026-10-28T01:00:00.000Z',
			'2026-10-28T02:00:00.000Z',
		]);
	});

	test('недоступный App не закрывает окно доставок; ошибка health — watchdog.failed', async () => {
		let answer: () => Promise<{ appOk: boolean; failed: number }> = async () => ({
			appOk: false,
			failed: 0,
		});
		const w = setup([tenantOf()], {}, () => answer());
		await w.check(START + HOUR);
		answer = () => Promise.reject(new Error('GitHub GET /app/hook/deliveries → 502'));
		await w.check(START + 2 * HOUR);
		answer = async () => ({ appOk: true, failed: 0 });
		await w.check(START + 3 * HOUR);
		expect(w.windows).toEqual([
			'2026-10-28T00:00:00.000Z',
			'2026-10-28T00:00:00.000Z',
			'2026-10-28T00:00:00.000Z',
		]);
		expect(w.logs).toEqual([
			{ event: 'github.app_unreachable', level: 'error', tenant: 'acme', app: 'acme' },
			{
				event: 'watchdog.failed',
				level: 'error',
				tenant: 'acme',
				app: 'acme',
				check: 'github',
				error: 'Error',
			},
			{ event: 'github.app_ok', tenant: 'acme', app: 'acme' },
		]);
	});
});

describe('сторож: тишина входов', () => {
	test('сторож: вход Vercel молчит дольше silenceHours — input.silent один раз; доставка — input.alive', async () => {
		const w = setup([tenantOf({ github: [] })]);
		const runtime = w.runtimes.tenants.get('acme');
		await w.check(START + 72 * HOUR);
		expect(w.logs).toEqual([]);
		await w.check(START + 72 * HOUR + 1);
		await w.check(START + 90 * HOUR);
		expect(w.logs).toEqual([
			{ event: 'input.silent', level: 'error', tenant: 'acme', input: 'vercel', hours: 72 },
		]);
		runtime?.lastDelivery.set('vercel', START + 91 * HOUR);
		await w.check(START + 92 * HOUR);
		expect(w.logs.at(-1)).toEqual({ event: 'input.alive', tenant: 'acme', input: 'vercel' });
		// Counted from the last delivery now: 72 h after it, silent again.
		await w.check(START + 91 * HOUR + 72 * HOUR + 1);
		expect(w.logs.map((l) => l.event)).toEqual(['input.silent', 'input.alive', 'input.silent']);
	});

	test('отсчёт — от старта, если доставка была раньше старта', async () => {
		const w = setup([tenantOf({ github: [] })]);
		w.runtimes.tenants.get('acme')?.lastDelivery.set('vercel', START - 100 * HOUR);
		await w.check(START + 72 * HOUR);
		expect(w.logs).toEqual([]);
	});

	test('вход без silenceHours не сторожится; выключенный вход — тоже', async () => {
		const quiet = setup([tenantOf({ github: [], silenceHours: {} })]);
		await quiet.check(START + 1000 * HOUR);
		expect(quiet.logs).toEqual([]);
		const off = setup([
			tenantOf({
				github: [],
				silenceHours: { dokploy: 1 },
				inputs: { grafana: `ph_${'a'.repeat(48)}`, vercel: null, dokploy: null },
			}),
		]);
		await off.check(START + 1000 * HOUR);
		expect(off.logs).toEqual([]);
	});
});
