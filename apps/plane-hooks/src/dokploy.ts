import { createHash, timingSafeEqual } from 'node:crypto';

import type { Tenant } from './config.ts';
import type { GitHubApi } from './github/client.ts';
import { esc, link, p, truncate } from './html.ts';
import type { IncidentSignal } from './incident.ts';
import { BadPayload, isRecord, optString } from './payload.ts';

/** GitHub rejects a deployment description over 140 characters. */
const DESCRIPTION_MAX = 140;
const ERROR_MAX = 2000;
const TEST_TITLE = 'Test Notification';
const BACKUP_TITLE = /^(?:Database|Volume) Backup (?:Successful|Failed)$/;

export type DokployEvent =
	| { kind: 'deployed'; app: string; at: string; url: string | null; resolve: IncidentSignal }
	| { kind: 'failed'; signal: IncidentSignal }
	/** A backup that works again: only the incident is closed, there is nothing to record on GitHub. */
	| { kind: 'resolved'; resolve: IncidentSignal }
	| { kind: 'ignored'; type: string };

/** Constant-time check of the static `Authorization: Bearer <secret>` header of Dokploy's Custom notification. */
export function verifyDokploy(headers: Headers, secret: string): boolean {
	const header = headers.get('authorization');
	if (header === null || !header.startsWith('Bearer ')) return false;
	// Hashing first makes both sides the same length for timingSafeEqual.
	return timingSafeEqual(
		createHash('sha256').update(header.slice('Bearer '.length)).digest(),
		createHash('sha256').update(secret).digest(),
	);
}

/**
 * Body of Dokploy's Custom notification → what plane-hooks does about it. The body is flat, every value a
 * string, and carries no commit, branch or repository. There is no uniform event field: a build is
 * `type: "build"` with `status`, a backup is told by its `title` and succeeds or fails by `status`.
 * Throws BadPayload on a body Dokploy would not send.
 */
export function parseDokployWebhook(body: unknown): DokployEvent {
	if (!isRecord(body)) throw new BadPayload('dokploy: body is not an object');
	const title = optString(body.title) ?? '';
	const status = optString(body.status);
	const type = optString(body.type);

	if (BACKUP_TITLE.test(title)) return backup(body, title, status);
	if (type === 'build' && (status === 'success' || status === 'error')) return build(body, status);
	// The Test button of the Custom notification sends only {title, message, timestamp}: no type, no status.
	if (title === TEST_TITLE) return { kind: 'ignored', type: 'test' };
	const kind = optString(body.alertType) ?? type;
	if (kind === null) throw new BadPayload('dokploy: no event type');
	return { kind: 'ignored', type: kind };
}

function build(body: Record<string, unknown>, status: 'success' | 'error'): DokployEvent {
	const app = optString(body.applicationName);
	if (app === null) throw new BadPayload(`dokploy: build ${status} without applicationName`);
	const at = timestampOf(body);
	const key = `dokploy:${app}:build`;
	const buildLink = optString(body.buildLink);
	const url = buildLink !== null && /^https?:\/\//i.test(buildLink) ? buildLink : null;
	if (status === 'success') {
		return {
			kind: 'deployed',
			app,
			at,
			url,
			resolve: {
				status: 'resolved',
				source: 'dokploy',
				key,
				at,
				noteHtml: p(`Сборка снова проходит: <code>${esc(app)}</code>`),
			},
		};
	}
	const project = optString(body.projectName);
	const detail = link(url, 'Деплои в Dokploy');
	return {
		kind: 'failed',
		signal: {
			status: 'firing',
			source: 'dokploy',
			key,
			occurrence: at,
			at,
			title: truncate(`Сборка упала: ${app}`, 200),
			bodyHtml: [
				p(
					`Приложение: <code>${esc(app)}</code>${project ? `, проект: <code>${esc(project)}</code>` : ''}`,
				),
				errorBlock(body.errorMessage),
				detail ? p(detail) : '',
			].join(''),
			noteHtml: p(`Сборка упала: <code>${esc(app)}</code>`),
			priority: 'high',
			label: 'deploy-failed',
		},
	};
}

function backup(body: Record<string, unknown>, title: string, status: string | null): DokployEvent {
	const app = optString(body.applicationName);
	if (app === null) throw new BadPayload(`dokploy: ${title} without applicationName`);
	if (status !== 'success' && status !== 'error')
		throw new BadPayload(`dokploy: ${title} with an unknown status`);
	const volume = title.startsWith('Volume');
	const part = optString(volume ? body.volumeName : body.databaseName);
	const name = part === null ? app : `${app}/${part}`;
	const key = `dokploy:${name}:backup`;
	const at = timestampOf(body);
	if (status === 'success') {
		return {
			kind: 'resolved',
			resolve: {
				status: 'resolved',
				source: 'dokploy',
				key,
				at,
				noteHtml: p(`Бэкап снова проходит: <code>${esc(name)}</code>`),
			},
		};
	}
	return {
		kind: 'failed',
		signal: {
			status: 'firing',
			source: 'dokploy',
			key,
			occurrence: at,
			at,
			title: truncate(`Бэкап упал: ${name}`, 200),
			bodyHtml: [
				p(`${volume ? 'Том' : 'База'}: <code>${esc(name)}</code>`),
				errorBlock(body.errorMessage),
			].join(''),
			noteHtml: p(`Бэкап упал: <code>${esc(name)}</code>`),
			priority: 'high',
			label: 'alert',
		},
	};
}

function errorBlock(value: unknown): string {
	const text = optString(value);
	return text === null ? '' : p(`<code>${esc(truncate(text, ERROR_MAX))}</code>`);
}

/** The event's own time: it orders deploys and names one firing, so a missing or unparseable one is a bad payload. */
function timestampOf(body: Record<string, unknown>): string {
	const raw = optString(body.timestamp);
	const date = new Date(raw ?? Number.NaN);
	if (Number.isNaN(date.getTime()))
		throw new BadPayload('dokploy: event without a valid timestamp');
	return date.toISOString();
}

/**
 * Records a successful deploy as a GitHub Deployment plus a success status. Dokploy's notification names no
 * commit, so the sha is the head of the app's branch at notification time, read through the tenant's App;
 * the description says so. Public repositories are never written to (a deploy record there would publish it): a visibility that is not
 * private/internal, or unknown, stops before any write.
 * `github` — as SyncDeps.github: the tenant's App client for the repo, null — no App covers it.
 */
export async function recordDokployDeploy(
	deps: { tenant: Tenant; github: (repo: string) => Promise<GitHubApi | null> },
	event: Extract<DokployEvent, { kind: 'deployed' }>,
): Promise<{
	action: 'recorded' | 'unmapped' | 'no_sha' | 'public_repo' | 'no_app';
	deploymentId?: number;
}> {
	const rule = deps.tenant.dokploy.find((app) => app.name === event.app);
	if (rule === undefined) return { action: 'unmapped' };
	const github = await deps.github(rule.repo);
	if (github === null) return { action: 'no_app' };
	const visibility = await github.repoVisibility(rule.repo);
	if (visibility === null) return { action: 'no_app' };
	if (visibility === 'public') return { action: 'public_repo' };
	const sha = await github.branchHead(rule.repo, rule.branch);
	if (sha === null) return { action: 'no_sha' };
	const deploymentId = await github.createDeployment(rule.repo, {
		sha,
		environment: rule.environment,
		description: truncate(`голова ${rule.branch} в момент уведомления Dokploy`, DESCRIPTION_MAX),
	});
	await github.createDeploymentStatus(rule.repo, deploymentId, 'success', event.url);
	return { action: 'recorded', deploymentId };
}
