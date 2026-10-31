// Adapted from apps/plane-miro/test/config.test.ts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { loadConfig, PLANE_SCOPES } from '../src/config.ts';

const EXAMPLE = readFileSync(new URL('../tenants.example.json', import.meta.url), 'utf8');

type TenantJson = Record<string, unknown>;
const example = () => JSON.parse(EXAMPLE) as { tenants: TenantJson[] };
const baseEnv = (): Record<string, string | undefined> => ({
	PLANE_GRAPH_PLANE_URL: 'https://plane.example.com',
	PLANE_GRAPH_PUBLIC_URL: 'https://g.example.com',
	PLANE_GRAPH_EX_PLANE_SECRET: 'ex-plane-secret',
	PLANE_GRAPH_EX_WEBHOOK_SECRET: 'ex-webhook-secret',
	PLANE_GRAPH_EX_READ_KEY: 'ex-read-key',
	PLANE_GRAPH_EX_AGENT_KEY: 'ex-agent-key',
});
const load = (file: unknown, env = baseEnv()) =>
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
	test('читает тенанта и умолчания', () => {
		const paths: string[] = [];
		const config = loadConfig(baseEnv(), (p) => {
			paths.push(p);
			return EXAMPLE;
		});
		expect(paths).toEqual(['/config/tenants.json']);
		expect(config.tenants.get('ex')).toEqual({
			id: 'ex',
			workspaceSlug: 'example-ws',
			workspaceId: '00000000-0000-4000-8000-000000000001',
			clientId: 'example-client-id',
			installationId: '00000000-0000-4000-8000-000000000002',
			planeSecret: 'ex-plane-secret',
			webhookSecret: 'ex-webhook-secret',
			readKey: 'ex-read-key',
			agentKey: 'ex-agent-key',
		});
		expect(config.planeUrl).toBe('https://plane.example.com');
		expect(config.dbPath).toBe('/data/plane-graph.sqlite');
		expect(config.port).toBe(8080);
	});

	test('PLANE_GRAPH_CONFIG, PLANE_GRAPH_DB и PORT перекрывают умолчания', () => {
		const paths: string[] = [];
		const env = {
			...baseEnv(),
			PLANE_GRAPH_CONFIG: '/cfg/t.json',
			PLANE_GRAPH_DB: '/tmp/x.sqlite',
			PORT: '9090',
		};
		const config = loadConfig(env, (p) => {
			paths.push(p);
			return EXAMPLE;
		});
		expect(paths).toEqual(['/cfg/t.json']);
		expect(config.dbPath).toBe('/tmp/x.sqlite');
		expect(config.port).toBe(9090);
	});

	test('PUBLIC_URL без хвостового слеша', () => {
		const env = { ...baseEnv(), PLANE_GRAPH_PUBLIC_URL: 'https://g.example.com/' };
		expect(load(EXAMPLE, env).publicUrl).toBe('https://g.example.com');
	});

	for (const name of ['PLANE_SECRET', 'WEBHOOK_SECRET', 'READ_KEY', 'AGENT_KEY']) {
		test(`нет ${name} — ошибка с именем переменной`, () => {
			const env = baseEnv();
			delete env[`PLANE_GRAPH_EX_${name}`];
			const message = errorOf(() => load(EXAMPLE, env));
			expect(message).toContain(`PLANE_GRAPH_EX_${name}`);
			expect(message).not.toContain('secret');
		});
	}

	test('ключ чтения и ключ агента совпадают — ошибка', () => {
		const env = { ...baseEnv(), PLANE_GRAPH_EX_AGENT_KEY: 'ex-read-key' };
		const message = errorOf(() => load(EXAMPLE, env));
		expect(message).toContain('PLANE_GRAPH_EX_READ_KEY and PLANE_GRAPH_EX_AGENT_KEY must differ');
		expect(message).not.toContain('ex-read-key');
	});

	test('оба ключа не заданы — только missing, без «must differ»', () => {
		const env = baseEnv();
		delete env.PLANE_GRAPH_EX_READ_KEY;
		delete env.PLANE_GRAPH_EX_AGENT_KEY;
		const message = errorOf(() => load(EXAMPLE, env));
		expect(message).toContain('missing env PLANE_GRAPH_EX_READ_KEY');
		expect(message).toContain('missing env PLANE_GRAPH_EX_AGENT_KEY');
		expect(message).not.toContain('must differ');
	});

	test('PORT: дробный, строка и больше 65535 — ошибка', () => {
		for (const port of ['1.5', 'abc', '65536'])
			expect(errorOf(() => load(EXAMPLE, { ...baseEnv(), PORT: port }))).toContain('PORT');
		expect(load(EXAMPLE, { ...baseEnv(), PORT: '65535' }).port).toBe(65_535);
	});

	test('длина id тенанта: 16 символов проходит, 17 — ошибка', () => {
		const ok = 'a'.repeat(16);
		const env = baseEnv();
		for (const f of ['PLANE_SECRET', 'WEBHOOK_SECRET', 'READ_KEY', 'AGENT_KEY'])
			env[`PLANE_GRAPH_${ok.toUpperCase()}_${f}`] = `${f}-value`;
		env[`PLANE_GRAPH_${ok.toUpperCase()}_AGENT_KEY`] = 'other-key';
		const file = example();
		file.tenants[0]!.id = ok;
		expect(load(file, env).tenants.has(ok)).toBe(true);
		file.tenants[0]!.id = 'a'.repeat(17);
		expect(errorOf(() => load(file, env))).toContain('tenants[0].id');
	});

	test('плохой id тенанта', () => {
		const file = example();
		file.tenants[0]!.id = 'Ex-1';
		expect(errorOf(() => load(file))).toContain('tenants[0].id');
	});

	test('повтор id или workspaceId — ошибка', () => {
		const file = example();
		file.tenants.push({ ...file.tenants[0]!, workspaceId: '00000000-0000-4000-8000-000000000009' });
		expect(errorOf(() => load(file))).toContain('tenants[1].id is a duplicate');

		const other = example();
		other.tenants.push({ ...other.tenants[0]!, id: 'two' });
		const env = {
			...baseEnv(),
			PLANE_GRAPH_TWO_PLANE_SECRET: 'a',
			PLANE_GRAPH_TWO_WEBHOOK_SECRET: 'b',
			PLANE_GRAPH_TWO_READ_KEY: 'c',
			PLANE_GRAPH_TWO_AGENT_KEY: 'd',
		};
		const message = errorOf(() => load(other, env));
		expect(message).toContain('tenants[1].workspaceId is a duplicate');
		expect(message).not.toContain('tenants[1].id is a duplicate');
	});

	test('нет обязательных URL — одна ошибка с обоими именами; не http(s) и PORT — ошибки', () => {
		const env = baseEnv();
		delete env.PLANE_GRAPH_PLANE_URL;
		delete env.PLANE_GRAPH_PUBLIC_URL;
		const message = errorOf(() => load(EXAMPLE, env));
		expect(message).toContain('missing env PLANE_GRAPH_PLANE_URL, PLANE_GRAPH_PUBLIC_URL');
		expect(message).not.toContain('must start with');
		const bad = errorOf(() =>
			load(EXAMPLE, { ...baseEnv(), PLANE_GRAPH_PUBLIC_URL: 'g.example.com', PORT: '0' }),
		);
		expect(bad).toContain('PLANE_GRAPH_PUBLIC_URL must start with http(s)://');
		expect(bad).toContain('PORT must be an integer 1..65535');
	});

	test('неизвестный ключ и неверные поля — ошибки с путями, без значений', () => {
		const file = example();
		file.tenants[0]!.extra = 1;
		file.tenants[0]!.workspaceId = 'not-a-uuid';
		file.tenants[0]!.clientId = ' ';
		delete file.tenants[0]!.installationId;
		const message = errorOf(() => load(file));
		expect(message).toContain('tenants[0].extra is not a known key');
		expect(message).toContain('tenants[0].workspaceId must be a UUID');
		expect(message).toContain('tenants[0].clientId must be a non-empty string');
		expect(message).toContain('tenants[0].installationId');
		expect(message).not.toContain('not-a-uuid');
	});

	test('UUID приводится к нижнему регистру', () => {
		const file = example();
		file.tenants[0]!.workspaceId = '0000000A-0000-4000-8000-00000000000B';
		expect(load(file).tenants.get('ex')?.workspaceId).toBe('0000000a-0000-4000-8000-00000000000b');
	});

	test('корень файла не {tenants: [...]} и не-объект тенанта — ошибка', () => {
		for (const root of [[], { tenants: {} }, { tenants: [], extra: 1 }, null])
			expect(errorOf(() => load(root))).toContain('{"tenants": [...]}');
		for (const item of [5, [], null])
			expect(errorOf(() => load({ tenants: [item] }))).toContain('tenants[0] must be an object');
	});

	test('файл не читается или не JSON — ошибка с PLANE_GRAPH_CONFIG и путём, без содержимого', () => {
		const env = { ...baseEnv(), PLANE_GRAPH_CONFIG: '/cfg/t.json' };
		const notJson = errorOf(() => load('{"secret-looking": oops', env));
		expect(notJson).toContain('PLANE_GRAPH_CONFIG');
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

	test('PLANE_SCOPES — шесть read-скоупов', () => {
		expect(PLANE_SCOPES).toEqual([
			'projects:read',
			'projects.work_items:read',
			'projects.work_items.relations:read',
			'projects.states:read',
			'projects.labels:read',
			'projects.modules:read',
		]);
	});
});
