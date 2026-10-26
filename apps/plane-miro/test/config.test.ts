// Adapted from apps/plane-discord/test/config.test.ts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { KEEP_SOURCE_DEFAULT, loadConfig } from '../src/config.ts';
import { badEmbed, badTeam, env, read, sameTeam, twoTenants } from './config-fixture.ts';

const EXAMPLE = readFileSync(new URL('../tenants.example.json', import.meta.url), 'utf8');

type TenantJson = Record<string, any>;
const example = () => JSON.parse(EXAMPLE) as { tenants: TenantJson[] };
const load = (file: unknown, e: Record<string, string | undefined> = env()) =>
	loadConfig(e, read(typeof file === 'string' ? file : JSON.stringify(file)));
const errorOf = (fn: () => unknown): string => {
	try {
		fn();
	} catch (e) {
		return (e as Error).message;
	}
	throw new Error('expected loadConfig to throw');
};

describe('loadConfig', () => {
	test('два тенанта читаются, секреты из env', () => {
		const c = loadConfig(env(), read(twoTenants));
		expect(c.tenants.map((t) => t.id)).toEqual(['acme', 'beta']);
		expect(c.tenants[0]?.auth.clientSecret).toBe('acme-plane-secret');
		expect(c.tenants[0]?.webhookSecret).toBe('acme-webhook-secret');
		expect(c.tenants[0]?.miroTeamId).toBe('3458764500000000001');
		expect(c.miro).toEqual({ clientId: '3458764500000000099', clientSecret: 'miro-secret' });
		expect(c.dbPath).toBe('/data/plane-miro.sqlite');
	});

	test('нет секрета вебхука тенанта — ошибка с именем переменной, без значений', () => {
		const e = { ...env() };
		delete e.PLANE_MIRO_BETA_WEBHOOK_SECRET;
		const message = errorOf(() => loadConfig(e, read(twoTenants)));
		expect(message).toContain('PLANE_MIRO_BETA_WEBHOOK_SECRET');
		expect(message).not.toContain('beta-plane-secret');
		expect(message).not.toContain('PLANE_MIRO_BETA_PLANE_SECRET');
	});

	test('нет PLANE_SECRET — ошибка с именем, WEBHOOK_SECRET его не заменяет', () => {
		const e = { ...env() };
		delete e.PLANE_MIRO_ACME_PLANE_SECRET;
		const message = errorOf(() => loadConfig(e, read(twoTenants)));
		expect(message).toContain('PLANE_MIRO_ACME_PLANE_SECRET');
		expect(message).not.toContain('PLANE_MIRO_ACME_WEBHOOK_SECRET');
	});

	test('одна команда Miro у двух тенантов — ошибка', () => {
		expect(() => loadConfig(env(), read(sameTeam))).toThrow(
			'tenants[1].miro.teamId is a duplicate',
		);
	});

	test('teamId не из цифр — ошибка', () => {
		expect(() => loadConfig(env(), read(badTeam))).toThrow('tenants[0].miro.teamId');
	});

	test('keepSource не задан — значение по умолчанию', () => {
		expect(loadConfig(env(), read(twoTenants)).tenants[1]?.keepSource).toBe(KEEP_SOURCE_DEFAULT);
	});

	test('keepSource: false в файле перекрывает значение по умолчанию', () => {
		const file = example();
		file.tenants[0]!.keepSource = false;
		expect(load(file).tenants[0]?.keepSource).toBe(false);
		expect(KEEP_SOURCE_DEFAULT).toBe(true);
	});

	test('embed не boolean — ошибка', () => {
		expect(() => loadConfig(env(), read(badEmbed))).toThrow('tenants[0].embed');
	});

	test('нет embed — ошибка, значения по умолчанию нет', () => {
		const file = example();
		delete file.tenants[0]!.embed;
		expect(errorOf(() => load(file))).toContain('tenants[0].embed');
	});

	test('keepSource не boolean — ошибка с путём', () => {
		const file = example();
		file.tenants[0]!.keepSource = 'no';
		expect(errorOf(() => load(file))).toContain('tenants[0].keepSource');
	});

	test('tenants.example.json с полным env проходит; silenceHours 72, hiddenProjects из файла', () => {
		const config = load(EXAMPLE);
		expect(config.planeUrl).toBe('https://plane.example.com');
		expect(config.port).toBe(8080);
		expect(config.configPath).toBe('/config/tenants.json');
		expect(config.tenants.map((t) => t.id)).toEqual(['acme', 'beta']);
		expect(config.tenants[0]?.silenceHours).toBe(72);
		expect(config.tenants[0]?.embed).toBe(true);
		expect(config.tenants[1]?.embed).toBe(false);
		expect(config.tenants[1]?.hiddenProjects).toEqual(['00000000-0000-4000-8000-000000000013']);
	});

	test('без silenceHours и hiddenProjects — значения по умолчанию', () => {
		const file = example();
		delete file.tenants[0]!.silenceHours;
		delete file.tenants[0]!.hiddenProjects;
		const [tenant] = load(file).tenants;
		expect(tenant?.silenceHours).toBe(72);
		expect(tenant?.hiddenProjects).toEqual([]);
	});

	test('нет четырёх обязательных env — одна ошибка, в ней все имена', () => {
		const e = env();
		delete (e as Record<string, string | undefined>).PLANE_MIRO_PLANE_URL;
		delete (e as Record<string, string | undefined>).PLANE_MIRO_PUBLIC_URL;
		delete (e as Record<string, string | undefined>).PLANE_MIRO_MIRO_CLIENT_ID;
		delete (e as Record<string, string | undefined>).PLANE_MIRO_MIRO_CLIENT_SECRET;
		const message = errorOf(() => load(EXAMPLE, e));
		for (const name of [
			'PLANE_MIRO_PLANE_URL',
			'PLANE_MIRO_PUBLIC_URL',
			'PLANE_MIRO_MIRO_CLIENT_ID',
			'PLANE_MIRO_MIRO_CLIENT_SECRET',
		])
			expect(message).toContain(name);
	});

	test('значение секрета не попадает в текст ошибки', () => {
		const file = example();
		file.tenants[0]!.workspaceId = 'not-a-uuid';
		const message = errorOf(() =>
			load(file, { ...env(), PLANE_MIRO_ACME_PLANE_SECRET: 's3cr3t-value' }),
		);
		expect(message).toContain('tenants[0].workspaceId');
		expect(message).not.toContain('s3cr3t-value');
		expect(message).not.toContain('not-a-uuid');
	});

	test('неизвестный ключ — ошибка с путём tenants[0].miro.extra и tenants[0].chanels', () => {
		const file = example();
		file.tenants[0]!.chanels = [];
		file.tenants[0]!.miro.extra = 1;
		const message = errorOf(() => load(file));
		expect(message).toContain('tenants[0].chanels');
		expect(message).toContain('tenants[0].miro.extra');
	});

	test('plane.mode в файле — ошибка с путём tenants[0].plane.mode', () => {
		const file = example();
		file.tenants[0]!.plane.mode = 'app';
		expect(errorOf(() => load(file))).toContain('tenants[0].plane.mode');
	});

	test('повтор workspaceId и teamId — по ошибке на каждый, повтор id отдельно', () => {
		const file = example();
		file.tenants.push({ ...file.tenants[0]!, id: 'gamma' });
		const e = {
			...env(),
			PLANE_MIRO_GAMMA_PLANE_SECRET: 'x',
			PLANE_MIRO_GAMMA_WEBHOOK_SECRET: 'y',
		};
		const message = errorOf(() => load(file, e));
		expect(message).toContain('tenants[2].workspaceId is a duplicate');
		expect(message).toContain('tenants[2].miro.teamId is a duplicate');
		expect(message).not.toContain('tenants[2].id is a duplicate');
	});

	test('повтор id тенанта — ошибка', () => {
		const file = example();
		file.tenants.push({
			...file.tenants[0]!,
			workspaceId: '00000000-0000-4000-8000-000000000009',
			miro: { teamId: '3458764500000000009' },
		});
		expect(errorOf(() => load(file))).toContain('tenants[2].id is a duplicate');
	});

	test('id umbrella читает PLANE_MIRO_UMBRELLA_PLANE_SECRET', () => {
		const file = example();
		file.tenants = [file.tenants[0]!];
		file.tenants[0]!.id = 'umbrella';
		const e: Record<string, string | undefined> = { ...env() };
		e.PLANE_MIRO_UMBRELLA_PLANE_SECRET = 'umbrella-client';
		e.PLANE_MIRO_UMBRELLA_WEBHOOK_SECRET = 'umbrella-hook';
		const [tenant] = load(file, e).tenants;
		expect(tenant?.auth.clientSecret).toBe('umbrella-client');
		expect(tenant?.webhookSecret).toBe('umbrella-hook');
	});

	test('файл не читается или не JSON — ошибка с PLANE_MIRO_CONFIG и путём файла, без содержимого', () => {
		const e = { ...env(), PLANE_MIRO_CONFIG: '/cfg/t.json' };
		const notJson = errorOf(() => load('{"secret-looking": oops', e));
		expect(notJson).toContain('PLANE_MIRO_CONFIG');
		expect(notJson).toContain('/cfg/t.json');
		expect(notJson).not.toContain('secret-looking');
		const unreadable = errorOf(() =>
			loadConfig(e, () => {
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
		const message = errorOf(() => load(file, { ...env(), PORT: '70000' }));
		expect(message).toContain('tenants[0].silenceHours');
		expect(message).toContain('tenants[0].hiddenProjects[0]');
		expect(message).toContain('PORT');
	});

	test('все поля разобраны: полный объект Config', () => {
		const file = example();
		file.tenants = [file.tenants[1]!];
		const first = file.tenants[0]!;
		first.id = 'acme';
		first.keepSource = false;
		first.silenceHours = 24;
		const e = {
			...env(),
			PORT: '9090',
			PLANE_MIRO_DB: '/tmp/x.sqlite',
			PLANE_MIRO_CONFIG: '/cfg/t.json',
		};
		expect(load(file, e)).toEqual({
			port: 9090,
			planeUrl: 'https://plane.example.com',
			publicUrl: 'https://plane-miro.example.com',
			configPath: '/cfg/t.json',
			dbPath: '/tmp/x.sqlite',
			miro: { clientId: '3458764500000000099', clientSecret: 'miro-secret' },
			tenants: [
				{
					id: 'acme',
					workspace: 'example-ws-two',
					workspaceId: '00000000-0000-4000-8000-000000000011',
					auth: {
						clientId: 'example-client-id',
						clientSecret: 'acme-plane-secret',
						appInstallationId: '00000000-0000-4000-8000-000000000012',
					},
					webhookSecret: 'acme-webhook-secret',
					miroTeamId: '3458764500000000002',
					embed: false,
					keepSource: false,
					silenceHours: 24,
					hiddenProjects: ['00000000-0000-4000-8000-000000000013'],
				},
			],
		});
		expect(
			loadConfig({ ...env(), PLANE_MIRO_PUBLIC_URL: 'https://p.example.com/' }, read(EXAMPLE))
				.publicUrl,
		).toBe('https://p.example.com');
	});

	const badFile: Array<[string, (t: TenantJson) => void, string]> = [
		['workspace пуст', (t) => (t.workspace = ' '), 'tenants[0].workspace'],
		['workspace не строка', (t) => (t.workspace = 5), 'tenants[0].workspace'],
		['workspaceId не UUID', (t) => (t.workspaceId = 'x'), 'tenants[0].workspaceId'],
		['id с заглавной', (t) => (t.id = 'Acme'), 'tenants[0].id'],
		['plane не объект', (t) => (t.plane = 'x'), 'tenants[0].plane must be an object'],
		[
			'нет appInstallationId',
			(t) => delete t.plane.appInstallationId,
			'tenants[0].plane.appInstallationId',
		],
		['нет clientId', (t) => delete t.plane.clientId, 'tenants[0].plane.clientId'],
		['miro не объект', (t) => (t.miro = 'x'), 'tenants[0].miro must be an object'],
		['нет teamId', (t) => delete t.miro.teamId, 'tenants[0].miro.teamId'],
		['teamId числом', (t) => (t.miro.teamId = 12), 'tenants[0].miro.teamId'],
		['teamId из 25 цифр', (t) => (t.miro.teamId = '1'.repeat(25)), 'tenants[0].miro.teamId'],
		['silenceHours 0', (t) => (t.silenceHours = 0), 'tenants[0].silenceHours'],
		['silenceHours дробное', (t) => (t.silenceHours = 1.5), 'tenants[0].silenceHours'],
		['silenceHours строка', (t) => (t.silenceHours = '5'), 'tenants[0].silenceHours'],
		[
			'hiddenProjects не массив',
			(t) => (t.hiddenProjects = 'x'),
			'tenants[0].hiddenProjects must be an array',
		],
		['hiddenProjects с числом', (t) => (t.hiddenProjects = [5]), 'tenants[0].hiddenProjects[0]'],
		[
			// String(['<uuid>']) is the UUID itself: only the string check refuses it
			'hiddenProjects с UUID в массиве',
			(t) => (t.hiddenProjects = [['00000000-0000-4000-8000-000000000013']]),
			'tenants[0].hiddenProjects[0] must be a UUID',
		],
	];
	for (const [name, mutate, path] of badFile) {
		test(`некорректный файл: ${name} — ошибка с путём`, () => {
			const file = example();
			mutate(file.tenants[0]!);
			expect(errorOf(() => load(file))).toContain(path);
		});
	}

	test('корень файла не {tenants: [...]} — ошибка', () => {
		for (const root of [[], { tenants: {} }, { tenants: [], extra: 1 }, null]) {
			expect(errorOf(() => load(root))).toContain('{"tenants": [...]}');
		}
		for (const item of [5, [], null])
			expect(errorOf(() => load({ tenants: [item] }))).toContain('tenants[0] must be an object');
	});

	test('некорректные глобальные env — ошибки с именами', () => {
		const cases: Array<[string, string]> = [
			['PLANE_MIRO_PLANE_URL', 'ftp://x'],
			['PLANE_MIRO_PUBLIC_URL', 'x.example.com'],
			['PORT', '0'],
			['PORT', '1.5'],
			['PORT', 'abc'],
		];
		for (const [name, value] of cases)
			expect(errorOf(() => load(EXAMPLE, { ...env(), [name]: value }))).toContain(name);
		for (const name of [
			'PLANE_MIRO_PUBLIC_URL',
			'PLANE_MIRO_MIRO_CLIENT_ID',
			'PLANE_MIRO_MIRO_CLIENT_SECRET',
		])
			expect(errorOf(() => load(EXAMPLE, { ...env(), [name]: '  ' }))).toContain(
				`missing env ${name}`,
			);
	});
});
