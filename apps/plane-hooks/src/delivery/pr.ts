import { matchRepo } from '../config.ts';
import type { GitHubEvent } from '../github/webhook.ts';
import { PlaneApiError } from '../plane.ts';
import { mentionedKeys, ownedKeys, pullUrl } from './keys.ts';
import { type SyncDeps, type SyncResult, syncTask } from './sync.ts';

export type PullEvent = Extract<GitHubEvent, { kind: 'pull_request' }>;

/**
 * Runs `run` for the work item `key`. A project the bot is not a member of (403) or a work item that vanished
 * (404) must not poison the delivery queue: the key is skipped with a warning (once per project) and `fallback`
 * stands in. Every other error propagates, so the queue retries it.
 */
export async function tolerateGone<T>(
	deps: Pick<SyncDeps, 'warnOnce'>,
	key: string,
	fallback: T,
	run: () => Promise<T>,
): Promise<T> {
	try {
		return await run();
	} catch (err) {
		if (!(err instanceof PlaneApiError) || (err.status !== 403 && err.status !== 404)) throw err;
		const project = key.slice(0, key.lastIndexOf('-'));
		deps.warnOnce(
			err.status === 403 ? `plane_forbidden:${project}` : `plane_not_found:${project}`,
			{
				project,
			},
		);
		return fallback;
	}
}

/**
 * Links the PR into every work item it names (title and branch: owned; description: mentioned), then syncs the
 * owned ones. A repository without a rule gets the links only; a tenant without `delivery` gets nothing.
 */
export async function handlePullRequest(
	deps: SyncDeps,
	event: PullEvent,
): Promise<{ linked: number; synced: SyncResult[] }> {
	const delivery = deps.tenant.delivery;
	if (delivery === null) return { linked: 0, synced: [] };
	const { pull } = event;
	const identifiers = new Set((await deps.projects()).map((p) => p.identifier));
	const owned = ownedKeys(pull, identifiers);
	const mentioned = mentionedKeys(pull, identifiers);
	const ruled = matchRepo(delivery.repos, pull.repo) !== null;

	let linked = 0;
	const synced: SyncResult[] = [];
	for (const key of [...owned, ...mentioned]) {
		const created = await tolerateGone(deps, key, false, async () => {
			const item = await deps.plane.getWorkItemByKey(key);
			if (item === null) return false;
			const outcome = await deps.plane.createLink(item.project, item.id, {
				url: pullUrl(pull.repo, pull.number),
				title: `GitHub: ${pull.repo}#${pull.number}`,
			});
			return outcome === 'created';
		});
		if (created) linked++;
	}
	if (!ruled) return { linked, synced };
	for (const key of owned) {
		const result = await tolerateGone<SyncResult>(
			deps,
			key,
			{ key, action: 'skipped', reason: 'plane refused' },
			() => syncTask(deps, key, { kind: 'pr', pull, deliveryId: event.deliveryId }, [pull]),
		);
		synced.push(result);
	}
	return { linked, synced };
}
