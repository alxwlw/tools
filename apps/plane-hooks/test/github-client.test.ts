import { describe, expect, test } from 'bun:test';

import { createGitHubClient, GitHubApiError } from '../src/github/client.ts';
import {
	compareBody,
	compareCommit,
	deploymentBody,
	deploymentStatusBody,
	mergedPullBody,
	pullBody,
	pullRow,
} from './github-bodies.ts';

type Reply = { status: number; body?: unknown; raw?: string };
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

const API = 'https://api.github.com';

function stub(replies: Reply[]) {
	const calls: Call[] = [];
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({
			url,
			method: init.method ?? 'GET',
			headers: init.headers as Record<string, string>,
			body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
		});
		const reply = replies.shift();
		if (!reply) throw new Error(`unexpected request ${init.method} ${url}`);
		const text = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
		return new Response(text, { status: reply.status });
	};
	const client = createGitHubClient({ fetch, bearer: async () => 'ghs_test' });
	return { calls, client };
}

function commits(from: number, to: number) {
	return Array.from({ length: to - from }, (_, i) =>
		compareCommit(String(from + i).padStart(40, '0'), `commit ${from + i}`),
	);
}

describe('getPull', () => {
	test('getPull: 404 — null; поля из ответа, mergeSha — merge_commit_sha только у смёрдженного', async () => {
		const { calls, client } = stub([
			{ status: 404, body: { message: 'Not Found' } },
			{ status: 200, body: pullBody({ draft: true }) },
			{ status: 200, body: mergedPullBody() },
		]);
		expect(await client.getPull('acme/api', 99)).toBeNull();

		expect(await client.getPull('acme/api', 12)).toEqual({
			repo: 'acme/api',
			number: 12,
			url: 'https://github.com/acme/api/pull/12',
			title: 'Add retry to the uploader',
			body: 'Closes ENG-7',
			head: 'eng-7-retry',
			base: 'main',
			draft: true,
			state: 'open',
			merged: false,
			mergeSha: null, // the body carries a test-merge merge_commit_sha
		});

		const merged = await client.getPull('acme/api', 12);
		expect(merged).toMatchObject({ state: 'closed', merged: true, mergeSha: 'd'.repeat(40) });

		expect(calls[0]).toMatchObject({ method: 'GET', url: `${API}/repos/acme/api/pulls/99` });
		expect(calls[0]?.headers).toMatchObject({
			Authorization: 'Bearer ghs_test',
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'plane-hooks',
		});
	});

	test('getPull: пустое тело PR — пустая строка, не null', async () => {
		const { client } = stub([{ status: 200, body: pullBody({ body: null }) }]);
		expect((await client.getPull('acme/api', 12))?.body).toBe('');
	});

	test('getPull: ответ без заголовка — ошибка формы, без значений в сообщении', async () => {
		const { client } = stub([{ status: 200, body: pullBody({ title: 7 }) }]);
		await expect(client.getPull('acme/api', 12)).rejects.toThrow('pull.title is not a string');
	});

	test('не-JSON в 2xx — ошибка', async () => {
		const { client } = stub([{ status: 200, raw: '<html>' }]);
		await expect(client.getPull('acme/api', 12)).rejects.toThrow('response is not JSON');
	});
});

describe('списки PR', () => {
	test('mergedPullsForCommit отбрасывает несмёрдженные', async () => {
		const sha = 'd'.repeat(40);
		const { calls, client } = stub([
			{
				status: 200,
				body: [
					pullRow({ number: 1, state: 'open' }),
					pullRow({ number: 2, state: 'closed' }),
					pullRow({
						number: 3,
						state: 'closed',
						merged_at: '2026-10-20T10:00:00Z',
						merge_commit_sha: sha,
					}),
				],
			},
		]);
		const pulls = await client.mergedPullsForCommit('acme/api', sha);
		expect(pulls.map((p) => [p.number, p.merged, p.mergeSha])).toEqual([[3, true, sha]]);
		expect(calls[0]?.url).toBe(`${API}/repos/acme/api/commits/${sha}/pulls?per_page=100`);
	});

	test('openPullsForBranch шлёт head=<owner>:<branch>', async () => {
		const { calls, client } = stub([{ status: 200, body: [pullRow({ number: 5 })] }]);
		const pulls = await client.openPullsForBranch('acme/api', 'eng-7/retry');
		expect(pulls.map((p) => p.number)).toEqual([5]);
		const url = new URL(calls[0]?.url as string);
		expect(url.pathname).toBe('/repos/acme/api/pulls');
		expect(url.searchParams.get('head')).toBe('acme:eng-7/retry');
		expect(url.searchParams.get('state')).toBe('open');
	});
});

