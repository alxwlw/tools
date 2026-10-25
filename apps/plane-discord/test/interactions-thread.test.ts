import { describe, expect, test } from 'bun:test';

import { DiscordApiError } from '../src/discord/rest.ts';
import { chatInputPayload } from './discord-harness.ts';
import {
	FORUM,
	GUILD,
	MAPPED,
	open,
	P_ENG,
	P_HIDDEN,
	P_LAB,
	setup,
	submitCreate,
	THREAD,
	type World,
} from './interactions-world.ts';

const OTHER_THREAD = '222222222222222230';
const CHANNEL_ANNOUNCE = '222222222222222231';

const threadChannel = (id: string, type = 11, parentId = MAPPED) => ({
	id,
	type,
	parent_id: parentId,
});

const link = (w: World, key: unknown, channel: Record<string, unknown> = threadChannel(THREAD)) =>
	w.ask(
		chatInputPayload({
			id: w.ids.next(),
			guildId: GUILD,
			name: 'plane-link',
			channel,
			options: key === undefined ? [] : [{ name: 'key', type: 3, value: key }],
		}),
	);

function seed(w: World, over: { id: string; projectId?: string; seq: number; name?: string }) {
	w.plane.items.set(over.id, {
		id: over.id,
		projectId: over.projectId ?? P_LAB,
		sequenceId: over.seq,
		name: over.name ?? 'Починить вход',
		stateId: '',
		assignees: [],
		priority: 'none',
		descriptionHtml: null,
	});
}

describe('тред из ответа бота (1c)', () => {
	test('create в текстовом канале → тред на ответе бота «LAB-41 Название», связь в store', async () => {
		const w = await setup();
		const { customId } = await open(w, { channel: { id: MAPPED, type: 0 } });
		await submitCreate(w, customId, { title: 'Починить вход' });
		await w.settle();
		const reply = 'd1';
		expect(w.discord.callsOf('startThreadFromMessage')).toEqual([
			[MAPPED, reply, 'LAB-1 Починить вход'],
		]);
		const itemId = w.plane.createdItems[0]!.id;
		expect(w.store.findByThread('d2')).toEqual({
			tenant: 'initech',
			projectId: P_LAB,
			workItemId: itemId,
			channelId: MAPPED,
		});
	});

	test('create в канале объявлений (тип 5) → тред тоже открывается', async () => {
		const w = await setup();
		const { customId } = await open(w, { channel: { id: MAPPED, type: 5 } });
		await submitCreate(w, customId, { title: 'T' });
		await w.settle();
		expect(w.discord.callsOf('startThreadFromMessage')).toHaveLength(1);
	});

	test('create в треде → нового треда нет', async () => {
		const w = await setup();
		const { customId } = await open(w, { channel: threadChannel(THREAD) });
		await submitCreate(w, customId, { title: 'T' });
		await w.settle();
		expect(w.discord.callsOf('sendMessage')).toHaveLength(1);
		expect(w.discord.callsOf('startThreadFromMessage')).toEqual([]);
		expect(w.store.findByThread('d2')).toBeNull();
	});

	test('create: ошибка startThread → лог ix.thread_failed, ответ на месте', async () => {
		const w = await setup();
		w.discord.failures.set(
			'startThreadFromMessage',
			new DiscordApiError(403, 'POST', '/channels/:id/messages/:id/threads', 50013),
		);
		const { customId } = await open(w);
		await submitCreate(w, customId, { title: 'T' });
		await w.settle();
		expect(w.logs).toContainEqual({
			event: 'ix.thread_failed',
			level: 'warn',
			tenant: 'initech',
			status: 403,
			code: 50013,
		});
		expect(w.discord.callsOf('sendMessage')).toHaveLength(1);
		expect(w.discord.callsOf('deleteOriginal')).toHaveLength(1);
		expect(w.store.findByThread('d2')).toBeNull();
		expect(w.logs.map((l) => l.event)).toContain('ix.done');
	});

	test('create: «Уже есть» (повтор) → второго треда нет', async () => {
		const w = await setup();
		const first = await open(w);
		await submitCreate(w, first.customId, { title: 'T' });
		await w.settle();
		const again = await open(w);
		await submitCreate(w, again.customId, { title: 'T' });
		await w.settle();
		expect(w.discord.callsOf('startThreadFromMessage')).toHaveLength(1);
	});
});

