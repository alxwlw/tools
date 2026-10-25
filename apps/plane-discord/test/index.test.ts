import { afterEach, describe, expect, jest, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';

import {
	installProcessHandlers,
	intervalEvery,
	logUnhandled,
	type Service,
	startService,
} from '../src/index.ts';
import { CREATE_COMMAND } from '../src/discord/commands.ts';
import { commandPayload, submitPayload } from './discord-harness.ts';
import { Store } from '../src/store.ts';
import { fixture } from './fixtures.ts';
import {
	ASSIGNEE,
	CHANNEL,
	delivery,
	DM_USER,
	ENV,
	GUILD,
	humanState,
	json,
	messages,
	post,
	running,
	SECRET,
	SERVICE,
	sign,
	signed,
	signer,
	start,
	world,
} from './index-world.ts';

afterEach(async () => {
	for (const service of running.splice(0)) await service.stop();
});

describe('startService', () => {
	test('/healthz → ok, строка listening с картой тенантов без секретов', async () => {
		const { w, url } = start();
		const res = await fetch(url('/healthz'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
		const listening = w.entries().find((e) => e.event === 'listening');
		expect(listening).toMatchObject({
			tenants: [{ id: 'acme', channels: 1, users: 1 }],
		});
		expect(typeof listening?.port).toBe('number');
		for (const secret of ['client-secret-value', 'bot-token-value', SECRET])
			expect(w.lines.join('\n')).not.toContain(secret);
	});

	test('плохой конфиг → исключение с именем переменной, порт не открыт', () => {
		const w = world();
		const { PLANE_DISCORD_ACME_WEBHOOK_SECRET: _drop, ...partial } = ENV;
		expect(() => startService(partial, w.options)).toThrow('PLANE_DISCORD_ACME_WEBHOOK_SECRET');
		expect(w.lines).toEqual([]);
	});

	test('вебхук Plane → сообщение в канал Discord (сквозной путь через очередь)', async () => {
		const { w, service, url } = start();
		const res = await post(url(''), delivery('00000000-0000-4000-8000-0000000000a1'));
		expect(res.status).toBe(200);
		await service.idle();
		const sent = messages(w);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.body?.content).toContain('**LAB-57**');
		expect(w.entries().some((e) => e.event === 'plane.accepted')).toBe(true);
	});

	test('правка через REST API: одна человеческая доставка state → «Задача закрыта» один раз', async () => {
		const { w, service, url } = start();
		const res = await post(url(''), signed('plane-app-workitem-state-done', humanState));
		expect(res.status).toBe(200);
		await service.idle();
		const sent = messages(w);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.body?.content).toContain('Задача закрыта');
	});

	test('правка через UI: машинный state_id и человеческий state → «Задача закрыта» один раз', async () => {
		const { w, service, url } = start();
		await post(
			url(''),
			signed('plane-app-workitem-state-done', () => {}),
		);
		await post(url(''), signed('plane-app-workitem-state-done', humanState));
		await service.idle();
		const sent = messages(w);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.body?.content).toContain('Задача закрыта');
	});

	test('правка через REST API: assignees добавлен → один DM назначенному', async () => {
		const { w, service, url } = start();
		const res = await post(
			url(''),
			signed('plane-app-workitem-assigned', (b) => {
				b.data.assignees = [{ id: ASSIGNEE }];
				b.activity.field = 'assignees';
				b.activity.old_value = '';
				b.activity.new_value = 'User5';
				b.activity.old_identifier = null;
				b.activity.new_identifier = ASSIGNEE;
			}),
		);
		expect(res.status).toBe(200);
		await service.idle();
		const dms = w.discord.filter((c) => c.method === 'POST' && c.path === '/channels/dm1/messages');
		expect(dms).toHaveLength(1);
		expect(dms[0]?.body?.content).toContain('Тебя назначили');
		expect(messages(w)).toHaveLength(0);
		expect(w.discord.find((c) => c.path === '/users/@me/channels')?.body).toEqual({
			recipient_id: DM_USER,
		});
	});

	test('тип канала запоминается: два события — один GET /channels', async () => {
		const { w, service, url } = start();
		await post(url(''), delivery('00000000-0000-4000-8000-0000000000a1'));
		await post(url(''), delivery('00000000-0000-4000-8000-0000000000a2'));
		await service.idle();
		expect(messages(w)).toHaveLength(2);
		expect(
			w.discord.filter((c) => c.method === 'GET' && c.path === `/channels/${CHANNEL}`),
		).toHaveLength(1);
	});

	test('сбой запроса типа канала не запоминается: следующее событие спрашивает заново', async () => {
		const { w, service, url } = start();
		w.behaviour.channelStatus = 404;
		await post(url(''), delivery('00000000-0000-4000-8000-0000000000a1'));
		await service.idle();
		expect(messages(w)).toHaveLength(0);
		expect(w.entries().some((e) => e.event === 'job.dropped' && e.level === 'error')).toBe(true);
		w.behaviour.channelStatus = 200;
		await post(url(''), delivery('00000000-0000-4000-8000-0000000000a2'));
		await service.idle();
		expect(messages(w)).toHaveLength(1);
	});

	test('/plane/setup редиректит на Plane, /discord/interactions подключён (без подписи — 401, не 404)', async () => {
		const { url } = start();
		const setup = await fetch(url('/plane/setup?tenant=acme'), { redirect: 'manual' });
		expect(setup.status).toBe(302);
		expect(setup.headers.get('location')).toStartWith(
			'https://plane.example.com/auth/o/authorize-app/?',
		);
		const ix = await fetch(url('/discord/interactions'), { method: 'POST', body: '{}' });
		expect(ix.status).toBe(401);
	});

	test('Plane недоступен на старте: сервис отвечает, прогрев пишет warm.failed (warn)', async () => {
		const w = world();
		w.behaviour.planeDown = true;
		const { url } = start(w);
		expect((await fetch(url('/healthz'))).status).toBe(200);
		await w.until(() => w.entries().some((e) => e.event === 'warm.failed'));
		expect(w.entries().find((e) => e.event === 'warm.failed')).toMatchObject({
			level: 'warn',
			tenant: 'acme',
			error: 'TypeError',
		});
	});

	test('логгер, который бросает, не роняет ни запуск, ни ответ', async () => {
		const w = world();
		w.options.write = () => {
			throw new Error('EPIPE');
		};
		const { service, url } = start(w);
		expect((await fetch(url('/healthz'))).status).toBe(200);
		const res = await post(url(''), delivery('00000000-0000-4000-8000-0000000000a1'));
		expect(res.status).toBe(200);
		await service.idle();
		expect(messages(w)).toHaveLength(1);
	});
});

