// Adapted from apps/plane-discord/test/store.test.ts.
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

function tmpPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'plane-miro-store-'));
	dirs.push(dir);
	return join(dir, 'state.sqlite');
}

describe('Store: дедуп и heartbeat', () => {
	test('claim: первый раз true, второй false', () => {
		const store = new Store(':memory:');
		expect(store.claim('plane:acme:k1', 1000)).toBe(true);
		expect(store.claim('plane:acme:k1', 2000)).toBe(false);
		expect(store.claim('miro:777', 1000)).toBe(true);
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
});

describe('Store: источники, карточки, токены', () => {
	test('источник: сначала задача, потом карточка', () => {
		const s = new Store(':memory:');
		s.putSource('acme', 'uXjVb1=', '101', { workItemId: 'w1', projectId: 'p1', key: 'LAB-1' });
		expect(s.getSource('acme', 'uXjVb1=', '101')).toEqual({
			workItemId: 'w1',
			projectId: 'p1',
			key: 'LAB-1',
			cardId: null,
		});
		s.setSourceCard('acme', 'uXjVb1=', '101', '900');
		expect(s.getSource('acme', 'uXjVb1=', '101')?.cardId).toBe('900');
		expect(s.getSource('beta', 'uXjVb1=', '101')).toBeNull();
	});

	test('повторный putSource заменяет задачу и сбрасывает карточку', () => {
		const s = new Store(':memory:');
		s.putSource('acme', 'uXjVb1=', '101', { workItemId: 'w1', projectId: 'p1', key: 'LAB-1' });
		s.setSourceCard('acme', 'uXjVb1=', '101', '900');
		s.putSource('acme', 'uXjVb1=', '101', { workItemId: 'w2', projectId: 'p2', key: 'LAB-2' });
		expect(s.getSource('acme', 'uXjVb1=', '101')).toEqual({
			workItemId: 'w2',
			projectId: 'p2',
			key: 'LAB-2',
			cardId: null,
		});
	});

	test('карточки задачи видит только свой тенант', () => {
		const s = new Store(':memory:');
		s.putCard({
			tenant: 'acme',
			boardId: 'uXjVb1=',
			cardId: '900',
			workItemId: 'w1',
			projectId: 'p1',
			fieldsHash: null,
		});
		s.putCard({
			tenant: 'acme',
			boardId: 'uXjVb2=',
			cardId: '901',
			workItemId: 'w1',
			projectId: 'p1',
			fieldsHash: null,
		});
		expect(
			s
				.cardsOfItem('acme', 'w1')
				.map((c) => c.cardId)
				.sort(),
		).toEqual(['900', '901']);
		expect(s.cardsOfItem('beta', 'w1')).toEqual([]);
		expect(s.cardOnBoard('acme', 'w1', 'uXjVb2=')?.cardId).toBe('901');
		expect(s.cardOnBoard('beta', 'w1', 'uXjVb2=')).toBeNull();
	});

	test('putCard — upsert по (доска, карточка)', () => {
		const s = new Store(':memory:');
		const row = {
			tenant: 'acme',
			boardId: 'uXjVb1=',
			cardId: '900',
			workItemId: 'w1',
			projectId: 'p1',
			fieldsHash: null,
		};
		s.putCard(row);
		s.putCard({ ...row, workItemId: 'w2', projectId: 'p2', fieldsHash: 'h9' });
		expect(s.findCard('uXjVb1=', '900')).toEqual({
			...row,
			workItemId: 'w2',
			projectId: 'p2',
			fieldsHash: 'h9',
		});
		expect(s.cardsOfItem('acme', 'w1')).toEqual([]);
	});

	test('хеш полей и удаление карточки', () => {
		const s = new Store(':memory:');
		s.putCard({
			tenant: 'acme',
			boardId: 'uXjVb1=',
			cardId: '900',
			workItemId: 'w1',
			projectId: 'p1',
			fieldsHash: null,
		});
		s.setFieldsHash('uXjVb1=', '900', 'h1');
		expect(s.findCard('uXjVb1=', '900')?.fieldsHash).toBe('h1');
		s.deleteCard('uXjVb1=', '900');
		expect(s.findCard('uXjVb1=', '900')).toBeNull();
	});

	test('токен Miro команды заменяется новым', () => {
		const s = new Store(':memory:');
		s.putMiroToken('3458764500000000001', '1', 'old');
		s.putMiroToken('3458764500000000001', '2', 'new');
		expect(s.getMiroToken('3458764500000000001')).toBe('new');
		expect(s.getMiroToken('3458764500000000002')).toBeNull();
	});
});

describe('Store: файл', () => {
	test('файл базы переживает переоткрытие', () => {
		const path = tmpPath();
		const a = new Store(path);
		a.claim('k', 1000);
		a.putMiroToken('3458764500000000001', '1', 't');
		a.touchEvent('acme', 42);
		a.close();
		expect(() => a.silence('acme')).toThrow();
		const b = new Store(path);
		expect(b.getMiroToken('3458764500000000001')).toBe('t');
		expect(b.claim('k', 2000)).toBe(false);
		expect(b.silence('acme').lastEventAt).toBe(42);
		b.close();
	});

	test('close сворачивает WAL: файла -wal на диске нет', () => {
		const path = tmpPath();
		const store = new Store(path);
		store.touchEvent('acme', 1);
		store.close();
		expect(existsSync(`${path}-wal`)).toBe(false);
	});

	test('файловая база открывается в режиме WAL', () => {
		const path = tmpPath();
		new Store(path).close();
		const probe = new Database(path, { readonly: true });
		expect(
			probe.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode,
		).toBe('wal');
		probe.close();
	});
});
