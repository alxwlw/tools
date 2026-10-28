import { describe, expect, test } from 'bun:test';

import type { Tenant } from '../src/config.ts';
import { PlaneApiError } from '../src/plane.ts';
import { fixture } from './fixtures.ts';
import {
	DOKPLOY_SECRET,
	dokployRequest,
	T0,
	tenantOf,
	VERCEL_SECRET,
	vercelRequest,
	world,
} from './server-harness.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const BRANCH = 'feat/ops-12-plane-hooks';
const incidents = (w: ReturnType<typeof world>) =>
	w.plane.workItems.filter((item) => item.project === 'p-inc');

async function vercelBody(name: string, mutate: (body: any) => void = () => undefined) {
	const body = await fixture(name);
	mutate(body);
	return body;
}

const preview = () =>
	vercelBody('vercel-deployment-succeeded.json', (b) => {
		b.payload.target = null;
		b.payload.deployment.meta.githubCommitOrg = 'acme';
		b.payload.deployment.meta.githubCommitRepo = 'api';
	});

describe('Vercel', () => {
	test('Vercel: превью — комментарий превью; ошибка — инцидент', async () => {
		const w = world();
		const id = w.plane.addWorkItem('OPS-12', 'In Progress');
		const res = await w.send(vercelRequest('acme', await preview()));
		expect([res.status, await res.text()]).toEqual([200, 'ok']);
		expect(w.plane.commentsOf(id).map((c) => [c.external_id, c.external_source])).toEqual([
			[`preview:${id}:terminal`, 'plane-hooks'],
		]);
		expect(w.lines('delivery.noted')).toEqual([
			{
				event: 'delivery.noted',
				tenant: 'acme',
				key: 'OPS-12',
				kind: 'preview',
				created: true,
				action: 'created',
			},
		]);
		// The preview is no deploy: no deploy mark.
		expect(w.logs.some((l) => l.annotation !== undefined)).toBe(false);
		// The same link again changes nothing: the line says so.
		await w.send(vercelRequest('acme', await preview()));
		expect(w.lines('delivery.noted').at(-1)).toMatchObject({ created: false, action: 'noop' });

		const failed = await w.send(
			vercelRequest('acme', await vercelBody('vercel-deployment-error.json')),
		);
		expect(failed.status).toBe(200);
		expect(incidents(w).map((i) => [i.external_id, i.external_source, i.priority])).toEqual([
			[`deploy:prj_terminal:production:${BRANCH}`, 'vercel', 'high'],
		]);
		expect(w.lines('deployment.error')).toEqual([
			{
				event: 'deployment.error',
				tenant: 'acme',
				source: 'vercel',
				key: `deploy:prj_terminal:production:${BRANCH}`,
				action: 'created',
				workItemId: incidents(w)[0]?.id ?? '',
				ms: expect.any(Number),
				annotation: 'deploy',
				title: '✗ terminal → production упал · 0123456',
				env: 'production',
				sha: SHA,
			},
		]);
		expect(w.runtime().lastDelivery.get('vercel')).toBe(T0);
	});

	test('Vercel: сбой Plane на ошибке — 502, отметка деплоя всё равно в строке', async () => {
		const w = world();
		w.plane.failNext('createWorkItem', new PlaneApiError(503, 'POST', '/work-items/'));
		const res = await w.send(
			vercelRequest('acme', await vercelBody('vercel-deployment-error.json')),
		);
		expect(res.status).toBe(502);
		expect(w.lines('deployment.error')[0]).toMatchObject({
			level: 'error',
			action: 'error',
			annotation: 'deploy',
			error: 'PlaneApiError: Plane POST /work-items/ → 503',
		});
	});

	test('Vercel: прод успешен — только Погас и одна отметка деплоя; превью на сбое Plane — 502 и без задачи', async () => {
		const w = world();
		const res = await w.send(
			vercelRequest('acme', await vercelBody('vercel-deployment-succeeded.json')),
		);
		expect(res.status).toBe(200);
		expect(w.logs.filter((l) => l.annotation !== undefined)).toEqual([
			{
				event: 'deployment.succeeded',
				tenant: 'acme',
				source: 'vercel',
				key: `deploy:prj_terminal:production:${BRANCH}`,
				action: 'noop',
				workItemId: null,
				ms: expect.any(Number),
				annotation: 'deploy',
				title: 'terminal → production · 0123456',
				env: 'production',
				sha: SHA,
			},
		]);
		expect(w.store.inboxPending()).toEqual([]);

		const down = world();
		const item = down.plane.addWorkItem('OPS-12', 'In Progress');
		down.plane.failNext('findWorkItemByExternalId', new PlaneApiError(500, 'GET', '/work-items/'));
		expect((await down.send(vercelRequest('acme', await preview()))).status).toBe(502);
		// Vercel resends the whole delivery: nothing of it may have been queued yet.
		expect(down.lines('delivery.noted')).toEqual([]);
		expect(down.plane.commentsOf(item)).toEqual([]);
		expect(down.store.inboxPending()).toEqual([]);
	});

	test('Vercel: подпись не того вида — 401 до тела; верного вида, но чужая — 401 после; подписанный не-JSON — 400', async () => {
		const w = world();
		const body = await vercelBody('vercel-deployment-error.json');
		for (const signature of [null, 'abc', 'z'.repeat(40)]) {
			const req = vercelRequest('acme', body, signature);
			expect((await w.handler(req)).status).toBe(401);
			expect(req.bodyUsed).toBe(false);
		}
		const forged = vercelRequest('acme', '{not json', '0'.repeat(40));
		expect((await w.handler(forged)).status).toBe(401);
		expect(forged.bodyUsed).toBe(true);
		expect(w.logs).toEqual([]);
		expect(w.runtime().lastDelivery.has('vercel')).toBe(false);
		const signed = await w.handler(vercelRequest('acme', '{not json'));
		expect([signed.status, await signed.text()]).toEqual([400, 'invalid json']);
		expect(w.lines('delivery.rejected').map((l) => [l.input, l.error])).toEqual([
			['vercel', 'invalid json'],
		]);
		const ignored = await w.handler(
			vercelRequest('acme', { type: 'project.created', payload: {} }),
		);
		expect([ignored.status, await ignored.text()]).toEqual([200, 'ignored']);
		expect(w.lines('vercel.ignored')).toEqual([
			{ event: 'vercel.ignored', tenant: 'acme', type: 'project.created' },
		]);
		expect(incidents(w)).toEqual([]);
	});

	describe('promote и откат', () => {
		/** acme/api deploys to Vercel's `Production` environment, which moves ENG work to Done. */
		const productionTenant = (): Tenant => {
			const base = tenantOf();
			return {
				...base,
				delivery: {
					...(base.delivery as NonNullable<Tenant['delivery']>),
					repos: [
						{
							repo: 'acme/api',
							environments: [{ name: 'Production', state: 'Done', release: false }],
						},
					],
				},
			};
		};
		const promoted = (over: Record<string, unknown> = {}) => ({
			id: 'evt_promoted_1',
			type: 'deployment.promoted',
			createdAt: 1_791_282_000_000,
			payload: {
				project: { id: 'prj_terminal' },
				deployment: {
					id: 'dpl_prom1',
					url: 'terminal-prom-example.vercel.app',
					name: 'terminal',
					meta: { githubCommitOrg: 'acme', githubCommitRepo: 'api', githubCommitSha: 'v1' },
				},
				...over,
			},
		});

		test('promote — handleDeploy через очередь: Выкачено, переход, отметка с source vercel', async () => {
			const w = world({ tenants: [productionTenant()] });
			w.gh.commit('v0', [], 'init');
			w.gh.commit('v1', ['v0'], 'ENG-3 ship (#3)');
			w.gh
				.pull({ repo: 'acme/api', number: 3, title: 'ENG-3 ship' })
				.mergePull('acme/api', 3, 'v1');
			w.gh.deploy('acme/api', 'Production', 'v0', 'success', 'vercel[bot]');
			w.gh.deploy('acme/api', 'Production', 'v1', 'success', 'vercel[bot]');
			const id = w.plane.addWorkItem('ENG-3', 'In Review');
			const res = await w.send(vercelRequest('acme', promoted()));
			expect([res.status, await res.text()]).toEqual([200, 'ok']);
			expect(w.plane.workItems.find((item) => item.id === id)?.state).toBe('eng-done');
			expect(w.lines('deploy')).toEqual([
				{
					event: 'deploy',
					tenant: 'acme',
					source: 'vercel',
					repo: 'acme/api',
					action: 'delivered',
					env: 'Production',
					sha: 'v1',
					annotation: 'deploy',
					title: 'acme/api → Production · v1',
				},
			]);
			// The deploy is ordered by the promote event's own time.
			expect(w.store.deployCursor('acme', 'acme/api', 'Production')).toEqual({
				sha: 'v1',
				at: '2026-10-06T10:20:00.000Z',
			});
		});

		test('откат без sha — 200 без задачи и одна строка без тела; GitHub не отвечает — 502', async () => {
			const w = world({ tenants: [productionTenant()] });
			const rollback = {
				id: 'evt_rollback_1',
				type: 'deployment.rollback',
				createdAt: 1_791_283_000_000,
				payload: {
					project: { id: 'prj_terminal' },
					fromDeploymentId: 'dpl_new',
					toDeploymentId: 'dpl_old',
				},
			};
			const res = await w.send(vercelRequest('acme', rollback));
			expect([res.status, await res.text()]).toEqual([200, 'ignored']);
			expect(w.store.inboxPending()).toEqual([]);
			expect(w.lines('deploy')).toEqual([]);
			expect(w.lines('vercel.switch')).toEqual([
				{
					event: 'vercel.switch',
					level: 'warn',
					tenant: 'acme',
					kind: 'rolled_back',
					project: 'prj_terminal',
					action: 'no_deploy',
				},
			]);
			expect(w.gh.calls).toEqual([]);

			const broken = world({ tenants: [productionTenant()] });
			broken.gh.listDeployments = () => Promise.reject(new TypeError('fetch failed'));
			expect((await broken.send(vercelRequest('acme', promoted()))).status).toBe(502);
			expect(broken.lines('vercel.switch')).toEqual([
				{
					event: 'vercel.switch',
					level: 'error',
					tenant: 'acme',
					kind: 'promoted',
					error: 'TypeError: fetch failed',
				},
			]);
			expect(broken.store.inboxPending()).toEqual([]);
		});

		test('promote без записи vercel[bot] этого sha — 200 ignored, без задачи', async () => {
			const w = world({ tenants: [productionTenant()] });
			w.gh.deploy('acme/api', 'Production', 'v1', 'success', 'github-actions[bot]');
			const res = await w.send(vercelRequest('acme', promoted()));
			expect([res.status, await res.text()]).toEqual([200, 'ignored']);
			expect(w.store.inboxPending()).toEqual([]);
			expect(w.lines('vercel.switch').map((l) => [l.kind, l.action])).toEqual([
				['promoted', 'no_deploy'],
			]);
		});
	});
});

