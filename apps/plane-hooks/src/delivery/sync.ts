import type { DeliveryConfig, RepoRule, Tenant } from '../config.ts';
import { matchRepo } from '../config.ts';
import type { GitHubApi, Pull } from '../github/client.ts';
import { esc } from '../html.ts';
import type { PlaneApi, ProjectSummary, StateSummary } from '../plane.ts';
import { ownedKeys, PULL_URL, pullUrl } from './keys.ts';
import { missingSteps, pullPosition, resolveStep } from './position.ts';
import { compareStates, isMovable } from './states.ts';

export const SOURCE = 'plane-hooks';
const DEPLOYMENTS_CHECKED = 20;

export type SyncCause =
	| { kind: 'pr'; pull: Pull; deliveryId: string }
	| { kind: 'deploy'; repo: string; environment: string; sha: string };
export type SyncDeps = {
	tenant: Tenant; // tenant.delivery is not null here
	plane: PlaneApi;
	/** Installation client for the repo's owner, or null when no App of the tenant covers it. */
	github: (repo: string) => Promise<GitHubApi | null>;
	projects: () => Promise<readonly ProjectSummary[]>; // ttl-cached by the caller
	states: (projectId: string) => Promise<readonly StateSummary[]>; // ttl-cached by the caller
	/** Memoised per event: does the latest successful deployment of repo/environment contain sha? */
	contains: (repo: string, environment: string, sha: string) => Promise<boolean>;
	warnOnce: (reason: string, entry: Record<string, string>) => void;
	/**
	 * Called right after a state write lands, before anything else can fail: a job the queue retries whole
	 * finds the work item already moved (noop), so the move is recorded here, where it happened.
	 */
	moved: (move: { key: string; from: string; to: string; cause: string }) => void;
};
export type SyncResult = {
	key: string;
	action: 'moved' | 'noop' | 'skipped';
	from?: string;
	to?: string;
	reason?: string;
};

type Candidate = { pull: Pull; rule: RepoRule };

/** The cause of a move as the journal names it: `pr:<repo>#<number>` or `deploy:<repo>:<environment>:<sha>`. */
export function causeKey(cause: SyncCause): string {
	return cause.kind === 'pr'
		? `pr:${cause.pull.repo}#${cause.pull.number}`
		: `deploy:${cause.repo}:${cause.environment}:${cause.sha}`;
}

/** The PRs the work item belongs to: its links plus `extra`, minus those the hub cannot see or that name another task. */
async function pullsOf(
	deps: SyncDeps,
	delivery: DeliveryConfig,
	key: string,
	item: { id: string; project: string },
	identifiers: ReadonlySet<string>,
	extra: readonly Pull[],
): Promise<Candidate[]> {
	const found: Candidate[] = [];
	const seen = new Set<string>();
	const consider = (pull: Pull) => {
		const rule = matchRepo(delivery.repos, pull.repo);
		if (rule && ownedKeys(pull, identifiers).includes(key)) found.push({ pull, rule });
	};
	for (const pull of extra) {
		const url = pullUrl(pull.repo, pull.number);
		if (seen.has(url)) continue;
		seen.add(url);
		consider(pull);
	}
	for (const link of await deps.plane.listLinks(item.project, item.id)) {
		const match = PULL_URL.exec(link.url);
		if (!match || seen.has(link.url)) continue;
		seen.add(link.url);
		const repo = match[1] as string;
		if (!matchRepo(delivery.repos, repo)) continue;
		const github = await deps.github(repo);
		if (!github) continue;
		const pull = await github.getPull(repo, Number(match[2]));
		if (pull) consider(pull);
	}
	return found;
}

function transitionComment(cause: SyncCause, stateName: string): { reason: string; html: string } {
	const head = `<p>Статус → <b>${esc(stateName)}</b>: `;
	if (cause.kind === 'pr') {
		const label = `${cause.pull.repo}#${cause.pull.number}`;
		return {
			reason: `pr:${label}:${cause.deliveryId}`,
			html: `${head}<a href="${esc(pullUrl(cause.pull.repo, cause.pull.number))}">${esc(label)}</a></p>`,
		};
	}
	return {
		reason: `deploy:${cause.repo}:${cause.environment}:${cause.sha}`,
		html: `${head}деплой <code>${esc(cause.sha.slice(0, 7))}</code> в <code>${esc(cause.environment)}</code></p>`,
	};
}

