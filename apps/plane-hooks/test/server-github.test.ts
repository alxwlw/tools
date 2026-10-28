import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { PlaneApiError } from '../src/plane.ts';
import { Store } from '../src/store.ts';
import { FakePlane } from './fake-plane.ts';
import {
	githubRequest,
	pullPayload,
	statusPayload,
	T0,
	tenantOf,
	world,
} from './server-harness.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function dbFile(): string {
	const dir = mkdtempSync(join(tmpdir(), 'plane-hooks-server-'));
	dirs.push(dir);
	return join(dir, 'hooks.sqlite');
}

const READY = () => pullPayload('ready_for_review');

/** ENG-7 (the key of the PR's branch `eng-7-retry`) in In Progress; returns its id. */
const seed = (w: ReturnType<typeof world>) => w.plane.addWorkItem('ENG-7', 'In Progress');
const stateOf = (w: ReturnType<typeof world>, id: string) =>
	w.plane.workItems.find((item) => item.id === id)?.state;
const transitions = (w: ReturnType<typeof world>, id: string) =>
	w.plane.commentsOf(id).filter((c) => c.external_id.startsWith('state:'));

describe('GitHub: доставка PR', () => {
	test('GitHub: неверная подпись — 401; верная — 202, PR в ready ставит In Review', async () => {
		const w = world();
		const id = seed(w);
		const forged = githubRequest('pull_request', READY(), undefined, {
			'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
		});
		expect((await w.send(forged)).status).toBe(401);
		expect(w.logs).toEqual([]);
		expect(w.store.inboxPending()).toEqual([]);
		expect(w.runtime().lastDelivery.has('github')).toBe(false);

		const res = await w.handler(githubRequest('pull_request', READY()));
		expect(res.status).toBe(202);
		expect(await res.text()).toBe('accepted');
		expect(w.runtime().lastDelivery.get('github')).toBe(T0);
		await w.idle();
		expect(stateOf(w, id)).toBe('eng-in-review');
		expect(w.plane.links.map((l) => [l.workItemId, l.url])).toEqual([
			[id, 'https://github.com/acme/api/pull/12'],
		]);
		expect(w.lines('delivery.synced')).toEqual([
			{
				event: 'delivery.synced',
				tenant: 'acme',
				key: 'ENG-7',
				action: 'moved',
				from: 'In Progress',
				to: 'In Review',
				reason: undefined,
			},
		]);
		expect(w.lines('github.pull_request')).toEqual([
			{
				event: 'github.pull_request',
				tenant: 'acme',
				repo: 'acme/api',
				number: 12,
				action: 'ready_for_review',
				linked: 1,
			},
		]);
		expect(w.store.inboxFailedList()).toEqual([]);
		expect(w.store.inboxPending()).toEqual([]);
	});

	test('переход задачи — строка журнала', async () => {
		const w = world();
		seed(w);
		await w.send(githubRequest('pull_request', READY()));
		expect(w.store.journalSince('2026-10-01T00:00:00Z')).toEqual([
			{
				tenant: 'acme',
				key: 'ENG-7',
				from: 'In Progress',
				to: 'In Review',
				cause: 'pr:acme/api#12',
				at: new Date(T0).toISOString(),
			},
		]);
	});

	test('две доставки одного PR подряд — один комментарий перехода', async () => {
		const w = world();
		const id = seed(w);
		// Both accepted before either job runs: the tenant queue serialises them.
		expect((await w.handler(githubRequest('pull_request', pullPayload('opened')))).status).toBe(
			202,
		);
		expect((await w.handler(githubRequest('pull_request', READY()))).status).toBe(202);
		await w.idle();
		expect(stateOf(w, id)).toBe('eng-in-review');
		expect(transitions(w, id)).toHaveLength(1);
		expect(w.plane.links).toHaveLength(1);
		expect(w.lines('delivery.synced').map((l) => [l.action, l.reason])).toEqual([
			['moved', undefined],
			['noop', 'not forward'],
		]);
		expect(w.store.journalSince('2026-10-01T00:00:00Z')).toHaveLength(1);
	});

	test('ping — 200 и строка github.ping; событие вне списка — 200 ignored; подписанный не-JSON — 400 и rejected', async () => {
		const w = world();
		const ping = await w.send(githubRequest('ping', { zen: 'z', hook_id: 1 }));
		expect([ping.status, await ping.text()]).toEqual([200, 'ok']);
		expect(w.lines('github.ping')).toEqual([{ event: 'github.ping', tenant: 'acme', app: 'acme' }]);
		const other = await w.send(githubRequest('installation', { action: 'created' }));
		expect([other.status, await other.text()]).toEqual([200, 'ignored']);
		const broken = await w.send(githubRequest('pull_request', '{not json'));
		expect([broken.status, await broken.text()]).toEqual([400, 'github: body is not JSON']);
		expect(w.lines('delivery.rejected')).toEqual([
			{
				event: 'delivery.rejected',
				level: 'error',
				tenant: 'acme',
				input: 'github',
				status: 400,
				error: 'BadPayload: github: body is not JSON',
			},
		]);
		expect(w.store.inboxPending()).toEqual([]);
	});
});

