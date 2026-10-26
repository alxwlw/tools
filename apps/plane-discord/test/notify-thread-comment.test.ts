import { describe, expect, test } from 'bun:test';

import { DiscordApiError } from '../src/discord/rest.ts';
import type { GatewayMessage } from '../src/discord/gateway.ts';
import { SerialQueue } from '../src/queue.ts';
import { webhookAvatar, webhookUsername } from '../src/notify.ts';
import { createThreadSync } from '../src/thread-sync.ts';
import { userMap } from '../src/text.ts';
import {
	agentMention,
	ALICE,
	BOB,
	BOT,
	CAROL,
	comment,
	D_ALICE,
	D_BOB,
	FORUM,
	FORUM_2,
	clock,
	ID,
	ITEM,
	mentionHtml,
	mentionTag,
	PLANE_URL,
	PROJECT,
	route,
	runAll,
	sent,
	setup,
	TEXT,
} from './notify-world.ts';

const THREAD = '140000000000000001';
const THREAD_2 = '140000000000000002';
/** Discord snowflake for a moment in time, as the fake mints them. */
const snowflake = (ms: number, seq: number) =>
	((BigInt(ms) - 1420070400000n) * 4194304n + BigInt(seq)).toString();
const AVATAR = 'https://cdn.example.com/carol.png';

const bound = (channels = [route(FORUM)]) => {
	const w = setup(channels);
	w.store.putThread('initech', ITEM, FORUM, THREAD, PROJECT);
	w.plane.members = [
		{ id: ALICE, displayName: 'Alice', avatarUrl: null },
		{ id: BOB, displayName: 'Bob', avatarUrl: null },
		{ id: CAROL, displayName: 'Carol', avatarUrl: AVATAR },
	];
	return w;
};
const webhookCalls = (w: ReturnType<typeof bound>) => w.discord.callsOf('executeWebhook');

