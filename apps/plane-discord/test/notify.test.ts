import { describe, expect, test } from 'bun:test';

import type { ChannelRoute } from '../src/config.ts';
import {
	DISCORD_ERR,
	DiscordApiError,
	type OutMessage,
	deliveryNonce,
} from '../src/discord/rest.ts';
import { type Delivery, routesFor } from '../src/notify.ts';
import { SerialQueue } from '../src/queue.ts';
import { FakeDiscord } from './fake-discord.ts';
import {
	ALICE,
	ANNOUNCE,
	BOB,
	BOT,
	build,
	CAROL,
	comment,
	created,
	D_ALICE,
	D_BOB,
	D_BOT,
	FORUM,
	FORUM_2,
	ID,
	ITEM,
	LINK,
	mentionHtml,
	MOD_A,
	MOD_B,
	OTHER_PROJECT,
	PROJECT,
	route,
	runAll,
	S_BACKLOG,
	S_CANCEL,
	S_DONE,
	S_DONE_2,
	S_STARTED,
	sent,
	sentRaw,
	setup,
	tenantOf,
	TEXT,
	updated,
	VOICE,
} from './notify-world.ts';

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
		expect(store.findByThread('d1')).toEqual({
			tenant: 'initech',
			projectId: PROJECT,
			workItemId: ITEM,
			channelId: FORUM,
		});
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

	test('автор с пустым именем в members → «кто-то»', async () => {
		const { notify, plane, discord } = setup([route(TEXT)]);
		plane.members.push({ id: ID(98), displayName: '' });
		await runAll(await notify(created({}, ID(98))));
		expect(sent(discord)[0]?.[1].content.split('\n')[1]).toBe('Задача создана · кто-то');
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

describe('createNotifier: бот не получает личку', () => {
	const withBotMapped = () => {
		const tenant = tenantOf([]);
		// a misconfigured table that maps the bot itself must not turn into a DM
		tenant.users = [...tenant.users, { plane: BOT, discord: D_BOT }];
		return setup([], tenant);
	};

	test('создана задача с ботом-исполнителем и упомянутым ботом → DM только человеку', async () => {
		const { notify, discord } = withBotMapped();
		await runAll(
			await notify(created({ assignees: [BOT, BOB], descriptionHtml: mentionHtml(BOT) })),
		);
		expect(discord.callsOf('openDm')).toEqual([[D_BOB]]);
	});

	test('обновление: бот назначен и упомянут в описании → DM нет', async () => {
		const { notify } = withBotMapped();
		expect(await notify(updated({ assignees: [] }, { assignees: [BOT] }))).toEqual([]);
		expect(
			await notify(updated({ descriptionHtml: null }, { descriptionHtml: mentionHtml(BOT) })),
		).toEqual([]);
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

	test('таймаут POST (status 0) после того, как Discord сообщение создал → повтор с тем же nonce; другая доставка — другой nonce', async () => {
		const { notify, discord, queue, queueLogs } = setupQueue([route(TEXT), route(ANNOUNCE)]);
		discord.script.set(TEXT, [new DiscordApiError(0, 'POST', '/channels/:id/messages')]);
		for (const d of await notify(created({ assignees: [BOB] }))) queue.push(d.label, d.run);
		await queue.idle();
		expect(queueLogs).toEqual([expect.objectContaining({ event: 'job.retry', attempt: 1 })]);
		const calls = sentRaw(discord);
		expect(calls.map(([channel]) => channel)).toEqual([TEXT, TEXT, ANNOUNCE, `dm-${D_BOB}`]);
		const [first, retry, other, dm] = calls.map(([, message]) => message.nonce);
		expect(first).toBe(deliveryNonce(`issue.created:x→channel:${TEXT}`));
		expect(retry).toBe(first);
		expect(other).toBe(deliveryNonce(`issue.created:x→channel:${ANNOUNCE}`));
		expect(dm).toBe(deliveryNonce(`issue.created:x→dm:${D_BOB}`));
		expect(new Set([first, other, dm]).size).toBe(3);
		for (const n of [first, other, dm]) expect(n?.length).toBeLessThanOrEqual(25);
	});

	test('форум: сообщение в существующий пост несёт nonce, createForumPost — нет (эндпоинт его не принимает)', async () => {
		const { notify, discord } = setup([route(FORUM)]);
		await runAll(await notify(created({}, ALICE)));
		await runAll(await notify(updated({ stateId: S_STARTED }, { stateId: S_DONE }, ALICE)));
		const [post] = discord.callsOf('createForumPost') as Array<[string, string, OutMessage]>;
		expect(post?.[2]).not.toHaveProperty('nonce');
		expect(sentRaw(discord).map(([, message]) => message.nonce)).toEqual([
			deliveryNonce(`issue.updated:x→channel:${FORUM}`),
		]);
	});

	test('транспортный сбой (status 0) на openDm один раз → повтор, DM доставлен', async () => {
		const { notify, discord, queue, queueLogs } = setupQueue([]);
		let failed = false;
		const open = discord.openDm.bind(discord);
		discord.openDm = async (id) => {
			if (!failed) {
				failed = true;
				throw new DiscordApiError(0, 'POST', '/users/@me/channels');
			}
			return open(id);
		};
		for (const d of await notify(created({ assignees: [BOB] }))) queue.push(d.label, d.run);
		await queue.idle();
		expect(failed).toBe(true);
		expect(sent(discord)).toHaveLength(1);
		expect(sent(discord)[0]?.[0]).toBe(`dm-${D_BOB}`);
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
		store.putThread('initech', ITEM, FORUM, 'gone-thread', null);
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
		store.putThread('initech', ITEM, FORUM, 'live-thread', null);
		const [text, forum] = await notify(created());
		discord.failures.set('sendMessage', new DiscordApiError(404, 'POST', '/x', 10003));
		await expect((text as Delivery).run()).rejects.toMatchObject({ status: 404 });
		discord.failures.set('sendMessage', new DiscordApiError(503, 'POST', '/x'));
		await expect((forum as Delivery).run()).rejects.toMatchObject({ status: 503 });
		expect(discord.callsOf('createForumPost')).toEqual([]);
		expect(store.getThread('initech', ITEM, FORUM)).toBe('live-thread');
	});
});

describe('ошибки не из Discord не принимаются за 404 и 50007', () => {
	const foreign = (extra: object) => Object.assign(new Error('boom'), extra);

	test('ошибка с status 404 не из DiscordApiError в треде — проброс, поста нет', async () => {
		const { notify, discord, store } = setup([route(FORUM)]);
		store.putThread('initech', ITEM, FORUM, 'live-thread', null);
		const [forum] = await notify(created());
		discord.failures.set('sendMessage', foreign({ status: 404 }) as DiscordApiError);
		await expect((forum as Delivery).run()).rejects.toThrow('boom');
		expect(discord.callsOf('createForumPost')).toEqual([]);
	});

	test('ошибка с code 50007 не из DiscordApiError в личке — проброс', async () => {
		const { notify, discord, logs } = setup([]);
		const [dm] = await notify(created({ assignees: [BOB] }));
		discord.failures.set('openDm', foreign({ code: DISCORD_ERR.CANNOT_DM }) as DiscordApiError);
		await expect((dm as Delivery).run()).rejects.toThrow('boom');
		expect(logs.filter((e) => e.event === 'dm.closed')).toEqual([]);
	});
});
