import { afterEach, describe, expect, test } from 'bun:test';
import { Gateway, INTENTS } from '../src/discord/gateway.ts';
import type { LogEntry } from '../src/log.ts';
import {
	READY,
	TOKEN,
	cleanup,
	fakeGateway,
	heartbeats,
	messageCreate,
	probe,
	run,
	spyTimeouts,
	track,
	validMessage,
} from './gateway-harness.ts';

afterEach(cleanup);
describe('Gateway', () => {
	test('HELLO → IDENTIFY с intents и токеном; heartbeat по интервалу', async () => {
		const { server } = run({ heartbeatInterval: 20 });
		const c = await server.conn(0);
		const identify = await c.takeOp(2);
		expect(identify.d.token).toBe(TOKEN);
		expect(identify.d.intents).toBe(1 | 512 | 32768);
		expect(identify.d.properties).toEqual({
			os: 'linux',
			browser: 'plane-discord',
			device: 'plane-discord',
		});
		const first = await c.takeOp(1);
		const second = await c.takeOp(1);
		expect(first.d).toBeNull();
		expect(second.d).toBeNull();
	});

	test('heartbeat перевзводится на interval', async () => {
		const spy = spyTimeouts();
		try {
			const { server } = run({ heartbeatInterval: 60_000 }, { random: () => 0 });
			const c = await server.conn(0);
			await c.takeOp(2);
			await c.takeOp(1);
			// The server ACKed the first heartbeat; the next tick is armed for the full interval.
			await probe(c, 1);
			expect(spy.delays.filter((d) => d === 60_000)).toEqual([60_000]);
			expect(heartbeats(c)).toBe(2);
		} finally {
			spy.restore();
		}
	});

	test('INTENTS — значения из Discord API', () => {
		expect(INTENTS).toEqual({ GUILDS: 1, GUILD_MESSAGES: 512, MESSAGE_CONTENT: 32768 });
	});

	test('первый heartbeat — через interval × random()', async () => {
		const spy = spyTimeouts();
		try {
			let draws = 0;
			const { server } = run(
				{ heartbeatInterval: 60_000 },
				{
					random: () => {
						draws++;
						return 0.5;
					},
				},
			);
			const c = await server.conn(0);
			await c.takeOp(2);
			expect(draws).toBe(1);
			// The first tick is armed for half of the interval, and no other timer uses that delay.
			expect(spy.delays.filter((d) => d === 30_000)).toEqual([30_000]);
			expect(heartbeats(c)).toBe(0);
		} finally {
			spy.restore();
		}
	});

	test('MESSAGE_CREATE → onMessage с полями; seq запоминается', async () => {
		const { server, messages } = run({ heartbeatInterval: 20 });
		const c = await server.conn(0);
		await c.takeOp(2);
		c.send(READY(server.resumeBase, 1));
		c.send(
			messageCreate(7, {
				...validMessage,
				type: 19,
				author: { ...validMessage.author, bot: true },
				member: { nick: 'Nick' },
				webhook_id: 'wh1',
				application_id: 'app1',
				attachments: [{ url: 'https://cdn.example.com/a.png', filename: 'a.png', size: 1 }],
				mentions: [{ id: 'u2', username: 'other', global_name: 'Other Global' }],
			}),
		);
		const hb = await c.take((f) => f.op === 1 && f.d === 7);
		expect(hb.d).toBe(7);
		expect(messages).toEqual([
			{
				id: 'm1',
				channelId: 'c1',
				guildId: 'g1',
				type: 19,
				content: 'hello',
				author: { id: 'u1', name: 'Nick', bot: true },
				webhookId: 'wh1',
				applicationId: 'app1',
				attachments: [{ url: 'https://cdn.example.com/a.png', filename: 'a.png' }],
				mentions: [{ id: 'u2', name: 'Other Global' }],
			},
		]);
	});

	test('имя автора: nick, затем global_name, затем username', async () => {
		const { server, messages } = run({ heartbeatInterval: 20 });
		const c = await server.conn(0);
		await c.takeOp(2);
		const author = { id: 'u1', username: 'user', global_name: 'Global' };
		c.send(messageCreate(1, { ...validMessage, id: 'a', author, member: { nick: 'Nick' } }));
		c.send(messageCreate(2, { ...validMessage, id: 'b', author }));
		c.send(messageCreate(3, { ...validMessage, id: 'c', author: { id: 'u1', username: 'user' } }));
		await c.take((f) => f.op === 1 && f.d === 3);
		expect(messages.map((m) => [m.id, m.author.name])).toEqual([
			['a', 'Nick'],
			['b', 'Global'],
			['c', 'user'],
		]);
		expect(messages.every((m) => m.webhookId === null && m.applicationId === null)).toBe(true);
	});

	test('сообщение без id, channel_id или author.id пропускается с gateway.bad_message', async () => {
		const { server, messages, logs } = run({ heartbeatInterval: 20 });
		const c = await server.conn(0);
		await c.takeOp(2);
		const { id: _id, ...noId } = validMessage;
		const { channel_id: _ch, ...noChannel } = validMessage;
		c.send(messageCreate(1, noId));
		c.send(messageCreate(2, noChannel));
		c.send(messageCreate(3, { ...validMessage, author: { username: 'x' } }));
		c.send(messageCreate(4, { ...validMessage, id: 'ok' }));
		await c.take((f) => f.op === 1 && f.d === 4);
		expect(messages.map((m) => m.id)).toEqual(['ok']);
		const bad = logs.filter((l) => l.event === 'gateway.bad_message');
		expect(bad.map((l) => [l.level, l.missing])).toEqual([
			['warn', 'id'],
			['warn', 'channel_id'],
			['warn', 'author.id'],
		]);
		expect(server.conns).toHaveLength(1);
	});

	test('мусорный кадр логируется как gateway.bad_frame и не рвёт соединение', async () => {
		const { server, logs, messages } = run({ heartbeatInterval: 20 });
		const c = await server.conn(0);
		await c.takeOp(2);
		c.sendRaw('not json');
		c.sendRaw('{"op":"x"}');
		c.send(messageCreate(1, validMessage));
		await c.take((f) => f.op === 1 && f.d === 1);
		expect(logs.filter((l) => l.event === 'gateway.bad_frame')).toEqual([
			{ event: 'gateway.bad_frame', level: 'warn' },
			{ event: 'gateway.bad_frame', level: 'warn' },
		]);
		expect(messages.map((m) => m.id)).toEqual(['m1']);
		expect(server.conns).toHaveLength(1);
	});

	test('исключение из onMessage не рвёт соединение', async () => {
		const server = fakeGateway({ heartbeatInterval: 20 });
		const logs: LogEntry[] = [];
		const seen: string[] = [];
		const gateway = new Gateway({
			token: TOKEN,
			intents: 0,
			url: server.url,
			log: (e) => logs.push(e),
			random: () => 0,
			onMessage: (m) => {
				seen.push(m.id);
				if (m.id === 'boom') throw new Error('handler down');
			},
		});
		track(gateway, server);
		gateway.start();
		const c = await server.conn(0);
		await c.takeOp(2);
		c.send(messageCreate(1, { ...validMessage, id: 'boom' }));
		c.send(messageCreate(2, { ...validMessage, id: 'after' }));
		await c.take((f) => f.op === 1 && f.d === 2);
		expect(seen).toEqual(['boom', 'after']);
		expect(logs.find((l) => l.event === 'gateway.handler_failed')).toEqual({
			event: 'gateway.handler_failed',
			level: 'error',
			message_id: 'boom',
		});
	});

	test('op 7 → подключение к resume_gateway_url и RESUME с session_id и seq', async () => {
		const { server, sleeps, constructed } = run();
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.send(READY(server.resumeBase, 1));
		c0.send(messageCreate(4, validMessage));
		c0.send({ op: 7 });
		const c1 = await server.conn(1);
		// The late close of the dropped socket must not start a third connection.
		await c0.closed;
		await Promise.resolve();
		expect(constructed()).toBe(2);
		expect(c1.path).toBe('/resume?v=10&encoding=json');
		const resume = await c1.takeOp(6);
		expect(resume.d).toEqual({ token: TOKEN, session_id: 'sess-1', seq: 4 });
		expect(c1.frames.filter((f) => f.op === 2)).toEqual([]);
		expect(sleeps).toEqual([]);
	});

	test('нет ACK до следующего heartbeat → переподключение с RESUME', async () => {
		const { server, logs } = run({ heartbeatInterval: 30, ack: false });
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.send(READY(server.resumeBase, 3));
		await c0.takeOp(1);
		const c1 = await server.conn(1);
		const resume = await c1.takeOp(6);
		expect(resume.d).toEqual({ token: TOKEN, session_id: 'sess-1', seq: 3 });
		expect(logs.find((l) => l.event === 'gateway.reconnect')).toEqual({
			event: 'gateway.reconnect',
			reason: 'no_ack',
		});
	});

	test('повторный start() не открывает второе соединение', async () => {
		const { server, gateway, constructed } = run();
		await server.conn(0);
		gateway.start();
		expect(constructed()).toBe(1);
	});

	test('op 1 от сервера → heartbeat сразу', async () => {
		const { server } = run({ heartbeatInterval: 60_000 }, { random: () => 0.99 });
		const c = await server.conn(0);
		await c.takeOp(2);
		c.send({ op: 1 });
		const hb = await c.takeOp(1);
		expect(hb.d).toBeNull();
	});

	test('op 9 true → RESUME без паузы', async () => {
		const { server, sleeps } = run();
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.send(READY(server.resumeBase, 2));
		c0.send({ op: 9, d: true });
		const c1 = await server.conn(1);
		expect((await c1.takeOp(6)).d).toEqual({ token: TOKEN, session_id: 'sess-1', seq: 2 });
		expect(sleeps).toEqual([]);
	});

	test('op 9 false → новый IDENTIFY после паузы 1–5 с', async () => {
		const { server, sleeps } = run({}, { random: () => 0.5 });
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.send(READY(server.resumeBase, 2));
		c0.send({ op: 9, d: false });
		const c1 = await server.conn(1);
		const identify = await c1.takeOp(2);
		expect(identify.d.token).toBe(TOKEN);
		expect(c1.frames.filter((f) => f.op === 6)).toEqual([]);
		expect(c1.path).toBe('/?v=10&encoding=json');
		expect(sleeps).toEqual([3000]);
	});

	test('close 4014 → gateway.fatal, переподключений нет', async () => {
		const { server, logs, logged, constructed, sleeps } = run();
		const c = await server.conn(0);
		await c.takeOp(2);
		c.close(4014);
		await logged('gateway.fatal');
		expect(logs.filter((l) => l.event === 'gateway.fatal')).toEqual([
			{
				event: 'gateway.fatal',
				level: 'error',
				code: 4014,
				error: 'MESSAGE_CONTENT не включён в Developer Portal',
			},
		]);
		expect(constructed()).toBe(1);
		expect(sleeps).toEqual([]);
	});

	test.each([4004, 4010, 4011, 4012, 4013])('close %d фатален', async (code) => {
		const { server, logs, logged, constructed } = run();
		const c = await server.conn(0);
		await c.takeOp(2);
		c.close(code);
		await logged('gateway.fatal');
		expect(logs.find((l) => l.event === 'gateway.fatal')?.code).toBe(code);
		expect(constructed()).toBe(1);
	});

	test('обычный close → backoff и RESUME', async () => {
		const { server, sleeps } = run();
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.send(READY(server.resumeBase, 5));
		c0.send(messageCreate(6, validMessage));
		c0.close(4000);
		const c1 = await server.conn(1);
		expect((await c1.takeOp(6)).d).toEqual({ token: TOKEN, session_id: 'sess-1', seq: 6 });
		expect(c1.path).toBe('/resume?v=10&encoding=json');
		expect(sleeps).toEqual([1000]);
	});

	test.each([4007, 4009])('close %d → backoff и новый IDENTIFY', async (code) => {
		const { server, sleeps, logs } = run();
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.send(READY(server.resumeBase, 5));
		c0.send(messageCreate(6, validMessage));
		c0.close(code);
		const c1 = await server.conn(1);
		const identify = await c1.takeOp(2);
		expect(identify.d.token).toBe(TOKEN);
		expect(c1.received.filter((f) => f.op === 6)).toEqual([]);
		expect(c1.path).toBe('/?v=10&encoding=json');
		// The new session has no sequence number yet.
		expect((await c1.takeOp(1)).d).toBeNull();
		expect(sleeps).toEqual([1000]);
		expect(logs.some((l) => l.event === 'gateway.fatal')).toBe(false);
	});

	test('backoff удваивается до 60 с и сбрасывается после READY', async () => {
		const { server, sleeps } = run();
		let c = await server.conn(0);
		for (let n = 1; n <= 8; n++) {
			c.close(3000 + n);
			c = await server.conn(n);
		}
		expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
		c.send(READY(server.resumeBase, 1));
		c.close(4000);
		await server.conn(9);
		expect(sleeps.at(-1)).toBe(1000);
	});

	test('backoff сбрасывается после RESUMED', async () => {
		const { server, sleeps } = run();
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.send(READY(server.resumeBase, 1));
		c0.close(4000);
		const c1 = await server.conn(1);
		c1.close(4000);
		const c2 = await server.conn(2);
		await c2.takeOp(6);
		c2.send({ op: 0, s: 2, t: 'RESUMED', d: {} });
		c2.close(4000);
		await server.conn(3);
		expect(sleeps).toEqual([1000, 2000, 1000]);
	});

	test('stop() закрывает соединение кодом 1000 и не переподключается', async () => {
		const { server, gateway, constructed, sleeps } = run();
		const c = await server.conn(0);
		await c.takeOp(2);
		await gateway.stop();
		// The server sees the close frame, then a late close must not revive the client.
		await c.closed;
		expect(c.closeCode).toBe(1000);
		expect(constructed()).toBe(1);
		expect(sleeps).toEqual([]);
	});

	test('stop() во время backoff: подключения после паузы нет', async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { server, gateway, constructed, logged } = run({}, { sleep: () => gate });
		const c = await server.conn(0);
		await c.takeOp(2);
		c.close(4000);
		await logged('gateway.reconnect');
		await gateway.stop();
		release();
		await gate;
		await Promise.resolve();
		await Promise.resolve();
		expect(constructed()).toBe(1);
	});

	test('stop() гасит таймер heartbeat', async () => {
		const { server, gateway, constructed, logs } = run({ heartbeatInterval: 30, ack: false });
		const c = await server.conn(0);
		await c.takeOp(2);
		await c.takeOp(1);
		await gateway.stop();
		await c.closed;
		// Negative check: a live tick would find no ACK and reconnect within one interval; wait three.
		await Bun.sleep(100);
		expect(constructed()).toBe(1);
		expect(logs.some((l) => l.event === 'gateway.reconnect')).toBe(false);
	});

	test('сбой sleep → gateway.sleep_failed и никаких новых подключений', async () => {
		const { server, logs, constructed, logged } = run(
			{},
			{
				sleep: () => Promise.reject(new Error('sleep broken')),
			},
		);
		const c = await server.conn(0);
		await c.takeOp(2);
		c.close(4000);
		await logged('gateway.sleep_failed');
		expect(logs.find((l) => l.event === 'gateway.sleep_failed')).toEqual({
			event: 'gateway.sleep_failed',
			level: 'error',
		});
		expect(constructed()).toBe(1);
	});

	test('после stop() start() подключается заново', async () => {
		const { server, gateway } = run();
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		await gateway.stop();
		gateway.start();
		const c1 = await server.conn(1);
		expect((await c1.takeOp(2)).d.token).toBe(TOKEN);
	});

	test('токен не попадает в лог', async () => {
		const { server, logs, logged } = run();
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.send(READY(server.resumeBase, 1));
		c0.send(messageCreate(2, { ...validMessage, content: 'secret text', id: undefined }));
		c0.send({ op: 7 });
		const c1 = await server.conn(1);
		await c1.takeOp(6);
		c1.close(4000);
		const c2 = await server.conn(2);
		await c2.takeOp(6);
		c2.close(4014);
		await logged('gateway.fatal');
		expect(logs.length).toBeGreaterThanOrEqual(5);
		const dump = JSON.stringify(logs);
		expect(dump).not.toContain(TOKEN);
		expect(dump).not.toContain('secret text');
	});
});
