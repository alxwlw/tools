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
const FLAG_EPHEMERAL = 64;

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
};

export class DiscordRest implements DiscordApi {
	readonly #botToken: string;
	readonly #app: string;
	readonly #fetch: Fetch;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #timeoutMs: number;

	constructor(options: DiscordRestOptions) {
		this.#botToken = options.botToken;
		this.#app = encodeURIComponent(options.applicationId);
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
		this.#timeoutMs = options.timeoutMs ?? 10_000;
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
		const res = await this.#bot(
			'POST',
			`/channels/${encodeURIComponent(channelId)}/messages`,
			messageBody(message),
		);
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
		return this.#request(method, path, path, true, body);
	}

	/** Interaction webhook routes authenticate by the token in the path; the token never reaches an error. */
	#hook(method: string, token: string, suffix: string, body?: unknown): Promise<unknown> {
		const base = `/webhooks/${this.#app}`;
		return this.#request(
			method,
			`${base}/${encodeURIComponent(token)}${suffix}`,
			`${base}/:token${suffix}`,
			false,
			body,
		);
	}

	async #request(
		method: string,
		path: string,
		route: string,
		bot: boolean,
		body?: unknown,
	): Promise<unknown> {
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
				await this.#sleep(typeof wait === 'number' ? Math.ceil(wait * 1000) : 1000);
				continue;
			}
			if (!res.ok) {
				const code = isRecord(parsed) && typeof parsed.code === 'number' ? parsed.code : null;
				throw new DiscordApiError(res.status, method, route, code);
			}
			return parsed;
		}
	}
}
