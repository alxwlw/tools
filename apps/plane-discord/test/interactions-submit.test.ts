import { describe, expect, test } from 'bun:test';

import { createInteractionHandler } from '../src/discord/interactions.ts';
import { DiscordApiError } from '../src/discord/rest.ts';
import { PlaneApiError } from '../src/plane/client.ts';
import { Store } from '../src/store.ts';
import { submitPayload } from './discord-harness.ts';
import {
	GUILD,
	MAPPED,
	UNMAPPED,
	MSG,
	AUTHOR,
	LINKED,
	P_LAB,
	P_ENG,
	P_HIDDEN,
	SECRET_TEXT,
	LAB,
	ENG,
	tenant,
	msg,
	setup,
	open,
	submitCreate,
} from './interactions-world.ts';

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

	test('просроченная форма не принимается, когда после неё открыли новую; новая принимается', async () => {
		const w = await setup();
		const old = await open(w);
		w.advance(15 * 60_000 + 1);
		const fresh = await open(w);
		// Dropping an expired form from the map is not observable: it is always the oldest, so a full
		// map evicts it first anyway. What a user sees is that only the fresh form is accepted.
		expect((await submitCreate(w, old.customId, { title: 'X' })).body.data.content).toBe(
			'Форма устарела, вызови команду ещё раз.',
		);
		expect((await submitCreate(w, fresh.customId, { title: 'X' })).body.type).toBe(5);
	});

	test('без defer в зависимостях работа всё равно выполняется (прод: fire and log)', async () => {
		const w = await setup({ withDefer: false });
		const { customId } = await open(w);
		const res = await submitCreate(w, customId, { title: 'Починить вход' });
		expect(res.body.type).toBe(5);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(w.plane.createdItems).toHaveLength(1);
	});

	test('без defer работа стартует после того, как ответ type 5 отдан, не раньше', async () => {
		const w = await setup({ withDefer: false });
		const { customId } = await open(w);
		const calls = w.planeCalls.length;
		const res = await submitCreate(w, customId, { title: 'Починить вход' });
		expect(res.body.type).toBe(5);
		expect(w.planeCalls.length).toBe(calls);
		expect(w.discord.callsOf('editOriginal')).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(w.planeCalls.length).toBeGreaterThan(calls);
	});

	test('задача из store в скрытом проекте: ключ, ссылка и название не раскрываются, второй задачи нет', async () => {
		const w = await setup();
		const made = await w.plane.createWorkItem(P_HIDDEN, {
			name: 'Секретная задача',
			description_html: '',
			external_id: MSG,
			external_source: 'discord',
		});
		w.store.putDiscordItem('initech', MSG, P_HIDDEN, made.id);
		const { customId } = await open(w);
		expect((await submitCreate(w, customId, { title: 'Починить вход' })).body.type).toBe(5);
		await w.settle();
		expect(
			w.discord.callsOf('editOriginal').map((c) => (c[1] as { content: string }).content),
		).toEqual(['Задача не найдена.']);
		const sent = JSON.stringify([...w.discord.calls]);
		expect(sent).not.toContain('ZEN-1');
		expect(sent).not.toContain('Секретная');
		expect(w.discord.callsOf('sendMessage')).toEqual([]);
		expect(w.plane.createdItems.map((c) => c.projectId)).toEqual([P_HIDDEN]);
	});
});
