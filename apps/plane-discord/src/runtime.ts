import type { Tenant } from './config.ts';
import type { TenantRuntime } from './notify.ts';
import { botTokenAuth, type Fetch } from './plane/auth.ts';
import {
	type MemberSummary,
	PlaneClient,
	type ProjectSummary,
	type StateSummary,
} from './plane/client.ts';
import { userMap } from './text.ts';
import { ttl } from './ttl.ts';

export const CACHE_TTL_MS = 10 * 60_000;
/** A lookup that misses the cache refreshes it, but not more often than this: unknown ids must not hammer Plane. */
export const MISS_REFRESH_MS = 30_000;

/** A TTL cache whose refresh()-ed read reloads at once, at most once per `minGapMs`. */
function refreshable<T>(
	load: () => Promise<T>,
	now: () => number,
	minGapMs: number,
	onValue?: (value: T) => void,
): (refresh?: boolean) => Promise<T> {
	const loadAndNote = async () => {
		const value = await load();
		onValue?.(value);
		return value;
	};
	let get = ttl(loadAndNote, CACHE_TTL_MS, now);
	let reloadedAt = Number.NEGATIVE_INFINITY;
	return (refresh = false) => {
		if (refresh && now() - reloadedAt >= minGapMs) {
			reloadedAt = now();
			get = ttl(loadAndNote, CACHE_TTL_MS, now);
		}
		return get();
	};
}

export type Runtime = TenantRuntime & {
	/** The last successfully loaded projects; null while cold. Synchronous: a Discord modal has 3 s. */
	projectsCached: () => ProjectSummary[] | null;
	/** Loads projects and the bot user in the background-friendly way: one promise, rejects on the first failure. */
	warm: () => Promise<void>;
};

export function createRuntime(
	tenant: Tenant,
	options: { planeUrl: string; fetch?: Fetch; now?: () => number; minGapMs?: number },
): Runtime {
	const now = options.now ?? (() => Date.now());
	const minGapMs = options.minGapMs ?? MISS_REFRESH_MS;
	const plane = new PlaneClient({
		baseUrl: options.planeUrl,
		workspace: tenant.workspace,
		appInstallationId: tenant.auth.appInstallationId,
		fetch: options.fetch,
		auth: botTokenAuth({
			planeUrl: options.planeUrl,
			clientId: tenant.auth.clientId,
			clientSecret: tenant.auth.clientSecret,
			appInstallationId: tenant.auth.appInstallationId,
			fetch: options.fetch,
			now,
		}),
	});
	let lastProjects: ProjectSummary[] | null = null;
	const projects = refreshable(
		() => plane.listProjects(),
		now,
		minGapMs,
		(value) => {
			lastProjects = value;
		},
	);
	const statesByProject = new Map<string, (refresh?: boolean) => Promise<StateSummary[]>>();
	const states = (projectId: string, opts?: { refresh?: boolean }) => {
		let cache = statesByProject.get(projectId);
		if (cache === undefined) {
			cache = refreshable(() => plane.listStates(projectId), now, minGapMs);
			statesByProject.set(projectId, cache);
		}
		return cache(opts?.refresh);
	};
	const members = ttl<MemberSummary[]>(() => plane.listMembers(), CACHE_TTL_MS, now);
	return {
		tenant,
		plane,
		users: userMap(tenant.users),
		projects: (opts) => projects(opts?.refresh),
		states,
		members,
		projectsCached: () => lastProjects,
		async warm() {
			await Promise.all([plane.botUserId(), projects(true)]);
		},
	};
}
