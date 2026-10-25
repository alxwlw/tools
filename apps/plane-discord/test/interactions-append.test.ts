import { describe, expect, test } from 'bun:test';

import { APPEND_COMMAND } from '../src/discord/commands.ts';
import { createInteractionHandler } from '../src/discord/interactions.ts';
import { type LogEntry } from '../src/log.ts';
import { PlaneApiError } from '../src/plane/client.ts';
import { createHandler } from '../src/server.ts';
import { Store } from '../src/store.ts';
import {
	GUILD,
	MAPPED,
	UNMAPPED,
	MSG,
	P_LAB,
	P_HIDDEN,
	SECRET_TEXT,
	LAB,
	msg,
	type World,
	setup,
	open,
	submitCreate,
	field,
} from './interactions-world.ts';

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
