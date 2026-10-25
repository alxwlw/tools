import { describe, expect, test } from 'bun:test';

import type { Tenant } from '../src/config.ts';
import { DiscordApiError } from '../src/discord/rest.ts';
import type { LogEntry } from '../src/log.ts';
import { Store } from '../src/store.ts';
import { checkSilence } from '../src/watchdog.ts';
import { FakeDiscord } from './fake-discord.ts';

const HOUR = 3_600_000;
const SERVICE = '222222222222222222';
const tenantOf = (id: string, over: Partial<Tenant> = {}): Tenant => ({
	id,
	guildId: '111111111111111111',
	workspace: 'example-ws',
	workspaceId: '00000000-0000-4000-8000-000000000001',
	auth: { clientId: 'c', clientSecret: 's', appInstallationId: 'i' },
	webhookSecret: 'h',
	serviceChannelId: SERVICE,
	silenceHours: 72,
	hiddenProjects: [],
	channels: [],
	users: [],
	...over,
});

function setup(tenants: Tenant[] = [tenantOf('initech')]) {
	const store = new Store(':memory:');
	const discord = new FakeDiscord();
	const logs: LogEntry[] = [];
	const check = (now: number, startedAt = 0) =>
		checkSilence({ tenants, store, discord, log: (e) => logs.push(e), now, startedAt });
	const sentTexts = () =>
		(discord.callsOf('sendMessage') as Array<[string, { content: string }]>).map(([c, m]) => [
			c,
			m.content,
		]);
	return { store, discord, logs, check, sentTexts };
}

describe('checkSilence', () => {
	test('тишина дольше silenceHours → одно сообщение в служебный канал и plane.silent; повторная проверка — без второго', async () => {
		const { store, check, sentTexts, logs } = setup();
		store.touchEvent('initech', 0);
		await check(73 * HOUR + 5);
		expect(sentTexts()).toEqual([
			[SERVICE, 'Plane молчит 73 ч (example-ws): проверь вебхук — runbook plane-discord'],
		]);
		expect(logs).toEqual([{ event: 'plane.silent', level: 'error', tenant: 'initech', hours: 73 }]);
		expect(store.silence('initech').alertedAt).toBe(73 * HOUR + 5);
		await check(90 * HOUR);
		expect(sentTexts()).toHaveLength(1);
		expect(logs).toHaveLength(1);
	});

	test('ровно silenceHours — ещё не тревога, на мс больше — тревога', async () => {
		const { store, check, sentTexts } = setup();
		store.touchEvent('initech', 1_000);
		await check(1_000 + 72 * HOUR);
		expect(sentTexts()).toEqual([]);
		await check(1_000 + 72 * HOUR + 1);
		expect(sentTexts()).toHaveLength(1);
	});

	test('событие после тревоги → «снова на связи», plane.alive, тревога сброшена', async () => {
		const { store, check, sentTexts, logs } = setup();
		store.touchEvent('initech', 0);
		await check(80 * HOUR);
		store.touchEvent('initech', 81 * HOUR);
		await check(82 * HOUR);
		expect(sentTexts()[1]).toEqual([SERVICE, 'Plane снова на связи']);
		expect(logs.at(-1)).toEqual({ event: 'plane.alive', tenant: 'initech' });
		expect(store.silence('initech').alertedAt).toBeNull();
		await check(83 * HOUR);
		expect(sentTexts()).toHaveLength(2);
	});

	test('после тревоги событий не было → «снова на связи» нет, тревога остаётся', async () => {
		const { store, check, sentTexts } = setup();
		store.touchEvent('initech', 0);
		await check(80 * HOUR);
		await check(500 * HOUR);
		expect(sentTexts()).toHaveLength(1);
		expect(store.silence('initech').alertedAt).toBe(80 * HOUR);
	});

	test('событие ровно в момент тревоги (lastEventAt == alertedAt) не считается возвращением', async () => {
		const { store, check, sentTexts } = setup();
		store.touchEvent('initech', 0);
		await check(80 * HOUR);
		store.touchEvent('initech', 80 * HOUR);
		await check(81 * HOUR);
		expect(sentTexts()).toHaveLength(1);
	});

	test('serviceChannelId null → только лог', async () => {
		const { store, check, discord, logs } = setup([
			tenantOf('initech', { serviceChannelId: null }),
		]);
		store.touchEvent('initech', 0);
		await check(80 * HOUR);
		expect(discord.calls).toEqual([]);
		expect(logs).toEqual([{ event: 'plane.silent', level: 'error', tenant: 'initech', hours: 80 }]);
		expect(store.silence('initech').alertedAt).toBe(80 * HOUR);
		store.touchEvent('initech', 81 * HOUR);
		await check(82 * HOUR);
		expect(discord.calls).toEqual([]);
		expect(logs.at(-1)).toEqual({ event: 'plane.alive', tenant: 'initech' });
	});

	test('тенант без событий: отсчёт от startedAt, сразу после старта тревоги нет', async () => {
		const { store, check, sentTexts, logs } = setup();
		const start = 1_000_000 * HOUR;
		await check(start + 1, start);
		await check(start + 72 * HOUR, start);
		expect(sentTexts()).toEqual([]);
		expect(logs).toEqual([]);
		await check(start + 73 * HOUR, start);
		expect(sentTexts()).toHaveLength(1);
		expect(store.silence('initech').alertedAt).toBe(start + 73 * HOUR);
	});

	test('silenceHours тенанта свой: 1 ч тенанта и 72 ч другого', async () => {
		const { store, check, sentTexts } = setup([
			tenantOf('fast', { silenceHours: 1 }),
			tenantOf('slow', { serviceChannelId: '333333333333333333' }),
		]);
		store.touchEvent('fast', 0);
		store.touchEvent('slow', 0);
		await check(2 * HOUR);
		expect(sentTexts()).toEqual([
			[SERVICE, 'Plane молчит 2 ч (example-ws): проверь вебхук — runbook plane-discord'],
		]);
	});

	test('сбой Discord: тревога не помечена, повтор на следующей проверке; другой тенант не страдает', async () => {
		const { store, check, discord, sentTexts, logs } = setup([
			tenantOf('a'),
			tenantOf('b', { serviceChannelId: '333333333333333333' }),
		]);
		store.touchEvent('a', 0);
		store.touchEvent('b', 0);
		discord.failures.set('sendMessage', new DiscordApiError(500, 'POST', '/channels/x/messages'));
		await check(80 * HOUR);
		expect(store.silence('a').alertedAt).toBeNull();
		expect(store.silence('b').alertedAt).toBeNull();
		// both were tried: a failure of the first does not skip the second
		expect(discord.callsOf('sendMessage')).toHaveLength(2);
		expect(logs).toEqual([
			{ event: 'watchdog.failed', level: 'error', tenant: 'a', error: 'DiscordApiError' },
			{ event: 'watchdog.failed', level: 'error', tenant: 'b', error: 'DiscordApiError' },
		]);
		discord.failures.clear();
		await check(81 * HOUR);
		// the fake records failed attempts too: two failed, then two delivered
		expect(sentTexts().slice(2)).toEqual([
			[SERVICE, 'Plane молчит 81 ч (example-ws): проверь вебхук — runbook plane-discord'],
			[
				'333333333333333333',
				'Plane молчит 81 ч (example-ws): проверь вебхук — runbook plane-discord',
			],
		]);
		expect(store.silence('a').alertedAt).toBe(81 * HOUR);
		expect(store.silence('b').alertedAt).toBe(81 * HOUR);
	});
});
