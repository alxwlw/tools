// Copy of apps/plane-discord/test/capture.test.ts; keep in sync until a shared package exists.
import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createCaptureHandler,
	describeRequest,
	limitsFromEnv,
	MAX_BODY_BYTES,
	parseLimit,
} from '../scripts/capture.ts';

test('GET с query: путь и параметры, тела нет', async () => {
	const line = await describeRequest(
		new Request('http://x/plane/oauth/callback?app_installation_id=abc&code=c'),
		new Date('2026-10-22T00:00:00Z'),
	);
	expect(line.path).toBe('/plane/oauth/callback');
	expect(line.query.app_installation_id).toBe('abc');
	expect(line.bodyBase64).toBeNull();
});

test('POST: x-plane-* сохранены, Authorization нет, тело байт в байт', async () => {
	const body = new TextEncoder().encode('{"a":"é"}');
	const req = new Request('http://x/plane/webhook', {
		method: 'POST',
		body,
		headers: { 'X-Plane-Signature': 'ab', 'X-Plane-Event': 'issue', Authorization: 'Bearer s' },
	});
	const line = await describeRequest(req, new Date());
	expect(line.headers['x-plane-signature']).toBe('ab');
	expect(line.headers.authorization).toBeUndefined();
	expect(Buffer.from(line.bodyBase64 as string, 'base64')).toEqual(Buffer.from(body));
});

