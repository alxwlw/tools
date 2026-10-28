import { describe, expect, test } from 'bun:test';

import type { IncidentResult } from '../src/incident.ts';
import { PlaneApiError } from '../src/plane.ts';
import { MAX_BODY_BYTES } from '../src/server.ts';
import { fixtureBytes } from './fixtures.ts';
import {
	APP_ID,
	BASE,
	githubRequest,
	GRAFANA_TOKEN,
	grafanaRequest,
	pullPayload,
	T0,
	tenantOf,
	vercelRequest,
	world,
} from './server-harness.ts';

/** A request whose body must never be read: any read marks `touched`. */
function untouchable(req: Request): { req: Request; touched: () => boolean } {
	let touched = false;
	for (const method of ['text', 'arrayBuffer', 'json', 'blob'] as const) {
		Object.defineProperty(req, method, {
			value: () => {
				touched = true;
				throw new Error('body read');
			},
		});
	}
	Object.defineProperty(req, 'body', {
		get: () => {
			touched = true;
			throw new Error('body read');
		},
	});
	return { req, touched: () => touched };
}

const incItems = (w: ReturnType<typeof world>) =>
	w.plane.workItems.filter((item) => item.project === 'p-inc');

describe('маршруты', () => {
	test('/healthz — ok', async () => {
		const w = world();
		const health = await w.handler(new Request(`${BASE}/healthz`));
		expect(health.status).toBe(200);
		expect(await health.text()).toBe('ok');
		expect((await w.handler(new Request(`${BASE}/healthz`, { method: 'POST' }))).status).toBe(405);
		expect((await w.handler(new Request(`${BASE}/nope`))).status).toBe(404);
		expect((await w.handler(new Request(`${BASE}/hooks/grafana`))).status).toBe(404);
		expect((await w.handler(new Request(`${BASE}/hooks/github`))).status).toBe(405);
		expect((await w.handler(new Request(`${BASE}/hooks/acme/grafana`))).status).toBe(405);
		expect(w.logs).toEqual([]);
	});

	test('неизвестный тенант, неизвестный App и выключенный вход — 404 без строки лога', async () => {
		const w = world({
			tenants: [tenantOf({ inputs: { grafana: GRAFANA_TOKEN, vercel: null, dokploy: null } })],
		});
		const requests = [
			grafanaRequest('nobody', { alerts: [] }),
			vercelRequest('acme', { type: 'deployment.succeeded' }),
			new Request(`${BASE}/hooks/acme/dokploy`, { method: 'POST', body: '{}' }),
			githubRequest('pull_request', pullPayload('opened'), 999),
		];
		for (const raw of requests) {
			const { req, touched } = untouchable(raw);
			const res = await w.handler(req);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe('not found');
			expect(touched()).toBe(false);
		}
		// A disabled input answers GET with 404 too, not 405: it looks like no path at all.
		expect((await w.handler(new Request(`${BASE}/hooks/acme/vercel`))).status).toBe(404);
		expect(w.logs).toEqual([]);
		expect(w.plane.calls).toEqual([]);
	});

	test('App по заголовку: нет или кривой x-github-hook-installation-target-id — 404 без чтения тела', async () => {
		const w = world();
		// Headers trims surrounding blanks itself, so ` 1000001` is the App: no case for it here.
		for (const value of [
			null,
			'',
			'abc',
			'0',
			'-1',
			'1.5',
			'1e3',
			'0x10',
			`+${APP_ID}`,
			`${APP_ID}0`,
		]) {
			const { req, touched } = untouchable(
				githubRequest('pull_request', pullPayload('opened'), APP_ID, {
					'x-github-hook-installation-target-id': value,
				}),
			);
			expect((await w.handler(req)).status).toBe(404);
			expect(touched()).toBe(false);
		}
		expect(w.logs).toEqual([]);
		// Control: the exact id is the App.
		expect((await w.send(githubRequest('ping', { zen: 'z' }, APP_ID))).status).toBe(200);
	});

	test('тело больше 4 MiB — 413; после аутентификации Grafana — строка rejected, до неё — без строки', async () => {
		const w = world();
		expect(MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
		const big = ' '.repeat(MAX_BODY_BYTES + 1);
		expect((await w.handler(grafanaRequest('acme', big))).status).toBe(413);
		expect(w.lines('delivery.rejected')).toEqual([
			{
				event: 'delivery.rejected',
				level: 'error',
				tenant: 'acme',
				input: 'grafana',
				status: 413,
				error: 'payload too large',
			},
		]);
		// Exactly the limit is read and parsed (blank is no JSON → 400).
		expect((await w.handler(grafanaRequest('acme', ' '.repeat(MAX_BODY_BYTES)))).status).toBe(400);

		const anonymous = world();
		const github = githubRequest('pull_request', big);
		expect((await anonymous.handler(github)).status).toBe(413);
		const vercel = vercelRequest('acme', big, '0'.repeat(40));
		expect((await anonymous.handler(vercel)).status).toBe(413);
		expect(anonymous.logs).toEqual([]);
	});

	test('заявленный content-length больше лимита → 413 без чтения тела', async () => {
		const w = world();
		const oversize = { 'content-length': String(MAX_BODY_BYTES + 1) };
		const { req, touched } = untouchable(grafanaRequest('acme', '{}', undefined, oversize));
		expect((await w.handler(req)).status).toBe(413);
		expect(touched()).toBe(false);
	});

	test('/plane/webhook — 200 при любом теле, тело не читается', async () => {
		const w = world();
		const { req, touched } = untouchable(
			new Request(`${BASE}/plane/webhook`, { method: 'POST', body: '\u0000not json' }),
		);
		const res = await w.handler(req);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
		expect(touched()).toBe(false);
		expect((await w.handler(new Request(`${BASE}/plane/webhook`))).status).toBe(405);
		expect(w.logs).toEqual([]);
	});
});

describe('страницы установки', () => {
	test('/plane/setup?tenant=acme — 302, неизвестный — 404', async () => {
		const w = world();
		const res = await w.handler(new Request(`${BASE}/plane/setup?tenant=acme`));
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get('location') as string);
		expect(`${location.origin}${location.pathname}`).toBe(
			'https://plane.example.com/auth/o/authorize-app/',
		);
		expect(location.searchParams.get('client_id')).toBe('example-client-id');
		expect(location.searchParams.get('redirect_uri')).toBe(
			'https://hooks.example.com/plane/oauth/callback',
		);
		expect(location.searchParams.get('scope')?.split(' ')).toContain('projects.work_items:write');
		for (const query of ['?tenant=nobody', '']) {
			expect((await w.handler(new Request(`${BASE}/plane/setup${query}`))).status).toBe(404);
		}
		expect(
			(await w.handler(new Request(`${BASE}/plane/setup?tenant=acme`, { method: 'POST' }))).status,
		).toBe(405);
	});

	test('/plane/oauth/callback — id установки на странице и в строке plane.installed', async () => {
		const w = world();
		const res = await w.handler(
			new Request(`${BASE}/plane/oauth/callback?app_installation_id=inst-7&code=secret-code`),
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('app_installation_id=inst-7\n');
		expect(w.logs).toEqual([{ event: 'plane.installed', appInstallationId: 'inst-7' }]);
	});

	test('/github/setup — страница с формой', async () => {
		const w = world();
		const res = await w.handler(
			new Request(`${BASE}/github/setup?tenant=acme&owner=acme-corp&kind=org`),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
		const html = await res.text();
		const nowSeconds = Math.floor(T0 / 1000);
		expect(html).toContain(
			`action="https://github.com/organizations/acme-corp/settings/apps/new?state=acme.${nowSeconds}.`,
		);
		expect(html).toContain('&quot;url&quot;:&quot;https://hooks.example.com/hooks/github&quot;');
		const user = await w.handler(
			new Request(`${BASE}/github/setup?tenant=acme&owner=octo&kind=user`),
		);
		expect(await user.text()).toContain('action="https://github.com/settings/apps/new?state=acme.');
	});

	test('/github/setup: неизвестный тенант — 404; без owner или kind — 400 с подсказкой', async () => {
		const w = world();
		expect(
			(await w.handler(new Request(`${BASE}/github/setup?tenant=nobody&owner=acme&kind=org`)))
				.status,
		).toBe(404);
		for (const query of ['owner=acme', 'kind=org', 'owner=acme&kind=team', 'owner=-bad&kind=org']) {
			const res = await w.handler(new Request(`${BASE}/github/setup?tenant=acme&${query}`));
			expect(res.status).toBe(400);
			expect(await res.text()).toContain('kind=org|user');
		}
	});

	test('/github/callback: чужой state — 400 без обращения к GitHub', async () => {
		const w = world();
		const res = await w.handler(new Request(`${BASE}/github/callback?code=abc&state=acme.1.00`));
		expect(res.status).toBe(400);
		expect(w.fetches).toEqual([]);
	});
});

describe('Grafana', () => {
	test.each([
		null,
		'Bearer wrong',
		`Bearer ${GRAFANA_TOKEN}x`,
		`Basic ${GRAFANA_TOKEN}`,
		GRAFANA_TOKEN,
		`Token: ${GRAFANA_TOKEN}`,
	])('неверный Bearer %p — 401 до чтения тела, без строки лога', async (auth) => {
		const w = world();
		const { req, touched } = untouchable(
			grafanaRequest('acme', await fixtureBytes('grafana-firing.json'), auth),
		);
		expect((await w.handler(req)).status).toBe(401);
		expect(touched()).toBe(false);
		expect(incItems(w)).toEqual([]);
		expect(w.logs).toEqual([]);
		expect(w.runtime().lastDelivery.has('grafana')).toBe(false);
	});

	test('Grafana: как раньше, по пути тенанта; неверный Bearer — 401', async () => {
		const w = world();
		const res = await w.handler(grafanaRequest('acme', await fixtureBytes('grafana-firing.json')));
		expect(res.status).toBe(200);
		expect(
			incItems(w).map((item) => [item.external_id, item.external_source, item.priority]),
		).toEqual([
			['a1b2c3d4e5f60718', 'grafana', 'urgent'],
			['0f1e2d3c4b5a6978', 'grafana', 'high'],
		]);
		expect(w.logs.map((l) => [l.tenant, l.source, l.event, l.key, l.action])).toEqual([
			['acme', 'grafana', 'alert.firing', 'a1b2c3d4e5f60718', 'created'],
			['acme', 'grafana', 'alert.firing', '0f1e2d3c4b5a6978', 'created'],
		]);
		expect(w.logs.every((l) => typeof l.ms === 'number' && typeof l.workItemId === 'string')).toBe(
			true,
		);
		expect(JSON.stringify(w.logs)).not.toContain(GRAFANA_TOKEN);
		expect(w.runtime().lastDelivery.get('grafana')).toBe(T0);
		expect((await w.handler(grafanaRequest('acme', '{}', 'Bearer wrong'))).status).toBe(401);
	});

	test('таблица приоритетов тенанта: warning в prod — medium', async () => {
		const tenant = tenantOf();
		const w = world({
			tenants: [
				{
					...tenant,
					incidents: {
						project: 'INC',
						priority: { ...tenant.incidents?.priority, warning: { '*': 'medium' } },
					},
				},
			],
		});
		const body = {
			alerts: [
				{
					status: 'firing',
					fingerprint: 'fp-warn',
					startsAt: '2026-10-06T10:00:00Z',
					labels: { alertname: 'Slow', severity: 'warning' },
					annotations: {},
				},
			],
		};
		expect((await w.handler(grafanaRequest('acme', body))).status).toBe(200);
		expect(incItems(w).map((item) => item.priority)).toEqual(['medium']);
	});

	test('не JSON и чужая форма → 400 и строка rejected с причиной', async () => {
		const w = world();
		const notJson = await w.handler(grafanaRequest('acme', '{not json'));
		expect([notJson.status, await notJson.text()]).toEqual([400, 'invalid json']);
		const shape = await w.handler(grafanaRequest('acme', '{}'));
		expect([shape.status, await shape.text()]).toEqual([400, 'grafana: body has no alerts[]']);
		expect(w.lines('delivery.rejected').map((l) => [l.input, l.status, l.error])).toEqual([
			['grafana', 400, 'invalid json'],
			['grafana', 400, 'BadPayload: grafana: body has no alerts[]'],
		]);
		expect(incItems(w)).toEqual([]);
	});

	test('один алерт упал (429) → 502 с числом, остальные всё равно обработаны', async () => {
		const w = world();
		w.plane.failNext('createWorkItem', new PlaneApiError(429, 'POST', '/projects/p/work-items/'));
		const res = await w.handler(grafanaRequest('acme', await fixtureBytes('grafana-firing.json')));
		expect(res.status).toBe(502);
		expect(await res.text()).toBe('plane: 1 of 2 alerts failed');
		expect(w.logs.map((l) => [l.key, l.action, l.workItemId])).toEqual([
			['a1b2c3d4e5f60718', 'error', null],
			['0f1e2d3c4b5a6978', 'created', expect.any(String)],
		]);
		expect(w.logs[0]).toMatchObject({
			level: 'error',
			error: 'PlaneApiError: Plane POST /projects/p/work-items/ → 429',
		});
		expect(w.logs[0]?.annotation).toBeUndefined();
	});

	test('проекта инцидентов нет — 502 на каждый повтор, строка warn одна', async () => {
		const w = world({ tenants: [tenantOf({ incidents: { project: 'NOPE', priority: {} } })] });
		const body = await fixtureBytes('grafana-firing.json');
		for (let attempt = 0; attempt < 3; attempt++) {
			expect((await w.handler(grafanaRequest('acme', body))).status).toBe(502);
		}
		expect(w.lines('warning')).toEqual([
			{
				event: 'warning',
				level: 'warn',
				tenant: 'acme',
				reason: 'incident_project_missing:NOPE',
				project: 'NOPE',
			},
		]);
		expect(w.lines('alert.firing').map((l) => l.error)).toContain(
			'Error: incident project NOPE not found',
		);
		// Another failure of the lookup is no missing project: no warn for it.
		const flaky = world();
		flaky.plane.failNext('listProjects');
		expect((await flaky.handler(grafanaRequest('acme', body))).status).toBe(502);
		expect(flaky.lines('warning')).toEqual([]);
	});
});

describe('Grafana: отметки на дашбордах', () => {
	test('новое срабатывание — отметка «инцидент» с заголовком и env; повтор (noop) — без отметки', async () => {
		const w = world();
		const body = await fixtureBytes('grafana-firing.json');
		await w.handler(grafanaRequest('acme', body));
		expect(w.logs.map((l) => [l.annotation, l.title, l.env])).toEqual([
			['incident', 'Сработал: [prod] ServiceDown: order-gateway is down', 'production'],
			['incident', 'Сработал: [staging] QueueStalled: settle queue stalled', 'staging'],
		]);
		w.logs.length = 0;
		await w.handler(grafanaRequest('acme', body));
		expect(w.logs.map((l) => [l.action, l.annotation])).toEqual([
			['noop', undefined],
			['noop', undefined],
		]);
	});

	test.each(['created', 'reopened', 'commented'] as const)(
		'срабатывание с действием %s — отметка есть',
		async (action) => {
			const w = world();
			w.runtime().incidents = {
				report: async (): Promise<IncidentResult> => ({ action, workItemId: 'w1' }),
			};
			await w.handler(grafanaRequest('acme', await fixtureBytes('grafana-firing.json')));
			expect(w.logs.map((l) => l.annotation)).toEqual(['incident', 'incident']);
		},
	);

	test('восстановление: commented — «Погас», noop — без отметки', async () => {
		const w = world();
		await w.handler(grafanaRequest('acme', await fixtureBytes('grafana-firing.json')));
		w.logs.length = 0;
		const resolved = await fixtureBytes('grafana-resolved.json');
		expect((await w.handler(grafanaRequest('acme', resolved))).status).toBe(200);
		expect(w.logs[0]).toMatchObject({
			event: 'alert.resolved',
			action: 'commented',
			annotation: 'incident',
			title: 'Погас: [prod] ServiceDown: order-gateway is down',
			env: 'production',
		});
		w.logs.length = 0;
		await w.handler(grafanaRequest('acme', resolved));
		expect(w.logs.map((l) => [l.action, l.annotation])).toEqual([['noop', undefined]]);
	});

	test('сбой, не являющийся Error, — «unknown error»', async () => {
		const w = world();
		w.runtime().incidents = {
			report: async () => {
				throw 'boom';
			},
		};
		await w.handler(grafanaRequest('acme', await fixtureBytes('grafana-firing.json')));
		expect(w.logs[0]?.error).toBe('unknown error');
	});
});
