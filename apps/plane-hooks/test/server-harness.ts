// The service as index.ts wires it — createRuntimes + createHandler on one Store — with FakePlane and
// FakeGitHub behind it, and requests signed the way each real sender signs them.
import { createHmac } from 'node:crypto';

import type { GitHubAppConfig, Tenant } from '../src/config.ts';
import type { GitHubApp } from '../src/github/app.ts';
import type { LogEntry } from '../src/log.ts';
import { createRuntimes, type Runtimes, type TenantRuntime } from '../src/runtime.ts';
import { createHandler } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { serviceConfigOf, tenantOf } from './config-fixture.ts';
import { FakeGitHub } from './fake-github.ts';
import { FakePlane } from './fake-plane.ts';
import { deploymentBody, deploymentStatusBody, pullBody } from './github-bodies.ts';
import { deliveryOf, INSTALLATION_ID } from './github-deliveries.ts';

export { serviceConfigOf, tenantOf } from './config-fixture.ts';

export const BASE = 'https://hooks.example.com';
export const APP_ID = 1_000_001;
export const GRAFANA_TOKEN = `ph_${'a'.repeat(48)}`;
export const VERCEL_SECRET = 'vercel-secret';
export const DOKPLOY_SECRET = 'dokploy-secret';
export const T0 = Date.parse('2026-10-28T12:00:00.000Z');

/** A GitHub App over one FakeGitHub: installed on every repo of its owner, healthy unless told otherwise. */
export function fakeApp(config: GitHubAppConfig, gh: FakeGitHub): GitHubApp & { calls: string[] } {
	const calls: string[] = [];
	return {
		config,
		calls,
		client: () => gh,
		installationFor: async (repo) => {
			calls.push(`installationFor ${repo}`);
			return repo.toLowerCase().startsWith(`${config.owner.toLowerCase()}/`)
				? INSTALLATION_ID
				: null;
		},
		health: async () => ({ appOk: true, failed: 0 }),
	};
}

export type World = ReturnType<typeof world>;

/**
 * One running service. `store` is shared when passed (a restart is a second world on the same Store or file);
 * the queue never waits between retries.
 */
export function world(
	options: { tenants?: Tenant[]; store?: Store; plane?: FakePlane; gh?: FakeGitHub } = {},
) {
	const plane = options.plane ?? FakePlane.delivery();
	const gh = options.gh ?? new FakeGitHub();
	const store = options.store ?? new Store(':memory:');
	const config = serviceConfigOf(options.tenants ?? [tenantOf()]);
	const logs: LogEntry[] = [];
	const sleeps: number[] = [];
	let clock = T0;
	const log = (entry: LogEntry) => logs.push(entry);
	const now = () => clock;
	const fetches: string[] = [];
	const fetch = async (input: string) => {
		fetches.push(input);
		return new Response('{}', { status: 500 });
	};
	const runtimes: Runtimes = createRuntimes(config, {
		store,
		log,
		now,
		plane: () => plane,
		githubApp: (app) => fakeApp(app, gh),
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	const handler = createHandler({ config, runtimes, log, now, fetch });
	const runtime = (id = 'acme') => runtimes.tenants.get(id) as TenantRuntime;
	return {
		plane,
		gh,
		store,
		config,
		runtimes,
		handler,
		logs,
		sleeps,
		fetches,
		runtime,
		/** The answer, after every job it queued has run. */
		send: async (req: Request) => {
			const res = await handler(req);
			await Promise.all([...runtimes.tenants.values()].map((r) => r.queue.idle()));
			return res;
		},
		idle: () => Promise.all([...runtimes.tenants.values()].map((r) => r.queue.idle())),
		advance: (ms: number) => {
			clock += ms;
		},
		/** Log lines of one event name. */
		lines: (event: string) => logs.filter((entry) => entry.event === event),
	};
}

let deliveries = 0;

/** A GitHub delivery to /hooks/github signed with the App's webhook secret; `delivery` — x-github-delivery. */
export function githubRequest(
	event: string,
	body: unknown,
	appId: number = APP_ID,
	over: Record<string, string | null> = {},
): Request {
	const d = deliveryOf(event, body, {
		'x-github-hook-installation-target-id': String(appId),
		'x-github-delivery': `delivery-${++deliveries}`,
		...over,
	});
	return new Request(`${BASE}/hooks/github`, { method: 'POST', headers: d.headers, body: d.raw });
}

const repository = { id: 100, full_name: 'acme/api', name: 'api', owner: { login: 'acme' } };
const installation = { id: INSTALLATION_ID };
const sender = { login: 'octocat', id: 1 };

/** A `pull_request` payload of acme/api with the PR fields replaced by `pull`. */
export function pullPayload(action: string, pull: Record<string, unknown> = {}) {
	const body = pullBody(pull);
	return { action, number: body.number, pull_request: body, repository, installation, sender };
}

/** A `deployment_status` payload of acme/api. */
export function statusPayload(
	state: string,
	deployment: Record<string, unknown> = {},
	status: Record<string, unknown> = {},
) {
	return {
		action: 'created',
		deployment_status: deploymentStatusBody(state, status),
		deployment: deploymentBody(deployment),
		repository,
		installation,
		sender,
	};
}

/** A string or bytes as they are (raw bodies, fixtures); anything else as JSON. */
const json = (body: unknown): string | Uint8Array =>
	typeof body === 'string' || body instanceof Uint8Array
		? body
		: new TextEncoder().encode(JSON.stringify(body));

export function grafanaRequest(
	tenant: string,
	body: unknown,
	authorization: string | null = `Bearer ${GRAFANA_TOKEN}`,
	headers: Record<string, string> = {},
): Request {
	const all: Record<string, string> = { 'content-type': 'application/json', ...headers };
	if (authorization !== null) all.authorization = authorization;
	return new Request(`${BASE}/hooks/${tenant}/grafana`, {
		method: 'POST',
		headers: all,
		body: json(body),
	});
}

/** Signed like Vercel: hex HMAC-SHA1 of the raw body; `signature` null drops the header. */
export function vercelRequest(
	tenant: string,
	body: unknown,
	signature?: string | null,
	headers: Record<string, string> = {},
): Request {
	const raw = json(body);
	const all: Record<string, string> = { 'content-type': 'application/json', ...headers };
	const sig =
		signature === undefined
			? createHmac('sha1', VERCEL_SECRET).update(raw).digest('hex')
			: signature;
	if (sig !== null) all['x-vercel-signature'] = sig;
	return new Request(`${BASE}/hooks/${tenant}/vercel`, { method: 'POST', headers: all, body: raw });
}

/** Dokploy's Custom notification: the static `Authorization: Bearer <secret>` header. */
export function dokployRequest(
	tenant: string,
	body: unknown,
	authorization: string | null = `Bearer ${DOKPLOY_SECRET}`,
): Request {
	const all: Record<string, string> = { 'content-type': 'application/json' };
	if (authorization !== null) all.authorization = authorization;
	return new Request(`${BASE}/hooks/${tenant}/dokploy`, {
		method: 'POST',
		headers: all,
		body: json(body),
	});
}

export const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
