import { describe, expect, test } from 'bun:test';

import type { Tenant } from '../src/config.ts';
import type { LogEntry } from '../src/log.ts';
import { MiroApiError, MiroNotConnected } from '../src/miro/rest.ts';
import { createRuntime } from '../src/runtime.ts';
import { Store } from '../src/store.ts';
import { checkHealth } from '../src/watchdog.ts';
import { configOf } from './config-fixture.ts';
import { FakeMiro } from './fake-miro.ts';
import { FakePlane } from './fake-plane.ts';

const HOUR = 3_600_000;
const tenantOf = (id: string, over: Partial<Tenant> = {}): Tenant => ({
	...(configOf().tenants[0] as Tenant),
	id,
	...over,
});

function setup(tenants: Tenant[] = [tenantOf('initech')]) {
	const store = new Store(':memory:');
	const logs: LogEntry[] = [];
	const miros = new Map(tenants.map((t) => [t.id, new FakeMiro()]));
	const runtimes = new Map(
		tenants.map((t) => [
			t.id,
			createRuntime(t, {
				planeUrl: 'https://plane.example.com',
				store,
				plane: new FakePlane(),
				miro: miros.get(t.id),
			}),
		]),
	);
	const tokenOk = new Map<string, boolean>();
	const check = (now: number, startedAt = 0) =>
		checkHealth({ runtimes, store, log: (e) => logs.push(e), now, startedAt, tokenOk });
	const miro = (id = 'initech') => miros.get(id) as FakeMiro;
	return { store, logs, check, miro, tokenOk };
}

describe('checkHealth: тишина Plane', () => {
	test('тишина дольше silenceHours → plane.silent один раз, событие → plane.alive', async () => {
		const { store, check, logs } = setup();
		store.touchEvent('initech', 0);
		await check(73 * HOUR + 5);
		expect(logs).toEqual([{ event: 'plane.silent', level: 'error', tenant: 'initech', hours: 73 }]);
		expect(store.silence('initech').alertedAt).toBe(73 * HOUR + 5);
		await check(90 * HOUR);
		expect(logs).toHaveLength(1);
		store.touchEvent('initech', 91 * HOUR);
		await check(92 * HOUR);
		expect(logs.at(-1)).toEqual({ event: 'plane.alive', tenant: 'initech' });
		expect(logs).toHaveLength(2);
		expect(store.silence('initech').alertedAt).toBeNull();
		await check(93 * HOUR);
		expect(logs).toHaveLength(2);
	});

	test('ровно silenceHours — ещё не тревога, на мс больше — тревога', async () => {
		const { store, check, logs } = setup();
		store.touchEvent('initech', 1_000);
		await check(1_000 + 72 * HOUR);
		expect(logs).toEqual([]);
		await check(1_000 + 72 * HOUR + 1);
		expect(logs).toHaveLength(1);
	});

	test('после тревоги событий не было → plane.alive нет, тревога остаётся', async () => {
		const { store, check, logs } = setup();
		store.touchEvent('initech', 0);
		await check(80 * HOUR);
		await check(500 * HOUR);
		expect(logs).toHaveLength(1);
		expect(store.silence('initech').alertedAt).toBe(80 * HOUR);
	});

	test('событие ровно в момент тревоги не считается возвращением', async () => {
		const { store, check, logs } = setup();
		store.touchEvent('initech', 0);
		await check(80 * HOUR);
		store.touchEvent('initech', 80 * HOUR);
		await check(81 * HOUR);
		expect(logs.map((l) => l.event)).toEqual(['plane.silent']);
	});

	test('тенант без событий: отсчёт от startedAt, сразу после старта тревоги нет', async () => {
		const { store, check, logs } = setup();
		const start = 1_000_000 * HOUR;
		await check(start + 1, start);
		await check(start + 72 * HOUR, start);
		expect(logs).toEqual([]);
		await check(start + 73 * HOUR, start);
		expect(logs).toEqual([{ event: 'plane.silent', level: 'error', tenant: 'initech', hours: 73 }]);
		expect(store.silence('initech').alertedAt).toBe(start + 73 * HOUR);
	});

	test('silenceHours тенанта свой: 1 ч у одного и 72 ч у другого', async () => {
		const { store, check, logs } = setup([tenantOf('fast', { silenceHours: 1 }), tenantOf('slow')]);
		store.touchEvent('fast', 0);
		store.touchEvent('slow', 0);
		await check(2 * HOUR);
		expect(logs).toEqual([{ event: 'plane.silent', level: 'error', tenant: 'fast', hours: 2 }]);
	});
});

