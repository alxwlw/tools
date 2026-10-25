// Signed Discord interaction requests for tests: a throwaway Ed25519 key pair and payload builders.
const hex = (bytes: ArrayBuffer): string =>
	Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

export type Signer = {
	publicKey: string;
	/** A POST /discord/interactions request signed over timestamp + body. */
	request(
		body: string,
		opts?: { timestamp?: string; headers?: Record<string, string> },
	): Promise<Request>;
};

export async function makeSigner(): Promise<Signer> {
	// The DOM lib types Ed25519 key generation as a single CryptoKey; at runtime it is a pair.
	const pair = (await crypto.subtle.generateKey('Ed25519', true, [
		'sign',
		'verify',
	])) as unknown as CryptoKeyPair;
	return {
		publicKey: hex(await crypto.subtle.exportKey('raw', pair.publicKey)),
		async request(body, opts = {}) {
			const timestamp = opts.timestamp ?? '1700000000';
			const signature = hex(
				await crypto.subtle.sign(
					{ name: 'Ed25519' },
					pair.privateKey,
					new TextEncoder().encode(timestamp + body),
				),
			);
			return new Request('http://plane-discord.test/discord/interactions', {
				method: 'POST',
				body,
				headers: {
					'x-signature-ed25519': signature,
					'x-signature-timestamp': timestamp,
					...opts.headers,
				},
			});
		},
	};
}

export type DiscordMessage = {
	id: string;
	content?: unknown;
	author?: unknown;
	attachments?: unknown;
	mentions?: unknown;
};

/** A message-command interaction (type 2, data.type 3); `channel` is the interaction's channel object. */
export function commandPayload(opts: {
	id: string;
	guildId: string;
	channel: Record<string, unknown>;
	name: string;
	message: DiscordMessage;
}): Record<string, unknown> {
	return {
		type: 2,
		id: opts.id,
		token: `tok-${opts.id}`,
		guild_id: opts.guildId,
		channel: opts.channel,
		data: {
			type: 3,
			name: opts.name,
			target_id: opts.message.id,
			resolved: { messages: { [opts.message.id]: opts.message } },
		},
	};
}

/** A slash-command interaction (type 2, data.type 1) with string options. */
export function chatInputPayload(opts: {
	id: string;
	guildId: string;
	name: string;
	options?: unknown[];
}): Record<string, unknown> {
	return {
		type: 2,
		id: opts.id,
		token: `tok-${opts.id}`,
		guild_id: opts.guildId,
		channel: { id: '222222222222222221', type: 0 },
		data: { type: 1, name: opts.name, options: opts.options ?? [] },
	};
}

/** A modal submit (type 5): text inputs and selects wrapped in Label components, as Discord sends them. */
export function submitPayload(opts: {
	id: string;
	guildId: string;
	customId: string;
	texts?: Record<string, string>;
	selects?: Record<string, string[]>;
}): Record<string, unknown> {
	const components = [
		...Object.entries(opts.texts ?? {}).map(([custom_id, value]) => ({
			type: 18,
			component: { type: 4, custom_id, value },
		})),
		...Object.entries(opts.selects ?? {}).map(([custom_id, values]) => ({
			type: 18,
			component: { type: 3, custom_id, values },
		})),
	];
	return {
		type: 5,
		id: opts.id,
		token: `tok-${opts.id}`,
		guild_id: opts.guildId,
		data: { custom_id: opts.customId, components },
	};
}