describe('createNotifier: comment.created → тред', () => {
	test('комментарий человека по задаче с тредом → сообщение webhook в тред с именем и аватаром автора', async () => {
		const w = bound();
		await runAll(await w.notify(comment('<p>Готово, проверьте</p>')));
		expect(w.discord.callsOf('createWebhook')).toEqual([[FORUM, 'Plane']]);
		const made = w.store.getWebhook(FORUM)!;
		expect(webhookCalls(w)).toEqual([
			[
				made.id,
				made.token,
				THREAD,
				{ content: 'Готово, проверьте', username: 'Carol', avatarUrl: AVATAR },
			],
		]);
		// nothing went through the bot's own sendMessage
		expect(sent(w.discord)).toEqual([]);
	});

	test('упоминания в тексте: человек из таблицы → <@id>, остальные → @имя', async () => {
		const w = bound();
		await runAll(
			await w.notify(comment(`<p>${mentionTag(ALICE)} и ${mentionTag(CAROL, 'm')}</p>`, BOB)),
		);
		const msg = webhookCalls(w).map((c) => (c[3] as { content: string }).content);
		expect(msg).toEqual([`<@${D_ALICE}> и @Carol`]);
	});

	test('упоминание человека без имени в Plane → «@кто-то»', async () => {
		const w = bound();
		w.plane.members = [{ id: ID(98), displayName: '', avatarUrl: null }];
		await runAll(await w.notify(comment(`<p>${mentionTag(ID(98))}</p>`, BOB)));
		expect((webhookCalls(w)[0]![3] as { content: string }).content).toBe('@кто-то');
	});

	test('webhook канала создаётся один раз, дальше берётся из store', async () => {
		const w = bound();
		await runAll(await w.notify(comment('<p>раз</p>')));
		await runAll(await w.notify(comment('<p>два</p>')));
		expect(w.discord.callsOf('createWebhook')).toHaveLength(1);
		const ids = webhookCalls(w).map((c) => [c[0], c[1]]);
		expect(ids).toHaveLength(2);
		expect(ids[1]).toEqual(ids[0]!);
		const made = w.store.getWebhook(FORUM)!;
		expect(ids[0]).toEqual([made.id, made.token]);
	});

	test('webhook уже в store (чужой запуск создал) → createWebhook не зовётся', async () => {
		const w = bound();
		w.store.putWebhook(FORUM, 'wh-old', 'tok-old');
		await runAll(await w.notify(comment('<p>раз</p>')));
		expect(w.discord.callsOf('createWebhook')).toEqual([]);
		expect(webhookCalls(w)[0]!.slice(0, 3)).toEqual(['wh-old', 'tok-old', THREAD]);
	});

	test('комментарий бота → ничего', async () => {
		const w = bound();
		expect(await w.notify(comment('<p>эхо</p>', BOT))).toEqual([]);
		expect(w.discord.calls).toEqual([]);
		expect(w.logs.some((l) => l.event === 'notify.skip' && l.reason === 'own')).toBe(true);
	});

	test('webhook удалён (404) → новый и повтор', async () => {
		const w = bound();
		w.store.putWebhook(FORUM, 'wh-old', 'tok-old');
		w.discord.failOnce.set(
			'executeWebhook',
			new DiscordApiError(404, 'POST', '/webhooks/wh-old/:token', 10015),
		);
		await runAll(await w.notify(comment('<p>после удаления</p>')));
		expect(w.discord.callsOf('createWebhook')).toEqual([[FORUM, 'Plane']]);
		const fresh = w.store.getWebhook(FORUM)!;
		expect(fresh.id).not.toBe('wh-old');
		expect(webhookCalls(w).map((c) => [c[0], c[1], c[2]])).toEqual([
			['wh-old', 'tok-old', THREAD],
			[fresh.id, fresh.token, THREAD],
		]);
		expect(w.logs.filter((l) => l.event === 'notify.webhook_gone')).toEqual([
			{ event: 'notify.webhook_gone', level: 'warn', tenant: 'initech', channel: FORUM },
		]);
	});

	test('webhook удалён и новый тоже отказал → ошибка уходит в очередь, третьей попытки нет', async () => {
		const w = bound();
		w.store.putWebhook(FORUM, 'wh-old', 'tok-old');
		w.discord.failures.set(
			'executeWebhook',
			new DiscordApiError(404, 'POST', '/webhooks/x/:token', 10015),
		);
		const [delivery] = await w.notify(comment('<p>x</p>'));
		await expect(delivery!.run()).rejects.toBeInstanceOf(DiscordApiError);
		expect(w.discord.callsOf('createWebhook')).toHaveLength(1);
		expect(webhookCalls(w)).toHaveLength(2);
	});

	test('404 другого рода и 5xx → ошибка как есть, webhook не пересоздаётся', async () => {
		for (const err of [
			new DiscordApiError(404, 'POST', '/webhooks/x/:token', 10008),
			// a 5xx is doubt, not a deleted thread
			new DiscordApiError(500, 'POST', '/webhooks/x/:token', 10003),
			new DiscordApiError(429, 'POST', '/webhooks/x/:token', 10003),
			new DiscordApiError(0, 'POST', '/webhooks/x/:token', 10003),
			new DiscordApiError(500, 'POST', '/webhooks/x/:token', null),
			// the code alone is not enough: only a 404 means the webhook is gone
			new DiscordApiError(500, 'POST', '/webhooks/x/:token', 10015),
		]) {
			const w = bound();
			w.store.putWebhook(FORUM, 'wh-old', 'tok-old');
			w.discord.failures.set('executeWebhook', err);
			const [delivery] = await w.notify(comment('<p>x</p>'));
			await expect(delivery!.run()).rejects.toBe(err);
			expect(w.discord.callsOf('createWebhook')).toEqual([]);
			expect(w.store.getWebhook(FORUM)).toEqual({ id: 'wh-old', token: 'tok-old' });
		}
	});

	test('имя с «Discord» или «clyde» вычищено; пустое → «Plane»', async () => {
		const w = bound();
		w.plane.members = [
			{ id: ALICE, displayName: 'Discord Алиса', avatarUrl: null },
			{ id: BOB, displayName: 'CLYDE', avatarUrl: null },
			{ id: CAROL, displayName: 'Bo DiScOrD clyde  Bo', avatarUrl: null },
		];
		for (const actor of [ALICE, BOB, CAROL, ID(77)])
			await runAll(await w.notify(comment('<p>текст</p>', actor)));
		expect(webhookCalls(w).map((c) => (c[3] as { username: string }).username)).toEqual([
			'Алиса',
			'Plane',
			'Bo Bo',
			'Plane',
		]);
	});

	test('имя и аватар: длинное имя режется до 80, не-https и относительный аватар отбрасываются', () => {
		expect(webhookUsername('я'.repeat(100))).toBe('я'.repeat(79) + '…');
		expect(webhookUsername(undefined)).toBe('Plane');
		expect(webhookAvatar(AVATAR, PLANE_URL)).toBe(AVATAR);
		expect(webhookAvatar('http://cdn.example.com/a.png', PLANE_URL)).toBeUndefined();
		expect(webhookAvatar('media/a.png', PLANE_URL)).toBeUndefined();
		expect(webhookAvatar('javascript:alert(1)', PLANE_URL)).toBeUndefined();
		expect(webhookAvatar('', PLANE_URL)).toBeUndefined();
		expect(webhookAvatar(null, PLANE_URL)).toBeUndefined();
	});

	test('аватар: путь от корня инстанса разрешается от planeUrl, только в https', () => {
		const path = '/api/assets/v2/static/u/';
		const full = 'https://plane.example.com/api/assets/v2/static/u/';
		expect(webhookAvatar(path, PLANE_URL)).toBe(full);
		expect(webhookAvatar(path, 'https://plane.example.com/')).toBe(full);
		expect(webhookAvatar(path, 'https://plane.example.com/sub//')).toBe(
			'https://plane.example.com/sub/api/assets/v2/static/u/',
		);
		expect(webhookAvatar('//evil.example/x.png', PLANE_URL)).toBeUndefined();
		expect(webhookAvatar(path, 'http://plane.example.com')).toBeUndefined();
		expect(
			webhookAvatar('http://plane.example.com/a.png', 'http://plane.example.com'),
		).toBeUndefined();
	});

	test('имя: остатки после вычистки не склеиваются в запрещённое слово', () => {
		for (const n of ['disdiscordcord', 'DiscClydeord', 'clclydeyde'])
			expect(webhookUsername(n)).not.toMatch(/discord|clyde/i);
		expect(webhookUsername('disdiscordcord')).toBe('Plane');
	});

	test('аватар: возвращается разобранный href, а не исходная строка', () => {
		expect(webhookAvatar(' https://cdn.example.com/a.png', PLANE_URL)).toBe(
			'https://cdn.example.com/a.png',
		);
	});

	test('относительный avatar_url Plane → в webhook уходит абсолютный https', async () => {
		const w = bound();
		w.plane.members = [{ id: CAROL, displayName: 'Carol', avatarUrl: '/api/assets/v2/static/c/' }];
		await runAll(await w.notify(comment('<p>x</p>')));
		expect(webhookCalls(w)[0]![3]).toEqual({
			content: 'x',
			username: 'Carol',
			avatarUrl: `${PLANE_URL}/api/assets/v2/static/c/`,
		});
	});

	test('аватар не https → в webhook нет avatarUrl', async () => {
		const w = bound();
		w.plane.members = [{ id: CAROL, displayName: 'Carol', avatarUrl: 'media/c.png' }];
		await runAll(await w.notify(comment('<p>x</p>')));
		expect(webhookCalls(w)[0]![3]).toEqual({ content: 'x', username: 'Carol' });
	});

	test('текст пуст после перевода → сообщения нет', async () => {
		const w = bound();
		expect(await w.notify(comment('<p> </p>'))).toEqual([]);
		expect(w.discord.calls).toEqual([]);
	});

	test('задача без треда → ничего (как раньше)', async () => {
		const w = setup([route(FORUM)]);
		expect(await w.notify(comment('<p>тихо</p>'))).toEqual([]);
	});

	test('два треда задачи в двух каналах → по доставке на тред, webhook у каждого канала свой', async () => {
		const w = bound([route(FORUM), route(FORUM_2)]);
		w.store.putThread('initech', ITEM, FORUM_2, THREAD_2, PROJECT);
		const deliveries = await w.notify(comment('<p>всем</p>'));
		expect(deliveries.map((d) => d.label)).toEqual([
			`comment.created:c1→thread:${THREAD}`,
			`comment.created:c1→thread:${THREAD_2}`,
		]);
		await runAll(deliveries);
		const a = w.store.getWebhook(FORUM)!;
		const b = w.store.getWebhook(FORUM_2)!;
		expect(a.id).not.toBe(b.id);
		expect(webhookCalls(w).map((c) => [c[0], c[2]])).toEqual([
			[a.id, THREAD],
			[b.id, THREAD_2],
		]);
	});

	test('упоминание человека в комментарии с тредом → и DM, и сообщение в тред', async () => {
		const w = bound();
		const deliveries = await w.notify(comment(mentionHtml(BOB), ALICE));
		expect(deliveries.map((d) => d.label).sort()).toEqual([
			`comment.created:c1→dm:${D_BOB}`,
			`comment.created:c1→thread:${THREAD}`,
		]);
	});

	test('эхо webhook, созданного доставкой, не становится комментарием', async () => {
		const w = bound();
		await runAll(await w.notify(comment('<p>из Plane</p>')));
		const made = w.store.getWebhook(FORUM)!;
		const rt = {
			tenant: w.tenant,
			plane: w.plane,
			users: userMap(w.tenant.users),
			projects: async () => w.plane.projects,
			states: async () => [],
			members: async () => w.plane.members,
		};
		const sync = createThreadSync({
			runtimes: new Map([['initech', rt]]),
			store: w.store,
			applicationId: '999999999999999999',
			log: () => {},
		});
		const echo = (webhookId: string): GatewayMessage => ({
			id: '444444444444444441',
			channelId: THREAD,
			guildId: null,
			type: 0,
			content: 'из Plane',
			author: { id: webhookId, name: 'Carol', bot: true },
			webhookId,
			applicationId: null,
			attachments: [],
			mentions: [],
		});
		await sync(echo(made.id));
		expect(w.plane.createdComments).toEqual([]);

		// the same after the webhook was recreated: the new one is recorded too
		w.discord.failOnce.set('executeWebhook', new DiscordApiError(404, 'POST', '/x', 10015));
		// the webhook is really gone in Discord: it is no longer listed
		w.discord.webhooks.delete(FORUM);
		await runAll(await w.notify(comment('<p>ещё</p>')));
		const fresh = w.store.getWebhook(FORUM)!;
		expect(fresh.id).not.toBe(made.id);
		await sync(echo(fresh.id));
		expect(w.plane.createdComments).toEqual([]);
		// positive control: a foreign webhook's message does become a comment
		await sync({ ...echo('foreign-hook'), applicationId: null });
		expect(w.plane.createdComments).toHaveLength(1);
	});
});