describe('checkHealth: токен Miro', () => {
	test('токена Miro нет → miro.not_connected на первом тике, на втором — тишина', async () => {
		const { check, logs, miro } = setup();
		miro().failNext('tokenValid', new MiroNotConnected());
		miro().failNext('tokenValid', new MiroNotConnected());
		await check(1);
		expect(logs).toEqual([{ event: 'miro.not_connected', level: 'error', tenant: 'initech' }]);
		await check(2);
		expect(logs).toHaveLength(1);
	});

	test('токен отозван → miro.token_invalid один раз, вернулся → miro.token_ok', async () => {
		const { check, logs, miro } = setup();
		await check(1);
		expect(logs).toEqual([]);
		miro().setTokenValid(false);
		await check(2);
		await check(3);
		expect(logs).toEqual([{ event: 'miro.token_invalid', level: 'error', tenant: 'initech' }]);
		miro().setTokenValid(true);
		await check(4);
		await check(5);
		expect(logs.at(-1)).toEqual({ event: 'miro.token_ok', tenant: 'initech' });
		expect(logs).toHaveLength(2);
	});

	test('был рабочий токен, затем его нет → miro.not_connected при смене состояния', async () => {
		const { check, logs, miro } = setup();
		await check(1);
		miro().failNext('tokenValid', new MiroNotConnected());
		await check(2);
		expect(logs).toEqual([{ event: 'miro.not_connected', level: 'error', tenant: 'initech' }]);
	});

	test('первый тик с отозванным токеном → miro.token_invalid сразу', async () => {
		const { check, logs, miro } = setup();
		miro().setTokenValid(false);
		await check(1);
		expect(logs).toEqual([{ event: 'miro.token_invalid', level: 'error', tenant: 'initech' }]);
	});

	test('ошибка сети → watchdog.failed, состояние не меняется; другой тенант проверен', async () => {
		const { check, logs, miro, tokenOk } = setup([tenantOf('a'), tenantOf('b')]);
		await check(1);
		miro('a').failNext('tokenValid', new MiroApiError(0, 'GET', '/v1/oauth-token'));
		miro('b').setTokenValid(false);
		await check(2);
		expect(logs).toEqual([
			{ event: 'watchdog.failed', level: 'error', tenant: 'a', error: 'MiroApiError' },
			{ event: 'miro.token_invalid', level: 'error', tenant: 'b' },
		]);
		expect(tokenOk.get('a')).toBe(true);
		miro('a').setTokenValid(false);
		await check(3);
		expect(logs.at(-1)).toEqual({ event: 'miro.token_invalid', level: 'error', tenant: 'a' });
	});

	test('сбой хранилища одного тенанта не останавливает остальных', async () => {
		const { check, logs, store, miro } = setup([tenantOf('a'), tenantOf('b')]);
		const real = store.silence.bind(store);
		store.silence = (tenant: string) => {
			if (tenant === 'a') throw new TypeError('db');
			return real(tenant);
		};
		miro('b').setTokenValid(false);
		await check(1);
		expect(logs).toEqual([
			{ event: 'watchdog.failed', level: 'error', tenant: 'a', error: 'TypeError' },
			{ event: 'miro.token_invalid', level: 'error', tenant: 'b' },
		]);
	});
});
