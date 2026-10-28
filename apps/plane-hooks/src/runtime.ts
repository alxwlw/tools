import { botTokenAuth, type Fetch } from '@alxwlw/plane-app';

import type { GitHubAppConfig, ServiceConfig, SilenceInput, Tenant } from './config.ts';
import type { DeployDeps } from './delivery/deploy.ts';
import { createGitHubApp, type GitHubApp } from './github/app.ts';
import type { GitHubApi } from './github/client.ts';
import {
	createIncidentReporter,
	IncidentProjectMissing,
	type IncidentReporter,
	resolveIncidentProject,
} from './incident.ts';
import { runJob } from './jobs.ts';
import type { Log } from './log.ts';
import {
	PLANE_HOOKS_SCOPES,
	type PlaneApi,
	PlaneClient,
	type ProjectSummary,
	type StateSummary,
} from './plane.ts';
import { SerialQueue } from './queue.ts';
import { publishRelease } from './release.ts';
import type { InboxJob, Store } from './store.ts';
import { ttl } from './ttl.ts';

/** Projects, states, the incident project and App installations are reloaded after this long. */
export const CACHE_TTL_MS = 10 * 60_000;

/** The inbox kinds and the normalised event each one carries as its payload. */
export type JobKind = 'github' | 'vercel.preview' | 'vercel.deploy' | 'dokploy.deployed';

export type TenantRuntime = {
	tenant: Tenant;
	plane: PlaneApi;
	/** The tenant's deliveries run one at a time, in the order they were accepted. */
	queue: SerialQueue;
	/** The incident project is resolved lazily by its identifier (cached CACHE_TTL_MS); none configured — noop. */
	incidents: IncidentReporter;
	/**
	 * The deploy path's dependencies without `contains`: its memo must not outlive one event, so every job takes
	 * a fresh one from `eventDeps` (jobs.ts).
	 */
	sync: Omit<DeployDeps, 'contains'>;
	/** Last accepted delivery per input, for the watchdog. */
	lastDelivery: Map<SilenceInput, number>;
	/**
	 * Saves the delivery in the inbox, then queues it; false — a GitHub delivery id already done or pending.
	 * The job ends in `inboxDone`, or in `inboxFailed` once the queue drops it.
	 */
	submit(kind: JobKind, deliveryId: string | null, event: unknown): boolean;
};

export type Runtimes = {
	tenants: ReadonlyMap<string, TenantRuntime>;
	/** By App id from x-github-hook-installation-target-id. */
	apps: ReadonlyMap<number, { app: GitHubApp; runtime: TenantRuntime }>;
};

export type RuntimeDeps = {
	store: Store;
	log: Log;
	fetch?: Fetch;
	now?: () => number;
	/** Tests: a Plane double per tenant instead of the bot-token client. */
	plane?: (tenant: Tenant) => PlaneApi;
	/** Tests: a GitHub App double instead of the real one. */
	githubApp?: (app: GitHubAppConfig) => GitHubApp;
	/** The queue's wait between retries; tests skip the real 1 s / 5 s / 30 s. */
	sleep?: (ms: number) => Promise<void>;
};

/**
 * One runtime per tenant (its Plane client, queue, incident reporter and deploy-path deps) and the App index for
 * `/hooks/github`. Then the inbox is resumed: every delivery a previous run left pending goes back on its tenant's
 * queue, oldest first; one of a tenant no longer configured is marked failed.
 */
export function createRuntimes(config: ServiceConfig, deps: RuntimeDeps): Runtimes {
	const now = deps.now ?? Date.now;
	const tenants = new Map<string, TenantRuntime>();
	const apps = new Map<number, { app: GitHubApp; runtime: TenantRuntime }>();
	const resume = new Map<string, (job: InboxJob) => void>();
	for (const tenant of config.tenants) {
		const tenantApps = tenant.github.map(
			(app) => deps.githubApp?.(app) ?? createGitHubApp(app, { fetch: deps.fetch, now }),
		);
		const { runtime, enqueue } = createRuntime(tenant, tenantApps, config, deps, now);
		tenants.set(tenant.id, runtime);
		resume.set(tenant.id, enqueue);
		for (const app of tenantApps) apps.set(app.config.appId, { app, runtime });
	}
	for (const job of deps.store.inboxPending()) {
		const enqueue = resume.get(job.tenant);
		if (enqueue === undefined) {
			deps.store.inboxFailed(job.id, 'tenant is not configured');
			deps.log({ event: 'inbox.orphaned', level: 'warn', tenant: job.tenant, id: job.id });
		} else enqueue(job);
	}
	return { tenants, apps };
}

