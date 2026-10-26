// Adapted from apps/plane-discord/test/fake-plane.test.ts.
import { describe, expect, test } from 'bun:test';
import { PlaneApiError } from '../src/plane/client.ts';
import { FakePlane } from './fake-plane.ts';

const newItem = (externalId: string, name = 'n') => ({
	name,
	description_html: '<p>d</p>',
	external_id: externalId,
	external_source: 'miro',
});

function seeded() {
	const plane = new FakePlane();
	plane.projects = [
		{ id: 'p1', identifier: 'LAB', name: 'Ops', archived: false },
		{ id: 'p2', identifier: 'OPS', name: 'More', archived: false },
	];
	plane.states.set('p1', [{ id: 's1', name: 'Todo', group: 'unstarted' }]);
	return plane;
}

describe('FakePlane', () => {
	test('повтор external_id задачи в проекте — created false и id первой; в другом проекте — новая', async () => {
		const plane = seeded();
		const first = await plane.createWorkItem('p1', newItem('m1'));
		expect(first.created).toBe(true);
		expect(await plane.createWorkItem('p1', newItem('m1'))).toEqual({
			id: first.id,
			created: false,
		});
		const other = await plane.createWorkItem('p2', newItem('m1'));
		expect(other.created).toBe(true);
		expect(other.id).not.toBe(first.id);
		expect(plane.createdItems.map((c) => c.id)).toEqual([first.id, other.id]);
	});

	test('getWorkItem: чужой проект и неизвестный id → null; getWorkItemByKey: ключ из identifier и sequenceId', async () => {
		const plane = seeded();
		const { id } = await plane.createWorkItem('p1', newItem('m1'));
		const seq = (await plane.getWorkItem('p1', id))!.sequenceId;
		expect(await plane.getWorkItem('p2', id)).toBeNull();
		expect(await plane.getWorkItem('p1', 'nope')).toBeNull();
		expect((await plane.getWorkItemByKey(`LAB-${seq}`))?.id).toBe(id);
		expect(await plane.getWorkItemByKey('LAB-9999')).toBeNull();
		expect(await plane.getWorkItemByKey('ZZZ-1')).toBeNull();
	});

	test('архивная задача: createWorkItem по её external_id — created false, а getWorkItem и getWorkItemByKey — null', async () => {
		const plane = seeded();
		const first = await plane.createWorkItem('p1', newItem('m1'));
		const seq = (await plane.getWorkItem('p1', first.id))!.sequenceId;
		plane.archived.add(first.id);
		expect(await plane.createWorkItem('p1', newItem('m1'))).toEqual({
			id: first.id,
			created: false,
		});
		expect(await plane.getWorkItem('p1', first.id)).toBeNull();
		expect(await plane.getWorkItemByKey(`LAB-${seq}`)).toBeNull();
	});

	test('searchWorkItems: по подстроке названия без регистра и по точному ключу', async () => {
		const plane = seeded();
		const a = await plane.createWorkItem('p1', newItem('m1', 'Починить Насос'));
		await plane.createWorkItem('p2', newItem('m2', 'Другое'));
		const hit = {
			id: a.id,
			projectId: 'p1',
			key: expect.stringMatching(/^LAB-\d+$/),
			name: 'Починить Насос',
		};
		expect(await plane.searchWorkItems('насос')).toEqual([hit]);
		const key = (await plane.searchWorkItems('насос'))[0]!.key;
		expect(await plane.searchWorkItems(key.toLowerCase())).toEqual([hit]);
		expect(await plane.searchWorkItems('нет такого')).toEqual([]);
	});

	test('findCommentByExternalId смотрит все комментарии задачи, но только этой', async () => {
		const plane = seeded();
		const comment = (externalId: string) => ({
			comment_html: '<p>c</p>',
			external_id: externalId,
			external_source: 'miro',
		});
		await plane.createComment('p1', 'w1', comment('a'));
		const target = await plane.createComment('p1', 'w1', comment('b'));
		await plane.createComment('p1', 'w2', comment('c'));
		expect(await plane.findCommentByExternalId('p1', 'w1', 'miro', 'b')).toEqual({
			id: target.id,
		});
		expect(await plane.findCommentByExternalId('p1', 'w1', 'miro', 'c')).toBeNull();
		expect(await plane.findCommentByExternalId('p1', 'w1', 'github', 'b')).toBeNull();
	});

	test('createLink: тот же URL у той же задачи — exists, у другой — created', async () => {
		const plane = seeded();
		const link = { url: 'https://miro.com/app/board/b/', title: 'Miro: Доска' };
		expect(await plane.createLink('p1', 'w1', link)).toBe('created');
		expect(await plane.createLink('p1', 'w1', link)).toBe('exists');
		expect(await plane.createLink('p1', 'w2', link)).toBe('created');
		expect(plane.links.get('w1')).toEqual([link]);
	});

	test('updateDescription: записывает в задачу и в descriptions; чужая или неизвестная задача — 404', async () => {
		const plane = seeded();
		const { id } = await plane.createWorkItem('p1', newItem('m1'));
		await plane.updateDescription('p1', id, '<p>new</p>');
		expect(plane.descriptions.get(id)).toBe('<p>new</p>');
		expect((await plane.getWorkItem('p1', id))?.descriptionHtml).toBe('<p>new</p>');
		const err = await plane.updateDescription('p2', id, 'x').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PlaneApiError);
		expect((err as PlaneApiError).status).toBe(404);
	});

	test('calls — журнал имён; failNext бросает только следующий вызов этого метода, по очереди', async () => {
		const plane = seeded();
		plane.failNext('listProjects', new Error('boom-1'));
		plane.failNext('listProjects', new Error('boom-2'));
		await expect(plane.listProjects()).rejects.toThrow('boom-1');
		await expect(plane.listProjects()).rejects.toThrow('boom-2');
		expect(await plane.listProjects()).toHaveLength(2);
		plane.failNext('createLink', new Error('link-boom'));
		expect(await plane.listStates('p1')).toHaveLength(1);
		await expect(plane.createLink('p1', 'w1', { url: 'u', title: 't' })).rejects.toThrow(
			'link-boom',
		);
		expect(plane.links.size).toBe(0);
		expect(plane.calls).toEqual([
			'listProjects',
			'listProjects',
			'listProjects',
			'listStates',
			'createLink',
		]);
	});
});
