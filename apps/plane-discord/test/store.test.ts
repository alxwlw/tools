import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Store', () => {
	test('claim: первый раз true, второй false', () => {
		const store = new Store(':memory:');
		expect(store.claim('plane:acme:k1', 1000)).toBe(true);
		expect(store.claim('plane:acme:k1', 2000)).toBe(false);
		expect(store.claim('ix:777', 1000)).toBe(true);
	});

	test('prune удаляет ключи старше порога, свежие остаются', () => {
		const store = new Store(':memory:');
		store.claim('old', 1000);
		store.claim('edge', 5000);
		store.claim('fresh', 9000);
		// threshold = 10000 - 5000 = 5000: strictly older than that goes
		expect(store.prune(5000, 10_000)).toBe(1);
		expect(store.claim('old', 10_000)).toBe(true);
		expect(store.claim('edge', 10_000)).toBe(false);
		expect(store.claim('fresh', 10_000)).toBe(false);
	});

	test('thread: put/get по (tenant, item, channel); другой канал → null', () => {
		const store = new Store(':memory:');
		store.putThread('acme', 'item-1', 'chan-1', 'thread-1');
		expect(store.getThread('acme', 'item-1', 'chan-1')).toBe('thread-1');
		expect(store.getThread('acme', 'item-1', 'chan-2')).toBeNull();
		expect(store.getThread('other', 'item-1', 'chan-1')).toBeNull();
		expect(store.getThread('acme', 'item-2', 'chan-1')).toBeNull();
		store.putThread('acme', 'item-1', 'chan-1', 'thread-2');
		expect(store.getThread('acme', 'item-1', 'chan-1')).toBe('thread-2');
	});

	test('discord item: put/get; тот же message id в другом тенанте → null', () => {
		const store = new Store(':memory:');
		store.putDiscordItem('acme', 'msg-1', 'proj-1', 'item-1');
		expect(store.getDiscordItem('acme', 'msg-1')).toEqual({
			projectId: 'proj-1',
			workItemId: 'item-1',
		});
		expect(store.getDiscordItem('other', 'msg-1')).toBeNull();
		expect(store.getDiscordItem('acme', 'msg-2')).toBeNull();
		store.putDiscordItem('acme', 'msg-1', 'proj-2', 'item-2');
		expect(store.getDiscordItem('acme', 'msg-1')).toEqual({
			projectId: 'proj-2',
			workItemId: 'item-2',
		});
	});

	test('heartbeat: touchEvent → silence().lastEventAt; markAlerted(null) сбрасывает alertedAt', () => {
		const store = new Store(':memory:');
		expect(store.silence('acme')).toEqual({ lastEventAt: null, alertedAt: null });
		store.touchEvent('acme', 111);
		expect(store.silence('acme')).toEqual({ lastEventAt: 111, alertedAt: null });
		store.markAlerted('acme', 222);
		expect(store.silence('acme')).toEqual({ lastEventAt: 111, alertedAt: 222 });
		store.touchEvent('acme', 333);
		expect(store.silence('acme')).toEqual({ lastEventAt: 333, alertedAt: 222 });
		store.markAlerted('acme', null);
		expect(store.silence('acme')).toEqual({ lastEventAt: 333, alertedAt: null });
		expect(store.silence('other')).toEqual({ lastEventAt: null, alertedAt: null });
	});

	test('markAlerted без touchEvent оставляет lastEventAt пустым', () => {
		const store = new Store(':memory:');
		store.markAlerted('acme', 5);
		expect(store.silence('acme')).toEqual({ lastEventAt: null, alertedAt: 5 });
	});

	test('файл на диске переживает close и повторное открытие', () => {
		const dir = mkdtempSync(join(tmpdir(), 'plane-discord-store-'));
		dirs.push(dir);
		const path = join(dir, 'state.sqlite');
		const first = new Store(path);
		first.claim('k', 1000);
		first.putThread('acme', 'item-1', 'chan-1', 'thread-1');
		first.putDiscordItem('acme', 'msg-1', 'proj-1', 'item-1');
		first.touchEvent('acme', 42);
		first.close();
		expect(() => first.silence('acme')).toThrow();
		expect(existsSync(`${path}-wal`)).toBe(false);
		const second = new Store(path);
		expect(second.claim('k', 2000)).toBe(false);
		expect(second.getThread('acme', 'item-1', 'chan-1')).toBe('thread-1');
		expect(second.getDiscordItem('acme', 'msg-1')).toEqual({
			projectId: 'proj-1',
			workItemId: 'item-1',
		});
		expect(second.silence('acme').lastEventAt).toBe(42);
		second.close();
	});

	test('файловая база открывается в режиме WAL', () => {
		const dir = mkdtempSync(join(tmpdir(), 'plane-discord-store-'));
		dirs.push(dir);
		const path = join(dir, 'state.sqlite');
		new Store(path).close();
		const probe = new Database(path, { readonly: true });
		expect(
			probe.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode,
		).toBe('wal');
		probe.close();
	});
});
