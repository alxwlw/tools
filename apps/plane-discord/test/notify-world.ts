import type { ChannelRoute, Tenant } from '../src/config.ts';
import { CHANNEL, type OutMessage } from '../src/discord/rest.ts';
import type { LogEntry } from '../src/log.ts';
import { createNotifier, type Delivery, type TenantRuntime } from '../src/notify.ts';
import type { PlaneEvent, WorkItemSnapshot } from '../src/plane/webhook.ts';
import { Store } from '../src/store.ts';
import { userMap } from '../src/text.ts';
import { FakeDiscord } from './fake-discord.ts';
import { FakePlane } from './fake-plane.ts';

export const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Plane side
export const PROJECT = ID(1);
export const OTHER_PROJECT = ID(2);
export const ITEM = ID(100);
export const MOD_A = ID(21);
export const MOD_B = ID(22);
export const ALICE = ID(10);
export const BOB = ID(11);
export const CAROL = ID(12); // in Plane, not in the user table
export const BOT = ID(13);
export const S_STARTED = ID(31);
export const S_DONE = ID(32);
export const S_DONE_2 = ID(33);
export const S_CANCEL = ID(34);
export const S_BACKLOG = ID(35);
// Discord side
export const D_ALICE = '110000000000000001';
export const D_BOB = '110000000000000002';
export const D_BOT = '110000000000000003';
export const GUILD = '120000000000000001';
export const FORUM = '130000000000000001';
export const TEXT = '130000000000000002';
export const ANNOUNCE = '130000000000000003';
export const FORUM_2 = '130000000000000004';
export const VOICE = '130000000000000005';
export const PLANE_URL = 'https://plane.example.com';
export const LINK = `[Открыть в Plane](<${PLANE_URL}/example-ws/browse/LAB-41/>)`;

export const route = (channelId: string, over: Partial<ChannelRoute> = {}): ChannelRoute => ({
	channelId,
	projectId: PROJECT,
	moduleId: null,
	events: ['created', 'closed', 'mention'],
	...over,
});
export const tenantOf = (channels: ChannelRoute[], id = 'initech'): Tenant => ({
	id,
	guildId: GUILD,
	workspace: 'example-ws',
	workspaceId: ID(900),
	auth: { clientId: 'client', clientSecret: 'secret', appInstallationId: ID(901) },
	webhookSecret: 'hook',
	serviceChannelId: null,
	silenceHours: 72,
	hiddenProjects: [],
	channels,
	users: [
		{ plane: ALICE, discord: D_ALICE },
		{ plane: BOB, discord: D_BOB },
	],
});
export const mentionTag = (id: string, node = 'n') =>
	`<mention-component id="${node}" entity_identifier="${id}" entity_name="user_mention"></mention-component>`;
export const mentionHtml = (...ids: string[]) =>
	`<p>${ids.map((id, i) => mentionTag(id, `n${i}`)).join(' ')} привет</p>`;
export const snapshot = (over: Partial<WorkItemSnapshot> = {}): WorkItemSnapshot => ({
	id: ITEM,
	projectId: PROJECT,
	sequenceId: 41,
	name: 'Название',
	stateId: S_STARTED,
	assignees: [],
	descriptionHtml: null,
	...over,
});

export class SpyPlane extends FakePlane {
	moduleCalls: Array<readonly string[]> = [];
	override async getWorkItemModules(p: string, w: string, ids: readonly string[]) {
		this.moduleCalls.push(ids);
		return super.getWorkItemModules(p, w, ids);
	}
}

export function setup(
	channels: ChannelRoute[] = [route(FORUM)],
	tenant: Tenant = tenantOf(channels),
) {
	const plane = new SpyPlane();
	plane.botId = BOT;
	plane.projects = [{ id: PROJECT, identifier: 'LAB', name: 'Lab' }];
	plane.states.set(PROJECT, [
		{ id: S_STARTED, name: 'In Progress', group: 'started' },
		{ id: S_DONE, name: 'Done', group: 'completed' },
		{ id: S_DONE_2, name: 'Released', group: 'completed' },
		{ id: S_CANCEL, name: 'Cancelled', group: 'cancelled' },
		{ id: S_BACKLOG, name: 'Backlog', group: 'backlog' },
	]);
	plane.members = [
		{ id: ALICE, displayName: 'Alice' },
		{ id: BOB, displayName: 'Bob' },
		{ id: CAROL, displayName: 'Carol' },
	];
	plane.items.set(ITEM, {
		id: ITEM,
		projectId: PROJECT,
		sequenceId: 41,
		name: 'Название',
		stateId: S_STARTED,
		assignees: [],
		priority: 'none',
		descriptionHtml: null,
	});
	const discord = new FakeDiscord();
	for (const [id, type] of [
		[FORUM, CHANNEL.FORUM],
		[FORUM_2, CHANNEL.MEDIA],
		[TEXT, CHANNEL.TEXT],
		[ANNOUNCE, CHANNEL.ANNOUNCEMENT],
		[VOICE, 2],
	] as const)
		discord.channels.set(id, { id, type, parentId: null, guildId: GUILD, name: 'c' });
	return build(plane, discord, tenant);
}

export function build(plane: SpyPlane, discord: FakeDiscord, tenant: Tenant) {
	const store = new Store(':memory:');
	const logs: LogEntry[] = [];
	const runtime: TenantRuntime = {
		tenant,
		plane,
		users: userMap(tenant.users),
		projects: () => plane.listProjects(),
		states: (projectId) => plane.listStates(projectId),
		members: () => plane.listMembers(),
	};
	const notify = createNotifier({
		runtimes: new Map([[tenant.id, runtime]]),
		discord,
		store,
		planeUrl: PLANE_URL,
		// not a recorded Discord call: tests count calls
		channelType: async (id) => {
			const found = discord.channels.get(id);
			if (!found) throw new Error('no channel');
			return found.type;
		},
		log: (e) => logs.push(e),
	});
	return { plane, discord, store, logs, notify, tenant };
}

export const runAll = async (deliveries: Delivery[]) => {
	for (const d of deliveries) await d.run();
};
export const created = (over: Partial<WorkItemSnapshot> = {}, actorId = CAROL): PlaneEvent => ({
	kind: 'workitem.created',
	tenant: 'initech',
	eventKey: 'issue.created:x',
	actorId,
	item: snapshot(over),
});
export const updated = (
	previous: Extract<PlaneEvent, { kind: 'workitem.updated' }>['previous'],
	over: Partial<WorkItemSnapshot> = {},
	actorId = CAROL,
): PlaneEvent => ({
	kind: 'workitem.updated',
	tenant: 'initech',
	eventKey: 'issue.updated:x',
	actorId,
	item: snapshot(over),
	previous,
});
export const comment = (commentHtml: string | null, actorId = CAROL): PlaneEvent => ({
	kind: 'comment.created',
	tenant: 'initech',
	eventKey: 'comment.created:c1',
	actorId,
	projectId: PROJECT,
	workItemId: ITEM,
	commentId: ID(200),
	commentHtml,
});
export const agentMention = (commentId: string | null = ID(200)): PlaneEvent => ({
	kind: 'agent.mention',
	tenant: 'initech',
	eventKey: 'agent_run:r1',
	projectId: PROJECT,
	workItemId: ITEM,
	commentId,
	runId: ID(300),
});
export const sent = (discord: FakeDiscord) =>
	discord.callsOf('sendMessage') as Array<[string, OutMessage]>;
