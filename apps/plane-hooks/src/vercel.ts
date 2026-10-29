import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { esc, link, p, truncate } from './html.ts';
import type { IncidentSignal } from './incident.ts';
import { BadPayload, isRecord, optString } from './payload.ts';

const TITLE_MAX = 200;
const BRANCH_MAX = 80;

export type DeployTarget = 'production' | 'staging' | 'preview';
/** What the Grafana annotation of one Vercel deploy shows. */
export type DeploySummary = { title: string; env: string; sha?: string };

/** 40 hex digits — the only shape an HMAC-SHA1 signature can take; anything else fails before the body is read. */
export function isVercelSignatureShaped(header: string | null): header is string {
	return header !== null && /^[0-9a-f]{40}$/i.test(header);
}

/** `x-vercel-signature` is the hex HMAC-SHA1 of the raw body keyed with the webhook secret (Vercel «Securing webhooks»). */
export function verifyVercelSignature(
	raw: Uint8Array,
	header: string | null,
	secret: string,
): boolean {
	if (!isVercelSignatureShaped(header)) return false;
	const expected = createHmac('sha1', secret).update(raw).digest();
	return timingSafeEqual(expected, Buffer.from(header, 'hex'));
}

export type VercelPreview = {
	/** The Vercel project name (`payload.deployment.name`). */
	project: string;
	/** `<org>/<repo>` from the deployment meta; null for a deploy without git metadata. */
	repo: string | null;
	branch: string | null;
	url: string;
	sha: string | null;
};
/** What a Vercel delivery means for plane-hooks: GitHub Deployments carry the deploys, Vercel adds the rest. */
export type VercelHookEvent =
	| { kind: 'failed'; signal: IncidentSignal; summary: DeploySummary }
	| { kind: 'succeeded'; resolve: IncidentSignal; summary: DeploySummary }
	| { kind: 'preview'; preview: VercelPreview; resolve: IncidentSignal }
	| {
			kind: 'promoted' | 'rolled_back';
			project: string;
			repo: string | null;
			sha: string | null;
			/** When the event itself happened (its own `createdAt`): the order of deploys on an environment. */
			at: string;
			url: string | null;
			/** Rollback only: the deployment Vercel restores. The documented body carries no sha, only this id. */
			toDeploymentId?: string;
	  }
	| { kind: 'ignored'; type: string };

/**
 * Vercel account webhook → the part of it GitHub does not already tell. deployment.error opens or extends an
 * incident keyed by project + target + branch; deployment.succeeded resolves it (a preview additionally yields the
 * preview link); promote and rollback become `promoted` / `rolled_back` for the deploy path. Other types are
 * ignored. Throws BadPayload on a body Vercel would not send.
 *
 * Seen live (observed on a live preview redeploy): `payload.target` is null for a preview, `meta.githubCommitOrg` /
 * `githubCommitRepo` / `githubCommitRef` / `githubCommitSha` are present, `meta.githubPrId` is a string, and
 * `deployment.created` arrives before `deployment.succeeded` (it is ignored). promote and rollback were not captured.
 */
