import { createHash, timingSafeEqual } from 'node:crypto';

import { type Fetch, planeOauthCallback, planeSetupRedirect } from '@alxwlw/plane-app';

import { DEFAULT_PRIORITY, type InputName, type ServiceConfig } from './config.ts';
import { vercelDeployFact } from './delivery/preview.ts';
import { parseDokployWebhook, verifyDokploy } from './dokploy.ts';
import { githubCallback, githubSetupPage } from './github/setup.ts';
import { parseGitHubDelivery, verifyGitHubSignature } from './github/webhook.ts';
import { parseGrafanaWebhook } from './grafana.ts';
import { deployAnnotation, incidentAnnotation, reportLogged, resolveBestEffort } from './jobs.ts';
import { describeError, type Log } from './log.ts';
import { BadPayload } from './payload.ts';
import { PLANE_HOOKS_SCOPES } from './plane.ts';
import type { Runtimes, TenantRuntime } from './runtime.ts';
import { isVercelSignatureShaped, parseVercelEvent, verifyVercelSignature } from './vercel.ts';

/** The largest body any input accepts; bigger is 413. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** An App id as GitHub sends it in x-github-hook-installation-target-id: decimal digits, no sign or exponent. */
const APP_ID = /^[1-9][0-9]{0,15}$/;
const TENANT_HOOK = /^\/hooks\/([^/]+)\/(grafana|vercel|dokploy)$/;
/** A GitHub login: an organisation or a user account. */
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export type HandlerDeps = {
	config: ServiceConfig;
	runtimes: Runtimes;
	log: Log;
	now: () => number;
	fetch: Fetch;
};

/**
 * HTTP surface of plane-hooks. GitHub deliveries are saved to the inbox and answered 202 at once; the
 * incident parts of Grafana, Vercel and Dokploy run synchronously and answer 502 on a Plane failure, so the
 * sender retries (every write is idempotent); the rest of Vercel and Dokploy goes through the inbox too.
 * A disabled input, an unknown tenant and an unknown App answer 404 before the body is read, with no log line.
 */
