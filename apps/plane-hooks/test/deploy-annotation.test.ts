import { describe, expect, test } from 'bun:test';

import {
	githubRequest,
	statusPayload,
	tenantOf,
	vercelRequest,
	world,
} from './server-harness.ts';

/** One production deploy of acme/api/a1 seen twice: by GitHub's `deployment_status` and by Vercel's webhook. */
async function deployTwice(options: { vercelInput: boolean; creator: string }) {
	const base = tenantOf();
	const tenant = {
		...base,
		delivery: {
			...base.delivery!,
			repos: [{ repo: 'acme/api', environments: [{ name: 'Production', state: 'Done', release: false }] }],
		},
		inputs: { ...base.inputs, vercel: options.vercelInput ? 'vercel-secret' : null },
	};
	const w = world({ tenants: [tenant] });
	w.gh.commit('a0', [], 'init');
	w.gh.commit('a1', ['a0'], 'ENG-1 change (#1)');
	w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 change' }).mergePull('acme/api', 1, 'a1');
	w.gh.deploy('acme/api', 'Production', 'a0', 'success', options.creator);
	const id = w.gh.deploy('acme/api', 'Production', 'a1', 'success', options.creator);
	const item = w.plane.addWorkItem('ENG-1', 'In Review');
	await w.send(
		githubRequest(
			'deployment_status',
			statusPayload(
				'success',
				{ id, sha: 'a1', environment: 'Production', creator: { login: options.creator }, created_at: '2026-10-28T09:00:00Z' },
				{ created_at: '2026-10-28T10:00:00Z' },
			),
		),
	);
	if (options.vercelInput) {
		await w.send(
			vercelRequest('acme', {
				id: 'e',
				type: 'deployment.succeeded',
				createdAt: 1791281400000,
				payload: {
					project: { id: 'prj' },
					deployment: {
						id: 'dpl',
						url: 'x.vercel.app',
						name: 'api',
						meta: { githubCommitRef: 'main', githubCommitSha: 'a1', githubCommitOrg: 'acme', githubCommitRepo: 'api' },
					},
					target: 'production',
				},
			}),
		);
	}
	const moved = w.plane.commentsOf(item).some((c) => c.external_id.startsWith('state:'));
	return { w, moved, marks: w.logs.filter((line) => line.annotation === 'deploy') };
}

describe('the annotation of a deploy', () => {
	test('a Vercel production deploy is marked once when the Vercel input is on', async () => {
		const { w, moved, marks } = await deployTwice({ vercelInput: true, creator: 'vercel[bot]' });
		expect(marks).toHaveLength(1);
		expect(marks[0]?.event).not.toBe('deploy');
		// The GitHub deployment still moves the work item and writes its own line, without a mark.
		expect(moved).toBe(true);
		expect(w.lines('deploy').map((line) => [line.source, line.annotation])).toEqual([['github', undefined]]);
	});

	test('the GitHub path keeps the mark of a Vercel deploy when the Vercel input is off', async () => {
		const { moved, marks } = await deployTwice({ vercelInput: false, creator: 'vercel[bot]' });
		expect(moved).toBe(true);
		expect(marks.map((line) => [line.event, line.source])).toEqual([['deploy', 'github']]);
	});

	test('a GitHub deploy by anyone else keeps its mark when the Vercel input is on', async () => {
		const { moved, marks } = await deployTwice({ vercelInput: true, creator: 'octocat' });
		expect(moved).toBe(true);
		expect(marks.filter((line) => line.event === 'deploy').map((line) => line.source)).toEqual(['github']);
	});
});
