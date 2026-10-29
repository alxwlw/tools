import { describe, expect, test } from 'bun:test';

import { handlePreview, vercelDeployFact } from '../src/delivery/preview.ts';
import { PlaneApiError } from '../src/plane.ts';
import type { VercelHookEvent, VercelPreview } from '../src/vercel.ts';
import { tenantOf } from './config-fixture.ts';
import { deliveryWorld } from './delivery-world.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

const PREVIEW: VercelPreview = {
	project: 'web',
	repo: 'acme/api',
	branch: 'feat/ENG-1-retries',
	url: 'https://web-abc-example.vercel.app',
	sha: SHA,
};

function text(w: ReturnType<typeof deliveryWorld>, id: string): string[] {
	return w.plane.commentsOf(id).map((c) => c.comment_html);
}

describe('handlePreview', () => {
	test('первое превью — комментарий; новое — тот же комментарий с новой ссылкой; то же — noop', async () => {
		const w = deliveryWorld();
		const id = w.item('ENG-1', 'In Progress');
		w.gh.pull({
			repo: 'acme/api',
			number: 7,
			title: 'ENG-1 retries',
			head: PREVIEW.branch as string,
		});

		expect(await handlePreview(w.deps, PREVIEW)).toEqual([{ key: 'ENG-1', action: 'created' }]);
		expect(text(w, id)).toEqual([
			'<p>Превью <code>web</code>: <a href="https://web-abc-example.vercel.app">https://web-abc-example.vercel.app</a> · ветка <code>feat/ENG-1-retries</code> · <code>0123456</code></p>',
		]);
		expect(w.commentIds(id)).toEqual([`preview:${id}:web`]);
		expect(w.plane.commentsOf(id)[0]?.external_source).toBe('plane-hooks');

		const next = { ...PREVIEW, url: 'https://web-def-example.vercel.app', sha: OTHER_SHA };
		expect(await handlePreview(w.deps, next)).toEqual([{ key: 'ENG-1', action: 'updated' }]);
		expect(text(w, id)).toEqual([
			'<p>Превью <code>web</code>: <a href="https://web-def-example.vercel.app">https://web-def-example.vercel.app</a> · ветка <code>feat/ENG-1-retries</code> · <code>fedcba9</code></p>',
		]);

		expect(await handlePreview(w.deps, next)).toEqual([{ key: 'ENG-1', action: 'noop' }]);
		expect(w.plane.commentsOf(id)).toHaveLength(1);
	});

	test('два проекта Vercel одной ветки — два комментария', async () => {
		const w = deliveryWorld();
		const id = w.item('ENG-1', 'In Progress');
		await handlePreview(w.deps, PREVIEW);
		await handlePreview(w.deps, {
			...PREVIEW,
			project: 'docs',
			url: 'https://docs-abc-example.vercel.app',
		});
		expect(w.commentIds(id)).toEqual([`preview:${id}:web`, `preview:${id}:docs`]);
		// A second project's preview does not touch the first one's comment.
		expect(text(w, id)[0]).toContain('https://web-abc-example.vercel.app');
	});

	test('ветка без PR — ключ из имени ветки; репозиторий без App тоже', async () => {
		const w = deliveryWorld();
		const id = w.item('ENG-1', 'In Progress');
		expect(await handlePreview(w.deps, PREVIEW)).toEqual([{ key: 'ENG-1', action: 'created' }]);
		expect(w.gh.calls).toContain('openPullsForBranch acme/api feat/ENG-1-retries');
		const other = w.item('ENG-2', 'In Progress');
		const noApp = { ...PREVIEW, repo: 'other/api', branch: 'feat/ENG-2-x' };
		expect(await handlePreview(w.deps, noApp)).toEqual([{ key: 'ENG-2', action: 'created' }]);
		expect(w.gh.calls.some((call) => call.includes('other/api'))).toBe(false);
		expect(w.commentIds(other)).toEqual([`preview:${other}:web`]);
		expect(w.commentIds(id)).toHaveLength(1);
	});

	test('превью без repo — ключ из имени ветки; без ветки — пусто', async () => {
		const w = deliveryWorld();
		const id = w.item('ENG-1', 'In Progress');
		expect(await handlePreview(w.deps, { ...PREVIEW, repo: null })).toEqual([
			{ key: 'ENG-1', action: 'created' },
		]);
		expect(w.gh.calls).toEqual([]);
		expect(await handlePreview(w.deps, { ...PREVIEW, branch: null })).toEqual([]);
		expect(w.plane.commentsOf(id)).toHaveLength(1);
	});

	test('ключи открытого PR — из заголовка и ветки; ключ из описания PR — без комментария', async () => {
		const w = deliveryWorld();
		const inTitle = w.item('ENG-2', 'In Progress');
		const inBranch = w.item('ENG-1', 'In Progress');
		const inBody = w.item('ENG-3', 'In Progress');
		w.gh.pull({
			repo: 'acme/api',
			number: 7,
			title: 'ENG-2 retries',
			body: 'Also ENG-3',
			head: PREVIEW.branch as string,
		});
		const result = await handlePreview(w.deps, PREVIEW);
		expect(result.map((r) => r.key).sort()).toEqual(['ENG-1', 'ENG-2']);
		expect(w.commentIds(inTitle)).toHaveLength(1);
		expect(w.commentIds(inBranch)).toHaveLength(1);
		expect(w.plane.commentsOf(inBody)).toEqual([]);
	});

	test('неизвестный ключ и tenant без delivery — ничего не пишут', async () => {
		const w = deliveryWorld();
		expect(await handlePreview(w.deps, PREVIEW)).toEqual([]);
		const off = deliveryWorld(tenantOf({ delivery: null }));
		const id = off.item('ENG-1', 'In Progress');
		expect(await handlePreview(off.deps, PREVIEW)).toEqual([]);
		expect(off.plane.commentsOf(id)).toEqual([]);
	});

	test('комментарий создан параллельно (409) — обновляется, а не дублируется', async () => {
		const w = deliveryWorld();
		const id = w.item('ENG-1', 'In Progress');
		await handlePreview(w.deps, PREVIEW);
		const next = { ...PREVIEW, url: 'https://web-def-example.vercel.app' };
		// The list was read before the other delivery's comment appeared.
		const plane = new Proxy(w.plane, {
			get: (target, name) => {
				if (name === 'listComments') return async () => [];
				const member = Reflect.get(target, name);
				return typeof member === 'function' ? member.bind(target) : member;
			},
		});
		const stale = { ...w.deps, plane };
		expect(await handlePreview(stale, next)).toEqual([{ key: 'ENG-1', action: 'updated' }]);
		expect(w.plane.commentsOf(id)).toHaveLength(1);
		expect(text(w, id)[0]).toContain('web-def-example');
	});

	test('ссылка не http(s) — показывается кодом, а не ссылкой', async () => {
		const w = deliveryWorld();
		const id = w.item('ENG-1', 'In Progress');
		await handlePreview(w.deps, { ...PREVIEW, url: 'javascript:alert(1)' });
		expect(text(w, id)[0]).toContain('<code>javascript:alert(1)</code>');
		expect(text(w, id)[0]).not.toContain('<a ');
	});

	test('задача недоступна (404) — пропускается с предупреждением, остальные получают комментарий', async () => {
		const w = deliveryWorld();
		const gone = w.item('ENG-2', 'In Progress');
		const ok = w.item('ENG-1', 'In Progress');
		w.gh.pull({
			repo: 'acme/api',
			number: 7,
			title: 'ENG-2 ENG-1',
			head: PREVIEW.branch as string,
		});
		const plane = new Proxy(w.plane, {
			get: (target, name) => {
				if (name === 'listComments')
					return async (_project: string, itemId: string) => {
						if (itemId === gone) throw new PlaneApiError(404, 'GET', '/comments/');
						return target.listComments(_project, itemId);
					};
				const member = Reflect.get(target, name);
				return typeof member === 'function' ? member.bind(target) : member;
			},
		});
		const result = await handlePreview({ ...w.deps, plane }, PREVIEW);
		expect(result).toEqual([{ key: 'ENG-1', action: 'created' }]);
		expect(w.commentIds(ok)).toHaveLength(1);
		expect(w.warns).toEqual([{ reason: 'plane_not_found:ENG', entry: { project: 'ENG' } }]);
	});

	test('текст экранируется: имя проекта и ветка с разметкой', async () => {
		const w = deliveryWorld();
		const id = w.item('ENG-1', 'In Progress');
		await handlePreview(w.deps, { ...PREVIEW, project: 'w<b>', branch: 'feat/ENG-1-<i>' });
		expect(text(w, id)[0]).toContain('<code>w&lt;b&gt;</code>');
		expect(text(w, id)[0]).toContain('<code>feat/ENG-1-&lt;i&gt;</code>');
	});
});

