import { afterEach, describe, expect, test } from 'bun:test';
import { Gateway, INTENTS, type GatewayMessage } from '../src/discord/gateway.ts';
import type { LogEntry } from '../src/log.ts';

const TOKEN = 'tok-SECRET-9f3a';

type Frame = { op: number; d?: any; s?: number | null; t?: string | null };

/** Server side of one client connection: frames received, frames to send. */
class Conn {
	readonly frames: Frame[] = [];
	/** Every frame ever received, consumed or not. */
	readonly received: Frame[] = [];
	closeCode: number | null = null;
	/** Resolves with the close code once the client side closed the socket. */
	readonly closed: Promise<number>;
	resolveClosed: (code: number) => void = () => {};
	private waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
	constructor(
		readonly path: string,
		private readonly ws: Bun.ServerWebSocket<string>,
	) {
		this.closed = new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
	}
	push(frame: Frame) {
		this.received.push(frame);
		const i = this.waiters.findIndex((w) => w.match(frame));
		if (i >= 0) this.waiters.splice(i, 1)[0]?.resolve(frame);
		else this.frames.push(frame);
	}
	/** Resolves with the first unconsumed received frame that matches. */
	take(match: (f: Frame) => boolean): Promise<Frame> {
		const i = this.frames.findIndex(match);
		if (i >= 0) return Promise.resolve(this.frames.splice(i, 1)[0] as Frame);
		return new Promise((resolve) => this.waiters.push({ match, resolve }));
	}
	takeOp(op: number) {
		return this.take((f) => f.op === op);
	}
	send(frame: Frame) {
		this.ws.send(JSON.stringify(frame));
	}
	sendRaw(text: string) {
		this.ws.send(text);
	}
	close(code: number) {
		this.ws.close(code);
	}
}

function fakeGateway(opts: { heartbeatInterval?: number; ack?: boolean } = {}) {
	const conns: Conn[] = [];
	const waiters: ((c: Conn) => void)[] = [];
	const byWs = new Map<Bun.ServerWebSocket<string>, Conn>();
	const server = Bun.serve<string>({
		port: 0,
		fetch(req, srv) {
			const u = new URL(req.url);
			return srv.upgrade(req, { data: u.pathname + u.search })
				? undefined
				: new Response('no', { status: 400 });
		},
		websocket: {
			open(ws) {
				const c = new Conn(ws.data, ws);
				byWs.set(ws, c);
				conns.push(c);
				c.send({ op: 10, d: { heartbeat_interval: opts.heartbeatInterval ?? 60_000 } });
				waiters.shift()?.(c);
			},
			message(ws, raw) {
				const c = byWs.get(ws) as Conn;
				const frame = JSON.parse(String(raw)) as Frame;
				if (frame.op === 1 && opts.ack !== false) c.send({ op: 11 });
				c.push(frame);
			},
			close(ws, code) {
				const c = byWs.get(ws);
				if (c) {
					c.closeCode = code;
					c.resolveClosed(code);
				}
			},
		},
	});
	return {
		url: `ws://127.0.0.1:${server.port}/?v=10&encoding=json`,
		resumeBase: `ws://127.0.0.1:${server.port}/resume`,
		conns,
		/** The n-th connection (0-based), awaited if it has not arrived yet. */
		conn(n: number): Promise<Conn> {
			const have = conns[n];
			if (have) return Promise.resolve(have);
			return new Promise((resolve) =>
				waiters.push(function wait(c) {
					if (conns.indexOf(c) === n) resolve(c);
					else waiters.push(wait);
				}),
			);
		},
		stop: () => server.stop(true),
	};
}