describe('createNotifier: webhook канала — чужой/потерянный ответ', () => {
	test('createWebhook принят, ответ потерян → повтор берёт созданный из списка, второго нет', async () => {
		const w = bound();
		w.discord.lostResponse.set(
			'createWebhook',
			new DiscordApiError(0, 'POST', '/channels/x/webhooks'),
		);
		const q = new SerialQueue({ log: () => {}, delaysMs: [0], sleep: async () => {} });
		for (const d of await w.notify(comment('<p>раз</p>'))) q.push(d.label, d.run);
		await q.idle();
		expect(w.discord.callsOf('createWebhook')).toHaveLength(1);
		const listed = w.discord.webhooks.get(FORUM)!;
		expect(listed).toHaveLength(1);
		expect(w.store.getWebhook(FORUM)).toEqual({ id: listed[0]!.id, token: listed[0]!.token! });
		expect(webhookCalls(w)).toHaveLength(1);
		expect(w.store.isOwnWebhook(listed[0]!.id)).toBe(true);
	});

	test('чужой webhook и свой без токена не берутся: создаётся новый', async () => {
		const w = bound();
		w.discord.webhooks.set(FORUM, [
			{ id: 'wh-foreign', token: 'tok-f', applicationId: 'other-app' },
			{ id: 'wh-notoken', token: null, applicationId: w.discord.applicationId },
			{ id: 'wh-noapp', token: 'tok-n', applicationId: null },
		]);
		await runAll(await w.notify(comment('<p>раз</p>')));
		expect(w.discord.callsOf('createWebhook')).toHaveLength(1);
		const stored = w.store.getWebhook(FORUM)!;
		expect(['wh-foreign', 'wh-notoken', 'wh-noapp']).not.toContain(stored.id);
	});

	test('наш webhook в списке есть, в store нет (чужой запуск, потеря БД) → берётся он', async () => {
		const w = bound();
		w.discord.webhooks.set(FORUM, [
			{ id: 'wh-foreign', token: 'tok-f', applicationId: 'other-app' },
			{ id: 'wh-ours', token: 'tok-o', applicationId: w.discord.applicationId },
		]);
		await runAll(await w.notify(comment('<p>раз</p>')));
		expect(w.discord.callsOf('createWebhook')).toEqual([]);
		expect(w.store.getWebhook(FORUM)).toEqual({ id: 'wh-ours', token: 'tok-o' });
	});
});

