import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadServiceConfig, matchRepo, type RepoRule } from '../src/config.ts';
import { TEST_KEY_PEM, tenantOf } from './config-fixture.ts';

const EXAMPLE = readFileSync(new URL('../tenants.example.json', import.meta.url), 'utf8');
const KEY_B64 = Buffer.from(TEST_KEY_PEM).toString('base64');
const TOKEN = `ph_${'a'.repeat(48)}`;

const ENV: Record<string, string> = {
	PLANE_HOOKS_PLANE_URL: 'https://plane.example.com/',
	PLANE_HOOKS_PUBLIC_URL: 'https://hooks.example.com',
	PLANE_HOOKS_ACME_PLANE_SECRET: 'plane-secret',
	PLANE_HOOKS_ACME_GRAFANA_TOKEN: TOKEN,
	PLANE_HOOKS_ACME_VERCEL_SECRET: 'vercel-secret',
	PLANE_HOOKS_ACME_DOKPLOY_SECRET: 'dokploy-secret',
	PLANE_HOOKS_GH_ACME_PRIVATE_KEY: KEY_B64,
	PLANE_HOOKS_GH_ACME_WEBHOOK_SECRET: 'gh-secret',
};

type Json = Record<string, any>;
function example(): Json {
	return JSON.parse(EXAMPLE);
}
/** Loads a config whose tenants file is `file` (an object, edited by `edit`) under `env`. */
function load(
	edit: (file: Json) => void = () => {},
	env: Record<string, string | undefined> = ENV,
) {
	const file = example();
	edit(file);
	return loadServiceConfig(env, () => JSON.stringify(file));
}
function message(
	edit: (file: Json) => void = () => {},
	env: Record<string, string | undefined> = ENV,
): string {
	try {
		load(edit, env);
	} catch (err) {
		return (err as Error).message;
	}
	throw new Error('expected loadServiceConfig to throw');
}
const without = (...names: string[]) =>
	Object.fromEntries(Object.entries(ENV).filter(([name]) => !names.includes(name)));

