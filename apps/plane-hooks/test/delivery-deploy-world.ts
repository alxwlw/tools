import type { DeployFact, DeployResult } from '../src/delivery/deploy.ts';
import type { ReleaseDraft, ReleaseItem, ReleaseResult } from '../src/release.ts';
import { Store } from '../src/store.ts';
import { tenantOf } from './config-fixture.ts';
import { deliveryWorld } from './delivery-world.ts';

export const REPO = 'acme/api';

export function setup(tenant = tenantOf()) {
	const w = deliveryWorld(tenant);
	const store = new Store(':memory:');
	const real = store.cursorFor('acme');
	// Tests read the sha and seed a cursor older than every fact (`at` 10:00) unless they say otherwise.
	const cursor = {
		get: (repo: string, env: string) => real.get(repo, env)?.sha ?? null,
		set: (repo: string, env: string, sha: string, at = '2026-10-28T09:00:00.000Z') =>
			real.set(repo, env, sha, at),
	};
	const releases: Array<{ draft: ReleaseDraft; items: ReleaseItem[] }> = [];
	let releaseFailure: Error | null = null;
	const deps = {
		...w.deps,
		cursor: real,
		releases: async (draft: ReleaseDraft, items: ReleaseItem[]): Promise<ReleaseResult> => {
			releases.push({ draft, items });
			if (releaseFailure) throw releaseFailure;
			return { action: 'created', releaseId: 'r1' };
		},
	};
	return {
		...w,
		deps,
		cursor,
		releases,
		failReleaseWith: (err: Error) => {
			releaseFailure = err;
		},
	};
}

export function fact(sha: string, over: Partial<DeployFact> = {}): DeployFact {
	return {
		repo: REPO,
		environment: 'staging',
		sha,
		deploymentId: null,
		logUrl: 'https://github.com/acme/api/actions/runs/1',
		at: '2026-10-28T10:00:00.000Z',
		...over,
	};
}

/** A squash-merged PR: the commit, the PR with a key in its title, its merge. */
export function squash(
	w: ReturnType<typeof setup>,
	sha: string,
	parent: string,
	number: number,
	key: string,
) {
	w.gh.commit(sha, [parent], `${key} change (#${number})`);
	w.gh.pull({ repo: REPO, number, title: `${key} change` }).mergePull(REPO, number, sha);
}

export const keysOf = (r: DeployResult) => r.notes.map((n) => n.key);
