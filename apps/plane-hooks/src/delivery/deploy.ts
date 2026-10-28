import { matchRepo } from '../config.ts';
import type { ReleaseDraft } from '../deploy-note.ts';
import type { Commit, GitHubApi, Pull } from '../github/client.ts';
import type { ReleaseItem, ReleaseResult } from '../release.ts';
import { describeError } from '../server.ts';
import { ownedKeys } from './keys.ts';
import { deployedHtml, rolledBackHtml } from './notes.ts';
import { tolerateGone } from './pr.ts';
import { SOURCE, type SyncCause, type SyncDeps, type SyncResult, syncTask } from './sync.ts';

const PAST_DEPLOYMENTS = 20;

export type DeployFact = {
	repo: string;
	environment: string;
	sha: string;
	/** GitHub deployment id; null — a deploy GitHub has no record of (Vercel promote). */
	deploymentId: number | null;
	logUrl: string | null;
	at: string; // ISO
};
export type DeployResult = {
	action: 'ignored' | 'identical' | 'delivered' | 'rolled_back';
	notes: Array<{ key: string; workItemId: string; created: boolean }>;
	synced: SyncResult[];
	release: ReleaseResult | null;
	/** describeError of a failed release (402 on Free and the rest); the deploy itself is done. */
	releaseError: string | null;
	/** For the annotation log line: `<repo> → <environment> · <sha7>`. */
	title: string;
};
/** Tenant-bound view of Store's deploy cursor. */
export type DeployCursor = {
	get(repo: string, environment: string): string | null;
	set(repo: string, environment: string, sha: string): void;
};
export type DeployDeps = SyncDeps & {
	releases: (draft: ReleaseDraft, items: ReleaseItem[]) => Promise<ReleaseResult>;
	cursor: DeployCursor;
};

/** A commit that no PR brought in stands for itself: its first message line may still name a work item. */
function commitAsPull(repo: string, commit: Commit): Pull {
	return {
		repo,
		number: 0,
		url: `https://github.com/${repo}/commit/${commit.sha}`,
		title: commit.message.split(/\r?\n/, 1)[0] ?? '',
		body: '',
		head: '',
		base: '',
		draft: false,
		state: 'closed',
		merged: true,
		mergeSha: commit.sha,
	};
}

/** The sha of the deploy before this one, from GitHub: newest successful deployment of the environment below `fact`. */
async function previousFromGitHub(github: GitHubApi, fact: DeployFact): Promise<string | null> {
	for (const past of await github.listDeployments(fact.repo, fact.environment, PAST_DEPLOYMENTS)) {
		if (past.sha === fact.sha) continue;
		if (fact.deploymentId !== null && past.id >= fact.deploymentId) continue;
		if ((await github.latestState(fact.repo, past.id)) === 'success') return past.sha;
	}
	return null;
}

type Range = { action: 'identical' } | { action: 'delivered' | 'rolled_back'; commits: Commit[] };

/** The commits this deploy changed on the environment, oldest first; `identical` — nothing changed. */
async function rangeOf(
	deps: DeployDeps,
	github: GitHubApi,
	fact: DeployFact,
	previous: string | null,
): Promise<Range> {
	const alone: Range = { action: 'delivered', commits: [{ sha: fact.sha, message: '' }] };
	if (previous === null) return alone;
	const forward = await github.compare(fact.repo, previous, fact.sha);
	// The previous sha is gone (force-push): only this sha is known; a vanished base is no rollback.
	if (forward === null) return alone;
	if (forward.status === 'identical') return { action: 'identical' };
	if (forward.status === 'behind') {
		// The environment went back: the PRs that were in `previous` and are not in `fact.sha` are rolled back.
		const undone = await github.compare(fact.repo, fact.sha, previous);
		if (undone?.truncated) deps.warnOnce(`compare_truncated:${fact.repo}`, { repo: fact.repo });
		return { action: 'rolled_back', commits: undone?.commits ?? [] };
	}
	if (forward.truncated) deps.warnOnce(`compare_truncated:${fact.repo}`, { repo: fact.repo });
	return { action: 'delivered', commits: forward.commits };
}

/** The PRs of the commits, each once; a commit without a PR becomes a stand-in PR. */
async function pullsOfCommits(
	github: GitHubApi,
	repo: string,
	commits: readonly Commit[],
): Promise<Pull[]> {
	const pulls = new Map<string, Pull>();
	for (const commit of commits) {
		const found = await github.mergedPullsForCommit(repo, commit.sha);
		if (found.length === 0) {
			const pseudo = commitAsPull(repo, commit);
			pulls.set(pseudo.url, pseudo);
		}
		for (const pull of found) pulls.set(pull.url, pull);
	}
	return [...pulls.values()];
}

