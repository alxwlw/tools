import { describe, expect, test } from 'bun:test';

import { BadPayload } from '../src/payload.ts';
import { parseVercelEvent, type VercelHookEvent } from '../src/vercel.ts';
import { fixture } from './fixtures.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const BRANCH = 'feat/ops-12-plane-hooks';
const PREVIEW_KEY = `deploy:prj_terminal:preview:${BRANCH}`;

async function event(
	name: string,
	mutate: (body: any) => void = () => undefined,
): Promise<VercelHookEvent> {
	const body = await fixture(name);
	mutate(body);
	return parseVercelEvent(body);
}

// по документации Vercel: Webhooks API, `deployment.promoted` (https://vercel.com/docs/webhooks/webhooks-api)
const promoted = (mutate: (body: any) => void = () => undefined) => {
	const body = {
		id: 'evt_promoted_1',
		type: 'deployment.promoted',
		createdAt: 1791282000000,
		payload: {
			team: { id: 'team_example' },
			user: { id: 'user_1' },
			project: { id: 'prj_terminal' },
			deployment: {
				id: 'dpl_prom1',
				url: 'terminal-prom-example.vercel.app',
				name: 'terminal',
				meta: {
					githubCommitOrg: 'acme',
					githubCommitRepo: 'api',
					githubCommitRef: 'main',
					githubCommitSha: SHA,
				},
			},
			links: { deployment: 'https://vercel.com/example-team/terminal/dpl_prom1' },
		},
	};
	mutate(body);
	return parseVercelEvent(body);
};

// по документации Vercel: Webhooks API, `deployment.rollback` — payload.fromDeploymentId / toDeploymentId,
// без payload.deployment (https://vercel.com/docs/webhooks/webhooks-api)
const rollback = (mutate: (body: any) => void = () => undefined) => {
	const body = {
		id: 'evt_rollback_1',
		type: 'deployment.rollback',
		createdAt: 1791283000000,
		payload: {
			team: { id: 'team_example' },
			user: { id: 'user_1' },
			project: { id: 'prj_terminal' },
			fromDeploymentId: 'dpl_new',
			toDeploymentId: 'dpl_old',
		},
	};
	mutate(body);
	return parseVercelEvent(body);
};

describe('parseVercelEvent: деплой', () => {
	test('превью — preview с repo, веткой, ссылкой и sha; плюс Погас для инцидента превью', async () => {
		const ev = await event('vercel-deployment-succeeded.json', (b) => {
			b.payload.target = null;
			// по документации Vercel: метаданные деплоя githubCommitOrg/githubCommitRepo (в доках названы только githubCommitSha/Ref)
			b.payload.deployment.meta.githubCommitOrg = 'acme';
			b.payload.deployment.meta.githubCommitRepo = 'api';
		});
		if (ev.kind !== 'preview') throw new Error(`expected preview, got ${ev.kind}`);
		expect(ev.preview).toEqual({
			project: 'terminal',
			repo: 'acme/api',
			branch: BRANCH,
			url: 'https://terminal-def456-example.vercel.app',
			sha: SHA,
		});
		expect(ev.resolve).toMatchObject({
			status: 'resolved',
			source: 'vercel',
			key: PREVIEW_KEY,
			at: '2026-10-06T10:10:00.000Z',
			noteHtml: '<p>Деплой снова проходит: <code>0123456</code></p>',
		});
	});

	test('превью без git-метаданных — repo, ветка и sha null', async () => {
		const ev = await event('vercel-deployment-succeeded.json', (b) => {
			b.payload.target = null;
			delete b.payload.deployment.meta;
		});
		if (ev.kind !== 'preview') throw new Error(`expected preview, got ${ev.kind}`);
		expect(ev.preview).toEqual({
			project: 'terminal',
			repo: null,
			branch: null,
			url: 'https://terminal-def456-example.vercel.app',
			sha: null,
		});
	});

	test('прод успешен — только Погас, без заметки о выкатке', async () => {
		const ev = await event('vercel-deployment-succeeded.json');
		if (ev.kind !== 'succeeded') throw new Error(`expected succeeded, got ${ev.kind}`);
		expect(ev.resolve).toMatchObject({
			status: 'resolved',
			key: `deploy:prj_terminal:production:${BRANCH}`,
		});
		expect(ev.summary).toEqual({
			title: 'terminal → production · 0123456',
			env: 'production',
			sha: SHA,
		});
		expect('note' in ev).toBe(false);
	});

	test('staging успешен — тоже только Погас', async () => {
		const ev = await event(
			'vercel-deployment-succeeded.json',
			(b) => (b.payload.target = 'staging'),
		);
		expect(ev.kind).toBe('succeeded');
	});

	test('ошибка — инцидент, как сейчас', async () => {
		const ev = await event('vercel-deployment-error.json');
		if (ev.kind !== 'failed' || ev.signal.status !== 'firing')
			throw new Error(`expected failed, got ${ev.kind}`);
		expect(ev.signal).toMatchObject({
			source: 'vercel',
			key: `deploy:prj_terminal:production:${BRANCH}`,
			occurrence: 'dpl_err1',
			at: '2026-10-06T10:00:00.000Z',
			title: `Деплой упал: terminal (production) · ${BRANCH}`,
			priority: 'high',
			label: 'deploy-failed',
		});
		expect(ev.summary).toEqual({
			title: '✗ terminal → production упал · 0123456',
			env: 'production',
			sha: SHA,
		});
	});
});

