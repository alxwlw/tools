import type { Tenant } from '../src/config.ts';
import { containsVia, type SyncDeps } from '../src/delivery/sync.ts';
import type { Pull } from '../src/github/client.ts';
import { tenantOf } from './config-fixture.ts';
import { FakeGitHub } from './fake-github.ts';
import { FakePlane } from './fake-plane.ts';

export const BASE_PULL: Pull = {
	repo: 'acme/api',
	number: 1,
	url: 'https://github.com/acme/api/pull/1',
	title: 't',
	body: '',
	head: 'h',
	base: 'main',
	draft: false,
	state: 'open',
	merged: false,
	mergeSha: null,
};
const PROJECT_IDS: Record<string, string> = {
	ENG: 'p-eng',
	OPS: 'p-ops',
	QA: 'p-qa',
	INC: 'p-inc',
};

export function world(tenant: Tenant = tenantOf()) {
	const plane = FakePlane.delivery();
	const gh = new FakeGitHub();
	const warns: Array<{ reason: string; entry: Record<string, string> }> = [];
	const github = async (repo: string) => (repo.startsWith('other/') ? null : gh);
	const deps: SyncDeps = {
		tenant,
		plane,
		github,
		projects: () => plane.listProjects(),
		states: (id) => plane.listStates(id),
		contains: containsVia(github),
		warnOnce: (reason, entry) => warns.push({ reason, entry }),
		moved: () => {},
	};
	/** A work item in `state`, linked to each `[repo, number]`; returns its id. */
	const item = (key: string, state: string, pulls: Array<[string, number]> = []) => {
		const id = plane.addWorkItem(key, state);
		const project = PROJECT_IDS[key.split('-')[0] as string] as string;
		for (const [repo, number] of pulls) {
			plane.links.push({
				id: `l-${repo}-${number}`,
				project,
				workItemId: id,
				url: `https://github.com/${repo}/pull/${number}`,
				title: `GitHub: ${repo}#${number}`,
			});
		}
		return id;
	};
	const stateOf = (id: string) => plane.workItems.find((w) => w.id === id)?.state;
	const pr = (cause: Pull | null = null, deliveryId = 'd1') => ({
		kind: 'pr' as const,
		pull: cause ?? ({ repo: 'acme/api', number: 1, url: '' } as Pull),
		deliveryId,
	});
	return { plane, gh, deps, warns, item, stateOf, pr };
}

export function tenantProjects(projects: Record<string, Record<string, string | null>>) {
	const base = tenantOf().delivery as NonNullable<Tenant['delivery']>;
	return tenantOf({ delivery: { ...base, projects } });
}
