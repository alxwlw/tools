import { describe, expect, spyOn, test } from 'bun:test';
import {
	CHANNEL,
	DISCORD_ERR,
	DiscordApiError,
	DiscordRest,
	deliveryNonce,
} from '../src/discord/rest.ts';

type Reply = { status: number; body?: unknown };
type Call = { url: string; method: string; headers: Record<string, string>; body: any };

const API = 'https://discord.com/api/v10';
const TOKEN = 'itok.SECRET/part';

function stub(replies: Reply[]) {
	const calls: Call[] = [];
	const sleeps: number[] = [];
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({
			url,
			method: init.method ?? 'GET',
			headers: init.headers as Record<string, string>,
			body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
		});
		const reply = replies.shift();
		if (!reply) throw new Error(`unexpected request ${init.method} ${url}`);
		return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
			status: reply.status,
		});
	};
	const sleep = async (ms: number): Promise<void> => {
		sleeps.push(ms);
		if (sleeps.length > 10) throw new Error('runaway sleep');
	};
	const rest = new DiscordRest({ botToken: 'BOTSECRET', applicationId: 'app1', fetch, sleep });
	return { calls, sleeps, rest };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error('expected a rejection');
		},
		(err: unknown) => err,
	);
}

const NO_PINGS = { parse: [], replied_user: false };
const msg = { content: 'hi @everyone <@&1>' };

/** One stubbed call per message-sending method, each answering with whatever shape it needs. */
const senders: Array<[string, (rest: DiscordRest) => Promise<unknown>, Reply]> = [
	['sendMessage', (r) => r.sendMessage('c1', msg), { status: 200, body: { id: 'm1' } }],
	[
		'createForumPost',
		(r) => r.createForumPost('f1', 'name', msg),
		{ status: 200, body: { id: 't1', message: { id: 'm1' } } },
	],
	['editOriginal', (r) => r.editOriginal(TOKEN, msg), { status: 200, body: {} }],
	['followup', (r) => r.followup(TOKEN, msg), { status: 200, body: {} }],
];

