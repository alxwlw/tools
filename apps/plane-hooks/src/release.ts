import type { ReleaseDraft } from './deploy-note.ts';
import { esc, link, truncate } from './html.ts';
import { type PlaneApi, RELEASE_ITEMS_MAX } from './plane.ts';

/** external_source of every release plane-hooks makes. */
export const RELEASE_SOURCE = 'github-deploy';
const NAME_MAX = 200;
const HEADLINE_MAX = 200;
/** GitHub's merge of the release PR: `Merge pull request #889 from liqu-fi/staging`, a blank line, the PR title. */
const RELEASE_MERGE = /^Merge pull request #\d+ from [^\s/]+\/staging\r?\n\r?\n([^\r\n]+)/;

/** A work item a deploy note found: the key for the changelog, the id for the release link. */
export type ReleaseItem = { key: string; workItemId: string };
/** `noop` — the release was already there (a replayed event); its changelog and work items were written again. */
export type ReleaseResult = { action: 'created' | 'noop'; releaseId: string };

/** One release per deployed commit of a repository. */
export function releaseExternalId(draft: ReleaseDraft): string {
	return `${draft.repository}@${draft.sha}`;
}

/** `2026-10-09 · 0ee269c`, plus ` — <PR title>` when the deployed commit is the merge of a release PR from staging. */
export function releaseName(draft: ReleaseDraft): string {
	const base = `${draft.at.slice(0, 10)} · ${draft.sha.slice(0, 7)}`;
	const head = draft.commits[0];
	const title =
		head !== undefined && head.sha === draft.sha
			? RELEASE_MERGE.exec(head.message)?.[1]?.trim()
			: undefined;
	return truncate(title ? `${base} — ${title}` : base, NAME_MAX);
}

/** Commits of the deploy (headline, short sha linked to the commit), then the work items it delivered. */
export function changelogHtml(draft: ReleaseDraft, items: readonly ReleaseItem[]): string {
	const parts = ['<h3>Коммиты</h3>'];
	if (draft.commits.length === 0) {
		parts.push('<p>Новых коммитов нет: повторный деплой того же sha.</p>');
	} else {
		const rows = draft.commits.map((commit) => {
			const sha7 = commit.sha.slice(0, 7);
			const ref =
				link(`https://github.com/${draft.repository}/commit/${commit.sha}`, sha7) ?? esc(sha7);
			const headline = truncate(commit.message.split(/\r?\n/, 1)[0] ?? '', HEADLINE_MAX);
			return `<li>${ref} ${esc(headline)}</li>`;
		});
		parts.push(`<ul>${rows.join('')}</ul>`);
	}
	const unique = uniqueItems(items);
	if (unique.length > 0) {
		parts.push(
			`<h3>Задачи</h3><ul>${unique.map((item) => `<li><code>${esc(item.key)}</code></li>`).join('')}</ul>`,
		);
	}
	return parts.join('');
}

/**
 * The Plane release of one production deploy (spec «plane-hooks: Release в Plane»). Looked up by external_id first, so a
 * replayed event makes no second release; then the changelog and the work items are written — both are idempotent,
 * and a replay completes a release a failed call left half-made. The changelog is rewritten only when the draft carries
 * commits or the release is new: a rerun with no commits must not erase the list written by the first run.
 */
export async function publishRelease(
	deps: { plane: PlaneApi },
	draft: ReleaseDraft,
	items: readonly ReleaseItem[],
): Promise<ReleaseResult> {
	const externalId = releaseExternalId(draft);
	const found = await deps.plane.findReleaseByExternalId(RELEASE_SOURCE, externalId);
	const release =
		found !== null
			? { id: found.id, created: false }
			: await deps.plane.createRelease({
					name: releaseName(draft),
					status: 'released',
					release_date: draft.at.slice(0, 10),
					external_source: RELEASE_SOURCE,
					external_id: externalId,
				});
	// A rerun of an already deployed sha carries no commits (the deploy tag has moved): keep the changelog written before.
	if (release.created || draft.commits.length > 0) {
		await deps.plane.updateReleaseChangelog(release.id, changelogHtml(draft, items));
	}
	const ids = uniqueItems(items)
		.map((item) => item.workItemId)
		.slice(0, RELEASE_ITEMS_MAX);
	if (ids.length > 0) await deps.plane.addReleaseWorkItems(release.id, ids);
	return { action: release.created ? 'created' : 'noop', releaseId: release.id };
}

function uniqueItems(items: readonly ReleaseItem[]): ReleaseItem[] {
	return items.filter(
		(item, i) => items.findIndex((other) => other.workItemId === item.workItemId) === i,
	);
}
