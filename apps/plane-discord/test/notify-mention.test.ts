import { describe, expect, test } from 'bun:test';

import type { ChannelRoute } from '../src/config.ts';
import {
	agentMention,
	ALICE,
	ANNOUNCE,
	BOB,
	CAROL,
	comment,
	created,
	D_ALICE,
	FORUM,
	ID,
	ITEM,
	LINK,
	mentionHtml,
	mentionTag,
	OTHER_PROJECT,
	PROJECT,
	route,
	runAll,
	S_DONE,
	S_STARTED,
	sent,
	setup,
	tenantOf,
	TEXT,
	updated,
	VOICE,
} from './notify-world.ts';

describe('createNotifier: agent.mention', () => {
	const setupMention = (channels: ChannelRoute[]) => {
		const ctx = setup(channels);
		ctx.plane.comments.push({
			id: ID(200),
			html: `<p>Привет, ${mentionTag(ALICE)} ${mentionTag(CAROL)} привет</p>`,
			actorId: ALICE,
			externalSource: null,
			externalId: null,
			projectId: PROJECT,
			workItemId: ITEM,
		});
		return ctx;
	};

	test('agent.mention → каналы с mention, цитата из getComment, createRunActivity; без канала — ответ «канал не настроен»', async () => {
		const { notify, discord, plane } = setupMention([
			route(TEXT),
			route(ANNOUNCE, { events: ['created'] }),
		]);
		await runAll(await notify(agentMention()));
		expect(sent(discord)).toEqual([
			[
				TEXT,
				{
					content: `**LAB-41** Название\nУпомянули бота · <@${D_ALICE}>\n${LINK}\n> Привет, <@${D_ALICE}> @Carol привет`,
				},
			],
		]);
		expect(plane.activities).toEqual([{ runId: ID(300), body: `→ Discord: ${TEXT}` }]);

		const none = setupMention([
			route(TEXT, { events: ['created'] }),
			route(FORUM, { projectId: OTHER_PROJECT }),
		]);
		await runAll(await none.notify(agentMention()));
		expect(none.discord.calls).toEqual([]);
		expect(none.plane.activities).toEqual([
			{ runId: ID(300), body: 'Канал для проекта не настроен' },
		]);
	});

	test('ответ run — после доставок в каналы и один на событие; в форум идёт постом', async () => {
		const { notify, discord, plane } = setupMention([route(FORUM), route(TEXT)]);
		const deliveries = await notify(agentMention());
		expect(deliveries.map((d) => d.label)).toEqual([
			`agent_run:r1→channel:${FORUM}`,
			`agent_run:r1→channel:${TEXT}`,
			`agent_run:r1→run:${ID(300)}`,
		]);
		expect(plane.activities).toEqual([]);
		await runAll(deliveries);
		expect(plane.activities).toEqual([{ runId: ID(300), body: `→ Discord: ${FORUM}, ${TEXT}` }]);
		expect(discord.callsOf('createForumPost')).toHaveLength(1);
	});

	test('без commentId → сообщение без цитаты, getComment не нужен', async () => {
		const { notify, discord } = setup([route(TEXT)]);
		await runAll(await notify(agentMention(null)));
		expect(sent(discord)[0]?.[1].content).toBe(
			`**LAB-41** Название\nУпомянули бота · кто-то\n${LINK}`,
		);
	});

	test('длинная цитата режется до 1000 символов и стоит после ссылки', async () => {
		const { notify, discord, plane } = setupMention([route(TEXT)]);
		plane.comments[0]!.html = `<p>${'я'.repeat(3000)}</p>`;
		await runAll(await notify(agentMention()));
		const lines = (sent(discord)[0]?.[1].content ?? '').split('\n');
		expect(lines[3]).toBe(`> ${'я'.repeat(999)}…`);
		expect(lines[2]).toBe(LINK);
		expect(lines).toHaveLength(4);
	});

	test('в цитате упомянутый, которого нет ни в таблице, ни в members → «@кто-то»', async () => {
		const { notify, discord, plane } = setupMention([route(TEXT)]);
		plane.comments[0]!.html = `<p>${mentionTag(ID(99))}</p>`;
		await runAll(await notify(agentMention()));
		expect((sent(discord)[0]?.[1].content ?? '').split('\n')[3]).toBe('> @кто-то');
	});

	test('комментарий без текста → сообщение без цитаты', async () => {
		const { notify, discord, plane } = setupMention([route(TEXT)]);
		plane.comments[0]!.html = '<p></p>';
		await runAll(await notify(agentMention()));
		expect(sent(discord)[0]?.[1].content).toBe(
			`**LAB-41** Название\nУпомянули бота · <@${D_ALICE}>\n${LINK}`,
		);
	});

	test('многострочная цитата — каждая строка с «> »', async () => {
		const { notify, discord, plane } = setupMention([route(TEXT)]);
		plane.comments[0]!.html = '<p>первая</p><p>вторая</p>';
		await runAll(await notify(agentMention()));
		expect((sent(discord)[0]?.[1].content ?? '').split('\n').slice(3)).toEqual([
			'> первая',
			'> ',
			'> вторая',
		]);
	});

	test('проекта нет в списке Plane → run всё равно получает ответ', async () => {
		const { notify, plane, discord, logs } = setupMention([route(TEXT)]);
		plane.projects = [];
		await runAll(await notify(agentMention()));
		expect(discord.calls).toEqual([]);
		expect(plane.activities).toEqual([
			{ runId: ID(300), body: 'Не удалось отправить в Discord: проект не найден в Plane' },
		]);
		expect(logs).toContainEqual({
			event: 'notify.skip',
			level: 'error',
			tenant: 'initech',
			reason: 'unknown_project',
			eventKey: 'agent_run:r1',
		});
	});
});

