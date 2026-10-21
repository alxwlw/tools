import { createHmac } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { PlaneApiError } from '../src/plane.ts';
import { MAX_BODY_BYTES } from '../src/server.ts';
import { fixtureBytes } from './fixtures.ts';
import {
	BASE,
	bytes,
	deployRequest,
	grafana,
	harness,
	SHA,
	TOKEN,
	vercel,
} from './server-harness.ts';

describe('маршруты', () => {
	test('healthz, неизвестный путь, неверный метод', async () => {
		const { handler } = harness();
		const health = await handler(new Request(`${BASE}/healthz`));
		expect(health.status).toBe(200);
		expect(await health.text()).toBe('ok');
		expect((await handler(new Request(`${BASE}/healthz`, { method: 'POST' }))).status).toBe(405);
		expect((await handler(new Request(`${BASE}/nope`))).status).toBe(404);
		expect((await handler(new Request(`${BASE}/hooks/grafana`))).status).toBe(405);
	});
});

describe('выключенные входы', () => {
	test('выключенный Vercel: POST /hooks/vercel с подписью верной формы → 404, тело не читается, лога нет', async () => {
		const { handler, logs, signals } = harness({ vercelSecret: null });
		let touched = false;
		const req = vercel(bytes({ type: 'deployment.succeeded' }));
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
		const res = await handler(req);
		expect(res.status).toBe(404);
		expect(await res.text()).toBe('not found');
		expect(touched).toBe(false);
		expect(logs).toEqual([]);
		expect(signals).toHaveLength(0);
	});

	test('выключенный deploy: POST /hooks/deploy → 404, лога нет', async () => {
		const { handler, logs, notes } = harness({ deploySecret: null });
		const res = await handler(deployRequest(bytes({ any: 1 })));
		expect(res.status).toBe(404);
		expect(await res.text()).toBe('not found');
		expect(logs).toEqual([]);
		expect(notes).toHaveLength(0);
	});

	test('выключенный вход и GET → 404, а не 405', async () => {
		const { handler } = harness({ vercelSecret: null, deploySecret: null });
		expect((await handler(new Request(`${BASE}/hooks/vercel`))).status).toBe(404);
		expect((await handler(new Request(`${BASE}/hooks/deploy`))).status).toBe(404);
		// control: an enabled input still answers 405 to GET
		expect((await harness().handler(new Request(`${BASE}/hooks/vercel`))).status).toBe(405);
	});

	test('Grafana работает при выключенных Vercel и deploy', async () => {
		const { handler, signals } = harness({ vercelSecret: null, deploySecret: null });
		const res = await handler(grafana(await fixtureBytes('grafana-firing.json')));
		expect(res.status).toBe(200);
		expect(signals.map((s) => s.key)).toEqual(['a1b2c3d4e5f60718', '0f1e2d3c4b5a6978']);
	});
});