describe('DiscordRest: сообщения', () => {
	for (const [name, send, reply] of senders) {
		test(`${name} — allowed_mentions {parse: [], replied_user: false}`, async () => {
			const { calls, rest } = stub([reply]);
			await send(rest);
			const body = calls[0]?.body;
			const message = name === 'createForumPost' ? body.message : body;
			expect(message.allowed_mentions).toEqual(NO_PINGS);
			expect(message.content).toBe('hi @everyone <@&1>');
		});
	}

	test('content из 2500 символов → 2000 code points; эмодзи на границе целый', async () => {
		const { calls, rest } = stub([{ status: 200, body: { id: 'm1' } }]);
		await rest.sendMessage('c1', { content: `${'a'.repeat(1998)}😀😀😀` });
		const content: string = calls[0]?.body.content;
		expect(Array.from(content)).toHaveLength(2000);
		expect(content).toBe(`${'a'.repeat(1998)}😀…`);
		const exact = stub([{ status: 200, body: { id: 'm1' } }]);
		await exact.rest.sendMessage('c1', { content: 'b'.repeat(2000) });
		expect(exact.calls[0]?.body.content).toBe('b'.repeat(2000));
	});

	test('имя поста из 150 символов → 100; content первого сообщения режется так же', async () => {
		const { calls, rest } = stub([{ status: 200, body: { id: 't1', message: { id: 'm1' } } }]);
		await rest.createForumPost('f1', '😀'.repeat(150), { content: 'x'.repeat(2500) });
		expect(Array.from(calls[0]?.body.name)).toHaveLength(100);
		expect(calls[0]?.body.name).toBe(`${'😀'.repeat(99)}…`);
		expect(Array.from(calls[0]?.body.message.content)).toHaveLength(2000);
	});

	test('embed: title 256, description 4096, field name 256, value 1024; короткое не меняется', async () => {
		const { calls, rest } = stub([{ status: 200, body: { id: 'm1' } }]);
		await rest.sendMessage('c1', {
			content: 'c',
			embeds: [
				{
					title: 't'.repeat(300),
					url: 'https://example.com/x',
					description: 'd'.repeat(5000),
					fields: [
						{ name: 'n'.repeat(300), value: 'v'.repeat(1100), inline: true },
						{ name: 'short', value: 'val' },
					],
				},
			],
		});
		const embed = calls[0]?.body.embeds[0];
		expect(embed.title).toBe(`${'t'.repeat(255)}…`);
		expect(embed.description).toBe(`${'d'.repeat(4095)}…`);
		expect(embed.url).toBe('https://example.com/x');
		expect(embed.fields[0]).toEqual({
			name: `${'n'.repeat(255)}…`,
			value: `${'v'.repeat(1023)}…`,
			inline: true,
		});
		expect(embed.fields[1]).toEqual({ name: 'short', value: 'val' });
	});

	test('без embeds, replyTo и ephemeral в теле нет message_reference, flags и embeds', async () => {
		const { calls, rest } = stub([{ status: 200, body: { id: 'm1' } }]);
		await rest.sendMessage('c1', { content: 'c' });
		expect(Object.keys(calls[0]?.body).sort()).toEqual(['allowed_mentions', 'content']);
	});

	test('sendMessage с nonce → nonce и enforce_nonce true в теле; без nonce их нет; createForumPost nonce не шлёт', async () => {
		const withNonce = stub([{ status: 200, body: { id: 'm1' } }]);
		await withNonce.rest.sendMessage('c1', { content: 'c', nonce: 'n-1' });
		expect(withNonce.calls[0]?.body.nonce).toBe('n-1');
		expect(withNonce.calls[0]?.body.enforce_nonce).toBe(true);
		const plain = stub([{ status: 200, body: { id: 'm1' } }]);
		await plain.rest.sendMessage('c1', { content: 'c' });
		expect(plain.calls[0]?.body).not.toHaveProperty('nonce');
		expect(plain.calls[0]?.body).not.toHaveProperty('enforce_nonce');
		const forum = stub([{ status: 200, body: { id: 't1', message: { id: 'm1' } } }]);
		await forum.rest.createForumPost('f1', 'name', { content: 'c', nonce: 'n-1' });
		expect(JSON.stringify(forum.calls[0]?.body)).not.toContain('nonce');
	});

	test('nonce длиннее 25 символов обрезается до лимита Discord', async () => {
		const { calls, rest } = stub([{ status: 200, body: { id: 'm1' } }]);
		await rest.sendMessage('c1', { content: 'c', nonce: 'x'.repeat(40) });
		expect(calls[0]?.body.nonce).toBe('x'.repeat(25));
	});

	test('deliveryNonce: ≤ 25 символов, стабилен для метки, различается между метками', () => {
		const a = deliveryNonce('issue.created:x→channel:1');
		expect(a).toBe(deliveryNonce('issue.created:x→channel:1'));
		expect(a).toHaveLength(25);
		expect(deliveryNonce('issue.created:x→channel:2')).not.toBe(a);
	});

	test('replyTo → message_reference с fail_if_not_exists false; ephemeral → flags 64', async () => {
		const { calls, rest } = stub([{ status: 200, body: { id: 'm1' } }]);
		await rest.sendMessage('c1', { content: 'c', replyTo: 'm0', ephemeral: true });
		expect(calls[0]?.body.message_reference).toEqual({
			message_id: 'm0',
			fail_if_not_exists: false,
		});
		expect(calls[0]?.body.flags).toBe(64);
		const plain = stub([{ status: 200, body: { id: 'm1' } }]);
		await plain.rest.sendMessage('c1', { content: 'c', ephemeral: false });
		expect(plain.calls[0]?.body.flags).toBeUndefined();
	});
});