test('метаданные: ts, метод, sha256 тела; HEAD без тела', async () => {
	const at = new Date('2026-10-22T01:02:03Z');
	const post = await describeRequest(
		new Request('http://x/p', { method: 'POST', body: 'abc' }),
		at,
	);
	expect(post.ts).toBe('2026-10-22T01:02:03.000Z');
	expect(post.method).toBe('POST');
	expect(post.bodySha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	const head = await describeRequest(new Request('http://x/p', { method: 'HEAD' }), at);
	expect(head.method).toBe('HEAD');
	expect(head.bodyBase64).toBeNull();
	expect(head.bodySha256).toBeNull();
});

const tmpDir = () => mkdtempSync(join(tmpdir(), 'capture-'));
const serve = (dir: string, limits = { maxFiles: 500, maxBytes: 50 * 1024 * 1024 }) =>
	Bun.serve({
		port: 0,
		maxRequestBodySize: MAX_BODY_BYTES,
		fetch: createCaptureHandler(dir, limits),
	});
const listing = (dir: string) => readdirSync(dir).sort();

test('тело больше 1 MiB: 413 и файлов нет', async () => {
	const dir = tmpDir();
	const server = serve(dir);
	const res = await fetch(`http://localhost:${server.port}/plane/webhook`, {
		method: 'POST',
		body: new Uint8Array(1024 * 1024 + 1),
	});
	await server.stop(true);
	expect(res.status).toBe(413);
	expect(listing(dir)).toEqual([]);
});

test('.json без тела, тело только в .bin', async () => {
	const dir = tmpDir();
	const server = serve(dir);
	await fetch(`http://localhost:${server.port}/p`, { method: 'POST', body: 'abc' });
	await server.stop(true);
	const files = listing(dir);
	expect(files).toHaveLength(2);
	const json = JSON.parse(
		readFileSync(join(dir, files.find((f) => f.endsWith('.json')) as string), 'utf8'),
	);
	expect(json.bodyBase64).toBeUndefined();
	expect(json.bodySha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	expect(readFileSync(join(dir, files.find((f) => f.endsWith('.bin')) as string), 'utf8')).toBe(
		'abc',
	);
});

test('после лимита по числу запросов файлы не появляются', async () => {
	const dir = tmpDir();
	const handle = createCaptureHandler(dir, { maxFiles: 2, maxBytes: 1e9 });
	for (const body of ['a', 'b', 'c']) {
		const res = await handle(new Request('http://x/p', { method: 'POST', body }));
		expect(res.status).toBe(200);
	}
	expect(listing(dir)).toHaveLength(4);
});

test('после лимита по байтам файлы не появляются', async () => {
	const dir = tmpDir();
	const handle = createCaptureHandler(dir, { maxFiles: 100, maxBytes: 2000 });
	await handle(new Request('http://x/p', { method: 'POST', body: 'a' }));
	const before = listing(dir);
	await handle(new Request('http://x/p', { method: 'POST', body: 'x'.repeat(2000) }));
	expect(listing(dir)).toEqual(before);
});

test('лимит по байтам копится между запросами: пишутся первые два, остальные нет', async () => {
	// Guard: bytes + 2 * body + 1024 <= maxBytes. With 300-byte bodies the first request
	// needs 1624 bytes, so maxBytes 2500 admits two requests (~530 bytes each), not a third.
	const dir = tmpDir();
	const handle = createCaptureHandler(dir, { maxFiles: 100, maxBytes: 2500 });
	for (let i = 0; i < 5; i += 1) {
		await handle(new Request('http://x/p', { method: 'POST', body: 'x'.repeat(300) }));
	}
	expect(listing(dir).map((f) => f.slice(0, 2))).toEqual(['1-', '1-', '2-', '2-']);
});

test('перезапуск продолжает нумерацию и не перезаписывает', async () => {
	const dir = tmpDir();
	const limits = { maxFiles: 100, maxBytes: 1e9 };
	await createCaptureHandler(
		dir,
		limits,
	)(new Request('http://x/p', { method: 'POST', body: 'one' }));
	const first = listing(dir);
	const firstBin = first.find((f) => f.endsWith('.bin')) as string;
	const content = readFileSync(join(dir, firstBin), 'utf8');
	await createCaptureHandler(
		dir,
		limits,
	)(new Request('http://x/p', { method: 'POST', body: 'one' }));
	const second = listing(dir);
	expect(second).toHaveLength(4);
	expect(second.filter((f) => f.startsWith('2-'))).toHaveLength(2);
	expect(readFileSync(join(dir, firstBin), 'utf8')).toBe(content);
});

test('разбор лимита из окружения: пусто, нечисло, ≤0 и дробное дают дефолт; целое берётся как есть', () => {
	expect(parseLimit(undefined, 500)).toBe(500);
	expect(parseLimit('', 500)).toBe(500);
	expect(parseLimit('abc', 500)).toBe(500);
	expect(parseLimit('-1', 500)).toBe(500);
	expect(parseLimit('0', 500)).toBe(500);
	expect(parseLimit('1.5', 500)).toBe(500);
	expect(parseLimit('7', 500)).toBe(7);
});

test('лимиты из окружения: дефолты 500 файлов и 50 MiB, переменные читаются раздельно', () => {
	expect(limitsFromEnv({})).toEqual({ maxFiles: 500, maxBytes: 50 * 1024 * 1024 });
	expect(limitsFromEnv({ CAPTURE_MAX_FILES: '7', CAPTURE_MAX_BYTES: 'abc' })).toEqual({
		maxFiles: 7,
		maxBytes: 50 * 1024 * 1024,
	});
	expect(limitsFromEnv({ CAPTURE_MAX_FILES: 'x', CAPTURE_MAX_BYTES: '4096' })).toEqual({
		maxFiles: 500,
		maxBytes: 4096,
	});
});

test('перезапуск учитывает уже записанное: лимит по числу и по байтам', async () => {
	const dir = tmpDir();
	const post = (h: (r: Request) => Promise<Response>) =>
		h(new Request('http://x/p', { method: 'POST', body: 'one' }));
	await post(createCaptureHandler(dir, { maxFiles: 100, maxBytes: 1e9 }));
	const before = listing(dir);
	expect(before.every((f) => f.startsWith('1-'))).toBe(true);
	await post(createCaptureHandler(dir, { maxFiles: 1, maxBytes: 1e9 }));
	expect(listing(dir)).toEqual(before);
	await post(createCaptureHandler(dir, { maxFiles: 100, maxBytes: 1100 }));
	expect(listing(dir)).toEqual(before);
	await post(createCaptureHandler(dir, { maxFiles: 100, maxBytes: 1e9 }));
	expect(listing(dir)).toHaveLength(4);
});
