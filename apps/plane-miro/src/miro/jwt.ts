import { createHmac, timingSafeEqual } from 'node:crypto';

export type MiroIdentity = { teamId: string; userId: string };

const B64URL = /^[A-Za-z0-9_-]+$/;

function json(part: string): Record<string, unknown> | null {
	if (!B64URL.test(part)) return null;
	try {
		const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
		return typeof v === 'object' && v !== null && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** A non-empty string, or a safe non-negative integer (a larger one lost digits in JSON.parse: reject, never guess). */
function idOf(v: unknown): string | null {
	if (typeof v === 'string') return v === '' ? null : v;
	if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
	return null;
}

/** HS256 only, signed with the app client secret; iss "miro", sub = client id, exp in the future; else null. */
export function verifyIdToken(
	token: string,
	opts: { clientId: string; clientSecret: string; nowSec: number },
): MiroIdentity | null {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [h, p, s] = parts as [string, string, string];
	const header = json(h);
	if (header === null || header.alg !== 'HS256') return null;
	if (!B64URL.test(s)) return null;
	const expected = createHmac('sha256', opts.clientSecret).update(`${h}.${p}`).digest();
	const given = Buffer.from(s, 'base64url');
	if (given.length !== expected.length || !timingSafeEqual(expected, given)) return null;
	const claims = json(p);
	if (claims === null) return null;
	if (claims.iss !== 'miro' || claims.sub !== opts.clientId) return null;
	if (typeof claims.exp !== 'number' || !(claims.exp > opts.nowSec)) return null;
	const teamId = idOf(claims.team);
	const userId = idOf(claims.user);
	return teamId === null || userId === null ? null : { teamId, userId };
}