describe('startService: учётные данные и журнал', () => {
	test('Discord: бот-токен в заголовке, id приложения в пути webhook; warm.ok с тенантом; config возвращается', async () => {
		const { w, service, url } = start();
		await w.until(() => w.entries().some((e) => e.event === 'warm.ok'));
		expect(w.entries().find((e) => e.event === 'warm.ok')).toMatchObject({ tenant: 'acme' });
		expect(service.config.tenants.map((t) => t.id)).toEqual(['acme']);
		const opened = await ask(url(''), command(CHANNEL, '800000000000000010'));
		await ask(
			url(''),
			submitPayload({
				id: '800000000000000011',
				guildId: GUILD,
				customId: opened.body.data.custom_id as string,
				texts: { title: 'Починить вход' },
			}),
		);
		await w.until(() => w.entries().some((e) => e.event === 'ix.done'));
		const sent = messages(w)[0]!;
		expect(sent.authorization).toBe('Bot bot-token-value');
		const hook = w.discord.find((c) => c.method === 'DELETE')!;
		expect(hook.path).toBe(
			'/webhooks/123456789012345678/tok-800000000000000011/messages/@original',
		);
		expect(hook.authorization).toBeNull();
	});

	test('событие по проекту без канала → notify.skip в журнале сервиса', async () => {
		const { w, service, url } = start();
		const body = structuredClone(fixture('plane-app-workitem-created').body) as {
			data: { project: string };
		};
		body.data.project = '00000000-0000-4000-8000-0000000000ff';
		const raw = JSON.stringify(body);
		const req = Object.assign(
			new Request('http://x/plane/webhook', {
				method: 'POST',
				body: raw,
				headers: { 'x-plane-event': 'issue', 'x-plane-signature': sign(raw) },
			}),
			{ raw },
		);
		await post(url(''), req);
		await service.idle();
		expect(w.entries().find((e) => e.event === 'notify.skip')).toMatchObject({
			tenant: 'acme',
			reason: 'no_effect',
		});
		expect(messages(w)).toHaveLength(0);
	});
});

