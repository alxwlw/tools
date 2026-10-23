import { describe, expect, test } from 'bun:test';

import type { Tenant } from '../src/config.ts';
import { APPEND_COMMAND, commandDefinitions, CREATE_COMMAND } from '../src/discord/commands.ts';
import { createInteractionHandler } from '../src/discord/interactions.ts';
import { DiscordApiError } from '../src/discord/rest.ts';
import { type LogEntry } from '../src/log.ts';
import type { TenantRuntime } from '../src/notify.ts';
import { type PlaneApi, PlaneApiError, type ProjectSummary } from '../src/plane/client.ts';
import { createHandler } from '../src/server.ts';
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

const GUILD = '111111111111111111';
const OTHER_GUILD = '111111111111111112';
const NOCONF_GUILD = '111111111111111113';
const MAPPED = '222222222222222221';
const UNMAPPED = '222222222222222222';
const FORUM = '222222222222222223';
const THREAD = '222222222222222224';
const MSG = '444444444444444441';
const AUTHOR = '555555555555555551';
const LINKED = '555555555555555552';
const P_LAB = '00000000-0000-4000-8000-0000000000a1';
const P_ENG = '00000000-0000-4000-8000-0000000000a2';
const P_HIDDEN = '00000000-0000-4000-8000-0000000000a3';
const PLANE_URL = 'https://plane.example.com';
const SECRET_TEXT = 'сверхсекретный текст сообщения';

const LAB: ProjectSummary = { id: P_LAB, identifier: 'LAB', name: 'Laboratory' };
const ENG: ProjectSummary = { id: P_ENG, identifier: 'ENG', name: 'Engineering' };
const HIDDEN: ProjectSummary = { id: P_HIDDEN, identifier: 'ZEN', name: 'Hidden' };

