// Adapted from apps/plane-miro/test/watchdog.test.ts (silence rules); the stale-sync tests are new.
import { describe, expect, test } from 'bun:test';

import type { CopyData } from '../src/contract.ts';
import type { LogEntry } from '../src/log.ts';
import { Store } from '../src/store.ts';
import { checkHealth, newWatchdogState } from '../src/watchdog.ts';

const HOUR = 3_600_000;
const EMPTY: CopyData = { projects: [], states: [], labels: [], modules: [], items: [], edges: [] };
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

function setup(tenants: string[] = ['initech']) {
	const store = new Store(':memory:');
	const logs: LogEntry[] = [];
	const state = newWatchdogState();
	const check = (now: number, startedAt = 0) =>
		checkHealth({ tenants, store, log: (e) => logs.push(e), now, startedAt, state });
	const synced = (tenant: string, at: number) =>
		store.replaceCopy(tenant, EMPTY, new Date(at).toISOString());
	/** Like `check`, but the copy was just synced: only the silence rules are under test. */
	const checkSilence = (now: number, startedAt = 0) => {
		for (const t of tenants) synced(t, now);
		check(now, startedAt);
	};
	return { store, logs, check, checkSilence, synced, state };
}

describe('checkHealth: тишина Plane', () => {
	test('тишина дольше 72 ч → plane.silent один раз, событие → plane.alive', () => {
		const { store, checkSilence: check, logs, state } = setup();
		store.touchEvent('initech', 0);
		check(73 * HOUR + 5);
		expect(logs).toEqual([{ event: 'plane.silent', level: 'error', tenant: 'initech', hours: 73 }]);
		expect(state.silentAt.get('initech')).toBe(73 * HOUR + 5);
		check(90 * HOUR);
		expect(logs).toHaveLength(1);
		store.touchEvent('initech', 91 * HOUR);
		check(92 * HOUR);
		expect(logs.at(-1)).toEqual({ event: 'plane.alive', tenant: 'initech' });
		expect(logs).toHaveLength(2);
		expect(state.silentAt.has('initech')).toBe(false);
		check(93 * HOUR);
		expect(logs).toHaveLength(2);
	});

	test('ровно 72 ч — ещё не тревога, на мс больше — тревога', () => {
		const { store, checkSilence: check, logs } = setup();
		store.touchEvent('initech', 1_000);
		check(1_000 + 72 * HOUR);
		expect(logs).toEqual([]);
		check(1_000 + 72 * HOUR + 1);
		expect(logs).toHaveLength(1);
	});

	test('после тревоги событий не было → plane.alive нет, тревога остаётся', () => {
		const { store, checkSilence: check, logs, state } = setup();
		store.touchEvent('initech', 0);
		check(80 * HOUR);
		check(500 * HOUR);
		expect(logs).toHaveLength(1);
		expect(state.silentAt.get('initech')).toBe(80 * HOUR);
	});

	test('событие ровно в момент тревоги не считается возвращением', () => {
		const { store, checkSilence: check, logs } = setup();
		store.touchEvent('initech', 0);
		check(80 * HOUR);
		store.touchEvent('initech', 80 * HOUR);
		check(81 * HOUR);
		expect(logs.map((l) => l.event)).toEqual(['plane.silent']);
	});

	test('тенант без событий: отсчёт от startedAt, сразу после старта тревоги нет', () => {
		const { checkSilence: check, logs, state } = setup();
		const start = 1_000_000 * HOUR;
		check(start + 1, start);
		check(start + 72 * HOUR, start);
		expect(logs).toEqual([]);
		check(start + 73 * HOUR, start);
		expect(logs).toEqual([{ event: 'plane.silent', level: 'error', tenant: 'initech', hours: 73 }]);
		expect(state.silentAt.get('initech')).toBe(start + 73 * HOUR);
	});
});

describe('checkHealth: давность сверки', () => {
	test('сверке больше 26 ч → watchdog.stale_sync (error) с часами; ровно 26 ч — ещё нет', () => {
		const { store, check, logs, synced } = setup();
		store.touchEvent('initech', T0 + 26 * HOUR);
		synced('initech', T0);
		check(T0 + 26 * HOUR, T0);
		expect(logs).toEqual([]);
		check(T0 + 26 * HOUR + 1, T0);
		expect(logs).toEqual([
			{ event: 'watchdog.stale_sync', level: 'error', tenant: 'initech', hours: 26 },
		]);
	});

	test('раз в сутки на тенант: через 24 ч − 1 мс тихо, через 24 ч снова с новыми часами', () => {
		const { store, check, logs, synced } = setup();
		synced('initech', T0);
		const first = T0 + 27 * HOUR;
		store.touchEvent('initech', first);
		check(first, T0);
		store.touchEvent('initech', first + 24 * HOUR - 1);
		check(first + HOUR, T0);
		check(first + 24 * HOUR - 1, T0);
		expect(logs).toHaveLength(1);
		store.touchEvent('initech', first + 24 * HOUR);
		check(first + 24 * HOUR, T0);
		expect(logs).toEqual([
			{ event: 'watchdog.stale_sync', level: 'error', tenant: 'initech', hours: 27 },
			{ event: 'watchdog.stale_sync', level: 'error', tenant: 'initech', hours: 51 },
		]);
	});

	test('удачная сверка снимает тревогу: после неё до 26 ч тихо', () => {
		const { store, check, logs, synced } = setup();
		synced('initech', T0);
		store.touchEvent('initech', T0 + 30 * HOUR);
		check(T0 + 30 * HOUR, T0);
		expect(logs).toHaveLength(1);
		synced('initech', T0 + 30 * HOUR);
		store.touchEvent('initech', T0 + 56 * HOUR);
		check(T0 + 56 * HOUR, T0);
		expect(logs).toHaveLength(1);
	});

	test('копия не сверялась ни разу: отсчёт от startedAt', () => {
		const { store, check, logs } = setup();
		store.touchEvent('initech', T0 + 26 * HOUR);
		check(T0 + 26 * HOUR, T0);
		expect(logs).toEqual([]);
		check(T0 + 26 * HOUR + 1, T0);
		expect(logs.map((l) => l.event)).toEqual(['watchdog.stale_sync']);
	});

	test('тенанты независимы: у одного старая сверка, у другого свежая', () => {
		const { store, check, logs, synced } = setup(['old', 'fresh']);
		synced('old', T0);
		synced('fresh', T0 + 20 * HOUR);
		for (const t of ['old', 'fresh']) store.touchEvent(t, T0 + 30 * HOUR);
		check(T0 + 30 * HOUR, T0);
		expect(logs).toEqual([
			{ event: 'watchdog.stale_sync', level: 'error', tenant: 'old', hours: 30 },
		]);
	});

	test('сбой хранилища одного тенанта не останавливает остальных', () => {
		const { store, check, logs, synced } = setup(['a', 'b']);
		synced('b', T0);
		for (const t of ['a', 'b']) store.touchEvent(t, T0 + 30 * HOUR);
		const real = store.copy.bind(store);
		store.copy = (tenant: string) => {
			if (tenant === 'a') throw new TypeError('db');
			return real(tenant);
		};
		check(T0 + 30 * HOUR, T0);
		expect(logs).toEqual([
			{ event: 'watchdog.failed', level: 'error', tenant: 'a', error: 'TypeError' },
			{ event: 'watchdog.stale_sync', level: 'error', tenant: 'b', hours: 30 },
		]);
	});
});