describe('startService: таймеры', () => {
	test('периоды: прогрев 10 мин, сторож 15 мин, чистка раз в сутки', () => {
		const { w } = start();
		expect(w.ticks.map((t) => t.ms)).toEqual([10 * 60_000, 15 * 60_000, 24 * 60 * 60_000]);
	});

	test('тик сторожа: тишина дольше silenceHours → сообщение в служебный канал', async () => {
		const { w, service } = start();
		const watchdog = w.ticks[1]!;
		watchdog.tick();
		await service.idle();
		expect(messages(w, SERVICE)).toHaveLength(0);
		w.advance(73 * 3_600_000);
		watchdog.tick();
		await w.until(() => messages(w, SERVICE).length > 0);
		expect(messages(w, SERVICE)[0]?.body?.content).toContain('Plane молчит 73 ч (example-ws)');
		await w.until(() => w.entries().some((e) => e.event === 'plane.silent'));
		expect(w.entries().find((e) => e.event === 'plane.silent')).toMatchObject({
			level: 'error',
			tenant: 'acme',
			hours: 73,
		});
	});

	test('тик чистки: ключ дедупликации старше 7 суток забыт, моложе — нет', async () => {
		const { w, service, url } = start();
		const prune = w.ticks[2]!;
		const req = () => delivery('00000000-0000-4000-8000-0000000000a1');
		await post(url(''), req());
		await service.idle();
		w.advance(6 * 24 * 3_600_000);
		prune.tick();
		await post(url(''), req());
		expect(w.entries().filter((e) => e.event === 'plane.duplicate')).toHaveLength(1);
		w.advance(2 * 24 * 3_600_000);
		prune.tick();
		await post(url(''), req());
		await service.idle();
		expect(w.entries().filter((e) => e.event === 'plane.accepted')).toHaveLength(2);
	});

	test('тик прогрева перечитывает проекты', async () => {
		const { w } = start();
		const warmed = () => w.entries().filter((e) => e.event === 'warm.ok').length;
		await w.until(() => warmed() === 1);
		const before = w.planeHits.filter((p) => p.endsWith('/projects/')).length;
		w.advance(10 * 60_000);
		w.ticks[0]!.tick();
		await w.until(() => warmed() === 2);
		expect(w.planeHits.filter((p) => p.endsWith('/projects/')).length).toBe(before + 1);
	});
});

/** An interaction signed by the test key, delivered to the real server over HTTP. */
async function ask(base: string, payload: unknown) {
	const signed = await signer.request(JSON.stringify(payload));
	const res = await fetch(`${base}/discord/interactions`, {
		method: 'POST',
		body: await signed.text(),
		headers: signed.headers,
	});
	return { status: res.status, body: (await res.json()) as any };
}
const UNMAPPED = '999999999999999999';
const command = (channelId: string, id: string) =>
	commandPayload({
		id,
		guildId: GUILD,
		channel: { id: channelId, type: 0 },
		name: CREATE_COMMAND,
		message: {
			id: '444444444444444441',
			content: 'Починить вход',
			author: { id: '555555555555555551', username: 'mira' },
			attachments: [],
			mentions: [],
		},
	});

