import { describe, expect, spyOn, test } from 'bun:test';
import { verifyDiscordRequest } from '../src/discord/verify.ts';

const hex = (bytes: ArrayBuffer): string =>
	Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

async function signed(timestamp: string, body: string) {
	// The DOM lib types Ed25519 key generation as a single CryptoKey; at runtime it is a pair.
	const pair = (await crypto.subtle.generateKey('Ed25519', true, [
		'sign',
		'verify',
	])) as unknown as CryptoKeyPair;
	const publicKey = hex(await crypto.subtle.exportKey('raw', pair.publicKey));
	const message = new TextEncoder().encode(timestamp + body);
	const signature = hex(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, message));
	return { publicKey, signature, bytes: new TextEncoder().encode(body) };
}

describe('verifyDiscordRequest', () => {
	test('верная подпись timestamp+body — true', async () => {
		const s = await signed('1700000000', '{"type":1}');
		expect(await verifyDiscordRequest(s.publicKey, s.signature, '1700000000', s.bytes)).toBe(true);
	});

	test('изменены тело или timestamp — false', async () => {
		const s = await signed('1700000000', '{"type":1}');
		const other = new TextEncoder().encode('{"type":2}');
		expect(await verifyDiscordRequest(s.publicKey, s.signature, '1700000000', other)).toBe(false);
		expect(await verifyDiscordRequest(s.publicKey, s.signature, '1700000001', s.bytes)).toBe(false);
	});

	test('чужой ключ — false', async () => {
		const s = await signed('1700000000', 'x');
		const foreign = await signed('1700000000', 'x');
		expect(await verifyDiscordRequest(foreign.publicKey, s.signature, '1700000000', s.bytes)).toBe(
			false,
		);
	});

	test('нет заголовков, не-hex, ключ не той длины — false без исключения', async () => {
		const s = await signed('1700000000', 'x');
		const call = (key: string, sig: string | null, ts: string | null) =>
			verifyDiscordRequest(key, sig, ts, s.bytes);
		expect(await call(s.publicKey, null, '1700000000')).toBe(false);
		expect(await call(s.publicKey, s.signature, null)).toBe(false);
		expect(await call(s.publicKey, 'zz'.repeat(64), '1700000000')).toBe(false);
		expect(await call('zz'.repeat(32), s.signature, '1700000000')).toBe(false);
		expect(await call(s.publicKey.slice(2), s.signature, '1700000000')).toBe(false);
		expect(await call(s.publicKey, s.signature.slice(2), '1700000000')).toBe(false);
		expect(await call(s.publicKey + '00', s.signature, '1700000000')).toBe(false);
		expect(await call(s.publicKey, s.signature + '00', '1700000000')).toBe(false);
		expect(await call('', '', '')).toBe(false);
	});

	test('ключ из 32 нулевых байт: подпись не сходится — false без исключения', async () => {
		const s = await signed('1700000000', 'x');
		expect(await verifyDiscordRequest('00'.repeat(32), s.signature, '1700000000', s.bytes)).toBe(
			false,
		);
	});

	test('знак вместо ведущего нуля байта подписи — false (parseInt его бы проглотил)', async () => {
		for (let attempt = 0; attempt < 50; attempt++) {
			const s = await signed('1700000000', 'x');
			const at = [...Array(64).keys()].find((n) => s.signature[n * 2] === '0');
			if (at === undefined) continue;
			const forged = `${s.signature.slice(0, at * 2)}+${s.signature.slice(at * 2 + 1)}`;
			expect(await verifyDiscordRequest(s.publicKey, s.signature, '1700000000', s.bytes)).toBe(
				true,
			);
			expect(await verifyDiscordRequest(s.publicKey, forged, '1700000000', s.bytes)).toBe(false);
			return;
		}
		throw new Error('no signature with a leading-zero byte in 50 tries');
	});

	test('WebCrypto бросает при импорте ключа — false, а не исключение', async () => {
		const s = await signed('1700000000', 'x');
		const spy = spyOn(crypto.subtle, 'importKey').mockRejectedValue(new Error('bad key'));
		try {
			expect(await verifyDiscordRequest(s.publicKey, s.signature, '1700000000', s.bytes)).toBe(
				false,
			);
		} finally {
			spy.mockRestore();
		}
	});
});