/**
 * One GitHub deploy of an environment: «Выкачено» (or «Откачено») on the work items of the PRs it carried, their
 * statuses by `syncTask`, the release of a production deploy, then the cursor. Any thrown error leaves the cursor
 * where it was, so the queue retries the same range; every write is idempotent.
 */
export async function handleDeploy(deps: DeployDeps, fact: DeployFact): Promise<DeployResult> {
	const title = `${fact.repo} → ${fact.environment} · ${fact.sha.slice(0, 7)}`;
	const result = (action: DeployResult['action']): DeployResult => ({
		action,
		notes: [],
		synced: [],
		release: null,
		releaseError: null,
		title,
	});
	const delivery = deps.tenant.delivery;
	const rule = delivery === null ? null : matchRepo(delivery.repos, fact.repo);
	const environment = rule?.environments.find((env) => env.name === fact.environment);
	if (environment === undefined) return result('ignored');
	const github = await deps.github(fact.repo);
	if (github === null) {
		deps.warnOnce(`no_app:${fact.repo}`, { repo: fact.repo });
		return result('ignored');
	}

	const cursor = deps.cursor.get(fact.repo, fact.environment);
	if (cursor === fact.sha) return result('identical');
	// A lost earlier deploy is caught up by the cursor; the first run asks GitHub for the one before.
	const previous = cursor ?? (await previousFromGitHub(github, fact));
	const range = await rangeOf(deps, github, fact, previous);
	if (range.action === 'identical') {
		deps.cursor.set(fact.repo, fact.environment, fact.sha);
		return result('identical');
	}

	const out = result(range.action);
	const rolledBack = range.action === 'rolled_back';
	const pulls = await pullsOfCommits(github, fact.repo, range.commits);
	const identifiers = new Set((await deps.projects()).map((p) => p.identifier));
	// key → the PRs of the range that own it; mentioned-only keys get nothing.
	const byKey = new Map<string, Pull[]>();
	for (const pull of pulls) {
		for (const key of ownedKeys(pull, identifiers))
			byKey.set(key, [...(byKey.get(key) ?? []), pull]);
	}

	const items: ReleaseItem[] = [];
	for (const [key, owned] of byKey) {
		const item = await tolerateGone(deps, key, null, () => deps.plane.getWorkItemByKey(key));
		if (item === null) continue;
		await tolerateGone(deps, key, undefined, async () => {
			if (!rolledBack) {
				for (const pull of owned.filter((p) => p.number > 0)) {
					await deps.plane.createLink(item.project, item.id, {
						url: pull.url,
						title: `GitHub: ${pull.repo}#${pull.number}`,
					});
				}
			}
			const comment = await deps.plane.createComment(item.project, item.id, {
				comment_html: rolledBack ? rolledBackHtml(fact) : deployedHtml(fact, owned),
				// Plane's duplicate check spans the project: the work item id keeps one deploy's notes apart.
				external_id: `${rolledBack ? 'rolledback' : 'deployed'}:${item.id}:${fact.repo}:${fact.environment}:${fact.sha}`,
				external_source: SOURCE,
			});
			out.notes.push({ key, workItemId: item.id, created: comment.created });
			items.push({ key, workItemId: item.id });
			if (!rolledBack) {
				const cause: SyncCause = {
					kind: 'deploy',
					repo: fact.repo,
					environment: fact.environment,
					sha: fact.sha,
				};
				out.synced.push(await syncTask(deps, key, cause, owned));
			}
		});
	}

	if (environment.release && range.action === 'delivered') {
		const headline = pulls.find((pull) => pull.number > 0 && pull.mergeSha === fact.sha)?.title;
		const draft: ReleaseDraft = {
			repository: fact.repo,
			sha: fact.sha,
			at: fact.at,
			runUrl: fact.logUrl ?? '',
			// Newest first, as the draft wants them.
			commits: [...range.commits].reverse(),
			...(headline === undefined ? {} : { headline }),
		};
		try {
			out.release = await deps.releases(draft, items);
		} catch (err) {
			out.releaseError = describeError(err);
		}
	}
	deps.cursor.set(fact.repo, fact.environment, fact.sha);
	return out;
}
