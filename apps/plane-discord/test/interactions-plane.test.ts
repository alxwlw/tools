import { describe, expect, test } from 'bun:test';

import { commandDefinitions } from '../src/discord/commands.ts';
import { DiscordApiError } from '../src/discord/rest.ts';
import { PlaneApiError } from '../src/plane/client.ts';
import { chatInputPayload, commandPayload } from './discord-harness.ts';
import {
	GUILD,
	LINKED,
	MAPPED,
	msg,
	P_HIDDEN,
	P_LAB,
	setup,
	type World,
} from './interactions-world.ts';

const slash = (w: World, key: unknown) =>
	w.ask(
		chatInputPayload({
			id: w.ids.next(),
			guildId: GUILD,
			name: 'plane',
			options: key === undefined ? [] : [{ name: 'key', type: 3, value: key }],
		}),
	);

function seed(w: World, assignees: string[] = []) {
	w.plane.states.set(P_LAB, [{ id: 's-doing', name: 'В работе', group: 'started' }]);
	w.plane.members = [{ id: 'plane-user-2', displayName: 'Мира' }];
	w.plane.items.set('w40', {
		id: 'w40',
		projectId: P_LAB,
		sequenceId: 40,
		name: 'Починить вход',
		stateId: 's-doing',
		assignees,
		priority: 'urgent',
		descriptionHtml: null,
	});
}

