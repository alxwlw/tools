/// <reference lib="dom" />
import { type ApiResult, apiResult } from './logic.ts';

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
	return apiResult<T>(() => fetch(path, { ...init, headers }));
}