describe('GitHub: деплой', () => {
	/** a0 ← a1 (ENG-1, PR #1 merged as a1); staging had a0 and now has a1. */
	function deployWorld() {
		const w = world();
		w.gh.commit('a0', [], 'init');
		w.gh.commit('a1', ['a0'], 'ENG-1 change (#1)');
		w.gh
			.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 change' })
			.mergePull('acme/api', 1, 'a1');
		w.gh.deploy('acme/api', 'staging', 'a0', 'success');
		const deploymentId = w.gh.deploy('acme/api', 'staging', 'a1', 'success');
		const id = w.plane.addWorkItem('ENG-1', 'In Review');
		const status = (over: Record<string, unknown> = {}) =>
			statusPayload(
				'success',
				{ id: deploymentId, sha: 'a1', environment: 'staging', created_at: '2026-10-28T09:00:00Z' },
				{
					created_at: '2026-10-28T10:00:00Z',
					log_url: 'https://github.com/acme/api/actions/runs/1',
					...over,
				},
			);
		return { w, id, status };
	}

	test('GitHub: deployment_status success — Выкачено, переход и строка annotation deploy с title, env, sha', async () => {
		const { w, id, status } = deployWorld();
		expect((await w.send(githubRequest('deployment_status', status()))).status).toBe(202);
		expect(stateOf(w, id)).toBe('eng-on-staging');
		expect(w.plane.commentsOf(id).map((c) => c.external_id)).toEqual([
			`deployed:${id}:acme/api:staging:a1`,
			`state:${id}:eng-on-staging:deploy:acme/api:staging:a1`,
		]);
		expect(w.lines('deploy')).toEqual([
			{
				event: 'deploy',
				tenant: 'acme',
				source: 'github',
				repo: 'acme/api',
				action: 'delivered',
				env: 'staging',
				sha: 'a1',
				annotation: 'deploy',
				title: 'acme/api → staging · a1',
			},
		]);
		expect(w.lines('delivery.noted')).toEqual([
			{ event: 'delivery.noted', tenant: 'acme', key: 'ENG-1', kind: 'deployed', created: true },
		]);
		expect(w.lines('delivery.synced').map((l) => [l.key, l.action, l.to])).toEqual([
			['ENG-1', 'moved', 'On staging'],
		]);
		expect(w.store.journalSince('2026-10-01T00:00:00Z').map((r) => r.cause)).toEqual([
			'deploy:acme/api:staging:a1',
		]);
	});

	test('at деплоя — created_at статуса: курсор с ним, более ранний статус после — устаревший, без отката', async () => {
		const { w, id, status } = deployWorld();
		await w.send(githubRequest('deployment_status', status()));
		// Neither the processing time (T0) nor the deployment's creation (09:00) stands in.
		expect(w.store.deployCursor('acme', 'acme/api', 'staging')).toEqual({
			sha: 'a1',
			at: '2026-10-28T10:00:00.000Z',
		});
		// An older status of the a0 deploy redelivered after it: ignored, the cursor stays, no «Откачено».
		const older = statusPayload(
			'success',
			{ id: 1, sha: 'a0', environment: 'staging' },
			{ created_at: '2026-10-28T09:30:00Z' },
		);
		await w.send(githubRequest('deployment_status', older));
		expect(w.store.deployCursor('acme', 'acme/api', 'staging')?.sha).toBe('a1');
		expect(w.lines('deploy').map((l) => [l.sha, l.action, l.annotation])).toEqual([
			['a1', 'delivered', 'deploy'],
			['a0', 'ignored', undefined],
		]);
		expect(w.plane.commentsOf(id).some((c) => c.external_id.startsWith('rolledback:'))).toBe(false);
	});

	test('GitHub: провал деплоя CI — инцидент', async () => {
		const w = world();
		const failure = statusPayload('failure', {
			id: 77,
			sha: 'f'.repeat(40),
			environment: 'production',
		});
		expect((await w.send(githubRequest('deployment_status', failure))).status).toBe(202);
		const incidents = w.plane.workItems.filter((item) => item.project === 'p-inc');
		expect(incidents.map((i) => [i.external_id, i.external_source, i.priority, i.name])).toEqual([
			[
				'deploy:acme/api:production',
				'github',
				'urgent',
				'Деплой упал: acme/api → production · fffffff',
			],
		]);
		expect(w.lines('deployment.failure')).toEqual([
			{
				event: 'deployment.failure',
				tenant: 'acme',
				source: 'github',
				key: 'deploy:acme/api:production',
				action: 'created',
				workItemId: incidents[0]?.id ?? '',
				ms: expect.any(Number),
			},
		]);
		expect(w.lines('deploy')).toEqual([]);
	});

	test('прод-деплой: сбой релиза (402 на Free) — строка release warn, деплой сделан', async () => {
		const w = world();
		w.gh.commit('p0', [], 'init');
		w.gh.commit('p1', ['p0'], 'ENG-2 ship (#2)');
		w.gh.pull({ repo: 'acme/api', number: 2, title: 'ENG-2 ship' }).mergePull('acme/api', 2, 'p1');
		w.gh.deploy('acme/api', 'production', 'p0', 'success');
		const deploymentId = w.gh.deploy('acme/api', 'production', 'p1', 'success');
		w.plane.addWorkItem('ENG-2', 'On staging');
		w.plane.failNext('findReleaseByExternalId', new PlaneApiError(402, 'GET', '/releases/'));
		const status = statusPayload('success', {
			id: deploymentId,
			sha: 'p1',
			environment: 'production',
		});
		await w.send(githubRequest('deployment_status', status));
		expect(w.lines('release')).toEqual([
			{
				event: 'release',
				level: 'warn',
				tenant: 'acme',
				repo: 'acme/api',
				sha: 'p1',
				error: 'PlaneApiError: Plane GET /releases/ → 402',
			},
		]);
		expect(w.lines('deploy').map((l) => [l.action, l.annotation])).toEqual([
			['delivered', 'deploy'],
		]);
		expect(w.store.inboxFailedList()).toEqual([]);

		// The same deploy without the 402: the release line carries its id.
		const ok = world({ gh: w.gh });
		ok.plane.addWorkItem('ENG-2', 'On staging');
		await ok.send(githubRequest('deployment_status', status));
		expect(ok.lines('release')).toEqual([
			{
				event: 'release',
				tenant: 'acme',
				repo: 'acme/api',
				sha: 'p1',
				action: 'created',
				releaseId: ok.plane.releases[0]?.id ?? '',
			},
		]);
	});

	test('откат окружения — «Откачено»: строка delivery.noted с kind rolledback', async () => {
		const { w, id, status } = deployWorld();
		await w.send(githubRequest('deployment_status', status()));
		// a0 deployed again after a1, at a later time: the environment went back.
		const back = w.gh.deploy('acme/api', 'staging', 'a0', 'success');
		const rollback = statusPayload(
			'success',
			{ id: back, sha: 'a0', environment: 'staging' },
			{ created_at: '2026-10-28T11:00:00Z' },
		);
		await w.send(githubRequest('deployment_status', rollback));
		expect(w.lines('delivery.noted').map((l) => [l.key, l.kind, l.created])).toEqual([
			['ENG-1', 'deployed', true],
			['ENG-1', 'rolledback', true],
		]);
		expect(w.lines('deploy').map((l) => l.action)).toEqual(['delivered', 'rolled_back']);
		expect(w.plane.commentsOf(id).at(-1)?.external_id).toBe(`rolledback:${id}:acme/api:staging:a0`);
	});

	test('провал деплоя: сбой Plane при инциденте — задача повторяется, инцидент один', async () => {
		const w = world();
		w.plane.failNext('createWorkItem', new PlaneApiError(503, 'POST', '/work-items/'));
		const failure = statusPayload('error', { id: 78, sha: 'e'.repeat(40), environment: 'staging' });
		await w.send(githubRequest('deployment_status', failure));
		expect(w.lines('deployment.error').map((l) => l.action)).toEqual(['error', 'created']);
		expect(w.lines('job.retry').map((l) => l.error)).toEqual(['Plane POST /work-items/ → 503']);
		expect(w.plane.workItems.filter((item) => item.project === 'p-inc')).toHaveLength(1);
		expect(w.store.inboxFailedList()).toEqual([]);
	});
});