describe('DiscordRest: тред на сообщении', () => {
	test('startThreadFromMessage: POST /channels/{c}/messages/{m}/threads, имя до 100, архив 7 дней, id треда', async () => {
		const { calls, rest } = stub([{ status: 201, body: { id: 't7' } }]);
		const id = await rest.startThreadFromMessage('c1', 'm1', '😀'.repeat(150));
		expect(id).toBe('t7');
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.url).toBe(`${API}/channels/c1/messages/m1/threads`);
		expect(calls[0]?.headers.Authorization).toBe('Bot BOTSECRET');
		expect(calls[0]?.body).toEqual({ name: `${'😀'.repeat(99)}…`, auto_archive_duration: 10080 });
	});

	test('startThreadFromMessage: ответ без id → ошибка; 403 → DiscordApiError со статусом и кодом', async () => {
		const empty = stub([{ status: 201, body: {} }]);
		expect(String(await failure(empty.rest.startThreadFromMessage('c1', 'm1', 'n')))).toContain(
			'no string field "id"',
		);
		const denied = stub([{ status: 403, body: { code: 50013, message: 'Missing Permissions' } }]);
		const err = await failure(denied.rest.startThreadFromMessage('c1', 'm1', 'n'));
		expect(err).toBeInstanceOf(DiscordApiError);
		expect([(err as DiscordApiError).status, (err as DiscordApiError).code]).toEqual([403, 50013]);
	});

	test('CHANNEL.ANNOUNCEMENT_THREAD = 10', () => {
		expect(CHANNEL.ANNOUNCEMENT_THREAD).toBe(10);
	});
});

describe('DiscordRest: ответы', () => {
	test('createForumPost: id поста и id первого сообщения', async () => {
		const { rest } = stub([{ status: 200, body: { id: 't1', message: { id: 'm9' } } }]);
		expect(await rest.createForumPost('f1', 'n', msg)).toEqual({ threadId: 't1', messageId: 'm9' });
	});

	test('createForumPost без message в ответе: первое сообщение поста имеет id поста', async () => {
		const { rest } = stub([{ status: 200, body: { id: 't1' } }]);
		expect(await rest.createForumPost('f1', 'n', msg)).toEqual({ threadId: 't1', messageId: 't1' });
	});

	test('getChannel и listGuildChannels разбирают поля канала', async () => {
		const row = {
			id: 'c1',
			type: CHANNEL.PUBLIC_THREAD,
			parent_id: 'f1',
			guild_id: 'g1',
			name: 'n',
		};
		const { rest } = stub([
			{ status: 200, body: row },
			{ status: 200, body: [row, { id: 'c2', type: CHANNEL.TEXT }] },
		]);
		const expected = { id: 'c1', type: 11, parentId: 'f1', guildId: 'g1', name: 'n' };
		expect(await rest.getChannel('c1')).toEqual(expected);
		expect(await rest.listGuildChannels('g1')).toEqual([
			expected,
			{ id: 'c2', type: 0, parentId: null, guildId: null, name: null },
		]);
	});

	test('openDm возвращает id канала; тело — recipient_id', async () => {
		const { calls, rest } = stub([{ status: 200, body: { id: 'dm1' } }]);
		expect(await rest.openDm('u1')).toBe('dm1');
		expect(calls[0]?.body).toEqual({ recipient_id: 'u1' });
		expect(calls[0]?.url).toBe(`${API}/users/@me/channels`);
	});

	test('joinThread: PUT /channels/{id}/thread-members/@me без тела', async () => {
		const { calls, rest } = stub([{ status: 204 }]);
		await rest.joinThread('t1');
		expect(calls[0]?.url).toBe(`${API}/channels/t1/thread-members/@me`);
		expect(calls[0]?.method).toBe('PUT');
		expect(calls[0]?.body).toBeUndefined();
	});

	test('ответ без id / не массив / без type — ошибка разбора', async () => {
		const empty = stub([{ status: 200, body: { id: '' } }]);
		expect(String(await failure(empty.rest.sendMessage('c', msg)))).toContain('"id"');
		expect(
			String(await failure(stub([{ status: 200, body: {} }]).rest.sendMessage('c', msg))),
		).toContain('"id"');
		expect(
			String(await failure(stub([{ status: 200, body: {} }]).rest.listGuildChannels('g'))),
		).toContain('array');
		expect(
			String(await failure(stub([{ status: 200, body: { id: 'c' } }]).rest.getChannel('c'))),
		).toContain('"type"');
	});

	test('bulkOverwriteGuildCommands: PUT списка команд на сервер приложения', async () => {
		const { calls, rest } = stub([{ status: 200, body: [] }]);
		await rest.bulkOverwriteGuildCommands('g1', [{ name: 'a' }]);
		expect(calls[0]).toMatchObject({
			method: 'PUT',
			url: `${API}/applications/app1/guilds/g1/commands`,
			body: [{ name: 'a' }],
		});
	});

	test('deleteOriginal: DELETE без тела на @original', async () => {
		const { calls, rest } = stub([{ status: 204 }]);
		await rest.deleteOriginal('tok');
		expect(calls[0]).toMatchObject({
			method: 'DELETE',
			url: `${API}/webhooks/app1/tok/messages/@original`,
			body: undefined,
		});
	});
});