describe('startService: Discord interactions', () => {
	test('команда в чужом для карты канале при тёплом кэше → модалка с проектами из Plane', async () => {
		const { w, url } = start();
		await w.until(() => w.entries().some((e) => e.event === 'warm.ok'));
		const res = await ask(url(''), command(UNMAPPED, '800000000000000001'));
		expect(res.status).toBe(200);
		expect(res.body.type).toBe(9);
		expect(JSON.stringify(res.body)).toContain('LAB');
	});

	test('кэш проектов холодный (Plane недоступен) → «повтори через минуту», а не падение', async () => {
		const w = world();
		w.behaviour.planeDown = true;
		const { url } = start(w);
		const res = await ask(url(''), command(UNMAPPED, '800000000000000002'));
		expect(res.body).toMatchObject({
			type: 4,
			data: { content: 'Plane недоступен, повтори через минуту.' },
		});
	});

	test('сервер не из конфига → «Этот сервер не настроен»', async () => {
		const { url } = start();
		const payload = { ...command(CHANNEL, '800000000000000003'), guild_id: '111111111111111199' };
		const res = await ask(url(''), payload);
		expect(res.body.data.content).toBe('Этот сервер не настроен.');
	});

	test('отправка формы: сразу type 5, задача создаётся после ответа, в канал уходит reply', async () => {
		const { w, service, url } = start();
		const opened = await ask(url(''), command(CHANNEL, '800000000000000004'));
		expect(opened.body.type).toBe(9);
		const customId = opened.body.data.custom_id as string;
		const sent = await ask(
			url(''),
			submitPayload({
				id: '800000000000000005',
				guildId: GUILD,
				customId,
				texts: { title: 'Починить вход', description: 'текст' },
			}),
		);
		expect(sent.body).toEqual({ type: 5, data: { flags: 64 } });
		await w.until(() => w.entries().some((e) => e.event === 'ix.done'));
		await service.idle();
		const created = w.planeRequests.filter(
			(r) => r.method === 'POST' && r.path.endsWith('/work-items/'),
		);
		expect(created).toHaveLength(1);
		expect(JSON.parse(created[0]!.body)).toMatchObject({
			name: 'Починить вход',
			external_source: 'discord',
			external_id: '444444444444444441',
		});
		expect(messages(w)[0]?.body?.content).toContain('`LAB-7`');
	});
});

describe('startService: Plane и лимиты', () => {
	test('запросы к Plane идут в нужный воркспейс с учётными данными тенанта', async () => {
		const { w } = start();
		await w.until(() =>
			w.planeRequests.some((r) => r.path.startsWith('/api/v1/workspaces/example-ws/projects/')),
		);
		const token = w.planeRequests.find((r) => r.path === '/auth/o/token/')!;
		expect(token.headers.get('authorization')).toBe(
			`Basic ${Buffer.from('example-client-id:client-secret-value').toString('base64')}`,
		);
		expect(new URLSearchParams(token.body).get('app_installation_id')).toBe('inst-1');
		await w.until(() =>
			w.planeRequests.some((r) => r.path.startsWith('/auth/o/app-installation/')),
		);
		expect(
			w.planeRequests.find((r) => r.path.startsWith('/auth/o/app-installation/'))?.path,
		).toContain('id=inst-1');
	});

	test('тело до 8 MiB доходит до обработчика (200 и plane.rejected), больше — отказ Bun', async () => {
		const { w, url } = start();
		const post5 = await fetch(url('/plane/webhook'), {
			method: 'POST',
			body: new Uint8Array(5 * 1024 * 1024),
		});
		expect(post5.status).toBe(200);
		expect(w.entries().find((e) => e.event === 'plane.rejected')).toMatchObject({
			level: 'error',
			reason: 'too_large',
		});
		const post9 = await fetch(url('/plane/webhook'), {
			method: 'POST',
			body: new Uint8Array(9 * 1024 * 1024),
		});
		expect(post9.status).toBe(413);
	});
});

