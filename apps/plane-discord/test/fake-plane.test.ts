import { describe, expect, test } from 'bun:test';
import { FakePlane } from './fake-plane.ts';

const newItem = (externalId: string) => ({
	name: 'n',
	description_html: '<p>d</p>',
	external_id: externalId,
	external_source: 'discord',
});

function seeded() {
	const plane = new FakePlane();
	plane.projects = [{ id: 'p1', identifier: 'LAB', name: 'Ops' }];
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

	test('getWorkItemByKey: ключ из identifier и sequenceId; неизвестный → null', async () => {
		const plane = seeded();
		const { id } = await plane.createWorkItem('p1', newItem('m1'));
		const seq = (await plane.getWorkItem('p1', id)).sequenceId;
		expect((await plane.getWorkItemByKey(`LAB-${seq}`))?.id).toBe(id);
		expect(await plane.getWorkItemByKey('LAB-9999')).toBeNull();
		expect(await plane.getWorkItemByKey('ZZZ-1')).toBeNull();
	});

	test('findCommentByExternalId смотрит все комментарии задачи, но только этой', async () => {
		const plane = seeded();
		const comment = (externalId: string) => ({
			comment_html: '<p>c</p>',
			external_id: externalId,
			external_source: 'discord',
		});
		await plane.createComment('p1', 'w1', comment('a'));
		const target = await plane.createComment('p1', 'w1', comment('b'));
		await plane.createComment('p1', 'w2', comment('c'));
		expect(await plane.findCommentByExternalId('p1', 'w1', 'discord', 'b')).toEqual({
			id: target.id,
		});
		expect(await plane.findCommentByExternalId('p1', 'w1', 'discord', 'c')).toBeNull();
		expect(await plane.findCommentByExternalId('p1', 'w1', 'github', 'b')).toBeNull();
	});

	test('getWorkItemModules: только модули, в которых задача лежит', async () => {
		const plane = seeded();
		plane.modules.set('m-a', new Set(['w1']));
		plane.modules.set('m-b', new Set(['w2']));
		expect(await plane.getWorkItemModules('p1', 'w1', ['m-a', 'm-b', 'm-none'])).toEqual(['m-a']);
	});

	test('createRunActivity и getComment: записано и читается', async () => {
		const plane = seeded();
		await plane.createRunActivity('run-1', 'ok');
		expect(plane.activities).toEqual([{ runId: 'run-1', body: 'ok' }]);
		const { id } = await plane.createComment('p1', 'w1', {
			comment_html: '<p>c</p>',
			external_id: 'x',
			external_source: 'discord',
		});
		expect((await plane.getComment('p1', 'w1', id)).html).toBe('<p>c</p>');
		await expect(plane.getComment('p1', 'w1', 'nope')).rejects.toThrow('no comment');
	});
});
