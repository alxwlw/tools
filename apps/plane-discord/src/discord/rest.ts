import { createHash } from 'node:crypto';

import { truncate } from '../html.ts';
import type { Fetch } from '../plane/auth.ts';

export type Embed = {
	title?: string;
	url?: string;
	description?: string;
	fields?: { name: string; value: string; inline?: boolean }[];
};
export type OutMessage = {
	content: string;
	embeds?: Embed[];
	replyTo?: string;
	ephemeral?: boolean;
	/**
	 * Idempotency key for `sendMessage` only (see `deliveryNonce`): Discord drops a repeat of the same nonce from the
	 * same author within minutes. The forum-post endpoint has no nonce field, so `createForumPost` ignores it.
	 */
	nonce?: string;
};
export type ChannelInfo = {
	id: string;
	type: number;
	parentId: string | null;
	guildId: string | null;
	name: string | null;
};

export const CHANNEL = {
	TEXT: 0,
	ANNOUNCEMENT: 5,
	PUBLIC_THREAD: 11,
	PRIVATE_THREAD: 12,
	FORUM: 15,
	MEDIA: 16,
} as const;
export const DISCORD_ERR = {
	CANNOT_DM: 50007,
	MISSING_ACCESS: 50001,
	MISSING_PERMISSIONS: 50013,
} as const;

export interface DiscordApi {
	getChannel(channelId: string): Promise<ChannelInfo>;
	listGuildChannels(guildId: string): Promise<ChannelInfo[]>;
	createForumPost(
		forumId: string,
		name: string,
		message: OutMessage,
	): Promise<{ threadId: string; messageId: string }>;
	sendMessage(channelId: string, message: OutMessage): Promise<{ id: string }>;
	openDm(userId: string): Promise<string>;
	editOriginal(interactionToken: string, message: OutMessage): Promise<void>;
	deleteOriginal(interactionToken: string): Promise<void>;
	followup(interactionToken: string, message: OutMessage): Promise<void>;
	bulkOverwriteGuildCommands(guildId: string, commands: readonly unknown[]): Promise<void>;
}

/** Carries status and Discord's JSON `code`, never the body; the interaction token is masked in `route`. */
export class DiscordApiError extends Error {
	override name = 'DiscordApiError';

	constructor(
		readonly status: number,
		readonly method: string,
		readonly route: string,
		readonly code: number | null = null,
	) {
		super(`Discord ${method} ${route} → ${status}${code === null ? '' : ` (code ${code})`}`);
	}
}

const API = 'https://discord.com/api/v10';
const CONTENT_MAX = 2000;
const POST_NAME_MAX = 100;
const EMBED_TITLE_MAX = 256;
const EMBED_DESCRIPTION_MAX = 4096;
const FIELD_NAME_MAX = 256;
const FIELD_VALUE_MAX = 1024;
const MAX_RATE_RETRIES = 3;
/**
 * Total 429 waiting allowed for one interaction call. The token lives 15 minutes; a reply that late is worthless,
 * and a sleeping call holds the work that follows. Over the budget the 429 is thrown instead of slept.
 */
const INTERACTION_MAX_WAIT_MS = 60_000;
const FLAG_EPHEMERAL = 64;
const NONCE_MAX = 25;

/**
 * A stable nonce for one delivery job: the same label gives the same nonce across the queue's retries, different
 * labels give different ones. 25 base64url characters of the label's SHA-256 (Discord caps nonce at 25).
 */
