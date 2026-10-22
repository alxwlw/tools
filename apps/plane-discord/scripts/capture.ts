// One-off receiver for the Plane App probe: records every request it gets, byte for byte.
// Run: bun scripts/capture.ts (CAPTURE_DIR defaults to /captures).
import { mkdirSync, writeFileSync } from 'node:fs';
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

// Authorization and cookies never reach the capture volume.
const KEEP_HEADER = /^(x-plane-.*|content-type|user-agent)$/;

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

if (import.meta.main) {
	const dir = process.env.CAPTURE_DIR ?? '/captures';
	mkdirSync(dir, { recursive: true });
	let n = 0;
	Bun.serve({
		port: 8080,
		development: false,
		async fetch(req) {
			const raw = new Uint8Array(await req.clone().arrayBuffer());
			const line = await describeRequest(req, new Date());
			n += 1;
			const base = `${n}-${sha256Hex(raw).slice(0, 8)}`;
			writeFileSync(join(dir, `${base}.bin`), raw);
			writeFileSync(join(dir, `${base}.json`), JSON.stringify(line));
			console.log(JSON.stringify({ ...line, bodyBase64: undefined }));
			return new Response('ok');
		},
	});
}
