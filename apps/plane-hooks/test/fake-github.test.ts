import { describe, expect, test } from 'bun:test';

import { FakeGitHub } from './fake-github.ts';

/** a - b - c (main) ; b - d - e (feature) */
function graph() {
	return new FakeGitHub()
		.commit('a', [], 'root')
		.commit('b', ['a'], 'second')
		.commit('c', ['b'], 'main tip')
		.commit('d', ['b'], 'feature one')
		.commit('e', ['d'], 'feature two');
}

describe('FakeGitHub.compare', () => {
	test('compare по графу: ahead, behind, identical, diverged', async () => {
		const gh = graph();
		expect(await gh.compare('acme/api', 'b', 'e')).toEqual({
			status: 'ahead',
			commits: [
				{ sha: 'd', message: 'feature one' },
				{ sha: 'e', message: 'feature two' },
			],
			truncated: false,
		});
		expect(await gh.compare('acme/api', 'e', 'b')).toEqual({
			status: 'behind',
			commits: [],
			truncated: false,
		});
		expect(await gh.compare('acme/api', 'c', 'c')).toEqual({
			status: 'identical',
			commits: [],
			truncated: false,
		});
		expect(await gh.compare('acme/api', 'c', 'e')).toEqual({
			status: 'diverged',
			commits: [
				{ sha: 'd', message: 'feature one' },
				{ sha: 'e', message: 'feature two' },
			],
			truncated: false,
		});
	});

	test('удалённый коммит — compare null', async () => {
		const gh = graph().removeCommit('d');
		expect(await gh.compare('acme/api', 'c', 'd')).toBeNull();
		expect(await gh.compare('acme/api', 'd', 'c')).toBeNull();
		// A child of the removed commit still resolves; the walk stops at the gap.
		expect((await gh.compare('acme/api', 'c', 'e'))?.commits.map((c) => c.sha)).toEqual(['e']);
	});

	test('больше 250 коммитов — первые 250 и truncated', async () => {
		const gh = new FakeGitHub().commit('base', [], 'base');
		let parent = 'base';
		for (let i = 0; i < 260; i++) {
			gh.commit(`n${i}`, [parent], `n${i}`);
			parent = `n${i}`;
		}
		const result = await gh.compare('acme/api', 'base', parent);
		expect(result?.commits).toHaveLength(250);
		expect(result?.commits[0]?.sha).toBe('n0');
		expect(result?.truncated).toBe(true);
	});
});

describe('FakeGitHub getCommit', () => {
	test('известный sha — сообщение, неизвестный — null', async () => {
		const gh = new FakeGitHub().commit('a1', [], 'ENG-1 one');
		expect(await gh.getCommit('acme/api', 'a1')).toEqual({ sha: 'a1', message: 'ENG-1 one' });
		expect(await gh.getCommit('acme/api', 'zz')).toBeNull();
	});
});

