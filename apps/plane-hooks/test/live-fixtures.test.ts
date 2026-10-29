// Part B of the Task 1 probe: live deliveries (sanitized) through the hub's real entry points.
import { describe, expect, test } from 'bun:test';

import { parseDokployWebhook } from '../src/dokploy.ts';
import { parseGitHubDelivery } from '../src/github/webhook.ts';
import { parseVercelEvent } from '../src/vercel.ts';
import { fakeSha } from '../scripts/sanitize-fixture.ts';
import { fixture } from './fixtures.ts';
import { dokployRequest, githubRequest, vercelRequest, world } from './server-harness.ts';

const APP_ID = 1_000_001;

describe('pull_request edited (живая доставка)', () => {
	test('edited с changes.title: событие с новым заголовком и action edited', async () => {
		const { headers, body } = await fixture('github-pr-edited-title.json');
		const event = parseGitHubDelivery(
			new Headers(headers),
			new TextEncoder().encode(JSON.stringify(body)),
			APP_ID,
		);
		expect(event).toMatchObject({
			kind: 'pull_request',
			action: 'edited',
			pull: { repo: 'acme/api', title: 'Example change', state: 'open', merged: false },
		});
		expect(body.changes.title.from).toBeString();
	});

	test('сервер: новый заголовок с ключом задачи — ссылка на PR у задачи', async () => {
		const { body } = await fixture('github-pr-edited-title.json');
		body.pull_request.title = 'ENG-7 renamed';
		body.pull_request.head.ref = 'unrelated';
		body.pull_request.draft = false;
		body.repository.full_name = 'acme/api';
		const w = world();
		const id = w.plane.addWorkItem('ENG-7', 'In Progress');
		expect((await w.send(githubRequest('pull_request', body))).status).toBe(202);
		await w.idle();
		expect(w.plane.links.map((l) => l.workItemId)).toEqual([id]);
	});
});

describe('Vercel: живые доставки (API-передеплой превью)', () => {
	test('deployment.succeeded превью: проект, репозиторий, ветка, ссылка, sha из настоящего meta', async () => {
		const { body } = await fixture('vercel-preview-succeeded.json');
		const event = parseVercelEvent(body);
		expect(event).toMatchObject({
			kind: 'preview',
			preview: {
				project: 'app1',
				repo: 'acme/api',
				branch: 'feat/branch-1',
				url: 'https://deployment-2.vercel.app',
				sha: body.payload.deployment.meta.githubCommitSha,
			},
			resolve: { key: 'deploy:prj_example1:preview:feat/branch-1' },
		});
		expect(body.payload.deployment.meta.githubPrId).toBeString();
		expect(body.payload.target).toBeNull();
	});

	test('deployment.created — ignored', async () => {
		const { body } = await fixture('vercel-created.json');
		expect(parseVercelEvent(body)).toEqual({ kind: 'ignored', type: 'deployment.created' });
	});

	test('сервер: подписанное превью с веткой-ключом — комментарий превью; created — 200 ignored', async () => {
		const { body } = await fixture('vercel-preview-succeeded.json');
		body.payload.deployment.meta.githubCommitRef = 'eng-7-live-preview';
		const w = world();
		const id = w.plane.addWorkItem('ENG-7', 'In Progress');
		const res = await w.send(vercelRequest('acme', body));
		expect([res.status, await res.text()]).toEqual([200, 'ok']);
		expect(w.plane.commentsOf(id).map((c) => c.external_id)).toEqual([`preview:${id}:app1`]);

		const created = await fixture('vercel-created.json');
		const ignored = await w.send(vercelRequest('acme', created.body));
		expect([ignored.status, await ignored.text()]).toEqual([200, 'ignored']);
	});
});

describe('deployment_status от vercel[bot] (Preview)', () => {
	test('разбор: окружение Preview, создатель vercel[bot], sha совпадает с превью Vercel', async () => {
		const { headers, body } = await fixture('github-deployment-status-vercel.json');
		const event = parseGitHubDelivery(
			new Headers(headers),
			new TextEncoder().encode(JSON.stringify(body)),
			APP_ID,
		);
		expect(event).toMatchObject({
			kind: 'deployment_status',
			state: 'success',
			deployment: { environment: 'Preview', creator: 'vercel[bot]', repo: 'acme/api' },
		});
		const vercel = await fixture('vercel-preview-succeeded.json');
		expect(event?.kind === 'deployment_status' && event.deployment.sha).toBe(
			vercel.body.payload.deployment.meta.githubCommitSha,
		);
	});

	test('сервер: Preview, которого нет в правилах, не двигает задачи и курсор', async () => {
		const { body } = await fixture('github-deployment-status-vercel.json');
		const w = world();
		const id = w.plane.addWorkItem('ENG-7', 'On staging');
		expect((await w.send(githubRequest('deployment_status', body))).status).toBe(202);
		await w.idle();
		expect(w.plane.workItems.find((item) => item.id === id)?.state).toBe('eng-on-staging');
		expect(w.plane.commentsOf(id)).toEqual([]);
		expect(w.lines('deploy').map((l) => l.action)).toEqual(['ignored']);
	});
});

