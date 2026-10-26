// Adapted from apps/plane-discord/src/runtime.ts.
import type { Tenant } from './config.ts';
import { type MiroApi, MiroClient } from './miro/rest.ts';
import { botTokenAuth, type Fetch } from './plane/auth.ts';
import {
	type MemberSummary,
	type PlaneApi,
	PlaneClient,
	type ProjectSummary,
	type StateSummary,
} from './plane/client.ts';
import type { Store } from './store.ts';
import { ttl } from './ttl.ts';

export const CACHE_TTL_MS = 10 * 60_000;

/** A lookup that misses the projects cache reloads it, but not more often than this. */
export const MISS_REFRESH_MS = 30_000;

/** keyOf: the project is not in the workspace's project list (deleted, or created after the last reload). */
export class UnknownProject extends Error {
	override name = 'UnknownProject';

	constructor() {
		super('unknown project');
	}
}

export type TenantRuntime = {
	tenant: Tenant;
	plane: PlaneApi;
	miro: MiroApi;
	/**
	 * Projects without hiddenProjects and without archived ones (probe: the bot sees archived projects); cached
	 * CACHE_TTL_MS. `refresh` reloads at once, at most once per MISS_REFRESH_MS.
	 */
	projects(opts?: { refresh?: boolean }): Promise<ProjectSummary[]>;
	isHidden(projectId: string): boolean;
	/** `<identifier>-<sequenceId>` from the full (unfiltered) project list, reloaded once on a miss; throws if still unknown. */
	keyOf(projectId: string, sequenceId: number): Promise<string>;
	/** null: the project has no such state. */
	state(projectId: string, stateId: string): Promise<StateSummary | null>;
	/** Display names in the order of `ids`; ids that are not workspace members are dropped. */
	memberNames(ids: readonly string[]): Promise<string[]>;
};

export function createRuntime(
	tenant: Tenant,
	deps: {
		planeUrl: string;
		store: Store;
		fetch?: Fetch;
		now?: () => number;
		minGapMs?: number;
		plane?: PlaneApi;
		miro?: MiroApi;
	},
): TenantRuntime {
	const plane =
		deps.plane ??
		new PlaneClient({
			baseUrl: deps.planeUrl,
			workspace: tenant.workspace,
			appInstallationId: tenant.auth.appInstallationId,
			fetch: deps.fetch,
			auth: botTokenAuth({
				planeUrl: deps.planeUrl,
				clientId: tenant.auth.clientId,
				clientSecret: tenant.auth.clientSecret,
				appInstallationId: tenant.auth.appInstallationId,
				fetch: deps.fetch,
				now: deps.now,
			}),
		});
	const miro =
		deps.miro ??
		new MiroClient({
			token: () => deps.store.getMiroToken(tenant.miroTeamId),
			fetch: deps.fetch,
		});
	const now = deps.now ?? (() => Date.now());
	const minGapMs = deps.minGapMs ?? MISS_REFRESH_MS;
	const hidden = new Set(tenant.hiddenProjects);
	let loadProjects = ttl(() => plane.listProjects(), CACHE_TTL_MS, now);
	let reloadedAt = Number.NEGATIVE_INFINITY;
	const allProjects = (refresh = false): Promise<ProjectSummary[]> => {
		if (refresh && now() - reloadedAt >= minGapMs) {
			reloadedAt = now();
			loadProjects = ttl(() => plane.listProjects(), CACHE_TTL_MS, now);
		}
		return loadProjects();
	};
	const statesOf = new Map<string, () => Promise<StateSummary[]>>();
	const members = ttl<MemberSummary[]>(() => plane.listMembers(), CACHE_TTL_MS, now);
	return {
		tenant,
		plane,
		miro,
		async projects(opts) {
			return (await allProjects(opts?.refresh)).filter((p) => !p.archived && !hidden.has(p.id));
		},
		isHidden: (projectId) => hidden.has(projectId),
		async keyOf(projectId, sequenceId) {
			const known = (list: ProjectSummary[]) => list.find((p) => p.id === projectId);
			const project = known(await allProjects()) ?? known(await allProjects(true));
			if (project === undefined) throw new UnknownProject();
			return `${project.identifier}-${sequenceId}`;
		},
		async state(projectId, stateId) {
			let load = statesOf.get(projectId);
			if (load === undefined) {
				load = ttl(() => plane.listStates(projectId), CACHE_TTL_MS, now);
				statesOf.set(projectId, load);
			}
			return (await load()).find((s) => s.id === stateId) ?? null;
		},
		async memberNames(ids) {
			if (ids.length === 0) return [];
			const byId = new Map((await members()).map((m) => [m.id, m.displayName]));
			return ids.flatMap((id) => {
				const name = byId.get(id);
				return name === undefined ? [] : [name];
			});
		},
	};
}