const tenant = (): Tenant => ({
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

const msg = (over: Partial<DiscordMessage> = {}): DiscordMessage => ({
	id: MSG,
	content: 'Починить вход\nПодробности ниже',
	author: { id: AUTHOR, username: 'mira', global_name: 'Мира' },
	attachments: [],
	mentions: [],
	...over,
});

type World = Awaited<ReturnType<typeof setup>>;

async function setup(
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
async function open(
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

const submitCreate = (
	w: World,
	customId: string,
	texts: Record<string, string>,
	selects?: Record<string, string[]>,
) => w.ask(submitPayload({ id: w.ids.next(), guildId: GUILD, customId, texts, selects }));

/** The text input / select inside the label with this custom_id. */
const field = (body: any, id: string): any =>
	body.data.components.map((c: any) => c.component).find((c: any) => c.custom_id === id);

const hasLoneSurrogate = (s: string) => !s.isWellFormed();

describe('createInteractionHandler: подпись и служебные ответы', () => {
	test('неверная подпись → 401; PING → {type: 1}', async () => {
		const w = await setup();
		const ping = JSON.stringify({ type: 1 });
		const forged = await (await makeSigner()).request(ping);
		const res = await w.handler(forged);
		expect(res.status).toBe(401);
		const noHeaders = await w.handler(
			new Request('http://x.test/', { method: 'POST', body: ping }),
		);
		expect(noHeaders.status).toBe(401);
		const good = await w.ask({ type: 1 });
		expect([good.status, good.body]).toEqual([200, { type: 1 }]);
		expect(good.headers.get('content-type')).toBe('application/json');
	});

	test('подпись проверяется до разбора: подписанный не-JSON → 400, неподписанный не-JSON → 401', async () => {
		const w = await setup();
		const signedJunk = await w.handler(await w.signer.request('not json{'));
		expect(signedJunk.status).toBe(400);
		const signedArray = await w.handler(await w.signer.request('[1,2]'));
		expect(signedArray.status).toBe(400);
		const unsignedJunk = await w.handler(
			new Request('http://x.test/', { method: 'POST', body: 'not json{' }),
		);
		expect(unsignedJunk.status).toBe(401);
		expect(w.store.claim('ix:probe')).toBe(true);
	});

	test('тело больше лимита → 413 без проверки подписи', async () => {
		const w = await setup();
		const big = 'x'.repeat(4 * 1024 * 1024 + 1);
		const res = await w.handler(await w.signer.request(big));
		expect(res.status).toBe(413);
	});

	test('сервер без тенанта → ephemeral «не настроен»', async () => {
		const w = await setup();
		const res = await w.ask(
			commandPayload({
				id: w.ids.next(),
				guildId: NOCONF_GUILD,
				channel: { id: MAPPED, type: 0 },
				name: CREATE_COMMAND,
				message: msg(),
			}),
		);
		expect(res.body.type).toBe(4);
		expect(res.body.data.flags).toBe(64);
		expect(res.body.data.content).toBe('Этот сервер не настроен.');
		expect(res.body.data.allowed_mentions).toEqual({ parse: [] });
		const dm = await w.ask({ type: 2, id: w.ids.next(), data: { type: 3 } });
		expect(dm.body.data.content).toBe('Этот сервер не настроен.');
	});

	test('тот же interaction id второй раз → ephemeral «уже обработано», модалки нет', async () => {
		const w = await setup();
		const payload = commandPayload({
			id: w.ids.next(),
			guildId: GUILD,
			channel: { id: MAPPED, type: 0 },
			name: CREATE_COMMAND,
			message: msg(),
		});
		expect((await w.ask(payload)).body.type).toBe(9);
		const again = await w.ask(payload);
		expect(again.body.type).toBe(4);
		expect(again.body.data.content).toBe('Уже обработано.');
		expect(w.logs.map((l) => l.event)).toContain('ix.duplicate');
	});

	test('commandDefinitions: две MESSAGE-команды с именами из констант, contexts [0]', () => {
		expect(commandDefinitions()).toEqual([
			{ name: CREATE_COMMAND, type: 3, contexts: [0], integration_types: [0] },
			{ name: APPEND_COMMAND, type: 3, contexts: [0], integration_types: [0] },
		]);
		expect(CREATE_COMMAND).toBe('Создать задачу в Plane');
		expect(APPEND_COMMAND).toBe('Добавить в задачу');
	});
});

describe('createInteractionHandler: модалка «создать задачу»', () => {
	test('сопоставленный канал → модалка из двух полей: название — первая строка, описание — текст', async () => {
		const w = await setup();
		const { body } = await open(w);
		expect(body.type).toBe(9);
		expect(body.data.custom_id).toBe('create:n1');
		expect(body.data.title).toBe('Задача в Plane');
		expect(body.data.components).toHaveLength(2);
		expect(body.data.components.every((c: any) => c.type === 18)).toBe(true);
		expect(field(body, 'title')).toMatchObject({
			type: 4,
			style: 1,
			max_length: 255,
			required: true,
			value: 'Починить вход',
		});
		expect(field(body, 'description')).toMatchObject({
			type: 4,
			style: 2,
			max_length: 4000,
			required: false,
			value: 'Починить вход\nПодробности ниже',
		});
		expect(field(body, 'project')).toBeUndefined();
	});

	test('несопоставленный канал → select без hiddenProjects, не больше 25 вариантов, ни одного вызова Plane', async () => {
		const many: ProjectSummary[] = Array.from({ length: 30 }, (_, i) => ({
			id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`,
			identifier: `P${String(29 - i).padStart(2, '0')}`,
			name: `Проект ${i}`,
		}));
		const w = await setup({ cached: [HIDDEN, ...many] });
		const { body } = await open(w, { channel: { id: UNMAPPED, type: 0 } });
		expect(body.type).toBe(9);
		expect(body.data.components).toHaveLength(3);
		const select = field(body, 'project');
		expect(select).toMatchObject({ type: 3, required: true });
		expect(select.options).toHaveLength(25);
		expect(select.options.map((o: any) => o.value)).not.toContain(P_HIDDEN);
		// Sorted by identifier before the cut: P00 … P24.
		expect(select.options[0]).toEqual({ label: 'P00 — Проект 29', value: many[29]?.id });
		expect(select.options[24].label).toBe('P24 — Проект 5');
		expect(w.planeCalls).toEqual([]);
	});

	test('подпись варианта «<identifier> — <name>» режется до 100', async () => {
		const long: ProjectSummary = { id: P_LAB, identifier: 'LAB', name: 'я'.repeat(300) };
		const w = await setup({ cached: [long] });
		const { body } = await open(w, { channel: { id: UNMAPPED, type: 0 } });
		const label = field(body, 'project').options[0].label as string;
		expect(Array.from(label)).toHaveLength(100);
		expect(label.startsWith('LAB — яяя')).toBe(true);
		expect(label.endsWith('…')).toBe(true);
	});

	test('кэш проектов пуст → ephemeral, модалки нет', async () => {
		const w = await setup({ cached: null });
		const { body } = await open(w, { channel: { id: UNMAPPED, type: 0 } });
		expect(body.type).toBe(4);
		expect(body.data.content).toBe('Plane недоступен, повтори через минуту.');
		expect(w.planeCalls).toEqual([]);
	});

	test('кэш из одних скрытых проектов → ephemeral, модалки нет', async () => {
		const w = await setup({ cached: [HIDDEN] });
		const { body } = await open(w, { channel: { id: UNMAPPED, type: 0 } });
		expect(body.type).toBe(4);
		expect(body.data.content).toBe('Нет проектов, в которые можно создать задачу.');
	});

	test('канал сопоставлен со скрытым проектом → ephemeral, модалки нет', async () => {
		const w = await setup();
		w.rt.tenant.hiddenProjects = [P_LAB];
		const { body } = await open(w);
		expect(body.type).toBe(4);
		expect(body.data.content).toBe('Для этого проекта создание задач из Discord отключено.');
	});

	test('сообщение в треде форума → маршрут по parent_id; тред без parent_id → по своему id', async () => {
		const w = await setup();
		const thread = await open(w, { channel: { id: THREAD, type: 11, parent_id: FORUM } });
		expect(thread.body.data.components).toHaveLength(2);
		const priv = await open(w, { channel: { id: THREAD, type: 12, parent_id: FORUM } });
		expect(priv.body.data.components).toHaveLength(2);
		// Same thread, parent not mapped: the project is asked for.
		const orphan = await open(w, { channel: { id: THREAD, type: 11, parent_id: UNMAPPED } });
		expect(orphan.body.data.components).toHaveLength(3);
		const noParent = await open(w, { channel: { id: THREAD, type: 11 } });
		expect(noParent.body.data.components).toHaveLength(3);
		// A text channel's parent_id (a category) is not a route.
		const text = await open(w, { channel: { id: UNMAPPED, type: 0, parent_id: MAPPED } });
		expect(text.body.data.components).toHaveLength(3);
	});

	test('сообщение в треде: публичный ответ уходит в тред, а проект берётся по форуму', async () => {
		const w = await setup();
		const { customId } = await open(w, { channel: { id: THREAD, type: 11, parent_id: FORUM } });
		await submitCreate(w, customId, { title: 'Из треда' });
		await w.settle();
		expect(w.plane.createdItems[0]?.projectId).toBe(P_ENG);
		expect(w.discord.callsOf('sendMessage')[0]?.[0]).toBe(THREAD);
	});

	test('первая строка 300 символов → value 255; текст 5000 → 4000; эмодзи на границе целый', async () => {
		const w = await setup();
		const long = await open(w, {
			message: msg({ content: `${'а'.repeat(300)}\n${'б'.repeat(5000)}` }),
		});
		expect(Array.from(field(long.body, 'title').value)).toHaveLength(255);
		expect(field(long.body, 'title').value.endsWith('…')).toBe(true);
		expect(Array.from(field(long.body, 'description').value)).toHaveLength(4000);

		// 253 letters + a surrogate pair: the cut lands next to the pair and must not split it.
		for (const letters of [252, 253, 254, 255]) {
			const emoji = await open(w, {
				message: msg({ content: `${'a'.repeat(letters)}😀${'b'.repeat(40)}` }),
			});
			const value = field(emoji.body, 'title').value as string;
			expect(hasLoneSurrogate(value)).toBe(false);
			expect(value.length).toBeLessThanOrEqual(255);
			expect(value.endsWith('…')).toBe(true);
		}
		const roomy = await open(w, {
			message: msg({ content: `${'a'.repeat(10)}😀${'b'.repeat(400)}` }),
		});
		expect((field(roomy.body, 'title').value as string).includes('😀')).toBe(true);

		const emojiBody = await open(w, { message: msg({ content: `x\n${'😀'.repeat(4001)}` }) });
		const desc = field(emojiBody.body, 'description').value as string;
		expect(hasLoneSurrogate(desc)).toBe(false);
		expect(desc.length).toBeLessThanOrEqual(4000);
	});

	test('сообщение без текста с вложением → у названия нет value; после отправки в описании ссылка на вложение', async () => {
		const w = await setup();
		const { customId, body } = await open(w, {
			message: msg({
				content: '',
				attachments: [
					{ url: 'https://cdn.example.com/a/shot.png', filename: 'shot<1>.png' },
					{ url: 'javascript:alert(1)', filename: 'evil' },
					{ url: 'https://cdn.example.com/b/log.txt' },
				],
			}),
		});
		expect(field(body, 'title')).not.toHaveProperty('value');
		expect(field(body, 'title').required).toBe(true);
		expect(field(body, 'description')).not.toHaveProperty('value');
		await submitCreate(w, customId, { title: 'Скриншот', description: '' });
		await w.settle();
		const html = w.plane.createdItems[0]?.item.description_html ?? '';
		expect(html).toContain(
			'<ul><li><a href="https://cdn.example.com/a/shot.png">shot&lt;1&gt;.png</a></li>',
		);
		expect(html).toContain('<li><a href="https://cdn.example.com/b/log.txt">файл</a></li></ul>');
		expect(html).not.toContain('javascript');
		expect(html).not.toContain('evil');
	});

	test('message без текста и без вложений, стикер: ничего не падает, название пустое', async () => {
		const w = await setup();
		for (const content of [undefined, null, 42, '   \n  ']) {
			const { body } = await open(w, { message: msg({ content, attachments: undefined }) });
			expect(body.type).toBe(9);
			expect(field(body, 'title')).not.toHaveProperty('value');
		}
	});
});

describe('createInteractionHandler: отправка формы «создать»', () => {
	test('отправка → deferred ephemeral; задача с external_source discord и external_id = id сообщения; в описании «Из Discord» и автор', async () => {
		const w = await setup();
		const { customId } = await open(w);
		const res = await submitCreate(w, customId, {
			title: 'Починить вход',
			description: 'Подробности <b>ниже</b>',
		});
		expect(res.body).toEqual({ type: 5, data: { flags: 64 } });
		await w.settle();
		expect(w.plane.createdItems).toHaveLength(1);
		const created = w.plane.createdItems[0]!;
		expect(created.projectId).toBe(P_LAB);
		expect(created.item.name).toBe('Починить вход');
		expect(created.item.external_source).toBe('discord');
		expect(created.item.external_id).toBe(MSG);
		const html = created.item.description_html;
		expect(html).toContain('<p>Подробности &lt;b&gt;ниже&lt;/b&gt;</p>');
		expect(html).toContain(
			`<p>Из Discord: <a href="https://discord.com/channels/${GUILD}/${MAPPED}/${MSG}">сообщение</a> · автор: Мира</p>`,
		);
		expect(w.store.getDiscordItem('initech', MSG)).toEqual({
			projectId: P_LAB,
			workItemId: created.id,
		});
	});

	test('публичный ответ — reply на исходное сообщение «→ `LAB-1` «Название»», ephemeral удалён', async () => {
		const w = await setup();
		const { customId } = await open(w);
		await submitCreate(w, customId, { title: 'Починить вход' });
		await w.settle();
		const sends = w.discord.callsOf('sendMessage');
		expect(sends).toEqual([
			[
				MAPPED,
				{
					content:
						'→ [`LAB-1` «Починить вход»](<https://plane.example.com/example-ws/browse/LAB-1/>)',
					replyTo: MSG,
				},
			],
		]);
		expect(w.discord.callsOf('deleteOriginal')).toHaveLength(1);
		expect(w.discord.callsOf('editOriginal')).toEqual([]);
		// Order: the public message first, then the cleanup.
		const order = w.discord.calls.map((c) => c.method);
		expect(order).toEqual(['sendMessage', 'deleteOriginal']);
	});

	test('название с разметкой и пробелами: метка ссылки экранирована, пробелы схлопнуты', async () => {
		const w = await setup();
		const { customId } = await open(w);
		await submitCreate(w, customId, { title: '  a](<https://evil.example>)\n`b` *c*  ' });
		await w.settle();
		const content = (w.discord.callsOf('sendMessage')[0]?.[1] as { content: string }).content;
		expect(content).toBe(
			'→ [`LAB-1` «a\\](\\<https://evil.example\\>) \\`b\\` \\*c\\*»](<https://plane.example.com/example-ws/browse/LAB-1/>)',
		);
		expect(w.plane.createdItems[0]?.item.name).toBe('a](<https://evil.example>) `b` *c*');
	});

	test('несопоставленный канал: проект из select уходит в Plane; чужое значение и скрытый проект — отказ', async () => {
		const w = await setup();
		const first = await open(w, { channel: { id: UNMAPPED, type: 0 } });
		await submitCreate(w, first.customId, { title: 'T' }, { project: [P_ENG] });
		await w.settle();
		expect(w.plane.createdItems.map((c) => c.projectId)).toEqual([P_ENG]);

		const edits = () =>
			w.discord.callsOf('editOriginal').map((c) => (c[1] as { content: string }).content);
		const hidden = await open(w, {
			channel: { id: UNMAPPED, type: 0 },
			message: msg({ id: '444444444444444442' }),
		});
		await submitCreate(w, hidden.customId, { title: 'T' }, { project: [P_HIDDEN] });
		const foreign = await open(w, {
			channel: { id: UNMAPPED, type: 0 },
			message: msg({ id: '444444444444444443' }),
		});
		await submitCreate(
			w,
			foreign.customId,
			{ title: 'T' },
			{ project: ['00000000-0000-4000-8000-0000000000ff'] },
		);
		const none = await open(w, {
			channel: { id: UNMAPPED, type: 0 },
			message: msg({ id: '444444444444444444' }),
		});
		await submitCreate(w, none.customId, { title: 'T' });
		await w.settle();
		expect(w.plane.createdItems).toHaveLength(1);
		expect(edits()).toEqual([
			'Этого проекта нет в списке, вызови команду ещё раз.',
			'Этого проекта нет в списке, вызови команду ещё раз.',
			'Проект не выбран.',
		]);
	});

	test('пустое название в отправке → «Название обязательно», задачи нет', async () => {
		const w = await setup();
		const { customId } = await open(w);
		await submitCreate(w, customId, { title: ' \n ' });
		await w.settle();
		expect(w.plane.createdItems).toEqual([]);
		expect(w.discord.callsOf('editOriginal')[0]?.[1]).toEqual({ content: 'Название обязательно.' });
	});

	test('название 400 символов в отправке режется до 255, описание — до 4000', async () => {
		const w = await setup();
		const { customId } = await open(w);
		await submitCreate(w, customId, { title: 'я'.repeat(400), description: 'ы'.repeat(6000) });
		await w.settle();
		const item = w.plane.createdItems[0]!.item;
		expect(Array.from(item.name)).toHaveLength(255);
		expect(item.description_html).toContain(`<p>${'ы'.repeat(3999)}…</p>`);
	});

	test('повтор по тому же сообщению (store; затем только Plane external_id) → второй задачи нет, ссылка на первую', async () => {
		const w = await setup();
		const first = await open(w);
		await submitCreate(w, first.customId, { title: 'Починить вход' });
		await w.settle();
		const again = await open(w);
		await submitCreate(w, again.customId, { title: 'Другое название' });
		await w.settle();
		expect(w.plane.createdItems).toHaveLength(1);
		expect(w.discord.callsOf('sendMessage')).toHaveLength(1);
		const edit = w.discord.callsOf('editOriginal').at(-1)?.[1] as { content: string };
		expect(edit.content).toBe(
			'Уже есть: [`LAB-1`](<https://plane.example.com/example-ws/browse/LAB-1/>) «Починить вход»',
		);

		// A fresh store (lost volume): Plane's own external_id is the second line of defence.
		const fresh = await setup({ store: new Store(':memory:') });
		fresh.plane.items = w.plane.items;
		const third = await open(fresh);
		await submitCreate(fresh, third.customId, { title: 'Ещё' });
		await fresh.settle();
		expect(fresh.plane.createdItems).toEqual([]);
		expect(fresh.discord.callsOf('sendMessage')).toEqual([]);
		expect(
			(fresh.discord.callsOf('editOriginal')[0]?.[1] as { content: string }).content,
		).toContain('Уже есть:');
		expect(fresh.store.getDiscordItem('initech', MSG)?.workItemId).toBe([...w.plane.items.keys()][0]!);
	});

	test('задача из store удалена в Plane (404) → создаётся заново', async () => {
		const w = await setup();
		w.store.putDiscordItem('initech', MSG, P_LAB, 'gone');
		const real = w.plane.getWorkItem.bind(w.plane);
		w.plane.getWorkItem = async (projectId, id) => {
			if (id === 'gone') throw new PlaneApiError(404, 'GET', '/work-items/gone/');
			return real(projectId, id);
		};
		const { customId } = await open(w);
		await submitCreate(w, customId, { title: 'Заново' });
		await w.settle();
		expect(w.plane.createdItems).toHaveLength(1);
		expect(w.store.getDiscordItem('initech', MSG)?.workItemId).toBe(w.plane.createdItems[0]!.id);
	});

	test('getWorkItem не 404 для записи из store → «не получилось», задачи нет', async () => {
		const w = await setup();
		w.store.putDiscordItem('initech', MSG, P_LAB, 'broken');
		w.plane.getWorkItem = async () => {
			throw new PlaneApiError(500, 'GET', '/work-items/broken/');
		};
		const { customId } = await open(w);
		await submitCreate(w, customId, { title: 'X' });
		await w.settle();
		expect(w.plane.createdItems).toEqual([]);
		expect(w.discord.callsOf('editOriginal')[0]?.[1]).toEqual({
			content: 'Не получилось: Plane ответил 500.',
		});
	});

	test('нет прав писать в канал (403) → ephemeral со ссылкой; другая ошибка Discord — со статусом', async () => {
		const w = await setup();
		w.discord.failures.set(
			'sendMessage',
			new DiscordApiError(403, 'POST', '/channels/:id/messages', 50013),
		);
		const { customId } = await open(w);
		await submitCreate(w, customId, { title: 'Починить вход' });
		await w.settle();
		expect(w.plane.createdItems).toHaveLength(1);
		expect(w.discord.callsOf('editOriginal')[0]?.[1]).toEqual({
			content:
				'Задача создана: [`LAB-1`](<https://plane.example.com/example-ws/browse/LAB-1/>) «Починить вход» — нет прав писать в канал.',
		});
		expect(w.discord.callsOf('deleteOriginal')).toEqual([]);

		const other = await setup();
		other.discord.failures.set(
			'sendMessage',
			new DiscordApiError(500, 'POST', '/channels/:id/messages'),
		);
		const again = await open(other);
		await submitCreate(other, again.customId, { title: 'Починить вход' });
		await other.settle();
		expect(
			(other.discord.callsOf('editOriginal')[0]?.[1] as { content: string }).content,
		).toEndWith('— Discord ответил 500.');
	});

	test('deleteOriginal не удался → публичный ответ уже есть, в лог warn, без «не получилось»', async () => {
		const w = await setup();
		w.discord.failures.set(
			'deleteOriginal',
			new DiscordApiError(404, 'DELETE', '/webhooks/:app/:token/messages/@original'),
		);
		const { customId } = await open(w);
		await submitCreate(w, customId, { title: 'Починить вход' });
		await w.settle();
		expect(w.discord.callsOf('sendMessage')).toHaveLength(1);
		expect(w.discord.callsOf('editOriginal')).toEqual([]);
		expect(w.logs).toContainEqual({ event: 'ix.cleanup_failed', level: 'warn', tenant: 'initech' });
		expect(w.logs.map((l) => l.event)).toContain('ix.done');
	});

	test('Plane упал → «Не получилось: Plane ответил 502», лог ix.failed без текстов', async () => {
		const w = await setup();
		w.plane.createWorkItem = async () => {
			throw new PlaneApiError(502, 'POST', `/projects/${P_LAB}/work-items/`);
		};
		const { customId } = await open(w, { message: msg({ content: SECRET_TEXT }) });
		await submitCreate(w, customId, { title: SECRET_TEXT, description: SECRET_TEXT });
		await w.settle();
		expect(w.discord.callsOf('editOriginal')[0]).toEqual([
			expect.stringMatching(/^tok-/),
			{ content: 'Не получилось: Plane ответил 502.' },
		]);
		const failed = w.logs.find((l) => l.event === 'ix.failed')!;
		expect(failed).toMatchObject({
			level: 'error',
			tenant: 'initech',
			kind: 'create',
			status: 502,
			error: 'PlaneApiError',
		});
		expect(JSON.stringify(w.logs)).not.toContain(SECRET_TEXT);
	});

	test('падение не-Plane, не-Discord → «внутренняя ошибка»; и editOriginal упал → ix.reply_failed', async () => {
		const w = await setup();
		w.plane.createWorkItem = async () => {
			throw new TypeError('boom with secret text');
		};
		const { customId } = await open(w);
		await submitCreate(w, customId, { title: 'X' });
		await w.settle();
		expect(w.discord.callsOf('editOriginal')[0]?.[1]).toEqual({
			content: 'Не получилось: внутренняя ошибка.',
		});
		expect(JSON.stringify(w.logs)).not.toContain('secret text');

		const broken = await setup();
		broken.plane.createWorkItem = async () => {
			throw new PlaneApiError(500, 'POST', '/x');
		};
		broken.discord.failures.set(
			'editOriginal',
			new DiscordApiError(0, 'PATCH', '/webhooks/:app/:token/messages/@original'),
		);
		const again = await open(broken);
		await submitCreate(broken, again.customId, { title: 'X' });
		await broken.settle();
		expect(broken.logs.map((l) => l.event)).toContain('ix.reply_failed');
	});

	test('проект исчез из Plane между формой и отправкой → «проект не найден в Plane»', async () => {
		const w = await setup();
		const { customId } = await open(w);
		w.plane.projects = [ENG];
		await submitCreate(w, customId, { title: 'X' });
		await w.settle();
		expect(w.discord.callsOf('editOriginal')[0]?.[1]).toEqual({
			content: 'Не получилось: проект не найден в Plane.',
		});
	});

	test('автор из таблицы → упоминание Plane; не из таблицы → экранированное имя', async () => {
		const w = await setup();
		const linked = await open(w, {
			message: msg({
				author: { id: LINKED, username: 'mira', global_name: 'Мира' },
				content: `привет <@${LINKED}> и <@${AUTHOR}> и <@999999999999999999>`,
				mentions: [
					{ id: LINKED, username: 'l', global_name: 'Линк' },
					{ id: AUTHOR, username: 'a<script>', global_name: null },
				],
			}),
		});
		await submitCreate(w, linked.customId, {
			title: 'T',
			description: `привет <@${LINKED}> и <@${AUTHOR}> и <@999999999999999999>`,
		});
		await w.settle();
		const html = w.plane.createdItems[0]!.item.description_html;
		expect(html).toContain('entity_identifier="plane-user-1" entity_name="user_mention"');
		expect(html).toContain('и a&lt;script&gt; и пользователь</p>');
		expect(html).toContain('автор: <mention-component');
		expect(html).not.toContain('<script>');

		const plain = await setup();
		const other = await open(plain, {
			message: msg({ author: { id: AUTHOR, username: 'x<i>y', global_name: null } }),
		});
		await submitCreate(plain, other.customId, { title: 'T' });
		await plain.settle();
		expect(plain.plane.createdItems[0]!.item.description_html).toContain('автор: x&lt;i&gt;y</p>');
	});

	test('контекст формы истёк → ephemeral «форма устарела»; чужой custom_id и повторная отправка — тоже', async () => {
		const w = await setup();
		const { customId } = await open(w);
		w.advance(15 * 60_000 + 1);
		const late = await submitCreate(w, customId, { title: 'X' });
		expect(late.body.type).toBe(4);
		expect(late.body.data.content).toBe('Форма устарела, вызови команду ещё раз.');

		const live = await open(w);
		const ok = await submitCreate(w, live.customId, { title: 'X' });
		expect(ok.body.type).toBe(5);
		const twice = await submitCreate(w, live.customId, { title: 'X' });
		expect(twice.body.data.content).toBe('Форма устарела, вызови команду ещё раз.');
		for (const customId of [
			'create:nope',
			'append:' + live.customId.slice(7),
			'create:',
			'',
			'other:n1',
			42,
			null,
		]) {
			const res = await w.ask({
				...submitPayload({ id: w.ids.next(), guildId: GUILD, customId: 'x' }),
				data: { custom_id: customId, components: [] },
			});
			expect(res.body.data.content).toBe('Форма устарела, вызови команду ещё раз.');
		}
		await w.settle();
		expect(w.plane.createdItems).toHaveLength(1);
	});

	test('форма «создать» не принимается как «добавить» и наоборот', async () => {
		const w = await setup();
		const create = await open(w);
		const nonce = create.customId.split(':')[1];
		const res = await submitCreate(w, `append:${nonce}`, { key: 'LAB-1' });
		expect(res.body.data.content).toBe('Форма устарела, вызови команду ещё раз.');
	});

	test('форма без token не откладывается', async () => {
		const w = await setup();
		const { customId } = await open(w);
		const res = await w.ask({
			...submitPayload({ id: w.ids.next(), guildId: GUILD, customId, texts: { title: 'X' } }),
			token: undefined,
		});
		expect(res.body.data.content).toBe('Форма устарела, вызови команду ещё раз.');
		await w.settle();
		expect(w.plane.createdItems).toEqual([]);
	});

	test('больше 1000 открытых форм → самая старая забыта, новая жива', async () => {
		const w = await setup();
		const first = await open(w);
		for (let i = 0; i < 1000; i++) await open(w);
		const last = await open(w);
		expect((await submitCreate(w, first.customId, { title: 'X' })).body.data.content).toBe(
			'Форма устарела, вызови команду ещё раз.',
		);
		expect((await submitCreate(w, last.customId, { title: 'X' })).body.type).toBe(5);
	});

	test('просроченные формы вытесняются при открытии новой', async () => {
		const w = await setup();
		const old = await open(w);
		w.advance(15 * 60_000 + 1);
		await open(w);
		// A fresh form is accepted; the stale one is gone either way.
		expect((await submitCreate(w, old.customId, { title: 'X' })).body.data.content).toBe(
			'Форма устарела, вызови команду ещё раз.',
		);
	});

	test('без defer в зависимостях работа всё равно выполняется (прод: fire and log)', async () => {
		const w = await setup({ withDefer: false });
		const { customId } = await open(w);
		const res = await submitCreate(w, customId, { title: 'Починить вход' });
		expect(res.body.type).toBe(5);
		for (let i = 0; i < 200 && w.discord.callsOf('deleteOriginal').length === 0; i++)
			await Promise.resolve();
		expect(w.plane.createdItems).toHaveLength(1);
	});
});

describe('createInteractionHandler: «добавить в задачу»', () => {
	function seed(w: World) {
		w.plane.items.set('w40', {
			id: 'w40',
			projectId: P_LAB,
			sequenceId: 40,
			name: 'Старая задача',
			stateId: '',
			assignees: [],
			priority: 'none',
			descriptionHtml: null,
		});
		w.plane.items.set('w7', {
			id: 'w7',
			projectId: P_HIDDEN,
			sequenceId: 7,
			name: 'Скрытая',
			stateId: '',
			assignees: [],
			priority: 'none',
			descriptionHtml: null,
		});
	}
	const edits = (w: World) =>
		w.discord.callsOf('editOriginal').map((c) => (c[1] as { content: string }).content);

	test('модалка «Комментарий в задачу»: ключ и текст сообщения', async () => {
		const w = await setup();
		const { body } = await open(w, { name: APPEND_COMMAND, channel: { id: UNMAPPED, type: 0 } });
		expect(body.type).toBe(9);
		expect(body.data.custom_id).toBe('append:n1');
		expect(body.data.title).toBe('Комментарий в задачу');
		expect(body.data.components).toHaveLength(2);
		expect(field(body, 'key')).toMatchObject({
			type: 4,
			style: 1,
			max_length: 20,
			required: true,
			placeholder: 'LAB-40',
		});
		expect(field(body, 'text')).toMatchObject({
			style: 2,
			max_length: 4000,
			value: 'Починить вход\nПодробности ниже',
		});
		expect(w.planeCalls).toEqual([]);
	});

	test('текст сообщения 5000 → value 4000; без текста → без value', async () => {
		const w = await setup();
		const long = await open(w, {
			name: APPEND_COMMAND,
			message: msg({ content: 'щ'.repeat(5000) }),
		});
		expect(Array.from(field(long.body, 'text').value)).toHaveLength(4000);
		const empty = await open(w, { name: APPEND_COMMAND, message: msg({ content: '' }) });
		expect(field(empty.body, 'text')).not.toHaveProperty('value');
	});

	test('комментарий с цитатой, автором и ссылкой; повтор в ту же задачу — без второго', async () => {
		const w = await setup();
		seed(w);
		const form = await open(w, {
			name: APPEND_COMMAND,
			message: msg({ attachments: [{ url: 'https://cdn.example.com/f.png', filename: 'f.png' }] }),
		});
		const res = await submitCreate(w, form.customId, {
			key: ' lab-40 ',
			text: 'Цитата <i>1</i>\n\nВторой абзац',
		});
		expect(res.body).toEqual({ type: 5, data: { flags: 64 } });
		await w.settle();
		expect(w.plane.createdComments).toHaveLength(1);
		const created = w.plane.createdComments[0]!;
		expect(created).toMatchObject({ projectId: P_LAB, workItemId: 'w40' });
		expect(created.comment.external_source).toBe('discord');
		expect(created.comment.external_id).toBe(MSG);
		expect(created.comment.comment_html).toBe(
			'<blockquote><p>Цитата &lt;i&gt;1&lt;/i&gt;</p><p>Второй абзац</p></blockquote>' +
				`<p>— Мира, <a href="https://discord.com/channels/${GUILD}/${MAPPED}/${MSG}">сообщение в Discord</a></p>` +
				'<ul><li><a href="https://cdn.example.com/f.png">f.png</a></li></ul>',
		);
		expect(edits(w)).toEqual([
			'→ комментарий в [`LAB-40`](<https://plane.example.com/example-ws/browse/LAB-40/>)',
		]);

		const again = await open(w, { name: APPEND_COMMAND });
		await submitCreate(w, again.customId, { key: 'LAB-40', text: 'ещё раз' });
		await w.settle();
		expect(w.plane.createdComments).toHaveLength(1);
		expect(edits(w).at(-1)).toBe(
			'Уже добавлено: [`LAB-40`](<https://plane.example.com/example-ws/browse/LAB-40/>)',
		);
	});

	test('сообщение только с вложением: комментарий без цитаты', async () => {
		const w = await setup();
		seed(w);
		const form = await open(w, { name: APPEND_COMMAND, message: msg({ content: '' }) });
		await submitCreate(w, form.customId, { key: 'LAB-40', text: '   ' });
		await w.settle();
		expect(w.plane.createdComments[0]!.comment.comment_html).toBe(
			`<p>— Мира, <a href="https://discord.com/channels/${GUILD}/${MAPPED}/${MSG}">сообщение в Discord</a></p>`,
		);
	});

	test('добавить в задачу: неверный ключ; несуществующая задача → ephemeral ошибка', async () => {
		const w = await setup();
		seed(w);
		const keys = [
			'',
			'LAB',
			'lab40',
			'40',
			'LAB-40; DROP',
			'A'.repeat(30) + '-1',
			'1A-1',
			'LAB-4x',
		];
		for (const key of keys) {
			const form = await open(w, { name: APPEND_COMMAND, message: msg({ id: w.ids.next() }) });
			await submitCreate(w, form.customId, { key, text: 'x' });
		}
		await w.settle();
		expect(edits(w)).toEqual(keys.map(() => 'Нужен ключ вида LAB-40.'));
		expect(w.planeCalls.filter((c) => c === 'getWorkItemByKey')).toEqual([]);

		const missing = await open(w, { name: APPEND_COMMAND });
		await submitCreate(w, missing.customId, { key: 'LAB-999', text: 'x' });
		await w.settle();
		expect(edits(w).at(-1)).toBe('Задача LAB-999 не найдена.');
		expect(w.plane.createdComments).toEqual([]);
	});

	test('задача скрытого проекта отвечает как несуществующая, комментария нет', async () => {
		const w = await setup();
		seed(w);
		const form = await open(w, { name: APPEND_COMMAND });
		await submitCreate(w, form.customId, { key: 'ZEN-7', text: 'x' });
		await w.settle();
		expect(edits(w)).toEqual(['Задача ZEN-7 не найдена.']);
		expect(w.plane.createdComments).toEqual([]);
		expect(w.planeCalls).not.toContain('findCommentByExternalId');
		expect(w.planeCalls).not.toContain('createComment');
	});

	test('Plane упал на комментарии → «Не получилось: Plane ответил 500»', async () => {
		const w = await setup();
		seed(w);
		w.plane.createComment = async () => {
			throw new PlaneApiError(500, 'POST', '/comments/');
		};
		const form = await open(w, { name: APPEND_COMMAND });
		await submitCreate(w, form.customId, { key: 'LAB-40', text: SECRET_TEXT });
		await w.settle();
		expect(edits(w)).toEqual(['Не получилось: Plane ответил 500.']);
		expect(w.logs.find((l) => l.event === 'ix.failed')).toMatchObject({
			kind: 'append',
			status: 500,
		});
		expect(JSON.stringify(w.logs)).not.toContain(SECRET_TEXT);
	});
});

describe('createInteractionHandler: враждебный ввод', () => {
	test('поля неверных типов, пустые, огромные — обработчик отвечает, не падает', async () => {
		const w = await setup();
		const huge = 'z'.repeat(200_000);
		const BROKEN = 'Не удалось разобрать запрос Discord.';
		const UNKNOWN = 'Неизвестная команда.';
		const NO_MESSAGE = 'Не удалось прочитать сообщение.';
		const NO_CHANNEL = 'Не удалось определить канал.';
		const EXPIRED = 'Форма устарела, вызови команду ещё раз.';
		const command = (data: unknown, extra: Record<string, unknown> = {}) => ({
			type: 2,
			id: w.ids.next(),
			guild_id: GUILD,
			channel: { id: MAPPED, type: 0 },
			data,
			...extra,
		});
		const target = (over: Record<string, unknown>) => ({
			type: 3,
			name: CREATE_COMMAND,
			target_id: MSG,
			resolved: { messages: { [MSG]: { id: MSG } } },
			...over,
		});
		const bad: Array<[unknown, string]> = [
			[{}, BROKEN],
			[{ type: 'x' }, BROKEN],
			[{ type: 2 }, BROKEN],
			[{ type: 2, id: 5 }, BROKEN],
			[{ type: 2, id: 'abc' }, BROKEN],
			[{ type: 2, id: '1'.repeat(40) }, BROKEN],
			[command(null), UNKNOWN],
			[command(undefined), UNKNOWN],
			[command([]), UNKNOWN],
			[command(target({ type: 2 })), UNKNOWN],
			[command(target({ type: '3' })), UNKNOWN],
			[command(target({ name: 'другая' })), UNKNOWN],
			[command(target({ name: 5 })), UNKNOWN],
			[command(target({ target_id: undefined })), NO_MESSAGE],
			[command(target({ target_id: 5 })), NO_MESSAGE],
			[command(target({ target_id: '__proto__', resolved: { messages: {} } })), NO_MESSAGE],
			[command(target({ target_id: 'constructor', resolved: { messages: {} } })), NO_MESSAGE],
			[command(target({ resolved: 'x' })), NO_MESSAGE],
			[command(target({ resolved: { messages: [] } })), NO_MESSAGE],
			[command(target({ resolved: { messages: { [MSG]: 'str' } } })), NO_MESSAGE],
			[command(target({ resolved: { messages: { [MSG]: { id: 5 } } } })), NO_MESSAGE],
			[
				command(target({ resolved: { messages: { [MSG]: { id: 'not-a-snowflake' } } } })),
				NO_MESSAGE,
			],
			[command(target({}), { channel: 'x' }), NO_CHANNEL],
			[command(target({}), { channel: { id: 'abc' } }), NO_CHANNEL],
			[command(target({}), { channel: undefined }), NO_CHANNEL],
			[command(target({}), { guild_id: 7 }), 'Этот сервер не настроен.'],
			[command(target({}), { type: 3 }), UNKNOWN],
			[{ type: 5, id: w.ids.next(), guild_id: GUILD, data: 'x' }, EXPIRED],
			[
				{
					type: 5,
					id: w.ids.next(),
					guild_id: GUILD,
					data: { custom_id: 'create:n1', components: 'x' },
				},
				EXPIRED,
			],
		];
		for (const [payload, content] of bad) {
			const res = await w.ask(payload);
			expect([res.status, res.body.type, res.body.data.content]).toEqual([200, 4, content]);
		}
		// The tolerant ones with a channel still open a modal even when every optional field is garbage.
		const sloppy = commandPayload({
			id: w.ids.next(),
			guildId: GUILD,
			channel: { id: MAPPED, type: 'x', parent_id: 5 },
			name: CREATE_COMMAND,
			message: msg({
				content: huge,
				author: 'nobody',
				attachments: [
					null,
					5,
					{ url: 5 },
					{ url: 'https://cdn.example.com/x' },
					...Array.from({ length: 50 }, () => ({
						url: 'https://cdn.example.com/y',
						filename: 'f'.repeat(1000),
					})),
				],
				mentions: [
					null,
					{ id: 5 },
					{ id: '123456789012345678' },
					...Array.from({ length: 5000 }, () => ({
						id: '123456789012345679',
						username: 'm'.repeat(300),
					})),
				],
			}),
		});
		const res = await w.ask(sloppy);
		expect(res.body.type).toBe(9);
		expect(Array.from(field(res.body, 'description').value)).toHaveLength(4000);
		const { customId } = { customId: res.body.data.custom_id as string };
		await submitCreate(w, customId, { title: 'T' });
		await w.settle();
		const html = w.plane.createdItems[0]!.item.description_html;
		expect(html.match(/<li>/g)).toHaveLength(10);
		expect(html).toContain(`автор: неизвестный</p>`);
		expect(html.includes('f'.repeat(201))).toBe(false);
	});

	test('компоненты отправки: пропуски, не-строки, вложенность и лишние поля не ломают разбор', async () => {
		const w = await setup();
		const { customId } = await open(w);
		const nest = (depth: number, leaf: unknown): unknown =>
			depth === 0 ? leaf : { type: 1, components: [nest(depth - 1, leaf)] };
		const payload = {
			...submitPayload({ id: w.ids.next(), guildId: GUILD, customId }),
			data: {
				custom_id: customId,
				components: [
					null,
					5,
					'x',
					{ custom_id: 5, value: 'нет' },
					{ type: 18, component: { custom_id: 'title', value: 7 } },
					{ type: 1, components: [{ type: 4, custom_id: 'title', value: 'из ActionRow' }] },
					// Too deep to be a real modal: ignored rather than followed (it comes last, so it would win).
					nest(10, { custom_id: 'title', value: 'глубоко' }),
				],
			},
		};
		const res = await w.ask(payload);
		expect(res.body.type).toBe(5);
		await w.settle();
		expect(w.plane.createdItems[0]?.item.name).toBe('из ActionRow');
	});

	test('select без значений и с не-строкой → «Проект не выбран»', async () => {
		const w = await setup();
		for (const values of [[], [5], 'x']) {
			const { customId } = await open(w, {
				channel: { id: UNMAPPED, type: 0 },
				message: msg({ id: w.ids.next() }),
			});
			await w.ask({
				...submitPayload({ id: w.ids.next(), guildId: GUILD, customId }),
				data: {
					custom_id: customId,
					components: [
						{ type: 18, component: { custom_id: 'title', value: 'T' } },
						{ type: 18, component: { custom_id: 'project', values } },
					],
				},
			});
		}
		await w.settle();
		expect(w.plane.createdItems).toEqual([]);
		expect(
			w.discord.callsOf('editOriginal').map((c) => (c[1] as { content: string }).content),
		).toEqual(['Проект не выбран.', 'Проект не выбран.', 'Проект не выбран.']);
	});

	test('логи не содержат текстов сообщения; падающий sink не ломает ответ', async () => {
		const w = await setup({ throwingLog: true });
		const { customId, body } = await open(w, { message: msg({ content: SECRET_TEXT }) });
		expect(body.type).toBe(9);
		await submitCreate(w, customId, { title: SECRET_TEXT, description: SECRET_TEXT });
		await w.settle();
		expect(w.plane.createdItems).toHaveLength(1);
		expect(JSON.stringify(w.logs)).not.toContain(SECRET_TEXT);
		const bad = await w.handler(await (await makeSigner()).request('{}'));
		expect(bad.status).toBe(401);
	});

	test('claim бросает → ephemeral «внутренняя ошибка», 200', async () => {
		const w = await setup();
		w.store.claim = () => {
			throw new Error('db locked');
		};
		const res = await w.ask({ type: 2, id: w.ids.next(), guild_id: GUILD });
		expect(res.status).toBe(200);
		expect(res.body.data.content).toBe('Внутренняя ошибка, повтори через минуту.');
		expect(w.logs.find((l) => l.event === 'ix.failed')).toMatchObject({ error: 'handler' });
	});
});

describe('createInteractionHandler: ветви, которые легко потерять', () => {
	const EXPIRED = 'Форма устарела, вызови команду ещё раз.';
	const edits = (w: World) =>
		w.discord.callsOf('editOriginal').map((c) => (c[1] as { content: string }).content);
	const seedLab = (w: World) =>
		w.plane.items.set('w40', {
			id: 'w40',
			projectId: P_LAB,
			sequenceId: 40,
			name: 'Старая задача',
			stateId: '',
			assignees: [],
			priority: 'none',
			descriptionHtml: null,
		});

	test('подписи и признаки полей обеих модалок', async () => {
		const w = await setup();
		const create = await open(w, { channel: { id: UNMAPPED, type: 0 } });
		expect(create.body.data.components.map((c: any) => c.label)).toEqual([
			'Название',
			'Описание',
			'Проект',
		]);
		const append = await open(w, { name: APPEND_COMMAND });
		expect(append.body.data.components.map((c: any) => c.label)).toEqual(['Ключ задачи', 'Текст']);
		expect(field(append.body, 'key').required).toBe(true);
		expect(field(append.body, 'text').required).toBe(false);
	});

	test('имя автора: пустой global_name уступает username', async () => {
		const w = await setup();
		const { customId } = await open(w, {
			message: msg({ author: { id: AUTHOR, username: 'mira', global_name: '' } }),
		});
		await submitCreate(w, customId, { title: 'T' });
		await w.settle();
		expect(w.plane.createdItems[0]!.item.description_html).toContain('автор: mira</p>');
	});

	test('канал берётся из channel_id, когда объекта channel нет', async () => {
		const w = await setup();
		const payload = {
			...commandPayload({
				id: w.ids.next(),
				guildId: GUILD,
				channel: {},
				name: CREATE_COMMAND,
				message: msg(),
			}),
			channel: undefined,
			channel_id: MAPPED,
		};
		const res = await w.ask(payload);
		expect(res.body.type).toBe(9);
		expect(res.body.data.components).toHaveLength(2);
	});

	test('без now и nonce в зависимостях: nonce — UUID, время настоящее, форма работает', async () => {
		const w = await setup({ realClockAndNonce: true });
		const { customId } = await open(w);
		expect(customId).toMatch(
			/^create:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		const other = await open(w, { message: msg({ id: '444444444444444449' }) });
		expect(other.customId).not.toBe(customId);
		expect((await submitCreate(w, customId, { title: 'T' })).body.type).toBe(5);
		await w.settle();
		expect(w.plane.createdItems).toHaveLength(1);
	});

	test('новая форма не стирает живые старые', async () => {
		const w = await setup();
		const first = await open(w);
		await open(w, { message: msg({ id: '444444444444444446' }) });
		await open(w, { message: msg({ id: '444444444444444447' }) });
		expect((await submitCreate(w, first.customId, { title: 'T' })).body.type).toBe(5);
	});

	test('форма живёт ровно 15 минут: за миллисекунду до — жива, ровно в срок — устарела', async () => {
		const w = await setup();
		const alive = await open(w);
		const dead = await open(w, { message: msg({ id: '444444444444444446' }) });
		w.advance(15 * 60_000 - 1);
		expect((await submitCreate(w, alive.customId, { title: 'T' })).body.type).toBe(5);
		w.advance(1);
		expect((await submitCreate(w, dead.customId, { title: 'T' })).body.data.content).toBe(EXPIRED);
	});

	test('форма, открытая на одном сервере, не принимается с другого', async () => {
		const w = await setup();
		const { customId } = await open(w);
		const res = await w.ask(
			submitPayload({ id: w.ids.next(), guildId: OTHER_GUILD, customId, texts: { title: 'T' } }),
		);
		expect(res.body.data.content).toBe(EXPIRED);
		await w.settle();
		expect(w.plane.createdItems).toEqual([]);
		// The right server still can.
		expect((await submitCreate(w, customId, { title: 'T' })).body.type).toBe(5);
	});

	test('лог: ix.done с id, тенантом, видом и временем; отклонения — со своей причиной', async () => {
		const w = await setup();
		const { customId } = await open(w);
		const submit = submitPayload({
			id: '777000000000000001',
			guildId: GUILD,
			customId,
			texts: { title: 'T' },
		});
		await w.ask(submit);
		await w.settle();
		expect(w.logs.find((l) => l.event === 'ix.done')).toEqual({
			event: 'ix.done',
			tenant: 'initech',
			interaction: '777000000000000001',
			kind: 'create',
			ms: 0,
		});
		await w.handler(await (await makeSigner()).request('{}'));
		await w.handler(await w.signer.request('nope'));
		await w.ask({ type: 2, id: '777000000000000002', guild_id: NOCONF_GUILD });
		await w.ask(submit);
		expect(w.logs.filter((l) => l.event !== 'ix.done')).toEqual([
			{ event: 'ix.rejected', level: 'warn', reason: 'bad_signature' },
			{ event: 'ix.rejected', level: 'error', reason: 'bad_json' },
			{ event: 'ix.unconfigured', interaction: '777000000000000002' },
			{ event: 'ix.duplicate', interaction: '777000000000000001' },
		]);
	});

	test('лог ix.failed: id взаимодействия, статус Discord-ошибки и время', async () => {
		const w = await setup();
		seedLab(w);
		w.discord.failures.set(
			'editOriginal',
			new DiscordApiError(500, 'PATCH', '/webhooks/:app/:token/messages/@original'),
		);
		const { customId } = await open(w, { name: APPEND_COMMAND });
		await w.ask(
			submitPayload({
				id: '777000000000000003',
				guildId: GUILD,
				customId,
				texts: { key: 'LAB-40', text: 'x' },
			}),
		);
		await w.settle();
		expect(w.logs.find((l) => l.event === 'ix.failed')).toEqual({
			event: 'ix.failed',
			level: 'error',
			tenant: 'initech',
			interaction: '777000000000000003',
			kind: 'append',
			error: 'DiscordApiError',
			status: 500,
			ms: 0,
		});
		expect(w.logs.find((l) => l.event === 'ix.reply_failed')).toMatchObject({
			interaction: '777000000000000003',
		});
	});

	test('в отправке нет полей названия, ключа, текста → понятные ответы, не «внутренняя ошибка»', async () => {
		const w = await setup();
		seedLab(w);
		const noTitle = await open(w);
		await w.ask(submitPayload({ id: w.ids.next(), guildId: GUILD, customId: noTitle.customId }));
		const noKey = await open(w, {
			name: APPEND_COMMAND,
			message: msg({ id: '444444444444444446' }),
		});
		await w.ask(submitPayload({ id: w.ids.next(), guildId: GUILD, customId: noKey.customId }));
		const noText = await open(w, {
			name: APPEND_COMMAND,
			message: msg({ id: '444444444444444447' }),
		});
		await w.ask(
			submitPayload({
				id: w.ids.next(),
				guildId: GUILD,
				customId: noText.customId,
				texts: { key: 'LAB-40' },
			}),
		);
		const noDescription = await open(w, { message: msg({ id: '444444444444444448' }) });
		await w.ask(
			submitPayload({
				id: w.ids.next(),
				guildId: GUILD,
				customId: noDescription.customId,
				texts: { title: 'T' },
			}),
		);
		await w.settle();
		expect(edits(w)).toEqual([
			'Название обязательно.',
			'Нужен ключ вида LAB-40.',
			'→ комментарий в [`LAB-40`](<https://plane.example.com/example-ws/browse/LAB-40/>)',
		]);
		expect(w.plane.createdComments[0]!.comment.comment_html).not.toContain('<blockquote>');
		expect(w.plane.createdItems).toHaveLength(1);
	});

	test('больше 20 полей в отправке: лишние (в том числе нужное) отбрасываются', async () => {
		const w = await setup();
		const { customId } = await open(w);
		const junk = Array.from({ length: 20 }, (_, i) => ({
			type: 18,
			component: { type: 4, custom_id: `junk${i}`, value: 'x' },
		}));
		await w.ask({
			...submitPayload({ id: w.ids.next(), guildId: GUILD, customId }),
			data: {
				custom_id: customId,
				components: [...junk, { type: 18, component: { type: 4, custom_id: 'title', value: 'T' } }],
			},
		});
		await w.settle();
		expect(edits(w)).toEqual(['Название обязательно.']);
	});

	test('проект скрыли между открытием формы и отправкой → отказ', async () => {
		const w = await setup();
		const { customId } = await open(w, { channel: { id: UNMAPPED, type: 0 } });
		w.rt.tenant.hiddenProjects = [P_ENG];
		await submitCreate(w, customId, { title: 'T' }, { project: [P_ENG] });
		await w.settle();
		expect(w.plane.createdItems).toEqual([]);
		expect(edits(w)).toEqual(['Этого проекта нет в списке, вызови команду ещё раз.']);
	});

	test('«добавить в задачу» в канале скрытого проекта открывает модалку: решает ключ, а не канал', async () => {
		const w = await setup();
		w.rt.tenant.hiddenProjects = [P_LAB];
		const { body } = await open(w, { name: APPEND_COMMAND });
		expect(body.type).toBe(9);
	});

	test('не-Plane ошибка со статусом 404 не принимается за «задача удалена»', async () => {
		const w = await setup();
		w.store.putDiscordItem('initech', MSG, P_LAB, 'x');
		w.plane.getWorkItem = async () => {
			throw Object.assign(new Error('not a PlaneApiError'), { status: 404 });
		};
		const { customId } = await open(w);
		await submitCreate(w, customId, { title: 'T' });
		await w.settle();
		expect(w.plane.createdItems).toEqual([]);
		expect(edits(w)).toEqual(['Не получилось: внутренняя ошибка.']);
	});

	test('потерян store: задача найдена поиском по external_id, а не созданием', async () => {
		const w = await setup();
		const first = await open(w);
		await submitCreate(w, first.customId, { title: 'T' });
		await w.settle();
		const fresh = await setup();
		fresh.plane.items = w.plane.items;
		const again = await open(fresh);
		await submitCreate(fresh, again.customId, { title: 'T' });
		await fresh.settle();
		expect(fresh.planeCalls).toContain('findWorkItemByExternalId');
		expect(fresh.planeCalls).not.toContain('createWorkItem');
	});

	test('sendMessage упал не Discord-ошибкой → «внутренняя ошибка», задача при этом создана', async () => {
		const w = await setup();
		w.discord.sendMessage = async () => {
			throw new TypeError('boom');
		};
		const { customId } = await open(w);
		await submitCreate(w, customId, { title: 'T' });
		await w.settle();
		expect(w.plane.createdItems).toHaveLength(1);
		expect(edits(w)).toEqual(['Не получилось: внутренняя ошибка.']);
		expect(w.discord.callsOf('deleteOriginal')).toEqual([]);
	});

	test('комментарий: упоминание привязанного пользователя — mention Plane, чужого — имя', async () => {
		const w = await setup();
		seedLab(w);
		const text = `смотри <@${LINKED}> и <@${AUTHOR}>`;
		const { customId } = await open(w, {
			name: APPEND_COMMAND,
			message: msg({
				content: text,
				mentions: [{ id: AUTHOR, username: 'bob<b>', global_name: null }],
			}),
		});
		await submitCreate(w, customId, { key: 'LAB-40', text });
		await w.settle();
		const html = w.plane.createdComments[0]!.comment.comment_html;
		expect(html).toContain('entity_identifier="plane-user-1"');
		expect(html).toContain('и bob&lt;b&gt;</p></blockquote>');
	});
});

describe('createHandler: маршрут /discord/interactions', () => {
	async function serverWith(interactions?: (req: Request) => Promise<Response>) {
		const logs: LogEntry[] = [];
		const handler = createHandler({
			tenantsByWorkspace: new Map(),
			store: new Store(':memory:'),
			enqueue: () => {},
			interactions,
			log: (e) => logs.push(e),
		});
		return { handler, logs };
	}
	const post = (path = '/discord/interactions') =>
		new Request(`http://x.test${path}`, { method: 'POST', body: '{}' });

	test('POST уходит в обработчик interactions; GET → 405; без обработчика → 404', async () => {
		const seen: string[] = [];
		const { handler } = await serverWith(async (req) => {
			seen.push(new URL(req.url).pathname);
			return new Response('handled', { status: 201 });
		});
		const res = await handler(post());
		expect([res.status, await res.text()]).toEqual([201, 'handled']);
		expect(seen).toEqual(['/discord/interactions']);
		expect((await handler(new Request('http://x.test/discord/interactions'))).status).toBe(405);
		expect((await handler(post('/discord/other'))).status).toBe(404);
		expect((await (await serverWith()).handler(post())).status).toBe(404);
	});

	test('обработчик бросил → 500 без текста ошибки, строка в логе', async () => {
		const { handler, logs } = await serverWith(async () => {
			throw new Error('token abc leaked');
		});
		const res = await handler(post());
		expect(res.status).toBe(500);
		expect(await res.text()).not.toContain('abc');
		expect(logs).toEqual([{ event: 'ix.rejected', level: 'error', reason: 'internal' }]);
	});

	test('сквозной путь: настоящий обработчик за сервером отвечает на подписанный PING', async () => {
		const w = await setup();
		const { handler } = await serverWith(w.handler);
		const res = await handler(await w.signer.request(JSON.stringify({ type: 1 })));
		expect(await res.json()).toEqual({ type: 1 });
	});
});
