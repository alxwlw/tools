import type { GitHubApi } from '../github/client.ts';
import { esc, link, p } from '../html.ts';
import type { VercelHookEvent, VercelPreview } from '../vercel.ts';
import type { DeployFact } from './deploy.ts';
import { ownedKeys } from './keys.ts';
import { tolerateGone } from './pr.ts';
import { SOURCE, type SyncDeps } from './sync.ts';

const DEPLOYMENTS_CHECKED = 20;
const VERCEL_BOT = 'vercel[bot]';

export type PreviewResult = { key: string; action: 'created' | 'updated' | 'noop' };

function previewHtml(preview: VercelPreview): string {
	const parts = [
		`Превью <code>${esc(preview.project)}</code>: ${link(preview.url, preview.url) ?? `<code>${esc(preview.url)}</code>`}`,
	];
	if (preview.branch !== null) parts.push(`ветка <code>${esc(preview.branch)}</code>`);
	if (preview.sha !== null) parts.push(`<code>${esc(preview.sha.slice(0, 7))}</code>`);
	return p(parts.join(' · '));
}

/** The work items a preview belongs to: the keys of the branch's open PRs, else of the branch name. */
async function keysOf(deps: SyncDeps, preview: VercelPreview): Promise<string[]> {
	if (preview.branch === null) return [];
	const identifiers = new Set((await deps.projects()).map((project) => project.identifier));
	const github = preview.repo === null ? null : await deps.github(preview.repo);
	const pulls =
		github === null || preview.repo === null
			? []
			: await github.openPullsForBranch(preview.repo, preview.branch);
	// Keys in a PR description are mentions: they get no preview.
	if (pulls.length === 0) return ownedKeys({ title: '', head: preview.branch }, identifiers);
	return [...new Set(pulls.flatMap((pull) => ownedKeys(pull, identifiers)))];
}

/**
 * One comment per work item and Vercel project, kept up to date: the first preview creates it, a new link
 * rewrites it, the same link changes nothing. The work item id in `external_id` keeps two work items of one
 * Plane project apart (its duplicate check spans the project).
 */
export async function handlePreview(
	deps: SyncDeps,
	preview: VercelPreview,
): Promise<PreviewResult[]> {
	if (deps.tenant.delivery === null) return [];
	const html = previewHtml(preview);
	const results: PreviewResult[] = [];
	for (const key of await keysOf(deps, preview)) {
		const action = await tolerateGone<PreviewResult['action'] | null>(deps, key, null, async () => {
			const item = await deps.plane.getWorkItemByKey(key);
			if (item === null) return null;
			const externalId = `preview:${item.id}:${preview.project}`;
			const comments = await deps.plane.listComments(item.project, item.id);
			const existing = comments.find((comment) => comment.external_id === externalId);
			let commentId = existing?.id;
			let shown = existing?.comment_html ?? null;
			if (commentId === undefined) {
				const made = await deps.plane.createComment(item.project, item.id, {
					comment_html: html,
					external_id: externalId,
					external_source: SOURCE,
				});
				if (made.created) return 'created';
				// Created by a concurrent delivery after our read: its text is unknown, rewrite it.
				commentId = made.id;
				shown = null;
			}
			if (shown?.includes(`href="${esc(preview.url)}"`)) return 'noop';
			await deps.plane.updateComment(item.project, item.id, commentId, html);
			return 'updated';
		});
		if (action !== null) results.push({ key, action });
	}
	return results;
}

/**
 * The GitHub deploy a Vercel promote / rollback stands for. `at` is the time of the promote/rollback event itself
 * (`event.at`): handleDeploy orders deploys by it and drops a fact older than its cursor as stale, so neither the
 * processing time nor the deployment's creation time may stand in. `deploymentId` is null — GitHub has no record
 * of the switch. The environment is the one where `vercel[bot]` has a Deployment record of `sha`. Observed on the
 * GitHub API rows: `Production` for a repository with one Vercel project (older records `Production – <project>`), and
 * `Production – <project>` for the projects of a repository with several; a preview is `Preview`. The
 * promote and rollback bodies are not captured live — per the Vercel docs a rollback carries only
 * `fromDeploymentId` / `toDeploymentId`, no sha, and the server answers it before this function with a
 * `vercel.rollback.unresolved` warn line (resolving the id would need a Vercel API key). No repo, sha or such a
 * record → null. A deployment whose creator is gone (null) is not `vercel[bot]`.
 */
export async function vercelDeployFact(
	github: GitHubApi,
	event: Extract<VercelHookEvent, { kind: 'promoted' | 'rolled_back' }>,
): Promise<DeployFact | null> {
	if (event.repo === null || event.sha === null) return null;
	for (const environment of ['Production', `Production – ${event.project}`]) {
		const found = (await github.listDeployments(event.repo, environment, DEPLOYMENTS_CHECKED)).some(
			(deployment) => deployment.sha === event.sha && deployment.creator === VERCEL_BOT,
		);
		if (found)
			return {
				repo: event.repo,
				environment,
				sha: event.sha,
				deploymentId: null,
				logUrl: event.url,
				at: event.at,
			};
	}
	return null;
}
