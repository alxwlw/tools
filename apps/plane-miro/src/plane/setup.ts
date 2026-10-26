// Copy of apps/plane-discord/src/plane/setup.ts; keep in sync until a shared package exists.
import type { Config } from '../config.ts';
import type { Log } from '../log.ts';
import { PLANE_SCOPES } from './auth.ts';

// What Plane puts in app_installation_id (a UUID); anything else is not echoed, not logged.
const INSTALLATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

const text = (body: string, status: number): Response =>
	new Response(body, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
	});

/** GET /plane/setup?tenant=<id> → 302 to the Plane consent screen; unknown tenant → 404. */
export function setupRedirect(config: Config, url: URL): Response {
	const id = url.searchParams.get('tenant');
	const tenant = config.tenants.find((t) => t.id === id);
	if (tenant === undefined) return text('not found', 404);
	// Plane v3.3.0 answers invalid_scope without `scope` (design §10); %20, not '+', between scopes.
	const params: Array<[string, string]> = [
		['client_id', tenant.auth.clientId],
		['response_type', 'code'],
		['redirect_uri', `${config.publicUrl}/plane/oauth/callback`],
		['scope', PLANE_SCOPES.join(' ')],
	];
	const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
	return new Response(null, {
		status: 302,
		headers: { location: `${config.planeUrl}/auth/o/authorize-app/?${query}` },
	});
}

/**
 * GET /plane/oauth/callback → 200 text/plain echoing app_installation_id for tenants.json; logs plane.installed.
 * Exchanges nothing: the `code` parameter is neither read nor logged. No id → 400.
 */
export function oauthCallback(url: URL, log: Log): Response {
	const id = url.searchParams.get('app_installation_id');
	if (id === null || !INSTALLATION_ID.test(id)) return text('app_installation_id is missing', 400);
	log({ event: 'plane.installed', appInstallationId: id });
	return text(`app_installation_id=${id}\n`, 200);
}
