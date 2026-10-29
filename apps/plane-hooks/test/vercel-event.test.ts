import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';

import type { IncidentSignal } from '../src/incident.ts';
import { BadPayload } from '../src/payload.ts';
import { parseVercelEvent, type VercelHookEvent, verifyVercelSignature } from '../src/vercel.ts';
import { fixture, fixtureBytes } from './fixtures.ts';

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
		// Half a repository name is no repository.
		const orgOnly = promoted((b) => delete b.payload.deployment.meta.githubCommitRepo);
		expect(orgOnly).toMatchObject({ repo: null, sha: SHA });
		const repoOnly = promoted((b) => delete b.payload.deployment.meta.githubCommitOrg);
		expect(repoOnly).toMatchObject({ repo: null });
	});

	test('rollback — свой kind; тела deployment в документации нет, sha и url null', () => {
		expect(rollback()).toEqual({
			kind: 'rolled_back',
			project: 'prj_terminal',
			repo: null,
			sha: null,
			at: '2026-10-06T10:36:40.000Z',
			url: null,
			toDeploymentId: 'dpl_old',
		});
	});

	test('rollback без payload.project, но с именем из deployment — проект по имени', () => {
		const ev = rollback((b) => {
			delete b.payload.project;
			b.payload.deployment = { name: 'terminal' };
		});
		expect(ev).toMatchObject({ kind: 'rolled_back', project: 'terminal' });
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
			toDeploymentId: 'dpl_old',
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

	const bad: unknown[] = [
		null,
		{},
		{ type: 1 },
		{ type: 'deployment.error', payload: {} },
		{
			type: 'deployment.error',
			payload: { project: { id: 'p' }, deployment: { name: 'n', url: 'u' } },
		},
		{ type: 'deployment.succeeded', payload: { deployment: { id: 'd', name: 'n', url: 'u' } } },
		{
			type: 'deployment.error',
			payload: { project: { id: 'p' }, deployment: { id: 'd', url: 'u' } },
		},
		{
			type: 'deployment.error',
			payload: { project: { id: 'p' }, deployment: { id: 'd', name: 'n' } },
		},
		{ type: 'deployment.error' },
		{ type: 'deployment.error', payload: 'text' },
	];
	test.each(bad.map((body, index) => [index, body] as const))(
		'чужая форма %d → BadPayload',
		(_index, body) => {
			expect(() => parseVercelEvent(body)).toThrow(BadPayload);
		},
	);
});

const SECRET = 'vercel-test-secret';
const KEY = `deploy:prj_terminal:production:${BRANCH}`;
const sign = (raw: Uint8Array, secret = SECRET) =>
	createHmac('sha1', secret).update(raw).digest('hex');

function failed(ev: VercelHookEvent): Extract<IncidentSignal, { status: 'firing' }> {
	if (ev.kind !== 'failed' || ev.signal.status !== 'firing')
		throw new Error(`expected failed, got ${ev.kind}`);
	return ev.signal;
}

function succeeded(ev: VercelHookEvent): Extract<VercelHookEvent, { kind: 'succeeded' }> {
	if (ev.kind !== 'succeeded') throw new Error(`expected succeeded, got ${ev.kind}`);
	return ev;
}

describe('verifyVercelSignature', () => {
	test('верная подпись HMAC-SHA1 по сырым байтам', async () => {
		const raw = await fixtureBytes('vercel-deployment-error.json');
		expect(verifyVercelSignature(raw, sign(raw), SECRET)).toBe(true);
	});

	test('изменённое тело, чужой секрет, нет заголовка, мусор — false без исключений', async () => {
		const raw = await fixtureBytes('vercel-deployment-error.json');
		expect(verifyVercelSignature(new Uint8Array([...raw, 0x20]), sign(raw), SECRET)).toBe(false);
		expect(verifyVercelSignature(raw, sign(raw, 'other-secret'), SECRET)).toBe(false);
		expect(verifyVercelSignature(raw, null, SECRET)).toBe(false);
		expect(verifyVercelSignature(raw, 'abc', SECRET)).toBe(false);
		expect(verifyVercelSignature(raw, 'z'.repeat(40), SECRET)).toBe(false);
	});

	test('hex неверной длины (короче и длиннее 40) — false без исключений', async () => {
		const raw = await fixtureBytes('vercel-deployment-error.json');
		expect(verifyVercelSignature(raw, 'abcd', SECRET)).toBe(false);
		expect(verifyVercelSignature(raw, sign(raw).slice(0, 38), SECRET)).toBe(false);
		expect(verifyVercelSignature(raw, `${sign(raw)}00`, SECRET)).toBe(false);
	});
});