describe('/plane KEY', () => {
	test('/plane lab-40 → публичный deferred (без flags 64), затем editOriginal с карточкой', async () => {
		const w = await setup();
		seed(w);
		const res = await slash(w, ' lab-40 ');
		await w.settle();
		expect(res.body).toEqual({ type: 5 });
		const [call] = w.discord.callsOf('editOriginal');
		expect(call).toEqual([
			'tok-900000000000000001',
			{
				content: '',
				embeds: [
					{
						title: 'LAB-40 Починить вход',
						url: 'https://plane.example.com/example-ws/browse/LAB-40/',
						fields: [
							{ name: 'Состояние', value: 'В работе', inline: true },
							{ name: 'Исполнители', value: '—', inline: true },
							{ name: 'Приоритет', value: 'Срочный', inline: true },
						],
					},
				],
			},
		]);
		expect(w.discord.callsOf('deleteOriginal')).toEqual([]);
	});

	test('/plane abc → сразу ephemeral, ни одного вызова Plane', async () => {
		const w = await setup();
		for (const key of ['abc', '', 42, undefined, 'LAB-' + '9'.repeat(30)]) {
			const res = await slash(w, key);
			expect(res.body.type).toBe(4);
			expect(res.body.data.flags).toBe(64);
			expect(res.body.data.content).toBe('Нужен ключ вида LAB-40.');
		}
		await w.settle();
		expect(w.planeCalls).toEqual([]);
		expect(w.discord.calls).toEqual([]);
	});

	test('несуществующий ключ → deleteOriginal и ephemeral followup', async () => {
		const w = await setup();
		const res = await slash(w, 'LAB-99');
		await w.settle();
		expect(res.body).toEqual({ type: 5 });
		expect(w.discord.calls.map((c) => c.method)).toEqual(['deleteOriginal', 'followup']);
		expect(w.discord.callsOf('followup')[0]?.[1]).toEqual({
			content: 'Задача LAB-99 не найдена.',
			ephemeral: true,
		});
	});

	test('ключ скрытого проекта → как несуществующий', async () => {
		const w = await setup();
		w.plane.items.set('wz', {
			id: 'wz',
			projectId: P_HIDDEN,
			sequenceId: 7,
			name: 'Секретная задача',
			stateId: 's',
			assignees: [],
			priority: 'none',
			descriptionHtml: null,
		});
		await slash(w, 'ZEN-7');
		await w.settle();
		expect(w.discord.callsOf('editOriginal')).toEqual([]);
		expect(w.discord.callsOf('followup')[0]?.[1]).toEqual({
			content: 'Задача ZEN-7 не найдена.',
			ephemeral: true,
		});
		expect(JSON.stringify(w.discord.calls)).not.toContain('Секретная');
	});

	test('message-команда с именем plane — неизвестная, карточка не строится', async () => {
		const w = await setup();
		seed(w);
		const res = await w.ask(
			commandPayload({
				id: w.ids.next(),
				guildId: GUILD,
				channel: { id: MAPPED, type: 0 },
				name: 'plane',
				message: msg(),
			}),
		);
		await w.settle();
		expect(res.body.data).toMatchObject({ content: 'Неизвестная команда.', flags: 64 });
		expect(w.planeCalls).toEqual([]);
	});

	test('ошибка Plane → deleteOriginal и ephemeral «Не получилось: Plane ответил 503»', async () => {
		const w = await setup();
		w.plane.getWorkItemByKey = async () => {
			throw new PlaneApiError(503, 'GET', '/x');
		};
		await slash(w, 'LAB-40');
		await w.settle();
		expect(w.discord.calls.map((c) => c.method)).toEqual(['deleteOriginal', 'followup']);
		expect(w.discord.callsOf('followup')[0]?.[1]).toEqual({
			content: 'Не получилось: Plane ответил 503.',
			ephemeral: true,
		});
		expect(w.logs.some((l) => l.event === 'ix.failed')).toBe(true);
	});

	test('исполнитель из таблицы → <@id>, остальные → display name, неизвестный → кто-то', async () => {
		const w = await setup();
		seed(w, ['plane-user-1', 'plane-user-2', 'plane-user-3']);
		await slash(w, 'LAB-40');
		await w.settle();
		const embed = (w.discord.callsOf('editOriginal')[0]?.[1] as { embeds: any[] }).embeds[0];
		expect(embed.fields[1].value).toBe(`<@${LINKED}>, Мира, кто-то`);
	});

	test('нет состояния и пустое имя участника → «—» и «кто-то»', async () => {
		const w = await setup();
		seed(w, ['plane-user-2']);
		w.plane.members = [{ id: 'plane-user-2', displayName: '' }];
		w.plane.states.set(P_LAB, []);
		await slash(w, 'LAB-40');
		await w.settle();
		const embed = (w.discord.callsOf('editOriginal')[0]?.[1] as { embeds: any[] }).embeds[0];
		expect(embed.fields.map((f: any) => f.value)).toEqual(['—', 'кто-то', 'Срочный']);
	});

	test('другая slash-команда → неизвестная; лог отказа и успеха без текстов', async () => {
		const w = await setup();
		seed(w);
		const other = await w.ask(
			chatInputPayload({ id: w.ids.next(), guildId: GUILD, name: 'other', options: [] }),
		);
		expect(other.body.data).toMatchObject({ content: 'Неизвестная команда.', flags: 64 });
		const payload = chatInputPayload({
			id: w.ids.next(),
			guildId: GUILD,
			name: 'plane',
			options: [{ name: 'key', type: 3, value: 'LAB-40' }],
		});
		const noToken = await w.ask({ ...payload, token: undefined });
		expect(noToken.body.data).toMatchObject({
			content: 'Не удалось разобрать запрос Discord.',
			flags: 64,
		});
		expect(w.logs.at(-1)).toMatchObject({
			event: 'ix.refused',
			tenant: 'initech',
			interaction: '900000000000000002',
			reason: 'no_token',
		});
		const bad = await slash(w, 'abc');
		expect(bad.body.data.flags).toBe(64);
		expect(w.logs.at(-1)).toMatchObject({
			event: 'ix.refused',
			tenant: 'initech',
			reason: 'bad_key',
		});
		await slash(w, 'LAB-40');
		await w.settle();
		expect(w.logs.at(-1)).toMatchObject({
			event: 'ix.done',
			tenant: 'initech',
			interaction: '900000000000000004',
			kind: 'card',
			ms: 0,
		});
	});

	test('сбой Discord при отправке карточки: лог со статусом Discord, ephemeral «Discord ответил»', async () => {
		const w = await setup();
		seed(w);
		w.discord.failures.set('editOriginal', new DiscordApiError(429, 'PATCH', '/x'));
		await slash(w, 'LAB-40');
		await w.settle();
		expect(w.logs.find((l) => l.event === 'ix.failed')).toMatchObject({
			error: 'DiscordApiError',
			status: 429,
		});
		expect(w.discord.callsOf('followup')[0]?.[1]).toEqual({
			content: 'Не получилось: Discord ответил 429.',
			ephemeral: true,
		});
	});

	test('сбой Plane: лог ix.failed с именем и статусом; сбой уборки и followup — в лог', async () => {
		const w = await setup();
		w.plane.getWorkItemByKey = async () => {
			throw new PlaneApiError(502, 'GET', '/x');
		};
		w.discord.failures.set('deleteOriginal', new DiscordApiError(500, 'DELETE', '/x'));
		w.discord.failures.set('followup', new DiscordApiError(500, 'POST', '/x'));
		await slash(w, 'LAB-40');
		await w.settle();
		const byEvent = (event: string) => w.logs.find((l) => l.event === event);
		expect(byEvent('ix.failed')).toMatchObject({
			level: 'error',
			tenant: 'initech',
			interaction: '900000000000000001',
			kind: 'card',
			error: 'PlaneApiError',
			status: 502,
			ms: 0,
		});
		expect(byEvent('ix.cleanup_failed')).toMatchObject({ level: 'warn', kind: 'card' });
		expect(byEvent('ix.reply_failed')).toMatchObject({ level: 'error', kind: 'card' });
	});

	test('состояние, созданное после заполнения кэша → повтор с refresh', async () => {
		const w = await setup();
		seed(w);
		w.plane.items.get('w40')!.stateId = 's-new';
		const asked: (boolean | undefined)[] = [];
		w.rt.states = async (_p, opts) => {
			asked.push(opts?.refresh);
			return opts?.refresh ? [{ id: 's-new', name: 'Ревью', group: 'started' }] : [];
		};
		await slash(w, 'LAB-40');
		await w.settle();
		const embed = (w.discord.callsOf('editOriginal')[0]?.[1] as { embeds: any[] }).embeds[0];
		expect(embed.fields[0].value).toBe('Ревью');
		expect(asked).toEqual([undefined, true]);
	});

	test('нет такого ключа и скрытый проект → ровно одна запись лога ix.done/not_found, без текстов', async () => {
		const w = await setup();
		w.plane.items.set('wz', {
			id: 'wz',
			projectId: P_HIDDEN,
			sequenceId: 7,
			name: 'Секретная задача',
			stateId: 's',
			assignees: [],
			priority: 'none',
			descriptionHtml: null,
		});
		await slash(w, 'LAB-99');
		await slash(w, 'ZEN-7');
		await w.settle();
		expect(w.logs).toEqual([
			{
				event: 'ix.done',
				tenant: 'initech',
				interaction: '900000000000000001',
				kind: 'card',
				result: 'not_found',
				ms: 0,
			},
			{
				event: 'ix.done',
				tenant: 'initech',
				interaction: '900000000000000002',
				kind: 'card',
				result: 'not_found',
				ms: 0,
			},
		]);
	});

	test('без исполнителей, которых нужно называть, members() не вызывается', async () => {
		const w = await setup();
		seed(w, ['plane-user-1']);
		w.rt.members = async () => {
			throw new PlaneApiError(503, 'GET', '/x');
		};
		await slash(w, 'LAB-40');
		await w.settle();
		const embed = (w.discord.callsOf('editOriginal')[0]?.[1] as { embeds: any[] }).embeds[0];
		expect(embed.fields[1].value).toBe(`<@${LINKED}>`);
		seed(w, []);
		await slash(w, 'LAB-40');
		await w.settle();
		expect(w.discord.callsOf('editOriginal')).toHaveLength(2);
		expect(w.discord.callsOf('followup')).toEqual([]);
	});

	test('members() запрашивается один раз на карточку, сколько бы ни было неизвестных исполнителей', async () => {
		const w = await setup();
		seed(w, ['plane-user-2', 'plane-user-3']);
		let calls = 0;
		const refreshes: (boolean | undefined)[] = [];
		const known = w.rt.states;
		w.rt.states = async (p, opts) => {
			refreshes.push(opts?.refresh);
			return known(p, opts);
		};
		w.rt.members = async () => {
			calls += 1;
			return w.plane.members;
		};
		await slash(w, 'LAB-40');
		await w.settle();
		expect(calls).toBe(1);
		// The state is known: no second, refreshing, request.
		expect(refreshes).toEqual([undefined]);
	});

	test('markdown в имени состояния и исполнителя приходит в поля экранированным', async () => {
		const w = await setup();
		seed(w, ['plane-user-2']);
		w.plane.members = [{ id: 'plane-user-2', displayName: '**Мира** [x](https://example.com)' }];
		w.plane.states.set(P_LAB, [
			{ id: 's-doing', name: '[x](https://example.com) **жирно**', group: 'started' },
		]);
		await slash(w, 'LAB-40');
		await w.settle();
		const embed = (w.discord.callsOf('editOriginal')[0]?.[1] as { embeds: any[] }).embeds[0];
		expect(embed.fields[0].value).toBe('\\[x\\](https://example.com) \\*\\*жирно\\*\\*');
		expect(embed.fields[1].value).toBe('\\*\\*Мира\\*\\* \\[x\\](https://example.com)');
	});

	test('commandDefinitions: plane с обязательной опцией key; обе MESSAGE-команды на месте', () => {
		const defs = commandDefinitions() as { name: string; type: number }[];
		expect(defs.map((d) => [d.name, d.type])).toEqual([
			['Создать задачу в Plane', 3],
			['Добавить в задачу', 3],
			['plane', 1],
			['plane-link', 1],
		]);
		expect(defs[2] as unknown).toEqual({
			name: 'plane',
			type: 1,
			description: 'Карточка задачи Plane',
			options: [
				{ name: 'key', type: 3, description: 'Ключ задачи, например LAB-40', required: true },
			],
			contexts: [0],
			integration_types: [0],
		});
	});

	test('commandDefinitions: плюс plane-link с обязательной опцией key, только гильдия', () => {
		const defs = commandDefinitions();
		expect(defs).toHaveLength(4);
		expect(defs[3] as unknown).toEqual({
			name: 'plane-link',
			type: 1,
			description: 'Привязать тред к задаче Plane',
			options: [
				{ name: 'key', type: 3, description: 'Ключ задачи, например LAB-40', required: true },
			],
			contexts: [0],
			integration_types: [0],
		});
	});
});
