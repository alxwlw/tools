// Plane events → Discord topics and DMs (design §3 «1a», «1b», §5 «Шум»).
// The notifier does not send anything itself: Plane lookups happen in the returned promise (the caller retries
// the event as a whole when one fails), every Discord send is its own Delivery (the queue retries only that one).
import type { ChannelRoute, EventKind, Tenant } from './config.ts';
import {
	CHANNEL,
	CONTENT_MAX,
	deliveryNonce,
	DISCORD_ERR,
	type DiscordApi,
	DiscordApiError,
	type OutMessage,
} from './discord/rest.ts';
import { truncate } from './html.ts';
import type { Log } from './log.ts';
import type { MemberSummary, PlaneApi, ProjectSummary, StateSummary } from './plane/client.ts';
import type { PlaneEvent } from './plane/webhook.ts';
import type { Store } from './store.ts';
import {
	planeHtmlToDiscord,
	planeMentions,
	type UserMap,
	workItemKey,
	workItemUrl,
} from './text.ts';

export type TenantRuntime = {
	tenant: Tenant;
	plane: PlaneApi;
	users: UserMap;
	/** `refresh: true` bypasses a cached answer (the caller missed an id: a project or state created after the load). */
	projects: (opts?: { refresh?: boolean }) => Promise<ProjectSummary[]>;
	states: (projectId: string, opts?: { refresh?: boolean }) => Promise<StateSummary[]>;
	members: () => Promise<MemberSummary[]>;
};
export type Delivery = { label: string; run: () => Promise<void> };
export type NotifyDeps = {
	runtimes: ReadonlyMap<string, TenantRuntime>;
	discord: DiscordApi;
	store: Store;
	planeUrl: string;
	channelType: (channelId: string) => Promise<number>;
	log: Log;
};

type Item = { id: string; projectId: string; sequenceId: number; name: string };

const UNKNOWN_ACTOR = 'кто-то';
const QUOTE_MAX = 1000;
const WEBHOOK_NAME = 'Plane';
// Discord refuses a webhook username that holds these (case-insensitive) and caps it at 80 characters.
const USERNAME_BANNED = /discord|clyde/gi;
const USERNAME_MAX = 80;
// How far back a retry looks for its own post that Discord took before the response was lost.
const DUP_LOOKBACK = 10;
const IN_THREAD = '→ Discord: в тред задачи';
const NO_CHANNEL = 'Канал для проекта не настроен';
const NO_PROJECT = 'Не удалось отправить в Discord: проект не найден в Plane';
// Neutral on purpose: no channel names, no hint of what the tenant's map holds.
const HIDDEN = 'Пересылка в Discord для этого проекта отключена';

/** A project missing from the cached list may be new: ask again, past the cache, before giving up. */
async function findProject(
	rt: TenantRuntime,
	projectId: string,
): Promise<ProjectSummary | undefined> {
	const hit = (await rt.projects()).find((p) => p.id === projectId);
	return hit ?? (await rt.projects({ refresh: true })).find((p) => p.id === projectId);
}

/** The author's Plane name made acceptable as a webhook username; empty after cleaning → `Plane`. */
export function webhookUsername(displayName: string | undefined): string {
	// Repeat: the halves left by one pass can join into a new banned word («disdiscordcord»).
	let name = displayName ?? '';
	for (let prev = ''; prev !== name;) {
		prev = name;
		name = name.replace(USERNAME_BANNED, '');
	}
	const clean = name.replace(/\s+/g, ' ').trim();
	return clean === '' ? WEBHOOK_NAME : truncate(clean, USERNAME_MAX);
}

