import { type DeployDeps, type DeployFact, handleDeploy } from './delivery/deploy.ts';
import { handlePullRequest } from './delivery/pr.ts';
import { handlePreview } from './delivery/preview.ts';
import { containsVia, type SyncResult } from './delivery/sync.ts';
import { type DokployEvent, recordDokployDeploy } from './dokploy.ts';
import { deploymentSignal } from './github/failure.ts';
import type { GitHubEvent } from './github/webhook.ts';
import type { IncidentSignal } from './incident.ts';
import { describeError, type Log } from './log.ts';
import type { TenantRuntime } from './runtime.ts';
import type { InboxJob, Store } from './store.ts';
import type { VercelPreview } from './vercel.ts';

export type JobDeps = { store: Store; log: Log; now: () => number };
type GitHubJob = Exclude<GitHubEvent, { kind: 'ping' }>;
type StatusEvent = Extract<GitHubEvent, { kind: 'deployment_status' }>;
/** The fields the Grafana annotation layers query: exactly one line per event carries them. */
type Annotation = { annotation: 'deploy' | 'incident'; title: string; env?: string; sha?: string };

/** The deps of one event: the runtime's, plus a `contains` memo that lives as long as the event (never per runtime). */
export function eventDeps(runtime: TenantRuntime): DeployDeps {
	return { ...runtime.sync, contains: containsVia(runtime.sync.github) };
}

/**
 * Runs one inbox job. Its payload is the normalised event this service wrote when it accepted the delivery
 * (signatures are not checked again); a kind this build does not know throws, and the job is dropped as failed.
 */
export async function runJob(runtime: TenantRuntime, job: InboxJob, deps: JobDeps): Promise<void> {
	const payload: unknown = JSON.parse(job.payload);
	switch (job.kind) {
		case 'github':
			return githubJob(runtime, payload as GitHubJob, deps);
		case 'vercel.preview':
			return previewJob(runtime, payload as VercelPreview, deps);
		case 'vercel.deploy':
			return deployJob(runtime, payload as DeployFact, 'vercel', deps);
		case 'dokploy.deployed':
			return dokployJob(runtime, payload as Extract<DokployEvent, { kind: 'deployed' }>, deps);
		default:
			throw new Error(`inbox kind ${job.kind} is unknown to this build`);
	}
}

/**
 * The deploy a successful `deployment_status` stands for. `at` is that status's own `created_at` (`event.at`):
 * handleDeploy orders the deploys of an environment by it and drops one older than its cursor as stale, so
 * neither the processing time nor the deployment's creation time may stand in.
 */
export function githubDeployFact(event: StatusEvent): DeployFact {
	return {
		repo: event.deployment.repo,
		environment: event.deployment.environment,
		sha: event.deployment.sha,
		deploymentId: event.deployment.id,
		logUrl: event.logUrl,
		at: event.at,
	};
}

async function githubJob(runtime: TenantRuntime, event: GitHubJob, deps: JobDeps): Promise<void> {
	if (event.kind === 'pull_request') {
		const { linked, synced } = await handlePullRequest(eventDeps(runtime), event);
		logSynced(runtime, synced, `pr:${event.pull.repo}#${event.pull.number}`, deps);
		deps.log({
			event: 'github.pull_request',
			tenant: runtime.tenant.id,
			repo: event.pull.repo,
			number: event.pull.number,
			action: event.action,
			linked,
		});
		return;
	}
	const signal = deploymentSignal(event, runtime.tenant, () => new Date(deps.now()));
	if (signal !== null) {
		const reported = await reportLogged(runtime, signal, `deployment.${event.state}`, deps.log);
		// The queue retries the whole job: the report and the deploy path are both idempotent.
		if (!reported.ok) throw reported.error;
	}
	if (event.state === 'success') await deployJob(runtime, githubDeployFact(event), 'github', deps);
}

async function deployJob(
	runtime: TenantRuntime,
	fact: DeployFact,
	source: 'github' | 'vercel',
	deps: JobDeps,
): Promise<void> {
	const result = await handleDeploy(eventDeps(runtime), fact);
	const tenant = runtime.tenant.id;
	const kind = result.action === 'rolled_back' ? 'rolledback' : 'deployed';
	for (const note of result.notes)
		deps.log({ event: 'delivery.noted', tenant, key: note.key, kind, created: note.created });
	logSynced(runtime, result.synced, `deploy:${fact.repo}:${fact.environment}:${fact.sha}`, deps);
	if (result.release !== null) {
		deps.log({
			event: 'release',
			tenant,
			repo: fact.repo,
			sha: fact.sha,
			action: result.release.action,
			releaseId: result.release.releaseId,
		});
	}
	if (result.releaseError !== null) {
		// The deploy is done; a Free plan (402) or a missing scope only costs the release.
		deps.log({
			event: 'release',
			level: 'warn',
			tenant,
			repo: fact.repo,
			sha: fact.sha,
			error: result.releaseError,
		});
	}
	// One line per deploy, and only it carries the annotation the dashboards draw; an ignored one is no mark.
	deps.log({
		event: 'deploy',
		tenant,
		source,
		repo: fact.repo,
		action: result.action,
		env: fact.environment,
		sha: fact.sha,
		...(result.action === 'ignored' ? {} : { annotation: 'deploy', title: result.title }),
	});
}

