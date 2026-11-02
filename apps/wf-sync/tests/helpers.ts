import type { ConnectorContext } from '../src/connectors/base.ts';
import { createLogger, setLevel } from '../src/log.ts';

setLevel((process.env.LOG_LEVEL as any) ?? 'error');

export function ctx(state: Record<string, any> = {}): ConnectorContext {
	return { state, log: createLogger('test'), saveState: () => {} };
}

export type Handler = (req: Request, url: URL) => Response | Promise<Response>;

/** Start a throwaway HTTP server; returns its base URL and a request log. */
export function mockServer(handler: Handler) {
	const calls: { method: string; path: string; body: any }[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const text = req.method === 'GET' ? '' : await req.text();
			let body: any = text;
			try {
				body = text ? JSON.parse(text) : undefined;
			} catch {}
			calls.push({ method: req.method, path: url.pathname + url.search, body });
			return handler(
				new Request(req.url, { method: req.method, headers: req.headers, body: text || undefined }),
				url,
			);
		},
	});
	return { url: `http://localhost:${server.port}`, calls, stop: () => server.stop(true) };
}

export const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