describe('createNotifier: удалённый тред', () => {
	const gone = () => {
		const w = setup([route(TEXT)]);
		w.store.putThread('initech', ITEM, TEXT, THREAD, PROJECT);
		w.store.putWebhook(TEXT, 'wh-old', 'tok-old');
		w.plane.members = [{ id: CAROL, displayName: 'Carol', avatarUrl: null }];
		w.plane.comments.push({
			id: ID(200),
			html: '<p>привет</p>',
			actorId: ALICE,
			externalSource: null,
			externalId: null,
			projectId: PROJECT,
			workItemId: ITEM,
		});
		return w;
	};

	test('executeWebhook 404/10003 → привязка снята, лог thread_gone, run() без ошибки; упоминание бота идёт в канал', async () => {
		const w = gone();
		// with the thread bound the mention is left to the thread sync
		const before = await w.notify(agentMention());
		await runAll(before);
		expect(sent(w.discord)).toEqual([]);
		expect(w.plane.activities.at(-1)?.body).toBe('→ Discord: в тред задачи');

		w.discord.failures.set(
			'executeWebhook',
			new DiscordApiError(404, 'POST', '/webhooks/wh-old/:token', 10003),
		);
		const [d] = await w.notify(comment('<p>в пустоту</p>'));
		await d!.run();
		expect(w.store.findByThread(THREAD)).toBeNull();
		expect(w.logs.filter((l) => l.event === 'notify.thread_gone')).toEqual([
			{
				event: 'notify.thread_gone',
				level: 'warn',
				tenant: 'initech',
				channel: TEXT,
				thread: THREAD,
			},
		]);
		expect(await w.notify(comment('<p>ещё</p>'))).toEqual([]);

		await runAll(await w.notify(agentMention()));
		expect(sent(w.discord).map(([channel]) => channel)).toEqual([TEXT]);
		expect(w.plane.activities.at(-1)?.body).toBe(`→ Discord: ${TEXT}`);
	});
});

