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
