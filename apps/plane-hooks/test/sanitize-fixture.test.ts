import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	cli,
	fakeSha,
	sanitizeDokploy,
	sanitizeGithub,
	sanitizeHeaders,
	sanitizeVercel,
} from '../scripts/sanitize-fixture.ts';

const SHA_A = '0123456789abcdef0123456789abcdef01234567';
const SHA_B = 'fedcba9876543210fedcba9876543210fedcba98';

const githubInput = () => ({
	repository: {
		id: 424242,
		node_id: 'R_kgDOabc',
		name: 'monorepo',
		full_name: 'example-org/monorepo',
		html_url: 'https://github.com/example-org/monorepo',
		owner: {
			login: 'example-org',
			id: 777,
			avatar_url: 'https://avatars.githubusercontent.com/u/777?v=4',
		},
	},
	sender: { login: 'someone', id: 555 },
	pull_request: {
		title: 'ping @someone',
		head: { sha: SHA_A, repo: { full_name: 'example-org/monorepo' } },
		base: { sha: SHA_B, repo: { full_name: 'other-org/tools' } },
	},
	commit: { author: { email: 'a@b.c' } },
});

test('sanitizeGithub заменяет организацию, логины, id, sha и почту, сохраняя форму', () => {
	const input = githubInput();
	const out = sanitizeGithub(input) as ReturnType<typeof githubInput>;
	expect(out.repository.full_name).toBe('acme/api');
	expect(out.repository.name).toBe('api');
	expect(out.repository.html_url).toBe('https://github.com/acme/api');
	expect(out.repository.owner.login).toBe('acme');
	expect(out.sender.login).toBe('octocat');
	expect(out.pull_request.title).toBe('ping @octocat');
	expect(out.pull_request.base.repo.full_name).toBe('acme/repo2');
	expect(out.commit.author.email).toBe('octocat@example.com');
	expect(out.repository.id).toBe(1);
	expect(out.repository.owner.id).toBe(2);
	expect(out.sender.id).toBe(3);
	expect(out.repository.node_id).toBe('1_kwDOexample');
	expect(out.repository.owner.avatar_url).toBe('https://avatars.githubusercontent.com/u/1?v=4');
	const head = out.pull_request.head.sha;
	expect(head).toMatch(/^[0-9a-f]{40}$/);
	expect(head).not.toBe(SHA_A);
	expect(head).toBe(fakeSha(SHA_A));
	expect(out.pull_request.base.sha).not.toBe(head);
	expect(
		(sanitizeGithub(githubInput()) as ReturnType<typeof githubInput>).pull_request.head.sha,
	).toBe(head);
	const flat = JSON.stringify(out);
	for (const original of [
		'example-org',
		'other-org',
		'someone',
		'monorepo',
		'a@b.c',
		SHA_A,
		SHA_B,
	]) {
		expect(flat).not.toContain(original);
	}
	expect(Object.keys(out.pull_request)).toEqual(Object.keys(input.pull_request));
});

test('sanitizeGithub не меняет входной объект', () => {
	const input = githubInput();
	sanitizeGithub(input);
	expect(input).toEqual(githubInput());
});

test('sanitizeVercel заменяет поля meta, id, хосты и ссылки, оставляя ветку и номер PR', () => {
	const input = {
		type: 'deployment.succeeded',
		payload: {
			team: { id: 'team_Abc123', slug: 'example-team' },
			user: { id: 'u1234567890' },
			project: { id: 'prj_Xyz789' },
			deployment: {
				id: 'dpl_Q1w2e3',
				name: 'private-site',
				url: 'private-site-git-feature-example-team.vercel.app',
				meta: {
					githubCommitOrg: 'example-org',
					githubCommitRepo: 'monorepo',
					githubCommitSha: SHA_A,
					githubCommitAuthorLogin: 'someone',
					githubCommitAuthorName: 'Some One',
					githubCommitMessage: 'private words',
					githubCommitRef: 'staging',
					githubPrId: '12',
				},
			},
			links: { deployment: 'https://vercel.com/example-team/private-site/Q1w2e3' },
		},
	};
	const out = sanitizeVercel(input) as typeof input;
	expect(out.payload.deployment.meta).toEqual({
		githubCommitOrg: 'acme',
		githubCommitRepo: 'api',
		githubCommitSha: fakeSha(SHA_A),
		githubCommitAuthorLogin: 'octocat',
		githubCommitAuthorName: 'Octo Cat',
		githubCommitMessage: 'Example commit message',
		githubCommitRef: 'staging',
		githubPrId: '12',
	});
	expect(out.payload.deployment.id).toBe('dpl_example1');
	expect(out.payload.project.id).toBe('prj_example1');
	expect(out.payload.team.id).toBe('team_example1');
	expect(out.payload.team.slug).toBe('acme');
	expect(out.payload.deployment.url).toBe('deployment-1.vercel.app');
	expect(out.payload.links.deployment).toBe('https://vercel.com/acme/app1/Q1w2e3');
	expect(out.payload.deployment.name).toBe('app1');
	const flat = JSON.stringify(out);
	for (const original of [
		'example-org',
		'example-team',
		'private-site',
		'someone',
		'monorepo',
		'u1234567890',
		SHA_A,
	]) {
		expect(flat).not.toContain(original);
	}
});

test('sanitizeDokploy заменяет проект, приложение, домен, коммит и текст ошибки', () => {
	const input = {
		projectName: 'secret-proj',
		applicationName: 'secret-app',
		domains: ['app.private.io'],
		commitHash: SHA_A,
		commitMessage: 'fix secret-proj',
		errorMessage: 'boom at secret-proj',
		branch: 'main',
	};
	const out = sanitizeDokploy(input);
	expect(out).toEqual({
		projectName: 'example-project-1',
		applicationName: 'example-app-1',
		domains: ['app1.example.com'],
		commitHash: fakeSha(SHA_A),
		commitMessage: 'Example commit message',
		errorMessage: 'Example error message',
		branch: 'main',
	});
});

