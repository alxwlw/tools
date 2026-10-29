import { describe, expect, test } from 'bun:test';

import type { Tenant } from '../src/config.ts';
import { syncTask } from '../src/delivery/sync.ts';
import type { Pull } from '../src/github/client.ts';
import { tenantOf } from './config-fixture.ts';
import { BASE_PULL, tenantProjects, world } from './delivery-sync-world.ts';
import { FakeGitHub } from './fake-github.ts';

describe('syncTask: цепочка PR', () => {
	test('PR готов к ревью — In Progress → In Review, комментарий со ссылкой на PR', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 feature' });
		const result = await syncTask(w.deps, 'ENG-1', w.pr());
		expect(result).toEqual({
			key: 'ENG-1',
			action: 'moved',
			from: 'In Progress',
			to: 'In Review',
		});
		expect(w.stateOf(id)).toBe('eng-in-review');
		const [comment, ...rest] = w.plane.commentsOf(id);
		expect(rest).toEqual([]);
		expect(comment?.external_id).toBe(`state:${id}:eng-in-review:pr:acme/api#1:d1`);
		expect(comment?.external_source).toBe('plane-hooks');
		expect(comment?.comment_html).toBe(
			'<p>Статус → <b>In Review</b>: <a href="https://github.com/acme/api/pull/1">acme/api#1</a></p>',
		);
	});

	test('черновой PR второго репозитория держит задачу', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress', [
			['acme/api', 1],
			['acme/infra', 2],
		]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		w.gh.pull({ repo: 'acme/infra', number: 2, title: 'ENG-1 infra', draft: true });
		const result = await syncTask(w.deps, 'ENG-1', w.pr());
		expect(result).toMatchObject({ action: 'noop', reason: 'draft' });
		expect(w.stateOf(id)).toBe('eng-in-progress');
	});

	test('по самому отстающему: api на staging, infra смёрджен — On staging', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Review', [
			['acme/api', 1],
			['acme/infra', 2],
		]);
		w.gh.commit('m1', [], 'api merge').commit('m2', [], 'infra merge');
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' }).mergePull('acme/api', 1, 'm1');
		w.gh
			.pull({ repo: 'acme/infra', number: 2, title: 'ENG-1 infra' })
			.mergePull('acme/infra', 2, 'm2');
		w.gh.deploy('acme/api', 'staging', 'm1', 'success');
		const result = await syncTask(w.deps, 'ENG-1', w.pr());
		expect(result).toMatchObject({ action: 'moved', to: 'On staging' });
		expect(w.stateOf(id)).toBe('eng-on-staging');
	});

	test('Done — только когда оба PR дошли: api в production, infra смёрджен', async () => {
		const w = world();
		const id = w.item('ENG-1', 'On staging', [
			['acme/api', 1],
			['acme/infra', 2],
		]);
		w.gh.commit('m1', [], 'api merge').commit('m2', [], 'infra merge');
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' }).mergePull('acme/api', 1, 'm1');
		w.gh
			.pull({ repo: 'acme/infra', number: 2, title: 'ENG-1 infra' })
			.mergePull('acme/infra', 2, 'm2');
		w.gh.deploy('acme/api', 'production', 'm1', 'success');
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({ action: 'moved', to: 'Done' });
		expect(w.stateOf(id)).toBe('eng-done');
	});

	test('смёрдженный, но не выкаченный PR api — In Review', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w.gh.commit('m1', [], 'api merge');
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' }).mergePull('acme/api', 1, 'm1');
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({
			action: 'moved',
			to: 'In Review',
		});
		expect(w.stateOf(id)).toBe('eng-in-review');
	});

	test('закрытый без merge PR не считается', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress', [
			['acme/api', 1],
			['acme/infra', 2],
		]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api', state: 'closed' });
		w.gh.pull({ repo: 'acme/infra', number: 2, title: 'ENG-1 infra' });
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({
			action: 'moved',
			to: 'In Review',
		});
		expect(w.stateOf(id)).toBe('eng-in-review');
	});

	test('только закрытые без merge PR — ничего не двигает', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api', state: 'closed' });
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({ action: 'noop' });
		expect(w.stateOf(id)).toBe('eng-in-progress');
	});

	test('PR события из extra и PR из ссылок не дублируются: extra свежее ссылки', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		const fresh: Pull = {
			repo: 'acme/api',
			number: 1,
			url: 'https://github.com/acme/api/pull/1',
			title: 'ENG-1 api',
			body: '',
			head: 'b',
			base: 'main',
			draft: true,
			state: 'open',
			merged: false,
			mergeSha: null,
		};
		expect(await syncTask(w.deps, 'ENG-1', w.pr(fresh), [fresh])).toMatchObject({
			action: 'noop',
			reason: 'draft',
		});
		expect(w.stateOf(id)).toBe('eng-in-progress');
		expect(w.gh.calls.filter((c) => c.startsWith('getPull acme/api#1'))).toEqual([]);
	});

	test('extra без ссылки в задаче — PR события считается', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress');
		const pull: Pull = {
			repo: 'acme/api',
			number: 5,
			url: 'https://github.com/acme/api/pull/5',
			title: 'ENG-1 api',
			body: '',
			head: 'b',
			base: 'main',
			draft: false,
			state: 'open',
			merged: false,
			mergeSha: null,
		};
		expect(await syncTask(w.deps, 'ENG-1', w.pr(pull), [pull])).toMatchObject({ action: 'moved' });
		expect(w.stateOf(id)).toBe('eng-in-review');
	});
});