export function parseVercelEvent(body: unknown): VercelHookEvent {
	if (!isRecord(body)) throw new BadPayload('vercel: body is not an object');
	const type = optString(body.type);
	if (type === null) throw new BadPayload('vercel: no event type');
	if (type === 'deployment.promoted' || type === 'deployment.rollback')
		return parseSwitch(body, type === 'deployment.promoted' ? 'promoted' : 'rolled_back');
	if (type !== 'deployment.error' && type !== 'deployment.succeeded')
		return { kind: 'ignored', type };

	const payload = isRecord(body.payload) ? body.payload : {};
	const deployment = isRecord(payload.deployment) ? payload.deployment : {};
	const project = isRecord(payload.project) ? payload.project : {};
	const deploymentId = optString(deployment.id);
	const projectId = optString(project.id);
	const name = optString(deployment.name);
	const host = optString(deployment.url);
	if (deploymentId === null || projectId === null || name === null || host === null) {
		throw new BadPayload(`vercel: ${type} without deployment id/name/url or project id`);
	}

	const meta = isRecord(deployment.meta) ? deployment.meta : {};
	const ref = optString(meta.githubCommitRef);
	const branch = ref ?? 'unknown';
	const sha = optString(meta.githubCommitSha) ?? undefined;
	const sha7 = sha?.slice(0, 7);
	const message = optString(meta.githubCommitMessage);
	const target = deployTarget(payload.target);
	const inspector = optString(isRecord(payload.links) ? payload.links.deployment : undefined);
	const url = /^https?:\/\//i.test(host) ? host : `https://${host}`;
	const key = `deploy:${projectId}:${target}:${branchKey(branch)}`;
	const at = timestamp(body.createdAt);
	const label = sha7 ?? deploymentId;

	if (type === 'deployment.error') {
		const links = [link(inspector, 'Инспектор Vercel'), link(url, url)].filter(
			(html): html is string => html !== null,
		);
		return {
			kind: 'failed',
			signal: {
				status: 'firing',
				source: 'vercel',
				key,
				occurrence: deploymentId,
				at,
				title: truncate(`Деплой упал: ${name} (${target}) · ${branch}`, TITLE_MAX),
				bodyHtml: [
					p(
						`Проект: <code>${esc(name)}</code>, окружение: <code>${target}</code>, ветка: <code>${esc(branch)}</code>`,
					),
					sha ? p(`Коммит: <code>${esc(sha)}</code>`) : '',
					message ? p(esc(message)) : '',
					links.length > 0 ? p(links.join(' · ')) : '',
				].join(''),
				noteHtml: p(
					`Деплой упал: ${link(inspector, deploymentId) ?? `<code>${esc(deploymentId)}</code>`}${sha7 ? ` · <code>${esc(sha7)}</code>` : ''}`,
				),
				priority: target === 'production' ? 'high' : 'medium',
				label: 'deploy-failed',
			},
			summary: { title: `✗ ${name} → ${target} упал · ${label}`, env: target, sha },
		};
	}

	const resolve: IncidentSignal = {
		status: 'resolved',
		source: 'vercel',
		key,
		at,
		noteHtml: p(`Деплой снова проходит: <code>${esc(sha7 ?? deploymentId)}</code>`),
	};
	if (target !== 'preview')
		return {
			kind: 'succeeded',
			resolve,
			summary: { title: `${name} → ${target} · ${label}`, env: target, sha },
		};
	return {
		kind: 'preview',
		preview: { project: name, repo: repoOf(meta), branch: ref, url, sha: sha ?? null },
		resolve,
	};
}

/**
 * promote / rollback: fields per the Vercel webhook docs (not captured live); a rollback event carries no
 * `payload.deployment` there, only `fromDeploymentId` / `toDeploymentId`, so without a Vercel API key its sha is unknown.
 */
function parseSwitch(
	body: Record<string, unknown>,
	kind: 'promoted' | 'rolled_back',
): Extract<VercelHookEvent, { kind: 'promoted' | 'rolled_back' }> {
	const payload = isRecord(body.payload) ? body.payload : {};
	const deployment = isRecord(payload.deployment) ? payload.deployment : {};
	const projectId = optString(isRecord(payload.project) ? payload.project.id : undefined);
	const name = optString(deployment.name);
	const host = optString(deployment.url);
	if (kind === 'promoted') {
		if (optString(deployment.id) === null || name === null)
			throw new BadPayload('vercel: deployment.promoted without deployment id or name');
	} else if (optString(payload.toDeploymentId) === null || (projectId === null && name === null)) {
		throw new BadPayload('vercel: deployment.rollback without toDeploymentId or project');
	}
	const meta = metaOf(body);
	const toDeploymentId = optString(payload.toDeploymentId);
	return {
		kind,
		project: (name ?? projectId) as string,
		repo: repoOf(meta),
		sha: optString(meta.githubCommitSha),
		at: eventTime(body.createdAt),
		url: host === null ? null : /^https?:\/\//i.test(host) ? host : `https://${host}`,
		...(kind === 'rolled_back' && toDeploymentId !== null ? { toDeploymentId } : {}),
	};
}

function metaOf(body: unknown): Record<string, unknown> {
	const payload = isRecord(body) && isRecord(body.payload) ? body.payload : {};
	const deployment = isRecord(payload.deployment) ? payload.deployment : {};
	return isRecord(deployment.meta) ? deployment.meta : {};
}

function repoOf(meta: Record<string, unknown>): string | null {
	const org = optString(meta.githubCommitOrg);
	const repo = optString(meta.githubCommitRepo);
	return org === null || repo === null ? null : `${org}/${repo}`;
}

/** The event's own time — it orders deploys, so a missing or unparseable one is a bad payload, not «now». */
function eventTime(value: unknown): string {
	const date =
		typeof value === 'number' || typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
	if (Number.isNaN(date.getTime())) throw new BadPayload('vercel: event without a valid createdAt');
	return date.toISOString();
}

function deployTarget(value: unknown): DeployTarget {
	return value === 'production' || value === 'staging' ? value : 'preview';
}

/** Plane caps external_id at 255 characters: a long branch name is replaced by a short hash of itself. */
function branchKey(branch: string): string {
	return branch.length > BRANCH_MAX
		? createHash('sha256').update(branch).digest('hex').slice(0, 16)
		: branch;
}

/** Vercel documents createdAt as epoch ms; ISO strings are accepted too. Anything else → receipt time: the value is informational. */
function timestamp(value: unknown): string {
	const date =
		typeof value === 'number' || typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
	return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
