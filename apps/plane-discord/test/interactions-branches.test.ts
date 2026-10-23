import { describe, expect, test } from 'bun:test';

import { APPEND_COMMAND, CREATE_COMMAND } from '../src/discord/commands.ts';
import { createInteractionHandler } from '../src/discord/interactions.ts';
import { DiscordApiError } from '../src/discord/rest.ts';
import { PlaneApiError } from '../src/plane/client.ts';
import { commandPayload, makeSigner, submitPayload } from './discord-harness.ts';
import {
	GUILD,
	OTHER_GUILD,
	NOCONF_GUILD,
	MAPPED,
	UNMAPPED,
	MSG,
	AUTHOR,
	LINKED,
	P_LAB,
	P_ENG,
	LAB,
	tenant,
	msg,
	type World,
	setup,
	open,
	submitCreate,
	field,
} from './interactions-world.ts';

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

describe('createInteractionHandler: границы', () => {
	test('1000 открытых форм живы, на 1001-й самая старая забывается', async () => {
		const w = await setup();
		const first = await open(w);
		for (let i = 1; i < 1000; i++) await open(w);
		expect((await submitCreate(w, first.customId, { title: 'T' })).body.type).toBe(5);

		const x = await setup();
		const old = await open(x);
		for (let i = 1; i < 1000; i++) await open(x);
		await open(x);
		expect((await submitCreate(x, old.customId, { title: 'T' })).body.data.content).toBe(
			'Форма устарела, вызови команду ещё раз.',
		);
	});

	test('упомянутых запоминается 50, имя — 80 символов, имя файла — 200', async () => {
		const w = await setup();
		const id = (n: number) => String(300_000_000_000_000_000n + BigInt(n));
		const mentions = Array.from({ length: 51 }, (_, n) => ({
			id: id(n),
			username: `user${n}`,
			global_name: null,
		}));
		const { customId } = await open(w, {
			message: msg({
				author: { id: AUTHOR, username: 'я'.repeat(81), global_name: null },
				attachments: [{ url: 'https://cdn.example.com/f', filename: 'ф'.repeat(201) }],
				mentions,
			}),
		});
		await submitCreate(w, customId, {
			title: 'T',
			description: `<@${id(49)}> <@${id(50)}>`,
		});
		await w.settle();
		const html = w.plane.createdItems[0]!.item.description_html;
		expect(html).toContain('<p>user49 пользователь</p>');
		expect(html).toContain(`автор: ${'я'.repeat(79)}…</p>`);
		expect(html).toContain(`>${'ф'.repeat(199)}…</a>`);
	});
});