export function deliveryNonce(label: string): string {
	return createHash('sha256').update(label).digest('base64url').slice(0, NONCE_MAX);
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function embedBody(embed: Embed): Rec {
	return {
		...embed,
		...(embed.title === undefined ? {} : { title: truncate(embed.title, EMBED_TITLE_MAX) }),
		...(embed.description === undefined
			? {}
			: { description: truncate(embed.description, EMBED_DESCRIPTION_MAX) }),
		...(embed.fields === undefined
			? {}
			: {
					fields: embed.fields.map((f) => ({
						...f,
						name: truncate(f.name, FIELD_NAME_MAX),
						value: truncate(f.value, FIELD_VALUE_MAX),
					})),
				}),
	};
}

/** The one place a message body is built, so no caller can forget `allowed_mentions` or a length cap. */
function messageBody(message: OutMessage): Rec {
	return {
		content: truncate(message.content, CONTENT_MAX),
		allowed_mentions: { parse: [], replied_user: false },
		...(message.embeds === undefined ? {} : { embeds: message.embeds.map(embedBody) }),
		...(message.replyTo === undefined
			? {}
			: { message_reference: { message_id: message.replyTo, fail_if_not_exists: false } }),
		...(message.ephemeral === true ? { flags: FLAG_EPHEMERAL } : {}),
	};
}

function str(value: unknown, key: string): string {
	const found = isRecord(value) ? value[key] : undefined;
	if (typeof found !== 'string' || found === '')
		throw new Error(`Discord response: no string field "${key}"`);
	return found;
}

function optStr(value: unknown, key: string): string | null {
	const found = isRecord(value) ? value[key] : undefined;
	return typeof found === 'string' ? found : null;
}

function channelInfo(value: unknown): ChannelInfo {
	const type = isRecord(value) ? value.type : undefined;
	if (typeof type !== 'number') throw new Error('Discord response: no number field "type"');
	return {
		id: str(value, 'id'),
		type,
		parentId: optStr(value, 'parent_id'),
		guildId: optStr(value, 'guild_id'),
		name: optStr(value, 'name'),
	};
}

export type DiscordRestOptions = {
	botToken: string;
	applicationId: string;
	fetch?: Fetch;
	sleep?: (ms: number) => Promise<void>;
	timeoutMs?: number;
	/** Cap on the summed 429 waits of one interaction-webhook call (default 60 s). */
	interactionMaxWaitMs?: number;
};

export class DiscordRest implements DiscordApi {
	readonly #botToken: string;
	readonly #app: string;
	readonly #fetch: Fetch;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #timeoutMs: number;
	readonly #interactionMaxWaitMs: number;

	constructor(options: DiscordRestOptions) {
		this.#botToken = options.botToken;
		this.#app = encodeURIComponent(options.applicationId);
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#interactionMaxWaitMs = options.interactionMaxWaitMs ?? INTERACTION_MAX_WAIT_MS;
	}

	async getChannel(channelId: string): Promise<ChannelInfo> {
		return channelInfo(await this.#bot('GET', `/channels/${encodeURIComponent(channelId)}`));
	}

	async listGuildChannels(guildId: string): Promise<ChannelInfo[]> {
		const rows = await this.#bot('GET', `/guilds/${encodeURIComponent(guildId)}/channels`);
		if (!Array.isArray(rows)) throw new Error('Discord response: channel list is not an array');
		return rows.map(channelInfo);
	}

	async createForumPost(
		forumId: string,
		name: string,
		message: OutMessage,
	): Promise<{ threadId: string; messageId: string }> {
		const res = await this.#bot('POST', `/channels/${encodeURIComponent(forumId)}/threads`, {
			name: truncate(name, POST_NAME_MAX),
			message: messageBody(message),
		});
		const threadId = str(res, 'id');
		// The first message of a forum post shares the thread's id; the reply also carries it as `message`.
		const first = isRecord(res) ? res.message : undefined;
		return { threadId, messageId: isRecord(first) ? str(first, 'id') : threadId };
	}

	async sendMessage(channelId: string, message: OutMessage): Promise<{ id: string }> {
		const res = await this.#bot('POST', `/channels/${encodeURIComponent(channelId)}/messages`, {
			...messageBody(message),
			...(message.nonce === undefined
				? {}
				: { nonce: message.nonce.slice(0, NONCE_MAX), enforce_nonce: true }),
		});
		return { id: str(res, 'id') };
	}

	async openDm(userId: string): Promise<string> {
		return str(await this.#bot('POST', '/users/@me/channels', { recipient_id: userId }), 'id');
	}

	async editOriginal(interactionToken: string, message: OutMessage): Promise<void> {
		await this.#hook('PATCH', interactionToken, '/messages/@original', messageBody(message));
	}

	async deleteOriginal(interactionToken: string): Promise<void> {
		await this.#hook('DELETE', interactionToken, '/messages/@original');
	}

	async followup(interactionToken: string, message: OutMessage): Promise<void> {
		await this.#hook('POST', interactionToken, '', messageBody(message));
	}

	async bulkOverwriteGuildCommands(guildId: string, commands: readonly unknown[]): Promise<void> {
		await this.#bot(
			'PUT',
			`/applications/${this.#app}/guilds/${encodeURIComponent(guildId)}/commands`,
			commands,
		);
	}

	#bot(method: string, path: string, body?: unknown): Promise<unknown> {
		return this.#request(method, path, path, true, Number.POSITIVE_INFINITY, body);
	}

	/** Interaction webhook routes authenticate by the token in the path; the token never reaches an error. */
	#hook(method: string, token: string, suffix: string, body?: unknown): Promise<unknown> {
		const base = `/webhooks/${this.#app}`;
		return this.#request(
			method,
			`${base}/${encodeURIComponent(token)}${suffix}`,
			`${base}/:token${suffix}`,
			false,
			this.#interactionMaxWaitMs,
			body,
		);
	}

	async #request(
		method: string,
		path: string,
		route: string,
		bot: boolean,
		maxWaitMs: number,
		body?: unknown,
	): Promise<unknown> {
		let waited = 0;
		for (let attempt = 0; ; attempt++) {
			let res: Response;
			let text: string;
			try {
				res = await this.#fetch(`${API}${path}`, {
					method,
					headers: {
						...(bot ? { Authorization: `Bot ${this.#botToken}` } : {}),
						'Content-Type': 'application/json',
						Accept: 'application/json',
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.timeout(this.#timeoutMs),
				});
				text = await res.text();
			} catch {
				// A transport error may quote the URL, which holds the interaction token: report the route only.
				throw new DiscordApiError(0, method, route);
			}
			let parsed: unknown = null;
			if (text !== '') {
				try {
					parsed = JSON.parse(text);
				} catch {
					// A non-JSON error page is fine; a non-JSON 2xx is handled by the callers' field checks.
				}
			}
			if (res.status === 429 && attempt < MAX_RATE_RETRIES) {
				const wait = isRecord(parsed) ? parsed.retry_after : undefined;
				// A negative or NaN value would credit the budget or poison the sum: clamp it to no wait.
				const ms = typeof wait === 'number' ? Math.max(0, Math.ceil(wait * 1000) || 0) : 1000;
				// Over the budget, fall through: the 429 below is thrown instead of slept.
				if (waited + ms <= maxWaitMs) {
					waited += ms;
					await this.#sleep(ms);
					continue;
				}
			}
			if (!res.ok) {
				const code = isRecord(parsed) && typeof parsed.code === 'number' ? parsed.code : null;
				throw new DiscordApiError(res.status, method, route, code);
			}
			return parsed;
		}
	}
}
