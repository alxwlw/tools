// The composition root: every module wired as in production, with Plane and Discord replaced at fetch level.
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';

import { type Service, startService } from '../src/index.ts';
import { fixture } from './fixtures.ts';

const WORKSPACE = '00000000-0000-4000-8000-000000000002';
const PROJECT = '00000000-0000-4000-8000-000000000007';
const SECRET = 'test-secret';
const CHANNEL = '333333333333333333';
const SERVICE = '222222222222222222';
const GUILD = '111111111111111111';

const TENANTS = JSON.stringify({
	tenants: [
		{
			id: 'acme',
			guildId: GUILD,
			workspace: 'example-ws',
			workspaceId: WORKSPACE,
			plane: { clientId: 'example-client-id', appInstallationId: 'inst-1' },
			serviceChannelId: SERVICE,
			silenceHours: 72,
			channels: [{ channelId: CHANNEL, projectId: PROJECT }],
			users: [],
		},
	],
});
const ENV = {
	PLANE_DISCORD_PLANE_URL: 'https://plane.example.com',
	PLANE_DISCORD_PUBLIC_URL: 'https://plane-discord.example.com',
	PLANE_DISCORD_CONFIG: '/config/tenants.json',
	PLANE_DISCORD_DB: ':memory:',
	PLANE_DISCORD_DISCORD_APPLICATION_ID: '123456789012345678',
	PLANE_DISCORD_DISCORD_PUBLIC_KEY: 'ab'.repeat(32),
	PLANE_DISCORD_DISCORD_BOT_TOKEN: 'bot-token-value',
	PLANE_DISCORD_ACME_PLANE_SECRET: 'client-secret-value',
	PLANE_DISCORD_ACME_WEBHOOK_SECRET: SECRET,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Discord = { method: string; path: string; body: Record<string, unknown> | null };
function world() {
	const discord: Discord[] = [];
	const planeHits: string[] = [];
	const behaviour = { channelStatus: 200, planeDown: false };
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		const { host, pathname } = new URL(url);
		if (host === 'discord.com') {
			const path = pathname.replace('/api/v10', '');
			discord.push({
				method: init.method ?? 'GET',
				path,
				body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
			});
			if (path === `/channels/${CHANNEL}` && init.method === 'GET')
				return behaviour.channelStatus === 200
					? json({ id: CHANNEL, type: 0, guild_id: GUILD, name: 'general' })
					: json({ message: 'x' }, behaviour.channelStatus);
			if (path.endsWith('/messages')) return json({ id: 'm1' });
			return json({}, 404);
		}
		planeHits.push(pathname);
		if (behaviour.planeDown) throw new TypeError('network down');
		if (pathname === '/auth/o/token/') return json({ access_token: 't', expires_in: 36_000 });
		if (pathname.endsWith('/app-installation/')) return json({ app_bot: 'bot-1' });
		if (pathname.endsWith('/projects/'))
			return json({
				results: [{ id: PROJECT, identifier: 'LAB', name: 'Lab' }],
				next_page_results: false,
			});
		if (pathname.endsWith('/members/'))
			return json({
				results: [{ id: '00000000-0000-4000-8000-000000000006', display_name: 'User1' }],
				next_page_results: false,
			});
		return json({}, 404);
	};
	const lines: string[] = [];
	const entries = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
	const ticks: Array<{ tick: () => void; ms: number }> = [];
	let clock = 1_800_000_000_000;
	return {
		discord,
		planeHits,
		behaviour,
		lines,
		entries,
		ticks,
		advance: (ms: number) => (clock += ms),
		options: {
			readFile: () => TENANTS,
			fetch,
			write: (line: string) => lines.push(line),
			listenPort: 0,
			now: () => clock,
			every: (tick: () => void, ms: number) => {
				ticks.push({ tick, ms });
				return () => {};
			},
		},
	};
}

const running: Service[] = [];
afterEach(async () => {
	for (const service of running.splice(0)) await service.stop();
});
function start(w = world(), env: Record<string, string | undefined> = ENV) {
	const service = startService(env, w.options);
	running.push(service);
	return { w, service, url: (path: string) => `http://localhost:${service.port}${path}` };
}

const sign = (raw: string) => createHmac('sha256', SECRET).update(raw).digest('hex');
/** The captured "issue created" delivery with another work item id, signed with the test secret. */
function delivery(id: string): Request & { raw: string } {
	const body = structuredClone(fixture('plane-app-workitem-created').body) as {
		data: { id: string };
	};
	body.data.id = id;
	const raw = JSON.stringify(body);
	return Object.assign(
		new Request('http://x/plane/webhook', {
			method: 'POST',
			body: raw,
			headers: { 'x-plane-event': 'issue', 'x-plane-signature': sign(raw) },
		}),
		{ raw },
	);
}
const post = (base: string, req: Request & { raw: string }) =>
	fetch(`${base}/plane/webhook`, { method: 'POST', body: req.raw, headers: req.headers });
const messages = (w: ReturnType<typeof world>, channel = CHANNEL) =>
	w.discord.filter((c) => c.method === 'POST' && c.path === `/channels/${channel}/messages`);

describe('startService', () => {
	test('/healthz → ok, строка listening с картой тенантов без секретов', async () => {
		const { w, url } = start();
		const res = await fetch(url('/healthz'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
		const listening = w.entries().find((e) => e.event === 'listening');
		expect(listening).toMatchObject({
			tenants: [{ id: 'acme', channels: 1, users: 0 }],
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
		for (let i = 0; i < 200 && !w.entries().some((e) => e.event === 'warm.failed'); i++)
			await new Promise((resolve) => setImmediate(resolve));
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
		for (let i = 0; i < 200 && messages(w, SERVICE).length === 0; i++)
			await new Promise((resolve) => setImmediate(resolve));
		expect(messages(w, SERVICE)[0]?.body?.content).toContain('Plane молчит 73 ч (example-ws)');
		for (let i = 0; i < 200 && !w.entries().some((e) => e.event === 'plane.silent'); i++)
			await new Promise((resolve) => setImmediate(resolve));
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
		for (let i = 0; i < 200 && !w.planeHits.some((p) => p.endsWith('/projects/')); i++)
			await new Promise((resolve) => setImmediate(resolve));
		const before = w.planeHits.filter((p) => p.endsWith('/projects/')).length;
		w.advance(10 * 60_000);
		w.ticks[0]!.tick();
		for (
			let i = 0;
			i < 200 && w.planeHits.filter((p) => p.endsWith('/projects/')).length === before;
			i++
		)
			await new Promise((resolve) => setImmediate(resolve));
		expect(w.planeHits.filter((p) => p.endsWith('/projects/')).length).toBe(before + 1);
	});
});
