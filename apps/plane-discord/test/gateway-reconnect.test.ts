import { afterEach, describe, expect, test } from 'bun:test';
import { Gateway } from '../src/discord/gateway.ts';
import type { LogEntry } from '../src/log.ts';
import {
	READY,
	TOKEN,
	cleanup,
	fakeGateway,
	run,
	setup,
	track,
	type Frame,
} from './gateway-harness.ts';

afterEach(cleanup);
describe('Gateway: переподключение, сбои сокета, адреса', () => {
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
		track(gateway, server);
		gateway.start();
		await logged('gateway.reconnect');
		expect(logs.map((l) => l.event).slice(0, 2)).toEqual([
			'gateway.socket_error',
			'gateway.reconnect',
		]);
		expect(logs[1]).toMatchObject({ code: 1006, reason: 'close', delay_ms: 1000 });
		expect(sleeps[0]).toBe(1000);
	});

	test('READY с wss resume_gateway_url → без bad_ready, op 7 подключается к нему с v=10', () => {
		const urls: string[] = [];
		const listeners: Record<string, (ev: unknown) => void>[] = [];
		class Recording {
			readyState = 1;
			constructor(url: string) {
				urls.push(url);
				listeners.push({});
			}
			addEventListener(type: string, fn: (ev: unknown) => void) {
				(listeners.at(-1) as Record<string, (ev: unknown) => void>)[type] = fn;
			}
			send() {}
			close() {}
		}
		const logs: LogEntry[] = [];
		const gateway = new Gateway({
			token: TOKEN,
			intents: 0,
			url: 'ws://127.0.0.1:1/',
			onMessage: () => {},
			log: (e) => logs.push(e),
			WebSocketImpl: Recording as unknown as typeof WebSocket,
		});
		gateway.start();
		const deliver = (frame: Frame) => listeners[0]?.message?.({ data: JSON.stringify(frame) });
		deliver({ op: 10, d: { heartbeat_interval: 60_000 } });
		deliver(READY('wss://gateway.example.com', 1));
		deliver({ op: 7 });
		expect(logs.some((l) => l.event === 'gateway.bad_ready')).toBe(false);
		expect(urls).toEqual(['ws://127.0.0.1:1/', 'wss://gateway.example.com/?v=10&encoding=json']);
		void gateway.stop();
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
});