// по исходникам Dokploy v0.30.10 (packages/server/src/utils/notifications/*): плоское тело, все значения — строки
const build = (status: 'success' | 'error', patch: Record<string, string> = {}) => ({
	title: status === 'success' ? 'Build Success' : 'Build Error',
	message: `Build ${status} for application: api`,
	projectName: 'shop',
	applicationName: 'api',
	applicationType: 'application',
	buildLink:
		'https://dokploy.example.com/dashboard/project/p1/services/application/a1?tab=deployments',
	timestamp: status === 'success' ? '2026-10-29T10:10:00.000Z' : '2026-10-29T10:05:00.000Z',
	status,
	type: 'build',
	...(status === 'error' ? { errorMessage: 'npm ERR! missing script' } : {}),
	...patch,
});
const backup = (outcome: 'success' | 'error', timestamp: string) => ({
	title: outcome === 'success' ? 'Database Backup Successful' : 'Database Backup Failed',
	message: 'Database backup',
	projectName: 'shop',
	applicationName: 'pg',
	databaseType: 'postgres',
	databaseName: 'orders',
	type: outcome,
	errorMessage: outcome === 'error' ? 'pg_dump: connection refused' : '',
	timestamp,
	status: outcome,
});

describe('Dokploy', () => {
	test('Dokploy: деплой сопоставленного приложения — Deployment в GitHub', async () => {
		const w = world();
		w.gh.branch('acme/api', 'main', SHA);
		const res = await w.send(dokployRequest('acme', build('success')));
		expect([res.status, await res.text()]).toEqual([200, 'ok']);
		expect(w.gh.calls.filter((call) => call.startsWith('create'))).toEqual([
			`createDeployment acme/api production ${SHA}`,
			'createDeploymentStatus acme/api 1 success https://dokploy.example.com/dashboard/project/p1/services/application/a1?tab=deployments',
		]);
		expect(w.lines('dokploy.recorded')).toEqual([
			{
				event: 'dokploy.recorded',
				tenant: 'acme',
				app: 'api',
				action: 'recorded',
				deploymentId: 1,
			},
		]);
		expect(w.runtime().lastDelivery.get('dokploy')).toBe(T0);
	});

	test('Dokploy: неверный Bearer — 401 до тела; несопоставленное — без записи, публичный — warn', async () => {
		const w = world();
		for (const auth of [null, 'Bearer wrong', DOKPLOY_SECRET, `Basic ${DOKPLOY_SECRET}`]) {
			const req = dokployRequest('acme', build('success'), auth);
			expect((await w.handler(req)).status).toBe(401);
			expect(req.bodyUsed).toBe(false);
		}
		expect(w.logs).toEqual([]);
		await w.send(dokployRequest('acme', build('success', { applicationName: 'web' })));
		expect(w.lines('dokploy.recorded')).toEqual([
			{
				event: 'dokploy.recorded',
				tenant: 'acme',
				app: 'web',
				action: 'unmapped',
				deploymentId: undefined,
			},
		]);
		w.gh.visibility('acme/api', 'public');
		await w.send(dokployRequest('acme', build('success')));
		expect(w.lines('dokploy.recorded').at(-1)).toEqual({
			event: 'dokploy.recorded',
			tenant: 'acme',
			app: 'api',
			action: 'public_repo',
			deploymentId: undefined,
			level: 'warn',
		});
		expect(w.gh.calls.some((call) => call.startsWith('createDeployment'))).toBe(false);
	});

	test('Dokploy: ошибка сборки — инцидент синхронно, деплой потом гасит его; сбой Plane — 502', async () => {
		const w = world();
		w.gh.branch('acme/api', 'main', SHA);
		expect((await w.send(dokployRequest('acme', build('error')))).status).toBe(200);
		const [incident] = incidents(w);
		expect([incident?.external_id, incident?.external_source]).toEqual([
			'dokploy:api:build',
			'dokploy',
		]);
		expect((await w.send(dokployRequest('acme', build('success')))).status).toBe(200);
		expect(w.plane.commentsOf(incident?.id ?? '').map((c) => c.external_id)).toEqual([
			'dokploy:api:build:2026-10-29T10:05:00.000Z:firing',
			'dokploy:api:build:2026-10-29T10:05:00.000Z:resolved',
		]);
		expect(w.lines('dokploy.deployed').map((l) => l.action)).toEqual(['commented']);

		const down = world();
		down.plane.failNext('createWorkItem', new PlaneApiError(500, 'POST', '/work-items/'));
		expect((await down.send(dokployRequest('acme', build('error')))).status).toBe(502);
		const blocked = world();
		blocked.plane.failNext(
			'findWorkItemByExternalId',
			new PlaneApiError(500, 'GET', '/work-items/'),
		);
		expect((await blocked.send(dokployRequest('acme', build('success')))).status).toBe(502);
		expect(blocked.store.inboxPending()).toEqual([]);
		expect(blocked.gh.calls).toEqual([]);
	});

	test('Dokploy: удачный бэкап после упавшего — Погас того же …:backup; другое событие — ignored', async () => {
		const w = world();
		expect(
			(await w.send(dokployRequest('acme', backup('error', '2026-10-29T03:00:00.000Z')))).status,
		).toBe(200);
		const [incident] = incidents(w);
		expect(incident?.external_id).toBe('dokploy:pg/orders:backup');
		const ok = await w.send(dokployRequest('acme', backup('success', '2026-10-30T03:00:00.000Z')));
		expect([ok.status, await ok.text()]).toEqual([200, 'ok']);
		expect(w.lines('dokploy.resolved').map((l) => [l.key, l.action])).toEqual([
			['dokploy:pg/orders:backup', 'commented'],
		]);
		expect(w.store.inboxPending()).toEqual([]);
		const restart = {
			title: 'Dokploy Server Restarted',
			timestamp: '2026-10-29T04:10:00.000Z',
			status: 'success',
			type: 'dokploy-restart',
		};
		const ignored = await w.send(dokployRequest('acme', restart));
		expect([ignored.status, await ignored.text()]).toEqual([200, 'ignored']);
		expect(w.lines('dokploy.ignored')).toEqual([
			{ event: 'dokploy.ignored', tenant: 'acme', type: 'dokploy-restart' },
		]);
		// The Vercel secret is no Dokploy secret.
		expect(
			(await w.handler(dokployRequest('acme', restart, `Bearer ${VERCEL_SECRET}`))).status,
		).toBe(401);
	});
});
