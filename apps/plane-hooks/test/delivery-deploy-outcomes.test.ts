import { describe, expect, test } from 'bun:test';

import { handleDeploy } from '../src/delivery/deploy.ts';
import { PlaneApiError } from '../src/plane.ts';
import { publishRelease, type ReleaseDraft, type ReleaseItem } from '../src/release.ts';
import { tenantOf } from './config-fixture.ts';
import { fact, keysOf, REPO, setup, squash } from './delivery-deploy-world.ts';

describe('handleDeploy: ignored, релиз, сбои', () => {
	test('окружение не из конфига (Preview – docs) — ignored, курсор не тронут', async () => {
		const w = setup();
		w.gh.commit('a0', [], 'init');
		squash(w, 'a1', 'a0', 1, 'ENG-1');
		const id = w.item('ENG-1', 'In Review');
		const planeCalls = w.plane.calls.length;

		const result = await handleDeploy(w.deps, fact('a1', { environment: 'Preview – docs' }));

		expect(result).toEqual({
			action: 'ignored',
			notes: [],
			synced: [],
			release: null,
			releaseError: null,
			title: 'acme/api → Preview – docs · a1',
		});
		expect(w.cursor.get(REPO, 'Preview – docs')).toBeNull();
		expect(w.plane.calls).toHaveLength(planeCalls);
		expect(w.gh.calls).toEqual([]);
		expect(w.plane.commentsOf(id)).toEqual([]);
	});

	test('репозиторий без правила, тенант без delivery, репозиторий без App — ignored', async () => {
		const w = setup();
		expect((await handleDeploy(w.deps, fact('a1', { repo: 'zeta/lib' }))).action).toBe('ignored');
		const off = setup(tenantOf({ delivery: null }));
		expect((await handleDeploy(off.deps, fact('a1'))).action).toBe('ignored');

		const delivery = tenantOf().delivery;
		const noApp = setup(
			tenantOf({
				delivery: {
					...(delivery as NonNullable<typeof delivery>),
					repos: [
						{
							repo: 'other/*',
							environments: [{ name: 'production', state: 'Done', release: false }],
						},
					],
				},
			}),
		);
		const result = await handleDeploy(
			noApp.deps,
			fact('a1', { repo: 'other/lib', environment: 'production' }),
		);
		expect(result.action).toBe('ignored');
		expect(noApp.warns).toEqual([{ reason: 'no_app:other/lib', entry: { repo: 'other/lib' } }]);
		expect(noApp.cursor.get('other/lib', 'production')).toBeNull();
	});

	function releaseHistory() {
		const w = setup();
		w.gh.commit('a0', [], 'init');
		w.gh.commit('s1', ['a0'], 'ENG-1 change (#1)');
		w.gh.pull({ repo: REPO, number: 1, title: 'ENG-1 change' }).mergePull(REPO, 1, 's1');
		w.gh.commit('m1', ['a0', 's1'], 'Merge pull request #5 from acme/staging\n\nRelease 2026.10');
		w.gh
			.pull({ repo: REPO, number: 5, title: 'Release 2026.10', head: 'staging' })
			.mergePull(REPO, 5, 'm1', ['s1']);
		w.gh.deploy(REPO, 'production', 'a0', 'success');
		const last = w.gh.deploy(REPO, 'production', 'm1', 'success');
		const id = w.item('ENG-1', 'In Review');
		return { w, id, fact: fact('m1', { environment: 'production', deploymentId: last }) };
	}

	test('прод с release — релиз с задачами, имя с заголовком PR merge-коммита', async () => {
		const { w, id, fact: deploy } = releaseHistory();
		const deps = {
			...w.deps,
			releases: (d: ReleaseDraft, i: ReleaseItem[]) => publishRelease({ plane: w.plane }, d, i),
		};

		const result = await handleDeploy(deps, deploy);

		expect(result.action).toBe('delivered');
		expect(result.release).toEqual({
			action: 'created',
			releaseId: result.release?.releaseId as string,
		});
		expect(result.releaseError).toBeNull();
		expect(w.plane.releases).toHaveLength(1);
		expect(w.plane.releases[0]).toMatchObject({
			name: '2026-10-28 · m1 — Release 2026.10',
			external_source: 'github-deploy',
			external_id: 'acme/api@m1',
			workItemIds: [id],
		});
		expect(w.stateOf(id)).toBe('eng-done');
		expect(keysOf(result)).toEqual(['ENG-1']);
	});

	test('релиз получает черновик: коммиты от новых к старым, заголовок, ссылку на прогон', async () => {
		const { w, id, fact: deploy } = releaseHistory();

		await handleDeploy(w.deps, deploy);

		expect(w.releases).toEqual([
			{
				draft: {
					repository: REPO,
					sha: 'm1',
					at: '2026-10-28T10:00:00.000Z',
					runUrl: 'https://github.com/acme/api/actions/runs/1',
					commits: [
						{ sha: 'm1', message: 'Merge pull request #5 from acme/staging\n\nRelease 2026.10' },
						{ sha: 's1', message: 'ENG-1 change (#1)' },
					],
					headline: 'Release 2026.10',
				},
				items: [{ key: 'ENG-1', workItemId: id }],
			},
		]);
	});

	test('релиз упал (402) — Выкачено и статусы сделаны, releaseError заполнен', async () => {
		const { w, id, fact: deploy } = releaseHistory();
		w.failReleaseWith(new PlaneApiError(402, 'POST', '/releases/'));

		const result = await handleDeploy(w.deps, deploy);

		expect(result.action).toBe('delivered');
		expect(result.release).toBeNull();
		expect(result.releaseError).toBe('PlaneApiError: Plane POST /releases/ → 402');
		expect(w.stateOf(id)).toBe('eng-done');
		expect(w.commentIds(id)[0]).toBe(`deployed:${id}:acme/api:production:m1`);
		expect(w.cursor.get(REPO, 'production')).toBe('m1');
	});

	test('релиз упал (403, у бота нет скоупа релизов) — Выкачено сделано, releaseError заполнен', async () => {
		const { w, id, fact: deploy } = releaseHistory();
		w.failReleaseWith(new PlaneApiError(403, 'POST', '/releases/'));

		const result = await handleDeploy(w.deps, deploy);

		expect(result.action).toBe('delivered');
		expect(result.release).toBeNull();
		expect(result.releaseError).toBe('PlaneApiError: Plane POST /releases/ → 403');
		expect(w.stateOf(id)).toBe('eng-done');
		expect(w.cursor.get(REPO, 'production')).toBe('m1');
	});

	test('сбой Plane посреди деплоя — курсор прежний; повтор доводит до конца без дублей', async () => {
		const w = setup();
		w.gh.commit('a0', [], 'init');
		squash(w, 'a1', 'a0', 1, 'ENG-1');
		squash(w, 'a2', 'a1', 2, 'ENG-2');
		for (const sha of ['a0', 'a1', 'a2']) w.gh.deploy(REPO, 'staging', sha, 'success');
		const ids = [w.item('ENG-1', 'In Review'), w.item('ENG-2', 'In Review')] as [string, string];
		w.cursor.set(REPO, 'staging', 'a0');
		w.plane.failNext('setWorkItemState');

		await expect(handleDeploy(w.deps, fact('a2', { deploymentId: 3 }))).rejects.toThrow('500');

		expect(w.cursor.get(REPO, 'staging')).toBe('a0');
		expect(w.stateOf(ids[0])).toBe('eng-in-review');
		const retry = await handleDeploy(w.deps, fact('a2', { deploymentId: 3 }));

		expect(retry.action).toBe('delivered');
		expect(retry.notes.map((n) => n.created)).toEqual([false, true]);
		expect(w.cursor.get(REPO, 'staging')).toBe('a2');
		for (const id of ids) {
			expect(w.stateOf(id)).toBe('eng-on-staging');
			expect(w.plane.commentsOf(id)).toHaveLength(2);
			expect(w.linksOf(id)).toHaveLength(1);
		}
		expect(w.commentIds(ids[0])).toEqual([
			`deployed:${ids[0]}:acme/api:staging:a2`,
			`state:${ids[0]}:eng-on-staging:deploy:acme/api:staging:a2`,
		]);
	});

	test('проект закрыт для бота (403) — его задачи пропущены, остальные доставлены, курсор сдвинут', async () => {
		const w = setup();
		w.gh.commit('a0', [], 'init');
		squash(w, 'a1', 'a0', 1, 'ENG-1');
		squash(w, 'a2', 'a1', 2, 'OPS-5');
		w.gh.deploy(REPO, 'staging', 'a0', 'success');
		w.gh.deploy(REPO, 'staging', 'a2', 'success');
		w.item('ENG-1', 'In Review');
		const ops = w.item('OPS-5', 'In Progress');
		w.plane.forbiddenProjects.add('p-eng');
		w.cursor.set(REPO, 'staging', 'a0');

		const result = await handleDeploy(w.deps, fact('a2', { deploymentId: 2 }));

		expect(keysOf(result)).toEqual(['OPS-5']);
		expect(w.commentIds(ops)[0]).toBe(`deployed:${ops}:acme/api:staging:a2`);
		expect(w.warns.some((x) => x.reason === 'plane_forbidden:ENG')).toBe(true);
		expect(w.cursor.get(REPO, 'staging')).toBe('a2');
	});

	test('задача исчезла между чтением и комментарием (404) — пропущена, остальные доставлены', async () => {
		const w = setup();
		w.gh.commit('a0', [], 'init');
		squash(w, 'a1', 'a0', 1, 'ENG-1');
		squash(w, 'a2', 'a1', 2, 'ENG-2');
		for (const sha of ['a0', 'a2']) w.gh.deploy(REPO, 'staging', sha, 'success');
		const first = w.item('ENG-1', 'In Review');
		const second = w.item('ENG-2', 'In Review');
		w.cursor.set(REPO, 'staging', 'a0');
		w.plane.failNext('createComment', new PlaneApiError(404, 'POST', '/comments/'));

		const result = await handleDeploy(w.deps, fact('a2', { deploymentId: 2 }));

		expect(keysOf(result)).toEqual(['ENG-2']);
		expect(w.plane.commentsOf(first)).toEqual([]);
		expect(w.stateOf(second)).toBe('eng-on-staging');
		expect(w.warns.some((x) => x.reason === 'plane_not_found:ENG')).toBe(true);
		expect(w.cursor.get(REPO, 'staging')).toBe('a2');
	});

	test('прод: прямой push без PR — релиз без заголовка, runUrl пуст без ссылки на прогон', async () => {
		const w = setup();
		w.gh.commit('a0', [], 'init').commit('a1', ['a0'], 'ENG-4 hotfix');
		w.gh.deploy(REPO, 'production', 'a0', 'success');
		const last = w.gh.deploy(REPO, 'production', 'a1', 'success');
		w.item('ENG-4', 'In Progress');

		await handleDeploy(
			w.deps,
			fact('a1', { environment: 'production', deploymentId: last, logUrl: null }),
		);

		expect(w.releases).toHaveLength(1);
		expect(w.releases[0]?.draft).toEqual({
			repository: REPO,
			sha: 'a1',
			at: '2026-10-28T10:00:00.000Z',
			runUrl: '',
			commits: [{ sha: 'a1', message: 'ENG-4 hotfix' }],
		});
	});
});
