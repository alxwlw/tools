import type { Tenant } from '../src/config.ts';
import { containsVia, type SyncDeps } from '../src/delivery/sync.ts';
import { tenantOf } from './config-fixture.ts';
import { FakeGitHub } from './fake-github.ts';
import { FakePlane } from './fake-plane.ts';

const PROJECT_IDS: Record<string, string> = {
	ENG: 'p-eng',
	OPS: 'p-ops',
	QA: 'p-qa',
	INC: 'p-inc',
};

/** FakePlane + FakeGitHub + SyncDeps of the `acme` tenant; no App covers repos under `other/`. */
export function deliveryWorld(tenant: Tenant = tenantOf()) {
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
	};
	/** A work item in `state`; returns its id. */
	const item = (key: string, state: string) => plane.addWorkItem(key, state);
	const stateOf = (id: string) => plane.workItems.find((w) => w.id === id)?.state;
	const linksOf = (id: string) => plane.links.filter((l) => l.workItemId === id);
	/** The ids of a work item's comments' external ids, in creation order. */
	const commentIds = (id: string) => plane.commentsOf(id).map((c) => c.external_id);
	return { plane, gh, deps, warns, item, stateOf, linksOf, commentIds, projectIds: PROJECT_IDS };
}