describe('Dokploy: App Deploy compose-приложения', () => {
	test('разбор: deployed с именем приложения, временем и ссылкой на деплой', async () => {
		const { body } = await fixture('dokploy-deploy.json');
		expect(parseDokployWebhook(body)).toMatchObject({
			kind: 'deployed',
			app: 'example-app-1',
			at: '2026-10-29T02:58:22.912Z',
			url: 'https://host1.example.com/dashboard/project/id1/environment/id2/services/compose/id3?tab=deployments',
		});
	});

	test('сервер: сопоставленное приложение — Deployment на голове ветки', async () => {
		const { body } = await fixture('dokploy-deploy.json');
		body.applicationName = 'api';
		const w = world();
		const sha = fakeSha('head');
		w.gh.branch('acme/api', 'main', sha);
		const res = await w.send(dokployRequest('acme', body));
		expect([res.status, await res.text()]).toEqual([200, 'ok']);
		expect(w.gh.calls.filter((c) => c.startsWith('create'))[0]).toBe(
			`createDeployment acme/api production ${sha}`,
		);
	});
});

describe('Vercel: instant rollback (по документации Vercel: только from/toDeploymentId)', () => {
	const rollback = () => ({
		id: 'evt_rollback_doc',
		type: 'deployment.rollback',
		createdAt: 1791283000000,
		payload: {
			team: { id: 'team_example1' },
			user: { id: 'user_example1' },
			project: { id: 'prj_example1' },
			fromDeploymentId: 'dpl_new',
			toDeploymentId: 'dpl_old',
		},
	});

	test('без sha: 200 ignored, одна warn-строка vercel.rollback.unresolved, Plane и GitHub не тронуты', async () => {
		const w = world();
		const id = w.plane.addWorkItem('ENG-7', 'Done');
		const res = await w.send(vercelRequest('acme', rollback()));
		expect([res.status, await res.text()]).toEqual([200, 'ignored']);
		expect(w.lines('vercel.rollback.unresolved')).toEqual([
			{
				event: 'vercel.rollback.unresolved',
				level: 'warn',
				tenant: 'acme',
				project: 'prj_example1',
				toDeploymentId: 'dpl_old',
			},
		]);
		expect(w.lines('vercel.switch')).toEqual([]);
		expect(w.plane.commentsOf(id)).toEqual([]);
		expect(w.gh.calls).toEqual([]);
	});

	test('rollback с телом deployment (sha есть) и promote без sha идут путём деплоя, не unresolved', async () => {
		const w = world();
		const withSha = rollback();
		(withSha.payload as any).deployment = {
			id: 'dpl_old',
			name: 'app1',
			url: 'app1-old.vercel.app',
			meta: {
				githubCommitOrg: 'acme',
				githubCommitRepo: 'api',
				githubCommitSha: fakeSha('old'),
			},
		};
		await w.send(vercelRequest('acme', withSha));
		const promoted = {
			id: 'evt_promoted_doc',
			type: 'deployment.promoted',
			createdAt: 1791283000000,
			payload: {
				project: { id: 'prj_example1' },
				deployment: { id: 'dpl_x', name: 'app1', meta: {} },
			},
		};
		const res = await w.send(vercelRequest('acme', promoted));
		expect(res.status).toBe(200);
		expect(w.lines('vercel.rollback.unresolved')).toEqual([]);
		expect(w.lines('vercel.switch').map((l) => [l.kind, l.action])).toEqual([
			['rolled_back', 'no_deploy'],
			['promoted', 'no_deploy'],
		]);
		const parsed = parseVercelEvent({
			...promoted,
			payload: { ...promoted.payload, toDeploymentId: 'dpl_stray' },
		});
		expect(parsed).not.toHaveProperty('toDeploymentId');
	});
});