describe('FakeGitHub pulls', () => {
	test('mergedPullsForCommit: коммит ветки смёрдженного PR тоже находит PR; несмёрдженный — нет', async () => {
		const gh = new FakeGitHub()
			.pull({ repo: 'acme/api', number: 5 })
			.pull({ repo: 'acme/api', number: 6 })
			.mergePull('acme/api', 5, 'm5', ['b1', 'b2']);
		expect((await gh.mergedPullsForCommit('acme/api', 'b2')).map((p) => p.number)).toEqual([5]);
		expect((await gh.mergedPullsForCommit('acme/api', 'm5')).map((p) => p.number)).toEqual([5]);
		expect(await gh.mergedPullsForCommit('acme/web', 'b1')).toEqual([]);
		expect(await gh.mergedPullsForCommit('acme/api', 'b3')).toEqual([]);
	});

	test('PR: значения по умолчанию, merge, поиск по коммиту и ветке', async () => {
		const gh = new FakeGitHub()
			.pull({ repo: 'acme/api', number: 1, head: 'eng-1' })
			.pull({ repo: 'acme/api', number: 2, head: 'eng-2', title: 'Two' })
			.pull({ repo: 'acme/web', number: 1, head: 'eng-1' })
			.mergePull('acme/api', 2, 'm2');

		expect(await gh.getPull('acme/api', 1)).toEqual({
			repo: 'acme/api',
			number: 1,
			url: 'https://github.com/acme/api/pull/1',
			title: 'PR 1',
			body: '',
			head: 'eng-1',
			base: 'main',
			draft: false,
			state: 'open',
			merged: false,
			mergeSha: null,
		});
		expect(await gh.getPull('acme/api', 9)).toBeNull();
		expect(await gh.getPull('acme/api', 2)).toMatchObject({
			title: 'Two',
			state: 'closed',
			merged: true,
			mergeSha: 'm2',
		});
		expect((await gh.mergedPullsForCommit('acme/api', 'm2')).map((p) => p.number)).toEqual([2]);
		expect(await gh.mergedPullsForCommit('acme/web', 'm2')).toEqual([]);
		// Not the merge commit of PR 2 and not on its branch: no PR.
		expect(await gh.mergedPullsForCommit('acme/api', 'other')).toEqual([]);
		expect((await gh.openPullsForBranch('acme/api', 'eng-1')).map((p) => p.repo)).toEqual([
			'acme/api',
		]);
		expect(await gh.openPullsForBranch('acme/api', 'eng-2')).toEqual([]);
	});

	test('mergePull несуществующего PR — ошибка', () => {
		expect(() => new FakeGitHub().mergePull('acme/api', 1, 'm')).toThrow('no pull acme/api#1');
	});
});

describe('FakeGitHub deployments', () => {
	test('деплои: новые первыми, limit, окружение и репозиторий, последнее состояние', async () => {
		const gh = new FakeGitHub();
		const first = gh.deploy('acme/api', 'production', 's1', 'success');
		const second = gh.deploy('acme/api', 'production', 's2', 'failure', 'octocat');
		gh.deploy('acme/api', 'staging', 's3', 'success');
		gh.deploy('acme/web', 'production', 's4', 'success');

		expect(await gh.listDeployments('acme/api', 'production', 10)).toEqual([
			{
				id: second,
				repo: 'acme/api',
				sha: 's2',
				environment: 'production',
				creator: 'octocat',
				description: null,
			},
			{
				id: first,
				repo: 'acme/api',
				sha: 's1',
				environment: 'production',
				creator: 'github-actions[bot]',
				description: null,
			},
		]);
		expect(await gh.listDeployments('acme/api', 'production', 1)).toHaveLength(1);
		expect(await gh.latestState('acme/api', first)).toBe('success');
		expect(await gh.latestState('acme/api', second)).toBe('failure');
	});

	test('createDeployment без статуса — latestState null; статус дописывается', async () => {
		const gh = new FakeGitHub();
		const id = await gh.createDeployment('acme/api', {
			sha: 's1',
			environment: 'production',
			description: 'hub',
		});
		expect(await gh.latestState('acme/api', id)).toBeNull();
		await gh.createDeploymentStatus('acme/api', id, 'success', 'https://example.com/l');
		expect(await gh.latestState('acme/api', id)).toBe('success');
		expect((await gh.listDeployments('acme/api', 'production', 5))[0]).toMatchObject({
			id,
			creator: 'plane-hooks[bot]',
			description: 'hub',
		});
	});

	test('calls — журнал вызовов по порядку', async () => {
		const gh = new FakeGitHub().pull({ repo: 'acme/api', number: 1 });
		await gh.getPull('acme/api', 1);
		await gh.listDeployments('acme/api', 'staging', 5);
		await gh.compare('acme/api', 'a', 'b');
		expect(gh.calls).toEqual([
			'getPull acme/api#1',
			'listDeployments acme/api staging 5',
			'compare acme/api a...b',
		]);
	});

	test('статус неизвестного деплоя — ошибка', async () => {
		await expect(new FakeGitHub().latestState('acme/api', 5)).rejects.toThrow('no deployment');
	});
});
