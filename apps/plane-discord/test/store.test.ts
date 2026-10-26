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
		store.putThread('acme', 'item-1', 'chan-1', 'thread-1', 'proj-1');
		expect(store.getThread('acme', 'item-1', 'chan-1')).toBe('thread-1');
		expect(store.getThread('acme', 'item-1', 'chan-2')).toBeNull();
		expect(store.getThread('other', 'item-1', 'chan-1')).toBeNull();
		expect(store.getThread('acme', 'item-2', 'chan-1')).toBeNull();
		store.putThread('acme', 'item-1', 'chan-1', 'thread-2', 'proj-1');
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
		first.putThread('acme', 'item-1', 'chan-1', 'thread-1', 'proj-1');
		first.putDiscordItem('acme', 'msg-1', 'proj-1', 'item-1');
		first.touchEvent('acme', 42);
		first.close();
		expect(() => first.silence('acme')).toThrow();
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

	test('close сворачивает WAL: файла -wal на диске нет', () => {
		const dir = mkdtempSync(join(tmpdir(), 'plane-discord-store-'));
		dirs.push(dir);
		const path = join(dir, 'state.sqlite');
		const store = new Store(path);
		store.touchEvent('acme', 1);
		store.close();
		expect(existsSync(`${path}-wal`)).toBe(false);
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

describe('Store: треды и задачи', () => {
	test('findByThread находит и пост форума из 1a; threadsOfItem — все треды задачи', () => {
		const store = new Store(':memory:');
		store.putThread('acme', 'item-1', 'chan-2', 'thread-b', 'proj-1');
		store.putThread('acme', 'item-1', 'chan-1', 'thread-a', 'proj-1');
		store.putThread('acme', 'item-2', 'chan-1', 'thread-c', null);
		store.putThread('other', 'item-1', 'chan-1', 'thread-d', 'proj-9');
		expect(store.findByThread('thread-a')).toEqual({
			tenant: 'acme',
			projectId: 'proj-1',
			workItemId: 'item-1',
			channelId: 'chan-1',
		});
		expect(store.findByThread('thread-c')?.projectId).toBeNull();
		expect(store.findByThread('nope')).toBeNull();
		expect(store.threadsOfItem('acme', 'item-1')).toEqual([
			{ channelId: 'chan-1', threadId: 'thread-a' },
			{ channelId: 'chan-2', threadId: 'thread-b' },
		]);
		expect(store.threadsOfItem('acme', 'item-9')).toEqual([]);
	});

	test('upsert по (tenant, item, channel) заменяет и thread_id, и project_id', () => {
		const store = new Store(':memory:');
		store.putThread('acme', 'item-1', 'chan-1', 'thread-a', null);
		store.putThread('acme', 'item-1', 'chan-1', 'thread-b', 'proj-1');
		expect(store.findByThread('thread-a')).toBeNull();
		expect(store.findByThread('thread-b')?.projectId).toBe('proj-1');
	});

	test('миграция: старая таблица threads без project_id получает колонку, строки целы', () => {
		const dir = mkdtempSync(join(tmpdir(), 'plane-discord-store-'));
		dirs.push(dir);
		const path = join(dir, 'state.sqlite');
		const old = new Database(path, { create: true });
		old.run(
			`CREATE TABLE threads (
				tenant TEXT NOT NULL,
				work_item_id TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				thread_id TEXT NOT NULL UNIQUE,
				PRIMARY KEY (tenant, work_item_id, channel_id)
			)`,
		);
		old.run("INSERT INTO threads VALUES ('acme', 'item-1', 'chan-1', 'thread-1')");
		old.close();
		const store = new Store(path);
		expect(store.getThread('acme', 'item-1', 'chan-1')).toBe('thread-1');
		expect(store.findByThread('thread-1')?.projectId).toBeNull();
		store.putThread('acme', 'item-2', 'chan-1', 'thread-2', 'proj-1');
		expect(store.findByThread('thread-2')?.projectId).toBe('proj-1');
		store.close();
		// A second open finds the column and does not try to add it again.
		const again = new Store(path);
		expect(again.findByThread('thread-2')?.projectId).toBe('proj-1');
		again.close();
	});
});

describe('Store: setThreadProject', () => {
	test('заполняет только пустой project_id своего треда', () => {
		const store = new Store(':memory:');
		store.putThread('acme', 'item-1', 'chan-1', 'thread-1', null);
		store.putThread('acme', 'item-2', 'chan-1', 'thread-2', null);
		store.putThread('acme', 'item-3', 'chan-1', 'thread-3', 'proj-3');
		store.setThreadProject('thread-1', 'proj-1');
		store.setThreadProject('thread-3', 'proj-other');
		expect(store.findByThread('thread-1')?.projectId).toBe('proj-1');
		expect(store.findByThread('thread-2')?.projectId).toBeNull();
		expect(store.findByThread('thread-3')?.projectId).toBe('proj-3');
		store.setThreadProject('no-such-thread', 'proj-1');
		expect(store.findByThread('no-such-thread')).toBeNull();
	});
});

describe('Store: webhooks', () => {
	test('putWebhook/getWebhook/isOwnWebhook; повтор по каналу заменяет вебхук', () => {
		const store = new Store(':memory:');
		expect(store.getWebhook('chan-1')).toBeNull();
		expect(store.isOwnWebhook('wh-1')).toBe(false);
		store.putWebhook('chan-1', 'wh-1', 'tok-1');
		expect(store.getWebhook('chan-1')).toEqual({ id: 'wh-1', token: 'tok-1' });
		expect(store.isOwnWebhook('wh-1')).toBe(true);
		expect(store.getWebhook('chan-2')).toBeNull();
		store.putWebhook('chan-1', 'wh-2', 'tok-2');
		expect(store.getWebhook('chan-1')).toEqual({ id: 'wh-2', token: 'tok-2' });
		expect(store.isOwnWebhook('wh-1')).toBe(false);
		expect(store.isOwnWebhook('wh-2')).toBe(true);
	});

	test('база фазы 2 без таблицы webhooks получает её при открытии', () => {
		const dir = mkdtempSync(join(tmpdir(), 'store-'));
		dirs.push(dir);
		const path = join(dir, 's.sqlite');
		const old = new Database(path, { create: true });
		old.run('CREATE TABLE seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL)');
		old.close();
		const store = new Store(path);
		store.putWebhook('c', 'w', 't');
		expect(store.isOwnWebhook('w')).toBe(true);
		store.close();
	});
});

describe('Store: deleteThread', () => {
	test('снимает привязку этого треда и не трогает другие', () => {
		const store = new Store(':memory:');
		store.putThread('t', 'i1', 'c1', 'thread-1', 'p');
		store.putThread('t', 'i2', 'c1', 'thread-2', 'p');
		store.deleteThread('thread-1');
		expect(store.findByThread('thread-1')).toBeNull();
		expect(store.findByThread('thread-2')?.workItemId).toBe('i2');
		expect(store.threadsOfItem('t', 'i1')).toEqual([]);
		store.deleteThread('no-such');
		expect(store.findByThread('thread-2')?.workItemId).toBe('i2');
	});
});
