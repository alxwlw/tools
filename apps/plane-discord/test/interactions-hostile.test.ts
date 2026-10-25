import { describe, expect, test } from 'bun:test';

import { CREATE_COMMAND } from '../src/discord/commands.ts';
import { createInteractionHandler } from '../src/discord/interactions.ts';
import { commandPayload, makeSigner, submitPayload } from './discord-harness.ts';
import {
	GUILD,
	MAPPED,
	UNMAPPED,
	MSG,
	SECRET_TEXT,
	msg,
	setup,
	open,
	submitCreate,
	field,
} from './interactions-world.ts';

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
		const id = w.ids.next();
		const res = await w.ask({ type: 2, id, guild_id: GUILD });
		expect(res.status).toBe(200);
		expect(res.body.data.content).toBe('Внутренняя ошибка, повтори через минуту.');
		expect(w.logs.find((l) => l.event === 'ix.failed')).toMatchObject({
			error: 'handler',
			interaction: id,
		});
	});
});
