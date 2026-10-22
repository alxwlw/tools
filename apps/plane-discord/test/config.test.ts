import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { describeTenants, loadConfig } from '../src/config.ts';

const EXAMPLE = readFileSync(new URL('../tenants.example.json', import.meta.url), 'utf8');

const BASE_ENV: Record<string, string> = {
	PLANE_DISCORD_PLANE_URL: 'https://plane.example.com/',
	PLANE_DISCORD_PUBLIC_URL: 'https://plane-discord.example.com',
	PLANE_DISCORD_DISCORD_APPLICATION_ID: '555555555555555555',
	PLANE_DISCORD_DISCORD_PUBLIC_KEY: 'ab'.repeat(32),
	PLANE_DISCORD_DISCORD_BOT_TOKEN: 'bot-token-value',
	PLANE_DISCORD_ACME_PLANE_SECRET: 'client-secret-value',
	PLANE_DISCORD_ACME_WEBHOOK_SECRET: 'webhook-secret-value',
};

const example = () => JSON.parse(EXAMPLE) as { tenants: Array<Record<string, unknown>> };
const load = (file: unknown, env: Record<string, string | undefined> = BASE_ENV) =>
	loadConfig(env, () => (typeof file === 'string' ? file : JSON.stringify(file)));
const errorOf = (fn: () => unknown): string => {
	try {
		fn();
	} catch (e) {
		return (e as Error).message;
	}
	throw new Error('expected loadConfig to throw');
};

