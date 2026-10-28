import { describe, expect, test } from 'bun:test';

import {
	type DeployCursor,
	type DeployFact,
	type DeployResult,
	handleDeploy,
} from '../src/delivery/deploy.ts';
import type { ReleaseDraft } from '../src/deploy-note.ts';
import { PlaneApiError } from '../src/plane.ts';
import { publishRelease, type ReleaseItem, type ReleaseResult } from '../src/release.ts';
import { Store } from '../src/store.ts';
import { tenantOf } from './config-fixture.ts';
import { deliveryWorld } from './delivery-world.ts';

const REPO = 'acme/api';

function setup(tenant = tenantOf()) {
	const w = deliveryWorld(tenant);
	const store = new Store(':memory:');
	const cursor = store.cursorFor('acme');
	const releases: Array<{ draft: ReleaseDraft; items: ReleaseItem[] }> = [];
	let releaseFailure: Error | null = null;
	const deps = {
		...w.deps,
		cursor,
		releases: async (draft: ReleaseDraft, items: ReleaseItem[]): Promise<ReleaseResult> => {
			releases.push({ draft, items });
			if (releaseFailure) throw releaseFailure;
			return { action: 'created', releaseId: 'r1' };
		},
	};
	return {
		...w,
		deps,
		cursor,
		releases,
		failReleaseWith: (err: Error) => {
			releaseFailure = err;
		},
	};
}

function fact(sha: string, over: Partial<DeployFact> = {}): DeployFact {
	return {
		repo: REPO,
		environment: 'staging',
		sha,
		deploymentId: null,
		logUrl: 'https://github.com/acme/api/actions/runs/1',
		at: '2026-10-28T10:00:00.000Z',
		...over,
	};
}

/** A squash-merged PR: the commit, the PR with a key in its title, its merge. */
function squash(
	w: ReturnType<typeof setup>,
	sha: string,
	parent: string,
	number: number,
	key: string,
) {
	w.gh.commit(sha, [parent], `${key} change (#${number})`);
	w.gh.pull({ repo: REPO, number, title: `${key} change` }).mergePull(REPO, number, sha);
}

const keysOf = (r: DeployResult) => r.notes.map((n) => n.key);