describe('startService: остановка', () => {
	test('stop: порт закрыт, таймеры сняты, текущая отправка дожидается', async () => {
		const w = world();
		let cancelled = 0;
		w.options.every = (tick, ms) => {
			w.ticks.push({ tick, ms });
			return () => void cancelled++;
		};
		const gate = Promise.withResolvers<void>();
		w.behaviour.gate = gate.promise;
		const { service, url } = start(w);
		running.pop();
		await post(url(''), delivery('00000000-0000-4000-8000-0000000000a1'));
		await w.reachedGate;
		let stopped = false;
		const stopping = service.stop().then(() => (stopped = true));
		expect(cancelled).toBe(3);
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		expect(stopped).toBe(false);
		await new Promise<void>((resolve, reject) => {
			const socket = connect(service.port, '127.0.0.1');
			socket.on('connect', () => {
				socket.destroy();
				reject(new Error('the port still accepts connections'));
			});
			socket.on('error', () => resolve());
		});
		gate.resolve();
		await stopping;
		expect(messages(w)).toHaveLength(1);
	});
});

describe('startService: срок остановки', () => {
	test('задача висит: stop() с drainMs отпускает, порт закрыт, store закрыт', async () => {
		const w = world();
		const gate = Promise.withResolvers<void>();
		w.behaviour.gate = gate.promise;
		Object.assign(w.options, { drainMs: 20 });
		const { service, url } = start(w);
		running.pop();
		await post(url(''), delivery('00000000-0000-4000-8000-0000000000a1'));
		await w.reachedGate;
		await service.stop();
		await new Promise<void>((resolve, reject) => {
			const socket = connect(service.port, '127.0.0.1');
			socket.on('connect', () => {
				socket.destroy();
				reject(new Error('the port still accepts connections'));
			});
			socket.on('error', () => resolve());
		});
		// A closed store throws on use: the prune tick, called after stop, logs prune.failed.
		w.ticks[2]!.tick();
		expect(w.entries().find((e) => e.event === 'prune.failed')).toMatchObject({ level: 'error' });
		gate.resolve();
		await service.idle();
	});
});

describe('startService: чистая остановка', () => {
	test('очередь пуста: таймер срока снят, ничего не висит', async () => {
		jest.useFakeTimers();
		try {
			const { service } = start();
			running.pop();
			await service.stop();
			expect(jest.getTimerCount()).toBe(0);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('intervalEvery', () => {
	test('тикает каждые ms, отмена останавливает', () => {
		jest.useFakeTimers();
		try {
			let ticks = 0;
			const cancel = intervalEvery(() => void ticks++, 5);
			jest.advanceTimersByTime(4);
			expect(ticks).toBe(0);
			jest.advanceTimersByTime(6);
			expect(ticks).toBe(2);
			cancel();
			jest.advanceTimersByTime(50);
			expect(ticks).toBe(2);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('installProcessHandlers', () => {
	test('rejection логируется, процесс жив; SIGTERM и SIGINT вызывают shutdown', () => {
		const proc = new EventEmitter();
		const lines: unknown[] = [];
		let shutdowns = 0;
		installProcessHandlers(
			proc,
			(entry) => lines.push(entry),
			() => void shutdowns++,
		);
		proc.emit('unhandledRejection', new RangeError('x'));
		expect(lines).toEqual([{ event: 'unhandled.rejection', level: 'error', error: 'RangeError' }]);
		expect(shutdowns).toBe(0);
		proc.emit('SIGTERM');
		expect(shutdowns).toBe(1);
		proc.emit('SIGINT');
		expect(shutdowns).toBe(2);
	});
});

describe('logUnhandled', () => {
	test('пишет класс ошибки, не текст; сбой журнала не пробрасывается', () => {
		const lines: unknown[] = [];
		logUnhandled((entry) => lines.push(entry))(new RangeError('секрет в тексте'));
		expect(lines).toEqual([{ event: 'unhandled.rejection', level: 'error', error: 'RangeError' }]);
		logUnhandled((entry) => lines.push(entry))('не ошибка');
		expect(lines[1]).toEqual({ event: 'unhandled.rejection', level: 'error', error: 'unknown' });
		const broken = logUnhandled(() => {
			throw new Error('EPIPE');
		});
		expect(() => broken(new Error('x'))).not.toThrow();
	});
});
