import { describe, expect, test } from 'bun:test';

import { handlePullRequest } from '../src/delivery/pr.ts';
import { causeKey } from '../src/delivery/sync.ts';
import { GitHubApiError, type Pull } from '../src/github/client.ts';
import type { GitHubEvent } from '../src/github/webhook.ts';
import { PlaneApiError } from '../src/plane.ts';
import { tenantOf } from './config-fixture.ts';
import { deliveryWorld } from './delivery-world.ts';

type PullEvent = Extract<GitHubEvent, { kind: 'pull_request' }>;

const PULL: Pull = {
	repo: 'acme/api',
	number: 7,
	url: 'https://github.com/acme/api/pull/7',
	title: 'ENG-1 add retries',
	body: 'Also touches ENG-2',
	head: 'feat/ENG-3-retries',
	base: 'main',
	draft: true,
	state: 'open',
	merged: false,
	mergeSha: null,
};

function event(
	pull: Partial<Pull> = {},
	action: PullEvent['action'] = 'opened',
	id = 'd1',
): PullEvent {
	return {
		kind: 'pull_request',
		appId: 1000001,
		deliveryId: id,
		installationId: 5,
		action,
		pull: { ...PULL, ...pull },
	};
}

describe('handlePullRequest', () => {
	test('черновой PR: ссылки в задачи ключей заголовка и описания, статусы не меняются', async () => {
		const w = deliveryWorld();
		const ids = [
			w.item('ENG-1', 'In Progress'),
			w.item('ENG-2', 'In Progress'),
			w.item('ENG-3', 'In Progress'),
		];
		const result = await handlePullRequest(w.deps, event());
		expect(result.linked).toBe(3);
		expect(result.synced.map((s) => [s.key, s.action, s.reason])).toEqual([
			['ENG-1', 'noop', 'draft'],
			['ENG-3', 'noop', 'draft'],
		]);
		for (const id of ids) {
			expect(w.linksOf(id).map((l) => [l.url, l.title])).toEqual([
				['https://github.com/acme/api/pull/7', 'GitHub: acme/api#7'],
			]);
			expect(w.stateOf(id)).toBe('eng-in-progress');
			expect(w.plane.commentsOf(id)).toEqual([]);
		}
	});

	test('ready for review — задача заголовка в In Review, задача описания — только ссылка', async () => {
		const w = deliveryWorld();
		const title = w.item('ENG-1', 'In Progress');
		const body = w.item('ENG-2', 'In Progress');
		const result = await handlePullRequest(w.deps, event({ draft: false }, 'ready_for_review'));
		expect(result.synced.find((s) => s.key === 'ENG-1')).toMatchObject({
			action: 'moved',
			to: 'In Review',
		});
		expect(w.stateOf(title)).toBe('eng-in-review');
		expect(w.commentIds(title)).toEqual([`state:${title}:eng-in-review:pr:acme/api#7:d1`]);
		expect(w.stateOf(body)).toBe('eng-in-progress');
		expect(w.linksOf(body)).toHaveLength(1);
		expect(w.plane.commentsOf(body)).toEqual([]);
	});

	test('переход — SyncDeps.moved с причиной сразу после записи статуса; сбой записи — без moved', async () => {
		const w = deliveryWorld();
		w.item('ENG-1', 'In Progress');
		await handlePullRequest(w.deps, event({ draft: false }, 'ready_for_review'));
		expect(w.moves).toEqual([
			{ key: 'ENG-1', from: 'In Progress', to: 'In Review', cause: 'pr:acme/api#7' },
		]);
		const failing = deliveryWorld();
		failing.item('ENG-1', 'In Progress');
		failing.plane.failNext('setWorkItemState');
		await expect(
			handlePullRequest(failing.deps, event({ draft: false }, 'ready_for_review')),
		).rejects.toThrow();
		expect(failing.moves).toEqual([]);
		expect(
			causeKey({ kind: 'deploy', repo: 'acme/api', environment: 'staging', sha: 'abc1234' }),
		).toBe('deploy:acme/api:staging:abc1234');
	});

	test('повтор той же доставки — ссылки не дублируются, комментарий перехода один', async () => {
		const w = deliveryWorld();
		const id = w.item('ENG-1', 'In Progress');
		const first = await handlePullRequest(w.deps, event({ draft: false, body: '' }));
		const again = await handlePullRequest(w.deps, event({ draft: false, body: '' }));
		expect(first.linked).toBe(1);
		expect(again.linked).toBe(0);
		expect(w.linksOf(id)).toHaveLength(1);
		expect(w.plane.commentsOf(id)).toHaveLength(1);
		expect(w.stateOf(id)).toBe('eng-in-review');
	});

	test('заголовок исправлен и получил новый ключ — ссылка и синк новой задачи', async () => {
		const w = deliveryWorld();
		const old = w.item('ENG-1', 'In Progress');
		const fresh = w.item('ENG-4', 'In Progress');
		const base = { draft: false, body: '', head: 'feature-x' };
		await handlePullRequest(w.deps, event({ ...base, title: 'ENG-1 retries' }));
		const result = await handlePullRequest(
			w.deps,
			event({ ...base, title: 'ENG-4 retries' }, 'edited', 'd2'),
		);
		expect(result.linked).toBe(1);
		expect(result.synced.map((s) => [s.key, s.action])).toEqual([['ENG-4', 'moved']]);
		expect(w.stateOf(fresh)).toBe('eng-in-review');
		expect(w.linksOf(fresh)).toHaveLength(1);
		// The old task keeps its link and its state: the PR was linked there once.
		expect(w.linksOf(old)).toHaveLength(1);
		expect(w.stateOf(old)).toBe('eng-in-review');
	});

	test('репозиторий без правила — только ссылки', async () => {
		const w = deliveryWorld();
		const id = w.item('ENG-1', 'In Progress');
		const pull = { repo: 'other/lib', url: 'https://github.com/other/lib/pull/9', number: 9 };
		const result = await handlePullRequest(
			w.deps,
			event({ ...pull, draft: false, body: '', head: 'x' }),
		);
		expect(result).toEqual({ linked: 1, synced: [] });
		expect(w.linksOf(id).map((l) => [l.url, l.title])).toEqual([
			['https://github.com/other/lib/pull/9', 'GitHub: other/lib#9'],
		]);
		expect(w.stateOf(id)).toBe('eng-in-progress');
	});

	test('тенант без delivery — ничего', async () => {
		const w = deliveryWorld(tenantOf({ delivery: null }));
		const id = w.item('ENG-1', 'In Progress');
		const before = w.plane.calls.length;
		const result = await handlePullRequest(w.deps, event({ draft: false }));
		expect(result).toEqual({ linked: 0, synced: [] });
		expect(w.linksOf(id)).toEqual([]);
		expect(w.plane.calls).toHaveLength(before);
	});

	test('ключ неизвестной задачи пропускается, остальные получают ссылку', async () => {
		const w = deliveryWorld();
		const id = w.item('ENG-2', 'In Progress');
		const result = await handlePullRequest(w.deps, event({ title: 'ENG-99 ghost', head: 'x' }));
		expect(result.linked).toBe(1);
		expect(w.linksOf(id)).toHaveLength(1);
	});

	test('проект закрыт для бота (403) — его ключи пропускаются с предупреждением о проекте', async () => {
		const w = deliveryWorld();
		w.item('ENG-1', 'In Progress');
		const ops = w.item('OPS-5', 'In Progress');
		w.plane.forbiddenProjects.add('p-eng');
		const result = await handlePullRequest(
			w.deps,
			event({ title: 'ENG-1 and OPS-5', head: 'x', body: '' }),
		);
		expect(result.linked).toBe(1);
		expect(result.synced.find((x) => x.key === 'ENG-1')).toEqual({
			key: 'ENG-1',
			action: 'skipped',
			reason: 'plane refused',
		});
		expect(w.linksOf(ops)).toHaveLength(1);
		// warnOnce dedupes in the caller: the link step and the sync step each report the project.
		const forbidden = w.warns.filter((x) => x.reason.startsWith('plane_'));
		expect(new Set(forbidden.map((x) => JSON.stringify([x.reason, x.entry])))).toEqual(
			new Set([JSON.stringify(['plane_forbidden:ENG', { project: 'ENG' }])]),
		);
		expect(forbidden.length).toBeGreaterThan(0);
		expect(w.stateOf(ops)).toBe('ops-in-progress');
	});

	test('задача исчезла между чтением и ссылкой (404) — ключ пропущен с предупреждением', async () => {
		const w = deliveryWorld();
		w.item('ENG-1', 'In Progress');
		w.plane.failNext('createLink', new PlaneApiError(404, 'POST', '/links/'));
		const result = await handlePullRequest(w.deps, event({ head: 'x', body: '' }));
		expect(result.linked).toBe(0);
		expect(w.warns.filter((x) => x.reason.startsWith('plane_'))[0]).toEqual({
			reason: 'plane_not_found:ENG',
			entry: { project: 'ENG' },
		});
	});

	test('сбой Plane, не 403 и не 404, не глотается', async () => {
		const w = deliveryWorld();
		w.item('ENG-1', 'In Progress');
		w.plane.failNext('createLink', new PlaneApiError(500, 'POST', '/links/'));
		await expect(handlePullRequest(w.deps, event({ head: 'x', body: '' }))).rejects.toThrow('500');
	});

	test('чужая ошибка со статусом 403 (GitHub) не принимается за отказ Plane', async () => {
		const w = deliveryWorld();
		w.item('ENG-1', 'In Progress');
		w.plane.failNext('createLink', new GitHubApiError(403, 'GET', '/x'));
		await expect(handlePullRequest(w.deps, event({ head: 'x', body: '' }))).rejects.toThrow('403');
	});
});
