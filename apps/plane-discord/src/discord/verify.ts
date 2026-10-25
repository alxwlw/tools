const ED25519_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** Strict hex → bytes of exactly `length`; anything else → null. */
function fromHex(hex: string, length: number): Uint8Array<ArrayBuffer> | null {
	if (hex.length !== length * 2 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** Ed25519 over timestamp + raw body. Malformed key, signature or missing headers → false, never throws. */
export async function verifyDiscordRequest(
	publicKeyHex: string,
	signatureHex: string | null,
	timestamp: string | null,
	rawBody: Uint8Array,
): Promise<boolean> {
	if (signatureHex === null || timestamp === null) return false;
	const key = fromHex(publicKeyHex, ED25519_KEY_BYTES);
	const signature = fromHex(signatureHex, ED25519_SIGNATURE_BYTES);
	if (key === null || signature === null) return false;
	try {
		const publicKey = await crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, [
			'verify',
		]);
		const stamp = new TextEncoder().encode(timestamp);
		const message = new Uint8Array(stamp.length + rawBody.length);
		message.set(stamp, 0);
		message.set(rawBody, stamp.length);
		return await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, message);
	} catch {
		return false;
	}
}
