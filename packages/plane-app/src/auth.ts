// Adapted from apps/plane-miro/src/plane/auth.ts: the scopes are a parameter, not a module constant.
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface PlaneAuth {
	headers(): Promise<Record<string, string>>;
	/** Drops the cached bot token. */
	invalidate(): void;
}

/** Non-2xx (or a body without a token) from /auth/o/token/; status 0 for a transport failure or timeout. Never carries the response body. */
export class PlaneAuthError extends Error {
	override name = 'PlaneAuthError';

	constructor(readonly status: number) {
		super(`Plane token request → ${status}`);
	}
}

/** The token is renewed this long before Plane would expire it. */
const EARLY_RENEWAL_S = 600;
const TOKEN_TIMEOUT_MS = 10_000;

type Cached = { token: string; until: number };

/**
 * Bot token of a workspace-level Plane App installation (client_credentials). Plane v3.3.0 refuses a
 * token request without `scope` (invalid_scope, design §10), so the registration's scopes go in each one.
 */
export function botTokenAuth(opts: {
	planeUrl: string;
	clientId: string;
	clientSecret: string;
	appInstallationId: string;
	/** Scopes of the app registration; each token request carries them space-separated. */
	scopes: readonly string[];
	fetch?: Fetch;
	now?: () => number;
}): PlaneAuth {
	const doFetch: Fetch = opts.fetch ?? ((input, init) => fetch(input, init));
	const now = opts.now ?? (() => Date.now());
	const url = `${opts.planeUrl.replace(/\/+$/, '')}/auth/o/token/`;
	const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
	let cached: Cached | null = null;
	let inflight: Promise<string> | null = null;
	// Bumped by invalidate(): a request that was in flight then must not write its token to the cache.
	let generation = 0;

	async function request(): Promise<Cached> {
		let res: Response;
		let text: string;
		try {
			res = await doFetch(url, {
				method: 'POST',
				headers: {
					Authorization: `Basic ${basic}`,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					grant_type: 'client_credentials',
					app_installation_id: opts.appInstallationId,
					scope: opts.scopes.join(' '),
				}).toString(),
				signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
			});
			text = await res.text();
		} catch {
			// A refused connection, a reset or a timeout: status 0, which the queue retries.
			throw new PlaneAuthError(0);
		}
		if (!res.ok) throw new PlaneAuthError(res.status);
		let body: unknown = null;
		try {
			body = JSON.parse(text);
		} catch {
			// Falls through to the shape check below.
		}
		const token = (body as { access_token?: unknown } | null)?.access_token;
		const lifetime = (body as { expires_in?: unknown } | null)?.expires_in;
		if (
			typeof token !== 'string' ||
			token === '' ||
			typeof lifetime !== 'number' ||
			!(lifetime > 0)
		)
			throw new PlaneAuthError(res.status);
		return { token, until: now() + Math.max(0, lifetime - EARLY_RENEWAL_S) * 1000 };
	}

	return {
		headers() {
			if (cached !== null && now() < cached.until) {
				return Promise.resolve({ Authorization: `Bearer ${cached.token}` });
			}
			if (inflight === null) {
				const mine = generation;
				const pending = request().then(
					(fresh) => {
						if (mine === generation) cached = fresh;
						if (inflight === pending) inflight = null;
						return fresh.token;
					},
					(err: unknown) => {
						if (inflight === pending) inflight = null;
						throw err;
					},
				);
				inflight = pending;
			}
			return inflight.then((token) => ({ Authorization: `Bearer ${token}` }));
		},
		invalidate() {
			generation++;
			cached = null;
			inflight = null;
		},
	};
}
