import { describe, expect, test } from 'bun:test';

import type { Tenant } from '../src/config.ts';
import type { GatewayMessage } from '../src/discord/gateway.ts';
import type { LogEntry } from '../src/log.ts';
import type { TenantRuntime } from '../src/notify.ts';
import { Store } from '../src/store.ts';
import { createThreadSync } from '../src/thread-sync.ts';
import { userMap } from '../src/text.ts';
import { PlaneApiError } from '../src/plane/client.ts';
import { FakePlane } from './fake-plane.ts';

const APP = '999999999999999999';
const GUILD = '111111111111111111';
const THREAD = '222222222222222224';
const PARENT = '222222222222222221';
const MSG = '444444444444444441';
const AUTHOR = '555555555555555551';
const LINKED = '555555555555555552';
const P_LAB = '00000000-0000-4000-8000-0000000000a1';
const P_ENG = '00000000-0000-4000-8000-0000000000a2';
const P_HIDDEN = '00000000-0000-4000-8000-0000000000a3';
const ITEM = '00000000-0000-4000-8000-000000000101';
const PLANE_USER = 'plane-user-1';
const SECRET_TEXT = 'сверхсекретный текст сообщения';

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
	channels: [],
	users: [{ plane: PLANE_USER, discord: LINKED }],
});

const message = (over: Partial<GatewayMessage> = {}): GatewayMessage => ({
	id: MSG,
	channelId: THREAD,
	guildId: GUILD,
	type: 0,
	content: 'Нашёл причину, правка в пути',
	author: { id: AUTHOR, name: 'Мира', bot: false },
	webhookId: null,
	applicationId: null,
	attachments: [],
	mentions: [],
	...over,
});

function setup(opts: { bind?: boolean; projectId?: string | null; itemProject?: string } = {}) {
	const plane = new FakePlane();
	plane.projects = [
		{ id: P_LAB, identifier: 'LAB', name: 'Lab' },
		{ id: P_ENG, identifier: 'ENG', name: 'Eng' },
		{ id: P_HIDDEN, identifier: 'ZEN', name: 'Hidden' },
	];
	plane.items.set(ITEM, {
		id: ITEM,
		projectId: opts.itemProject ?? P_ENG,
		sequenceId: 7,
		name: 'Задача',
		stateId: 's',
		assignees: [],
		priority: 'none',
		descriptionHtml: null,
	});
	const t = tenant();
	const rt: TenantRuntime = {
		tenant: t,
		plane,
		users: userMap(t.users),
		projects: async () => plane.projects,
		states: async () => [],
		members: async () => [],
	};
	const store = new Store(':memory:');
	if (opts.bind !== false)
		store.putThread(
			'initech',
			ITEM,
			PARENT,
			THREAD,
			opts.projectId === undefined ? P_ENG : opts.projectId,
		);
	const logs: LogEntry[] = [];
	const sync = createThreadSync({
		runtimes: new Map([['initech', rt]]),
		store,
		applicationId: APP,
		log: (e) => logs.push(e),
	});
	return { plane, store, sync, logs };
}