describe('DiscordRest: маршруты и авторизация', () => {
	test('бот — Authorization: Bot …; interaction webhook — без Authorization', async () => {
		const { calls, rest } = stub([
			{ status: 200, body: { id: 'm1' } },
			{ status: 200, body: {} },
			{ status: 200, body: {} },
			{ status: 204 },
		]);
		await rest.sendMessage('c1', msg);
		await rest.editOriginal('tok', msg);
		await rest.followup('tok', msg);
		await rest.deleteOriginal('tok');
		expect(calls[0]?.headers.Authorization).toBe('Bot BOTSECRET');
		for (const call of calls.slice(1)) expect(call.headers.Authorization).toBeUndefined();
	});

	test('каждый id в пути экранируется (канал, форум, сервер, приложение, токен interaction)', async () => {
		const ID = 'a/b?c#d';
		const E = 'a%2Fb%3Fc%23d';
		const mk = (replies: Reply[]) => {
			const s = stub(replies);
			const rest = new DiscordRest({
				botToken: 'B',
				applicationId: ID,
				fetch: async (url, init) => {
					s.calls.push({ url, method: init.method ?? 'GET', headers: {}, body: undefined });
					return new Response(JSON.stringify(replies.shift() ?? {}), { status: 200 });
				},
			});
			return { calls: s.calls, rest };
		};
		const urls = async (run: (r: DiscordRest) => Promise<unknown>, body: unknown) => {
			const { calls, rest } = mk([{ status: 200, body } as Reply]);
			await run(rest).catch(() => {});
			return calls[0]?.url;
		};
		expect(await urls((r) => r.getChannel(ID), { id: 'x', type: 0 })).toBe(`${API}/channels/${E}`);
		expect(await urls((r) => r.listGuildChannels(ID), [])).toBe(`${API}/guilds/${E}/channels`);
		expect(await urls((r) => r.createForumPost(ID, 'n', msg), { id: 't' })).toBe(
			`${API}/channels/${E}/threads`,
		);
		expect(await urls((r) => r.startThreadFromMessage(ID, ID, 'n'), { id: 't' })).toBe(
			`${API}/channels/${E}/messages/${E}/threads`,
		);
		expect(await urls((r) => r.sendMessage(ID, msg), { id: 'm' })).toBe(
			`${API}/channels/${E}/messages`,
		);
		expect(await urls((r) => r.editOriginal(ID, msg), {})).toBe(
			`${API}/webhooks/${E}/${E}/messages/@original`,
		);
		expect(await urls((r) => r.deleteOriginal(ID), {})).toBe(
			`${API}/webhooks/${E}/${E}/messages/@original`,
		);
		expect(await urls((r) => r.followup(ID, msg), {})).toBe(`${API}/webhooks/${E}/${E}`);
		expect(await urls((r) => r.bulkOverwriteGuildCommands(ID, []), [])).toBe(
			`${API}/applications/${E}/guilds/${E}/commands`,
		);
	});
});

