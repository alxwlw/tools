import { expect, test } from 'bun:test';
import { describeRequest } from '../scripts/capture.ts';

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
