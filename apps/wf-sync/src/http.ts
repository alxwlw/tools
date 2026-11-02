/** fetch wrapper with timeout, JSON handling and retries on 429/5xx/network errors. */

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly body: string,
		readonly url: string,
	) {
		super(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`);
	}
}

export interface RequestOptions {
	method?: string;
	headers?: Record<string, string>;
	json?: unknown;
	timeoutMs?: number;
	retries?: number;
	/** Retry on 429 too (default true). Monobank's limiter is better served by waiting outside. */
	retryOn429?: boolean;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
	const { method = 'GET', json, timeoutMs = 30_000, retries = 2, retryOn429 = true } = opts;
	const headers: Record<string, string> = { 'user-agent': 'wf-sync/0.1', ...opts.headers };
	let body: string | undefined;
	if (json !== undefined) {
		headers['content-type'] = 'application/json';
		body = JSON.stringify(json);
	}
	let lastErr: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(url, {
				method,
				headers,
				body,
				signal: AbortSignal.timeout(timeoutMs),
			});
			const retryable = res.status >= 500 || (res.status === 429 && retryOn429);
			if (retryable && attempt < retries) {
				const ra = Number(res.headers.get('retry-after'));
				await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
				continue;
			}
			return res;
		} catch (e) {
			lastErr = e;
			if (attempt < retries) await sleep(1000 * 2 ** attempt);
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function requestJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
	const res = await request(url, opts);
	const text = await res.text();
	if (!res.ok) throw new HttpError(res.status, text, url);
	return (text ? JSON.parse(text) : undefined) as T;
}
