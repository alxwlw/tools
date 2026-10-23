import type { Tenant } from '../src/config.ts';
import { CREATE_COMMAND } from '../src/discord/commands.ts';
import { createInteractionHandler } from '../src/discord/interactions.ts';
import { type LogEntry } from '../src/log.ts';
import type { TenantRuntime } from '../src/notify.ts';
import { type PlaneApi, type ProjectSummary } from '../src/plane/client.ts';
import { Store } from '../src/store.ts';
import { userMap } from '../src/text.ts';
import {
	commandPayload,
	type DiscordMessage,
	makeSigner,
	submitPayload,
} from './discord-harness.ts';
import { FakeDiscord } from './fake-discord.ts';
import { FakePlane } from './fake-plane.ts';

export const GUILD = '111111111111111111';
export const OTHER_GUILD = '111111111111111112';
export const NOCONF_GUILD = '111111111111111113';
export const MAPPED = '222222222222222221';
export const UNMAPPED = '222222222222222222';
export const FORUM = '222222222222222223';
export const THREAD = '222222222222222224';
export const MSG = '444444444444444441';
export const AUTHOR = '555555555555555551';
export const LINKED = '555555555555555552';
export const P_LAB = '00000000-0000-4000-8000-0000000000a1';
export const P_ENG = '00000000-0000-4000-8000-0000000000a2';
export const P_HIDDEN = '00000000-0000-4000-8000-0000000000a3';
export const PLANE_URL = 'https://plane.example.com';
export const SECRET_TEXT = 'сверхсекретный текст сообщения';

export const LAB: ProjectSummary = { id: P_LAB, identifier: 'LAB', name: 'Laboratory' };
export const ENG: ProjectSummary = { id: P_ENG, identifier: 'ENG', name: 'Engineering' };
export const HIDDEN: ProjectSummary = { id: P_HIDDEN, identifier: 'ZEN', name: 'Hidden' };

export const tenant = (): Tenant => ({
	id: 'initech',
	guildId: GUILD,
	workspace: 'example-ws',
	workspaceId: '00000000-0000-4000-8000-000000000002',
	auth: { clientId: 'cid', clientSecret: 'csecret', appInstallationId: 'inst' },
	webhookSecret: 'whsec',
	serviceChannelId: null,
	silenceHours: 72,
	hiddenProjects: [P_HIDDEN],
	channels: [
		{ channelId: MAPPED, projectId: P_LAB, moduleId: null, events: ['created'] },
		{ channelId: FORUM, projectId: P_ENG, moduleId: null, events: ['created'] },
	],
	users: [{ plane: 'plane-user-1', discord: LINKED }],
});

export const msg = (over: Partial<DiscordMessage> = {}): DiscordMessage => ({
	id: MSG,
	content: 'Починить вход\nПодробности ниже',
	author: { id: AUTHOR, username: 'mira', global_name: 'Мира' },
	attachments: [],
	mentions: [],
	...over,
});

export type World = Awaited<ReturnType<typeof setup>>;

export async function setup(
	opts: {
		cached?: ProjectSummary[] | null;
		store?: Store;
		withDefer?: boolean;
		/** Leave `now` and `nonce` to the handler's own defaults. */
		realClockAndNonce?: boolean;
		throwingLog?: boolean;
	} = {},
) {
	const signer = await makeSigner();
	const plane = new FakePlane();
	plane.projects = [LAB, ENG, HIDDEN];
	const planeCalls: string[] = [];
	// Every PlaneApi method is counted, so "no Plane call" is a claim about the real call surface.
	const countedPlane = new Proxy(plane, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== 'function' || typeof prop !== 'string') return value;
			return (...args: unknown[]) => {
				planeCalls.push(prop);
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	}) as PlaneApi;
	const discord = new FakeDiscord();
	const store = opts.store ?? new Store(':memory:');
	const logs: LogEntry[] = [];
	const t = tenant();
	const rt: TenantRuntime = {
		tenant: t,
		plane: countedPlane,
		users: userMap(t.users),
		projects: async () => plane.projects,
		states: async () => [],
		members: async () => [],
	};
	const rt2: TenantRuntime = {
		...rt,
		tenant: { ...tenant(), id: 'umbrella', guildId: OTHER_GUILD, channels: [], users: [] },
	};
	const pending: Promise<void>[] = [];
	let clock = 1_000_000;
	let nonces = 0;
	const handler = createInteractionHandler({
		publicKey: signer.publicKey,
		runtimesByGuild: new Map([
			[GUILD, rt],
			[OTHER_GUILD, rt2],
		]),
		discord,
		store,
		planeUrl: PLANE_URL,
		projectsCached: () => (opts.cached === undefined ? [LAB, ENG, HIDDEN] : opts.cached),
		log: (e) => {
			logs.push(e);
			if (opts.throwingLog) throw new Error('EPIPE');
		},
		...(opts.realClockAndNonce === true ? {} : { now: () => clock, nonce: () => `n${++nonces}` }),
		...(opts.withDefer === false
			? {}
			: { defer: (work: () => Promise<void>) => void pending.push(work()) }),
	});
	let seq = 0;
	const ids = { next: () => String(900_000_000_000_000_000n + BigInt(++seq)) };
	return {
		signer,
		plane,
		planeCalls,
		discord,
		store,
		logs,
		rt,
		handler,
		ids,
		advance: (ms: number) => void (clock += ms),
		async ask(payload: unknown): Promise<{ status: number; body: any; headers: Headers }> {
			const res = await handler(await signer.request(JSON.stringify(payload)));
			const text = await res.text();
			return {
				status: res.status,
				body: text.startsWith('{') ? JSON.parse(text) : text,
				headers: res.headers,
			};
		},
		async settle(): Promise<void> {
			await Promise.all(pending);
		},
	};
}

/** Opens a form with a command and returns its custom_id. */
export async function open(
	w: World,
	opts: { name?: string; channel?: Record<string, unknown>; message?: DiscordMessage } = {},
): Promise<{ customId: string; body: any }> {
	const res = await w.ask(
		commandPayload({
			id: w.ids.next(),
			guildId: GUILD,
			channel: opts.channel ?? { id: MAPPED, type: 0 },
			name: opts.name ?? CREATE_COMMAND,
			message: opts.message ?? msg(),
		}),
	);
	return { customId: res.body.data?.custom_id, body: res.body };
}

export const submitCreate = (
	w: World,
	customId: string,
	texts: Record<string, string>,
	selects?: Record<string, string[]>,
) => w.ask(submitPayload({ id: w.ids.next(), guildId: GUILD, customId, texts, selects }));

/** The text input / select inside the label with this custom_id. */
export const field = (body: any, id: string): any =>
	body.data.components.map((c: any) => c.component).find((c: any) => c.custom_id === id);

export const hasLoneSurrogate = (s: string) => !s.isWellFormed();
