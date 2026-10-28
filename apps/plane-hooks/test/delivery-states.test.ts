import { describe, expect, test } from 'bun:test';

import { compareStates, isMovable, stateByName } from '../src/delivery/states.ts';
import type { StateSummary } from '../src/plane.ts';

const st = (name: string, group: string, sequence: number): StateSummary => ({
	id: name,
	name,
	group,
	sequence,
	default: false,
});
const backlog = st('Backlog', 'backlog', 99000);
const todo = st('Todo', 'unstarted', 10);
const progress = st('In Progress', 'started', 35000);
const review = st('In Review', 'started', 37000);
const done = st('Done', 'completed', 1);
const cancelled = st('Cancelled', 'cancelled', 55000);

describe('compareStates', () => {
	test('порядок: группа важнее sequence; внутри started — по sequence', () => {
		expect(compareStates(backlog, todo)).toBeLessThan(0);
		expect(compareStates(todo, progress)).toBeLessThan(0);
		expect(compareStates(review, done)).toBeLessThan(0);
		expect(compareStates(progress, review)).toBeLessThan(0);
		expect(compareStates(review, progress)).toBeGreaterThan(0);
		expect(compareStates(review, { ...review, id: 'x' })).toBe(0);
	});
});

describe('isMovable', () => {
	test('Cancelled, Done и hold — не movable', () => {
		expect(isMovable(cancelled, [])).toBe(false);
		expect(isMovable(done, [])).toBe(false);
		expect(isMovable(progress, ['In Progress'])).toBe(false);
		expect(isMovable(backlog, [])).toBe(true);
		expect(isMovable(todo, [])).toBe(true);
		expect(isMovable(progress, ['Blocked'])).toBe(true);
	});
});

describe('stateByName / hold', () => {
	test('имя состояния без регистра', () => {
		expect(stateByName([todo, review], 'in REVIEW')).toBe(review);
		expect(stateByName([todo, review], 'Nope')).toBeNull();
		expect(isMovable(progress, ['in progress'])).toBe(false);
	});
});