export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
	const { config, runtimes, log } = deps;

	/** Refused after authentication: the sender does not retry a 4xx, so this line is the only trace. */
	function rejected(
		runtime: TenantRuntime,
		input: InputName | 'github',
		status: 400 | 413,
		error: string,
		answer: string = error,
	): Response {
		log({
			event: 'delivery.rejected',
			level: 'error',
			tenant: runtime.tenant.id,
			input,
			status,
			error,
		});
		return text(status, answer);
	}

	async function github(req: Request): Promise<Response> {
		if (req.method !== 'POST') return text(405, 'method not allowed');
		// The one place the App id header is parsed: it picks the App, and so the secret of the signature.
		const header = req.headers.get('x-github-hook-installation-target-id') ?? '';
		const entry = APP_ID.test(header) ? runtimes.apps.get(Number(header)) : undefined;
		if (entry === undefined) return text(404, 'not found');
		// 413 and 401 come before authentication: anyone can produce them, so they stay unlogged.
		const raw = await readBody(req);
		if (raw === null) return text(413, 'payload too large');
		const { app, runtime } = entry;
		if (
			!verifyGitHubSignature(app.config.webhookSecret, req.headers.get('x-hub-signature-256'), raw)
		)
			return text(401, 'unauthorized');
		runtime.lastDelivery.set('github', deps.now());
		let event: ReturnType<typeof parseGitHubDelivery>;
		try {
			event = parseGitHubDelivery(req.headers, raw, app.config.appId);
		} catch (err) {
			if (err instanceof BadPayload)
				return rejected(runtime, 'github', 400, describeError(err), err.message);
			throw err;
		}
		if (event === null) return text(200, 'ignored');
		if (event.kind === 'ping') {
			log({ event: 'github.ping', tenant: runtime.tenant.id, app: app.config.name });
			return text(200, 'ok');
		}
		const accepted = runtime.submit('github', event.deliveryId, event);
		log({
			event: accepted ? 'delivery.accepted' : 'delivery.duplicate',
			tenant: runtime.tenant.id,
			input: 'github',
			kind: event.kind,
			delivery: event.deliveryId,
		});
		// GitHub waits 10 s for an answer and never retries on its own: the work runs after the answer.
		return accepted ? text(202, 'accepted') : text(200, 'duplicate');
	}

	async function grafana(runtime: TenantRuntime, body: unknown): Promise<Response> {
		const table = runtime.tenant.incidents?.priority ?? DEFAULT_PRIORITY;
		const signals = parseGrafanaWebhook(body, table);
		let failed = 0;
		for (const signal of signals) {
			const reported = await reportLogged(
				runtime,
				signal,
				`alert.${signal.status}`,
				log,
				incidentAnnotation(signal),
			);
			if (!reported.ok) failed++;
		}
		return failed === 0
			? text(200, 'ok')
			: text(502, `plane: ${failed} of ${signals.length} alerts failed`);
	}

	async function vercel(runtime: TenantRuntime, body: unknown): Promise<Response> {
		const event = parseVercelEvent(body);
		const tenant = runtime.tenant.id;
		switch (event.kind) {
			case 'ignored':
				log({ event: 'vercel.ignored', tenant, type: event.type });
				return text(200, 'ignored');
			case 'failed':
			case 'succeeded': {
				const signal = event.kind === 'failed' ? event.signal : event.resolve;
				const reported = await reportLogged(
					runtime,
					signal,
					event.kind === 'failed' ? 'deployment.error' : 'deployment.succeeded',
					log,
					deployAnnotation(event.summary),
				);
				return reported.ok ? text(200, 'ok') : text(502, 'plane failed');
			}
			case 'preview': {
				// The preview comment never waits for «Погас»: queued first, the resolve is best effort.
				runtime.submit('vercel.preview', null, event.preview);
				await resolveBestEffort(runtime, event.resolve, 'deployment.succeeded', log);
				return text(200, 'ok');
			}
			case 'promoted':
			case 'rolled_back': {
				// The documented rollback body has no commit, only the target deployment id; resolving it takes a
				// Vercel API key, which the hub does not hold. Nothing changes in Plane.
				if (event.kind === 'rolled_back' && event.sha === null) {
					log({
						event: 'vercel.rollback.unresolved',
						level: 'warn',
						tenant,
						project: event.project,
						toDeploymentId: event.toDeploymentId ?? null,
					});
					return text(200, 'ignored');
				}
				let fact: Awaited<ReturnType<typeof vercelDeployFact>> = null;
				try {
					const client = event.repo === null ? null : await runtime.sync.github(event.repo);
					fact = client === null ? null : await vercelDeployFact(client, event);
				} catch (err) {
					log({
						event: 'vercel.switch',
						level: 'error',
						tenant,
						kind: event.kind,
						error: describeError(err),
					});
					return text(502, 'github failed');
				}
				if (fact === null) {
					// A rollback carries no sha in the Vercel docs; a deploy GitHub has no record of is none either.
					log({
						event: 'vercel.switch',
						level: 'warn',
						tenant,
						kind: event.kind,
						project: event.project,
						action: 'no_deploy',
					});
					return text(200, 'ignored');
				}
				runtime.submit('vercel.deploy', null, fact);
				return text(200, 'ok');
			}
		}
	}

	async function dokploy(runtime: TenantRuntime, body: unknown): Promise<Response> {
		const event = parseDokployWebhook(body);
		switch (event.kind) {
			case 'ignored':
				log({ event: 'dokploy.ignored', tenant: runtime.tenant.id, type: event.type });
				return text(200, 'ignored');
			case 'failed':
			case 'resolved': {
				const signal = event.kind === 'failed' ? event.signal : event.resolve;
				const reported = await reportLogged(runtime, signal, `dokploy.${event.kind}`, log);
				return reported.ok ? text(200, 'ok') : text(502, 'plane failed');
			}
			case 'deployed': {
				// The Deployment record never waits for «Погас»: queued first, the resolve is best effort.
				runtime.submit('dokploy.deployed', null, event);
				await resolveBestEffort(runtime, event.resolve, 'dokploy.deployed', log);
				return text(200, 'ok');
			}
		}
	}

	async function tenantHook(req: Request, id: string, input: InputName): Promise<Response> {
		const runtime = runtimes.tenants.get(id);
		const secret = runtime?.tenant.inputs[input] ?? null;
		// Indistinguishable from an unknown path: before method, authentication, body and log.
		if (runtime === undefined || secret === null) return text(404, 'not found');
		if (req.method !== 'POST') return text(405, 'method not allowed');
		// What can be checked without the body is checked first: an unauthenticated body is never buffered.
		if (input === 'grafana' && !bearerMatches(req.headers.get('authorization'), secret))
			return text(401, 'unauthorized');
		if (input === 'dokploy' && !verifyDokploy(req.headers, secret))
			return text(401, 'unauthorized');
		const signature = req.headers.get('x-vercel-signature');
		if (input === 'vercel' && !isVercelSignatureShaped(signature)) return text(401, 'unauthorized');
		const raw = await readBody(req);
		// Vercel's 413 comes before its HMAC (which needs the body): unauthenticated, so unlogged.
		if (raw === null)
			return input === 'vercel'
				? text(413, 'payload too large')
				: rejected(runtime, input, 413, 'payload too large');
		if (input === 'vercel' && !verifyVercelSignature(raw, signature, secret))
			return text(401, 'unauthorized');
		runtime.lastDelivery.set(input, deps.now());
		let body: unknown;
		try {
			body = JSON.parse(new TextDecoder().decode(raw));
		} catch {
			return rejected(runtime, input, 400, 'invalid json');
		}
		try {
			if (input === 'grafana') return await grafana(runtime, body);
			if (input === 'vercel') return await vercel(runtime, body);
			return await dokploy(runtime, body);
		} catch (err) {
			if (err instanceof BadPayload)
				return rejected(runtime, input, 400, describeError(err), err.message);
			throw err;
		}
	}

	async function page(url: URL): Promise<Response> {
		const tenantOf = () => runtimes.tenants.get(url.searchParams.get('tenant') ?? '')?.tenant;
		const nowSeconds = Math.floor(deps.now() / 1000);
		switch (url.pathname) {
			case '/plane/setup': {
				const tenant = tenantOf();
				if (tenant === undefined) return text(404, 'not found');
				return planeSetupRedirect({
					planeUrl: config.planeUrl,
					publicUrl: config.publicUrl,
					clientId: tenant.plane.clientId,
					scopes: PLANE_HOOKS_SCOPES,
				});
			}
			case '/plane/oauth/callback':
				return planeOauthCallback(url, log);
			case '/github/setup': {
				const tenant = tenantOf();
				if (tenant === undefined) return text(404, 'not found');
				const owner = url.searchParams.get('owner') ?? '';
				const kind = url.searchParams.get('kind');
				if (!GITHUB_OWNER.test(owner) || (kind !== 'org' && kind !== 'user')) {
					return text(
						400,
						'Нужны параметры owner (организация или аккаунт GitHub) и kind=org|user: /github/setup?tenant=<id>&owner=<login>&kind=org\n',
					);
				}
				return githubSetupPage({ publicUrl: config.publicUrl, tenant, owner, kind, nowSeconds });
			}
			case '/github/callback':
				return githubCallback(url, { tenants: config.tenants, fetch: deps.fetch, nowSeconds, log });
			default:
				return text(404, 'not found');
		}
	}

	return async (req) => {
		const url = new URL(req.url);
		const { pathname } = url;
		if (pathname === '/healthz')
			return req.method === 'GET' ? text(200, 'ok') : text(405, 'method not allowed');
		if (pathname === '/hooks/github') return github(req);
		const hook = TENANT_HOOK.exec(pathname);
		if (hook !== null) return tenantHook(req, hook[1] as string, hook[2] as InputName);
		// Plane App deliveries are not used: answered 200 unread, so Plane never disables the webhook.
		if (pathname === '/plane/webhook')
			return req.method === 'POST' ? text(200, 'ok') : text(405, 'method not allowed');
		if (
			pathname !== '/plane/setup' &&
			pathname !== '/plane/oauth/callback' &&
			pathname !== '/github/setup' &&
			pathname !== '/github/callback'
		)
			return text(404, 'not found');
		if (req.method !== 'GET') return text(405, 'method not allowed');
		return page(url);
	};
}

/** The body, or null when it is (or declares to be) over MAX_BODY_BYTES. */
async function readBody(req: Request): Promise<Uint8Array | null> {
	const declared = Number(req.headers.get('content-length') ?? 0);
	if (declared > MAX_BODY_BYTES) return null;
	const raw = new Uint8Array(await req.arrayBuffer());
	return raw.byteLength > MAX_BODY_BYTES ? null : raw;
}

/** Constant-time check of `Authorization: Bearer <token>`; hashing first makes both sides the same length. */
function bearerMatches(header: string | null, token: string): boolean {
	if (header === null || !header.startsWith('Bearer ')) return false;
	const presented = header.slice('Bearer '.length);
	return timingSafeEqual(
		createHash('sha256').update(presented).digest(),
		createHash('sha256').update(token).digest(),
	);
}

export function text(status: number, body: string): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