async function previewJob(
	runtime: TenantRuntime,
	preview: VercelPreview,
	deps: JobDeps,
): Promise<void> {
	for (const result of await handlePreview(eventDeps(runtime), preview)) {
		deps.log({
			event: 'delivery.noted',
			tenant: runtime.tenant.id,
			key: result.key,
			kind: 'preview',
			created: result.action === 'created',
			action: result.action,
		});
	}
}

async function dokployJob(
	runtime: TenantRuntime,
	event: Extract<DokployEvent, { kind: 'deployed' }>,
	deps: JobDeps,
): Promise<void> {
	const result = await recordDokployDeploy(
		{ tenant: runtime.tenant, github: runtime.sync.github },
		event,
	);
	// No App, no branch head or a public repository: the config does not match GitHub — worth a warn.
	const expected = result.action === 'recorded' || result.action === 'unmapped';
	deps.log({
		event: 'dokploy.recorded',
		tenant: runtime.tenant.id,
		app: event.app,
		action: result.action,
		deploymentId: result.deploymentId,
		...(expected ? {} : { level: 'warn' }),
	});
}

/** One `delivery.synced` line per result; a move also goes to the journal with its cause. */
function logSynced(
	runtime: TenantRuntime,
	results: readonly SyncResult[],
	cause: string,
	deps: JobDeps,
): void {
	const tenant = runtime.tenant.id;
	for (const result of results) {
		deps.log({
			event: 'delivery.synced',
			tenant,
			key: result.key,
			action: result.action,
			from: result.from,
			to: result.to,
			reason: result.reason,
		});
		if (result.action === 'moved' && result.from !== undefined && result.to !== undefined) {
			deps.store.journalAdd({
				tenant,
				key: result.key,
				from: result.from,
				to: result.to,
				cause,
				at: new Date(deps.now()).toISOString(),
			});
		}
	}
}

/**
 * Reports one incident signal and writes its line (with the annotation `annotate` gives for the outcome).
 * A failure is returned, not thrown: the HTTP path answers 502, a job rethrows it for the queue.
 */
export async function reportLogged(
	runtime: TenantRuntime,
	signal: IncidentSignal,
	event: string,
	log: Log,
	annotate: (action: string) => Annotation | undefined = () => undefined,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
	const started = performance.now();
	const line = { event, tenant: runtime.tenant.id, source: signal.source, key: signal.key };
	try {
		const result = await runtime.incidents.report(signal);
		log({
			...line,
			action: result.action,
			workItemId: result.workItemId,
			ms: since(started),
			...annotate(result.action),
		});
		return { ok: true };
	} catch (error) {
		log({
			...line,
			level: 'error',
			action: 'error',
			workItemId: null,
			ms: since(started),
			...annotate('error'),
			error: describeError(error),
		});
		return { ok: false, error };
	}
}

/** Grafana alerts: a new firing or a new resolution is a mark on the dashboards; a replay (noop) or an error is not. */
export function incidentAnnotation(
	signal: IncidentSignal,
): (action: string) => Annotation | undefined {
	return (action) => {
		const fresh =
			signal.status === 'firing'
				? action === 'created' || action === 'reopened' || action === 'commented'
				: action === 'commented';
		if (!fresh) return undefined;
		const verb = signal.status === 'firing' ? 'Сработал' : 'Погас';
		return {
			annotation: 'incident',
			title: `${verb}: ${signal.title ?? signal.key}`,
			env: markEnv(signal.env),
		};
	};
}

/** A Vercel production or staging deploy (or its failure) is a deploy mark whatever the incident outcome. */
export function deployAnnotation(summary: {
	title: string;
	env: string;
	sha?: string;
}): () => Annotation {
	return () => ({ annotation: 'deploy', title: summary.title, env: summary.env, sha: summary.sha });
}

/** Deploy marks tag `production` / `staging`; an alert without an env label defaults to `prod` in its title, but the mark must match the deploy vocabulary. */
function markEnv(env: string | undefined): string | undefined {
	return env === 'prod' ? 'production' : env;
}

function since(started: number): number {
	return Math.round(performance.now() - started);
}
