// GitHub webhook deliveries (headers + body) as the webhook docs show them, built in one place.
// Hand-built to the docs; the captured deliveries live in test/fixtures.
import { createHmac } from 'node:crypto';

import { deploymentBody, deploymentStatusBody, pullBody } from './github-bodies.ts';

type Json = Record<string, unknown>;

export const APP_ID = 1_000_001;
export const INSTALLATION_ID = 42;
export const WEBHOOK_SECRET = 'gh-secret';
export const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

export type Delivery = { headers: Headers; raw: Uint8Array; text: string };

const repository = { id: 100, full_name: 'acme/api', name: 'api', owner: { login: 'acme' } };
const installation = { id: INSTALLATION_ID, node_id: 'MDIzOkluc3RhbGxhdGlvbjQy' };
const sender = { login: 'octocat', id: 1 };

export function sign(secret: string, raw: Uint8Array): string {
	return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

/** Headers GitHub sends with every delivery; `over` replaces or (with null) removes one. */
export function deliveryOf(
	event: string,
	payload: unknown,
	over: Record<string, string | null> = {},
): Delivery {
	const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
	const raw = new TextEncoder().encode(text);
	const base: Record<string, string> = {
		'content-type': 'application/json',
		'user-agent': 'GitHub-Hookshot/044aadd',
		'x-github-event': event,
		'x-github-delivery': DELIVERY_ID,
		'x-github-hook-id': '9001',
		'x-github-hook-installation-target-id': String(APP_ID),
		'x-github-hook-installation-target-type': 'integration',
		'x-hub-signature-256': sign(WEBHOOK_SECRET, raw),
	};
	const headers = new Headers();
	for (const [name, value] of Object.entries({ ...base, ...over })) {
		if (value !== null) headers.set(name, value);
	}
	return { headers, raw, text };
}

export function pullDelivery(
	action: string,
	pull: Json = {},
	extra: Json = {},
	over: Record<string, string | null> = {},
): Delivery {
	return deliveryOf(
		'pull_request',
		{
			action,
			number: 12,
			pull_request: pullBody(pull),
			repository,
			installation,
			sender,
			...extra,
		},
		over,
	);
}

export function deploymentStatusDelivery(state: string, deployment: Json = {}, status: Json = {}) {
	return deliveryOf('deployment_status', {
		action: 'created',
		deployment_status: deploymentStatusBody(state, status),
		deployment: deploymentBody(deployment),
		repository,
		installation,
		sender,
	});
}

export function installationDelivery(): Delivery {
	return deliveryOf('installation', {
		action: 'created',
		installation: { ...installation, app_id: APP_ID, account: { login: 'acme', id: 7 } },
		sender,
	});
}

export function pingDelivery(): Delivery {
	return deliveryOf('ping', {
		zen: 'Keep it logically awesome.',
		hook_id: 9001,
		hook: { type: 'App', id: 9001, active: true, events: ['pull_request'] },
		sender,
	});
}