describe('/hooks/grafana', () => {
	test.each([null, 'Bearer wrong', `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, TOKEN])(
		'авторизация %p → 401',
		async (auth) => {
			const { handler, signals } = harness();
			const res = await handler(grafana(await fixtureBytes('grafana-firing.json'), auth));
			expect(res.status).toBe(401);
			expect(signals).toHaveLength(0);
		},
	);

	test('пачка обработана: 200, по строке лога на алерт, без токена в логе', async () => {
		const { handler, signals, logs } = harness();
		const res = await handler(grafana(await fixtureBytes('grafana-firing.json')));
		expect(res.status).toBe(200);
		expect(signals.map((s) => s.key)).toEqual(['a1b2c3d4e5f60718', '0f1e2d3c4b5a6978']);
		expect(logs.map((l) => [l.source, l.event, l.key, l.action, l.workItemId])).toEqual([
			['grafana', 'alert.firing', 'a1b2c3d4e5f60718', 'created', 'w1'],
			['grafana', 'alert.firing', '0f1e2d3c4b5a6978', 'created', 'w1'],
		]);
		expect(logs.every((l) => typeof l.ms === 'number')).toBe(true);
		expect(JSON.stringify(logs)).not.toContain(TOKEN);
	});

	test('не JSON и чужая форма → 400', async () => {
		const { handler, signals } = harness();
		expect((await handler(grafana('{not json'))).status).toBe(400);
		expect((await handler(grafana('{}'))).status).toBe(400);
		expect(signals).toHaveLength(0);
	});

	test('тело больше 1 МБ → 413, ровно 1 МБ разбирается', async () => {
		const { handler } = harness();
		expect((await handler(grafana(' '.repeat(MAX_BODY_BYTES + 1)))).status).toBe(413);
		expect((await handler(grafana(' '.repeat(MAX_BODY_BYTES)))).status).toBe(400);
	});

	test('один алерт упал (429) → 502, остальные всё равно обработаны', async () => {
		const { handler, signals, logs } = harness({
			report: async (signal) => {
				if (signal.key === 'a1b2c3d4e5f60718')
					throw new PlaneApiError(429, 'POST', '/projects/p/work-items/');
				return { action: 'created', workItemId: 'w2' };
			},
		});
		const res = await handler(grafana(await fixtureBytes('grafana-firing.json')));
		expect(res.status).toBe(502);
		expect(signals).toHaveLength(2);
		expect(logs.map((l) => l.action)).toEqual(['error', 'created']);
		expect(logs[0]?.error).toBe('PlaneApiError: Plane POST /projects/p/work-items/ → 429');
	});
});

describe('/hooks/vercel', () => {
	test('неверная или отсутствующая подпись → 401', async () => {
		const raw = await fixtureBytes('vercel-deployment-error.json');
		for (const signature of [
			null,
			'0'.repeat(40),
			createHmac('sha1', 'other').update(raw).digest('hex'),
		]) {
			const { handler, signals } = harness();
			expect((await handler(vercel(raw, signature))).status).toBe(401);
			expect(signals).toHaveLength(0);
		}
	});

	test('другой тип события → 200 ignored, Plane не трогается', async () => {
		const { handler, signals, notes, logs } = harness();
		const res = await handler(vercel(bytes({ type: 'deployment.created', payload: {} })));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ignored');
		expect(signals).toHaveLength(0);
		expect(notes).toHaveLength(0);
		expect(logs[0]?.action).toBe('ignored');
	});

	test('deployment.error → сигнал срабатывания', async () => {
		const { handler, signals } = harness();
		const res = await handler(vercel(await fixtureBytes('vercel-deployment-error.json')));
		expect(res.status).toBe(200);
		expect(signals.map((s) => [s.status, s.key])).toEqual([
			['firing', 'deploy:prj_terminal:production:feat/ops-12-plane-hooks'],
		]);
	});

	test('deployment.succeeded → восстановление и заметки, по строке лога на ключ', async () => {
		const { handler, signals, notes, logs } = harness({
			report: async () => ({ action: 'noop', workItemId: null }),
		});
		const res = await handler(vercel(await fixtureBytes('vercel-deployment-succeeded.json')));
		expect(res.status).toBe(200);
		expect(signals[0]?.status).toBe('resolved');
		expect(notes[0]?.deploymentId).toBe('dpl_ok1');
		expect(logs.map((l) => [l.key, l.action])).toEqual([
			['deploy:prj_terminal:production:feat/ops-12-plane-hooks', 'noop'],
			['OPS-12', 'commented'],
		]);
	});

	test('Plane упал на восстановлении → 502, заметки не пишутся', async () => {
		const { handler, notes } = harness({
			report: async () => {
				throw new PlaneApiError(429, 'GET', '/work-items/');
			},
		});
		expect(
			(await handler(vercel(await fixtureBytes('vercel-deployment-succeeded.json')))).status,
		).toBe(502);
		expect(notes).toHaveLength(0);
	});

	test('Plane упал на заметках → 502', async () => {
		const { handler } = harness({
			notes: async () => {
				throw new PlaneApiError(500, 'POST', '/comments/');
			},
		});
		expect(
			(await handler(vercel(await fixtureBytes('vercel-deployment-succeeded.json')))).status,
		).toBe(502);
	});

	test('подписанный не-JSON и подписанная чужая форма → 400', async () => {
		const { handler } = harness();
		expect((await handler(vercel(new TextEncoder().encode('{not json')))).status).toBe(400);
		expect((await handler(vercel(bytes({ type: 'deployment.error' })))).status).toBe(400);
	});
});

describe('аутентификация и размер тела: порядок проверок', () => {
	test('Grafana: без токена 401 раньше чтения тела — даже у огромного тела', async () => {
		const { handler } = harness();
		const req = grafana(' '.repeat(MAX_BODY_BYTES + 1), null);
		expect((await handler(req)).status).toBe(401);
		expect(req.bodyUsed).toBe(false);
	});

	test('Grafana: префикс ровно «Bearer » (7 символов другого вида не подходят)', async () => {
		const { handler, signals } = harness();
		expect(
			(await handler(grafana(await fixtureBytes('grafana-firing.json'), `Token: ${TOKEN}`))).status,
		).toBe(401);
		expect(signals).toHaveLength(0);
	});

	test('Vercel: подпись не того вида или её нет → 401 раньше чтения тела, без строки лога', async () => {
		const raw = await fixtureBytes('vercel-deployment-error.json');
		for (const signature of [null, 'abc', 'z'.repeat(40)]) {
			const { handler, signals, logs } = harness();
			const req = vercel(raw, signature);
			expect((await handler(req)).status).toBe(401);
			expect(req.bodyUsed).toBe(false);
			expect(signals).toHaveLength(0);
			expect(logs).toEqual([]);
		}
	});

	test('Vercel: подпись верного вида, но неверная — тело читается для HMAC, не-JSON всё равно 401, а не 400', async () => {
		const { handler, logs } = harness();
		const raw = new TextEncoder().encode('{not json');
		const req = vercel(raw, '0'.repeat(40));
		expect((await handler(req)).status).toBe(401);
		expect(req.bodyUsed).toBe(true);
		expect((await handler(vercel(raw, null))).status).toBe(401);
		expect(logs).toEqual([]);
	});

	test('413 после аутентификации (Grafana) пишет строку rejected; до неё (401, 413 Vercel) — нет', async () => {
		const oversize = { 'content-length': String(MAX_BODY_BYTES + 1) };
		const authed = harness();
		const res = await authed.handler(
			new Request(`${BASE}/hooks/grafana`, {
				method: 'POST',
				headers: { authorization: `Bearer ${TOKEN}`, ...oversize },
				body: '{}',
			}),
		);
		expect(res.status).toBe(413);
		expect(authed.logs).toEqual([
			{
				source: 'grafana',
				event: 'rejected',
				key: '-',
				action: 'error',
				workItemId: null,
				ms: 0,
				error: 'payload too large',
			},
		]);

		const anonymous = harness();
		const unauthorized = await anonymous.handler(
			new Request(`${BASE}/hooks/grafana`, { method: 'POST', headers: oversize, body: '{}' }),
		);
		expect(unauthorized.status).toBe(401);
		expect(anonymous.logs).toEqual([]);

		const unsigned = harness();
		const vercelOversize = await unsigned.handler(
			new Request(`${BASE}/hooks/vercel`, {
				method: 'POST',
				headers: { 'x-vercel-signature': '0'.repeat(40), ...oversize },
				body: '{}',
			}),
		);
		expect(vercelOversize.status).toBe(413);
		expect(unsigned.logs).toEqual([]);
	});

	test('заявленный content-length больше лимита → 413 без чтения тела', async () => {
		const { handler, signals } = harness();
		const req = new Request(`${BASE}/hooks/grafana`, {
			method: 'POST',
			headers: { authorization: `Bearer ${TOKEN}`, 'content-length': String(MAX_BODY_BYTES + 1) },
			body: '{}',
		});
		expect((await handler(req)).status).toBe(413);
		expect(req.bodyUsed).toBe(false);
		expect(signals).toHaveLength(0);
	});
});

describe('лог и ответы: поля строк', () => {
	test('Grafana resolved: событие alert.resolved, без поля error на успехе, ms неотрицательно', async () => {
		const { handler, logs } = harness({
			report: async () => ({ action: 'commented', workItemId: 'w9' }),
		});
		const res = await handler(grafana(await fixtureBytes('grafana-resolved.json')));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
		expect(logs.length).toBeGreaterThan(0);
		for (const l of logs) {
			expect(l.event).toBe('alert.resolved');
			expect(l).not.toHaveProperty('error');
			expect(l.ms).toBeGreaterThanOrEqual(0);
		}
	});

	test('Grafana: тело 502 называет число упавших и всего; в логе ошибки workItemId null', async () => {
		const { handler, logs } = harness({
			report: async (signal) => {
				if (signal.key === 'a1b2c3d4e5f60718') throw new PlaneApiError(500, 'POST', '/x/');
				return { action: 'created', workItemId: 'w2' };
			},
		});
		const res = await handler(grafana(await fixtureBytes('grafana-firing.json')));
		expect(await res.text()).toBe('plane: 1 of 2 alerts failed');
		expect(logs[0]?.workItemId).toBeNull();
		expect(logs[0]?.source).toBe('grafana');
	});

	test('ignored: полная строка лога', async () => {
		const { handler, logs } = harness();
		await handler(vercel(bytes({ type: 'deployment.created', payload: {} })));
		expect(logs).toEqual([
			{
				source: 'vercel',
				event: 'deployment.created',
				key: '-',
				action: 'ignored',
				workItemId: null,
				ms: 0,
			},
		]);
	});

	test('deployment.error: сбой Plane → 502, строка лога deployment.error', async () => {
		const { handler, logs } = harness({
			report: async () => {
				throw new PlaneApiError(500, 'POST', '/x/');
			},
		});
		const res = await handler(vercel(await fixtureBytes('vercel-deployment-error.json')));
		expect(res.status).toBe(502);
		expect(logs.map((l) => [l.source, l.event, l.action])).toEqual([
			['vercel', 'deployment.error', 'error'],
		]);
	});

	test('deployment.error: успех → строка лога с действием и workItemId', async () => {
		const { handler, logs } = harness();
		await handler(vercel(await fixtureBytes('vercel-deployment-error.json')));
		expect(logs.map((l) => [l.source, l.event, l.action, l.workItemId])).toEqual([
			['vercel', 'deployment.error', 'created', 'w1'],
		]);
	});

	test('deployment.succeeded: поля обеих строк лога', async () => {
		const { handler, logs } = harness({
			report: async () => ({ action: 'noop', workItemId: null }),
		});
		await handler(vercel(await fixtureBytes('vercel-deployment-succeeded.json')));
		expect(logs.map((l) => [l.source, l.event, l.workItemId])).toEqual([
			['vercel', 'deployment.succeeded', null],
			['vercel', 'deployment.succeeded', 'w12'],
		]);
		for (const l of logs) expect(l).not.toHaveProperty('error');
	});

	test('сбой заметок: строка лога note:<deploymentId> с error', async () => {
		const { handler, logs } = harness({
			report: async () => ({ action: 'noop', workItemId: null }),
			notes: async () => {
				throw new PlaneApiError(500, 'POST', '/comments/');
			},
		});
		await handler(vercel(await fixtureBytes('vercel-deployment-succeeded.json')));
		expect(logs[1]).toMatchObject({
			source: 'vercel',
			event: 'deployment.succeeded',
			key: 'note:dpl_ok1',
			action: 'error',
			workItemId: null,
			error: 'PlaneApiError: Plane POST /comments/ → 500',
		});
		expect(logs.filter((l) => l.annotation !== undefined)).toHaveLength(1);
		expect(logs[1]?.annotation).toBeUndefined();
	});

	test('сбой, не являющийся Error → «unknown error»', async () => {
		const { handler, logs } = harness({
			report: async () => {
				throw 'boom';
			},
		});
		await handler(grafana(await fixtureBytes('grafana-firing.json')));
		expect(logs[0]?.error).toBe('unknown error');
	});

	test('ошибка не от Plane (у проекта нет состояния по умолчанию) → 502 и строка лога с ней', async () => {
		const { handler, logs } = harness({
			report: async () => {
				throw new Error('Plane project p-ops has no default state');
			},
		});
		const res = await handler(vercel(await fixtureBytes('vercel-deployment-error.json')));
		expect(res.status).toBe(502);
		expect(logs).toEqual([
			{
				source: 'vercel',
				event: 'deployment.error',
				key: 'deploy:prj_terminal:production:feat/ops-12-plane-hooks',
				action: 'error',
				workItemId: null,
				ms: expect.any(Number),
				annotation: 'deploy',
				title: '✗ terminal → production упал · 0123456',
				env: 'production',
				sha: SHA,
				error: 'Error: Plane project p-ops has no default state',
			},
		]);
	});

	test('заметки о деплое: ms у каждого ключа свой, а не общий с начала цикла', async () => {
		const { handler, logs } = harness({
			report: async () => ({ action: 'noop', workItemId: null }),
			notes: async () => [
				{ key: 'OPS-12', action: 'commented', workItemId: 'w12', ms: 7 },
				{ key: 'MONO-3', action: 'skipped', workItemId: null, ms: 11 },
			],
		});
		await handler(vercel(await fixtureBytes('vercel-deployment-succeeded.json')));
		expect(logs.slice(1).map((l) => [l.key, l.action, l.workItemId, l.ms])).toEqual([
			['OPS-12', 'commented', 'w12', 7],
			['MONO-3', 'skipped', null, 11],
		]);
	});
});

describe('аутентифицированное, но неразборное тело: 400 и строка лога rejected', () => {
	test('Vercel: подписанный не-JSON', async () => {
		const { handler, logs } = harness();
		const res = await handler(vercel(new TextEncoder().encode('{not json')));
		expect(res.status).toBe(400);
		expect(await res.text()).toBe('invalid json');
		expect(logs).toEqual([
			{
				source: 'vercel',
				event: 'rejected',
				key: '-',
				action: 'error',
				workItemId: null,
				ms: 0,
				error: 'invalid json',
			},
		]);
	});

	test('Grafana: верный токен, чужая форма', async () => {
		const { handler, logs } = harness();
		const res = await handler(grafana('{}'));
		expect(res.status).toBe(400);
		expect(await res.text()).toBe('grafana: body has no alerts[]');
		expect(logs).toEqual([
			{
				source: 'grafana',
				event: 'rejected',
				key: '-',
				action: 'error',
				workItemId: null,
				ms: 0,
				error: 'BadPayload: grafana: body has no alerts[]',
			},
		]);
	});
});

describe('ms в логе', () => {
	test('ms измеряет длительность вызова Plane (нижняя граница, без привязки к верхней)', async () => {
		const { handler, logs } = harness({
			report: async () => {
				await Bun.sleep(20);
				return { action: 'created', workItemId: 'w1' };
			},
		});
		await handler(grafana(await fixtureBytes('grafana-firing.json')));
		expect(logs[0]?.ms).toBeGreaterThanOrEqual(15);
	});
});

describe('поля отметки в логе', () => {
	test('новое срабатывание алерта — отметка «инцидент» с заголовком задачи и env', async () => {
		const { handler, logs, signals } = harness();
		expect((await handler(grafana(await fixtureBytes('grafana-firing.json')))).status).toBe(200);
		expect(logs[0]).toMatchObject({
			annotation: 'incident',
			title: 'Сработал: [prod] ServiceDown: order-gateway is down',
			env: 'production',
		});
		const second = signals[1] as { title: string };
		expect(logs[1]).toMatchObject({
			annotation: 'incident',
			title: `Сработал: ${second.title}`,
			env: 'staging',
		});
	});

	test('алерт без метки env: отметка в словаре деплоев (production), заголовок остаётся [prod]', async () => {
		const body = JSON.stringify({
			alerts: [
				{
					status: 'firing',
					fingerprint: 'fp-no-env',
					startsAt: '2026-10-06T10:00:00Z',
					labels: { alertname: 'NoEnv', severity: 'critical' },
					annotations: {},
				},
			],
		});
		const { handler, logs } = harness();
		expect((await handler(grafana(body))).status).toBe(200);
		expect(logs[0]).toMatchObject({
			annotation: 'incident',
			title: 'Сработал: [prod] NoEnv',
			env: 'production',
		});
	});

	test.each(['created', 'reopened', 'commented'] as const)(
		'срабатывание с действием %s — отметка есть',
		async (action) => {
			const { handler, logs } = harness({ report: async () => ({ action, workItemId: 'w1' }) });
			await handler(grafana(await fixtureBytes('grafana-firing.json')));
			expect(logs.every((l) => l.annotation === 'incident')).toBe(true);
		},
	);

	test('повтор (noop) и ошибка Plane у алерта — без отметки', async () => {
		const noop = harness({ report: async () => ({ action: 'noop', workItemId: 'w1' }) });
		await noop.handler(grafana(await fixtureBytes('grafana-firing.json')));
		expect(noop.logs.some((l) => 'annotation' in l && l.annotation !== undefined)).toBe(false);
		const failing = harness({
			report: async () => {
				throw new PlaneApiError(500, 'POST', '/x/');
			},
		});
		await failing.handler(grafana(await fixtureBytes('grafana-firing.json')));
		expect(failing.logs.some((l) => l.annotation !== undefined)).toBe(false);
	});

	test('восстановление: commented — «Погас», noop — без отметки', async () => {
		const commented = harness({ report: async () => ({ action: 'commented', workItemId: 'w1' }) });
		await commented.handler(grafana(await fixtureBytes('grafana-resolved.json')));
		expect(commented.logs[0]).toMatchObject({
			annotation: 'incident',
			title: 'Погас: [prod] ServiceDown: order-gateway is down',
			env: 'production',
		});
		const noop = harness({ report: async () => ({ action: 'noop', workItemId: 'w1' }) });
		await noop.handler(grafana(await fixtureBytes('grafana-resolved.json')));
		expect(noop.logs[0]?.annotation).toBeUndefined();
	});

	test.each([
		['created', 200],
		['noop', 200],
	] as const)(
		'упавший деплой Vercel (%s) — отметка «деплой» на строке события',
		async (action, status) => {
			const { handler, logs } = harness({ report: async () => ({ action, workItemId: 'w1' }) });
			expect(
				(await handler(vercel(await fixtureBytes('vercel-deployment-error.json')))).status,
			).toBe(status);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				event: 'deployment.error',
				annotation: 'deploy',
				title: '✗ terminal → production упал · 0123456',
				env: 'production',
				sha: SHA,
			});
		},
	);

	test('упавший деплой Vercel при ошибке Plane — отметка всё равно есть, ответ 502', async () => {
		const { handler, logs } = harness({
			report: async () => {
				throw new PlaneApiError(503, 'POST', '/x/');
			},
		});
		expect((await handler(vercel(await fixtureBytes('vercel-deployment-error.json')))).status).toBe(
			502,
		);
		expect(logs[0]).toMatchObject({ action: 'error', annotation: 'deploy' });
	});

	test('успешный деплой Vercel — ровно одна строка с отметкой, у строк заметок её нет', async () => {
		const { handler, logs } = harness({
			report: async () => ({ action: 'noop', workItemId: null }),
			notes: async () => [
				{ key: 'OPS-12', action: 'commented', workItemId: 'w12', ms: 3 },
				{ key: 'MONO-3', action: 'skipped', workItemId: null, ms: 1 },
			],
		});
		expect(
			(await handler(vercel(await fixtureBytes('vercel-deployment-succeeded.json')))).status,
		).toBe(200);
		const marked = logs.filter((l) => l.annotation !== undefined);
		expect(marked).toHaveLength(1);
		expect(marked[0]).toMatchObject({
			event: 'deployment.succeeded',
			annotation: 'deploy',
			title: 'terminal → production · 0123456',
			env: 'production',
			sha: SHA,
		});
		expect(logs).toHaveLength(3);
	});
});
