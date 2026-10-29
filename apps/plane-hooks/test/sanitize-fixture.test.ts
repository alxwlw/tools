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

test('sanitizeGithub заменяет homepage репозитория', () => {
	const out = sanitizeGithub({
		repository: {
			full_name: 'example-org/monorepo',
			homepage: 'https://landing.vercel.app',
			description: null,
		},
		other: { homepage: null },
		empty: { homepage: '' },
	}) as any;
	expect(out.repository.homepage).toBe('https://example.com');
	expect(out.other.homepage).toBeNull();
	expect(out.empty.homepage).toBe('');
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
	expect(out.payload.links.deployment).toBe('https://vercel.com/acme/app1/deployment1');
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

test('sanitizeGithub оставляет логины ботов', () => {
	const out = JSON.stringify(
		sanitizeGithub({
			repository: { full_name: 'example-org/monorepo' },
			deployment: { creator: { login: 'vercel[bot]' } },
			status: { creator: { login: 'github-actions[bot]' } },
			sender: { login: 'someone' },
		}),
	);
	expect(out).toContain('vercel[bot]');
	expect(out).toContain('github-actions[bot]');
	expect(out).not.toContain('someone');
});

test('sanitizeGithub чистит имена людей, организацию в ветке и неизвестные репозитории в URL', () => {
	const out = sanitizeGithub({
		repository: { full_name: 'example-org/monorepo' },
		commits: [{ author: { name: 'Real Person' }, committer: { name: 'Real Committer' } }],
		pusher: { name: 'Real Pusher' },
		pull_request: {
			head: { ref: 'feat/Example-Org-thing' },
			url: 'https://api.github.com/repos/example-org/hidden-repo/pulls/3',
		},
	}) as any;
	const flat = JSON.stringify(out);
	for (const original of [
		'Real Person',
		'Real Committer',
		'Real Pusher',
		'Example-Org',
		'hidden-repo',
	]) {
		expect(flat).not.toContain(original);
	}
	expect(out.pull_request.head.ref).toBe('feat/acme-thing');
	expect(out.pull_request.url).toBe('https://api.github.com/repos/acme/repo2/pulls/3');
	expect(out.commits[0].author.name).toBe('Octo Cat');
});

test('sanitizeVercel даёт разным dpl_ id разные замены', () => {
	const out = sanitizeVercel({ a: 'dpl_aaa', b: 'dpl_bbb', c: 'dpl_aaa' }) as Record<
		string,
		string
	>;
	expect(out).toEqual({ a: 'dpl_example1', b: 'dpl_example2', c: 'dpl_example1' });
});

test('sanitizeGithub не включает .git и точку в конце предложения в имя репозитория', () => {
	const out = sanitizeGithub({
		repository: {
			full_name: 'example-org/monorepo',
			clone_url: 'https://github.com/example-org/monorepo.git',
		},
		note: 'see example-org/monorepo.',
	}) as any;
	expect(out.repository.full_name).toBe('acme/api');
	expect(out.repository.clone_url).toBe('https://github.com/acme/api.git');
	expect(out.note).toBe('see acme/api.');
});

// Ответы API (compare, deployments, pulls) не несут `full_name`: владелец приходит из опций.
test('sanitizeGithub с repos заменяет владельца в ответе API без full_name', () => {
	const out = JSON.stringify(
		sanitizeGithub(
			{
				url: 'https://api.github.com/repos/example-org/monorepo/compare/a...b',
				base: { label: 'example-org:main' },
			},
			{ repos: ['example-org/monorepo'] },
		),
	);
	expect(out).toContain('https://api.github.com/repos/acme/api/compare/a...b');
	expect(out).toContain('acme:main');
	expect(out).not.toContain('example-org');
	expect(out).not.toContain('monorepo');
});

test('sanitizeGithub с apps заменяет слаг приватного GitHub App и оставляет [bot]', () => {
	const out = JSON.stringify(
		sanitizeGithub(
			{
				repository: { full_name: 'example-org/monorepo' },
				creator: { login: 'secret-hooks[bot]', html_url: 'https://github.com/apps/secret-hooks' },
				app: { slug: 'secret-hooks', name: 'secret-hooks' },
			},
			{ apps: ['secret-hooks'] },
		),
	);
	expect(out).toContain('acme-app[bot]');
	expect(out).toContain('https://github.com/apps/acme-app');
	expect(out).not.toContain('secret-hooks');
});

test('sanitizeGithub заменяет короткий sha, у которого в документе есть полный', () => {
	const out = sanitizeGithub({
		sha: SHA_A,
		description: `работает ${SHA_A.slice(0, 7)}, не ${SHA_B.slice(0, 7)}`,
		url: `https://x/compare/${SHA_A.slice(0, 7)}...${SHA_B}`,
	}) as { sha: string; description: string; url: string };
	const fakeA = fakeSha(SHA_A);
	expect(out.sha).toBe(fakeA);
	expect(out.description).toBe(`работает ${fakeA.slice(0, 7)}, не ${fakeSha(SHA_B).slice(0, 7)}`);
	expect(out.url).toBe(`https://x/compare/${fakeA.slice(0, 7)}...${fakeSha(SHA_B)}`);
});

test('sanitizeGithub с redactText прячет тексты, имена файлов и ветки, оставляя ключи задач', () => {
	const input = {
		repository: { full_name: 'example-org/monorepo' },
		pull_request: {
			title: 'secret feature (DX-14)',
			body: 'private details, see LW-16 and DX-14',
			head: { ref: 'feat-cld/secret-branch', label: 'example-org:feat-cld/secret-branch' },
			base: { ref: 'main' },
		},
		commits: [
			{ commit: { message: 'secret change (DX-14)\n\nCo-Authored-By: Someone' } },
			{ commit: { message: 'Merge pull request #7 from example-org/feat-cld/secret-branch' } },
			{ commit: { message: 'secret keyless change' } },
		],
		files: [
			{
				filename: 'secret/path.md',
				previous_filename: 'secret/old.md',
				blob_url: 'https://github.com/example-org/monorepo/blob/abc/secret/path.md',
				patch: '@@ secret @@',
			},
			{ filename: 'secret/other.md', status: 'added' },
		],
		workflow_run: { display_title: 'secret feature (DX-14)' },
		milestone: null,
		draft: true,
	};
	const out = sanitizeGithub(input, { redactText: true }) as any;
	const text = JSON.stringify(out);
	expect(text).not.toContain('secret');
	expect(text).not.toContain('private');
	expect(out.milestone).toBeNull();
	expect(out.draft).toBe(true);
	expect(out.pull_request.title).toBe('Example change (ENG-1)');
	expect(out.pull_request.body).toBe('Example description (ENG-2 ENG-1)');
	expect(out.workflow_run.display_title).toBe('Example change (ENG-1)');
	expect(out.pull_request.head.ref).toBe('feat/branch-1');
	expect(out.pull_request.head.label).toBe('acme:feat/branch-1');
	expect(out.pull_request.base.ref).toBe('main');
	expect(out.commits[0].commit.message).toBe('chore: example change (ENG-1)');
	expect(out.commits[1].commit.message).toMatch(/^Merge pull request #7 from /);
	expect(out.files[0].filename).toBe('src/file-1.md');
	expect(out.files[1].filename).toBe('src/file-2.md');
	expect(out.files[0].previous_filename).toBe('src/old-1.md');
	expect(out.files[0]).not.toHaveProperty('patch');
	expect(out.files[0].blob_url).toBe('https://github.com/acme/api/blob/abc/src/file-1.md');
	expect(out.files[1].filename).toBe('src/file-2.md');
	expect(out.commits[2].commit.message).toBe('chore: example change');
	expect(out.files[1].status).toBe('added');
	// Без redactText тексты остаются как были.
	expect((sanitizeGithub(input) as any).pull_request.title).toBe('secret feature (DX-14)');
});

test('cli передаёт --repo, --app и --redact-text в sanitizeGithub', () => {
	const dir = mkdtempSync(join(tmpdir(), 'sanitize-'));
	const file = join(dir, 'api.json');
	writeFileSync(
		file,
		JSON.stringify({
			url: 'https://api.github.com/repos/example-org/monorepo/x',
			title: 'secret',
			bot: 'other-hooks',
		}),
	);
	const out = JSON.parse(
		cli([
			'github',
			file,
			'--repo',
			'example-org/monorepo',
			'--app',
			'secret-hooks',
			'--app',
			'other-hooks',
			'--redact-text',
		]),
	);
	expect(out.body).toEqual({
		url: 'https://api.github.com/repos/acme/api/x',
		title: 'Example change',
		bot: 'acme-app',
	});
});

test('sanitizeVercel заменяет имя проекта на уровне payload и приватную ветку feat-cld', () => {
	const out = sanitizeVercel({
		payload: {
			name: 'private-site',
			deployment: {
				name: 'private-site',
				meta: { githubCommitRef: 'feat-cld/secret-thing', githubPrId: '9' },
			},
		},
	}) as any;
	expect(out.payload.name).toBe('app1');
	expect(out.payload.deployment.name).toBe('app1');
	expect(out.payload.deployment.meta.githubCommitRef).toBe('feat/branch-1');
	expect(out.payload.deployment.meta.githubPrId).toBe('9');
});

test('sanitizeGithub заменяет хосты *.vercel.app, sanitizeDokploy — id в пути buildLink', () => {
	const gh = sanitizeGithub({
		a: 'https://secret-abc123-team.vercel.app/x',
		b: 'secret-abc123-team.vercel.app',
		c: 'https://other-site.vercel.app',
	}) as any;
	expect(gh).toEqual({
		a: 'https://deployment-1.vercel.app/x',
		b: 'deployment-1.vercel.app',
		c: 'https://deployment-2.vercel.app',
	});
	const dk = sanitizeDokploy({
		buildLink:
			'https://dok.private.io/dashboard/project/AbC_1/environment/Env-2/services/compose/Svc9?tab=deployments',
	}) as any;
	expect(dk.buildLink).toBe(
		'https://host1.example.com/dashboard/project/id1/environment/id2/services/compose/id3?tab=deployments',
	);
});

test('sanitizeGithub убирает подпись и текст коммита из verification, даже без redactText', () => {
	const input = {
		repository: { full_name: 'example-org/monorepo' },
		commit: {
			message: 'secret msg',
			verification: {
				verified: true,
				reason: 'valid',
				signature: '-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----',
				payload: 'tree 0123\nauthor Someone\n\nsecret msg',
			},
		},
	};
	for (const options of [{ redactText: true }, {}]) {
		const out = sanitizeGithub(input, options) as any;
		expect(out.commit.verification).toEqual({
			verified: true,
			reason: 'valid',
			signature: null,
			payload: null,
		});
		expect(JSON.stringify(out)).not.toContain('PGP');
		expect(JSON.stringify(out)).not.toContain('tree 0123');
	}
	expect(JSON.stringify(sanitizeGithub(input, { redactText: true }))).not.toContain('secret');
});

test('sanitizeGithub заменяет id деплоя и статуса в ссылках тем же номером, что и id объекта', () => {
	const base = 'https://api.github.com/repos/example-org/monorepo';
	const out = sanitizeGithub({
		url: `${base}/deployments/7123456789/statuses/20123456789`,
		id: 20123456789,
		deployment_url: `${base}/deployments/7123456789`,
		deployment: {
			url: `${base}/deployments/7123456789`,
			id: 7123456789,
			statuses_url: `${base}/deployments/7123456789/statuses`,
		},
		repository: { full_name: 'example-org/monorepo' },
	}) as any;
	const { id: statusId } = out;
	const { id: deploymentId } = out.deployment;
	expect(statusId).not.toBe(deploymentId);
	const api = 'https://api.github.com/repos/acme/api';
	expect(out.url).toBe(`${api}/deployments/${deploymentId}/statuses/${statusId}`);
	expect(out.deployment_url).toBe(`${api}/deployments/${deploymentId}`);
	expect(out.deployment.url).toBe(`${api}/deployments/${deploymentId}`);
	expect(out.deployment.statuses_url).toBe(`${api}/deployments/${deploymentId}/statuses`);
	expect(JSON.stringify(out)).not.toMatch(/\d{6,}/);
});

test('sanitizeGithub нумерует id по порядку полей id, а не по порядку ссылок', () => {
	const out = sanitizeGithub({
		deployment_url: 'https://api.github.com/repos/example-org/monorepo/deployments/7123456789',
		size: 77,
		creator: { id: 41234567 },
		deployment: { id: 7123456789 },
		repository: { full_name: 'example-org/monorepo' },
	}) as any;
	expect(out.creator.id).toBe(1);
	expect(out.deployment.id).toBe(2);
	expect(out.deployment_url).toBe('https://api.github.com/repos/acme/api/deployments/2');
});

test('sanitizeHeaders даёт x-github-delivery фиктивный UUID', () => {
	expect(sanitizeHeaders({ 'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958' })).toEqual({
		'x-github-delivery': '00000000-0000-4000-8000-000000000001',
	});
});

test('sanitizeVercel нумерует id вебхука и id деплоя в ссылках', () => {
	const out = sanitizeVercel({
		id: 'aB3dE5gH7jK9mN1pQ3sT5',
		payload: {
			deployment: { inspectorUrl: 'https://vercel.com/team-a/site/EEzb2uAbC' },
			links: { deployment: 'https://vercel.com/team-a/site/EEzb2uAbC' },
		},
	}) as any;
	expect(out.id).toBe('evt_example1');
	expect(out.payload.deployment.inspectorUrl).toBe('https://vercel.com/acme/app1/deployment1');
	expect(out.payload.links.deployment).toBe('https://vercel.com/acme/app1/deployment1');
});