describe('loadConfig', () => {
	test('tenants.example.json с полным env проходит; events по умолчанию — все три; silenceHours 72', () => {
		const config = load(EXAMPLE);
		expect(config.planeUrl).toBe('https://plane.example.com');
		expect(config.port).toBe(8080);
		expect(config.configPath).toBe('/config/tenants.json');
		expect(config.tenants).toHaveLength(1);
		const [tenant] = config.tenants;
		expect(tenant?.id).toBe('acme');
		expect(tenant?.channels[0]?.events).toEqual(['created', 'closed', 'mention']);
		expect(tenant?.channels[0]?.moduleId).toBeNull();
		expect(tenant?.silenceHours).toBe(72);
		expect(describeTenants(config)).toEqual([{ id: 'acme', channels: 1, users: 1 }]);
	});

	test('нет трёх обязательных env — одна ошибка, в ней все три имени', () => {
		const env = { ...BASE_ENV };
		delete env.PLANE_DISCORD_PLANE_URL;
		delete env.PLANE_DISCORD_DISCORD_PUBLIC_KEY;
		delete env.PLANE_DISCORD_DISCORD_BOT_TOKEN;
		const message = errorOf(() => load(EXAMPLE, env));
		expect(message).toContain('PLANE_DISCORD_PLANE_URL');
		expect(message).toContain('PLANE_DISCORD_DISCORD_PUBLIC_KEY');
		expect(message).toContain('PLANE_DISCORD_DISCORD_BOT_TOKEN');
	});

	test('значение секрета не попадает в текст ошибки', () => {
		const file = example();
		file.tenants[0]!.guildId = 'not-a-snowflake';
		const message = errorOf(() =>
			load(file, { ...BASE_ENV, PLANE_DISCORD_ACME_PLANE_SECRET: 's3cr3t-value' }),
		);
		expect(message).toContain('tenants[0].guildId');
		expect(message).not.toContain('s3cr3t-value');
		expect(message).not.toContain('not-a-snowflake');
	});

	test('неизвестный ключ — ошибка с путём tenants[0].chanels', () => {
		const file = example();
		file.tenants[0]!.chanels = [];
		expect(errorOf(() => load(file))).toContain('tenants[0].chanels');
	});

	test('нет WEBHOOK_SECRET — ошибка с именем PLANE_DISCORD_ACME_WEBHOOK_SECRET, client secret его не заменяет', () => {
		const env = { ...BASE_ENV };
		delete env.PLANE_DISCORD_ACME_WEBHOOK_SECRET;
		const message = errorOf(() => load(EXAMPLE, env));
		expect(message).toContain('PLANE_DISCORD_ACME_WEBHOOK_SECRET');
		expect(message).not.toContain('PLANE_DISCORD_ACME_PLANE_SECRET');
	});

	test('webhookSecret — значение WEBHOOK_SECRET, auth.clientSecret — значение PLANE_SECRET', () => {
		const [tenant] = load(EXAMPLE).tenants;
		expect(tenant?.webhookSecret).toBe('webhook-secret-value');
		expect(tenant?.auth.clientSecret).toBe('client-secret-value');
		expect(tenant?.auth.clientId).toBe('example-client-id');
	});

	test('plane.mode в файле — ошибка с путём tenants[0].plane.mode', () => {
		const file = example();
		(file.tenants[0]!.plane as Record<string, unknown>).mode = 'app';
		expect(errorOf(() => load(file))).toContain('tenants[0].plane.mode');
	});

	test('повтор guildId, workspaceId, channelId, users.plane, users.discord — по ошибке на каждый', () => {
		const file = example();
		const first = file.tenants[0]!;
		const channel = (first.channels as Array<Record<string, unknown>>)[0]!;
		const user = (first.users as Array<Record<string, unknown>>)[0]!;
		first.channels = [channel, { ...channel }];
		first.users = [user, { ...user }];
		file.tenants.push({ ...first, id: 'beta' });
		const env = {
			...BASE_ENV,
			PLANE_DISCORD_BETA_PLANE_SECRET: 'x',
			PLANE_DISCORD_BETA_WEBHOOK_SECRET: 'y',
		};
		const message = errorOf(() => load(file, env));
		for (const path of [
			'tenants[1].guildId',
			'tenants[1].workspaceId',
			'tenants[0].channels[1].channelId',
			'tenants[0].users[1].plane',
			'tenants[0].users[1].discord',
		])
			expect(message).toContain(`${path} is a duplicate`);
		expect(message).not.toContain('tenants[1].id is a duplicate');
	});

	test('повтор id тенанта — ошибка', () => {
		const file = example();
		file.tenants.push({
			...file.tenants[0]!,
			guildId: '666666666666666666',
			workspaceId: '00000000-0000-4000-8000-000000000009',
		});
		expect(errorOf(() => load(file))).toContain('tenants[1].id is a duplicate');
	});

	test('events: [] — ошибка; serviceChannelId: null допустим', () => {
		const file = example();
		const first = file.tenants[0]!;
		first.serviceChannelId = null;
		(first.channels as Array<Record<string, unknown>>)[0]!.events = [];
		expect(errorOf(() => load(file))).toContain('tenants[0].channels[0].events');
		(first.channels as Array<Record<string, unknown>>)[0]!.events = ['closed'];
		const [tenant] = load(file).tenants;
		expect(tenant?.serviceChannelId).toBeNull();
		expect(tenant?.channels[0]?.events).toEqual(['closed']);
	});

	test('id umbrella читает PLANE_DISCORD_UMBRELLA_PLANE_SECRET', () => {
		const file = example();
		file.tenants[0]!.id = 'umbrella';
		const env = { ...BASE_ENV };
		delete env.PLANE_DISCORD_ACME_PLANE_SECRET;
		delete env.PLANE_DISCORD_ACME_WEBHOOK_SECRET;
		env.PLANE_DISCORD_UMBRELLA_PLANE_SECRET = 'umbrella-client';
		env.PLANE_DISCORD_UMBRELLA_WEBHOOK_SECRET = 'umbrella-hook';
		const [tenant] = load(file, env).tenants;
		expect(tenant?.auth.clientSecret).toBe('umbrella-client');
		expect(tenant?.webhookSecret).toBe('umbrella-hook');
	});

	test('файл не читается или не JSON — ошибка с PLANE_DISCORD_CONFIG и путём файла, без содержимого', () => {
		const env = { ...BASE_ENV, PLANE_DISCORD_CONFIG: '/cfg/t.json' };
		const notJson = errorOf(() => load('{"secret-looking": oops', env));
		expect(notJson).toContain('PLANE_DISCORD_CONFIG');
		expect(notJson).toContain('/cfg/t.json');
		expect(notJson).not.toContain('secret-looking');
		const unreadable = errorOf(() =>
			loadConfig(env, () => {
				throw new Error('EACCES: leaked-detail');
			}),
		);
		expect(unreadable).toContain('/cfg/t.json');
		expect(unreadable).not.toContain('leaked-detail');
	});

	test('silenceHours вне 1..720, hiddenProjects не UUID, PORT вне диапазона — ошибки с путями', () => {
		const file = example();
		file.tenants[0]!.silenceHours = 721;
		file.tenants[0]!.hiddenProjects = ['nope'];
		const message = errorOf(() => load(file, { ...BASE_ENV, PORT: '70000' }));
		expect(message).toContain('tenants[0].silenceHours');
		expect(message).toContain('tenants[0].hiddenProjects[0]');
		expect(message).toContain('PORT');
	});
});
