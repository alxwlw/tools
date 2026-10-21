import { esc, link, p } from './html.ts';
import type { IncidentSignal } from './incident.ts';
import { type PlaneApi, PlaneApiError } from './plane.ts';
import { extractWorkItemKeys } from './work-item-keys.ts';

export type DeployTarget = 'production' | 'staging' | 'preview';

/** A successful deploy, reduced to what a work item comment needs. `texts` — branch and commit message to look for keys in; `source` — external_source of the notes; `keyLimit` — at most this many keys per deploy. */
export type DeployNote = {
	deploymentId: string;
	project: string;
	target: DeployTarget;
	sha?: string;
	url: string;
	texts: string[];
	source: 'vercel' | 'github';
	keyLimit: number;
};

/** What the Grafana annotation of one deploy shows. */
export type DeploySummary = { title: string; env: string; sha?: string };

/** A deployed commit: full sha (lower case) and message, as report-deploy.sh sends it (cut to 4 KiB). */
export type DeployCommit = { sha: string; message: string };

/** One successful production deploy, reduced to what its Plane release needs (spec «plane-hooks: Release в Plane»). */
export type ReleaseDraft = {
	/** `liqu-fi/monorepo` */
	repository: string;
	/** The deployed commit, 40 hex, lower case. */
	sha: string;
	/** When plane-hooks took the event (ISO): the release date is its UTC day. */
	at: string;
	runUrl: string;
	/** Newest first, as report-deploy.sh sends them; commits[0] is the deployed commit when it carries any. */
	commits: DeployCommit[];
};

export type DeployOutcome =
	| { kind: 'failed'; signal: IncidentSignal; summary: DeploySummary }
	| {
			kind: 'succeeded';
			resolve: IncidentSignal;
			note: DeployNote;
			summary: DeploySummary;
			release?: ReleaseDraft;
	  };

export type DeployNoteAction = 'commented' | 'noop' | 'skipped';
/** `ms` — how long this key's Plane calls took. */
export type DeployNoteResult = {
	key: string;
	action: DeployNoteAction;
	workItemId: string | null;
	ms: number;
};

/**
 * «Выкачено» comment on every work item whose key (`OPS-12`) the branch or the
 * commit message mentions (spec «Поток Vercel»). Keyed by deployment and work
 * item, so a redelivered event adds nothing. Keys go one by one: at most `note.keyLimit`.
 */
export async function postDeployNotes(
	deps: { plane: PlaneApi; projectIdentifiers: () => Promise<ReadonlySet<string>> },
	note: DeployNote,
): Promise<DeployNoteResult[]> {
	if (note.texts.length === 0) return [];
	const keys = extractWorkItemKeys(note.texts, await deps.projectIdentifiers(), note.keyLimit);
	const results: DeployNoteResult[] = [];
	for (const key of keys) {
		const started = performance.now();
		const result = await postOne(deps.plane, note, key);
		results.push({ ...result, ms: Math.round(performance.now() - started) });
	}
	return results;
}

async function postOne(
	plane: PlaneApi,
	note: DeployNote,
	key: string,
): Promise<Omit<DeployNoteResult, 'ms'>> {
	try {
		const item = await plane.getWorkItemByKey(key);
		if (item === null) return { key, action: 'skipped', workItemId: null };
		const comment = await plane.createComment(item.project, item.id, {
			comment_html: noteHtml(note),
			external_id: `note:${note.deploymentId}:${key}`,
			external_source: note.source,
		});
		return { key, action: comment.created ? 'commented' : 'noop', workItemId: item.id };
	} catch (err) {
		// The bot is not a member of that project (403) or the item vanished (404): skip this key, keep the rest.
		if (err instanceof PlaneApiError && (err.status === 403 || err.status === 404)) {
			return { key, action: 'skipped', workItemId: null };
		}
		throw err;
	}
}

function noteHtml(note: DeployNote): string {
	const parts = [`Выкачено: <code>${esc(note.project)}</code> → ${esc(note.target)}`];
	if (note.sha) parts.push(`<code>${esc(note.sha.slice(0, 7))}</code>`);
	parts.push(link(note.url, note.url) ?? esc(note.url));
	return p(parts.join(' · '));
}