describe('parseVercelEvent: promote и rollback', () => {
	test('promote — свой kind с repo, sha, временем события и ссылкой', () => {
		expect(promoted()).toEqual({
			kind: 'promoted',
			project: 'terminal',
			repo: 'acme/api',
			sha: SHA,
			at: '2026-10-06T10:20:00.000Z',
			url: 'https://terminal-prom-example.vercel.app',
		});
	});

	test('promote без githubCommitOrg/Repo и sha — repo и sha null', () => {
		const ev = promoted((b) => (b.payload.deployment.meta = {}));
		expect(ev).toMatchObject({ kind: 'promoted', repo: null, sha: null });
	});

	test('rollback — свой kind; тела deployment в документации нет, sha и url null', () => {
		expect(rollback()).toEqual({
			kind: 'rolled_back',
			project: 'prj_terminal',
			repo: null,
			sha: null,
			at: '2026-10-06T10:36:40.000Z',
			url: null,
		});
	});

	test('rollback с телом deployment — sha и repo оттуда', () => {
		const ev = rollback((b) => {
			b.payload.deployment = {
				id: 'dpl_old',
				url: 'terminal-old-example.vercel.app',
				name: 'terminal',
				meta: { githubCommitOrg: 'acme', githubCommitRepo: 'api', githubCommitSha: SHA },
			};
		});
		expect(ev).toEqual({
			kind: 'rolled_back',
			project: 'terminal',
			repo: 'acme/api',
			sha: SHA,
			at: '2026-10-06T10:36:40.000Z',
			url: 'https://terminal-old-example.vercel.app',
		});
	});

	test('время promote — из createdAt самого события, ISO-строка тоже; без createdAt — BadPayload', () => {
		expect(promoted((b) => (b.createdAt = '2026-10-06T10:00:00+03:00'))).toMatchObject({
			at: '2026-10-06T07:00:00.000Z',
		});
		expect(() => promoted((b) => delete b.createdAt)).toThrow(BadPayload);
		expect(() => rollback((b) => (b.createdAt = 'вчера'))).toThrow(BadPayload);
	});

	test('promote без deployment id или имени, rollback без toDeploymentId или проекта — BadPayload', () => {
		expect(() => promoted((b) => delete b.payload.deployment.id)).toThrow(BadPayload);
		expect(() => promoted((b) => delete b.payload.deployment.name)).toThrow(BadPayload);
		expect(() => rollback((b) => delete b.payload.toDeploymentId)).toThrow(BadPayload);
		expect(() => rollback((b) => delete b.payload.project)).toThrow(BadPayload);
	});
});

describe('parseVercelEvent: прочее', () => {
	test('другие события — ignored', () => {
		expect(parseVercelEvent({ type: 'deployment.created', payload: {} })).toEqual({
			kind: 'ignored',
			type: 'deployment.created',
		});
		expect(parseVercelEvent({ type: 'project.created' })).toEqual({
			kind: 'ignored',
			type: 'project.created',
		});
	});

	test('без deployment id — BadPayload', async () => {
		await expect(
			event('vercel-deployment-succeeded.json', (b) => delete b.payload.deployment.id),
		).rejects.toThrow(BadPayload);
		await expect(
			event('vercel-deployment-error.json', (b) => delete b.payload.deployment.id),
		).rejects.toThrow(BadPayload);
	});

	test('не объект и без типа — BadPayload', () => {
		expect(() => parseVercelEvent('x')).toThrow(BadPayload);
		expect(() => parseVercelEvent({})).toThrow(BadPayload);
	});
});