describe('createNotifier: удалённый тред, ответ 400', () => {
	test('executeWebhook 400/10003 → привязка снята, лог thread_gone, run() без ошибки', async () => {
		const w = setup([route(TEXT)]);
		w.store.putThread('initech', ITEM, TEXT, THREAD, PROJECT);
		w.store.putWebhook(TEXT, 'wh-old', 'tok-old');
		w.discord.failures.set(
			'executeWebhook',
			new DiscordApiError(400, 'POST', '/webhooks/wh-old/:token', 10003),
		);
		const [d] = await w.notify(comment('<p>в пустоту</p>'));
		await d!.run();
		expect(w.store.findByThread(THREAD)).toBeNull();
		expect(w.logs.filter((l) => l.event === 'notify.thread_gone')).toEqual([
			{
				event: 'notify.thread_gone',
				level: 'warn',
				tenant: 'initech',
				channel: TEXT,
				thread: THREAD,
			},
		]);
	});
});

describe('createNotifier: удалённый тред после сомнительной попытки', () => {
	test('сомнение снято вместе с привязкой: следующий run() историю не читает', async () => {
		const w = setup([route(TEXT)]);
		w.store.putThread('initech', ITEM, TEXT, THREAD, PROJECT);
		w.store.putWebhook(TEXT, 'wh-old', 'tok-old');
		const [d] = await w.notify(comment('<p>x</p>'));
		w.discord.failOnce.set('executeWebhook', new DiscordApiError(502, 'POST', '/x'));
		await expect(d!.run()).rejects.toBeInstanceOf(DiscordApiError);
		w.discord.failOnce.set('executeWebhook', new DiscordApiError(404, 'POST', '/x', 10003));
		await d!.run();
		expect(w.discord.callsOf('recentMessages')).toHaveLength(1);
		await d!.run();
		expect(w.discord.callsOf('recentMessages')).toHaveLength(1);
	});
});

