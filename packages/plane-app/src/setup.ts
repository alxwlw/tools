// Adapted from apps/plane-discord/src/plane/setup.ts: the scopes, URLs and client id are parameters.

// What Plane puts in app_installation_id (a UUID); anything else is not echoed, not logged.
const INSTALLATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

const text = (body: string, status: number): Response =>
	new Response(body, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
	});

/** 302 to the Plane consent screen of the app. */
export function planeSetupRedirect(opts: {
	planeUrl: string;
	publicUrl: string;
	clientId: string;
	scopes: readonly string[];
}): Response {
	// Plane v3.3.0 answers invalid_scope without `scope`; %20, not '+', between scopes.
	const params: Array<[string, string]> = [
		['client_id', opts.clientId],
		['response_type', 'code'],
		['redirect_uri', `${opts.publicUrl}/plane/oauth/callback`],
		['scope', opts.scopes.join(' ')],
	];
	const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
	return new Response(null, {
		status: 302,
		headers: { location: `${opts.planeUrl}/auth/o/authorize-app/?${query}` },
	});
}

/**
 * GET /plane/oauth/callback → 200 text/plain echoing app_installation_id for the tenant config; logs plane.installed.
 * Exchanges nothing: the `code` parameter is neither read nor logged. No valid id → 400.
 */
export function planeOauthCallback(
	url: URL,
	log: (entry: { event: 'plane.installed'; appInstallationId: string }) => void,
): Response {
	const id = url.searchParams.get('app_installation_id');
	if (id === null || !INSTALLATION_ID.test(id)) return text('app_installation_id is missing', 400);
	log({ event: 'plane.installed', appInstallationId: id });
	return text(`app_installation_id=${id}\n`, 200);
}
