import { createHmac, timingSafeEqual } from 'node:crypto';

import { BadPayload, isRecord, optString } from '../payload.ts';
import type { Deployment, DeploymentState, Pull } from './client.ts';

export type PullAction =
	| 'opened'
	| 'reopened'
	| 'ready_for_review'
	| 'converted_to_draft'
	| 'closed'
	| 'edited';
export type GitHubEvent =
	| { kind: 'ping'; appId: number }
	| {
			kind: 'pull_request';
			appId: number;
			deliveryId: string;
			installationId: number;
			action: PullAction;
			pull: Pull;
	  }
	| {
			kind: 'deployment_status';
			appId: number;
			deliveryId: string;
			installationId: number;
			deployment: Deployment;
			state: DeploymentState;
			logUrl: string | null;
	  };

const PULL_ACTIONS: readonly string[] = [
	'opened',
	'reopened',
	'ready_for_review',
	'converted_to_draft',
	'closed',
	'edited',
];
const DEPLOYMENT_STATES: readonly string[] = [
	'success',
	'failure',
	'error',
	'inactive',
	'in_progress',
	'queued',
	'pending',
];
const SIGNATURE = /^sha256=[0-9a-f]{64}$/i;

/** `sha256=<64 hex>`; anything else → false. Constant-time. */
export function verifyGitHubSignature(
	secret: string,
	header: string | null,
	raw: Uint8Array,
): boolean {
	if (header === null || !SIGNATURE.test(header)) return false;
	const expected = createHmac('sha256', secret).update(raw).digest();
	return timingSafeEqual(expected, Buffer.from(header.slice('sha256='.length), 'hex'));
}

function bad(what: string): BadPayload {
	return new BadPayload(`github: ${what}`);
}

function positiveInt(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function record(parent: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = parent[key];
	if (!isRecord(value)) throw bad(`${key} is missing or not an object`);
	return value;
}

function text(parent: Record<string, unknown>, key: string, where: string): string {
	const value = optString(parent[key]);
	if (value === null) throw bad(`${where}.${key} is missing`);
	return value;
}

function repoOf(payload: Record<string, unknown>): string {
	const repo = text(record(payload, 'repository'), 'full_name', 'repository');
	if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw bad('repository.full_name is not owner/name');
	return repo;
}

function pullOf(repo: string, raw: Record<string, unknown>): Pull {
	const number = positiveInt(raw.number);
	if (number === null) throw bad('pull_request.number is missing');
	const head = record(raw, 'head');
	const base = record(raw, 'base');
	const merged = raw.merged === true;
	return {
		repo,
		number,
		url: text(raw, 'html_url', 'pull_request'),
		title: typeof raw.title === 'string' ? raw.title : '',
		body: typeof raw.body === 'string' ? raw.body : '',
		head: text(head, 'ref', 'pull_request.head'),
		base: text(base, 'ref', 'pull_request.base'),
		draft: raw.draft === true,
		state: raw.state === 'closed' ? 'closed' : 'open',
		merged,
		// GitHub fills merge_commit_sha with a throwaway test merge for an unmerged PR.
		mergeSha: merged ? optString(raw.merge_commit_sha) : null,
	};
}

function deploymentOf(repo: string, raw: Record<string, unknown>): Deployment {
	const id = positiveInt(raw.id);
	if (id === null) throw bad('deployment.id is missing');
	return {
		id,
		repo,
		sha: text(raw, 'sha', 'deployment'),
		environment: text(raw, 'environment', 'deployment'),
		// GitHub's schema makes the creator nullable; '' never equals a login.
		creator: isRecord(raw.creator) ? (optString(raw.creator.login) ?? '') : '',
		description: optString(raw.description),
	};
}

/** null — an event or action plane-hooks ignores (installation, labeled, synchronize, edited without a title change…). Throws BadPayload. */
export function parseGitHubDelivery(headers: Headers, raw: Uint8Array): GitHubEvent | null {
	const event = headers.get('x-github-event');
	if (event !== 'ping' && event !== 'pull_request' && event !== 'deployment_status') return null;

	const appHeader = headers.get('x-github-hook-installation-target-id') ?? '';
	const appId = /^\d+$/.test(appHeader) ? positiveInt(Number(appHeader)) : null;
	if (appId === null) throw bad('x-github-hook-installation-target-id is missing or not an id');

	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		throw bad('body is not JSON');
	}
	if (!isRecord(payload)) throw bad('body is not an object');
	if (event === 'ping') return { kind: 'ping', appId };

	if (event === 'pull_request') {
		const action = payload.action;
		if (typeof action !== 'string' || !PULL_ACTIONS.includes(action)) return null;
		if (action === 'edited') {
			const changes = payload.changes;
			if (!isRecord(changes) || changes.title === undefined) return null;
		}
	}

	const deliveryId = optString(headers.get('x-github-delivery'));
	if (deliveryId === null) throw bad('x-github-delivery is missing');
	const installationId = positiveInt(record(payload, 'installation').id);
	if (installationId === null) throw bad('installation.id is missing');
	const repo = repoOf(payload);

	if (event === 'pull_request') {
		return {
			kind: 'pull_request',
			appId,
			deliveryId,
			installationId,
			action: payload.action as PullAction,
			pull: pullOf(repo, record(payload, 'pull_request')),
		};
	}

	const status = record(payload, 'deployment_status');
	const state = status.state;
	if (typeof state !== 'string' || !DEPLOYMENT_STATES.includes(state)) {
		throw bad('deployment_status.state is not a known state');
	}
	return {
		kind: 'deployment_status',
		appId,
		deliveryId,
		installationId,
		deployment: deploymentOf(repo, record(payload, 'deployment')),
		state: state as DeploymentState,
		logUrl: optString(status.log_url),
	};
}