function setup(
	server: ReturnType<typeof fakeGateway>,
	over: {
		random?: () => number;
		sleep?: (ms: number) => Promise<void>;
		url?: string;
		/** 1-based construction numbers whose `new WebSocket` throws. */
		failConstruct?: number[];
	} = {},
) {
	const logs: LogEntry[] = [];
	const messages: GatewayMessage[] = [];
	const sleeps: number[] = [];
	const logWaiters: { event: string; resolve: () => void }[] = [];
	let constructed = 0;
	class CountingWebSocket extends WebSocket {
		constructor(url: string | URL) {
			constructed++;
			if (over.failConstruct?.includes(constructed)) throw new Error('construct failed');
			super(url);
		}
	}
	const gateway = new Gateway({
		token: TOKEN,
		intents: INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT,
		url: over.url ?? server.url,
		onMessage: (m) => messages.push(m),
		log: (e) => {
			logs.push(e);
			for (const w of logWaiters.filter((x) => x.event === e.event)) w.resolve();
		},
		random: over.random ?? (() => 0),
		sleep:
			over.sleep ??
			(async (ms) => {
				sleeps.push(ms);
				// A mutant that reconnects in a loop must fail the test, not hang the file.
				if (sleeps.length > 20) throw new Error('sleep storm');
			}),
		WebSocketImpl: CountingWebSocket as typeof WebSocket,
	});
	return {
		gateway,
		logs,
		messages,
		sleeps,
		constructed: () => constructed,
		logged: (event: string) =>
			logs.some((l) => l.event === event)
				? Promise.resolve()
				: new Promise<void>((resolve) => logWaiters.push({ event, resolve })),
	};
}

/** n round trips: the server asks for a heartbeat and waits for the reply. */
async function probe(c: Conn, n: number) {
	for (let i = 0; i < n; i++) {
		c.send({ op: 1 });
		await c.takeOp(1);
	}
}
/** Records every setTimeout delay until restore() is called. */
function spyTimeouts() {
	const delays: number[] = [];
	const real = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
		delays.push(ms ?? 0);
		return real(fn, ms, ...args);
	}) as typeof setTimeout;
	return {
		delays,
		restore: () => {
			globalThis.setTimeout = real;
		},
	};
}
const heartbeats = (c: Conn) => c.received.filter((f) => f.op === 1).length;

const READY = (resume: string, s = 1): Frame => ({
	op: 0,
	s,
	t: 'READY',
	d: { session_id: 'sess-1', resume_gateway_url: resume },
});
const messageCreate = (s: number, d: Record<string, unknown>): Frame => ({
	op: 0,
	s,
	t: 'MESSAGE_CREATE',
	d,
});
const validMessage = {
	id: 'm1',
	channel_id: 'c1',
	guild_id: 'g1',
	type: 0,
	content: 'hello',
	author: { id: 'u1', username: 'user', global_name: 'Global', bot: false },
};

