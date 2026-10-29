import { describe, expect, test } from 'bun:test';

import { chainFor, pullPosition, resolveStep } from '../src/delivery/position.ts';
import type { Tenant } from '../src/config.ts';
import { containsVia } from '../src/delivery/sync.ts';
import type { Pull } from '../src/github/client.ts';
import type { StateSummary } from '../src/plane.ts';
import { tenantOf } from './config-fixture.ts';
import { BASE_PULL } from './delivery-sync-world.ts';
import { FakeGitHub } from './fake-github.ts';

describe('позиции', () => {
	const rules = tenantOf().delivery as NonNullable<Tenant['delivery']>;
	const api = rules.repos[0] as NonNullable<(typeof rules.repos)[0]>;
	const wild = rules.repos[1] as NonNullable<(typeof rules.repos)[1]>;
	const basePull: Pull = BASE_PULL;
	const merged: Pull = { ...basePull, state: 'closed', merged: true, mergeSha: 'm1' };

	test('цепочка: review и окружения, без окружений — review и done', () => {
		expect(chainFor(api, rules)).toEqual(['In Review', 'On staging', 'Done']);
		expect(chainFor(wild, rules)).toEqual(['In Review', 'Done']);
	});

	test('открытый черновик, открытый PR и закрытый без merge', async () => {
		const never = async () => {
			throw new Error('contains must not be asked');
		};
		expect(await pullPosition({ ...basePull, draft: true }, api, rules, never)).toEqual({
			kind: 'draft',
		});
		expect(await pullPosition(basePull, api, rules, never)).toEqual({
			kind: 'at',
			chain: ['In Review', 'On staging', 'Done'],
			index: 0,
		});
		expect(await pullPosition({ ...basePull, state: 'closed' }, api, rules, never)).toEqual({
			kind: 'ignored',
		});
	});

	test('смёрджен без известного merge-коммита — ревью, деплои не спрашиваются', async () => {
		const never = async () => {
			throw new Error('contains must not be asked');
		};
		expect(await pullPosition({ ...merged, mergeSha: null }, api, rules, never)).toEqual({
			kind: 'at',
			chain: ['In Review', 'On staging', 'Done'],
			index: 0,
		});
	});

	test('смёрджен без окружений — конец дороги; с окружениями — самое дальнее выкаченное', async () => {
		const asked: string[] = [];
		const deployedTo =
			(...envs: string[]) =>
			async (env: string) => {
				asked.push(env);
				return envs.includes(env);
			};
		expect(await pullPosition(merged, wild, rules, deployedTo())).toMatchObject({ index: 1 });
		expect(asked).toEqual([]);
		expect(await pullPosition(merged, api, rules, deployedTo('staging'))).toMatchObject({
			index: 1,
		});
		expect(
			await pullPosition(merged, api, rules, deployedTo('staging', 'production')),
		).toMatchObject({
			index: 2,
		});
		expect(await pullPosition(merged, api, rules, deployedTo())).toMatchObject({ index: 0 });
	});

	const states: StateSummary[] = [
		{ id: 's-review', name: 'In Review', group: 'started', sequence: 2, default: false },
		{ id: 's-done', name: 'Done', group: 'completed', sequence: 3, default: false },
	];
	test('resolveStep: переименование, null и откат назад по цепочке', () => {
		const chain = ['In Review', 'On staging', 'Done'];
		expect(resolveStep(chain, 2, {}, states)?.id).toBe('s-done');
		expect(resolveStep(chain, 1, {}, states)?.id).toBe('s-review');
		expect(resolveStep(chain, 2, { Done: null }, states)?.id).toBe('s-review');
		expect(resolveStep(chain, 2, { Done: 'in review' }, states)?.id).toBe('s-review');
		expect(resolveStep(chain, 0, { 'In Review': null }, states)).toBeNull();
		expect(resolveStep(chain, 0, {}, [])).toBeNull();
	});
});

describe('containsVia', () => {
	function graph() {
		const gh = new FakeGitHub()
			.commit('c1', [], 'one')
			.commit('c2', ['c1'], 'two')
			.commit('c3', ['c2'], 'three');
		return { gh, contains: containsVia(async (repo) => (repo === 'acme/api' ? gh : null)) };
	}

	test('выкачанный коммит впереди merge-коммита — содержит; позади — нет; тот же — да', async () => {
		const { gh, contains } = graph();
		gh.deploy('acme/api', 'production', 'c2', 'success');
		expect(await contains('acme/api', 'production', 'c1')).toBe(true);
		expect(await contains('acme/api', 'production', 'c2')).toBe(true);
		expect(await contains('acme/api', 'production', 'c3')).toBe(false);
		expect(gh.calls).toContain('compare acme/api c1...c2');
	});

	test('берётся последний успешный деплой, упавшие новее него пропускаются', async () => {
		const { gh, contains } = graph();
		gh.deploy('acme/api', 'production', 'c1', 'success');
		gh.deploy('acme/api', 'production', 'c3', 'failure');
		expect(await contains('acme/api', 'production', 'c2')).toBe(false);
		expect(gh.calls).toContain('listDeployments acme/api production 20');
	});

	test('нет деплоев, нет App, пропавший после force-push sha — false', async () => {
		const { gh, contains } = graph();
		expect(await contains('acme/api', 'production', 'c1')).toBe(false);
		expect(await contains('other/api', 'production', 'c1')).toBe(false);
		gh.deploy('acme/api', 'staging', 'c2', 'success');
		gh.removeCommit('c2');
		expect(await contains('acme/api', 'staging', 'c1')).toBe(false);
	});

	test('упавший запрос не запоминается — следующий повторяет его', async () => {
		const gh = new FakeGitHub().commit('c1', [], 'one');
		gh.deploy('acme/api', 'production', 'c1', 'success');
		let attempts = 0;
		const contains = containsVia(async () => {
			if (attempts++ === 0) throw new Error('network');
			return gh;
		});
		await expect(contains('acme/api', 'production', 'c1')).rejects.toThrow('network');
		expect(await contains('acme/api', 'production', 'c1')).toBe(true);
	});

	test('ответы разных репозиториев не смешиваются', async () => {
		const { gh, contains } = graph();
		gh.deploy('acme/api', 'production', 'c2', 'success');
		expect(await contains('acme/api', 'production', 'c1')).toBe(true);
		expect(await contains('acme/infra', 'production', 'c1')).toBe(false);
	});

	test('ответ запоминается по репозиторию, окружению и sha', async () => {
		const { gh, contains } = graph();
		gh.deploy('acme/api', 'production', 'c2', 'success');
		await Promise.all([
			contains('acme/api', 'production', 'c1'),
			contains('acme/api', 'production', 'c1'),
		]);
		await contains('acme/api', 'production', 'c1');
		expect(gh.calls.filter((c) => c.startsWith('listDeployments'))).toHaveLength(1);
		await contains('acme/api', 'production', 'c3');
		expect(gh.calls.filter((c) => c.startsWith('listDeployments'))).toHaveLength(2);
	});
});