describe('handleDeploy: доставка', () => {
	test('staging: PR из диапазона от прошлого деплоя — Выкачено и On staging', async () => {
		const w = setup();
		w.gh.commit('a0', [], 'init');
		squash(w, 'a1', 'a0', 1, 'ENG-1');
		w.gh.deploy(REPO, 'staging', 'a0', 'success');
		const id1 = w.gh.deploy(REPO, 'staging', 'a1', 'success');
		const id = w.item('ENG-1', 'In Review');

		const result = await handleDeploy(w.deps, fact('a1', { deploymentId: id1 }));

		expect(result).toEqual({
			action: 'delivered',
			notes: [{ key: 'ENG-1', workItemId: id, created: true }],
			synced: [{ key: 'ENG-1', action: 'moved', from: 'In Review', to: 'On staging' }],
			release: null,
			releaseError: null,
			title: 'acme/api → staging · a1',
		});
		expect(w.stateOf(id)).toBe('eng-on-staging');
		expect(w.commentIds(id)).toEqual([
			`deployed:${id}:acme/api:staging:a1`,
			`state:${id}:eng-on-staging:deploy:acme/api:staging:a1`,
		]);
		expect(w.plane.commentsOf(id)[0]?.comment_html).toBe(
			'<p>Выкачено: <code>acme/api</code> → staging · <code>a1</code> · <a href="https://github.com/acme/api/actions/runs/1">прогон</a> · PR: <a href="https://github.com/acme/api/pull/1">acme/api#1</a></p>',
		);
		expect(w.plane.commentsOf(id)[0]?.external_source).toBe('plane-hooks');
		expect(w.linksOf(id).map((l) => [l.url, l.title])).toEqual([
			['https://github.com/acme/api/pull/1', 'GitHub: acme/api#1'],
		]);
		expect(w.releases).toEqual([]);
		expect(w.cursor.get(REPO, 'staging')).toBe('a1');
	});

	test('многокоммитный деплой: задачи всех PR диапазона, не только последнего коммита', async () => {
		const w = setup();
		w.gh.commit('a0', [], 'init');
		squash(w, 'a1', 'a0', 1, 'ENG-1');
		squash(w, 'a2', 'a1', 2, 'ENG-2');
		squash(w, 'a3', 'a2', 3, 'ENG-3');
		w.gh.deploy(REPO, 'staging', 'a0', 'success');
		const last = w.gh.deploy(REPO, 'staging', 'a3', 'success');
		const ids = ['ENG-1', 'ENG-2', 'ENG-3'].map((key) => w.item(key, 'In Review'));

		const result = await handleDeploy(w.deps, fact('a3', { deploymentId: last }));

		expect(keysOf(result)).toEqual(['ENG-1', 'ENG-2', 'ENG-3']);
		expect(ids.map((id) => w.stateOf(id))).toEqual(Array(3).fill('eng-on-staging'));
	});

	test('повтор той же доставки — одно Выкачено и один комментарий перехода', async () => {
		const w = setup();
		w.gh.commit('a0', [], 'init');
		squash(w, 'a1', 'a0', 1, 'ENG-1');
		w.gh.deploy(REPO, 'staging', 'a0', 'success');
		const last = w.gh.deploy(REPO, 'staging', 'a1', 'success');
		const id = w.item('ENG-1', 'In Review');
		// The first delivery's cursor write was lost: the replay walks the whole range again.
		const forgetful: DeployCursor = { get: () => null, set: () => {} };
		const deps = { ...w.deps, cursor: forgetful };

		await handleDeploy(deps, fact('a1', { deploymentId: last }));
		const again = await handleDeploy(deps, fact('a1', { deploymentId: last }));

		expect(again.notes).toEqual([{ key: 'ENG-1', workItemId: id, created: false }]);
		expect(again.synced).toMatchObject([{ action: 'noop', reason: 'not forward' }]);
		expect(w.commentIds(id)).toEqual([
			`deployed:${id}:acme/api:staging:a1`,
			`state:${id}:eng-on-staging:deploy:acme/api:staging:a1`,
		]);
		expect(w.linksOf(id)).toHaveLength(1);
		expect(w.stateOf(id)).toBe('eng-on-staging');
	});

	test('тот же sha повторно (identical) — ничего', async () => {
		const w = setup();
		w.gh.commit('a0', [], 'init');
		squash(w, 'a1', 'a0', 1, 'ENG-1');
		const id = w.item('ENG-1', 'In Review');
		w.cursor.set(REPO, 'staging', 'a1');
		const planeCalls = w.plane.calls.length;

		const result = await handleDeploy(w.deps, fact('a1'));

		expect(result).toEqual({
			action: 'identical',
			notes: [],
			synced: [],
			release: null,
			releaseError: null,
			title: 'acme/api → staging · a1',
		});
		expect(w.plane.calls).toHaveLength(planeCalls);
		expect(w.gh.calls).toEqual([]);
		expect(w.plane.commentsOf(id)).toEqual([]);
		expect(w.cursor.get(REPO, 'staging')).toBe('a1');
	});

	test('прямой push без PR: ключ из первой строки сообщения двигает задачу', async () => {
		const w = setup();
		w.gh.commit('a0', [], 'init').commit('a1', ['a0'], 'fix ENG-4 hotfix\n\nlong body ENG-5');
		w.gh.deploy(REPO, 'staging', 'a0', 'success');
		const last = w.gh.deploy(REPO, 'staging', 'a1', 'success');
		const id = w.item('ENG-4', 'In Progress');
		const other = w.item('ENG-5', 'In Progress');

		const result = await handleDeploy(w.deps, fact('a1', { deploymentId: last }));

		expect(keysOf(result)).toEqual(['ENG-4']);
		expect(w.stateOf(id)).toBe('eng-on-staging');
		// No PR to link, and the second line of the message is not a title.
		expect(w.linksOf(id)).toEqual([]);
		expect(w.plane.commentsOf(other)).toEqual([]);
		expect(w.plane.commentsOf(id)[0]?.comment_html).toBe(
			'<p>Выкачено: <code>acme/api</code> → staging · <code>a1</code> · <a href="https://github.com/acme/api/actions/runs/1">прогон</a></p>',
		);
	});

	test('задача описания PR не получает Выкачено', async () => {
		const w = setup();
		w.gh.commit('a0', [], 'init').commit('a1', ['a0'], 'ENG-1 change (#1)');
		w.gh
			.pull({ repo: REPO, number: 1, title: 'ENG-1 change', body: 'follow-up of ENG-2' })
			.mergePull(REPO, 1, 'a1');
		w.gh.deploy(REPO, 'staging', 'a0', 'success');
		const last = w.gh.deploy(REPO, 'staging', 'a1', 'success');
		w.item('ENG-1', 'In Review');
		const mentioned = w.item('ENG-2', 'In Review');

		const result = await handleDeploy(w.deps, fact('a1', { deploymentId: last }));

		expect(keysOf(result)).toEqual(['ENG-1']);
		expect(w.plane.commentsOf(mentioned)).toEqual([]);
		expect(w.linksOf(mentioned)).toEqual([]);
		expect(w.stateOf(mentioned)).toBe('eng-in-review');
	});

	test('merge-коммит ветки: коммиты ветки и merge дают один PR, одно Выкачено', async () => {
		const w = setup();
		w.gh.commit('a0', [], 'init');
		w.gh.commit('b1', ['a0'], 'wip').commit('b2', ['b1'], 'wip 2');
		w.gh.commit('mg', ['a0', 'b2'], 'Merge pull request #3');
		w.gh
			.pull({ repo: REPO, number: 3, title: 'ENG-1 change' })
			.mergePull(REPO, 3, 'mg', ['b1', 'b2']);
		w.gh.deploy(REPO, 'staging', 'a0', 'success');
		const last = w.gh.deploy(REPO, 'staging', 'mg', 'success');
		const id = w.item('ENG-1', 'In Review');

		const result = await handleDeploy(w.deps, fact('mg', { deploymentId: last }));

		expect(result.notes).toEqual([{ key: 'ENG-1', workItemId: id, created: true }]);
		expect(w.linksOf(id)).toHaveLength(1);
		expect(w.gh.calls.filter((c) => c.startsWith('mergedPullsForCommit'))).toHaveLength(3);
	});
});

