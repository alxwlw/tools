// The composition root: every module wired as in production, with Plane and Discord replaced at fetch level.
import { createHmac } from 'node:crypto';

import { type Service, type ServiceOptions, startService } from '../src/index.ts';
import { makeSigner } from './discord-harness.ts';
import { fixture } from './fixtures.ts';

export const signer = await makeSigner();
export const WORKSPACE = '00000000-0000-4000-8000-000000000002';
export const PROJECT = '00000000-0000-4000-8000-000000000007';
export const BACKLOG = '00000000-0000-4000-8000-000000000004';
export const DONE = '00000000-0000-4000-8000-000000000009';
export const SECRET = 'test-secret';
export const CHANNEL = '333333333333333333';
export const SERVICE = '222222222222222222';
export const GUILD = '111111111111111111';
export const DM_USER = '444444444444444444';
export const ASSIGNEE = '00000000-0000-4000-8000-000000000014';

export const TENANTS = JSON.stringify({
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
			users: [{ plane: ASSIGNEE, discord: DM_USER }],
		},
	],
});
export const ENV = {
	PLANE_DISCORD_PLANE_URL: 'https://plane.example.com',
	PLANE_DISCORD_PUBLIC_URL: 'https://plane-discord.example.com',
	PLANE_DISCORD_CONFIG: '/config/tenants.json',
	PLANE_DISCORD_DB: ':memory:',
	PLANE_DISCORD_DISCORD_APPLICATION_ID: '123456789012345678',
	PLANE_DISCORD_DISCORD_PUBLIC_KEY: signer.publicKey,
	PLANE_DISCORD_DISCORD_BOT_TOKEN: 'bot-token-value',
	PLANE_DISCORD_ACME_PLANE_SECRET: 'client-secret-value',
	PLANE_DISCORD_ACME_WEBHOOK_SECRET: SECRET,
};

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