describe('deployment.error', () => {
	test('сигнал срабатывания с ключом проект+target+ветка', async () => {
		const signal = failed(await event('vercel-deployment-error.json'));
		expect(signal).toMatchObject({
			status: 'firing',
			source: 'vercel',
			key: KEY,
			occurrence: 'dpl_err1',
			at: '2026-10-06T10:00:00.000Z',
			title: `Деплой упал: terminal (production) · ${BRANCH}`,
			priority: 'high',
			label: 'deploy-failed',
			noteHtml:
				'<p>Деплой упал: <a href="https://vercel.com/example-team/terminal/dpl_err1">dpl_err1</a> · <code>0123456</code></p>',
		});
		expect(signal.bodyHtml).toContain(`<code>${SHA}</code>`);
		expect(signal.bodyHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(signal.bodyHtml).not.toContain('<script>');
		expect(signal.bodyHtml).toContain('<a href="https://terminal-abc123-example.vercel.app">');
	});

	test('target null → preview, приоритет medium; staging → medium', async () => {
		const preview = failed(
			await event('vercel-deployment-error.json', (b) => (b.payload.target = null)),
		);
		expect(preview.key).toBe(`deploy:prj_terminal:preview:${BRANCH}`);
		expect(preview.priority).toBe('medium');
		const staging = failed(
			await event('vercel-deployment-error.json', (b) => (b.payload.target = 'staging')),
		);
		expect(staging.key).toBe(`deploy:prj_terminal:staging:${BRANCH}`);
		expect(staging.priority).toBe('medium');
	});

	test('деплой без git-метаданных (CLI) → ветка unknown', async () => {
		const signal = failed(
			await event('vercel-deployment-error.json', (b) => delete b.payload.deployment.meta),
		);
		expect(signal.key).toBe('deploy:prj_terminal:production:unknown');
		expect(signal.title).toBe('Деплой упал: terminal (production) · unknown');
		expect(signal.noteHtml).toBe(
			'<p>Деплой упал: <a href="https://vercel.com/example-team/terminal/dpl_err1">dpl_err1</a></p>',
		);
	});

	test('ветка длиннее 80 символов → 16 hex её SHA-256 в ключе', async () => {
		const longBranch = `feat/${'x'.repeat(100)}`;
		const signal = failed(
			await event(
				'vercel-deployment-error.json',
				(b) => (b.payload.deployment.meta.githubCommitRef = longBranch),
			),
		);
		const hash = createHash('sha256').update(longBranch).digest('hex').slice(0, 16);
		expect(signal.key).toBe(`deploy:prj_terminal:production:${hash}`);
		expect(signal.title.length).toBeLessThanOrEqual(200);
	});

	test('createdAt ISO-строкой и без createdAt', async () => {
		const iso = failed(
			await event(
				'vercel-deployment-error.json',
				(b) => (b.createdAt = '2026-10-06T10:00:00+03:00'),
			),
		);
		expect(iso.at).toBe('2026-10-06T07:00:00.000Z');
		const none = failed(await event('vercel-deployment-error.json', (b) => delete b.createdAt));
		expect(Number.isNaN(Date.parse(none.at))).toBe(false);
	});
});

describe('deployment.error: границы и экранирование', () => {
	test('target вне production/staging (canary) → preview', async () => {
		const signal = failed(
			await event('vercel-deployment-error.json', (b) => (b.payload.target = 'canary')),
		);
		expect(signal.key).toBe(`deploy:prj_terminal:preview:${BRANCH}`);
		expect(signal.title).toBe(`Деплой упал: terminal (preview) · ${BRANCH}`);
	});

	test('ветка ровно 80 символов остаётся в ключе, 81 — заменяется хэшем', async () => {
		const at80 = `feat/${'y'.repeat(75)}`;
		const at81 = `${at80}z`;
		expect(at80).toHaveLength(80);
		const keep = failed(
			await event(
				'vercel-deployment-error.json',
				(b) => (b.payload.deployment.meta.githubCommitRef = at80),
			),
		);
		expect(keep.key).toBe(`deploy:prj_terminal:production:${at80}`);
		const hash = createHash('sha256').update(at81).digest('hex').slice(0, 16);
		const cut = failed(
			await event(
				'vercel-deployment-error.json',
				(b) => (b.payload.deployment.meta.githubCommitRef = at81),
			),
		);
		expect(cut.key).toBe(`deploy:prj_terminal:production:${hash}`);
	});

	test('заголовок: ровно 200 символов цел, 201 → 199 + «…»', async () => {
		const titleOf = (name: string) => `Деплой упал: ${name} (production) · ${BRANCH}`;
		const pad = 200 - titleOf('').length;
		const exact = failed(
			await event(
				'vercel-deployment-error.json',
				(b) => (b.payload.deployment.name = 'n'.repeat(pad)),
			),
		);
		expect(exact.title).toBe(titleOf('n'.repeat(pad)));
		expect(exact.title).toHaveLength(200);
		const over = failed(
			await event(
				'vercel-deployment-error.json',
				(b) => (b.payload.deployment.name = 'n'.repeat(pad + 1)),
			),
		);
		expect(over.title).toBe(`${titleOf('n'.repeat(pad + 1)).slice(0, 199)}…`);
		expect(over.title).toHaveLength(200);
	});

	test('без ссылок Vercel: id деплоя в <code>, в теле нет ссылки инспектора; со ссылками — текст ссылки', async () => {
		const plain = failed(
			await event('vercel-deployment-error.json', (b) => delete b.payload.links),
		);
		expect(plain.noteHtml).toBe('<p>Деплой упал: <code>dpl_err1</code> · <code>0123456</code></p>');
		expect(plain.bodyHtml).not.toContain('Инспектор');
		const withLinks = failed(await event('vercel-deployment-error.json'));
		expect(withLinks.bodyHtml).toContain(
			'<a href="https://vercel.com/example-team/terminal/dpl_err1">Инспектор Vercel</a>',
		);
	});

	test('ссылка инспектора не http(s) (javascript:) — id деплоя в <code>, ни одной ссылки на неё', async () => {
		const signal = failed(
			await event(
				'vercel-deployment-error.json',
				(b) => (b.payload.links.deployment = 'javascript:alert(1)'),
			),
		);
		expect(signal.noteHtml).toBe(
			'<p>Деплой упал: <code>dpl_err1</code> · <code>0123456</code></p>',
		);
		expect(signal.noteHtml).not.toContain('<a');
		expect(signal.bodyHtml).not.toContain('javascript:');
		expect(signal.bodyHtml).not.toContain('Инспектор');
	});

	test('имя, ветка, sha и id деплоя экранируются в теле и заметке', async () => {
		const signal = failed(
			await event('vercel-deployment-error.json', (b) => {
				b.payload.deployment.id = 'dpl_<i>';
				b.payload.deployment.name = 'n<u>';
				b.payload.deployment.meta.githubCommitRef = 'r<b>';
				b.payload.deployment.meta.githubCommitSha = '<s>0123456789';
				delete b.payload.links;
			}),
		);
		expect(signal.bodyHtml).toContain('<code>n&lt;u&gt;</code>');
		expect(signal.bodyHtml).toContain('<code>r&lt;b&gt;</code>');
		expect(signal.bodyHtml).toContain('<code>&lt;s&gt;0123456789</code>');
		expect(signal.noteHtml).toBe(
			'<p>Деплой упал: <code>dpl_&lt;i&gt;</code> · <code>&lt;s&gt;0123</code></p>',
		);
		expect(`${signal.bodyHtml}${signal.noteHtml}`).not.toMatch(/<[ibus]>/);
	});
});

describe('deployment.succeeded: Погас и сводка', () => {
	test('восстановление без срабатывания: ключ, время события, sha7; без occurrence', async () => {
		const ev = succeeded(await event('vercel-deployment-succeeded.json'));
		expect(ev.resolve).toEqual({
			status: 'resolved',
			source: 'vercel',
			key: KEY,
			at: '2026-10-06T10:10:00.000Z',
			noteHtml: '<p>Деплой снова проходит: <code>0123456</code></p>',
		});
		expect('occurrence' in ev.resolve).toBe(false);
	});

	test('без git-метаданных: в восстановлении и в сводке id деплоя, sha нет', async () => {
		const ev = succeeded(
			await event('vercel-deployment-succeeded.json', (b) => delete b.payload.deployment.meta),
		);
		expect((ev.resolve as { noteHtml: string }).noteHtml).toBe(
			'<p>Деплой снова проходит: <code>dpl_ok1</code></p>',
		);
		expect(ev.summary.title).toBe('terminal → production · dpl_ok1');
		expect(ev.summary.sha).toBeUndefined();
	});

	test('target staging попадает в env сводки', async () => {
		const ev = succeeded(
			await event('vercel-deployment-succeeded.json', (b) => (b.payload.target = 'staging')),
		);
		expect(ev.summary).toEqual({
			title: 'terminal → staging · 0123456',
			env: 'staging',
			sha: SHA,
		});
	});

	test('url превью уже со схемой не дублирует https://', async () => {
		const urlOf = async (url: string) => {
			const ev = await event('vercel-deployment-succeeded.json', (b) => {
				b.payload.target = null;
				b.payload.deployment.url = url;
			});
			if (ev.kind !== 'preview') throw new Error(`expected preview, got ${ev.kind}`);
			return ev.preview.url;
		};
		expect(await urlOf('https://x.vercel.app')).toBe('https://x.vercel.app');
		expect(await urlOf('http://x.vercel.app')).toBe('http://x.vercel.app');
		expect(await urlOf('HTTPS://X.VERCEL.APP')).toBe('HTTPS://X.VERCEL.APP');
		expect(await urlOf('x.vercel.app')).toBe('https://x.vercel.app');
	});
});
