import { expect } from 'bun:test';
import { Gateway, INTENTS, type GatewayMessage } from '../src/discord/gateway.ts';
import type { LogEntry } from '../src/log.ts';

export const TOKEN = 'tok-SECRET-9f3a';

export type Frame = { op: number; d?: any; s?: number | null; t?: string | null };

/** Server side of one client connection: frames received, frames to send. */
export class Conn {
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

export function fakeGateway(opts: { heartbeatInterval?: number; ack?: boolean } = {}) {
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

export function setup(
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
export async function probe(c: Conn, n: number) {
	for (let i = 0; i < n; i++) {
		c.send({ op: 1 });
		await c.takeOp(1);
	}
}
/** Records every setTimeout delay until restore() is called. */
export function spyTimeouts() {
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
export const heartbeats = (c: Conn) => c.received.filter((f) => f.op === 1).length;

export const READY = (resume: string, s = 1): Frame => ({
	op: 0,
	s,
	t: 'READY',
	d: { session_id: 'sess-1', resume_gateway_url: resume },
});
export const messageCreate = (s: number, d: Record<string, unknown>): Frame => ({
	op: 0,
	s,
	t: 'MESSAGE_CREATE',
	d,
});
export const validMessage = {
	id: 'm1',
	channel_id: 'c1',
	guild_id: 'g1',
	type: 0,
	content: 'hello',
	author: { id: 'u1', username: 'user', global_name: 'Global', bot: false },
};

let running: { gateway: Gateway; server: ReturnType<typeof fakeGateway> } | null = null;
/** Tests that build the pair by hand register it for `cleanup`. */
export function track(gateway: Gateway, server: ReturnType<typeof fakeGateway>) {
	running = { gateway, server };
}

/** Registered by every test file with `afterEach(cleanup)`. */
export async function cleanup() {
	await running?.gateway.stop();
	await running?.server.stop();
	running = null;
}
export function run(
	opts: Parameters<typeof fakeGateway>[0] = {},
	over: Parameters<typeof setup>[1] = {},
) {
	const server = fakeGateway(opts);
	const world = setup(server, over);
	running = { gateway: world.gateway, server };
	world.gateway.start();
	return { server, ...world };
}