export type Discord = {
	method: string;
	path: string;
	body: Record<string, unknown> | null;
	authorization: string | null;
};
export function world() {
	const discord: Discord[] = [];
	const planeHits: string[] = [];
	const planeRequests: Array<{ method: string; path: string; headers: Headers; body: string }> = [];
	const behaviour = {
		channelStatus: 200,
		planeDown: false,
		/** What `GET /channels/{id}/webhooks` lists. */
		webhooks: [] as unknown[],
		/** When set, a Discord message POST waits for it. */
		gate: null as Promise<void> | null,
	};
	let gateReached = () => {};
	const reachedGate = new Promise<void>((resolve) => (gateReached = resolve));
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		const { host, pathname } = new URL(url);
		queueMicrotask(poke);
		if (host === 'discord.com') {
			const path = pathname.replace('/api/v10', '');
			discord.push({
				method: init.method ?? 'GET',
				path,
				body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
				authorization: new Headers(init.headers).get('authorization'),
			});
			if (path === `/channels/${CHANNEL}` && init.method === 'GET')
				return behaviour.channelStatus === 200
					? json({ id: CHANNEL, type: 0, guild_id: GUILD, name: 'general' })
					: json({ message: 'x' }, behaviour.channelStatus);
			if (path.endsWith('/messages') && init.method === 'POST') {
				if (behaviour.gate) {
					gateReached();
					await behaviour.gate;
				}
				return json({ id: 'm1' });
			}
			if (path === '/users/@me/channels' && init.method === 'POST') return json({ id: 'dm1' });
			if (path.endsWith('/webhooks') && init.method === 'GET') return json(behaviour.webhooks);
			if (path.endsWith('/webhooks') && init.method === 'POST')
				return json({ id: 'wh-new', token: 'tok-new' });
			if (path.startsWith('/webhooks/') && init.method === 'POST') return json({ id: 'wm1' });
			if (init.method === 'DELETE') return new Response(null, { status: 204 });
			return json({}, 404);
		}
		planeHits.push(pathname);
		planeRequests.push({
			method: init.method ?? 'GET',
			path: pathname + new URL(url).search,
			headers: new Headers(init.headers),
			body: typeof init.body === 'string' ? init.body : '',
		});
		if (behaviour.planeDown) throw new TypeError('network down');
		if (pathname === '/auth/o/token/') return json({ access_token: 't', expires_in: 36_000 });
		if (pathname.endsWith('/app-installation/')) return json({ app_bot: 'bot-1' });
		if (pathname.endsWith('/projects/'))
			return json({
				results: [{ id: PROJECT, identifier: 'LAB', name: 'Lab' }],
				next_page_results: false,
			});
		if (pathname.endsWith('/work-items/') && init.method === 'GET') return json({}, 404);
		if (pathname.endsWith('/work-items/') && init.method === 'POST') return json({ id: 'w1' }, 201);
		if (pathname.endsWith('/work-items/w1/'))
			return json({
				id: 'w1',
				project: PROJECT,
				sequence_id: 7,
				name: 'Починить вход',
				state: 's1',
				priority: 'none',
				assignees: [],
			});
		if (pathname.endsWith('/comments/'))
			return init.method === 'POST'
				? json({ id: 'c1' }, 201)
				: json({ results: [], next_page_results: false });
		if (pathname.endsWith('/states/'))
			return json({
				results: [
					{ id: BACKLOG, name: 'Backlog', group: 'backlog' },
					{ id: DONE, name: 'Done', group: 'completed' },
				],
				next_page_results: false,
			});
		if (pathname.endsWith('/members/'))
			return json({
				results: [{ id: '00000000-0000-4000-8000-000000000006', display_name: 'User1' }],
				next_page_results: false,
			});
		return json({}, 404);
	};
	const watchers = new Set<() => void>();
	const poke = () => {
		for (const check of [...watchers]) check();
	};
	/** Resolves once `done()` holds; re-checked whenever a line is logged or a request is made. */
	const until = (done: () => boolean) =>
		new Promise<void>((resolve) => {
			const check = () => {
				if (!done()) return;
				watchers.delete(check);
				resolve();
			};
			watchers.add(check);
			check();
		});
	const lines: string[] = [];
	const gateways: Array<{
		opts: Parameters<NonNullable<ServiceOptions['gateway']>>[0];
		started: number;
		stopped: number;
	}> = [];
	const entries = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
	const ticks: Array<{ tick: () => void; ms: number }> = [];
	let clock = 1_800_000_000_000;
	return {
		discord,
		planeHits,
		planeRequests,
		reachedGate,
		until,
		behaviour,
		lines,
		entries,
		ticks,
		gateways,
		advance: (ms: number) => (clock += ms),
		options: {
			readFile: () => TENANTS,
			fetch,
			write: (line: string) => {
				lines.push(line);
				poke();
			},
			listenPort: 0,
			gateway: ((opts) => {
				const g = { opts, started: 0, stopped: 0 };
				gateways.push(g);
				return {
					start: () => void g.started++,
					stop: async () => void g.stopped++,
				};
			}) as NonNullable<ServiceOptions['gateway']>,
			now: () => clock,
			every: (tick: () => void, ms: number) => {
				ticks.push({ tick, ms });
				return () => {};
			},
		},
	};
}

export const running: Service[] = [];
export function start(w = world(), env: Record<string, string | undefined> = ENV) {
	const service = startService(env, w.options);
	running.push(service);
	return { w, service, url: (path: string) => `http://localhost:${service.port}${path}` };
}

export const sign = (raw: string) => createHmac('sha256', SECRET).update(raw).digest('hex');
/** The captured "issue created" delivery with another work item id, signed with the test secret. */
export function delivery(id: string): Request & { raw: string } {
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
/** A signed delivery: the captured fixture `name` after `edit`. */
export function signed(name: string, edit: (b: any) => void): Request & { raw: string } {
	const body = structuredClone(fixture(name).body) as any;
	edit(body);
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
/** The "human" twin of a state change, the only delivery the REST API produces. */
export const humanState = (b: any) => {
	b.activity.field = 'state';
	b.activity.old_value = 'Backlog';
	b.activity.new_value = 'Done';
	b.activity.old_identifier = BACKLOG;
	b.activity.new_identifier = DONE;
};
export const post = (base: string, req: Request & { raw: string }) =>
	fetch(`${base}/plane/webhook`, { method: 'POST', body: req.raw, headers: req.headers });
export const messages = (w: ReturnType<typeof world>, channel = CHANNEL) =>
	w.discord.filter((c) => c.method === 'POST' && c.path === `/channels/${channel}/messages`);
