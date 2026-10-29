import { createSign } from 'node:crypto';

import type { Fetch } from '@alxwlw/plane-app';

import type { GitHubAppConfig } from '../config.ts';
import { isRecord } from '../payload.ts';
import { createGitHubClient, type GitHubApi, githubRequest, type Transport } from './client.ts';

const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;
/** A cached installation token is replaced this long before GitHub expires it. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const DELIVERIES_PAGE_SIZE = 100;
/** 1000 deliveries: more than a health window holds; stops a runaway cursor. */
const DELIVERIES_MAX_PAGES = 10;

function base64url(value: string | Buffer): string {
	return Buffer.from(value).toString('base64url');
}

/** RS256 App JWT: `iat` is backdated for clock skew, `exp` stays under GitHub's 10 minute cap. */
export function appJwt(appId: number, privateKeyPem: string, nowSeconds: number): string {
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const payload = base64url(
		JSON.stringify({
			iat: nowSeconds - JWT_BACKDATE_SECONDS,
			exp: nowSeconds + JWT_LIFETIME_SECONDS,
			iss: appId,
		}),
	);
	const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem);
	return `${header}.${payload}.${base64url(signature)}`;
}

export type GitHubApp = {
	config: GitHubAppConfig;
	/** Installation-scoped client; tokens are cached until 5 min before expires_at. */
	client(installationId: number): GitHubApi;
	/** GET /repos/{repo}/installation with the App JWT; 404 → null. */
	installationFor(repo: string): Promise<number | null>;
	/** GET /app and GET /app/hook/deliveries; failed = deliveries since `sinceIso` with status_code >= 400 or none. */
	health(sinceIso: string): Promise<{ appOk: boolean; failed: number }>;
};

type CachedToken = { token: Promise<string>; expiresAtMs: number | null };

/** `now` is in milliseconds, like Date.now. */
export function createGitHubApp(
	config: GitHubAppConfig,
	opts: { fetch?: Fetch; now?: () => number } = {},
): GitHubApp {
	const doFetch: Fetch = opts.fetch ?? ((input, init) => fetch(input, init));
	const now = opts.now ?? Date.now;
	const jwt = () =>
		Promise.resolve(appJwt(config.appId, config.privateKeyPem, Math.floor(now() / 1000)));
	const appTransport: Transport = { fetch: doFetch, bearer: jwt };
	const tokens = new Map<number, CachedToken>();

	async function mint(installationId: number): Promise<{ token: string; expiresAtMs: number }> {
		const res = await githubRequest(
			appTransport,
			'POST',
			`/app/installations/${installationId}/access_tokens`,
			{},
		);
		const body = isRecord(res.body) ? res.body : {};
		const expiresAtMs =
			typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN;
		if (typeof body.token !== 'string' || body.token === '' || Number.isNaN(expiresAtMs)) {
			throw new Error('GitHub access_tokens: unexpected shape');
		}
		return { token: body.token, expiresAtMs };
	}

	/** One request per installation in flight: concurrent callers share the promise; a failure is not cached. */
	function installationToken(installationId: number): Promise<string> {
		const cached = tokens.get(installationId);
		if (
			cached &&
			(cached.expiresAtMs === null || now() < cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS)
		) {
			return cached.token;
		}
		const entry: CachedToken = { token: Promise.resolve(''), expiresAtMs: null };
		entry.token = mint(installationId).then(
			(minted) => {
				entry.expiresAtMs = minted.expiresAtMs;
				return minted.token;
			},
			(error: unknown) => {
				if (tokens.get(installationId) === entry) tokens.delete(installationId);
				throw error;
			},
		);
		tokens.set(installationId, entry);
		return entry.token;
	}

	return {
		config,

		client(installationId) {
			return createGitHubClient({
				fetch: doFetch,
				bearer: () => installationToken(installationId),
			});
		},

		async installationFor(repo) {
			const res = await githubRequest(
				appTransport,
				'GET',
				`/repos/${repo}/installation`,
				undefined,
				[404],
			);
			if (res.status === 404) return null;
			const id = isRecord(res.body) ? res.body.id : undefined;
			if (typeof id !== 'number' || !Number.isInteger(id)) {
				throw new Error('GitHub repos/installation: unexpected shape');
			}
			return id;
		},

		async health(sinceIso) {
			// A failed probe is the answer here, not an error: the caller alerts on appOk.
			try {
				await githubRequest(appTransport, 'GET', '/app');
			} catch {
				return { appOk: false, failed: 0 };
			}
			const since = Date.parse(sinceIso);
			let failed = 0;
			let cursor: string | null = null;
			for (let page = 0; page < DELIVERIES_MAX_PAGES; page++) {
				const query = new URLSearchParams({ per_page: String(DELIVERIES_PAGE_SIZE) });
				if (cursor !== null) query.set('cursor', cursor);
				const res = await githubRequest(
					appTransport,
					'GET',
					`/app/hook/deliveries?${query.toString()}`,
				);
				if (!Array.isArray(res.body))
					throw new Error('GitHub app/hook/deliveries: unexpected shape');
				let reachedOlder = false;
				for (const row of res.body) {
					if (!isRecord(row) || typeof row.delivered_at !== 'string') {
						throw new Error('GitHub app/hook/deliveries: unexpected shape');
					}
					if (Date.parse(row.delivered_at) < since) {
						reachedOlder = true; // newest first: everything after is older too
						break;
					}
					// 0 is how GitHub reports a delivery that got no HTTP answer (timeout).
					const code = row.status_code;
					if (typeof code !== 'number' || code < 100 || code >= 400) failed++;
				}
				const next = res.next === null ? null : new URL(res.next).searchParams.get('cursor');
				if (reachedOlder || next === null) break;
				cursor = next;
			}
			return { appOk: true, failed };
		},
	};
}