test('sanitizeHeaders оставляет событие, отбрасывает подписи и подменяет id доставки и App', () => {
	const out = sanitizeHeaders({
		'x-github-event': 'pull_request',
		'x-github-delivery': 'real-delivery-id',
		'x-github-hook-id': '999',
		'x-github-hook-installation-target-id': '123456',
		'x-hub-signature-256': 'sha256=abc',
		'x-hub-signature': 'sha1=abc',
		'x-vercel-signature': 'deadbeef',
		'user-agent': 'GitHub-Hookshot/abc',
		'content-type': 'application/json',
	});
	expect(out['x-github-event']).toBe('pull_request');
	expect(out['x-github-hook-installation-target-id']).toBe('1000001');
	expect(out['x-github-hook-id']).toBe('1');
	expect(out['x-github-delivery']).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	expect(out['x-github-delivery']).not.toContain('real');
	expect(Object.keys(out).sort()).toEqual([
		'content-type',
		'x-github-delivery',
		'x-github-event',
		'x-github-hook-id',
		'x-github-hook-installation-target-id',
	]);
});

test('cli --capture читает метаданные и .bin, без --capture оставляет заголовки пустыми', () => {
	const dir = mkdtempSync(join(tmpdir(), 'sanitize-'));
	const meta = join(dir, '1-abcdef12.json');
	writeFileSync(meta, JSON.stringify({ headers: { 'x-github-event': 'ping' } }));
	writeFileSync(
		join(dir, '1-abcdef12.bin'),
		JSON.stringify({ sender: { login: 'someone', id: 5 } }),
	);
	const captured = JSON.parse(cli(['github', meta, '--capture']));
	expect(captured).toEqual({
		headers: { 'x-github-event': 'ping' },
		body: { sender: { login: 'octocat', id: 1 } },
	});
	const plain = join(dir, 'plain.json');
	writeFileSync(plain, JSON.stringify({ sender: { login: 'someone' } }));
	expect(JSON.parse(cli(['github', plain]))).toEqual({
		headers: {},
		body: { sender: { login: 'octocat' } },
	});
	expect(() => cli(['nope', plain])).toThrow('usage:');
});

test('разные значения получают разные замены, одинаковые — одинаковые', () => {
	const dokploy = sanitizeDokploy({
		a: { repository: 'org-one/first', owner: 'org-one', domain: 'one.private.io' },
		b: { repository: 'org-two/second', owner: 'org-two', domain: 'two.private.io' },
		c: {
			repository: 'org-one/first',
			applicationName: 'x',
			project: 'p',
			note: 'see https://host.private.io/x',
		},
	}) as Record<string, Record<string, string>>;
	expect(dokploy.a).toEqual({ repository: 'acme/api', owner: 'acme', domain: 'app1.example.com' });
	expect(dokploy.b).toEqual({
		repository: 'acme/repo2',
		owner: 'acme',
		domain: 'app2.example.com',
	});
	expect(dokploy.c).toEqual({
		repository: 'acme/api',
		applicationName: 'example-app-1',
		project: 'example-project-1',
		note: 'see https://host3.example.com/x',
	});
	const vercel = sanitizeVercel({
		a: {
			team: { id: 'tm-1', name: 'team one' },
			user: { id: 'u-1' },
			project: { name: 'site-one' },
		},
		b: {
			team: { id: 'tm-2' },
			user: { id: 'u-2' },
			project: { name: 'site-two' },
			deployment: { name: 'site-one' },
		},
		meta: { githubCommitRepo: 'r1', githubRepoId: '9001', githubCommitAuthorLogin: 'p1' },
		meta2: { githubCommitRepo: 'r2', githubRepoId: '9002', githubCommitAuthorLogin: 'p2' },
	}) as Record<string, any>;
	expect(vercel.a).toEqual({
		team: { id: 'user_example1', name: 'acme' },
		user: { id: 'user_example2' },
		project: { name: 'app1' },
	});
	expect(vercel.b.project.name).toBe('app2');
	expect(vercel.b.deployment.name).toBe('app1');
	expect(vercel.b.user.id).toBe('user_example4');
	expect(vercel.meta).toEqual({
		githubCommitRepo: 'api',
		githubRepoId: '1',
		githubCommitAuthorLogin: 'octocat',
	});
	expect(vercel.meta2).toEqual({
		githubCommitRepo: 'repo2',
		githubRepoId: '2',
		githubCommitAuthorLogin: 'octocat2',
	});
});

test('sanitizeVercel не трогает id вида dpl_/prj_/team_ в чужих полях и чистит почту', () => {
	const out = sanitizeVercel({ id: 'dpl_A1', mail: 'x@y.io', ref: 'team_Z9' }) as Record<
		string,
		string
	>;
	expect(out).toEqual({ id: 'dpl_example1', mail: 'octocat@example.com', ref: 'team_example1' });
});

test('cli без --capture и без заголовков в метаданных даёт пустые заголовки', () => {
	const dir = mkdtempSync(join(tmpdir(), 'sanitize-'));
	const meta = join(dir, '2-abcdef12.json');
	writeFileSync(meta, '{}');
	writeFileSync(join(dir, '2-abcdef12.bin'), '{}');
	expect(JSON.parse(cli(['vercel', meta, '--capture']))).toEqual({ headers: {}, body: {} });
	expect(() => cli(['github'])).toThrow('usage:');
	expect(() => cli([])).toThrow('usage:');
});