function createRuntime(
	tenant: Tenant,
	tenantApps: readonly GitHubApp[],
	config: ServiceConfig,
	deps: RuntimeDeps,
	now: () => number,
): { runtime: TenantRuntime; enqueue: (job: InboxJob) => void } {
	const plane =
		deps.plane?.(tenant) ??
		new PlaneClient({
			baseUrl: config.planeUrl,
			workspace: tenant.workspace,
			fetch: deps.fetch,
			auth: botTokenAuth({
				planeUrl: config.planeUrl,
				clientId: tenant.plane.clientId,
				clientSecret: tenant.plane.clientSecret,
				appInstallationId: tenant.plane.appInstallationId,
				scopes: PLANE_HOOKS_SCOPES,
				fetch: deps.fetch,
				now,
			}),
		});

	const warned = new Set<string>();
	const warnOnce = (reason: string, entry: Record<string, string>): void => {
		if (warned.has(reason)) return;
		warned.add(reason);
		deps.log({ event: 'warning', level: 'warn', tenant: tenant.id, reason, ...entry });
	};

	// Labels carry the inbox id, so the drop of a job can be written back to its row.
	const labels = new Map<string, number>();
	const queue = new SerialQueue({
		log: (entry) => {
			deps.log({
				event: entry.event,
				level: entry.event === 'job.dropped' ? 'error' : 'warn',
				tenant: tenant.id,
				label: entry.label,
				attempt: entry.attempt,
				error: entry.error,
			});
			if (entry.event !== 'job.dropped') return;
			const id = labels.get(entry.label);
			labels.delete(entry.label);
			if (id !== undefined) deps.store.inboxFailed(id, entry.error);
		},
		sleep: deps.sleep,
	});

	const projects = ttl(() => plane.listProjects(), CACHE_TTL_MS, now);
	const states = new Map<string, () => Promise<StateSummary[]>>();
	const installations = new Map<string, () => Promise<number | null>>();
	const clients = new Map<string, GitHubApi>();

	/** The App whose owner owns the repo (case-insensitive), its installation on the repo, its client; else null. */
	async function github(repo: string): Promise<GitHubApi | null> {
		const owner = repo.split('/')[0]?.toLowerCase();
		const app = tenantApps.find((candidate) => candidate.config.owner.toLowerCase() === owner);
		if (app === undefined) return null;
		const key = repo.toLowerCase();
		let lookup = installations.get(key);
		if (lookup === undefined) {
			lookup = ttl(() => app.installationFor(repo), CACHE_TTL_MS, now);
			installations.set(key, lookup);
		}
		const installation = await lookup();
		if (installation === null) return null;
		const clientKey = `${app.config.appId}:${installation}`;
		let client = clients.get(clientKey);
		if (client === undefined) {
			client = app.client(installation);
			clients.set(clientKey, client);
		}
		return client;
	}

	const runtime: TenantRuntime = {
		tenant,
		plane,
		queue,
		incidents: incidentReporter(tenant, plane, warnOnce, now),
		sync: {
			tenant,
			plane,
			github,
			projects: (): Promise<readonly ProjectSummary[]> => projects(),
			states: (projectId) => {
				let load = states.get(projectId);
				if (load === undefined) {
					load = ttl(() => plane.listStates(projectId), CACHE_TTL_MS, now);
					states.set(projectId, load);
				}
				return load();
			},
			warnOnce,
			moved: (move) =>
				deps.store.journalAdd({ tenant: tenant.id, ...move, at: new Date(now()).toISOString() }),
			releases: (draft, items) => publishRelease({ plane }, draft, items),
			cursor: deps.store.cursorFor(tenant.id),
		},
		lastDelivery: new Map(),
		submit(kind, deliveryId, event) {
			const payload = JSON.stringify(event);
			const id = deps.store.inboxAdd(
				tenant.id,
				kind,
				deliveryId,
				payload,
				new Date(now()).toISOString(),
			);
			if (id === null) return false;
			enqueue({ id, tenant: tenant.id, kind, payload });
			return true;
		},
	};

	function enqueue(job: InboxJob): void {
		// No work item key or delivery text in the label: it reaches the log on a retry or a drop.
		const label = `${job.kind}#${job.id}`;
		labels.set(label, job.id);
		queue.push(label, async () => {
			await runJob(runtime, job, { store: deps.store, log: deps.log, now });
			labels.delete(label);
			deps.store.inboxDone(job.id);
		});
	}

	return { runtime, enqueue };
}

/** Incidents of the tenant's project, resolved by identifier on first use; no `incidents` in the config — noop. */
function incidentReporter(
	tenant: Tenant,
	plane: PlaneApi,
	warnOnce: (reason: string, entry: Record<string, string>) => void,
	now: () => number,
): IncidentReporter {
	if (tenant.incidents === null) {
		return { report: () => Promise.resolve({ action: 'noop', workItemId: null }) };
	}
	const identifier = tenant.incidents.project;
	const projectId = ttl(
		async () => {
			try {
				return await resolveIncidentProject(plane, identifier);
			} catch (err) {
				// One warn per process, not one per retry of the sender; the call still fails.
				if (err instanceof IncidentProjectMissing)
					warnOnce(`incident_project_missing:${identifier}`, { project: identifier });
				throw err;
			}
		},
		CACHE_TTL_MS,
		now,
	);
	// One reporter per project id: its label and state caches and its per-key serialisation live there.
	const reporters = new Map<string, IncidentReporter>();
	return {
		async report(signal) {
			const id = await projectId();
			let reporter = reporters.get(id);
			if (reporter === undefined) {
				reporter = createIncidentReporter({ plane, projectId: id });
				reporters.set(id, reporter);
			}
			return reporter.report(signal);
		},
	};
}