describe('syncTask: куда нельзя', () => {
	test('только вперёд: задача в Done не возвращается', async () => {
		const w = world();
		const id = w.item('ENG-1', 'Done', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({ action: 'noop' });
		expect(w.stateOf(id)).toBe('eng-done');
		expect(w.plane.calls).not.toContain('setWorkItemState');
	});

	test('цель равна текущему состоянию — не пишем', async () => {
		const w = world();
		w.item('ENG-1', 'In Review', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({ action: 'noop' });
		expect(w.plane.calls).not.toContain('setWorkItemState');
		expect(w.plane.calls).not.toContain('createComment');
	});

	test('только вперёд: из On staging назад в In Review не идёт', async () => {
		const w = world();
		const id = w.item('ENG-1', 'On staging', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({ action: 'noop' });
		expect(w.stateOf(id)).toBe('eng-on-staging');
		expect(w.plane.calls).not.toContain('setWorkItemState');
	});

	test('из Cancelled не двигается', async () => {
		const w = world();
		const id = w.item('ENG-1', 'Cancelled', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({
			action: 'noop',
			reason: 'hold',
		});
		expect(w.stateOf(id)).toBe('eng-cancelled');
	});

	test('из hold не двигается', async () => {
		const base = tenantOf();
		const tenant = tenantOf({
			delivery: { ...(base.delivery as NonNullable<Tenant['delivery']>), hold: ['Needs info'] },
		});
		const w = world(tenant);
		const id = w.item('QA-1', 'Needs info', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'QA-1 api' });
		expect(await syncTask(w.deps, 'QA-1', w.pr())).toMatchObject({
			action: 'noop',
			reason: 'hold',
		});
		expect(w.stateOf(id)).toBe('qa-needs-info');
	});

	test('проект инцидентов не трогается', async () => {
		const w = world();
		const id = w.item('INC-3', 'In Progress', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'INC-3 hotfix' });
		expect(await syncTask(w.deps, 'INC-3', w.pr())).toEqual({
			key: 'INC-3',
			action: 'skipped',
			reason: 'incident project',
		});
		expect(w.stateOf(id)).toBe('inc-in-progress');
		expect(w.plane.calls).not.toContain('setWorkItemState');
	});

	test('неизвестный ключ — skipped', async () => {
		const w = world();
		expect(await syncTask(w.deps, 'ENG-99', w.pr())).toEqual({
			key: 'ENG-99',
			action: 'skipped',
			reason: 'unknown key',
		});
	});
});

describe('syncTask: проекты', () => {
	test('QA: прод-деплой ставит Ready for retest, Done — никогда', async () => {
		const w = world();
		const id = w.item('QA-1', 'In Progress', [['acme/api', 1]]);
		w.gh.commit('m1', [], 'merge');
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'QA-1 api' }).mergePull('acme/api', 1, 'm1');
		w.gh.deploy('acme/api', 'production', 'm1', 'success');
		expect(await syncTask(w.deps, 'QA-1', w.pr())).toMatchObject({
			action: 'moved',
			to: 'Ready for retest',
		});
		expect(w.stateOf(id)).toBe('qa-ready-for-retest');
	});

	test('в проекте нет In Review (OPS) — открытый PR ничего не двигает, warn один раз', async () => {
		const w = world();
		const id = w.item('OPS-1', 'In Progress', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'OPS-1 api' });
		expect(await syncTask(w.deps, 'OPS-1', w.pr())).toMatchObject({
			action: 'noop',
			reason: 'unresolved',
		});
		expect(w.stateOf(id)).toBe('ops-in-progress');
		expect(w.warns).toHaveLength(1);
		expect(w.warns[0]).toEqual({
			reason: 'state_missing:OPS:In Review',
			entry: { project: 'OPS', state: 'In Review' },
		});
	});

	test('null в projects — состояние не ставится, и это не warn', async () => {
		const base = tenantOf().delivery as NonNullable<Tenant['delivery']>;
		const w = world(tenantOf({ delivery: { ...base, projects: { ENG: { 'In Review': null } } } }));
		const id = w.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({
			action: 'noop',
			reason: 'unresolved',
		});
		expect(w.stateOf(id)).toBe('eng-in-progress');
		expect(w.warns).toEqual([]);
	});

	test('нет On staging в проекте — позиция падает на In Review, остальное работает', async () => {
		const base = tenantOf().delivery as NonNullable<Tenant['delivery']>;
		const renamed = tenantOf({
			delivery: { ...base, projects: { ENG: { 'On staging': null } } },
		});
		const w2 = world(renamed);
		const id = w2.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w2.gh.commit('m1', [], 'merge');
		w2.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' }).mergePull('acme/api', 1, 'm1');
		w2.gh.deploy('acme/api', 'staging', 'm1', 'success');
		expect(await syncTask(w2.deps, 'ENG-1', w2.pr())).toMatchObject({ to: 'In Review' });
		expect(w2.stateOf(id)).toBe('eng-in-review');
		expect(w2.warns).toEqual([]);
	});
});

