import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

import { Store } from '../src/store.ts';

const dirs: string[] = [];
function tempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), 'plane-hooks-store-'));
	dirs.push(dir);
	return join(dir, 'hooks.sqlite');
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Store: курсор деплоя', () => {
	test('курсор: нет — null; set и get по тенанту, репозиторию и окружению', () => {
		const store = new Store(':memory:');
		expect(store.deployCursor('acme', 'acme/api', 'staging')).toBeNull();
		store.setDeployCursor('acme', 'acme/api', 'staging', 'sha-a', '2026-10-28T10:00:00.000Z');
		expect(store.deployCursor('acme', 'acme/api', 'staging')).toEqual({
			sha: 'sha-a',
			at: '2026-10-28T10:00:00.000Z',
		});
		// Every part of the key counts.
		expect(store.deployCursor('other', 'acme/api', 'staging')).toBeNull();
		expect(store.deployCursor('acme', 'acme/infra', 'staging')).toBeNull();
		expect(store.deployCursor('acme', 'acme/api', 'production')).toBeNull();
		store.setDeployCursor('acme', 'acme/api', 'staging', 'sha-b', '2026-10-28T11:00:00.000Z');
		expect(store.deployCursor('acme', 'acme/api', 'staging')).toEqual({
			sha: 'sha-b',
			at: '2026-10-28T11:00:00.000Z',
		});
		store.close();
	});

	test('cursorFor — вид на тенанта: get и set без тенанта в аргументах', () => {
		const store = new Store(':memory:');
		const acme = store.cursorFor('acme');
		const other = store.cursorFor('other');
		acme.set('acme/api', 'staging', 'sha-a', '2026-10-28T10:00:00.000Z');
		expect(acme.get('acme/api', 'staging')).toEqual({
			sha: 'sha-a',
			at: '2026-10-28T10:00:00.000Z',
		});
		expect(other.get('acme/api', 'staging')).toBeNull();
		other.set('acme/api', 'staging', 'sha-o', '2026-10-28T12:00:00.000Z');
		expect(other.get('acme/api', 'staging')).toEqual({
			sha: 'sha-o',
			at: '2026-10-28T12:00:00.000Z',
		});
		expect(acme.get('acme/api', 'staging')).toEqual({
			sha: 'sha-a',
			at: '2026-10-28T10:00:00.000Z',
		});
		expect(store.deployCursor('other', 'acme/api', 'staging')?.sha).toBe('sha-o');
		expect(store.deployCursor('acme', 'acme/api', 'staging')?.sha).toBe('sha-a');
		store.close();
	});

	test('база переживает повторное открытие файла', () => {
		const path = tempFile();
		const first = new Store(path);
		first.setDeployCursor('acme', 'acme/api', 'production', 'sha-z', '2026-10-28T10:00:00.000Z');
		first.close();
		const second = new Store(path);
		expect(second.deployCursor('acme', 'acme/api', 'production')).toEqual({
			sha: 'sha-z',
			at: '2026-10-28T10:00:00.000Z',
		});
		second.close();
		const raw = new Database(path);
		expect((raw.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe(
			'wal',
		);
		raw.close();
	});

	test('после close запросы не проходят', () => {
		const store = new Store(':memory:');
		store.close();
		expect(() => store.deployCursor('acme', 'acme/api', 'staging')).toThrow();
	});

	test('версия схемы — PRAGMA user_version; чужая более новая версия — ошибка', () => {
		const path = tempFile();
		new Store(path).close();
		const raw = new Database(path);
		expect((raw.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
			2,
		);
		raw.run('PRAGMA user_version = 99');
		raw.close();
		expect(() => new Store(path)).toThrow('schema version 99');
	});

	test('файл версии 1 (только курсор) переходит на 2: курсор цел, входящие и журнал появляются', () => {
		const path = tempFile();
		const raw = new Database(path, { create: true });
		raw.run(`CREATE TABLE deploy_cursor (tenant TEXT NOT NULL, repo TEXT NOT NULL, environment TEXT NOT NULL,
			sha TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (tenant, repo, environment))`);
		raw.run(
			`INSERT INTO deploy_cursor VALUES ('acme', 'acme/api', 'staging', 'sha-v1', '2026-10-28T10:00:00.000Z')`,
		);
		raw.run('PRAGMA user_version = 1');
		raw.close();
		const store = new Store(path);
		expect(store.deployCursor('acme', 'acme/api', 'staging')?.sha).toBe('sha-v1');
		expect(store.inboxAdd('acme', 'github', 'd-1', '{}', '2026-10-28T10:00:00.000Z')).toBe(1);
		store.journalAdd({
			tenant: 'acme',
			key: 'ENG-1',
			from: 'Todo',
			to: 'In Review',
			cause: 'pr:acme/api#1',
			at: '2026-10-28T10:00:00.000Z',
		});
		expect(store.journalSince('2026-10-01T00:00:00Z')).toHaveLength(1);
		store.close();
	});
});

const AT = '2026-10-28T10:00:00.000Z';
const payloadOf = (path: string, id: number) => {
	const raw = new Database(path);
	const row = raw.query('SELECT payload, status FROM inbox WHERE id = ?').get(id);
	raw.close();
	return row as { payload: string | null; status: string } | null;
};

describe('Store: входящие доставки', () => {
	test('входящие: add, done (payload стёрт), failed, retry, pending после повторного открытия', () => {
		const path = tempFile();
		const first = new Store(path);
		const a = first.inboxAdd('acme', 'github', 'd-a', '{"n":"a"}', AT) as number;
		const b = first.inboxAdd(
			'beta',
			'vercel.preview',
			null,
			'{"n":"b"}',
			'2026-10-28T10:01:00Z',
		) as number;
		const c = first.inboxAdd('acme', 'dokploy.deployed', null, '{"n":"c"}', AT) as number;
		expect([a, b, c]).toEqual([1, 2, 3]);
		first.inboxDone(a);
		first.inboxFailed(c, 'PlaneApiError: Plane GET /projects/ → 400');
		first.close();

		const second = new Store(path);
		// Only b is still pending; a is done, c failed.
		expect(second.inboxPending()).toEqual([
			{ id: b, tenant: 'beta', kind: 'vercel.preview', payload: '{"n":"b"}' },
		]);
		expect(payloadOf(path, a)).toEqual({ payload: null, status: 'done' });
		expect(second.inboxFailedList()).toEqual([
			{
				id: c,
				tenant: 'acme',
				kind: 'dokploy.deployed',
				error: 'PlaneApiError: Plane GET /projects/ → 400',
				at: AT,
			},
		]);
		expect(second.inboxRetry(c)).toBe(true);
		// A retried delivery is pending again with its payload, and no longer listed as failed.
		expect(second.inboxPending().map((job) => [job.id, job.payload])).toEqual([
			[b, '{"n":"b"}'],
			[c, '{"n":"c"}'],
		]);
		expect(second.inboxFailedList()).toEqual([]);
		// retry of something that is not failed changes nothing.
		expect(second.inboxRetry(c)).toBe(false);
		expect(second.inboxRetry(a)).toBe(false);
		expect(second.inboxRetry(999)).toBe(false);
		second.close();
	});

	test('pending старше — раньше: порядок по id, не по тенанту и не по времени приёма', () => {
		const store = new Store(':memory:');
		store.inboxAdd('zeta', 'github', null, '1', '2026-10-28T12:00:00Z');
		store.inboxAdd('acme', 'github', null, '2', '2026-10-28T09:00:00Z');
		expect(store.inboxPending().map((job) => job.payload)).toEqual(['1', '2']);
		store.close();
	});

	test('повтор id доставки GitHub: выполненная и ждущая — null; упавшая — тот же id снова pending с новым телом', () => {
		const store = new Store(':memory:');
		const done = store.inboxAdd('acme', 'github', 'd-done', 'old', AT) as number;
		store.inboxDone(done);
		expect(store.inboxAdd('acme', 'github', 'd-done', 'again', AT)).toBeNull();

		const waiting = store.inboxAdd('acme', 'github', 'd-wait', 'w', AT) as number;
		expect(store.inboxAdd('acme', 'github', 'd-wait', 'w2', AT)).toBeNull();
		expect(store.inboxPending().find((job) => job.id === waiting)?.payload).toBe('w');

		const failed = store.inboxAdd('acme', 'github', 'd-fail', 'f1', AT) as number;
		store.inboxFailed(failed, 'boom');
		expect(store.inboxAdd('acme', 'github', 'd-fail', 'f2', '2026-10-29T08:00:00Z')).toBe(failed);
		expect(store.inboxPending().find((job) => job.id === failed)?.payload).toBe('f2');
		expect(store.inboxFailedList()).toEqual([]);
		// Without a delivery id nothing is ever a duplicate.
		const x = store.inboxAdd('acme', 'vercel.deploy', null, 'p', AT);
		const y = store.inboxAdd('acme', 'vercel.deploy', null, 'p', AT);
		expect(x).not.toBeNull();
		expect(y).not.toBeNull();
		expect(y).not.toBe(x);
		store.close();
	});

	test('failed только из pending: выполненная не становится упавшей', () => {
		const store = new Store(':memory:');
		const id = store.inboxAdd('acme', 'github', null, 'p', AT) as number;
		store.inboxDone(id);
		store.inboxFailed(id, 'late');
		expect(store.inboxFailedList()).toEqual([]);
		store.close();
	});

	test('время приёма не дата — ошибка, ничего не записано', () => {
		const store = new Store(':memory:');
		expect(() => store.inboxAdd('acme', 'github', 'd', 'p', 'yesterday')).toThrow(RangeError);
		expect(store.inboxPending()).toEqual([]);
		store.close();
	});
});

describe('Store: другое соединение держит запись', () => {
	/** A second process takes the write lock on `path`, says so, holds it for `ms`, then commits. */
	async function holdLock(path: string, ms: number) {
		const child = Bun.spawn(
			[
				process.execPath,
				'-e',
				`const { Database } = require('bun:sqlite');
				const db = new Database(${JSON.stringify(path)});
				db.run('BEGIN IMMEDIATE');
				console.log('locked');
				Bun.sleepSync(${ms});
				db.run('COMMIT');`,
			],
			{ stdout: 'pipe', stderr: 'inherit' },
		);
		const reader = child.stdout.getReader();
		const { value } = await reader.read();
		expect(new TextDecoder().decode(value)).toContain('locked');
		reader.releaseLock();
		return child;
	}

	test('запись ждёт чужую блокировку и проходит; открытие свежей базы блокировку не берёт', async () => {
		const path = tempFile();
		new Store(path).close();
		const child = await holdLock(path, 200);
		// Opening an up-to-date file writes nothing, so it does not wait for (or fail on) the lock.
		const store = new Store(path);
		const started = performance.now();
		const id = store.inboxAdd('acme', 'github', 'd-locked', '{}', '2026-10-28T10:00:00Z');
		expect(typeof id).toBe('number');
		expect(performance.now() - started).toBeGreaterThan(50);
		expect(await child.exited).toBe(0);
		expect(store.inboxPending().map((job) => job.id)).toEqual([id as number]);
		store.close();
	});
});

describe('Store: журнал переходов', () => {
	const row = (key: string, at: string, tenant = 'acme') => ({
		tenant,
		key,
		from: 'Todo',
		to: 'In Review',
		cause: `pr:acme/api#${key.split('-')[1]}`,
		at,
	});

	test('journalSince: с момента включительно, по времени, фильтр тенанта', () => {
		const store = new Store(':memory:');
		store.journalAdd(row('ENG-2', '2026-10-28T12:00:00Z'));
		store.journalAdd(row('ENG-1', '2026-10-28T10:00:00+00:00'));
		store.journalAdd(row('QA-3', '2026-10-28T11:00:00Z', 'beta'));
		store.journalAdd(row('ENG-0', '2026-10-27T23:59:59Z'));
		expect(store.journalSince('2026-10-28T10:00:00Z').map((r) => r.key)).toEqual([
			'ENG-1',
			'QA-3',
			'ENG-2',
		]);
		expect(store.journalSince('2026-10-28T10:00:00Z', 'beta')).toEqual([
			{
				tenant: 'beta',
				key: 'QA-3',
				from: 'Todo',
				to: 'In Review',
				cause: 'pr:acme/api#3',
				at: '2026-10-28T11:00:00.000Z',
			},
		]);
		expect(() => store.journalSince('7d')).toThrow(RangeError);
		store.close();
	});

	test('prune удаляет выполненные старше 14 дней и журнал старше 180', () => {
		const path = tempFile();
		const store = new Store(path);
		const now = '2026-10-29T00:00:00.000Z';
		const oldDone = store.inboxAdd(
			'acme',
			'github',
			'd-old',
			'p',
			'2026-10-14T23:59:59Z',
		) as number;
		const freshDone = store.inboxAdd(
			'acme',
			'github',
			'd-new',
			'p',
			'2026-10-15T00:00:00Z',
		) as number;
		const oldFailed = store.inboxAdd(
			'acme',
			'github',
			'd-f',
			'p',
			'2026-01-01T00:00:00Z',
		) as number;
		const oldPending = store.inboxAdd(
			'acme',
			'github',
			null,
			'p',
			'2026-01-01T00:00:00Z',
		) as number;
		store.inboxDone(oldDone);
		store.inboxDone(freshDone);
		store.inboxFailed(oldFailed, 'x');
		store.journalAdd(row('ENG-1', '2026-05-01T23:59:59Z'));
		store.journalAdd(row('ENG-2', '2026-05-02T00:00:00Z'));
		store.prune(now);
		expect(payloadOf(path, oldDone)).toBeNull();
		expect(payloadOf(path, freshDone)).toEqual({ payload: null, status: 'done' });
		expect(store.inboxFailedList().map((job) => job.id)).toEqual([oldFailed]);
		expect(store.inboxPending().map((job) => job.id)).toEqual([oldPending]);
		expect(store.journalSince('2000-01-01T00:00:00Z').map((r) => r.key)).toEqual(['ENG-2']);
		// The pruned delivery id is forgotten: a redelivery after the window is new.
		expect(store.inboxAdd('acme', 'github', 'd-old', 'p', now)).not.toBeNull();
		expect(store.inboxAdd('acme', 'github', 'd-new', 'p', now)).toBeNull();
		store.close();
	});
});