describe('handleDeploy: откат и диапазон', () => {
	function history() {
		const w = setup();
		w.gh.commit('a0', [], 'init');
		squash(w, 'a1', 'a0', 1, 'ENG-1');
		squash(w, 'a2', 'a1', 2, 'ENG-2');
		return w;
	}

	test('откат (behind): Откачено в задачах откаченных PR, статусы не меняются', async () => {
		const w = history();
		w.gh.deploy(REPO, 'staging', 'a0', 'success');
		w.gh.deploy(REPO, 'staging', 'a2', 'success');
		const back = w.gh.deploy(REPO, 'staging', 'a0', 'success');
		const ids = [w.item('ENG-1', 'On staging'), w.item('ENG-2', 'On staging')];
		w.cursor.set(REPO, 'staging', 'a2');

		const result = await handleDeploy(w.deps, fact('a0', { deploymentId: back }));

		expect(result).toEqual({
			action: 'rolled_back',
			notes: [
				{ key: 'ENG-1', workItemId: ids[0] as string, created: true },
				{ key: 'ENG-2', workItemId: ids[1] as string, created: true },
			],
			synced: [],
			release: null,
			releaseError: null,
			title: 'acme/api → staging · a0',
		});
		expect(w.commentIds(ids[0] as string)).toEqual([`rolledback:${ids[0]}:acme/api:staging:a0`]);
		expect(w.plane.commentsOf(ids[1] as string)[0]?.comment_html).toBe(
			'<p>Откачено: <code>acme/api</code> → staging · <code>a0</code> · <a href="https://github.com/acme/api/actions/runs/1">прогон</a></p>',
		);
		expect(ids.map((id) => w.stateOf(id))).toEqual(['eng-on-staging', 'eng-on-staging']);
		expect(w.plane.links).toEqual([]);
		expect(w.cursor.get(REPO, 'staging')).toBe('a0');
	});

	test('откат прода — релиз не создаётся', async () => {
		const w = history();
		w.gh.deploy(REPO, 'production', 'a2', 'success');
		const back = w.gh.deploy(REPO, 'production', 'a0', 'success');
		w.item('ENG-2', 'Done');
		w.cursor.set(REPO, 'production', 'a2');

		const result = await handleDeploy(
			w.deps,
			fact('a0', { environment: 'production', deploymentId: back }),
		);

		expect(result.action).toBe('rolled_back');
		expect(result.release).toBeNull();
		expect(w.releases).toEqual([]);
	});

	test('прошлый sha пропал после force-push — только PR самого sha, без отката', async () => {
		const w = history();
		w.gh.deploy(REPO, 'staging', 'a2', 'success');
		w.item('ENG-1', 'In Review');
		const second = w.item('ENG-2', 'In Review');
		w.cursor.set(REPO, 'staging', 'gone-after-force-push');

		const result = await handleDeploy(w.deps, fact('a2'));

		expect(result.action).toBe('delivered');
		expect(keysOf(result)).toEqual(['ENG-2']);
		expect(w.commentIds(second)[0]).toBe(`deployed:${second}:acme/api:staging:a2`);
		expect(w.cursor.get(REPO, 'staging')).toBe('a2');
	});

	test('diverged — коммиты из compare, не откат', async () => {
		const w = history();
		w.gh.commit('x', ['a0'], 'side branch');
		w.gh.deploy(REPO, 'staging', 'a2', 'success');
		w.item('ENG-1', 'In Review');
		w.item('ENG-2', 'In Review');
		w.cursor.set(REPO, 'staging', 'x');

		const result = await handleDeploy(w.deps, fact('a2'));

		expect(result.action).toBe('delivered');
		expect(keysOf(result)).toEqual(['ENG-1', 'ENG-2']);
		expect(result.notes.map((n) => n.created)).toEqual([true, true]);
	});

	test('первый деплой окружения — только PR самого sha', async () => {
		const w = history();
		const only = w.gh.deploy(REPO, 'staging', 'a2', 'success');
		const earlier = w.item('ENG-1', 'In Review');
		w.item('ENG-2', 'In Review');

		const result = await handleDeploy(w.deps, fact('a2', { deploymentId: only }));

		expect(keysOf(result)).toEqual(['ENG-2']);
		expect(w.plane.commentsOf(earlier)).toEqual([]);
	});

	test('потерянный деплой догоняется: курсор на A, событие B потеряно, деплой C — задачи B и C', async () => {
		const w = history();
		squash(w, 'a3', 'a2', 3, 'ENG-3');
		for (const sha of ['a0', 'a1', 'a2', 'a3']) w.gh.deploy(REPO, 'staging', sha, 'success');
		const a = w.item('ENG-1', 'In Review');
		w.item('ENG-2', 'In Review');
		w.item('ENG-3', 'In Review');
		w.cursor.set(REPO, 'staging', 'a1');

		const result = await handleDeploy(w.deps, fact('a3', { deploymentId: 4 }));

		expect(keysOf(result)).toEqual(['ENG-2', 'ENG-3']);
		expect(w.plane.commentsOf(a)).toEqual([]);
		expect(w.cursor.get(REPO, 'staging')).toBe('a3');
	});

	test('без курсора — база из прошлого успешного деплоя GitHub, неуспешные и более новые пропускаются', async () => {
		const w = history();
		squash(w, 'a3', 'a2', 3, 'ENG-3');
		w.gh.deploy(REPO, 'staging', 'a0', 'success'); // 1: the base
		w.gh.deploy(REPO, 'staging', 'a1', 'failure'); // 2: failed, not a base
		const own = w.gh.deploy(REPO, 'staging', 'a2', 'success'); // 3: this event
		w.gh.deploy(REPO, 'staging', 'a3', 'success'); // 4: newer than this event
		w.item('ENG-1', 'In Review');
		w.item('ENG-2', 'In Review');
		w.item('ENG-3', 'In Review');

		const result = await handleDeploy(w.deps, fact('a2', { deploymentId: own }));

		expect(result.action).toBe('delivered');
		expect(keysOf(result)).toEqual(['ENG-1', 'ENG-2']);
	});

	test('без id деплоя (promote) — база: любой успешный деплой с другим sha', async () => {
		const w = history();
		w.gh.deploy(REPO, 'staging', 'a0', 'success');
		w.gh.deploy(REPO, 'staging', 'a2', 'success');
		w.item('ENG-1', 'In Review');
		w.item('ENG-2', 'In Review');

		const result = await handleDeploy(w.deps, fact('a2', { deploymentId: null }));

		// a1 has no deployment of its own: it is in the range a0..a2.
		expect(keysOf(result)).toEqual(['ENG-1', 'ENG-2']);
	});

	test('два прямых push без PR в диапазоне — обе задачи, коммиты не склеиваются', async () => {
		const w = setup();
		w.gh
			.commit('a0', [], 'init')
			.commit('a1', ['a0'], 'ENG-4 one')
			.commit('a2', ['a1'], 'ENG-6 two');
		w.item('ENG-4', 'In Progress');
		w.item('ENG-6', 'In Progress');
		w.cursor.set(REPO, 'staging', 'a0');
		w.gh.deploy(REPO, 'staging', 'a2', 'success');

		const result = await handleDeploy(w.deps, fact('a2'));

		expect(keysOf(result)).toEqual(['ENG-4', 'ENG-6']);
	});

	test('задача двух PR диапазона — ссылки на оба, оба в тексте Выкачено', async () => {
		const w = setup();
		w.gh.commit('a0', [], 'init');
		squash(w, 'a1', 'a0', 1, 'ENG-1');
		squash(w, 'a2', 'a1', 2, 'ENG-1');
		w.gh.deploy(REPO, 'staging', 'a2', 'success');
		w.cursor.set(REPO, 'staging', 'a0');
		const id = w.item('ENG-1', 'In Review');

		const result = await handleDeploy(w.deps, fact('a2'));

		expect(result.notes).toEqual([{ key: 'ENG-1', workItemId: id, created: true }]);
		expect(w.linksOf(id).map((l) => l.url)).toEqual([
			'https://github.com/acme/api/pull/1',
			'https://github.com/acme/api/pull/2',
		]);
		expect(w.plane.commentsOf(id)[0]?.comment_html).toContain(
			'PR: <a href="https://github.com/acme/api/pull/1">acme/api#1</a>, <a href="https://github.com/acme/api/pull/2">acme/api#2</a>',
		);
	});

	test('длинный sha: в title и в тексте Выкачено — первые 7 символов', async () => {
		const w = setup();
		const sha = '0123456789abcdef0123456789abcdef01234567';
		w.gh.commit('a0', [], 'init').commit(sha, ['a0'], 'ENG-1 direct');
		const id = w.item('ENG-1', 'In Progress');
		w.cursor.set(REPO, 'staging', 'a0');
		w.gh.deploy(REPO, 'staging', sha, 'success');

		const result = await handleDeploy(w.deps, fact(sha, { logUrl: null }));

		expect(result.title).toBe('acme/api → staging · 0123456');
		expect(w.plane.commentsOf(id)[0]?.comment_html).toBe(
			'<p>Выкачено: <code>acme/api</code> → staging · <code>0123456</code></p>',
		);
	});

	test('откат: обратный compare не нашёл sha — Откачено никому, курсор сдвинут', async () => {
		const w = history();
		w.cursor.set(REPO, 'staging', 'a2');
		let calls = 0;
		const github = new Proxy(w.gh, {
			get(target, prop) {
				if (prop === 'compare') {
					return async (repo: string, base: string, head: string) =>
						++calls === 1 ? target.compare(repo, base, head) : null;
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});

		const result = await handleDeploy({ ...w.deps, github: async () => github }, fact('a0'));

		expect(result).toMatchObject({ action: 'rolled_back', notes: [] });
		expect(w.cursor.get(REPO, 'staging')).toBe('a0');
	});

	test('первый деплой окружения: база не ищется через compare, прошлые деплои просмотрены (20)', async () => {
		const w = history();
		w.gh.deploy(REPO, 'staging', 'a2', 'success');
		w.item('ENG-2', 'In Review');

		await handleDeploy(w.deps, fact('a2', { deploymentId: 1 }));

		// Without a base there is nothing to compare from; the only compare is syncTask's `contains` (a2 against a2).
		expect(w.gh.calls.filter((c) => c.startsWith('compare '))).toEqual([
			'compare acme/api a2...a2',
		]);
		// The first listing is the base lookup; the later ones are `contains`.
		expect(w.gh.calls.find((c) => c.startsWith('listDeployments'))).toBe(
			'listDeployments acme/api staging 20',
		);
	});

	function longChain(w: ReturnType<typeof setup>) {
		w.gh.commit('c0', [], 'init');
		for (let i = 1; i <= 251; i++) w.gh.commit(`c${i}`, [`c${i - 1}`], `chore ${i}`);
	}
	const truncated = [{ reason: 'compare_truncated:acme/api', entry: { repo: REPO } }];

	test('compare обрезан на 250 коммитах — warnOnce, деплой доставлен', async () => {
		const w = setup();
		longChain(w);
		w.cursor.set(REPO, 'staging', 'c0');

		const result = await handleDeploy(w.deps, fact('c251'));

		expect(result.action).toBe('delivered');
		expect(w.warns.filter((x) => x.reason.startsWith('compare_'))).toEqual(truncated);
	});

	test('откат на 250+ коммитов — тот же warnOnce', async () => {
		const w = setup();
		longChain(w);
		w.cursor.set(REPO, 'staging', 'c251');

		const result = await handleDeploy(w.deps, fact('c0'));

		expect(result.action).toBe('rolled_back');
		expect(w.warns.filter((x) => x.reason.startsWith('compare_'))).toEqual(truncated);
	});

	test('compare ответил identical для другого sha — identical, курсор сдвинут', async () => {
		const w = setup();
		w.cursor.set(REPO, 'staging', 'old');
		const github = new Proxy(w.gh, {
			get(target, prop) {
				if (prop === 'compare') {
					return async () => ({ status: 'identical' as const, commits: [], truncated: false });
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});

		const result = await handleDeploy({ ...w.deps, github: async () => github }, fact('new'));

		expect(result.action).toBe('identical');
		expect(result.notes).toEqual([]);
		expect(w.cursor.get(REPO, 'staging')).toBe('new');
	});
});

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
