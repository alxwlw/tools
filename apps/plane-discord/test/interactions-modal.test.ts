import { describe, expect, test } from 'bun:test';

import { APPEND_COMMAND, commandDefinitions, CREATE_COMMAND } from '../src/discord/commands.ts';
import { createInteractionHandler } from '../src/discord/interactions.ts';
import { type ProjectSummary } from '../src/plane/client.ts';
import { commandPayload, makeSigner } from './discord-harness.ts';
import {
	GUILD,
	NOCONF_GUILD,
	MAPPED,
	UNMAPPED,
	FORUM,
	THREAD,
	P_LAB,
	P_ENG,
	P_HIDDEN,
	LAB,
	HIDDEN,
	tenant,
	msg,
	setup,
	open,
	submitCreate,
	field,
	hasLoneSurrogate,
} from './interactions-world.ts';

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
