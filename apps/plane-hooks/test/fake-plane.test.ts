import { describe, expect, test } from 'bun:test';

import { PlaneApiError } from '../src/plane.ts';
import { FakePlane } from './fake-plane.ts';

describe('FakePlane: доставка', () => {
	test('addWorkItem ставит задачу в состояние по имени', async () => {
		const plane = FakePlane.delivery();
		const id = plane.addWorkItem('ENG-12', 'In Review');
		const byKey = await plane.getWorkItemByKey('ENG-12');
		const states = await plane.listStates('p-eng');
		expect(byKey).toEqual({
			id,
			project: 'p-eng',
			state: states.find((s) => s.name === 'In Review')?.id as string,
			sequenceId: 12,
		});
		expect(states.find((s) => s.id === byKey?.state)).toMatchObject({
			group: 'started',
			sequence: 37000,
		});
	});

	test('наборы состояний проектов: OPS без In Review, QA с Needs info', async () => {
		const plane = FakePlane.delivery();
		const names = async (project: string) => (await plane.listStates(project)).map((s) => s.name);
		expect(await names('p-ops')).not.toContain('In Review');
		expect(await names('p-ops')).not.toContain('On staging');
		expect(await names('p-qa')).toContain('Needs info');
		expect(await names('p-qa')).toContain('Ready for retest');
		expect((await plane.listProjects()).map((p) => p.identifier)).toEqual([
			'ENG',
			'OPS',
			'QA',
			'INC',
		]);
	});

	test('addWorkItem: неизвестное состояние проекта — ошибка', () => {
		expect(() => FakePlane.delivery().addWorkItem('OPS-1', 'In Review')).toThrow(
			'no state "In Review" in OPS',
		);
	});

	test('createLink дважды — exists', async () => {
		const plane = FakePlane.delivery();
		const id = plane.addWorkItem('ENG-1', 'Todo');
		const link = { url: 'https://github.com/acme/api/pull/1', title: 'GitHub: acme/api#1' };
		expect(await plane.createLink('p-eng', id, link)).toBe('created');
		expect(await plane.createLink('p-eng', id, link)).toBe('exists');
		expect(plane.links).toHaveLength(1);
		expect(await plane.listLinks('p-eng', id)).toEqual([
			{ id: plane.links[0]?.id as string, url: link.url },
		]);
	});

	test('updateComment меняет текст комментария; чужой id — 404', async () => {
		const plane = FakePlane.delivery();
		const id = plane.addWorkItem('ENG-2', 'Todo');
		const created = await plane.createComment('p-eng', id, {
			comment_html: '<p>a</p>',
			external_id: 'preview:web',
			external_source: 'plane-hooks',
		});
		await plane.updateComment('p-eng', id, created.id, '<p>b</p>');
		expect(plane.commentsOf(id)[0]?.comment_html).toBe('<p>b</p>');
		expect((await plane.listComments('p-eng', id))[0]?.external_source).toBe('plane-hooks');
		const err = await plane.updateComment('p-eng', id, 'nope', 'x').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PlaneApiError);
		expect((err as PlaneApiError).status).toBe(404);
	});

	test('автономерация пропускает номера, занятые явным ключом', async () => {
		const plane = FakePlane.delivery();
		plane.addWorkItem('ENG-3', 'Todo');
		for (let i = 0; i < 5; i++)
			await plane.createWorkItem('p-eng', {
				name: `n${i}`,
				description_html: '',
				priority: 'none',
				labels: [],
				external_id: `e${i}`,
				external_source: 'test',
			});
		const numbers = plane.workItems.map((w) => w.sequence);
		expect(new Set(numbers).size).toBe(numbers.length);
		expect((await plane.getWorkItemByKey('ENG-3'))?.id).toBe(plane.workItems[0]?.id as string);
	});
});