/** Only an absolute https URL is an avatar; a relative path or anything else leaves Discord's default. */
export function webhookAvatar(avatarUrl: string | null | undefined): string | undefined {
	if (!avatarUrl) return undefined;
	try {
		const url = new URL(avatarUrl);
		return url.protocol === 'https:' ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/** Module routes win; without one, the project's routes with moduleId null. Unique by channelId. */
export function routesFor(
	tenant: Tenant,
	projectId: string,
	moduleIds: readonly string[],
): ChannelRoute[] {
	const forProject = tenant.channels.filter((r) => r.projectId === projectId);
	const byModule = forProject.filter((r) => r.moduleId !== null && moduleIds.includes(r.moduleId));
	const picked = byModule.length > 0 ? byModule : forProject.filter((r) => r.moduleId === null);
	// The first entry of a channel listed twice wins.
	return picked.filter((r, i) => picked.findIndex((o) => o.channelId === r.channelId) === i);
}

/** Plane lookups happen here (retried as a whole); every Discord send is its own Delivery. */
export function createNotifier(deps: NotifyDeps): (event: PlaneEvent) => Promise<Delivery[]> {
	const skip = (event: PlaneEvent, reason: string, level?: 'error') =>
		deps.log({
			event: 'notify.skip',
			level,
			tenant: event.tenant,
			reason,
			eventKey: event.eventKey,
		});

	/** Channels of the project (and of the item's modules) that take `kind`; modules are asked only if the map has some. */
	async function channelsFor(
		rt: TenantRuntime,
		projectId: string,
		workItemId: string,
		kind: EventKind,
	): Promise<ChannelRoute[]> {
		const moduleIds = [
			...new Set(
				rt.tenant.channels.flatMap((r) =>
					r.projectId === projectId && r.moduleId !== null ? [r.moduleId] : [],
				),
			),
		];
		const inModules =
			moduleIds.length > 0
				? await rt.plane.getWorkItemModules(projectId, workItemId, moduleIds)
				: [];
		return routesFor(rt.tenant, projectId, inModules).filter((r) => r.events.includes(kind));
	}

	/** Members are fetched at most once per event, and only when somebody is not in the user table. */
	function actors(rt: TenantRuntime) {
		let members: Promise<MemberSummary[]> | null = null;
		const list = () => (members ??= rt.members());
		return {
			list,
			async who(planeUserId: string): Promise<string> {
				const discordId = rt.users.toDiscord(planeUserId);
				if (discordId !== null) return `<@${discordId}>`;
				const found = (await list()).find((m) => m.id === planeUserId);
				return found?.displayName || UNKNOWN_ACTOR;
			},
		};
	}

	/** Mapped people only; the author and the bot never get a DM; the first reason for a person stays. */
	function addRecipients(
		rt: TenantRuntime,
		into: Map<string, string>,
		exclude: ReadonlySet<string>,
		planeUserIds: readonly string[],
		reason: string,
	): void {
		for (const id of planeUserIds) {
			if (exclude.has(id)) continue;
			const discordId = rt.users.toDiscord(id);
			if (discordId !== null && !into.has(discordId)) into.set(discordId, reason);
		}
	}

	async function toForum(
		rt: TenantRuntime,
		item: Item,
		key: string,
		channelId: string,
		message: OutMessage,
		nonce: string,
	): Promise<void> {
		// Read at run time: an earlier delivery of another event may have created the post since this list was built.
		const threadId = deps.store.getThread(rt.tenant.id, item.id, channelId);
		if (threadId !== null) {
			try {
				await deps.discord.sendMessage(threadId, { ...message, nonce });
				return;
			} catch (err) {
				if (!(err instanceof DiscordApiError && err.status === 404)) throw err;
				deps.log({
					event: 'notify.thread_gone',
					level: 'warn',
					tenant: rt.tenant.id,
					channel: channelId,
					thread: threadId,
				});
			}
		}
		// No nonce here: Discord's forum-post endpoint does not take one, so a timed-out create may repeat (see rest.ts).
		const post = await deps.discord.createForumPost(channelId, `${key} ${item.name}`, message);
		deps.store.putThread(rt.tenant.id, item.id, channelId, post.threadId, item.projectId);
	}

	function channelDelivery(
		rt: TenantRuntime,
		event: PlaneEvent,
		item: Item,
		key: string,
		channelId: string,
		message: OutMessage,
	): Delivery {
		const label = `${event.eventKey}→channel:${channelId}`;
		// Stable across the queue's retries of this job: a timed-out POST that Discord did complete is not repeated.
		const nonce = deliveryNonce(label);
		return {
			label,
			run: async () => {
				const type = await deps.channelType(channelId);
				if (type === CHANNEL.FORUM || type === CHANNEL.MEDIA)
					await toForum(rt, item, key, channelId, message, nonce);
				else if (type === CHANNEL.TEXT || type === CHANNEL.ANNOUNCEMENT)
					await deps.discord.sendMessage(channelId, { ...message, nonce });
				else
					deps.log({
						event: 'notify.bad_channel',
						level: 'error',
						tenant: rt.tenant.id,
						channel: channelId,
						type,
					});
			},
		};
	}

	function dmDelivery(
		rt: TenantRuntime,
		event: PlaneEvent,
		discordId: string,
		message: OutMessage,
	): Delivery {
		const label = `${event.eventKey}→dm:${discordId}`;
		return {
			label,
			run: async () => {
				try {
					const channelId = await deps.discord.openDm(discordId);
					await deps.discord.sendMessage(channelId, { ...message, nonce: deliveryNonce(label) });
				} catch (err) {
					// The person closed DMs from server members: not an error of ours, and a retry cannot help.
					if (err instanceof DiscordApiError && err.code === DISCORD_ERR.CANNOT_DM) {
						deps.log({ event: 'dm.closed', level: 'warn', tenant: rt.tenant.id, user: discordId });
						return;
					}
					throw err;
				}
			},
		};
	}

	/** Channel messages (`what`) and DMs (one reason per person) for one work item. */
	async function assemble(
		rt: TenantRuntime,
		event: PlaneEvent,
		item: Item,
		actorId: string,
		what: string | null,
		channels: readonly ChannelRoute[],
		recipients: ReadonlyMap<string, string>,
	): Promise<Delivery[]> {
		if (channels.length === 0 && recipients.size === 0) {
			skip(event, 'no_effect');
			return [];
		}
		const project = await findProject(rt, item.projectId);
		if (!project) {
			skip(event, 'unknown_project', 'error');
			return [];
		}
		const key = workItemKey(project.identifier, item.sequenceId);
		const url = workItemUrl(deps.planeUrl, rt.tenant.workspace, key);
		const who = await actors(rt).who(actorId);
		const text = (action: string): OutMessage => ({
			content: [
				`**${key}** ${item.name}`,
				`${action} · ${who}`,
				`[Открыть в Plane](<${url}>)`,
			].join('\n'),
		});
		const deliveries: Delivery[] = [];
		if (what !== null)
			for (const route of channels)
				deliveries.push(channelDelivery(rt, event, item, key, route.channelId, text(what)));
		for (const [discordId, reason] of recipients)
			deliveries.push(dmDelivery(rt, event, discordId, text(reason)));
		return deliveries;
	}

	async function onCreated(
		rt: TenantRuntime,
		event: Extract<PlaneEvent, { kind: 'workitem.created' }>,
	): Promise<Delivery[]> {
		const bot = await rt.plane.botUserId();
		if (event.actorId === bot) return (skip(event, 'own'), []);
		const { item } = event;
		const exclude = new Set([bot, event.actorId]);
		const recipients = new Map<string, string>();
		addRecipients(rt, recipients, exclude, item.assignees, 'Тебя назначили');
		addRecipients(
			rt,
			recipients,
			exclude,
			planeMentions(item.descriptionHtml ?? ''),
			'Тебя упомянули в описании',
		);
		const channels = await channelsFor(rt, item.projectId, item.id, 'created');
		return assemble(rt, event, item, event.actorId, 'Задача создана', channels, recipients);
	}

	async function onUpdated(
		rt: TenantRuntime,
		event: Extract<PlaneEvent, { kind: 'workitem.updated' }>,
	): Promise<Delivery[]> {
		const bot = await rt.plane.botUserId();
		if (event.actorId === bot) return (skip(event, 'own'), []);
		const { item, previous } = event;
		const exclude = new Set([bot, event.actorId]);
		const recipients = new Map<string, string>();
		if (previous.assignees !== undefined) {
			const before = new Set(previous.assignees);
			addRecipients(
				rt,
				recipients,
				exclude,
				item.assignees.filter((id) => !before.has(id)),
				'Тебя назначили',
			);
		}
		if (previous.descriptionHtml !== undefined) {
			const before = new Set(planeMentions(previous.descriptionHtml ?? ''));
			addRecipients(
				rt,
				recipients,
				exclude,
				planeMentions(item.descriptionHtml ?? '').filter((id) => !before.has(id)),
				'Тебя упомянули в описании',
			);
		}
		let what: string | null = null;
		// The parser sets exactly one of the three `previous` keys; none of them means the state field changed
		// (old_value null → no previous state). Only a state change can close the item.
		if (previous.assignees === undefined && previous.descriptionHtml === undefined) {
			let states = await rt.states(item.projectId);
			if (!states.some((s) => s.id === item.stateId))
				states = await rt.states(item.projectId, { refresh: true });
			const now = states.find((s) => s.id === item.stateId);
			if (!now) return (skip(event, 'unknown_state', 'error'), []);
			if (now.group === 'completed' || now.group === 'cancelled') {
				const before =
					previous.stateId === undefined
						? undefined
						: states.find((s) => s.id === previous.stateId);
				if (before?.group !== now.group)
					what = now.group === 'completed' ? 'Задача закрыта' : 'Задача отменена';
			}
		}
		const channels = what === null ? [] : await channelsFor(rt, item.projectId, item.id, 'closed');
		return assemble(rt, event, item, event.actorId, what, channels, recipients);
	}

	/** One delivery per bound thread: the webhook of the thread's parent channel posts under the author's name. */
	function threadDelivery(
		rt: TenantRuntime,
		event: PlaneEvent,
		target: { channelId: string; threadId: string },
		message: OutMessage & { username?: string; avatarUrl?: string },
	): Delivery {
		const create = async () => {
			const made = await deps.discord.createWebhook(target.channelId, WEBHOOK_NAME);
			// Recorded at once: the echo of this webhook's own messages is skipped by `isOwnWebhook`.
			deps.store.putWebhook(target.channelId, made.id, made.token);
			return made;
		};
		// Execute Webhook takes no nonce: after a lost response the retry first looks for its own post in the thread.
		// The queue calls this same `run` on each retry, so the flag lives in the closure.
		let inDoubt = false;
		const alreadyPosted = async (): Promise<boolean> => {
			const hook = deps.store.getWebhook(target.channelId);
			if (hook === null) return false;
			const recent = await deps.discord.recentMessages(target.threadId, DUP_LOOKBACK);
			return recent.some(
				(m) => m.webhookId === hook.id && m.content === truncate(message.content, CONTENT_MAX),
			);
		};
		const attempt = async () => {
			// Read at run time: an earlier delivery of another event may have created it since.
			const hook = deps.store.getWebhook(target.channelId) ?? (await create());
			try {
				await deps.discord.executeWebhook(hook.id, hook.token, target.threadId, message);
			} catch (err) {
				if (
					!(
						err instanceof DiscordApiError &&
						err.status === 404 &&
						err.code === DISCORD_ERR.UNKNOWN_WEBHOOK
					)
				)
					throw err;
				deps.log({
					event: 'notify.webhook_gone',
					level: 'warn',
					tenant: rt.tenant.id,
					channel: target.channelId,
				});
				const fresh = await create();
				await deps.discord.executeWebhook(fresh.id, fresh.token, target.threadId, message);
			}
		};
		return {
			label: `${event.eventKey}→thread:${target.threadId}`,
			run: async () => {
				if (inDoubt && (await alreadyPosted())) {
					deps.log({
						event: 'notify.thread_dup_skipped',
						level: 'warn',
						tenant: rt.tenant.id,
						thread: target.threadId,
					});
					return;
				}
				try {
					await attempt();
					inDoubt = false;
				} catch (err) {
					// Transport failure or 5xx: Discord may have taken the post. A 429 or 4xx did not.
					if (err instanceof DiscordApiError && (err.status === 0 || err.status >= 500))
						inDoubt = true;
					throw err;
				}
			},
		};
	}

	/** Comment → every bound thread of the item; empty text after the translation means no message. */
	async function threadDeliveries(
		rt: TenantRuntime,
		event: Extract<PlaneEvent, { kind: 'comment.created' }>,
		html: string,
	): Promise<Delivery[]> {
		const threads = deps.store.threadsOfItem(rt.tenant.id, event.workItemId);
		if (threads.length === 0) return [];
		const members = await rt.members();
		const content = planeHtmlToDiscord(html, (id) => {
			const discordId = rt.users.toDiscord(id);
			if (discordId !== null) return `<@${discordId}>`;
			return `@${members.find((m) => m.id === id)?.displayName || UNKNOWN_ACTOR}`;
		}).trim();
		if (content === '') return [];
		const author = members.find((m) => m.id === event.actorId);
		const avatarUrl = webhookAvatar(author?.avatarUrl);
		const message = {
			content,
			username: webhookUsername(author?.displayName),
			...(avatarUrl === undefined ? {} : { avatarUrl }),
		};
		return threads.map((t) => threadDelivery(rt, event, t, message));
	}

	async function onComment(
		rt: TenantRuntime,
		event: Extract<PlaneEvent, { kind: 'comment.created' }>,
	): Promise<Delivery[]> {
		const bot = await rt.plane.botUserId();
		if (event.actorId === bot) return (skip(event, 'own'), []);
		const html =
			event.commentHtml ??
			(await rt.plane.getComment(event.projectId, event.workItemId, event.commentId)).html;
		const recipients = new Map<string, string>();
		addRecipients(
			rt,
			recipients,
			new Set([bot, event.actorId]),
			planeMentions(html),
			'Тебя упомянули в комментарии',
		);
		// Comments never go to channels: a mention of the bot arrives as agent.mention. Bound threads get them.
		const inThreads = await threadDeliveries(rt, event, html);
		if (recipients.size === 0) {
			if (inThreads.length === 0) skip(event, 'no_effect');
			return inThreads;
		}
		const item = await rt.plane.getWorkItem(event.projectId, event.workItemId);
		return [
			...(await assemble(rt, event, item, event.actorId, null, [], recipients)),
			...inThreads,
		];
	}

	async function onMention(
		rt: TenantRuntime,
		event: Extract<PlaneEvent, { kind: 'agent.mention' }>,
	): Promise<Delivery[]> {
		// The run is answered whatever happens to the channels, or Plane marks it stale after 5 minutes.
		const answer = (body: string): Delivery => ({
			label: `${event.eventKey}→run:${event.runId}`,
			run: () => rt.plane.createRunActivity(event.runId, body),
		});
		// A hidden project is hidden entirely: nothing goes to Discord, the run still gets a short neutral answer.
		if (rt.tenant.hiddenProjects.includes(event.projectId))
			return (skip(event, 'hidden_project'), [answer(HIDDEN)]);
		// A channel where the item has a bound thread is covered by the thread sync: sending here would duplicate.
		const threaded = new Set(
			deps.store.threadsOfItem(rt.tenant.id, event.workItemId).map((t) => t.channelId),
		);
		const routed = await channelsFor(rt, event.projectId, event.workItemId, 'mention');
		if (routed.length === 0) return [answer(NO_CHANNEL)];
		const channels = routed.filter((r) => !threaded.has(r.channelId));
		if (channels.length === 0) return [answer(IN_THREAD)];
		const project = await findProject(rt, event.projectId);
		if (!project) return (skip(event, 'unknown_project', 'error'), [answer(NO_PROJECT)]);
		const item = await rt.plane.getWorkItem(event.projectId, event.workItemId);
		const key = workItemKey(project.identifier, item.sequenceId);
		const url = workItemUrl(deps.planeUrl, rt.tenant.workspace, key);
		const people = actors(rt);
		let who = UNKNOWN_ACTOR;
		let quote: string | null = null;
		if (event.commentId !== null) {
			const found = await rt.plane.getComment(event.projectId, event.workItemId, event.commentId);
			who = await people.who(found.actorId);
			const members = await people.list();
			const markdown = planeHtmlToDiscord(found.html, (id) => {
				const discordId = rt.users.toDiscord(id);
				if (discordId !== null) return `<@${discordId}>`;
				return `@${members.find((m) => m.id === id)?.displayName || UNKNOWN_ACTOR}`;
			}).trim();
			if (markdown !== '')
				quote = truncate(markdown, QUOTE_MAX)
					.split('\n')
					.map((line) => `> ${line}`)
					.join('\n');
		}
		// The quote goes last: Discord's length cut then eats the quote, never the link.
		const message: OutMessage = {
			content: [
				`**${key}** ${item.name}`,
				`Упомянули бота · ${who}`,
				`[Открыть в Plane](<${url}>)`,
				...(quote === null ? [] : [quote]),
			].join('\n'),
		};
		return [
			...channels.map((r) => channelDelivery(rt, event, item, key, r.channelId, message)),
			answer(`→ Discord: ${channels.map((r) => r.channelId).join(', ')}`),
		];
	}

	return async (event) => {
		const rt = deps.runtimes.get(event.tenant);
		if (!rt) return (skip(event, 'unknown_tenant', 'error'), []);
		// Hidden projects (the owner's decision 2026-10-23): no topics, no DMs, no mention forwarding.
		const projectId = 'item' in event ? event.item.projectId : event.projectId;
		if (event.kind !== 'agent.mention' && rt.tenant.hiddenProjects.includes(projectId))
			return (skip(event, 'hidden_project'), []);
		switch (event.kind) {
			case 'workitem.created':
				return onCreated(rt, event);
			case 'workitem.updated':
				return onUpdated(rt, event);
			case 'comment.created':
				return onComment(rt, event);
			case 'agent.mention':
				return onMention(rt, event);
		}
	};
}