describe('DiscordRest: ошибки и 429', () => {
	test('429 с retry_after 0.5 → sleep(500) и успех', async () => {
		const { calls, sleeps, rest } = stub([
			{ status: 429, body: { retry_after: 0.5, global: false } },
			{ status: 200, body: { id: 'm1' } },
		]);
		expect(await rest.sendMessage('c1', msg)).toEqual({ id: 'm1' });
		expect(sleeps).toEqual([500]);
		expect(calls).toHaveLength(2);
	});

	test('429 без retry_after → sleep(1000)', async () => {
		const { sleeps, rest } = stub([
			{ status: 429, body: {} },
			{ status: 200, body: { id: 'm1' } },
		]);
		await rest.sendMessage('c1', msg);
		expect(sleeps).toEqual([1000]);
	});

	test('четыре 429 подряд → DiscordApiError 429, три sleep, четыре запроса', async () => {
		const { calls, sleeps, rest } = stub(
			Array.from({ length: 4 }, () => ({ status: 429, body: { retry_after: 1.2 } })),
		);
		const err = await failure(rest.sendMessage('c1', msg));
		expect(err).toBeInstanceOf(DiscordApiError);
		expect((err as DiscordApiError).status).toBe(429);
		expect(sleeps).toEqual([1200, 1200, 1200]);
		expect(calls).toHaveLength(4);
	});

	test('interaction-вызов: retry_after сверх бюджета не спится — сразу DiscordApiError 429', async () => {
		for (const call of [
			(r: DiscordRest) => r.editOriginal(TOKEN, msg),
			(r: DiscordRest) => r.followup(TOKEN, msg),
			(r: DiscordRest) => r.deleteOriginal(TOKEN),
		]) {
			const { calls, sleeps, rest } = stub([{ status: 429, body: { retry_after: 900 } }]);
			const err = await failure(call(rest));
			expect(err).toBeInstanceOf(DiscordApiError);
			expect((err as DiscordApiError).status).toBe(429);
			expect(sleeps).toEqual([]);
			expect(calls).toHaveLength(1);
		}
	});

	test('interaction-вызов: бюджет — сумма ожиданий; в пределах 60 с спим, сверх — бросаем', async () => {
		const { calls, sleeps, rest } = stub([
			{ status: 429, body: { retry_after: 30 } },
			{ status: 429, body: { retry_after: 30 } },
			{ status: 429, body: { retry_after: 0.001 } },
		]);
		const err = await failure(rest.editOriginal(TOKEN, msg));
		expect((err as DiscordApiError).status).toBe(429);
		// 30 s + 30 s is exactly the budget and is slept; one more millisecond is not.
		expect(sleeps).toEqual([30_000, 30_000]);
		expect(calls).toHaveLength(3);
	});

	test('interaction-вызов: отрицательный retry_after = ждать 0 и не пополняет бюджет', async () => {
		const { calls, sleeps, rest } = stub([
			{ status: 429, body: { retry_after: -100 } },
			{ status: 429, body: { retry_after: 61 } },
		]);
		const err = await failure(rest.editOriginal(TOKEN, msg));
		expect((err as DiscordApiError).status).toBe(429);
		// Unclamped, -100 s would credit the budget and the 61 s wait would be slept.
		expect(sleeps).toEqual([0]);
		expect(calls).toHaveLength(2);
	});

	test('бот-вызов: длинный retry_after по-прежнему спится (бюджет только у interaction)', async () => {
		const { sleeps, rest } = stub([
			{ status: 429, body: { retry_after: 900 } },
			{ status: 200, body: { id: 'm1' } },
		]);
		expect(await rest.sendMessage('c1', msg)).toEqual({ id: 'm1' });
		expect(sleeps).toEqual([900_000]);
	});

	test('403 с code 50007 → DiscordApiError status 403, code 50007, без тела в сообщении', async () => {
		const { rest } = stub([
			{
				status: 403,
				body: { code: DISCORD_ERR.CANNOT_DM, message: 'Cannot send messages to this user' },
			},
		]);
		const err = (await failure(rest.openDm('u1'))) as DiscordApiError;
		expect(err).toBeInstanceOf(DiscordApiError);
		expect([err.status, err.code, err.method, err.route]).toEqual([
			403,
			50007,
			'POST',
			'/users/@me/channels',
		]);
		expect(err.message).toBe('Discord POST /users/@me/channels → 403 (code 50007)');
	});

	test('ошибка без JSON-кода: code null; нечисловой code — тоже null', async () => {
		const plain = stub([{ status: 500 }]);
		expect(((await failure(plain.rest.getChannel('c'))) as DiscordApiError).code).toBeNull();
		const odd = stub([{ status: 400, body: { code: '50007' } }]);
		expect(((await failure(odd.rest.getChannel('c'))) as DiscordApiError).code).toBeNull();
	});

	test('токен interaction не попадает ни в message, ни в route ошибки', async () => {
		for (const call of [
			(r: DiscordRest) => r.editOriginal(TOKEN, msg),
			(r: DiscordRest) => r.deleteOriginal(TOKEN),
			(r: DiscordRest) => r.followup(TOKEN, msg),
		]) {
			const { rest } = stub([{ status: 404, body: { code: 10015, message: TOKEN } }]);
			const err = (await failure(call(rest))) as DiscordApiError;
			expect(err.message).not.toContain('SECRET');
			expect(err.route).not.toContain('SECRET');
			expect(err.route).toContain('/webhooks/app1/:token');
		}
	});

	test('сбой транспорта: ошибка с маршрутом, без URL с токеном и без токена бота', async () => {
		const rest = new DiscordRest({
			botToken: 'BOTSECRET',
			applicationId: 'app1',
			fetch: async (url) => {
				throw new Error(`connect failed ${url}`);
			},
		});
		const err = (await failure(rest.followup(TOKEN, msg))) as DiscordApiError;
		expect(err).toBeInstanceOf(DiscordApiError);
		expect(err.status).toBe(0);
		expect(err.message).not.toContain('SECRET');
		expect(err.message).toBe('Discord POST /webhooks/app1/:token → 0');
	});

	test('токен бота не попадает в ошибку', async () => {
		const { rest } = stub([{ status: 401, body: { message: '401: Unauthorized' } }]);
		const err = (await failure(rest.getChannel('c1'))) as DiscordApiError;
		expect(JSON.stringify([err.message, err.route])).not.toContain('BOTSECRET');
	});

	test('по умолчанию: глобальный fetch с (url, init), реальный sleep, signal таймаута', async () => {
		const seen: Array<{ url: unknown; init: RequestInit }> = [];
		const replies = [
			new Response(JSON.stringify({ retry_after: 0.001 }), { status: 429 }),
			new Response(JSON.stringify({ id: 'm1' }), { status: 200 }),
		];
		const spy = spyOn(globalThis, 'fetch').mockImplementation((async (
			url: unknown,
			init: RequestInit,
		) => {
			seen.push({ url, init });
			return replies.shift() as Response;
		}) as unknown as typeof fetch);
		try {
			const rest = new DiscordRest({ botToken: 'B', applicationId: 'app1' });
			expect(await rest.sendMessage('c1', msg)).toEqual({ id: 'm1' });
		} finally {
			spy.mockRestore();
		}
		expect(seen).toHaveLength(2);
		expect(seen[0]?.url).toBe(`${API}/channels/c1/messages`);
		expect(seen[0]?.init.method).toBe('POST');
		expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
		expect(seen[0]?.init.signal?.aborted).toBe(false);
	});
});

