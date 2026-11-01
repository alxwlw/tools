// Adapted from apps/plane-miro/test/fake-plane.test.ts.
import { describe, expect, test } from 'bun:test';

import type { ItemRow } from '../src/contract.ts';
import { FakePlane } from './fake-plane.ts';

const item = (id: string, projectId: string): ItemRow => ({
	id,
	projectId,
	sequenceId: 1,
	name: 'Task',
	description: '',
	stateId: 's1',
	parentId: null,
	labelIds: [],
	createdAt: '2026-11-01T00:00:00Z',
	updatedAt: '2026-11-01T00:00:00Z',
});

describe('FakePlane', () => {
	test('читает по проекту, отдаёт копии, ведёт calls', async () => {
		const plane = new FakePlane();
		plane.projects = [{ id: 'p1', identifier: 'ABC', name: 'Alpha' }];
		plane.states = [
			{ id: 's1', projectId: 'p1', group: 'started' },
			{ id: 's2', projectId: 'p2', group: 'backlog' },
		];
		plane.labels = [
			{ id: 'l1', projectId: 'p1', name: 'one' },
			{ id: 'l2', projectId: 'p2', name: 'two' },
		];
		plane.modules = [
			{ id: 'm1', projectId: 'p1', name: 'M', itemIds: ['i1'] },
			{ id: 'm2', projectId: 'p2', name: 'N', itemIds: [] },
		];
		plane.items.set('i1', item('i1', 'p1'));
		plane.items.set('i2', item('i2', 'p2'));
		plane.relations.set('i1', [{ from: 'i1', to: 'i2', type: 'blocks' }]);

		expect(await plane.listProjects()).toEqual(plane.projects);
		expect(await plane.listStates('p1')).toEqual([{ id: 's1', projectId: 'p1', group: 'started' }]);
		expect((await plane.listLabels('p1')).map((l) => l.id)).toEqual(['l1']);
		expect((await plane.listModules('p1')).map((m) => m.id)).toEqual(['m1']);
		expect((await plane.listWorkItems('p1')).map((i) => i.id)).toEqual(['i1']);
		expect((await plane.getWorkItem('p1', 'i1'))?.id).toBe('i1');
		// another project's item and a missing one are both null, like Plane's 404
		expect(await plane.getWorkItem('p1', 'i2')).toBeNull();
		expect(await plane.getWorkItem('p1', 'nope')).toBeNull();
		expect(await plane.getRelations('p1', 'i1')).toEqual([
			{ from: 'i1', to: 'i2', type: 'blocks' },
		]);
		expect(await plane.getRelations('p1', 'i2')).toEqual([]);
		expect(plane.calls).toEqual([
			'listProjects',
			'listStates',
			'listLabels',
			'listModules',
			'listWorkItems',
			'getWorkItem',
			'getWorkItem',
			'getWorkItem',
			'getRelations',
			'getRelations',
		]);
		// what the caller gets is a copy
		(await plane.listWorkItems('p1'))[0]!.name = 'changed';
		expect(plane.items.get('i1')!.name).toBe('Task');
	});

	test('failNext: следующие вызовы метода падают по очереди, потом снова работают', async () => {
		const plane = new FakePlane();
		plane.failNext('listProjects', new Error('first'));
		plane.failNext('listProjects', new Error('second'));
		await expect(plane.listProjects()).rejects.toThrow('first');
		await expect(plane.listProjects()).rejects.toThrow('second');
		expect(await plane.listProjects()).toEqual([]);
		// another method is not affected
		expect(await plane.listStates('p1')).toEqual([]);
		expect(plane.calls).toEqual(['listProjects', 'listProjects', 'listProjects', 'listStates']);
	});
});