describe('/plane-link', () => {
	test('в треде → связь; другая задача в тот же тред → ephemeral «уже привязан»', async () => {
		const w = await setup();
		seed(w, { id: 'w40', seq: 40 });
		seed(w, { id: 'w41', seq: 41, name: 'Другое' });
		const res = await link(w, ' lab-40 ');
		await w.settle();
		expect(res.body).toEqual({ type: 5 });
		expect(w.discord.callsOf('editOriginal')).toEqual([
			[
				'tok-900000000000000001',
				{
					content:
						'Тред привязан к [`LAB-40` «Починить вход»](<https://plane.example.com/example-ws/browse/LAB-40/>).',
				},
			],
		]);
		expect(w.store.findByThread(THREAD)).toEqual({
			tenant: 'initech',
			projectId: P_LAB,
			workItemId: 'w40',
			channelId: MAPPED,
		});

		await link(w, 'LAB-41');
		await w.settle();
		expect(w.discord.callsOf('deleteOriginal')).toEqual([['tok-900000000000000002']]);
		expect(w.discord.callsOf('followup')).toEqual([
			['tok-900000000000000002', { content: 'Тред уже привязан к LAB-40.', ephemeral: true }],
		]);
		expect(w.store.findByThread(THREAD)?.workItemId).toBe('w40');
	});

	test('тот же ключ в уже привязанном треде → снова «привязан»', async () => {
		const w = await setup();
		seed(w, { id: 'w40', seq: 40 });
		await link(w, 'LAB-40');
		await link(w, 'LAB-40');
		await w.settle();
		expect(w.discord.callsOf('editOriginal')).toHaveLength(2);
		expect(w.discord.callsOf('followup')).toEqual([]);
	});

	test('тот же ключ в другом треде того же канала → связь переезжает на новый тред', async () => {
		const w = await setup();
		seed(w, { id: 'w40', seq: 40 });
		await link(w, 'LAB-40');
		await link(w, 'LAB-40', threadChannel(OTHER_THREAD));
		await w.settle();
		expect(w.store.findByThread(OTHER_THREAD)?.workItemId).toBe('w40');
		expect(w.store.findByThread(THREAD)).toBeNull();
	});

	test('вне треда → ephemeral «Команда работает в треде.», без запросов в Plane', async () => {
		const w = await setup();
		seed(w, { id: 'w40', seq: 40 });
		for (const channel of [{ id: MAPPED, type: 0 }, { id: FORUM, type: 15 }, {}]) {
			const res = await link(w, 'LAB-40', channel);
			expect(res.body.type).toBe(4);
			expect(res.body.data.flags).toBe(64);
			expect(res.body.data.content).toBe('Команда работает в треде.');
		}
		await w.settle();
		expect(w.planeCalls).toEqual([]);
		expect(w.store.findByThread(THREAD)).toBeNull();
	});

	test('/plane-link неверный ключ → сразу ephemeral, ни одного вызова Plane', async () => {
		const w = await setup();
		for (const key of ['abc', '', 42, undefined, 'LAB-' + '9'.repeat(30)]) {
			const res = await link(w, key);
			expect(res.body.type).toBe(4);
			expect(res.body.data.flags).toBe(64);
			expect(res.body.data.content).toBe('Нужен ключ вида LAB-40.');
		}
		await w.settle();
		expect(w.planeCalls).toEqual([]);
	});

	test('/plane-link ключ скрытого проекта → как несуществующий', async () => {
		const w = await setup();
		seed(w, { id: 'wz', projectId: P_HIDDEN, seq: 7 });
		await link(w, 'ZEN-7');
		await link(w, 'LAB-999');
		await w.settle();
		const texts = w.discord.callsOf('followup').map((c) => (c[1] as { content: string }).content);
		expect(texts).toEqual(['Задача ZEN-7 не найдена.', 'Задача LAB-999 не найдена.']);
		expect(w.discord.callsOf('deleteOriginal')).toHaveLength(2);
		expect(w.store.findByThread(THREAD)).toBeNull();
	});

	test('/plane-link в треде канала объявлений (тип 10) → связь', async () => {
		const w = await setup();
		seed(w, { id: 'w40', seq: 40 });
		await link(w, 'LAB-40', threadChannel(OTHER_THREAD, 10, CHANNEL_ANNOUNCE));
		await w.settle();
		expect(w.store.findByThread(OTHER_THREAD)).toEqual({
			tenant: 'initech',
			projectId: P_LAB,
			workItemId: 'w40',
			channelId: CHANNEL_ANNOUNCE,
		});
	});

	test('тред привязан со строки фаз 1–2 (projectId null) к другой задаче → текст без ключа', async () => {
		const w = await setup();
		seed(w, { id: 'w40', seq: 40 });
		seed(w, { id: 'w41', seq: 41 });
		w.store.putThread('initech', 'w41', MAPPED, THREAD, null);
		await link(w, 'LAB-40');
		await w.settle();
		expect(w.discord.callsOf('followup')).toEqual([
			[
				'tok-900000000000000001',
				{ content: 'Тред уже привязан к другой задаче.', ephemeral: true },
			],
		]);
	});

	test('другая задача из скрытого проекта или недоступная → текст без ключа', async () => {
		const w = await setup();
		seed(w, { id: 'w40', seq: 40 });
		seed(w, { id: 'wz', projectId: P_HIDDEN, seq: 7 });
		w.store.putThread('initech', 'wz', MAPPED, THREAD, P_HIDDEN);
		await link(w, 'LAB-40');
		w.store.putThread('initech', 'gone', MAPPED, OTHER_THREAD, P_ENG);
		await link(w, 'LAB-40', threadChannel(OTHER_THREAD));
		await w.settle();
		const texts = w.discord.callsOf('followup').map((c) => (c[1] as { content: string }).content);
		expect(texts).toEqual([
			'Тред уже привязан к другой задаче.',
			'Тред уже привязан к другой задаче.',
		]);
	});

	test('ошибка Plane → «Не получилось», публичная заглушка удалена, лог ix.failed', async () => {
		const w = await setup();
		w.plane.getWorkItemByKey = async () => {
			throw new Error('boom');
		};
		await link(w, 'LAB-40');
		await w.settle();
		expect(w.discord.callsOf('deleteOriginal')).toHaveLength(1);
		expect(w.discord.callsOf('followup')[0]?.[1]).toEqual({
			content: 'Не получилось: внутренняя ошибка.',
			ephemeral: true,
		});
		expect(w.logs.map((l) => l.event)).toContain('ix.failed');
		expect(w.store.findByThread(THREAD)).toBeNull();
	});
});