type Switch = Extract<VercelHookEvent, { kind: 'promoted' | 'rolled_back' }>;
const EVENT: Switch = {
	kind: 'promoted',
	project: 'web',
	repo: 'acme/api',
	sha: SHA,
	at: '2026-10-06T10:20:00.000Z',
	url: 'https://web-prom-example.vercel.app',
};

describe('vercelDeployFact', () => {
	test('promote: окружение — Production-запись vercel[bot] этого sha; записи нет — null', async () => {
		const w = deliveryWorld();
		expect(await vercelDeployFact(w.gh, EVENT)).toBeNull();

		w.gh.deploy('acme/api', 'Production', OTHER_SHA, 'success', 'vercel[bot]');
		w.gh.deploy('acme/api', 'Preview', SHA, 'success', 'vercel[bot]');
		w.gh.deploy('acme/api', 'Production', SHA, 'success', 'github-actions[bot]');
		w.gh.deploy('acme/api', 'Production', SHA, 'success', '');
		expect(await vercelDeployFact(w.gh, EVENT)).toBeNull();

		w.gh.deploy('acme/api', 'Production', SHA, 'success', 'vercel[bot]');
		expect(await vercelDeployFact(w.gh, EVENT)).toEqual({
			repo: 'acme/api',
			environment: 'Production',
			sha: SHA,
			deploymentId: null,
			logUrl: 'https://web-prom-example.vercel.app',
			at: '2026-10-06T10:20:00.000Z',
		});
	});

	test('at — время самого события promote/rollback, не создания деплоя и не обработки', async () => {
		const w = deliveryWorld();
		w.gh.deploy('acme/api', 'Production', SHA, 'success', 'vercel[bot]');
		const rolled: Switch = { ...EVENT, kind: 'rolled_back', at: '2026-01-02T03:04:05.000Z' };
		expect((await vercelDeployFact(w.gh, rolled))?.at).toBe('2026-01-02T03:04:05.000Z');
	});

	test('несколько проектов Vercel в репозитории — запись «Production – <проект>»', async () => {
		const w = deliveryWorld();
		w.gh.deploy('acme/api', 'Production – docs', SHA, 'success', 'vercel[bot]');
		expect(await vercelDeployFact(w.gh, EVENT)).toBeNull();
		w.gh.deploy('acme/api', 'Production – web', SHA, 'success', 'vercel[bot]');
		expect((await vercelDeployFact(w.gh, EVENT))?.environment).toBe('Production – web');
	});

	test('нет repo или sha — null без обращений к GitHub', async () => {
		const w = deliveryWorld();
		w.gh.deploy('acme/api', 'Production', SHA, 'success', 'vercel[bot]');
		expect(await vercelDeployFact(w.gh, { ...EVENT, repo: null })).toBeNull();
		expect(await vercelDeployFact(w.gh, { ...EVENT, sha: null })).toBeNull();
		expect(w.gh.calls).toEqual([]);
	});

	test('просматриваются последние 20 записей каждого окружения', async () => {
		const w = deliveryWorld();
		await vercelDeployFact(w.gh, EVENT);
		expect(w.gh.calls).toEqual([
			'listDeployments acme/api Production 20',
			'listDeployments acme/api Production – web 20',
		]);
	});

	test('url события null — logUrl null', async () => {
		const w = deliveryWorld();
		w.gh.deploy('acme/api', 'Production', SHA, 'success', 'vercel[bot]');
		expect((await vercelDeployFact(w.gh, { ...EVENT, url: null }))?.logUrl).toBeNull();
	});
});