describe('syncTask: PR, которого хаб не видит', () => {
	test('PR чужой организации, удалённый (404) и репозиторий без правила не считаются и не блокируют', async () => {
		const base = tenantOf().delivery as NonNullable<Tenant['delivery']>;
		const w = world(
			tenantOf({
				delivery: { ...base, repos: [...base.repos, { repo: 'other/*', environments: [] }] },
			}),
		);
		const id = w.item('ENG-1', 'In Progress', [
			['acme/api', 1],
			['other/api', 2],
			['acme/api', 99],
			['zzz/lib', 3],
		]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		w.gh.pull({ repo: 'other/api', number: 2, title: 'ENG-1 other', draft: true });
		w.gh.pull({ repo: 'zzz/lib', number: 3, title: 'ENG-1 lib', draft: true });
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({
			action: 'moved',
			to: 'In Review',
		});
		expect(w.stateOf(id)).toBe('eng-in-review');
		// No rule or no App: the hub does not even ask GitHub.
		expect(w.gh.calls.some((c) => c.includes('zzz/lib') || c.includes('other/api'))).toBe(false);
	});

	test('ключ только в описании PR — задача не двигается', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'unrelated', body: 'see ENG-1' });
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toEqual({
			key: 'ENG-1',
			action: 'noop',
			reason: 'no pulls',
		});
		expect(w.stateOf(id)).toBe('eng-in-progress');
	});

	test('PR с чужим ключом в заголовке — не принадлежит задаче', async () => {
		const w = world();
		w.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-2 other task' });
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({ reason: 'no pulls' });
	});

	test('ссылка на не-PR URL игнорируется', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress');
		w.plane.links.push({
			id: 'l-x',
			project: 'p-eng',
			workItemId: id,
			url: 'https://example.com/acme/api/pull/1',
			title: 'x',
		});
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({ reason: 'no pulls' });
		expect(w.gh.calls).toEqual([]);
	});
});

describe('syncTask: комментарии перехода', () => {
	test('повтор той же причины — один комментарий', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		await syncTask(w.deps, 'ENG-1', w.pr());
		await w.plane.setWorkItemState('p-eng', id, 'eng-in-progress');
		const second = await syncTask(w.deps, 'ENG-1', w.pr());
		expect(second).toMatchObject({ action: 'moved' });
		expect(w.stateOf(id)).toBe('eng-in-review');
		expect(w.plane.commentsOf(id)).toHaveLength(1);
	});

	test('другая доставка — новый комментарий', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		await syncTask(w.deps, 'ENG-1', w.pr(null, 'd1'));
		await w.plane.setWorkItemState('p-eng', id, 'eng-in-progress');
		await syncTask(w.deps, 'ENG-1', w.pr(null, 'd2'));
		expect(w.plane.commentsOf(id).map((c) => c.external_id)).toEqual([
			`state:${id}:eng-in-review:pr:acme/api#1:d1`,
			`state:${id}:eng-in-review:pr:acme/api#1:d2`,
		]);
	});

	test('деплой: причина с sha, текст с sha7 и окружением', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Review', [['acme/api', 1]]);
		w.gh.commit('abcdef1234567', [], 'merge');
		w.gh
			.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' })
			.mergePull('acme/api', 1, 'abcdef1234567');
		w.gh.deploy('acme/api', 'staging', 'abcdef1234567', 'success');
		await syncTask(w.deps, 'ENG-1', {
			kind: 'deploy',
			repo: 'acme/api',
			environment: 'staging',
			sha: 'abcdef1234567',
		});
		const [comment] = w.plane.commentsOf(id);
		expect(comment?.external_id).toBe(
			`state:${id}:eng-on-staging:deploy:acme/api:staging:abcdef1234567`,
		);
		expect(comment?.comment_html).toBe(
			'<p>Статус → <b>On staging</b>: деплой <code>abcdef1</code> в <code>staging</code></p>',
		);
	});
});

