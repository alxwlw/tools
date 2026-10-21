import { describe, expect, test } from 'bun:test';

import { PlaneApiError } from '../src/plane.ts';
import { MAX_BODY_BYTES } from '../src/server.ts';
import { fixture, fixtureBytes } from './fixtures.ts';
import { BASE, bytes, DEPLOY_SHA, deployRequest, harness } from './server-harness.ts';

describe('/hooks/deploy', () => {
	test.each([null, 'short', 'z'.repeat(64)])(
		'подпись %p не той формы → 401 до чтения тела, без строки лога',
		async (signature) => {
			const { handler, logs, signals } = harness();
			const req = deployRequest(await fixtureBytes('deploy-failure.json'), signature);
			expect((await handler(req)).status).toBe(401);
			expect(req.bodyUsed).toBe(false);
			expect(logs).toEqual([]);
			expect(signals).toHaveLength(0);
		},
	);

	test('подпись правильной формы, но чужая → 401 после чтения тела, без строки лога', async () => {
		const { handler, logs } = harness();
		const req = deployRequest(await fixtureBytes('deploy-failure.json'), '0'.repeat(64));
		expect((await handler(req)).status).toBe(401);
		expect(req.bodyUsed).toBe(true);
		expect(logs).toEqual([]);
	});

	test('чужая подпись при плохом теле → 401 без строки лога: подпись проверяется до разбора', async () => {
		const bodies = [
			new TextEncoder().encode('{not json'),
			bytes({ ...(await fixture('deploy-failure.json')), environment: 'preview' }),
		];
		for (const raw of bodies) {
			const { handler, logs } = harness();
			expect((await handler(deployRequest(raw, '0'.repeat(64)))).status).toBe(401);
			expect(logs).toEqual([]);
		}
	});

	test('тело больше 1 MiB → 413 без строки лога (до аутентификации)', async () => {
		const { handler, logs } = harness();
		const raw = await fixtureBytes('deploy-failure.json');
		const res = await handler(
			deployRequest(raw, '0'.repeat(64), { 'content-length': String(MAX_BODY_BYTES + 1) }),
		);
		expect(res.status).toBe(413);
		expect(logs).toEqual([]);
	});

	test('не JSON → 400 и строка rejected с источником github', async () => {
		const { handler, logs } = harness();
		const raw = new TextEncoder().encode('{not json');
		expect((await handler(deployRequest(raw))).status).toBe(400);
		expect(logs).toEqual([
			{
				source: 'github',
				event: 'rejected',
				key: '-',
				action: 'error',
				workItemId: null,
				ms: 0,
				error: 'invalid json',
			},
		]);
	});

	test('неверная форма события → 400 и rejected с текстом ошибки разбора', async () => {
		const { handler, logs } = harness();
		const raw = bytes({ ...(await fixture('deploy-failure.json')), environment: 'preview' });
		const res = await handler(deployRequest(raw));
		expect(res.status).toBe(400);
		expect(await res.text()).toBe('deploy: environment must be staging or production');
		expect(logs[0]).toMatchObject({
			source: 'github',
			event: 'rejected',
			error: 'BadPayload: deploy: environment must be staging or production',
		});
	});

	test('провал → сигнал срабатывания, 200, отметка «деплой» на строке события', async () => {
		const { handler, logs, signals } = harness();
		expect((await handler(deployRequest(await fixtureBytes('deploy-failure.json')))).status).toBe(
			200,
		);
		expect(signals).toHaveLength(1);
		expect(signals[0]).toMatchObject({
			status: 'firing',
			source: 'github',
			key: 'deploy:monorepo:staging',
		});
		expect(logs).toEqual([
			{
				source: 'github',
				event: 'deployment.error',
				key: 'deploy:monorepo:staging',
				action: 'created',
				workItemId: 'w1',
				ms: expect.any(Number),
				annotation: 'deploy',
				title: '✗ monorepo → staging упал · 89abcde · bootstrap-smoke',
				env: 'staging',
				sha: DEPLOY_SHA,
			},
		]);
	});

	test('успех → восстановление и заметки, строки заметок с источником github, отметка одна', async () => {
		const { handler, logs, signals, notes } = harness({
			report: async () => ({ action: 'noop', workItemId: null }),
		});
		expect((await handler(deployRequest(await fixtureBytes('deploy-success.json')))).status).toBe(
			200,
		);
		expect(signals[0]).toMatchObject({ status: 'resolved', key: 'deploy:monorepo:production' });
		expect(notes[0]).toMatchObject({
			deploymentId: `gh:production:${DEPLOY_SHA}`,
			source: 'github',
			keyLimit: 50,
		});
		expect(logs.filter((l) => l.annotation === 'deploy')).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			source: 'github',
			event: 'deployment.succeeded',
			annotation: 'deploy',
		});
		expect(logs[1]).toMatchObject({
			source: 'github',
			event: 'deployment.succeeded',
			key: 'OPS-12',
			action: 'commented',
		});
	});

	test('успех без коммитов (повторный деплой того же sha) → 200 и отметка есть', async () => {
		const { handler, logs, notes } = harness({ notes: async () => [] });
		const raw = bytes({ ...(await fixture('deploy-success.json')), commits: [] });
		expect((await handler(deployRequest(raw))).status).toBe(200);
		expect(notes[0]?.texts).toEqual([]);
		expect(logs).toHaveLength(2);
		expect(logs[1]).toMatchObject({ event: 'release', action: 'created' });
		expect(logs[0]).toMatchObject({
			annotation: 'deploy',
			title: 'monorepo → production · 89abcde',
		});
	});

	test('ошибка Plane → 502', async () => {
		const { handler } = harness({
			report: async () => {
				throw new PlaneApiError(503, 'POST', '/x/');
			},
		});
		expect((await handler(deployRequest(await fixtureBytes('deploy-failure.json')))).status).toBe(
			502,
		);
	});

	test('прод-успех → релиз после заметок, с id задач из заметок; строка release в логе', async () => {
		const { handler, logs, releases, order } = harness({
			notes: async () => [
				{ key: 'OPS-12', action: 'commented', workItemId: 'w12', ms: 1 },
				{ key: 'MONO-3', action: 'skipped', workItemId: null, ms: 1 },
				{ key: 'OPS-13', action: 'noop', workItemId: 'w13', ms: 1 },
			],
		});
		expect((await handler(deployRequest(await fixtureBytes('deploy-success.json')))).status).toBe(
			200,
		);
		expect(order).toEqual(['notes', 'release']);
		expect(releases).toHaveLength(1);
		expect(releases[0]?.draft).toMatchObject({ repository: 'liqu-fi/monorepo', sha: DEPLOY_SHA });
		expect(releases[0]?.items).toEqual([
			{ key: 'OPS-12', workItemId: 'w12' },
			{ key: 'OPS-13', workItemId: 'w13' },
		]);
		expect(logs.at(-1)).toEqual({
			source: 'github',
			event: 'release',
			key: `release:liqu-fi/monorepo@${DEPLOY_SHA}`,
			action: 'created',
			workItemId: null,
			ms: expect.any(Number),
			releaseId: 'r1',
		});
	});

	test('staging-успех → релиза нет', async () => {
		const { handler, releases } = harness();
		const raw = bytes({ ...(await fixture('deploy-success.json')), environment: 'staging' });
		expect((await handler(deployRequest(raw))).status).toBe(200);
		expect(releases).toEqual([]);
	});

	test('сбой релиза (403) → 200, «Выкачено» на месте, строка release с level warn', async () => {
		const { handler, logs } = harness({
			releases: async () => {
				throw new PlaneApiError(403, 'POST', '/releases/');
			},
		});
		expect((await handler(deployRequest(await fixtureBytes('deploy-success.json')))).status).toBe(
			200,
		);
		expect(logs.some((l) => l.key === 'OPS-12' && l.action === 'commented')).toBe(true);
		expect(logs.at(-1)).toEqual({
			source: 'github',
			event: 'release',
			key: `release:liqu-fi/monorepo@${DEPLOY_SHA}`,
			action: 'error',
			workItemId: null,
			ms: expect.any(Number),
			level: 'warn',
			error: 'PlaneApiError: Plane POST /releases/ → 403',
		});
	});

	test('сбой заметок → 502, релиз не трогается', async () => {
		const { handler, releases } = harness({
			notes: async () => {
				throw new PlaneApiError(503, 'POST', '/x/');
			},
		});
		expect((await handler(deployRequest(await fixtureBytes('deploy-success.json')))).status).toBe(
			502,
		);
		expect(releases).toEqual([]);
	});

	test('GET /hooks/deploy → 405', async () => {
		const { handler } = harness();
		expect((await handler(new Request(`${BASE}/hooks/deploy`))).status).toBe(405);
	});
});