describe('hiddenProjects: проект скрыт полностью', () => {
	const hidden = (channels: ChannelRoute[]) =>
		setup(channels, { ...tenantOf(channels), hiddenProjects: [PROJECT] });
	const skipEntry = (eventKey: string) => ({
		event: 'notify.skip',
		level: undefined,
		tenant: 'initech',
		reason: 'hidden_project',
		eventKey,
	});

	test('created: ни канала, ни DM, notify.skip hidden_project, запросов Plane нет', async () => {
		const { notify, discord, plane, logs } = hidden([route(TEXT)]);
		expect(
			await notify(created({ assignees: [BOB], descriptionHtml: mentionHtml(ALICE) })),
		).toEqual([]);
		expect(discord.calls).toEqual([]);
		expect(plane.moduleCalls).toEqual([]);
		expect(logs).toEqual([skipEntry('issue.created:x')]);
	});

	test('updated: закрытие, новый исполнитель и упоминание — ничего', async () => {
		const { notify, discord, logs } = hidden([route(TEXT)]);
		expect(await notify(updated({ stateId: S_STARTED }, { stateId: S_DONE }))).toEqual([]);
		expect(await notify(updated({ assignees: [] }, { assignees: [BOB] }))).toEqual([]);
		expect(
			await notify(updated({ descriptionHtml: null }, { descriptionHtml: mentionHtml(BOB) })),
		).toEqual([]);
		expect(discord.calls).toEqual([]);
		expect(logs.map((l) => l.reason)).toEqual([
			'hidden_project',
			'hidden_project',
			'hidden_project',
		]);
	});

	test('comment.created с упоминанием: DM нет, getComment не вызывается', async () => {
		const { notify, discord, logs } = hidden([]);
		expect(await notify(comment(null))).toEqual([]);
		expect(await notify(comment(mentionHtml(BOB)))).toEqual([]);
		expect(discord.calls).toEqual([]);
		expect(logs).toEqual([skipEntry('comment.created:c1'), skipEntry('comment.created:c1')]);
	});

	test('agent.mention: ни одного вызова Discord, run получает нейтральный ответ без каналов, лог без текстов', async () => {
		const { notify, discord, plane, logs } = hidden([route(TEXT)]);
		const deliveries = await notify(agentMention());
		expect(deliveries).toHaveLength(1);
		await runAll(deliveries);
		expect(discord.calls).toEqual([]);
		expect(plane.activities).toEqual([
			{ runId: ID(300), body: 'Пересылка в Discord для этого проекта отключена' },
		]);
		expect(JSON.stringify(plane.activities)).not.toContain(TEXT);
		expect(logs).toEqual([skipEntry('agent_run:r1')]);
	});

	test('другой проект того же тенанта не затронут', async () => {
		const channels = [route(TEXT)];
		const { notify, discord } = setup(channels, {
			...tenantOf(channels),
			hiddenProjects: [OTHER_PROJECT],
		});
		await runAll(await notify(created()));
		expect(sent(discord).map(([c]) => c)).toEqual([TEXT]);
	});
});

describe('логи', () => {
	test('ни одна запись не содержит названия задачи, текста описания и комментария', async () => {
		const { notify, logs } = setup([route(VOICE), route(TEXT)]);
		await runAll(
			await notify(
				created({ name: 'СЕКРЕТНОЕ-НАЗВАНИЕ', descriptionHtml: mentionHtml(BOB) }, ALICE),
			),
		);
		await notify({ ...updated({ stateId: S_STARTED }, { stateId: ID(77) }), tenant: 'initech' });
		expect(logs.length).toBeGreaterThan(0);
		expect(JSON.stringify(logs)).not.toContain('СЕКРЕТНОЕ');
	});
});