describe('createNotifier: повтор доставки в тред', () => {
	const queueOf = (w: ReturnType<typeof bound>) =>
		new SerialQueue({
			log: (e) => w.logs.push({ event: e.event, error: e.error }),
			delaysMs: [0],
			sleep: async () => {},
		});
	const run = async (w: ReturnType<typeof bound>) => {
		const q = queueOf(w);
		for (const d of await w.notify(comment('<p>один раз</p>'))) q.push(d.label, d.run);
		await q.idle();
	};

	test('ответ потерян, но Discord пост принял → повтор очереди не дублирует сообщение', async () => {
		const w = bound();
		w.store.putWebhook(FORUM, 'wh-old', 'tok-old');
		w.discord.lostResponse.set(
			'executeWebhook',
			new DiscordApiError(0, 'POST', '/webhooks/wh-old/:token'),
		);
		await run(w);
		expect(w.discord.posted.get(THREAD)).toHaveLength(1);
		expect(w.discord.callsOf('recentMessages')).toEqual([[THREAD, 10]]);
		expect(w.logs.filter((l) => l.event === 'notify.thread_dup_skipped')).toEqual([
			{ event: 'notify.thread_dup_skipped', level: 'warn', tenant: 'initech', thread: THREAD },
		]);
	});

	test('сбой до поста (5xx без сообщения) → повтор постит ровно один раз', async () => {
		const w = bound();
		w.store.putWebhook(FORUM, 'wh-old', 'tok-old');
		w.discord.failOnce.set(
			'executeWebhook',
			new DiscordApiError(502, 'POST', '/webhooks/wh-old/:token'),
		);
		await run(w);
		expect(w.discord.posted.get(THREAD)).toHaveLength(1);
		expect(w.discord.callsOf('recentMessages')).toHaveLength(1);
		expect(w.logs.filter((l) => l.event === 'notify.thread_dup_skipped')).toEqual([]);
	});

	test('без сбоев история не читается; после успешного повтора флаг сброшен', async () => {
		const w = bound();
		w.store.putWebhook(FORUM, 'wh-old', 'tok-old');
		const [d] = await w.notify(comment('<p>один раз</p>'));
		await d!.run();
		expect(w.discord.callsOf('recentMessages')).toEqual([]);
		w.discord.failOnce.set('executeWebhook', new DiscordApiError(500, 'POST', '/x'));
		await expect(d!.run()).rejects.toBeInstanceOf(DiscordApiError);
		w.discord.posted.clear();
		await d!.run();
		expect(w.discord.callsOf('recentMessages')).toHaveLength(1);
		await d!.run();
		expect(w.discord.callsOf('recentMessages')).toHaveLength(1);
	});

	test('тот же текст раньше от того же webhook («ок» дважды) + сбой без поста → второй комментарий всё равно постится', async () => {
		const w = bound();
		w.store.putWebhook(FORUM, 'wh-old', 'tok-old');
		const q = queueOf(w);
		const [first] = await w.notify(comment('<p>ок</p>'));
		await first!.run();
		w.discord.failOnce.set(
			'executeWebhook',
			new DiscordApiError(502, 'POST', '/webhooks/wh-old/:token'),
		);
		// the first «ок» was posted a minute ago
		clock.t += 60_000;
		for (const d of await w.notify(comment('<p>ок</p>'))) q.push(d.label, d.run);
		await q.idle();
		expect(w.discord.posted.get(THREAD)).toHaveLength(2);
		expect(w.logs.filter((l) => l.event === 'notify.thread_dup_skipped')).toEqual([]);
	});

	test('граница: пост того же webhook с тем же текстом за 5 с до попытки — наш, за 5 с + 1 мс — нет', async () => {
		for (const [offset, expected] of [
			[5000, 1],
			[5001, 2],
		] as const) {
			const w = bound();
			w.store.putWebhook(FORUM, 'wh-old', 'tok-old');
			w.discord.posted.set(THREAD, [
				{ id: snowflake(clock.t - offset, 1), webhookId: 'wh-old', content: 'один раз' },
			]);
			w.discord.failOnce.set('executeWebhook', new DiscordApiError(0, 'POST', '/x'));
			await run(w);
			expect(w.discord.posted.get(THREAD)).toHaveLength(expected);
		}
	});

	test('createWebhook упал (502) → поста не было: повтор создаёт webhook и постит, история не читается', async () => {
		const w = bound();
		w.discord.failOnce.set(
			'createWebhook',
			new DiscordApiError(502, 'POST', '/channels/x/webhooks'),
		);
		await run(w);
		expect(w.discord.posted.get(THREAD)).toHaveLength(1);
		expect(w.discord.callsOf('recentMessages')).toEqual([]);
		expect(w.logs.filter((l) => l.event === 'notify.thread_dup_skipped')).toEqual([]);
	});

	test('webhook удалён, пост через новый принят, ответ потерян → повтор не дублирует', async () => {
		const w = bound();
		w.store.putWebhook(FORUM, 'wh-old', 'tok-old');
		w.discord.failOnce.set(
			'executeWebhook',
			new DiscordApiError(404, 'POST', '/webhooks/wh-old/:token', 10015),
		);
		w.discord.lostResponse.set(
			'executeWebhook',
			new DiscordApiError(0, 'POST', '/webhooks/x/:token'),
		);
		await run(w);
		expect(w.discord.posted.get(THREAD)).toHaveLength(1);
		expect(w.discord.callsOf('createWebhook')).toHaveLength(1);
	});

	test('429 — пост не принят: повтор без чтения истории', async () => {
		const w = bound();
		w.store.putWebhook(FORUM, 'wh-old', 'tok-old');
		w.discord.failOnce.set(
			'executeWebhook',
			new DiscordApiError(429, 'POST', '/webhooks/wh-old/:token'),
		);
		await run(w);
		expect(w.discord.posted.get(THREAD)).toHaveLength(1);
		expect(w.discord.callsOf('recentMessages')).toEqual([]);
	});

	test('такой же текст в треде от другого webhook или другой текст → пост не пропускается', async () => {
		const w = bound();
		w.store.putWebhook(FORUM, 'wh-old', 'tok-old');
		w.discord.posted.set(THREAD, [
			{ id: snowflake(clock.t, 1), webhookId: 'wh-foreign', content: 'один раз' },
			{ id: snowflake(clock.t, 2), webhookId: 'wh-old', content: 'совсем другое' },
		]);
		w.discord.failOnce.set(
			'executeWebhook',
			new DiscordApiError(0, 'POST', '/webhooks/wh-old/:token'),
		);
		await run(w);
		expect(w.discord.posted.get(THREAD)).toHaveLength(3);
	});
});

