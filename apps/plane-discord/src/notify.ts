// Plane events → Discord topics and DMs (design §3 «1a», «1b», §5 «Шум»).
// The notifier does not send anything itself: Plane lookups happen in the returned promise (the caller retries
// the event as a whole when one fails), every Discord send is its own Delivery (the queue retries only that one).
import type { ChannelRoute, EventKind, Tenant } from './config.ts';
import {
	CHANNEL,
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
	projects: () => Promise<ProjectSummary[]>;
	states: (projectId: string) => Promise<StateSummary[]>;
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
const NO_CHANNEL = 'Канал для проекта не настроен';
const NO_PROJECT = 'Не удалось отправить в Discord: проект не найден в Plane';
// Neutral on purpose: no channel names, no hint of what the tenant's map holds.
const HIDDEN = 'Пересылка в Discord для этого проекта отключена';

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
	): Promise<void> {
		// Read at run time: an earlier delivery of another event may have created the post since this list was built.
		const threadId = deps.store.getThread(rt.tenant.id, item.id, channelId);
		if (threadId !== null) {
			try {
				await deps.discord.sendMessage(threadId, message);
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
		const post = await deps.discord.createForumPost(channelId, `${key} ${item.name}`, message);
		deps.store.putThread(rt.tenant.id, item.id, channelId, post.threadId);
	}

	function channelDelivery(
		rt: TenantRuntime,
		event: PlaneEvent,
		item: Item,
		key: string,
		channelId: string,
		message: OutMessage,
	): Delivery {
		return {
			label: `${event.eventKey}→channel:${channelId}`,
			run: async () => {
				const type = await deps.channelType(channelId);
				if (type === CHANNEL.FORUM || type === CHANNEL.MEDIA)
					await toForum(rt, item, key, channelId, message);
				else if (type === CHANNEL.TEXT || type === CHANNEL.ANNOUNCEMENT)
					await deps.discord.sendMessage(channelId, message);
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
		return {
			label: `${event.eventKey}→dm:${discordId}`,
			run: async () => {
				try {
					const channelId = await deps.discord.openDm(discordId);
					await deps.discord.sendMessage(channelId, message);
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
		const project = (await rt.projects()).find((p) => p.id === item.projectId);
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
			const states = await rt.states(item.projectId);
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
		// Comments never go to channels: a mention of the bot arrives as agent.mention.
		if (recipients.size === 0) return (skip(event, 'no_effect'), []);
		const item = await rt.plane.getWorkItem(event.projectId, event.workItemId);
		return assemble(rt, event, item, event.actorId, null, [], recipients);
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
		const channels = await channelsFor(rt, event.projectId, event.workItemId, 'mention');
		if (channels.length === 0) return [answer(NO_CHANNEL)];
		const project = (await rt.projects()).find((p) => p.id === event.projectId);
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