describe('GitHub: очередь и входящие', () => {
	test('сбой Plane 503 в задаче очереди — повтор и успех; 400 — без повтора, строка error', async () => {
		const flaky = world();
		const id = seed(flaky);
		flaky.plane.failNext('getWorkItemByKey', new PlaneApiError(503, 'GET', '/work-items/ENG-7/'));
		await flaky.send(githubRequest('pull_request', READY()));
		expect(flaky.sleeps).toEqual([1000]);
		expect(flaky.lines('job.retry')).toEqual([
			{
				event: 'job.retry',
				level: 'warn',
				tenant: 'acme',
				label: 'github#1',
				attempt: 1,
				error: 'Plane GET /work-items/ENG-7/ → 503',
			},
		]);
		expect(stateOf(flaky, id)).toBe('eng-in-review');
		expect(flaky.store.inboxFailedList()).toEqual([]);

		const refused = world();
		const other = seed(refused);
		refused.plane.failNext('createLink', new PlaneApiError(400, 'POST', '/links/'));
		await refused.send(githubRequest('pull_request', READY()));
		expect(refused.sleeps).toEqual([]);
		expect(refused.lines('job.dropped')).toEqual([
			{
				event: 'job.dropped',
				level: 'error',
				tenant: 'acme',
				label: 'github#1',
				attempt: 1,
				error: 'Plane POST /links/ → 400',
			},
		]);
		expect(refused.store.inboxFailedList()).toEqual([
			{
				id: 1,
				tenant: 'acme',
				kind: 'github',
				error: 'Plane POST /links/ → 400',
				at: new Date(T0).toISOString(),
			},
		]);
		expect(stateOf(refused, other)).toBe('eng-in-progress');
	});

	test('доставка сохранена до 202: рестарт (новый runtime на том же файле базы) доделывает незавершённую', async () => {
		const path = dbFile();
		const hung = FakePlane.delivery();
		// The first process never gets past its first Plane call: it dies with the job unfinished.
		hung.listProjects = () => new Promise(() => {});
		const first = world({ store: new Store(path), plane: hung });
		const res = await first.handler(githubRequest('pull_request', READY()));
		expect(res.status).toBe(202);
		const saved = first.store.inboxPending();
		expect(saved.map((job) => [job.id, job.kind])).toEqual([[1, 'github']]);
		// The normalised event, not the raw body: no sender, no installation object.
		expect(JSON.parse(saved[0]?.payload ?? '{}')).toMatchObject({
			kind: 'pull_request',
			action: 'ready_for_review',
			pull: { repo: 'acme/api', number: 12 },
		});
		expect(saved[0]?.payload).not.toContain('octocat');
		first.store.close();

		const plane = FakePlane.delivery();
		const id = plane.addWorkItem('ENG-7', 'In Progress');
		const second = world({ store: new Store(path), plane });
		await second.idle();
		expect(stateOf(second, id)).toBe('eng-in-review');
		expect(second.store.inboxPending()).toEqual([]);
		expect(second.store.inboxFailedList()).toEqual([]);
		second.store.close();
	});

	test('повтор выполненной доставки GitHub — 200 duplicate без работы; Redeliver упавшей — выполняется', async () => {
		const w = world();
		const id = seed(w);
		const done = { 'x-github-delivery': 'redeliver-done' };
		expect((await w.send(githubRequest('pull_request', READY(), undefined, done))).status).toBe(
			202,
		);
		const calls = w.plane.calls.length;
		const again = await w.send(githubRequest('pull_request', READY(), undefined, done));
		expect([again.status, await again.text()]).toEqual([200, 'duplicate']);
		expect(w.plane.calls.length).toBe(calls);
		expect(w.lines('delivery.duplicate')).toEqual([
			{
				event: 'delivery.duplicate',
				tenant: 'acme',
				input: 'github',
				kind: 'pull_request',
				delivery: 'redeliver-done',
			},
		]);
		expect(stateOf(w, id)).toBe('eng-in-review');

		const failedWorld = world();
		const item = seed(failedWorld);
		const failing = { 'x-github-delivery': 'redeliver-failed' };
		failedWorld.plane.failNext('createLink', new PlaneApiError(400, 'POST', '/links/'));
		await failedWorld.send(githubRequest('pull_request', READY(), undefined, failing));
		expect(failedWorld.store.inboxFailedList().map((job) => job.id)).toEqual([1]);
		const redelivered = await failedWorld.send(
			githubRequest('pull_request', READY(), undefined, failing),
		);
		expect(redelivered.status).toBe(202);
		expect(stateOf(failedWorld, item)).toBe('eng-in-review');
		expect(failedWorld.store.inboxFailedList()).toEqual([]);
		expect(failedWorld.lines('job.dropped')).toHaveLength(1);
	});

	test('вид задачи, неизвестный этой сборке, — job.dropped и failed', async () => {
		const path = dbFile();
		const old = new Store(path);
		old.inboxAdd('acme', 'github.future', null, '{}', '2026-10-28T10:00:00Z');
		old.close();
		const w = world({ store: new Store(path) });
		await w.idle();
		expect(w.store.inboxFailedList().map((job) => job.error)).toEqual([
			'inbox kind github.future is unknown to this build',
		]);
		expect(w.lines('job.dropped').map((l) => l.label)).toEqual(['github.future#1']);
		w.store.close();
	});

	test('задача тенанта, которого больше нет в конфиге, при старте помечается упавшей', async () => {
		const path = dbFile();
		const old = new Store(path);
		old.inboxAdd('gone', 'github', 'd-gone', '{}', '2026-10-28T10:00:00Z');
		old.close();
		const w = world({ store: new Store(path), tenants: [tenantOf()] });
		expect(w.store.inboxFailedList()).toEqual([
			{
				id: 1,
				tenant: 'gone',
				kind: 'github',
				error: 'tenant is not configured',
				at: '2026-10-28T10:00:00.000Z',
			},
		]);
		expect(w.lines('inbox.orphaned')).toEqual([
			{ event: 'inbox.orphaned', level: 'warn', tenant: 'gone', id: 1 },
		]);
		w.store.close();
	});
});