describe('loadServiceConfig', () => {
	test('пример tenants.example.json грузится целиком', () => {
		expect(loadServiceConfig(ENV, () => EXAMPLE)).toEqual({
			port: 8080,
			planeUrl: 'https://plane.example.com',
			publicUrl: 'https://hooks.example.com',
			tenants: [tenantOf()],
		});
	});

	test('все проблемы — одной ошибкой, без значений', () => {
		const text = message(
			(file) => {
				file.tenants[0].id = 'Acme';
				file.tenants[0].colour = 'red';
			},
			{
				...without('PLANE_HOOKS_PUBLIC_URL', 'PLANE_HOOKS_GH_ACME_WEBHOOK_SECRET'),
				PLANE_HOOKS_ACME_VERCEL_SECRET: ' ',
			},
		);
		for (const name of [
			'PLANE_HOOKS_PUBLIC_URL',
			'tenants[0].id',
			'tenants[0].colour',
			'PLANE_HOOKS_ACME_VERCEL_SECRET',
			'PLANE_HOOKS_GH_ACME_WEBHOOK_SECRET',
		])
			expect(text).toContain(name);
		for (const value of ['plane-secret', TOKEN, 'dokploy-secret', KEY_B64, 'red', 'Acme'])
			expect(text).not.toContain(value);
	});

	test('не задан — вход выключен', () => {
		const config = load(() => {}, without('PLANE_HOOKS_ACME_DOKPLOY_SECRET'));
		expect(config.tenants[0]?.inputs).toEqual({
			grafana: TOKEN,
			vercel: 'vercel-secret',
			dokploy: null,
		});
	});

	test('тенант только с Grafana (github [], delivery null) грузится', () => {
		const config = load(
			(file) => {
				file.tenants[0].github = [];
				delete file.tenants[0].delivery;
				delete file.tenants[0].dokploy;
				delete file.tenants[0].silenceHours;
			},
			without(
				'PLANE_HOOKS_ACME_VERCEL_SECRET',
				'PLANE_HOOKS_ACME_DOKPLOY_SECRET',
				'PLANE_HOOKS_GH_ACME_PRIVATE_KEY',
				'PLANE_HOOKS_GH_ACME_WEBHOOK_SECRET',
			),
		);
		expect(config.tenants[0]).toEqual(
			tenantOf({
				github: [],
				delivery: null,
				dokploy: [],
				silenceHours: {},
				inputs: { grafana: TOKEN, vercel: null, dokploy: null },
			}),
		);
	});

	test('Grafana-токен — ph_ и 48 hex', () => {
		const text = message(() => {}, { ...ENV, PLANE_HOOKS_ACME_GRAFANA_TOKEN: 'ph_123' });
		expect(text).toContain('PLANE_HOOKS_ACME_GRAFANA_TOKEN');
		expect(text).not.toContain('ph_123');
	});

	test('вход инцидентов без проекта инцидентов — ошибка', () => {
		expect(message((file) => delete file.tenants[0].incidents)).toContain(
			'tenants[0].incidents.project is required for grafana',
		);
	});

	test('ключ GitHub App — base64 PEM', () => {
		const text = message(() => {}, { ...ENV, PLANE_HOOKS_GH_ACME_PRIVATE_KEY: 'bm90LWEta2V5' });
		expect(text).toContain('PLANE_HOOKS_GH_ACME_PRIVATE_KEY');
		expect(text).not.toContain('bm90LWEta2V5');
	});

	test('ключ GitHub App — именно RSA', () => {
		const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
			type: 'pkcs8',
			format: 'pem',
		});
		expect(
			message(() => {}, {
				...ENV,
				PLANE_HOOKS_GH_ACME_PRIVATE_KEY: Buffer.from(ec).toString('base64'),
			}),
		).toContain('PLANE_HOOKS_GH_ACME_PRIVATE_KEY');
	});

	test('имена и id App уникальны во всех тенантах', () => {
		const text = message((file) => {
			const second = structuredClone(file.tenants[0]);
			second.id = 'beta';
			file.tenants.push(second);
		});
		expect(text).toContain('tenants[1].github[0].name is a duplicate');
		expect(text).toContain('tenants[1].github[0].appId is a duplicate');
	});

	test('repo — owner/name или owner/*', () => {
		const text = message((file) => {
			file.tenants[0].delivery.repos[0].repo = 'acme';
			file.tenants[0].delivery.repos[1].repo = 'acme/**';
		});
		expect(text).toContain('tenants[0].delivery.repos[0].repo');
		expect(text).toContain('tenants[0].delivery.repos[1].repo');
	});

	test('окружения репозитория не повторяются', () => {
		expect(
			message((file) => {
				file.tenants[0].delivery.repos[0].environments[1].name = 'staging';
			}),
		).toContain('tenants[0].delivery.repos[0].environments[1].name is a duplicate');
	});

	test('ключи projects — идентификаторы проектов', () => {
		expect(
			message((file) => {
				file.tenants[0].delivery.projects = { qa: { Done: 'X' } };
			}),
		).toContain('tenants[0].delivery.projects.qa');
	});

	test('projects: null — состояние в проекте не ставится', () => {
		const config = load((file) => {
			file.tenants[0].delivery.projects = { QA: { Done: null } };
		});
		expect(config.tenants[0]?.delivery?.projects).toEqual({ QA: { Done: null } });
	});

	test('заданный пустым вход — ошибка старта, называет переменную', () => {
		expect(message(() => {}, { ...ENV, PLANE_HOOKS_ACME_DOKPLOY_SECRET: '' })).toContain(
			'PLANE_HOOKS_ACME_DOKPLOY_SECRET is set but empty',
		);
	});

	test('сбой чтения файла — без причины', () => {
		expect(() =>
			loadServiceConfig(ENV, () => {
				throw new Error('ENOENT secret-path-detail');
			}),
		).toThrow('PLANE_HOOKS_CONFIG: cannot read /config/tenants.json as JSON');
	});

	test('silenceHours — только известные входы, 1..720', () => {
		const text = message((file) => {
			file.tenants[0].silenceHours = { vercel: 0, github: 5 };
		});
		expect(text).toContain('tenants[0].silenceHours.vercel');
		expect(text).toContain('tenants[0].silenceHours.github is not a known key');
	});

	const shapeCases: Array<[string, (file: Json) => void, string]> = [
		[
			'dokploy.repo — не owner/name',
			(f) => (f.tenants[0].dokploy.apps[0].repo = 'acme/*'),
			'dokploy.apps[0].repo must be',
		],
		['тенант — не объект', (f) => (f.tenants[0] = 5), 'tenants[0] must be an object'],
		[
			'plane: лишний ключ',
			(f) => (f.tenants[0].plane.x = 1),
			'tenants[0].plane.x is not a known key',
		],
		['plane — не объект', (f) => (f.tenants[0].plane = 1), 'tenants[0].plane must be an object'],
		['workspace пуст', (f) => (f.tenants[0].workspace = ' '), 'tenants[0].workspace must be'],
		['github — не массив', (f) => (f.tenants[0].github = {}), 'tenants[0].github must be an array'],
		['github: лишний ключ', (f) => (f.tenants[0].github[0].x = 1), 'tenants[0].github[0].x is not'],
		['appId — не число', (f) => (f.tenants[0].github[0].appId = '1'), 'github[0].appId must be'],
		['appId — 0', (f) => (f.tenants[0].github[0].appId = 0), 'github[0].appId must be'],
		['appId — дробь', (f) => (f.tenants[0].github[0].appId = 1.5), 'github[0].appId must be'],
		['incidents: лишний ключ', (f) => (f.tenants[0].incidents.x = 1), 'incidents.x is not a known'],
		[
			'incidents.project — не идентификатор',
			(f) => (f.tenants[0].incidents.project = 'inc'),
			'incidents.project must be',
		],
		['dokploy: лишний ключ', (f) => (f.tenants[0].dokploy.x = 1), 'dokploy.x is not a known'],
		[
			'dokploy.apps[0]: лишний ключ',
			(f) => (f.tenants[0].dokploy.apps[0].x = 1),
			'dokploy.apps[0].x is not',
		],
		[
			'dokploy.apps — не массив',
			(f) => (f.tenants[0].dokploy.apps = 1),
			'dokploy.apps must be an array',
		],
		[
			'dokploy: повтор имени',
			(f) => f.tenants[0].dokploy.apps.push({ ...f.tenants[0].dokploy.apps[0] }),
			'dokploy.apps[1].name is a duplicate',
		],
		[
			'silenceHours — дробь',
			(f) => (f.tenants[0].silenceHours.vercel = 1.5),
			'silenceHours.vercel must be',
		],
		[
			'silenceHours — строка',
			(f) => (f.tenants[0].silenceHours.vercel = '5'),
			'silenceHours.vercel must be',
		],
		['delivery: лишний ключ', (f) => (f.tenants[0].delivery.x = 1), 'delivery.x is not a known'],
		[
			'states: лишний ключ',
			(f) => (f.tenants[0].delivery.states.x = 1),
			'delivery.states.x is not',
		],
		['hold — число', (f) => (f.tenants[0].delivery.hold = [5]), 'delivery.hold[0] must be'],
		[
			'hold — пустая строка',
			(f) => (f.tenants[0].delivery.hold = [' ']),
			'delivery.hold[0] must be',
		],
		['repos[0]: лишний ключ', (f) => (f.tenants[0].delivery.repos[0].x = 1), 'repos[0].x is not'],
		[
			'environments[0]: лишний ключ',
			(f) => (f.tenants[0].delivery.repos[0].environments[0].x = 1),
			'environments[0].x is not',
		],
		[
			'release — не boolean',
			(f) => (f.tenants[0].delivery.repos[0].environments[0].release = 'yes'),
			'environments[0].release must be a boolean',
		],
		[
			'projects: значение — число',
			(f) => (f.tenants[0].delivery.projects = { QA: { Done: 5 } }),
			'projects.QA.Done must be',
		],
		[
			'projects: значение — пустая строка',
			(f) => (f.tenants[0].delivery.projects = { QA: { Done: ' ' } }),
			'projects.QA.Done must be',
		],
		[
			'повтор id тенанта',
			(f) => f.tenants.push({ ...f.tenants[0] }),
			'tenants[1].id is a duplicate',
		],
		['корень с лишним ключом', (f) => (f.extra = 1), 'tenants file must be an object'],
		['корень без tenants', (f) => delete f.tenants, 'tenants file must be an object'],
	];
	for (const [name, edit, expected] of shapeCases)
		test(`форма: ${name}`, () => {
			expect(message(edit)).toContain(expected);
		});

	test('без Grafana проект инцидентов не нужен', () => {
		const config = load(
			(file) => delete file.tenants[0].incidents,
			without('PLANE_HOOKS_ACME_GRAFANA_TOKEN'),
		);
		expect(config.tenants[0]?.incidents).toBeNull();
	});

	test('нет секрета Plane — называет переменную', () => {
		expect(message(() => {}, without('PLANE_HOOKS_ACME_PLANE_SECRET'))).toContain(
			'missing env PLANE_HOOKS_ACME_PLANE_SECRET',
		);
	});

	test('нет ключа GitHub App — называет переменную', () => {
		expect(message(() => {}, without('PLANE_HOOKS_GH_ACME_PRIVATE_KEY'))).toContain(
			'missing env PLANE_HOOKS_GH_ACME_PRIVATE_KEY',
		);
	});

	test('PORT = 0 и дробный — ошибка; PLANE_HOOKS_CONFIG читает другой путь', () => {
		expect(message(() => {}, { ...ENV, PORT: '0' })).toContain('PORT must be');
		expect(message(() => {}, { ...ENV, PORT: '80.5' })).toContain('PORT must be');
		let asked = '';
		loadServiceConfig({ ...ENV, PLANE_HOOKS_CONFIG: '/etc/t.json' }, (path) => {
			asked = path;
			return EXAMPLE;
		});
		expect(asked).toBe('/etc/t.json');
	});

	test('PORT и URL', () => {
		const text = message(() => {}, {
			...ENV,
			PORT: '70000',
			PLANE_HOOKS_PLANE_URL: 'plane.example.com',
		});
		expect(text).toContain('PORT must be an integer 1..65535');
		expect(text).toContain('PLANE_HOOKS_PLANE_URL must start with http(s)://');
	});
});

describe('matchRepo', () => {
	const rules: RepoRule[] = [
		{ repo: 'acme/*', environments: [] },
		{ repo: 'acme/api', environments: [{ name: 'production', state: 'Done', release: true }] },
	];
	test('первое совпадение по порядку побеждает, точное раньше маски если стоит раньше', () => {
		expect(matchRepo(rules, 'acme/api')).toBe(rules[0] as RepoRule);
		expect(matchRepo([...rules].reverse(), 'acme/api')).toBe(rules[1] as RepoRule);
	});
	test('регистр не важен', () => {
		expect(matchRepo(rules, 'ACME/Api')).toBe(rules[0] as RepoRule);
		expect(matchRepo([rules[1] as RepoRule], 'Acme/API')).toBe(rules[1] as RepoRule);
	});
	test('чужой владелец — null', () => {
		expect(matchRepo(rules, 'other/api')).toBeNull();
		expect(matchRepo(rules, 'acme-evil/api')).toBeNull();
		expect(matchRepo([{ repo: 'acme', environments: [] }], 'acme/api')).toBeNull();
		expect(matchRepo([{ repo: 'acme/x', environments: [] }], 'acme/api')).toBeNull();
	});
});