/** Decides where the work item `key` stands by all its PRs and moves it there, forward only. */
export async function syncTask(
	deps: SyncDeps,
	key: string,
	cause: SyncCause,
	extra: readonly Pull[] = [],
): Promise<SyncResult> {
	const skipped = (reason: string): SyncResult => ({ key, action: 'skipped', reason });
	const noop = (reason: string): SyncResult => ({ key, action: 'noop', reason });
	const delivery = deps.tenant.delivery;
	if (delivery === null) return skipped('delivery off');

	const item = await deps.plane.getWorkItemByKey(key);
	if (item === null) return skipped('unknown key');
	const identifier = key.slice(0, key.lastIndexOf('-'));
	if (deps.tenant.incidents?.project === identifier) return skipped('incident project');

	const identifiers = new Set((await deps.projects()).map((p) => p.identifier));
	for (const name of Object.keys(delivery.projects)) {
		if (!identifiers.has(name)) deps.warnOnce(`project_missing:${name}`, { project: name });
	}
	const candidates = await pullsOf(deps, delivery, key, item, identifiers, extra);
	if (candidates.length === 0) return noop('no pulls');

	const positions = [];
	for (const { pull, rule } of candidates) {
		const position = await pullPosition(pull, rule, delivery, (environment) =>
			deps.contains(pull.repo, environment, pull.mergeSha as string),
		);
		if (position.kind === 'draft') return noop('draft');
		if (position.kind === 'at') positions.push(position);
	}
	if (positions.length === 0) return noop('no pulls');

	const states = await deps.states(item.project);
	const renames = delivery.projects[identifier] ?? {};
	let target: StateSummary | null = null;
	let unresolved = false;
	for (const { chain, index } of positions) {
		for (const name of missingSteps(chain, index, renames, states))
			deps.warnOnce(`state_missing:${identifier}:${name}`, { project: identifier, state: name });
		const step = resolveStep(chain, index, renames, states);
		if (step === null) unresolved = true;
		else if (target === null || compareStates(step, target) < 0) target = step;
	}
	if (unresolved || target === null) return noop('unresolved');

	// The task may have been moved by a person while the awaits above ran: decide on a fresh read.
	const fresh = await deps.plane.getWorkItem(item.project, item.id);
	const current = states.find((s) => s.id === fresh.state);
	if (!current) return noop('unknown state');
	if (!isMovable(current, delivery.hold)) return noop('hold');
	if (compareStates(target, current) <= 0) return noop('not forward');

	// Comment first: its external_id makes a repeat harmless (409), so a failed state write is retried whole.
	const { reason, html } = transitionComment(cause, target.name);
	await deps.plane.createComment(item.project, item.id, {
		comment_html: html,
		// Plane's duplicate check spans the project: the work item id keeps two tasks of one PR apart.
		external_id: `state:${item.id}:${target.id}:${reason}`,
		external_source: SOURCE,
	});
	await deps.plane.setWorkItemState(item.project, item.id, target.id);
	deps.moved({ key, from: current.name, to: target.name, cause: causeKey(cause) });
	return { key, action: 'moved', from: current.name, to: target.name };
}

/**
 * `contains` for SyncDeps: latest deployment of the environment whose latest state is success (first 20 checked),
 * then compare(sha, its sha) is ahead or identical. Memoised by repo/environment/sha.
 */
export function containsVia(
	github: (repo: string) => Promise<GitHubApi | null>,
): SyncDeps['contains'] {
	const memo = new Map<string, Promise<boolean>>();
	const check = async (repo: string, environment: string, sha: string): Promise<boolean> => {
		const client = await github(repo);
		if (!client) return false;
		for (const deployment of await client.listDeployments(repo, environment, DEPLOYMENTS_CHECKED)) {
			if ((await client.latestState(repo, deployment.id)) !== 'success') continue;
			const comparison = await client.compare(repo, sha, deployment.sha);
			return (
				comparison !== null && (comparison.status === 'ahead' || comparison.status === 'identical')
			);
		}
		return false;
	};
	return (repo, environment, sha) => {
		const id = JSON.stringify([repo, environment, sha]);
		let answer = memo.get(id);
		if (!answer) {
			answer = check(repo, environment, sha);
			memo.set(id, answer);
			// A failed lookup is not an answer: the next ask repeats it.
			answer.catch(() => memo.delete(id));
		}
		return answer;
	};
}