describe('createNotifier: agent.mention и треды', () => {
	const withComment = (w: ReturnType<typeof setup>) =>
		w.plane.comments.push({
			id: ID(200),
			html: '<p>привет</p>',
			actorId: ALICE,
			externalSource: null,
			externalId: null,
			projectId: PROJECT,
			workItemId: ITEM,
		});

	test('упоминание бота по задаче с привязанным тредом → сообщения 1a в этот канал нет', async () => {
		const w = setup([route(FORUM), route(TEXT)]);
		withComment(w);
		w.store.putThread('initech', ITEM, FORUM, THREAD, PROJECT);
		const deliveries = await w.notify(agentMention());
		await runAll(deliveries);
		expect(sent(w.discord).map(([channel]) => channel)).toEqual([TEXT]);
		expect(w.discord.callsOf('createForumPost')).toEqual([]);
		expect(w.plane.activities.map((a) => a.body)).toEqual([`→ Discord: ${TEXT}`]);
	});

	test('все каналы упоминания с тредом → только ответ в Agent Run', async () => {
		const w = setup([route(FORUM)]);
		withComment(w);
		w.store.putThread('initech', ITEM, FORUM, THREAD, PROJECT);
		const deliveries = await w.notify(agentMention());
		expect(deliveries.map((d) => d.label)).toEqual(['agent_run:r1→run:' + ID(300)]);
		await runAll(deliveries);
		expect(w.discord.calls).toEqual([]);
		expect(w.plane.activities.map((a) => a.body)).toEqual(['→ Discord: в тред задачи']);
	});

	test('тред другой задачи канал не закрывает', async () => {
		const w = setup([route(FORUM)]);
		withComment(w);
		w.store.putThread('initech', ID(101), FORUM, THREAD, PROJECT);
		await runAll(await w.notify(agentMention()));
		expect(w.discord.callsOf('createForumPost')).toHaveLength(1);
	});
});