describe('syncTask: края', () => {
	test('delivery выключен — skipped', async () => {
		const w = world(tenantOf({ delivery: null }));
		w.item('ENG-1', 'In Progress');
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toEqual({
			key: 'ENG-1',
			action: 'skipped',
			reason: 'delivery off',
		});
	});

	test('самый отстающий не зависит от порядка ссылок', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Review', [
			['acme/infra', 2],
			['acme/api', 1],
		]);
		w.gh.commit('m1', [], 'api merge').commit('m2', [], 'infra merge');
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' }).mergePull('acme/api', 1, 'm1');
		w.gh
			.pull({ repo: 'acme/infra', number: 2, title: 'ENG-1 infra' })
			.mergePull('acme/infra', 2, 'm2');
		w.gh.deploy('acme/api', 'staging', 'm1', 'success');
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({ to: 'On staging' });
		expect(w.stateOf(id)).toBe('eng-on-staging');
	});

	test('один PR не находит шага в проекте — задача стоит, хоть другой дошёл до Done', async () => {
		const w = world();
		const id = w.item('OPS-1', 'In Progress', [
			['acme/api', 1],
			['acme/infra', 2],
		]);
		w.gh.commit('m2', [], 'infra merge');
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'OPS-1 api' });
		w.gh
			.pull({ repo: 'acme/infra', number: 2, title: 'OPS-1 infra' })
			.mergePull('acme/infra', 2, 'm2');
		expect(await syncTask(w.deps, 'OPS-1', w.pr())).toMatchObject({
			action: 'noop',
			reason: 'unresolved',
		});
		expect(w.stateOf(id)).toBe('ops-in-progress');
	});

	test('состояние задачи, которого нет в проекте, — noop', async () => {
		const w = world();
		const item = w.plane.seedWorkItem('p-eng', { sequence: 1, state: 'gone' });
		w.plane.links.push({
			id: 'l1',
			project: 'p-eng',
			workItemId: item.id,
			url: 'https://github.com/acme/api/pull/1',
			title: 't',
		});
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({ reason: 'unknown state' });
		expect(w.plane.calls).not.toContain('setWorkItemState');
	});

	test('extra репозитория без правила не считается', async () => {
		const w = world();
		w.item('ENG-1', 'In Progress');
		const pull = { ...BASE_PULL, repo: 'zzz/lib', draft: true, title: 'ENG-1 lib' };
		expect(await syncTask(w.deps, 'ENG-1', w.pr(pull), [pull])).toMatchObject({
			reason: 'no pulls',
		});
	});

	test('одна и та же ссылка дважды — PR запрашивается один раз', async () => {
		const w = world();
		w.item('ENG-1', 'In Progress', [
			['acme/api', 1],
			['acme/api', 1],
		]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		await syncTask(w.deps, 'ENG-1', w.pr());
		expect(w.gh.calls.filter((c) => c === 'getPull acme/api#1')).toHaveLength(1);
	});
});