describe('DiscordRest: webhooks приложения', () => {
	const WH_TOKEN = 'whtok.SECRET/x';

	test('createWebhook: POST /channels/{id}/webhooks с именем, от имени бота; id и token из ответа', async () => {
		const { calls, rest } = stub([{ status: 200, body: { id: 'w1', token: 'wt1', extra: 1 } }]);
		expect(await rest.createWebhook('c1', 'Plane')).toEqual({ id: 'w1', token: 'wt1' });
		expect(calls[0]).toMatchObject({
			url: `${API}/channels/c1/webhooks`,
			method: 'POST',
			body: { name: 'Plane' },
		});
		expect(calls[0]!.headers.Authorization).toBe('Bot BOTSECRET');
	});

	test('createWebhook: ответ без token → ошибка, а не пустая строка', async () => {
		const { rest } = stub([{ status: 200, body: { id: 'w1' } }]);
		expect(String(await failure(rest.createWebhook('c1', 'Plane')))).toContain('"token"');
	});

	test('executeWebhook: ?wait=true&thread_id=, без заголовка бота, username и avatar_url, allowed_mentions', async () => {
		const { calls, rest } = stub([{ status: 200, body: { id: 'm1' } }]);
		const res = await rest.executeWebhook('w1', WH_TOKEN, 't1', {
			content: 'привет @everyone',
			username: 'Carol',
			avatarUrl: 'https://cdn.example.com/c.png',
		});
		expect(res).toEqual({ id: 'm1' });
		expect(calls[0]).toMatchObject({
			url: `${API}/webhooks/w1/${encodeURIComponent(WH_TOKEN)}?wait=true&thread_id=t1`,
			method: 'POST',
			body: {
				content: 'привет @everyone',
				username: 'Carol',
				avatar_url: 'https://cdn.example.com/c.png',
				allowed_mentions: NO_PINGS,
			},
		});
		expect(calls[0]!.headers.Authorization).toBeUndefined();
	});

	test('executeWebhook: без username и avatarUrl в теле их нет', async () => {
		const { calls, rest } = stub([{ status: 200, body: { id: 'm1' } }]);
		await rest.executeWebhook('w1', WH_TOKEN, 't1', { content: 'x' });
		expect(Object.keys(calls[0]!.body).sort()).toEqual(['allowed_mentions', 'content']);
	});

	test('executeWebhook: токен webhook маскируется в route ошибки (HTTP-ошибка и сбой транспорта)', async () => {
		const { rest } = stub([{ status: 404, body: { code: DISCORD_ERR.UNKNOWN_WEBHOOK } }]);
		const err = (await failure(rest.executeWebhook('w1', WH_TOKEN, 't1', msg))) as DiscordApiError;
		expect(err).toBeInstanceOf(DiscordApiError);
		expect([err.status, err.code]).toEqual([404, 10015]);
		expect(err.route).toBe('/webhooks/w1/:token?wait=true&thread_id=t1');
		expect(err.message).not.toContain('SECRET');

		const broken = new DiscordRest({
			botToken: 'BOTSECRET',
			applicationId: 'app1',
			fetch: async (url) => {
				throw new Error(`boom ${String(url)}`);
			},
		});
		const down = (await failure(
			broken.executeWebhook('w1', WH_TOKEN, 't1', msg),
		)) as DiscordApiError;
		expect([down.status, down.route]).toEqual([0, '/webhooks/w1/:token?wait=true&thread_id=t1']);
		expect(`${down.message}${down.stack}`).not.toContain('SECRET');
	});
});

describe('DiscordRest: recentMessages', () => {
	test('GET /channels/{id}/messages?limit=: id, webhookId и content', async () => {
		const { calls, rest } = stub([
			{
				status: 200,
				body: [
					{ id: 'm2', webhook_id: 'w1', content: 'привет', extra: 1 },
					{ id: 'm1', content: 'без webhook' },
					{ id: 'm0' },
				],
			},
		]);
		expect(await rest.recentMessages('t1', 10)).toEqual([
			{ id: 'm2', webhookId: 'w1', content: 'привет' },
			{ id: 'm1', webhookId: null, content: 'без webhook' },
			{ id: 'm0', webhookId: null, content: '' },
		]);
		expect(calls[0]).toMatchObject({ url: `${API}/channels/t1/messages?limit=10`, method: 'GET' });
	});

	test('recentMessages: не массив → ошибка', async () => {
		const { rest } = stub([{ status: 200, body: {} }]);
		expect(String(await failure(rest.recentMessages('t1', 10)))).toContain('not an array');
	});
});