let running: { gateway: Gateway; server: ReturnType<typeof fakeGateway> } | null = null;
afterEach(async () => {
	await running?.gateway.stop();
	await running?.server.stop();
	running = null;
});
function run(opts: Parameters<typeof fakeGateway>[0] = {}, over: Parameters<typeof setup>[1] = {}) {
	const server = fakeGateway(opts);
	const world = setup(server, over);
	running = { gateway: world.gateway, server };
	world.gateway.start();
	return { server, ...world };
}

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
		running = { gateway, server };
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

	test('READY с битым resume_gateway_url → gateway.bad_ready, op 7 даёт новый IDENTIFY', async () => {
		const { server, logs } = run();
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.send(READY('not a url', 1));
		c0.send({ op: 7 });
		const c1 = await server.conn(1);
		expect((await c1.takeOp(2)).d.token).toBe(TOKEN);
		expect(c1.path).toBe('/?v=10&encoding=json');
		expect(logs.filter((l) => l.event === 'gateway.bad_ready')).toEqual([
			{ event: 'gateway.bad_ready', level: 'warn' },
		]);
	});

	test('READY с resume_gateway_url не ws(s) → bad_ready, следующее подключение на базовый url', async () => {
		const { server, logs } = run();
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.send(READY('https://gateway.example.com/', 1));
		c0.send({ op: 7 });
		const c1 = await server.conn(1);
		expect((await c1.takeOp(2)).d.token).toBe(TOKEN);
		expect(c1.path).toBe('/?v=10&encoding=json');
		expect(logs.filter((l) => l.event === 'gateway.bad_ready')).toHaveLength(1);
	});

	test('op 7 при сбое создания сокета → connect_failed и повтор после паузы', async () => {
		const { server, logs, sleeps } = run({}, { failConstruct: [2] });
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.send(READY(server.resumeBase, 3));
		c0.send({ op: 7 });
		const c1 = await server.conn(1);
		expect((await c1.takeOp(6)).d).toEqual({ token: TOKEN, session_id: 'sess-1', seq: 3 });
		expect(logs.filter((l) => l.event === 'gateway.connect_failed')).toEqual([
			{ event: 'gateway.connect_failed', level: 'warn' },
		]);
		expect(sleeps).toEqual([1000]);
	});

	test('нет ACK при сбое создания сокета → connect_failed и повтор после паузы', async () => {
		const { server, logs, sleeps } = run(
			{ heartbeatInterval: 30, ack: false },
			{ failConstruct: [2] },
		);
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.send(READY(server.resumeBase, 3));
		const c1 = await server.conn(1);
		expect((await c1.takeOp(6)).d).toEqual({ token: TOKEN, session_id: 'sess-1', seq: 3 });
		expect(logs.some((l) => l.event === 'gateway.connect_failed')).toBe(true);
		expect(sleeps[0]).toBe(1000);
	});

	test('op 9 true при сбое создания сокета → connect_failed и RESUME на следующем', async () => {
		const { server, logs, sleeps } = run({}, { failConstruct: [2] });
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.send(READY(server.resumeBase, 3));
		c0.send({ op: 9, d: true });
		const c1 = await server.conn(1);
		expect((await c1.takeOp(6)).d).toEqual({ token: TOKEN, session_id: 'sess-1', seq: 3 });
		expect(logs.filter((l) => l.event === 'gateway.connect_failed')).toHaveLength(1);
		expect(sleeps).toEqual([1000]);
	});

	test('start() при сбое создания сокета не бросает: connect_failed и повтор', async () => {
		const { server, logs, sleeps, constructed } = run({}, { failConstruct: [1] });
		const c0 = await server.conn(0);
		expect((await c0.takeOp(2)).d.token).toBe(TOKEN);
		expect(constructed()).toBe(2);
		expect(logs.filter((l) => l.event === 'gateway.connect_failed')).toHaveLength(1);
		expect(sleeps).toEqual([1000]);
	});

	test('stop(); start() во время backoff: после паузы второго подключения нет', async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { server, gateway, constructed, logged } = run({}, { sleep: () => gate });
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.close(4000);
		await logged('gateway.reconnect');
		await gateway.stop();
		gateway.start();
		await server.conn(1);
		release();
		await gate;
		await Promise.resolve();
		await Promise.resolve();
		expect(constructed()).toBe(2);
	});

	test('сбой создания сокета после close → connect_failed, backoff 1 с, 2 с, третье подключение', async () => {
		const { server, logs, sleeps, constructed } = run({}, { failConstruct: [2] });
		const c0 = await server.conn(0);
		await c0.takeOp(2);
		c0.close(4000);
		const c2 = await server.conn(1);
		await c2.takeOp(2);
		expect(constructed()).toBe(3);
		expect(logs.filter((l) => l.event === 'gateway.connect_failed')).toEqual([
			{ event: 'gateway.connect_failed', level: 'warn' },
		]);
		expect(sleeps).toEqual([1000, 2000]);
	});

	test('отказ в соединении → socket_error, затем reconnect с кодом 1006 и backoff 1 с', async () => {
		const server = fakeGateway();
		const { gateway, logs, sleeps, logged } = setup(server, { url: 'ws://127.0.0.1:1/' });
		running = { gateway, server };
		gateway.start();
		await logged('gateway.reconnect');
		expect(logs.map((l) => l.event).slice(0, 2)).toEqual([
			'gateway.socket_error',
			'gateway.reconnect',
		]);
		expect(logs[1]).toMatchObject({ code: 1006, reason: 'close', delay_ms: 1000 });
		expect(sleeps[0]).toBe(1000);
	});

	test('адрес по умолчанию — wss://gateway.discord.gg/?v=10&encoding=json', () => {
		const urls: string[] = [];
		class Recording {
			constructor(url: string) {
				urls.push(url);
			}
			addEventListener() {}
			close() {}
		}
		const gateway = new Gateway({
			token: TOKEN,
			intents: 0,
			onMessage: () => {},
			log: () => {},
			WebSocketImpl: Recording as unknown as typeof WebSocket,
		});
		gateway.start();
		expect(urls).toEqual(['wss://gateway.discord.gg/?v=10&encoding=json']);
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
