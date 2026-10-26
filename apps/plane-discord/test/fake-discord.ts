import {
	CHANNEL,
	type ChannelInfo,
	type DiscordApi,
	type DiscordApiError,
	type OutMessage,
} from '../src/discord/rest.ts';

export type DiscordCall = { method: keyof DiscordApi; args: unknown[] };

/**
 * Discord in memory. Seed `channels`; make a method fail with `failures.set('openDm', new DiscordApiError(...))`.
 * Every call lands in `calls`, in order.
 */
export class FakeDiscord implements DiscordApi {
	channels = new Map<string, ChannelInfo>();
	failures = new Map<keyof DiscordApi, DiscordApiError>();
	/** Like `failures`, but the entry is consumed by the first call: the retry succeeds. */
	failOnce = new Map<keyof DiscordApi, DiscordApiError>();
	/**
	 * Like `failOnce`, but for a call whose effect happened: Discord took the post and the response was lost.
	 * `executeWebhook` stores the message, then throws.
	 */
	lostResponse = new Map<keyof DiscordApi, DiscordApiError>();
	/** What webhooks posted, per thread, oldest first. */
	posted = new Map<string, { id: string; webhookId: string | null; content: string }[]>();
	calls: DiscordCall[] = [];
	#seq = 0;

	#enter(method: keyof DiscordApi, ...args: unknown[]): void {
		this.calls.push({ method, args });
		const once = this.failOnce.get(method);
		if (once) {
			this.failOnce.delete(method);
			throw once;
		}
		const failure = this.failures.get(method);
		if (failure) throw failure;
	}

	#id(): string {
		return `d${++this.#seq}`;
	}

	callsOf(method: keyof DiscordApi): unknown[][] {
		return this.calls.filter((c) => c.method === method).map((c) => c.args);
	}

	async getChannel(channelId: string): Promise<ChannelInfo> {
		this.#enter('getChannel', channelId);
		const found = this.channels.get(channelId);
		if (!found) throw new Error(`fake discord: no channel ${channelId}`);
		return found;
	}

	async listGuildChannels(guildId: string): Promise<ChannelInfo[]> {
		this.#enter('listGuildChannels', guildId);
		return [...this.channels.values()].filter((c) => c.guildId === guildId);
	}

	async createForumPost(
		forumId: string,
		name: string,
		message: OutMessage,
	): Promise<{ threadId: string; messageId: string }> {
		this.#enter('createForumPost', forumId, name, message);
		const threadId = this.#id();
		const guildId = this.channels.get(forumId)?.guildId ?? null;
		this.channels.set(threadId, {
			id: threadId,
			type: CHANNEL.PUBLIC_THREAD,
			parentId: forumId,
			guildId,
			name,
		});
		return { threadId, messageId: threadId };
	}

	async sendMessage(channelId: string, message: OutMessage): Promise<{ id: string }> {
		this.#enter('sendMessage', channelId, message);
		return { id: this.#id() };
	}

	async startThreadFromMessage(
		channelId: string,
		messageId: string,
		name: string,
	): Promise<string> {
		this.#enter('startThreadFromMessage', channelId, messageId, name);
		const threadId = this.#id();
		const parent = this.channels.get(channelId);
		this.channels.set(threadId, {
			id: threadId,
			type:
				parent?.type === CHANNEL.ANNOUNCEMENT ? CHANNEL.ANNOUNCEMENT_THREAD : CHANNEL.PUBLIC_THREAD,
			parentId: channelId,
			guildId: parent?.guildId ?? null,
			name,
		});
		return threadId;
	}

	async joinThread(threadId: string): Promise<void> {
		this.#enter('joinThread', threadId);
	}

	async createWebhook(channelId: string, name: string): Promise<{ id: string; token: string }> {
		this.#enter('createWebhook', channelId, name);
		const n = this.#id();
		return { id: `wh-${n}`, token: `tok-${n}` };
	}

	async executeWebhook(
		webhookId: string,
		token: string,
		threadId: string,
		message: OutMessage & { username?: string; avatarUrl?: string },
	): Promise<{ id: string }> {
		this.#enter('executeWebhook', webhookId, token, threadId, message);
		const id = this.#id();
		this.posted.set(threadId, [
			...(this.posted.get(threadId) ?? []),
			{ id, webhookId, content: message.content },
		]);
		const lost = this.lostResponse.get('executeWebhook');
		if (lost) {
			this.lostResponse.delete('executeWebhook');
			throw lost;
		}
		return { id };
	}

	async recentMessages(
		channelId: string,
		limit: number,
	): Promise<{ id: string; webhookId: string | null; content: string }[]> {
		this.#enter('recentMessages', channelId, limit);
		return [...(this.posted.get(channelId) ?? [])].reverse().slice(0, limit);
	}

	async openDm(userId: string): Promise<string> {
		this.#enter('openDm', userId);
		return `dm-${userId}`;
	}

	async editOriginal(interactionToken: string, message: OutMessage): Promise<void> {
		this.#enter('editOriginal', interactionToken, message);
	}

	async deleteOriginal(interactionToken: string): Promise<void> {
		this.#enter('deleteOriginal', interactionToken);
	}

	async followup(interactionToken: string, message: OutMessage): Promise<void> {
		this.#enter('followup', interactionToken, message);
	}

	async bulkOverwriteGuildCommands(guildId: string, commands: readonly unknown[]): Promise<void> {
		this.#enter('bulkOverwriteGuildCommands', guildId, commands);
	}
}
