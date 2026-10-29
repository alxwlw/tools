// The hub's GitHub parsers against what GitHub really sent (Task 1 probe, sanitized by scripts/sanitize-fixture.ts).
import { describe, expect, test } from 'bun:test';

import { createGitHubClient } from '../src/github/client.ts';
import { parseGitHubDelivery } from '../src/github/webhook.ts';
import { fixture } from './fixtures.ts';

const APP_ID = 1_000_001;

async function delivery(name: string) {
	const { headers, body } = await fixture(name);
	return {
		headers: new Headers(headers as Record<string, string>),
		raw: new TextEncoder().encode(JSON.stringify(body)),
		body,
	};
}

function clientReplying(...bodies: unknown[]) {
	const urls: string[] = [];
	const fetch = async (url: string): Promise<Response> => {
		urls.push(url);
		const body = bodies.shift();
		if (body === undefined) throw new Error(`unexpected request ${url}`);
		return new Response(JSON.stringify(body), { status: 200 });
	};
	return { urls, client: createGitHubClient({ fetch, bearer: async () => 'ghs_test' }) };
}

describe('pull_request: реальные доставки', () => {
	test('opened черновиком: draft, ветки, ссылка, номер, installation', async () => {
		const d = await delivery('github-pr-opened-draft.json');
		const event = parseGitHubDelivery(d.headers, d.raw, APP_ID);
		expect(event).toMatchObject({
			kind: 'pull_request',
			appId: APP_ID,
			installationId: 5,
			action: 'opened',
			pull: {
				repo: 'acme/api',
				number: 151,
				url: 'https://github.com/acme/api/pull/151',
				title: 'Example change (ENG-1)',
				head: 'feat/branch-1',
				base: 'main',
				draft: true,
				state: 'open',
				merged: false,
				mergeSha: null,
			},
		});
	});

	test('ready_for_review: не черновик, mergeSha у несмёрдженного — null', async () => {
		const d = await delivery('github-pr-ready.json');
		const event = parseGitHubDelivery(d.headers, d.raw, APP_ID);
		expect(event).toMatchObject({
			action: 'ready_for_review',
			pull: { draft: false, state: 'open', merged: false, mergeSha: null },
		});
	});

	test('closed смёрдженным: merged и merge_commit_sha', async () => {
		const d = await delivery('github-pr-merged.json');
		const event = parseGitHubDelivery(d.headers, d.raw, APP_ID);
		expect(event).toMatchObject({
			action: 'closed',
			pull: {
				state: 'closed',
				merged: true,
				mergeSha: '2aa525588d3fd7e899fe17a27ab5fee062f74592',
			},
		});
	});
});

describe('deployment_status: реальная доставка', () => {
	test('success: окружение, sha, создатель, время успеха, installation', async () => {
		const d = await delivery('github-deployment-status-success.json');
		const event = parseGitHubDelivery(d.headers, d.raw, APP_ID);
		expect(event).toEqual({
			kind: 'deployment_status',
			appId: APP_ID,
			deliveryId: '00000000-0000-4000-8000-000000000001',
			installationId: 6,
			deployment: {
				id: 3,
				repo: 'acme/api',
				sha: '2aa525588d3fd7e899fe17a27ab5fee062f74592',
				environment: 'probe',
				creator: 'acme-app[bot]',
				description: 'plane-hooks probe',
			},
			state: 'success',
			logUrl: null,
			at: '2026-10-29T02:27:57.000Z',
		});
	});
});

describe('ответы REST: реальные', () => {
	test('compare: ahead, три коммита с сообщениями, не truncated', async () => {
		const { client } = clientReplying((await fixture('github-compare-ahead.json')).body);
		const result = await client.compare('acme/api', 'a', 'b');
		expect(result?.status).toBe('ahead');
		expect(result?.truncated).toBe(false);
		expect(result?.commits.map((c) => c.message)).toEqual([
			'chore: example change (ENG-1)',
			'chore: example change (ENG-1)',
			'Merge pull request #1006 from acme/repo2/branch-2',
		]);
		expect(result?.commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha))).toBe(true);
	});

	test('commits/{sha}/pulls: смёрдженный PR с merge_commit_sha и ветками', async () => {
		const { client } = clientReplying((await fixture('github-commit-pulls.json')).body);
		const pulls = await client.mergedPullsForCommit('acme/api', 'x'.repeat(40));
		expect(pulls).toHaveLength(1);
		expect(pulls[0]).toMatchObject({
			repo: 'acme/api',
			number: 1006,
			title: 'Example change (ENG-1)',
			head: 'feat/branch-1',
			base: 'staging',
			state: 'closed',
			merged: true,
			mergeSha: '6032e98722f7e772f4a4b1f86fb5c3ae9d4b25c5',
		});
	});

	test('deployments: staging, создатель github-actions[bot], свежие первыми', async () => {
		const { client } = clientReplying((await fixture('github-deployments.json')).body);
		const rows = await client.listDeployments('acme/api', 'staging', 100);
		expect(rows).toHaveLength(30);
		expect(rows[0]).toMatchObject({
			id: 1,
			repo: 'acme/api',
			environment: 'staging',
			creator: 'github-actions[bot]',
		});
		expect(rows.every((r) => r.environment === 'staging' && /^[0-9a-f]{40}$/.test(r.sha))).toBe(
			true,
		);
	});
});
