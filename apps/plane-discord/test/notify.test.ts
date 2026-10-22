import { describe, expect, test } from 'bun:test';

import type { ChannelRoute, Tenant } from '../src/config.ts';
import { CHANNEL, DISCORD_ERR, DiscordApiError, type OutMessage } from '../src/discord/rest.ts';
import type { LogEntry } from '../src/log.ts';
import { createNotifier, type Delivery, routesFor, type TenantRuntime } from '../src/notify.ts';
import type { PlaneEvent, WorkItemSnapshot } from '../src/plane/webhook.ts';
import { SerialQueue } from '../src/queue.ts';
import { Store } from '../src/store.ts';
import { userMap } from '../src/text.ts';
import { FakeDiscord } from './fake-discord.ts';
import { FakePlane } from './fake-plane.ts';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Plane side
const PROJECT = ID(1);
const OTHER_PROJECT = ID(2);
const ITEM = ID(100);
const MOD_A = ID(21);
const MOD_B = ID(22);
const ALICE = ID(10);
const BOB = ID(11);
const CAROL = ID(12); // in Plane, not in the user table
const BOT = ID(13);
const S_STARTED = ID(31);
const S_DONE = ID(32);
const S_DONE_2 = ID(33);
const S_CANCEL = ID(34);
const S_BACKLOG = ID(35);
// Discord side
const D_ALICE = '110000000000000001';
const D_BOB = '110000000000000002';
const D_BOT = '110000000000000003';
const GUILD = '120000000000000001';
const FORUM = '130000000000000001';
const TEXT = '130000000000000002';
const ANNOUNCE = '130000000000000003';
const FORUM_2 = '130000000000000004';
const VOICE = '130000000000000005';
const PLANE_URL = 'https://plane.example.com';
const LINK = `[Открыть в Plane](<${PLANE_URL}/example-ws/browse/LAB-41/>)`;