describe('getCommit', () => {
	test('getCommit: sha и сообщение; 404 и 422 — null; 500 — ошибка', async () => {
		const sha = 'b'.repeat(40);
		const { calls, client } = stub([
			{ status: 200, body: compareCommit(sha, 'ENG-4 hotfix\n\nbody') },
			{ status: 404, body: { message: 'Not Found' } },
			{ status: 422, body: { message: 'No commit found for SHA' } },
			{ status: 500, body: { message: 'boom' } },
		]);
		expect(await client.getCommit('acme/api', sha)).toEqual({
			sha,
			message: 'ENG-4 hotfix\n\nbody',
		});
		expect(calls[0]?.url).toBe(`${API}/repos/acme/api/commits/${sha}`);
		expect(await client.getCommit('acme/api', 'gone')).toBeNull();
		expect(await client.getCommit('acme/api', 'gone')).toBeNull();
		await expect(client.getCommit('acme/api', 'x')).rejects.toThrow('→ 500');
	});

	test('getCommit: ответ без сообщения — ошибка формы', async () => {
		const { client } = stub([{ status: 200, body: { sha: 'abc', commit: {} } }]);
		await expect(client.getCommit('acme/api', 'abc')).rejects.toThrow('message is not a string');
	});
});

describe('compare', () => {
	test('compare: 422 (sha исчез) — null, как 404', async () => {
		const { client } = stub([{ status: 422, body: { message: 'No common ancestor' } }]);
		expect(await client.compare('acme/api', 'gone', 'x')).toBeNull();
	});

	test('compare: 500 — ошибка, не null', async () => {
		const { client } = stub([{ status: 500, body: { message: 'boom' } }]);
		await expect(client.compare('acme/api', 'a', 'b')).rejects.toThrow('→ 500');
	});

	test('compare: статусы и коммиты; 404 — null', async () => {
		const { calls, client } = stub([
			{ status: 200, body: compareBody('ahead', commits(1, 4)) },
			{ status: 200, body: compareBody('behind', []) },
			{ status: 200, body: compareBody('identical', []) },
			{ status: 200, body: compareBody('diverged', commits(5, 6)) },
			{ status: 404, body: { message: 'Not Found' } },
		]);
		const ahead = await client.compare('acme/api', 'main', 'eng-7');
		expect(ahead).toEqual({
			status: 'ahead',
			commits: [
				{ sha: `${'0'.repeat(39)}1`, message: 'commit 1' },
				{ sha: `${'0'.repeat(39)}2`, message: 'commit 2' },
				{ sha: `${'0'.repeat(39)}3`, message: 'commit 3' },
			],
			truncated: false,
		});
		expect((await client.compare('acme/api', 'main', 'eng-7'))?.status).toBe('behind');
		expect((await client.compare('acme/api', 'main', 'main'))?.status).toBe('identical');
		expect((await client.compare('acme/api', 'main', 'x'))?.status).toBe('diverged');
		expect(await client.compare('acme/api', 'gone', 'x')).toBeNull();
		expect(calls[0]?.url).toBe(`${API}/repos/acme/api/compare/main...eng-7?per_page=100&page=1`);
	});

	test('compare: 250 коммитов и total_commits 300 — truncated', async () => {
		const total = { total_commits: 300 };
		const { calls, client } = stub([
			{ status: 200, body: compareBody('ahead', commits(0, 100), total) },
			{ status: 200, body: compareBody('ahead', commits(100, 200), total) },
			{ status: 200, body: compareBody('ahead', commits(200, 250), total) },
		]);
		const result = await client.compare('acme/api', 'a', 'b');
		expect(result?.commits).toHaveLength(250);
		expect(result?.truncated).toBe(true);
		expect(calls.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2', '3']);
	});

	test('compare: 150 коммитов из total_commits 150 — две страницы, не truncated', async () => {
		const total = { total_commits: 150 };
		const { calls, client } = stub([
			{ status: 200, body: compareBody('ahead', commits(0, 100), total) },
			{ status: 200, body: compareBody('ahead', commits(100, 150), total) },
		]);
		const result = await client.compare('acme/api', 'a', 'b');
		expect(result?.commits).toHaveLength(150);
		expect(result?.truncated).toBe(false);
		expect(calls).toHaveLength(2);
	});

	test('compare: неизвестный status — ошибка', async () => {
		const { client } = stub([{ status: 200, body: compareBody('sideways', []) }]);
		await expect(client.compare('acme/api', 'a', 'b')).rejects.toThrow('unexpected shape');
	});
});

describe('deployments', () => {
	test('listDeployments идёт по страницам до limit, environment в запросе', async () => {
		const page = (from: number, to: number) =>
			Array.from({ length: to - from }, (_, i) => deploymentBody({ id: 1000 - from - i }));
		const { calls, client } = stub([
			{ status: 200, body: page(0, 100) },
			{ status: 200, body: page(100, 200) },
		]);
		const rows = await client.listDeployments('acme/api', 'staging', 150);
		expect(rows).toHaveLength(150);
		expect(rows[0]).toEqual({
			id: 1000,
			repo: 'acme/api',
			sha: 'e'.repeat(40),
			environment: 'production',
			creator: 'github-actions[bot]',
			description: 'Deploy main',
		});
		expect(rows[149]?.id).toBe(851);
		expect(calls.map((c) => c.url)).toEqual([
			`${API}/repos/acme/api/deployments?environment=staging&per_page=100&page=1`,
			`${API}/repos/acme/api/deployments?environment=staging&per_page=100&page=2`,
		]);
	});

	test('listDeployments: creator null (удалённый аккаунт) — пустая строка', async () => {
		const { client } = stub([
			{ status: 200, body: [deploymentBody({ id: 4, creator: null }), deploymentBody({ id: 3 })] },
		]);
		const found = await client.listDeployments('acme/api', 'production', 10);
		expect(found.map((d) => [d.id, d.creator])).toEqual([
			[4, ''],
			[3, 'github-actions[bot]'],
		]);
	});

	test('listDeployments: неполная страница — конец, limit меньше страницы обрезает', async () => {
		const { calls, client } = stub([
			{
				status: 200,
				body: [deploymentBody({ id: 3 }), deploymentBody({ id: 2, description: null })],
			},
		]);
		expect((await client.listDeployments('acme/api', 'production', 100)).map((d) => d.id)).toEqual([
			3, 2,
		]);
		const more = stub([
			{
				status: 200,
				body: [deploymentBody({ id: 3 }), deploymentBody({ id: 2, description: null })],
			},
		]);
		const one = await more.client.listDeployments('acme/api', 'production', 1);
		expect(one.map((d) => d.id)).toEqual([3]);
		expect(calls).toHaveLength(1);
	});

	test('latestState: состояние первой строки, пустой список — null', async () => {
		const { calls, client } = stub([
			{ status: 200, body: [deploymentStatusBody('in_progress')] },
			{ status: 200, body: [] },
		]);
		expect(await client.latestState('acme/api', 501)).toBe('in_progress');
		expect(await client.latestState('acme/api', 502)).toBeNull();
		expect(calls[0]?.url).toBe(`${API}/repos/acme/api/deployments/501/statuses?per_page=1`);
	});

	test('latestState: неизвестное состояние — ошибка', async () => {
		const { client } = stub([{ status: 200, body: [deploymentStatusBody('exploded')] }]);
		await expect(client.latestState('acme/api', 501)).rejects.toThrow('unexpected shape');
	});

	test('createDeployment: auto_merge false, required_contexts [], production_environment для production', async () => {
		const { calls, client } = stub([
			{ status: 201, body: deploymentBody({ id: 601 }) },
			{ status: 201, body: deploymentBody({ id: 602, environment: 'staging' }) },
		]);
		const sha = 'f'.repeat(40);
		expect(
			await client.createDeployment('acme/api', {
				sha,
				environment: 'production',
				description: 'Deploy via hub',
			}),
		).toBe(601);
		expect(
			await client.createDeployment('acme/api', {
				sha,
				environment: 'staging',
				description: 'Deploy via hub',
			}),
		).toBe(602);
		expect(calls[0]).toMatchObject({ method: 'POST', url: `${API}/repos/acme/api/deployments` });
		expect(calls[0]?.headers['Content-Type']).toBe('application/json');
		expect(calls[0]?.body).toEqual({
			ref: sha,
			environment: 'production',
			description: 'Deploy via hub',
			auto_merge: false,
			required_contexts: [],
			production_environment: true,
		});
		expect(calls[1]?.body).toMatchObject({ environment: 'staging', production_environment: false });
	});

	test('createDeploymentStatus: log_url только когда он есть', async () => {
		const { calls, client } = stub([
			{ status: 201, body: deploymentStatusBody('success') },
			{ status: 201, body: deploymentStatusBody('failure') },
		]);
		await client.createDeploymentStatus('acme/api', 601, 'success', 'https://example.com/logs/1');
		await client.createDeploymentStatus('acme/api', 601, 'failure', null);
		expect(calls[0]).toMatchObject({
			method: 'POST',
			url: `${API}/repos/acme/api/deployments/601/statuses`,
			body: { state: 'success', log_url: 'https://example.com/logs/1' },
		});
		expect(calls[1]?.body).toEqual({ state: 'failure' });
	});
});

describe('ошибки', () => {
	test('не-2xx — GitHubApiError без тела ответа', async () => {
		const { client } = stub([
			{ status: 403, body: { message: 'secret-detail Resource not accessible' } },
		]);
		const error = await client.getPull('acme/api', 12).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(GitHubApiError);
		const apiError = error as GitHubApiError;
		expect([apiError.status, apiError.method, apiError.path]).toEqual([
			403,
			'GET',
			'/repos/acme/api/pulls/12',
		]);
		expect(apiError.message).not.toContain('secret-detail');
	});

	test('путь в ошибке без query', async () => {
		const { client } = stub([{ status: 500 }]);
		await expect(client.openPullsForBranch('acme/api', 'x')).rejects.toMatchObject({
			path: '/repos/acme/api/pulls',
		});
	});
});

describe('границы и форма ответа', () => {
	test.each(['success', 'failure', 'error', 'inactive', 'in_progress', 'queued', 'pending'])(
		'latestState принимает состояние %s',
		async (state) => {
			const { client } = stub([{ status: 200, body: [deploymentStatusBody(state)] }]);
			expect(await client.latestState('acme/api', 501)).toBe(state);
		},
	);

	test('неизвестные status и state называют метод и ресурс', async () => {
		const { client } = stub([
			{ status: 200, body: compareBody('sideways', []) },
			{ status: 200, body: [deploymentStatusBody('exploded')] },
		]);
		await expect(client.compare('acme/api', 'a', 'b')).rejects.toThrow(
			'GitHub GET compare: unexpected shape (status)',
		);
		await expect(client.latestState('acme/api', 501)).rejects.toThrow(
			'GitHub GET statuses: unexpected shape (state)',
		);
	});

	test('GitHubApiError — имя класса в name', async () => {
		const { client } = stub([{ status: 500 }]);
		const error = await client.getPull('acme/api', 1).then(
			() => null,
			(e: unknown) => e,
		);
		expect((error as GitHubApiError).name).toBe('GitHubApiError');
	});

	test('запрос обрывается по таймауту', async () => {
		const fetch = (_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
			});
		const client = createGitHubClient({ fetch, bearer: async () => 't', timeoutMs: 20 });
		const error = await client.getPull('acme/api', 1).then(
			() => null,
			(e: unknown) => e,
		);
		expect((error as Error).name).toBe('TimeoutError');
	});

	test('404 с не-JSON телом — null, пустое тело 2xx — успех', async () => {
		const { client } = stub([{ status: 404, raw: '<html>not found</html>' }, { status: 201 }]);
		expect(await client.getPull('acme/api', 1)).toBeNull();
		await client.createDeploymentStatus('acme/api', 1, 'success', null);
	});

	test('PR без body и с неверной формой полей', async () => {
		const { body: _body, ...noBody } = pullBody();
		const cases: [unknown, string][] = [
			[noBody, ''],
			[pullBody({ state: 'merged' }), 'pull.state unknown'],
			[pullBody({ number: '12' }), 'pull.number is not an integer'],
			[pullBody({ number: 1.5 }), 'pull.number is not an integer'],
			[pullBody({ body: 5 }), 'pull.body is not a string'],
			[[pullBody()], 'pull is not an object'],
		];
		const { client } = stub(cases.map(([body]) => ({ status: 200, body })));
		for (const [, expected] of cases) {
			const result = client.getPull('acme/api', 12);
			if (expected === '') expect((await result)?.body).toBe('');
			else await expect(result).rejects.toThrow(expected);
		}
	});

	test('список PR не массив — ошибка формы', async () => {
		const { client } = stub([{ status: 200, body: pullBody() }]);
		await expect(client.mergedPullsForCommit('acme/api', 'abc')).rejects.toThrow(
			'pulls is not an array',
		);
	});

	test('mergedPullsForCommit: sha исчез (404 или 422) — пустой список, не ошибка', async () => {
		const { client } = stub([
			{ status: 404, body: { message: 'Not Found' } },
			{ status: 422, body: { message: 'No commit found for SHA' } },
		]);
		expect(await client.mergedPullsForCommit('acme/api', 'gone')).toEqual([]);
		expect(await client.mergedPullsForCommit('acme/api', 'gone')).toEqual([]);
	});

	test('mergedPullsForCommit: 500 — ошибка', async () => {
		const { client } = stub([{ status: 500, body: { message: 'boom' } }]);
		await expect(client.mergedPullsForCommit('acme/api', 'abc')).rejects.toThrow('→ 500');
	});

	test('openPullsForBranch просит страницу в 100', async () => {
		const { calls, client } = stub([{ status: 200, body: [] }]);
		await client.openPullsForBranch('acme/api', 'x');
		expect(new URL(calls[0]?.url as string).searchParams.get('per_page')).toBe('100');
	});

	test('compare: полная страница из 100 при total_commits 100 — один запрос', async () => {
		const { calls, client } = stub([{ status: 200, body: compareBody('ahead', commits(0, 100)) }]);
		const result = await client.compare('acme/api', 'a', 'b');
		expect([result?.commits.length, result?.truncated, calls.length]).toEqual([100, false, 1]);
	});

	test('compare: неполная страница при большем total_commits — стоп, truncated', async () => {
		const { calls, client } = stub([
			{ status: 200, body: compareBody('ahead', commits(0, 40), { total_commits: 300 }) },
		]);
		const result = await client.compare('acme/api', 'a', 'b');
		expect([result?.commits.length, result?.truncated, calls.length]).toEqual([40, true, 1]);
	});

	test('listDeployments: limit равен полной странице — один запрос', async () => {
		const full = Array.from({ length: 100 }, (_, i) => deploymentBody({ id: 100 - i }));
		const { calls, client } = stub([{ status: 200, body: full }]);
		expect(await client.listDeployments('acme/api', 'production', 100)).toHaveLength(100);
		expect(calls).toHaveLength(1);
	});
});
