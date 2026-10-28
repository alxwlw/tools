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
		expect(store.deployCursor('acme', 'acme/api', 'staging')).toBe('sha-a');
		// Every part of the key counts.
		expect(store.deployCursor('other', 'acme/api', 'staging')).toBeNull();
		expect(store.deployCursor('acme', 'acme/infra', 'staging')).toBeNull();
		expect(store.deployCursor('acme', 'acme/api', 'production')).toBeNull();
		store.setDeployCursor('acme', 'acme/api', 'staging', 'sha-b', '2026-10-28T11:00:00.000Z');
		expect(store.deployCursor('acme', 'acme/api', 'staging')).toBe('sha-b');
		store.close();
	});

	test('cursorFor — вид на тенанта: get и set без тенанта в аргументах', () => {
		const store = new Store(':memory:');
		const acme = store.cursorFor('acme');
		const other = store.cursorFor('other');
		acme.set('acme/api', 'staging', 'sha-a');
		expect(acme.get('acme/api', 'staging')).toBe('sha-a');
		expect(other.get('acme/api', 'staging')).toBeNull();
		other.set('acme/api', 'staging', 'sha-o');
		expect(other.get('acme/api', 'staging')).toBe('sha-o');
		expect(acme.get('acme/api', 'staging')).toBe('sha-a');
		expect(store.deployCursor('other', 'acme/api', 'staging')).toBe('sha-o');
		expect(store.deployCursor('acme', 'acme/api', 'staging')).toBe('sha-a');
		store.close();
	});

	test('база переживает повторное открытие файла', () => {
		const path = tempFile();
		const first = new Store(path);
		first.setDeployCursor('acme', 'acme/api', 'production', 'sha-z', '2026-10-28T10:00:00.000Z');
		first.close();
		const second = new Store(path);
		expect(second.deployCursor('acme', 'acme/api', 'production')).toBe('sha-z');
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
			1,
		);
		raw.run('PRAGMA user_version = 99');
		raw.close();
		expect(() => new Store(path)).toThrow('schema version 99');
	});
});
