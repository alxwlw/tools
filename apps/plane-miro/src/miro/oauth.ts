import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Config } from '../config.ts';
import type { Log } from '../log.ts';
import type { Fetch } from '../plane/auth.ts';
import type { Store } from '../store.ts';

const STATE_TTL_MS = 15 * 60_000;
const EXCHANGE_TIMEOUT_MS = 10_000;
const TEAM_ID = /^\d{1,24}$/;
const sign = (payload: string, secret: string): string =>
	createHmac('sha256', secret).update(`miro-state:${payload}`).digest('hex');

/** `<tenant>.<expMs>.<hmac>`: tenant ids have no dots, and the HMAC input is prefixed so it never matches a JWT. */
export function signState(tenantId: string, expMs: number, secret: string): string {
	const payload = `${tenantId}.${expMs}`;
	return `${payload}.${sign(payload, secret)}`;
}

/** Tenant id of a valid, unexpired state; else null. */
export function readState(state: string, secret: string, nowMs: number): string | null {
	const parts = state.split('.');
	if (parts.length !== 3) return null;
	const [tenantId, exp, mac] = parts as [string, string, string];
	if (!/^\d{1,16}$/.test(exp) || !/^[0-9a-f]{64}$/.test(mac)) return null;
	const expected = Buffer.from(sign(`${tenantId}.${exp}`, secret), 'hex');
	if (!timingSafeEqual(expected, Buffer.from(mac, 'hex'))) return null;
	return Number(exp) > nowMs ? tenantId : null;
}

const redirectUri = (config: Config): string => `${config.publicUrl}/miro/oauth/callback`;
const text = (status: number, body: string): Response =>
	new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

/** GET /miro/setup?tenant=<id> → 302 to https://miro.com/oauth/authorize?…&state=…&team_id=<miroTeamId>; unknown tenant → 404. */
export function miroSetupRedirect(config: Config, url: URL, nowMs: number): Response {
	const id = url.searchParams.get('tenant');
	const tenant = config.tenants.find((t) => t.id === id);
	if (tenant === undefined) return text(404, 'Неизвестный тенант');
	const target = new URL('https://miro.com/oauth/authorize');
	target.searchParams.set('response_type', 'code');
	target.searchParams.set('client_id', config.miro.clientId);
	target.searchParams.set('redirect_uri', redirectUri(config));
	target.searchParams.set(
		'state',
		signState(tenant.id, nowMs + STATE_TTL_MS, config.miro.clientSecret),
	);
	target.searchParams.set('team_id', tenant.miroTeamId);
	return new Response(null, { status: 302, headers: { location: target.toString() } });
}

/** A team or user id of the token reply: a string, or a safe integer (a larger one lost digits in JSON.parse). */
function idOf(v: unknown): string | null {
	if (typeof v === 'string') return v === '' ? null : v;
	return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
}

type Exchange =
	| { status: number; token: string; teamId: string; userId: string }
	| { status: number };

async function exchange(code: string, config: Config, fetchFn: Fetch): Promise<Exchange> {
	const target = new URL('https://api.miro.com/v1/oauth/token');
	target.searchParams.set('grant_type', 'authorization_code');
	target.searchParams.set('client_id', config.miro.clientId);
	target.searchParams.set('client_secret', config.miro.clientSecret);
	target.searchParams.set('code', code);
	target.searchParams.set('redirect_uri', redirectUri(config));
	let status: number;
	let raw: string;
	try {
		const res = await fetchFn(target.toString(), {
			method: 'POST',
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
		});
		status = res.status;
		raw = await res.text();
	} catch {
		// the error text may carry the URL with the secret and the code: status 0 only
		return { status: 0 };
	}
	if (status < 200 || status >= 300) return { status };
	try {
		const body: unknown = JSON.parse(raw);
		const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
		const token = o.access_token;
		const teamId = idOf(o.team_id);
		const userId = idOf(o.user_id);
		if (typeof token !== 'string' || token === '' || teamId === null || userId === null)
			return { status };
		return { status, token, teamId, userId };
	} catch {
		return { status };
	}
}

/** GET /miro/oauth/callback. */
export async function miroOauthCallback(
	url: URL,
	deps: { config: Config; store: Store; fetch: Fetch; log: Log; nowMs: number },
): Promise<Response> {
	const { config, store, log } = deps;
	const code = url.searchParams.get('code');
	if (code === null || code === '') return text(400, 'Нет параметра code');
	const rawTeam = url.searchParams.get('team_id') ?? url.searchParams.get('team');
	const queryTeam = rawTeam !== null && TEAM_ID.test(rawTeam) ? rawTeam : '';
	const done = (team: string): Response => {
		const target = new URL('https://miro.com/app-install-completed/');
		target.searchParams.set('client_id', config.miro.clientId);
		target.searchParams.set('team_id', team);
		return new Response(null, { status: 302, headers: { location: target.toString() } });
	};

	const state = url.searchParams.get('state');
	const tenantId = state === null ? null : readState(state, config.miro.clientSecret, deps.nowMs);
	const tenant = config.tenants.find((t) => t.id === tenantId);
	if (tenant === undefined) {
		// An ordinary person's install: nothing is exchanged, nothing is stored.
		log({ event: 'miro.installed', team: queryTeam });
		return done(queryTeam);
	}

	const got = await exchange(code, config, deps.fetch);
	if (!('token' in got)) {
		log({ event: 'miro.exchange_failed', level: 'error', tenant: tenant.id, status: got.status });
		return text(502, 'Не удалось получить токен Miro');
	}
	if (got.teamId !== tenant.miroTeamId) {
		log({ event: 'miro.wrong_team', level: 'error', tenant: tenant.id, team: got.teamId });
		return text(400, 'Это не та команда Miro');
	}
	store.putMiroToken(got.teamId, got.userId, got.token);
	log({ event: 'miro.service_connected', tenant: tenant.id, user: got.userId });
	return done(got.teamId);
}

/** Routes `GET /miro/setup` and `GET /miro/oauth/callback` for `ServerDeps.miroOauth`; other methods 405, other paths 404. */
export function miroOauthHandler(deps: {
	config: Config;
	store: Store;
	fetch: Fetch;
	log: Log;
	now?: () => number;
}): (req: Request, url: URL) => Promise<Response> {
	const now = deps.now ?? Date.now;
	return async (req, url) => {
		const setup = url.pathname === '/miro/setup';
		if (!setup && url.pathname !== '/miro/oauth/callback') return text(404, 'not found');
		if (req.method !== 'GET') return text(405, 'method not allowed');
		return setup
			? miroSetupRedirect(deps.config, url, now())
			: miroOauthCallback(url, { ...deps, nowMs: now() });
	};
}
