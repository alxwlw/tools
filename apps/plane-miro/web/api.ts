/// <reference lib="dom" />
import type { ApiResult } from './logic.ts';

/** Calls the service with the Miro id token; failures come back as an error code, never as a throw. */
export async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
	let token: string;
	try {
		token = await miro.board.getIdToken();
	} catch {
		return { ok: false, error: 'unauthorized' };
	}
	const headers = new Headers(init?.headers);
	headers.set('Authorization', `Bearer ${token}`);
	if (init?.body !== undefined) headers.set('Content-Type', 'application/json');
	let res: Response;
	try {
		res = await fetch(path, { ...init, headers });
	} catch {
		return { ok: false, error: 'network' };
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		// A body that is not JSON carries no code.
	}
	if (!res.ok) {
		const code = (body as { error?: unknown } | null | undefined)?.error;
		return { ok: false, error: typeof code === 'string' ? code : 'unknown' };
	}
	return body === undefined ? { ok: false, error: 'unknown' } : { ok: true, data: body as T };
}