const route = (channelId: string, over: Partial<ChannelRoute> = {}): ChannelRoute => ({
	channelId,
	projectId: PROJECT,
	moduleId: null,
	events: ['created', 'closed', 'mention'],
	...over,
});
const tenantOf = (channels: ChannelRoute[], id = 'initech'): Tenant => ({
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
const mentionTag = (id: string, node = 'n') =>
	`<mention-component id="${node}" entity_identifier="${id}" entity_name="user_mention"></mention-component>`;
const mentionHtml = (...ids: string[]) =>
	`<p>${ids.map((id, i) => mentionTag(id, `n${i}`)).join(' ')} привет</p>`;
const snapshot = (over: Partial<WorkItemSnapshot> = {}): WorkItemSnapshot => ({
	id: ITEM,
	projectId: PROJECT,
	sequenceId: 41,
	name: 'Название',
	stateId: S_STARTED,
	assignees: [],
	descriptionHtml: null,
	...over,
});

class SpyPlane extends FakePlane {
	moduleCalls: Array<readonly string[]> = [];
	override async getWorkItemModules(p: string, w: string, ids: readonly string[]) {
		this.moduleCalls.push(ids);
		return super.getWorkItemModules(p, w, ids);
	}
}

function setup(channels: ChannelRoute[] = [route(FORUM)], tenant: Tenant = tenantOf(channels)) {
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

function build(plane: SpyPlane, discord: FakeDiscord, tenant: Tenant) {
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

const runAll = async (deliveries: Delivery[]) => {
	for (const d of deliveries) await d.run();
};
const created = (over: Partial<WorkItemSnapshot> = {}, actorId = CAROL): PlaneEvent => ({
	kind: 'workitem.created',
	tenant: 'initech',
	eventKey: 'issue.created:x',
	actorId,
	item: snapshot(over),
});
const updated = (
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
const comment = (commentHtml: string | null, actorId = CAROL): PlaneEvent => ({
	kind: 'comment.created',
	tenant: 'initech',
	eventKey: 'comment.created:c1',
	actorId,
	projectId: PROJECT,
	workItemId: ITEM,
	commentId: ID(200),
	commentHtml,
});
const agentMention = (commentId: string | null = ID(200)): PlaneEvent => ({
	kind: 'agent.mention',
	tenant: 'initech',
	eventKey: 'agent_run:r1',
	projectId: PROJECT,
	workItemId: ITEM,
	commentId,
	runId: ID(300),
});
const sent = (discord: FakeDiscord) =>
	discord.callsOf('sendMessage') as Array<[string, OutMessage]>;

describe('createNotifier: workitem.created', () => {
	test('created, канал-форум → пост «LAB-41 Название», связь в store; следующее событие по задаче — в тот же пост', async () => {
		const { notify, discord, store } = setup([route(FORUM)]);
		await runAll(await notify(created()));
		expect(discord.callsOf('createForumPost')).toEqual([
			[
				FORUM,
				'LAB-41 Название',
				{ content: `**LAB-41** Название\nЗадача создана · Carol\n${LINK}` },
			],
		]);
		expect(store.getThread('initech', ITEM, FORUM)).toBe('d1');
		expect(sent(discord)).toEqual([]);

		await runAll(await notify(updated({ stateId: S_STARTED }, { stateId: S_DONE })));
		expect(discord.callsOf('createForumPost')).toHaveLength(1);
		expect(sent(discord)).toEqual([
			['d1', { content: `**LAB-41** Название\nЗадача закрыта · Carol\n${LINK}` }],
		]);
	});

	test('created, текстовый канал → одно sendMessage', async () => {
		const { notify, discord } = setup([route(TEXT)]);
		await runAll(await notify(created({}, ALICE)));
		expect(sent(discord)).toEqual([
			[TEXT, { content: `**LAB-41** Название\nЗадача создана · <@${D_ALICE}>\n${LINK}` }],
		]);
		expect(discord.callsOf('createForumPost')).toEqual([]);
	});

	test('канал-объявления — обычное сообщение, медиа-канал — пост', async () => {
		const { notify, discord } = setup([route(ANNOUNCE), route(FORUM_2)]);
		await runAll(await notify(created()));
		expect(sent(discord).map(([channel]) => channel)).toEqual([ANNOUNCE]);
		expect(discord.callsOf('createForumPost').map(([channel]) => channel)).toEqual([FORUM_2]);
	});

	test('канал неподдерживаемого типа → notify.bad_channel, вызовов Discord нет, остальные доставки идут', async () => {
		const { notify, discord, logs } = setup([route(VOICE), route(TEXT)]);
		const deliveries = await notify(created());
		expect(deliveries).toHaveLength(2);
		await runAll(deliveries);
		expect(logs).toContainEqual({
			event: 'notify.bad_channel',
			level: 'error',
			tenant: 'initech',
			channel: VOICE,
			type: 2,
		});
		expect(sent(discord).map(([channel]) => channel)).toEqual([TEXT]);
	});

	test('проект без записи в карте → ни одного вызова Discord', async () => {
		const { notify, discord } = setup([route(FORUM, { projectId: OTHER_PROJECT })]);
		await runAll(await notify(created()));
		expect(discord.calls).toEqual([]);
	});

	test('проекта нет в списке Plane → доставок нет, notify.skip unknown_project', async () => {
		const { notify, plane, discord, logs } = setup([route(TEXT)]);
		plane.projects = [];
		expect(await notify(created())).toEqual([]);
		expect(discord.calls).toEqual([]);
		expect(logs).toContainEqual({
			event: 'notify.skip',
			level: 'error',
			tenant: 'initech',
			reason: 'unknown_project',
			eventKey: 'issue.created:x',
		});
	});

	test('тенанта события нет в runtimes → доставок нет, notify.skip unknown_tenant', async () => {
		const { notify, logs } = setup([route(TEXT)]);
		expect(await notify({ ...created(), tenant: 'ghost' })).toEqual([]);
		expect(logs).toEqual([
			{
				event: 'notify.skip',
				level: 'error',
				tenant: 'ghost',
				reason: 'unknown_tenant',
				eventKey: 'issue.created:x',
			},
		]);
	});

	test('автор не в таблице и не в members → «кто-то», не пустая строка', async () => {
		const { notify, discord } = setup([route(TEXT)]);
		await runAll(await notify(created({}, ID(99))));
		expect(sent(discord)[0]?.[1].content).toBe(
			`**LAB-41** Название\nЗадача создана · кто-то\n${LINK}`,
		);
	});
});

describe('routesFor и модули', () => {
	test('запись модуля перекрывает запись проекта; задача в двух модулях → оба канала, без дублей', async () => {
		const channels = [
			route(FORUM),
			route(TEXT, { moduleId: MOD_A }),
			route(ANNOUNCE, { moduleId: MOD_B }),
			route(FORUM_2, { moduleId: ID(23) }),
		];
		const { notify, plane, discord } = setup(channels);
		plane.modules.set(MOD_A, new Set([ITEM]));
		plane.modules.set(MOD_B, new Set([ITEM]));
		plane.modules.set(ID(23), new Set());
		await runAll(await notify(created()));
		expect(plane.moduleCalls).toEqual([[MOD_A, MOD_B, ID(23)]]);
		expect(sent(discord).map(([channel]) => channel)).toEqual([TEXT, ANNOUNCE]);
		expect(discord.callsOf('createForumPost')).toEqual([]);
	});

	test('задача вне модулей карты → запись проекта; модули в карте проекта запрашиваются один раз', async () => {
		const channels = [route(FORUM), route(TEXT, { moduleId: MOD_A })];
		const { notify, plane, discord } = setup(channels);
		plane.modules.set(MOD_A, new Set());
		await runAll(await notify(created()));
		expect(plane.moduleCalls).toEqual([[MOD_A]]);
		expect(discord.callsOf('createForumPost').map(([channel]) => channel)).toEqual([FORUM]);
		expect(sent(discord)).toEqual([]);
	});

	test('модули чужого проекта не запрашиваются; без модульных записей getWorkItemModules не вызывается', async () => {
		const { notify, plane } = setup([
			route(FORUM),
			route(TEXT, { moduleId: MOD_A, projectId: OTHER_PROJECT }),
		]);
		await notify(created());
		expect(plane.moduleCalls).toEqual([]);
	});

	test('routesFor: модуль задачи без своей записи → запись проекта; один канал дважды → одна запись', () => {
		const tenant = tenantOf([
			route(FORUM),
			route(TEXT, { moduleId: MOD_A }),
			route(ANNOUNCE, { moduleId: MOD_B }),
			route(ANNOUNCE, { moduleId: MOD_A, events: ['closed'] }),
			route(FORUM_2, { projectId: OTHER_PROJECT }),
		]);
		expect(routesFor(tenant, PROJECT, []).map((r) => r.channelId)).toEqual([FORUM]);
		expect(routesFor(tenant, PROJECT, [MOD_B]).map((r) => r.channelId)).toEqual([ANNOUNCE]);
		const both = routesFor(tenant, PROJECT, [MOD_A, MOD_B]);
		expect(both.map((r) => r.channelId)).toEqual([TEXT, ANNOUNCE]);
		// the first entry of a duplicated channel wins
		expect(both[1]?.moduleId).toBe(MOD_B);
	});
});

describe('createNotifier: workitem.updated', () => {
	test('started → completed: «закрыта»; → cancelled: «отменена»; completed → другое completed: ничего', async () => {
		const { notify, discord, logs } = setup([route(TEXT)]);
		await runAll(await notify(updated({ stateId: S_STARTED }, { stateId: S_DONE })));
		await runAll(await notify(updated({ stateId: S_STARTED }, { stateId: S_CANCEL })));
		expect(sent(discord).map(([, m]) => m.content.split('\n')[1])).toEqual([
			'Задача закрыта · Carol',
			'Задача отменена · Carol',
		]);
		const before = discord.calls.length;
		const none = await notify(updated({ stateId: S_DONE }, { stateId: S_DONE_2 }));
		expect(none).toEqual([]);
		expect(discord.calls.length).toBe(before);
		expect(logs).toContainEqual({
			event: 'notify.skip',
			tenant: 'initech',
			reason: 'no_effect',
			eventKey: 'issue.updated:x',
		});
	});

	test('completed → cancelled — другая группа: «отменена»; из started в started — ничего', async () => {
		const { notify, discord } = setup([route(TEXT)]);
		await runAll(await notify(updated({ stateId: S_DONE }, { stateId: S_CANCEL })));
		expect(sent(discord)[0]?.[1].content.split('\n')[1]).toBe('Задача отменена · Carol');
		expect(await notify(updated({ stateId: S_BACKLOG }, { stateId: S_STARTED }))).toEqual([]);
	});

	test('состояние без прежнего (old_value null) → completed: закрытие; смена исполнителей закрытой задачи — нет', async () => {
		const { notify, discord } = setup([route(TEXT)]);
		await runAll(await notify(updated({}, { stateId: S_DONE })));
		expect(sent(discord)).toHaveLength(1);
		// the same completed item, but the changed field is the assignees: not a closing
		const none = await notify(updated({ assignees: [] }, { stateId: S_DONE, assignees: [CAROL] }));
		expect(none).toEqual([]);
		const noneDescription = await notify(
			updated({ descriptionHtml: null }, { stateId: S_DONE, descriptionHtml: '<p>x</p>' }),
		);
		expect(noneDescription).toEqual([]);
		expect(sent(discord)).toHaveLength(1);
	});

	test('состояния нет в списке проекта → notify.skip unknown_state, доставок нет', async () => {
		const { notify, logs } = setup([route(TEXT)]);
		expect(await notify(updated({ stateId: S_STARTED }, { stateId: ID(77) }))).toEqual([]);
		expect(logs).toContainEqual({
			event: 'notify.skip',
			level: 'error',
			tenant: 'initech',
			reason: 'unknown_state',
			eventKey: 'issue.updated:x',
		});
	});

	test('прежнего состояния нет в списке проекта, новое completed → закрытие', async () => {
		const { notify, discord } = setup([route(TEXT)]);
		await runAll(await notify(updated({ stateId: ID(78) }, { stateId: S_DONE })));
		expect(sent(discord)).toHaveLength(1);
	});

	test('канал без closed в events не получает закрытие', async () => {
		const { notify, discord } = setup([route(TEXT, { events: ['created', 'mention'] })]);
		await runAll(await notify(updated({ stateId: S_STARTED }, { stateId: S_DONE })));
		expect(discord.calls).toEqual([]);
	});

	test('модульная запись без closed перекрывает проектную с closed', async () => {
		const { notify, plane, discord } = setup([
			route(FORUM),
			route(TEXT, { moduleId: MOD_A, events: ['created'] }),
		]);
		plane.modules.set(MOD_A, new Set([ITEM]));
		await runAll(await notify(updated({ stateId: S_STARTED }, { stateId: S_DONE })));
		expect(discord.calls).toEqual([]);
	});

	test('новые исполнители из таблицы → DM каждому, кроме автора; немапленный — без DM', async () => {
		const { notify, discord } = setup([route(TEXT)]);
		const deliveries = await notify(
			updated({ assignees: [BOB] }, { assignees: [BOB, ALICE, CAROL, ID(14)] }, ALICE),
		);
		// ALICE is the author, CAROL and ID(14) are not in the table, BOB was assigned before.
		expect(deliveries).toEqual([]);
		const second = await notify(
			updated({ assignees: [] }, { assignees: [BOB, ALICE, CAROL] }, ALICE),
		);
		expect(second).toHaveLength(1);
		await runAll(second);
		expect(discord.callsOf('openDm')).toEqual([[D_BOB]]);
		expect(sent(discord)).toEqual([
			[`dm-${D_BOB}`, { content: `**LAB-41** Название\nТебя назначили · <@${D_ALICE}>\n${LINK}` }],
		]);
	});

	test('упоминание в описании: DM только новым относительно previous', async () => {
		const { notify, discord } = setup([route(TEXT)]);
		const deliveries = await notify(
			updated(
				{ descriptionHtml: mentionHtml(ALICE) },
				{ descriptionHtml: mentionHtml(ALICE, BOB, CAROL) },
			),
		);
		await runAll(deliveries);
		expect(discord.callsOf('openDm')).toEqual([[D_BOB]]);
		expect(sent(discord)[0]?.[1].content).toBe(
			`**LAB-41** Название\nТебя упомянули в описании · Carol\n${LINK}`,
		);
	});

	test('описание было пустым и стало пустым, или упоминание убрали → доставок нет', async () => {
		const { notify } = setup([route(TEXT)]);
		expect(await notify(updated({ descriptionHtml: null }, { descriptionHtml: null }))).toEqual([]);
		const second = await notify(
			updated({ descriptionHtml: mentionHtml(BOB) }, { descriptionHtml: null }),
		);
		expect(second).toEqual([]);
	});

	test('автор — бот → доставок нет, notify.skip own', async () => {
		const { notify, discord, logs } = setup([route(TEXT)]);
		expect(await notify(updated({ stateId: S_STARTED }, { stateId: S_DONE }, BOT))).toEqual([]);
		expect(await notify(created({ assignees: [BOB] }, BOT))).toEqual([]);
		expect(await notify(comment(mentionHtml(BOB), BOT))).toEqual([]);
		expect(discord.calls).toEqual([]);
		expect(logs.filter((e) => e.event === 'notify.skip' && e.reason === 'own')).toEqual([
			{ event: 'notify.skip', tenant: 'initech', reason: 'own', eventKey: 'issue.updated:x' },
			{ event: 'notify.skip', tenant: 'initech', reason: 'own', eventKey: 'issue.created:x' },
			{ event: 'notify.skip', tenant: 'initech', reason: 'own', eventKey: 'comment.created:c1' },
		]);
	});

	test('бот тенанта — свой: app_bot другого тенанта не считается своим', async () => {
		const { notify, plane } = setup([route(TEXT)]);
		plane.botId = ID(15);
		const deliveries = await notify(created({}, BOT));
		expect(deliveries).toHaveLength(1);
	});
});

describe('createNotifier: личка при создании', () => {
	test('исполнитель и упомянутый в описании → DM; человек и исполнитель, и упомянутый — одно письмо «назначили»', async () => {
		const { notify, discord } = setup([]);
		const deliveries = await notify(
			created({ assignees: [BOB, ALICE], descriptionHtml: mentionHtml(BOB, ALICE) }, ALICE),
		);
		await runAll(deliveries);
		expect(discord.callsOf('openDm')).toEqual([[D_BOB]]);
		expect(sent(discord)[0]?.[1].content.split('\n')[1]).toBe(`Тебя назначили · <@${D_ALICE}>`);
	});

	test('только упомянут в описании → «упомянули в описании»', async () => {
		const { notify, discord } = setup([]);
		await runAll(await notify(created({ descriptionHtml: mentionHtml(BOB) }, ALICE)));
		expect(sent(discord).map(([channel]) => channel)).toEqual([`dm-${D_BOB}`]);
		expect(sent(discord)[0]?.[1].content.split('\n')[1]).toBe(
			`Тебя упомянули в описании · <@${D_ALICE}>`,
		);
	});
});

describe('createNotifier: comment.created', () => {
	test('упоминание в комментарии → DM упомянутому; упомянул сам себя — нет', async () => {
		const { notify, discord } = setup([route(TEXT)]);
		const deliveries = await notify(comment(mentionHtml(BOB, ALICE), ALICE));
		await runAll(deliveries);
		expect(discord.callsOf('openDm')).toEqual([[D_BOB]]);
		expect(sent(discord)).toEqual([
			[
				`dm-${D_BOB}`,
				{
					content: `**LAB-41** Название\nТебя упомянули в комментарии · <@${D_ALICE}>\n${LINK}`,
				},
			],
		]);
		expect(await notify(comment(mentionHtml(ALICE), ALICE))).toEqual([]);
	});

	test('HTML из события нет → comment берётся через getComment', async () => {
		const { notify, plane, discord } = setup([route(TEXT)]);
		plane.comments.push({
			id: ID(200),
			html: mentionHtml(BOB),
			actorId: CAROL,
			externalSource: null,
			externalId: null,
			projectId: PROJECT,
			workItemId: ITEM,
		});
		await runAll(await notify(comment(null)));
		expect(discord.callsOf('openDm')).toEqual([[D_BOB]]);
	});

	test('комментарий без упоминаний → доставок нет, запросов Plane к задаче нет', async () => {
		const { notify, plane, logs } = setup([route(TEXT)]);
		plane.items.clear();
		expect(await notify(comment('<p>просто текст</p>'))).toEqual([]);
		expect(logs).toContainEqual({
			event: 'notify.skip',
			tenant: 'initech',
			reason: 'no_effect',
			eventKey: 'comment.created:c1',
		});
	});

	test('comment.created с упоминанием бота → ни одного сообщения в каналы, DM только упомянутому человеку', async () => {
		const tenant = tenantOf([route(TEXT), route(FORUM)]);
		// a misconfigured table that maps the bot itself must not turn into a DM
		tenant.users = [...tenant.users, { plane: BOT, discord: D_BOT }];
		const { notify, discord } = setup([], tenant);
		await runAll(await notify(comment(mentionHtml(BOT, BOB))));
		expect(discord.callsOf('openDm')).toEqual([[D_BOB]]);
		expect(sent(discord).map(([channel]) => channel)).toEqual([`dm-${D_BOB}`]);
		expect(discord.callsOf('createForumPost')).toEqual([]);
	});
});

describe('createNotifier: личка и ошибки Discord', () => {
	for (const failing of ['openDm', 'sendMessage'] as const) {
		test(`личка закрыта (50007 на ${failing}) → dm.closed, остальные доставки выполнены, исключения нет`, async () => {
			const { notify, discord, logs } = setup([route(TEXT)]);
			const deliveries = await notify(created({ assignees: [ALICE, BOB] }, CAROL));
			// channel, DM Alice, DM Bob
			expect(deliveries).toHaveLength(3);
			const [toChannel, toAlice, toBob] = deliveries as [Delivery, Delivery, Delivery];
			await toChannel.run();
			discord.failures.set(failing, new DiscordApiError(403, 'POST', '/x', DISCORD_ERR.CANNOT_DM));
			await toAlice.run();
			discord.failures.delete(failing);
			await toBob.run();
			expect(logs).toContainEqual({
				event: 'dm.closed',
				level: 'warn',
				tenant: 'initech',
				user: D_ALICE,
			});
			expect(sent(discord).map(([channel]) => channel)).toEqual(
				failing === 'openDm' ? [TEXT, `dm-${D_BOB}`] : [TEXT, `dm-${D_ALICE}`, `dm-${D_BOB}`],
			);
		});
	}

	test('другая ошибка лички (403 без кода 50007) пробрасывается: очередь решит, повторять ли', async () => {
		const { notify, discord } = setup([]);
		const [dm] = await notify(created({ assignees: [BOB] }));
		discord.failures.set('openDm', new DiscordApiError(403, 'POST', '/x', 40333));
		await expect((dm as Delivery).run()).rejects.toMatchObject({ status: 403, code: 40333 });
	});
});

class ScriptedDiscord extends FakeDiscord {
	/** channelId → errors to throw on the next sendMessage calls to it, in order */
	script = new Map<string, DiscordApiError[]>();
	override async sendMessage(channelId: string, message: OutMessage) {
		const next = this.script.get(channelId)?.shift();
		if (next) {
			this.calls.push({ method: 'sendMessage', args: [channelId, message] });
			throw next;
		}
		return super.sendMessage(channelId, message);
	}
}

function setupQueue(channels: ChannelRoute[]) {
	const base = setup(channels);
	const discord = new ScriptedDiscord();
	discord.channels = base.discord.channels;
	const { notify, store, logs } = build(base.plane, discord, base.tenant);
	const queueLogs: unknown[] = [];
	const queue = new SerialQueue({ log: (e) => queueLogs.push(e), sleep: async () => {} });
	return { notify, discord, store, logs, queue, queueLogs };
}

describe('доставки через очередь', () => {
	test('нет доступа (403, 50013) к одному каналу → остальные получают, повтора нет', async () => {
		const { notify, discord, queue, queueLogs } = setupQueue([route(TEXT), route(ANNOUNCE)]);
		discord.script.set(TEXT, [
			new DiscordApiError(403, 'POST', '/channels/:id/messages', DISCORD_ERR.MISSING_PERMISSIONS),
		]);
		for (const d of await notify(created({ assignees: [BOB] }))) queue.push(d.label, d.run);
		await queue.idle();
		expect(discord.callsOf('sendMessage').map((a) => (a as string[])[0])).toEqual([
			TEXT,
			ANNOUNCE,
			`dm-${D_BOB}`,
		]);
		expect(queueLogs).toHaveLength(1);
		expect(queueLogs[0]).toMatchObject({ event: 'job.dropped', attempt: 1 });
	});

	test('5xx на втором канале → повторяется только он, уже отправленное не дублируется', async () => {
		const { notify, discord, queue, queueLogs } = setupQueue([route(TEXT), route(ANNOUNCE)]);
		discord.script.set(ANNOUNCE, [new DiscordApiError(503, 'POST', '/channels/:id/messages')]);
		for (const d of await notify(created())) queue.push(d.label, d.run);
		await queue.idle();
		expect(discord.callsOf('sendMessage').map((a) => (a as string[])[0])).toEqual([
			TEXT,
			ANNOUNCE,
			ANNOUNCE,
		]);
		expect(queueLogs).toEqual([expect.objectContaining({ event: 'job.retry', attempt: 1 })]);
	});

	test('метки доставок: id события и адресат, без названия и текста', async () => {
		const { notify } = setupQueue([route(TEXT)]);
		const labels = (await notify(created({ assignees: [BOB] }))).map((d) => d.label);
		expect(labels).toEqual([`issue.created:x→channel:${TEXT}`, `issue.created:x→dm:${D_BOB}`]);
	});
});

describe('форум: удалённый пост', () => {
	test('пост форума удалён (404) → новый пост, связь перезаписана', async () => {
		const { notify, discord, store, logs } = setup([route(FORUM)]);
		store.putThread('initech', ITEM, FORUM, 'gone-thread');
		discord.failures.set('sendMessage', new DiscordApiError(404, 'POST', '/x', 10003));
		await runAll(await notify(updated({ stateId: S_STARTED }, { stateId: S_DONE })));
		discord.failures.delete('sendMessage');
		expect(discord.callsOf('sendMessage').map((a) => (a as string[])[0])).toEqual(['gone-thread']);
		expect(discord.callsOf('createForumPost')).toEqual([
			[
				FORUM,
				'LAB-41 Название',
				{ content: `**LAB-41** Название\nЗадача закрыта · Carol\n${LINK}` },
			],
		]);
		expect(store.getThread('initech', ITEM, FORUM)).toBe('d1');
		expect(logs).toContainEqual({
			event: 'notify.thread_gone',
			level: 'warn',
			tenant: 'initech',
			channel: FORUM,
			thread: 'gone-thread',
		});
	});

	test('404 в текстовом канале и 5xx в треде не пересоздают пост, а пробрасываются', async () => {
		const { notify, discord, store } = setup([route(TEXT), route(FORUM)]);
		store.putThread('initech', ITEM, FORUM, 'live-thread');
		const [text, forum] = await notify(created());
		discord.failures.set('sendMessage', new DiscordApiError(404, 'POST', '/x', 10003));
		await expect((text as Delivery).run()).rejects.toMatchObject({ status: 404 });
		discord.failures.set('sendMessage', new DiscordApiError(503, 'POST', '/x'));
		await expect((forum as Delivery).run()).rejects.toMatchObject({ status: 503 });
		expect(discord.callsOf('createForumPost')).toEqual([]);
		expect(store.getThread('initech', ITEM, FORUM)).toBe('live-thread');
	});
});

describe('createNotifier: agent.mention', () => {
	const setupMention = (channels: ChannelRoute[]) => {
		const ctx = setup(channels);
		ctx.plane.comments.push({
			id: ID(200),
			html: `<p>Привет, ${mentionTag(ALICE)} ${mentionTag(CAROL)} привет</p>`,
			actorId: ALICE,
			externalSource: null,
			externalId: null,
			projectId: PROJECT,
			workItemId: ITEM,
		});
		return ctx;
	};

	test('agent.mention → каналы с mention, цитата из getComment, createRunActivity; без канала — ответ «канал не настроен»', async () => {
		const { notify, discord, plane } = setupMention([
			route(TEXT),
			route(ANNOUNCE, { events: ['created'] }),
		]);
		await runAll(await notify(agentMention()));
		expect(sent(discord)).toEqual([
			[
				TEXT,
				{
					content: `**LAB-41** Название\nУпомянули бота · <@${D_ALICE}>\n${LINK}\n> Привет, <@${D_ALICE}> @Carol привет`,
				},
			],
		]);
		expect(plane.activities).toEqual([{ runId: ID(300), body: `→ Discord: ${TEXT}` }]);

		const none = setupMention([
			route(TEXT, { events: ['created'] }),
			route(FORUM, { projectId: OTHER_PROJECT }),
		]);
		await runAll(await none.notify(agentMention()));
		expect(none.discord.calls).toEqual([]);
		expect(none.plane.activities).toEqual([
			{ runId: ID(300), body: 'Канал для проекта не настроен' },
		]);
	});

	test('ответ run — после доставок в каналы и один на событие; в форум идёт постом', async () => {
		const { notify, discord, plane } = setupMention([route(FORUM), route(TEXT)]);
		const deliveries = await notify(agentMention());
		expect(deliveries.map((d) => d.label)).toEqual([
			`agent_run:r1→channel:${FORUM}`,
			`agent_run:r1→channel:${TEXT}`,
			`agent_run:r1→run:${ID(300)}`,
		]);
		expect(plane.activities).toEqual([]);
		await runAll(deliveries);
		expect(plane.activities).toEqual([{ runId: ID(300), body: `→ Discord: ${FORUM}, ${TEXT}` }]);
		expect(discord.callsOf('createForumPost')).toHaveLength(1);
	});

	test('без commentId → сообщение без цитаты, getComment не нужен', async () => {
		const { notify, discord } = setup([route(TEXT)]);
		await runAll(await notify(agentMention(null)));
		expect(sent(discord)[0]?.[1].content).toBe(
			`**LAB-41** Название\nУпомянули бота · кто-то\n${LINK}`,
		);
	});

	test('длинная цитата режется до 1000 символов и стоит после ссылки', async () => {
		const { notify, discord, plane } = setupMention([route(TEXT)]);
		plane.comments[0]!.html = `<p>${'я'.repeat(3000)}</p>`;
		await runAll(await notify(agentMention()));
		const lines = (sent(discord)[0]?.[1].content ?? '').split('\n');
		expect(lines[3]).toBe(`> ${'я'.repeat(999)}…`);
		expect(lines[2]).toBe(LINK);
		expect(lines).toHaveLength(4);
	});

	test('комментарий без текста → сообщение без цитаты', async () => {
		const { notify, discord, plane } = setupMention([route(TEXT)]);
		plane.comments[0]!.html = '<p></p>';
		await runAll(await notify(agentMention()));
		expect(sent(discord)[0]?.[1].content).toBe(
			`**LAB-41** Название\nУпомянули бота · <@${D_ALICE}>\n${LINK}`,
		);
	});

	test('многострочная цитата — каждая строка с «> »', async () => {
		const { notify, discord, plane } = setupMention([route(TEXT)]);
		plane.comments[0]!.html = '<p>первая</p><p>вторая</p>';
		await runAll(await notify(agentMention()));
		expect((sent(discord)[0]?.[1].content ?? '').split('\n').slice(3)).toEqual([
			'> первая',
			'> ',
			'> вторая',
		]);
	});

	test('проекта нет в списке Plane → run всё равно получает ответ', async () => {
		const { notify, plane, discord, logs } = setupMention([route(TEXT)]);
		plane.projects = [];
		await runAll(await notify(agentMention()));
		expect(discord.calls).toEqual([]);
		expect(plane.activities).toEqual([
			{ runId: ID(300), body: 'Не удалось отправить в Discord: проект не найден в Plane' },
		]);
		expect(logs).toContainEqual({
			event: 'notify.skip',
			level: 'error',
			tenant: 'initech',
			reason: 'unknown_project',
			eventKey: 'agent_run:r1',
		});
	});
});

describe('логи', () => {
	test('ни одна запись не содержит названия задачи, текста описания и комментария', async () => {
		const { notify, logs } = setup([route(VOICE), route(TEXT)]);
		await runAll(
			await notify(
				created({ name: 'СЕКРЕТНОЕ-НАЗВАНИЕ', descriptionHtml: mentionHtml(BOB) }, ALICE),
			),
		);
		await notify({ ...updated({ stateId: S_STARTED }, { stateId: ID(77) }), tenant: 'initech' });
		expect(logs.length).toBeGreaterThan(0);
		expect(JSON.stringify(logs)).not.toContain('СЕКРЕТНОЕ');
	});
});