describe('syncTask: несколько задач, сбои записи, переименования', () => {
	function twoTasks(w: ReturnType<typeof world>) {
		const a = w.item('ENG-1', 'In Review', [['acme/api', 1]]);
		const b = w.item('ENG-2', 'In Review', [['acme/api', 1]]);
		w.gh.commit('m1', [], 'merge');
		w.gh
			.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 ENG-2 fix' })
			.mergePull('acme/api', 1, 'm1');
		w.gh.deploy('acme/api', 'staging', 'm1', 'success');
		return [a, b] as const;
	}

	test('один деплой двигает две задачи проекта — по комментарию на каждую', async () => {
		const w = world();
		const [a, b] = twoTasks(w);
		const cause = { kind: 'deploy' as const, repo: 'acme/api', environment: 'staging', sha: 'm1' };
		await syncTask(w.deps, 'ENG-1', cause);
		await syncTask(w.deps, 'ENG-2', cause);
		expect(w.plane.commentsOf(a)).toHaveLength(1);
		expect(w.plane.commentsOf(b)).toHaveLength(1);
		expect([w.stateOf(a), w.stateOf(b)]).toEqual(['eng-on-staging', 'eng-on-staging']);
	});

	test('один PR с двумя ключами — по комментарию на каждую задачу', async () => {
		const w = world();
		const [a, b] = twoTasks(w);
		await syncTask(w.deps, 'ENG-1', w.pr());
		await syncTask(w.deps, 'ENG-2', w.pr());
		expect(w.plane.commentsOf(a)).toHaveLength(1);
		expect(w.plane.commentsOf(b)).toHaveLength(1);
	});

	test('человек перевёл задачу в Done, пока шли запросы, — состояние остаётся', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		let first = true;
		w.deps.github = async () => {
			if (first) {
				first = false;
				await w.plane.setWorkItemState('p-eng', id, 'eng-done');
			}
			return w.gh;
		};
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({ action: 'noop' });
		expect(w.stateOf(id)).toBe('eng-done');
		expect(w.plane.commentsOf(id)).toHaveLength(0);
	});

	test('сбой записи комментария — повтор даёт один комментарий и переход', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		w.plane.failNext('createComment');
		await expect(syncTask(w.deps, 'ENG-1', w.pr())).rejects.toThrow();
		expect(w.stateOf(id)).toBe('eng-in-progress');
		expect(await syncTask(w.deps, 'ENG-1', w.pr())).toMatchObject({ action: 'moved' });
		expect(w.plane.commentsOf(id)).toHaveLength(1);
		expect(w.stateOf(id)).toBe('eng-in-review');
	});

	test('сбой записи состояния после комментария — повтор не дублирует комментарий', async () => {
		const w = world();
		const id = w.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' });
		w.plane.failNext('setWorkItemState');
		await expect(syncTask(w.deps, 'ENG-1', w.pr())).rejects.toThrow();
		await syncTask(w.deps, 'ENG-1', w.pr());
		expect(w.plane.commentsOf(id)).toHaveLength(1);
		expect(w.stateOf(id)).toBe('eng-in-review');
	});

	test('ключ переименования без учёта регистра', async () => {
		const w = world(tenantProjects({ QA: { done: 'Ready for retest' } }));
		const id = w.item('QA-1', 'In Progress', [['acme/api', 1]]);
		w.gh.commit('m1', [], 'merge');
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'QA-1 api' }).mergePull('acme/api', 1, 'm1');
		w.gh.deploy('acme/api', 'production', 'm1', 'success');
		await syncTask(w.deps, 'QA-1', w.pr());
		expect(w.stateOf(id)).toBe('qa-ready-for-retest');
	});

	test('переименование в несуществующее состояние — шаг назад и один warn', async () => {
		const w = world(tenantProjects({ ENG: { 'On staging': 'Staged' } }));
		const id = w.item('ENG-1', 'In Progress', [['acme/api', 1]]);
		w.gh.commit('m1', [], 'merge');
		w.gh.pull({ repo: 'acme/api', number: 1, title: 'ENG-1 api' }).mergePull('acme/api', 1, 'm1');
		w.gh.deploy('acme/api', 'staging', 'm1', 'success');
		await syncTask(w.deps, 'ENG-1', w.pr());
		expect(w.stateOf(id)).toBe('eng-in-review');
		expect(w.warns).toEqual([
			{ reason: 'state_missing:ENG:Staged', entry: { project: 'ENG', state: 'Staged' } },
		]);
	});

	test('projects называет проект, которого нет в Plane, — warn', async () => {
		const w = world(tenantProjects({ NOPE: { Done: 'X' } }));
		w.item('ENG-1', 'In Progress');
		await syncTask(w.deps, 'ENG-1', w.pr());
		expect(w.warns).toEqual([{ reason: 'project_missing:NOPE', entry: { project: 'NOPE' } }]);
	});

	test('переименование в Cancelled не делает его целью', async () => {
		const w = world(tenantProjects({ ENG: { Done: 'Cancelled' } }));
		const id = w.item('ENG-1', 'In Progress', [['acme/infra', 2]]);
		w.gh.commit('m2', [], 'merge');
		w.gh
			.pull({ repo: 'acme/infra', number: 2, title: 'ENG-1 infra' })
			.mergePull('acme/infra', 2, 'm2');
		await syncTask(w.deps, 'ENG-1', w.pr());
		expect(w.stateOf(id)).toBe('eng-in-review');
		expect(w.warns.map((x) => x.reason)).toEqual(['state_missing:ENG:Cancelled']);
	});
});