describe('createThreadSync', () => {
	test('сообщение в привязанном треде → комментарий «Имя (Discord): …» со ссылкой и external_id', async () => {
		const w = setup();
		await w.sync(message());
		expect(w.plane.createdComments).toHaveLength(1);
		const c = w.plane.createdComments[0]!;
		expect(c.projectId).toBe(P_ENG);
		expect(c.workItemId).toBe(ITEM);
		expect(c.comment.external_source).toBe('discord');
		expect(c.comment.external_id).toBe(MSG);
		expect(c.comment.comment_html).toBe(
			'<p><strong>Мира</strong> (Discord):</p><p>Нашёл причину, правка в пути</p>' +
				`<p><a href="https://discord.com/channels/${GUILD}/${THREAD}/${MSG}">сообщение</a></p>`,
		);
		expect(w.logs.find((l) => l.event === 'sync.done')).toMatchObject({
			tenant: 'initech',
			thread: THREAD,
			message: MSG,
			created: true,
		});
	});

	test('повтор того же сообщения → второго комментария нет', async () => {
		const w = setup();
		await w.sync(message());
		await w.sync(message());
		expect(w.plane.createdComments).toHaveLength(1);
		expect(w.logs.some((l) => l.event === 'sync.duplicate')).toBe(true);
	});

	test('сообщение с нашим application_id, нашего webhook и нашего бота → пропуск', async () => {
		const w = setup();
		w.store.putWebhook(PARENT, '777777777777777771', 'tok');
		await w.sync(message({ id: '1', applicationId: APP }));
		await w.sync(message({ id: '2', webhookId: '777777777777777771' }));
		await w.sync(message({ id: '3', author: { id: APP, name: 'Plane', bot: true } }));
		expect(w.plane.createdComments).toHaveLength(0);
		expect(w.logs).toEqual([]);
	});

	test('чужой webhook в привязанном треде → комментарий', async () => {
		const w = setup();
		w.store.putWebhook(PARENT, '777777777777777771', 'tok');
		await w.sync(
			message({
				webhookId: '777777777777777772',
				author: { id: '888888888888888881', name: 'Grafana', bot: true },
			}),
		);
		expect(w.plane.createdComments).toHaveLength(1);
		expect(w.plane.createdComments[0]!.comment.comment_html).toContain('<strong>Grafana</strong>');
	});

	test('системные сообщения (type 18, 21) → пропуск; ответ (type 19) синхронизируется', async () => {
		const w = setup();
		await w.sync(message({ id: '1', type: 18 }));
		await w.sync(message({ id: '2', type: 21 }));
		expect(w.plane.createdComments).toHaveLength(0);
		await w.sync(message({ id: '3', type: 19 }));
		expect(w.plane.createdComments).toHaveLength(1);
	});

	test('тред без привязки → ничего', async () => {
		const w = setup({ bind: false });
		await w.sync(message());
		expect(w.plane.createdComments).toHaveLength(0);
		expect(w.logs).toEqual([]);
	});

	test('автор из таблицы → упоминание Plane, упоминания в тексте — по таблице или @имя', async () => {
		const w = setup();
		await w.sync(
			message({
				author: { id: LINKED, name: 'Linked', bot: false },
				content: `привет <@${LINKED}> и <@${AUTHOR}>`,
				mentions: [
					{ id: LINKED, name: 'Linked' },
					{ id: AUTHOR, name: 'Мира' },
				],
			}),
		);
		const html = w.plane.createdComments[0]!.comment.comment_html;
		expect(html).toStartWith('<p><strong><mention-component id="');
		const mentions = [...html.matchAll(/entity_identifier="([^"]+)"/g)].map((m) => m[1]);
		expect(mentions).toEqual([PLANE_USER, PLANE_USER]);
		expect(html).toContain(' и Мира');
		expect(html).not.toContain('Linked');
	});

	test('вложения — ссылками, не http — отбрасываются', async () => {
		const w = setup();
		await w.sync(
			message({
				content: '',
				attachments: [
					{ url: 'https://cdn.example.com/a.png?x=1&y=2', filename: 'a<b>.png' },
					{ url: 'javascript:alert(1)', filename: 'evil' },
				],
			}),
		);
		expect(w.plane.createdComments[0]!.comment.comment_html).toBe(
			'<p><strong>Мира</strong> (Discord):</p>' +
				'<ul><li><a href="https://cdn.example.com/a.png?x=1&amp;y=2">a&lt;b&gt;.png</a></li></ul>' +
				`<p><a href="https://discord.com/channels/${GUILD}/${THREAD}/${MSG}">сообщение</a></p>`,
		);
	});

	test('пустой текст без вложений → пропуск и sync.empty без текста', async () => {
		const w = setup();
		await w.sync(message({ content: '  ' }));
		expect(w.plane.createdComments).toHaveLength(0);
		expect(w.logs).toEqual([
			{ event: 'sync.empty', level: 'warn', tenant: 'initech', thread: THREAD, message: MSG },
		]);
	});

	test('строка threads без project_id → проект найден обходом, связь дописана', async () => {
		const w = setup({ projectId: null, itemProject: P_ENG });
		await w.sync(message());
		expect(w.plane.createdComments[0]!.projectId).toBe(P_ENG);
		expect(w.store.findByThread(THREAD)).toEqual({
			tenant: 'initech',
			projectId: P_ENG,
			workItemId: ITEM,
			channelId: PARENT,
		});
	});

	test('строка без project_id и задача нигде не найдена → sync.unresolved', async () => {
		const w = setup({ projectId: null });
		w.plane.items.clear();
		await w.sync(message());
		expect(w.plane.createdComments).toHaveLength(0);
		expect(w.logs).toEqual([
			{
				event: 'sync.unresolved',
				level: 'warn',
				tenant: 'initech',
				thread: THREAD,
				message: MSG,
				item: ITEM,
			},
		]);
		expect(w.store.findByThread(THREAD)?.projectId).toBeNull();
	});

	test('строка без project_id: сбой Plane (не 404) при обходе пробрасывается', async () => {
		const w = setup({ projectId: null });
		w.plane.getWorkItem = async () => {
			throw new PlaneApiError(500, 'GET', '/x/');
		};
		await expect(w.sync(message())).rejects.toThrow(PlaneApiError);
		expect(w.plane.createdComments).toHaveLength(0);
		expect(w.logs).toEqual([]);
	});

	test('длинное имя автора режется; упоминание вне списка mentions → «пользователь»', async () => {
		const w = setup();
		await w.sync(
			message({
				author: { id: AUTHOR, name: 'Я'.repeat(100), bot: false },
				content: `<@${LINKED}x> <@4242>`,
			}),
		);
		const html = w.plane.createdComments[0]!.comment.comment_html;
		expect(html).toStartWith(`<p><strong>${'Я'.repeat(79)}…</strong> (Discord):</p>`);
		expect(html).toContain('пользователь');
	});

	test('сообщение без guild_id → ссылка на сервер тенанта', async () => {
		const w = setup();
		await w.sync(message({ guildId: null }));
		expect(w.plane.createdComments[0]!.comment.comment_html).toContain(
			`https://discord.com/channels/${GUILD}/${THREAD}/${MSG}`,
		);
	});

	test('тенант привязки не настроен → sync.skipped no_tenant', async () => {
		const w = setup();
		w.store.putThread('gone', 'item-x', PARENT, '222222222222222229', P_ENG);
		await w.sync(message({ channelId: '222222222222222229' }));
		expect(w.logs).toEqual([
			{
				event: 'sync.skipped',
				level: 'warn',
				tenant: 'gone',
				thread: '222222222222222229',
				message: MSG,
				reason: 'no_tenant',
			},
		]);
	});

	test('задача скрытого проекта → пропуск без текста в логе', async () => {
		const w = setup({ projectId: P_HIDDEN, itemProject: P_HIDDEN });
		await w.sync(message({ content: SECRET_TEXT }));
		expect(w.plane.createdComments).toHaveLength(0);
		expect(w.logs).toEqual([
			{ event: 'sync.skipped', tenant: 'initech', thread: THREAD, message: MSG, reason: 'hidden' },
		]);
	});

	test('скрытый проект, найденный обходом → тоже пропуск', async () => {
		const w = setup({ projectId: null, itemProject: P_HIDDEN });
		await w.sync(message({ content: SECRET_TEXT }));
		expect(w.plane.createdComments).toHaveLength(0);
		expect(w.logs.map((l) => l.event)).toEqual(['sync.skipped']);
	});

	test('в логах нет текста сообщения', async () => {
		const w = setup();
		await w.sync(message({ content: SECRET_TEXT }));
		expect(JSON.stringify(w.logs)).not.toContain(SECRET_TEXT);
	});

	test('длинный текст режется до 4000 символов', async () => {
		const w = setup();
		await w.sync(message({ content: 'я'.repeat(5000) }));
		const html = w.plane.createdComments[0]!.comment.comment_html;
		expect(html).toContain('я'.repeat(3999) + '…');
		expect(html).not.toContain('я'.repeat(4000));
	});

	test('сбой Plane пробрасывается (очередь повторит)', async () => {
		const w = setup();
		w.plane.createComment = async () => {
			throw new Error('boom');
		};
		await expect(w.sync(message())).rejects.toThrow('boom');
	});
});
