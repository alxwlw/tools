// Adapted from apps/plane-discord/scripts/capture.ts: also keeps GitHub and Vercel delivery headers.
// One-off receiver for the Plane App probe: records every request it gets, byte for byte.
// Run: bun scripts/capture.ts (CAPTURE_DIR defaults to /captures).
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type CaptureLine = {
	ts: string;
	method: string;
	path: string;
	query: Record<string, string>;
	headers: Record<string, string>;
	bodyBase64: string | null;
	bodySha256: string | null;
};

// Plane, GitHub and Vercel delivery headers are kept; Authorization and cookies never reach the capture volume.
const KEEP_HEADER = /^(x-plane-.*|x-github-.*|x-hub-signature.*|x-vercel-.*|content-type|user-agent)$/;

const sha256Hex = (bytes: Uint8Array): string =>
	new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

export async function describeRequest(req: Request, now: Date): Promise<CaptureLine> {
	const url = new URL(req.url);
	const headers: Record<string, string> = {};
	for (const [name, value] of req.headers) {
		const key = name.toLowerCase();
		if (KEEP_HEADER.test(key)) headers[key] = value;
	}
	const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
	const bytes = hasBody ? new Uint8Array(await req.arrayBuffer()) : null;
	return {
		ts: now.toISOString(),
		method: req.method,
		path: url.pathname,
		query: Object.fromEntries(url.searchParams),
		headers,
		bodyBase64: bytes ? Buffer.from(bytes).toString('base64') : null,
		bodySha256: bytes ? sha256Hex(bytes) : null,
	};
}

export const MAX_BODY_BYTES = 1024 * 1024;

// A limit from the environment: a positive integer, otherwise the default.
// Number('') is 0 and Number('abc') is NaN, so both fall back instead of disabling the limit.
export function parseLimit(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function limitsFromEnv(env: Record<string, string | undefined>): CaptureLimits {
	return {
		maxFiles: parseLimit(env.CAPTURE_MAX_FILES, 500),
		maxBytes: parseLimit(env.CAPTURE_MAX_BYTES, 50 * 1024 * 1024),
	};
}

export type CaptureLimits = { maxFiles: number; maxBytes: number };

// Handler that stores each request as N-<hash>.bin (raw body) and N-<hash>.json (metadata).
// N continues after the highest number already in the directory, so a restart never
// overwrites old files; writing stops once the directory holds maxFiles requests or maxBytes.
export function createCaptureHandler(dir: string, limits: CaptureLimits) {
	mkdirSync(dir, { recursive: true });
	let n = 0;
	let files = 0;
	let bytes = 0;
	for (const name of readdirSync(dir)) {
		const m = /^(\d+)-[0-9a-f]{8}\.(bin|json)$/.exec(name);
		if (!m) continue;
		n = Math.max(n, Number(m[1]));
		bytes += statSync(join(dir, name)).size;
		if (m[2] === 'bin') files += 1;
	}
	return async (req: Request): Promise<Response> => {
		const raw = new Uint8Array(await req.clone().arrayBuffer());
		const line = await describeRequest(req, new Date());
		const summary = JSON.stringify({ ...line, bodyBase64: undefined });
		if (files >= limits.maxFiles || bytes + 2 * raw.length + 1024 > limits.maxBytes) {
			console.log(JSON.stringify({ dropped: 'limit', method: line.method, path: line.path }));
			return new Response('ok');
		}
		n += 1;
		files += 1;
		const base = `${n}-${sha256Hex(raw).slice(0, 8)}`;
		// The body lives in the .bin file; the .json carries metadata only.
		const meta = JSON.stringify({ ...line, bodyBase64: undefined });
		writeFileSync(join(dir, `${base}.bin`), raw);
		writeFileSync(join(dir, `${base}.json`), meta);
		bytes += raw.length + meta.length;
		console.log(summary);
		return new Response('ok');
	};
}

if (import.meta.main) {
	const dir = process.env.CAPTURE_DIR ?? '/captures';
	Bun.serve({
		port: 8080,
		development: false,
		maxRequestBodySize: MAX_BODY_BYTES,
		fetch: createCaptureHandler(dir, limitsFromEnv(process.env)),
	});
}
