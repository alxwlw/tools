import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	DEFAULT_SCOPES,
	familyOf,
	formatVerifyRow,
	main,
	requestToken,
	verifyDir,
} from '../scripts/probe-plane-app.ts';

const creds = { clientId: 'cid', clientSecret: 'csecret', installationId: 'inst-1' };

function fakeFetch(replies: { status: number; body: unknown }[]) {
	const seen: { url: string; form: URLSearchParams; auth: string }[] = [];
	const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
		const reply = replies[seen.length];
		seen.push({
			url,
			form: new URLSearchParams(String(init?.body)),
			auth: String((init?.headers as Record<string, string>).Authorization),
		});
		if (reply === undefined) throw new Error('unexpected request');
		return new Response(JSON.stringify(reply.body), { status: reply.status });
	};
	return { fetchFn, seen };
}

test('token: без scope сработало — второй запрос не нужен', async () => {
	const { fetchFn, seen } = fakeFetch([
		{ status: 200, body: { access_token: 'abcdef123456', expires_in: 86400 } },
	]);
	const r = await requestToken(fetchFn, 'https://plane.example.com', creds, ['a:read']);
	expect(r.variant).toBe('без scope');
	expect(r.token).toBe('abcdef123456');
	expect(r.expiresIn).toBe(86400);
	expect(r.attempts).toEqual([{ variant: 'без scope', status: 200 }]);
	expect(seen).toHaveLength(1);
	expect(seen[0]?.url).toBe('https://plane.example.com/auth/o/token/');
	expect(seen[0]?.auth).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
	expect(seen[0]?.form.get('grant_type')).toBe('client_credentials');
	expect(seen[0]?.form.get('app_installation_id')).toBe('inst-1');
	expect(seen[0]?.form.has('scope')).toBe(false);
});

test('token: отказ без scope → повтор со scope списком через пробел, error из тела записан', async () => {
	const { fetchFn, seen } = fakeFetch([
		{ status: 400, body: { error: 'invalid_scope', access_token: 'must-not-leak' } },
		{ status: 200, body: { access_token: 'zzzzzz999999', expires_in: 3600 } },
	]);
	const r = await requestToken(fetchFn, 'https://plane.example.com', creds, ['a:read', 'b:write']);
	expect(r.variant).toBe('со scope');
	expect(r.token).toBe('zzzzzz999999');
	expect(r.attempts).toEqual([
		{ variant: 'без scope', status: 400, error: 'invalid_scope' },
		{ variant: 'со scope', status: 200 },
	]);
	expect(seen[1]?.form.get('scope')).toBe('a:read b:write');
});

test('token: оба варианта отказаны — токена нет, в попытках только поле error', async () => {
	const { fetchFn } = fakeFetch([
		{ status: 401, body: { error: 'invalid_client', error_description: 'secret-ish text' } },
		{ status: 200, body: { expires_in: 1 } },
	]);
	const r = await requestToken(fetchFn, 'https://plane.example.com', creds, ['a:read']);
	expect(r.token).toBeUndefined();
	expect(r.variant).toBeUndefined();
	expect(r.attempts).toEqual([
		{ variant: 'без scope', status: 401, error: 'invalid_client' },
		{ variant: 'со scope', status: 200, error: 'нет access_token' },
	]);
});

test('familyOf: v1, v2, agent_run и всё прочее', () => {
	expect(familyOf('{"event":"issue","action":"created","data":{}}')).toBe('v1');
	expect(familyOf('{"version":"v2","event":"issue","action":"created"}')).toBe('v2');
	expect(familyOf('{"type":"agent_run_activity","action":"prompted"}')).toBe('agent_run');
	expect(familyOf('{"action":"created","agent_run":{}}')).toBe('agent_run');
	expect(familyOf('{"hello":1}')).toBe('unknown');
	expect(familyOf('not json')).toBe('unknown');
	expect(familyOf('[1]')).toBe('unknown');
});

const sign = (secret: string, body: string): string =>
	createHmac('sha256', secret).update(body).digest('hex');

function capture(dir: string, name: string, body: string, headers: Record<string, string>) {
	writeFileSync(join(dir, `${name}.bin`), body);
	writeFileSync(
		join(dir, `${name}.json`),
		JSON.stringify({ method: 'POST', path: '/plane/webhook', headers }),
	);
}

function syntheticDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'verify-'));
	const v1 = '{"event":"issue","action":"created"}';
	const v2 = '{"version":"v2","event":"issue"}';
	capture(dir, '10-aaaaaaaa', v1, {
		'x-plane-event': 'issue',
		'x-plane-signature': sign('webhook-secret', v1),
	});
	capture(dir, '2-bbbbbbbb', v2, {
		'x-plane-event': 'workitem.created',
		'x-plane-signature': `sha256=${sign('v2-secret', v2)}`,
	});
	capture(dir, '3-cccccccc', v1, {
		'x-plane-event': 'issue',
		'x-plane-signature': sign('other', v1),
	});
	capture(dir, '4-dddddddd', '', {});
	writeFileSync(join(dir, '5-eeeeeeee.json'), '{}'); // no .bin: not a pair
	return dir;
}

test('verifyDir: пары по порядку номеров, семейство и секрет, которым сошлось', () => {
	const rows = verifyDir(syntheticDir(), [
		{ name: 'PROBE_CLIENT_SECRET', value: 'client' },
		{ name: 'PROBE_WEBHOOK_SECRET', value: 'webhook-secret' },
		{ name: 'PROBE_V2_SECRET', value: 'v2-secret' },
	]);
	expect(rows.map((r) => [r.name, r.family, r.event, r.signature, r.matched])).toEqual([
		['2-bbbbbbbb', 'v2', 'workitem.created', 'present', ['PROBE_V2_SECRET']],
		['3-cccccccc', 'v1', 'issue', 'present', []],
		['4-dddddddd', 'unknown', '-', 'absent', []],
		['10-aaaaaaaa', 'v1', 'issue', 'present', ['PROBE_WEBHOOK_SECRET']],
	]);
});

test('formatVerifyRow: три исхода подписи', () => {
	const base = {
		name: '1-aaaaaaaa',
		method: 'POST',
		path: '/p',
		event: 'issue',
		family: 'v1' as const,
	};
	expect(formatVerifyRow({ ...base, signature: 'present', matched: ['A', 'B'] })).toBe(
		'✓ 1-aaaaaaaa POST /p event=issue family=v1 — подпись сошлась: A, B',
	);
	expect(formatVerifyRow({ ...base, signature: 'present', matched: [] })).toContain(
		'подпись не сошлась ни с одним секретом',
	);
	expect(formatVerifyRow({ ...base, signature: 'absent', matched: [] })).toContain('подписи нет');
});

let logs: string[];
let errors: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
	logs = [];
	errors = [];
	logSpy = spyOn(console, 'log').mockImplementation(
		(...a: unknown[]) => void logs.push(a.join(' ')),
	);
	errSpy = spyOn(console, 'error').mockImplementation(
		(...a: unknown[]) => void errors.push(a.join(' ')),
	);
});
afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
});

test('--verify: любое число env-имён, печатает имя секрета и ни одного значения', async () => {
	const dir = syntheticDir();
	const code = await main(
		[
			'--verify',
			dir,
			'PROBE_CLIENT_SECRET',
			'PROBE_WEBHOOK_SECRET',
			'PROBE_V2_SECRET',
			'PROBE_UNSET',
		],
		{
			PROBE_CLIENT_SECRET: 'client',
			PROBE_WEBHOOK_SECRET: 'webhook-secret',
			PROBE_V2_SECRET: 'v2-secret',
		},
	);
	const out = logs.join('\n');
	expect(code).toBe(0);
	expect(out).toContain('env не задан: PROBE_UNSET');
	expect(out).toContain(
		'✓ 10-aaaaaaaa POST /plane/webhook event=issue family=v1 — подпись сошлась: PROBE_WEBHOOK_SECRET',
	);
	expect(out).toContain(
		'✓ 2-bbbbbbbb POST /plane/webhook event=workitem.created family=v2 — подпись сошлась: PROBE_V2_SECRET',
	);
	expect(out).toContain('пар: 4, подпись сошлась: 2');
	for (const secret of ['webhook-secret', 'v2-secret', 'client']) {
		expect(out.replaceAll('PROBE_CLIENT_SECRET', '')).not.toContain(secret);
	}
});

test('--verify: ни один env не задан или пустой каталог — код 2 и 1', async () => {
	expect(await main(['--verify', syntheticDir(), 'PROBE_X'], {})).toBe(2);
	expect(await main(['--verify', syntheticDir()], { PROBE_X: 'x' })).toBe(2);
	expect(
		await main(['--verify', mkdtempSync(join(tmpdir(), 'empty-')), 'PROBE_X'], { PROBE_X: 'x' }),
	).toBe(1);
});

test('без env — код 2 и список недостающих; --help — код 0 и usage', async () => {
	expect(await main([], {})).toBe(2);
	expect(errors.join('\n')).toContain('missing env: PROBE_PLANE_URL, PROBE_WORKSPACE');
	expect(await main([], { PROBE_PLANE_URL: 'u', PROBE_WORKSPACE: 'w', PROBE_CLIENT_ID: 'c' })).toBe(
		2,
	);
	expect(errors.join('\n')).toContain('PROBE_CLIENT_SECRET, PROBE_INSTALLATION_ID');
	expect(await main(['--help'], {})).toBe(0);
	expect(logs.join('\n')).toContain('--verify <captureDir>');
	expect(logs.join('\n')).toContain('PROBE_SCOPES');
});

test('PROBE_SCOPES уходит в запрос token, по умолчанию — список плана', async () => {
	const seen: string[] = [];
	const fetchFn = async (_url: string, init?: RequestInit): Promise<Response> => {
		seen.push(String((init?.body as URLSearchParams).get('scope')));
		return new Response('{"error":"invalid_scope"}', { status: 400 });
	};
	const env = {
		PROBE_PLANE_URL: 'https://plane.example.com',
		PROBE_WORKSPACE: 'example-ws',
		PROBE_CLIENT_ID: 'c',
		PROBE_CLIENT_SECRET: 's',
		PROBE_INSTALLATION_ID: 'i',
	};
	expect(await main([], { ...env, PROBE_SCOPES: 'x:read y:write' }, fetchFn)).toBe(1);
	expect(await main([], env, fetchFn)).toBe(1);
	expect(seen).toEqual(['null', 'x:read y:write', 'null', DEFAULT_SCOPES.join(' ')]);
});

test('DEFAULT_SCOPES — тринадцать скоупов плана', () => {
	expect(DEFAULT_SCOPES).toEqual([
		'projects:read',
		'projects.work_items:read',
		'projects.work_items:write',
		'projects.work_items.comments:read',
		'projects.work_items.comments:write',
		'projects.states:read',
		'projects.members:read',
		'projects.modules:read',
		'workspaces.members:read',
		'agents.runs:read',
		'agents.runs:write',
		'agents.run_activities:read',
		'agents.run_activities:write',
	]);
});

type Seen = { method: string; path: string; auth: string; apiKey: string; body: string };

/** A Plane in memory: enough routes for every probe row. `over` replaces a route's reply. */
function stubPlane(over: Record<string, () => Response> = {}) {
	const seen: Seen[] = [];
	const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
		new Response(JSON.stringify(b), { status, headers });
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const p = new URL(req.url).pathname;
			const m = req.method;
			const body = await req.text();
			seen.push({
				method: m,
				path: p,
				auth: req.headers.get('authorization') ?? '',
				apiKey: req.headers.get('x-api-key') ?? '',
				body,
			});
			const key = `${m} ${p.replace(/^\/api\/v1\/workspaces\/example-ws/, '')}`;
			const custom = over[key];
			if (custom) return custom();
			if (p === '/auth/o/token/') {
				return body.includes('scope=')
					? json({ access_token: 'tok123456789', expires_in: 86400 })
					: json({ error: 'invalid_scope' }, 400);
			}
			if (p === '/auth/o/app-installation/') {
				return json([
					{
						workspace: 'ws-uuid',
						workspace_detail: { slug: 'example-ws' },
						app_bot: 'bot-1',
						status: 'installed',
						webhook: { url: 'u', secret_key: 'LEAK-WEBHOOK' },
					},
				]);
			}
			if (key === 'POST /projects/p1/work-items/') return json({ id: 'item-1' }, 201);
			if (key === 'POST /projects/p1/work-items/item-1/comments/') return json({ id: 'c1' }, 201);
			if (key === 'GET /projects/p1/work-items/item-1/comments/c1/') {
				return json({ id: 'c1', created_by: 'bot-1', comment_html: '<p>SECRET-COMMENT</p>' });
			}
			if (key === 'GET /projects/p1/members/') {
				return json([{ member: { id: 'bot-1', display_name: 'Probe Bot' } }]);
			}
			if (key === 'GET /projects/p1/') return json({ identifier: 'DX' });
			if (key === 'GET /projects/p1/work-items/item-1/') {
				return json({ sequence_id: 7, module_ids: ['mod-1'], modules: [{ id: 'mod-1' }] });
			}
			if (key === 'GET /projects/p1/modules/') return json({ results: [{ id: 'mod-1' }] });
			if (key === 'GET /projects/p1/modules/mod-1/module-issues/') {
				return json({ results: [{ id: 'item-1' }] });
			}
			if (key.startsWith('POST /projects/p1/modules/mod-1/module-issues/')) return json({});
			if (key === 'GET /webhooks/') {
				return json([{ id: 'h1', is_active: true, secret_key: 'LEAK-WEBHOOK' }]);
			}
			if (key === 'GET /projects/')
				return json({ results: [] }, 200, { 'x-ratelimit-limit': '60' });
			if (m === 'DELETE') return new Response(null, { status: 204 });
			if (key === 'POST /runs/run-1/activities/') return json({}, 201);
			return json({}, 404);
		},
	});
	return { seen, server, url: `http://localhost:${server.port}` };
}

const appEnv = (url: string) => ({
	PROBE_PLANE_URL: `${url}/`,
	PROBE_WORKSPACE: 'example-ws',
	PROBE_PROJECT_ID: 'p1',
	PROBE_CLIENT_ID: 'cid',
	PROBE_CLIENT_SECRET: 'csecret',
	PROBE_INSTALLATION_ID: 'inst-1',
});

test('строки пробы: все ✓, что бот пишет и читает, ни одного секрета и текста в stdout', async () => {
	const stub = stubPlane();
	try {
		expect(await main([], appEnv(stub.url))).toBe(0);
	} finally {
		stub.server.stop(true);
	}
	const out = logs.join('\n');
	expect(out).toContain('token без scope: 400 error=invalid_scope');
	expect(out).toContain('✓ token — сработал вариант «со scope», префикс tok123…, expires_in=86400');
	expect(out).toContain(
		'✓ installation — 200, workspace=ws-uuid, slug=example-ws, app_bot=bot-1, status=installed, webhook=object {secret_key,url}',
	);
	expect(out).toContain(
		'✓ bot-write — задача 201, комментарий 201, чтение 200, actor=нет поля, created_by=app_bot; GET /members/ 200 массив (1), ключи строки: member, бот в списке: да, display_name=Probe Bot',
	);
	expect(out).toContain(
		`✓ browse-url — открыть и подтвердить: ${stub.url}/example-ws/browse/DX-7/`,
	);
	expect(out).toContain(
		'✓ modules — добавление в модуль 200; GET /modules/ 200; деталь: module_ids=массив(1); ?expand=modules 200: modules=массив(1), module_ids=массив(1); GET /modules/{m}/module-issues/ 200, задача в списке: да',
	);
	expect(out).toContain(
		'✓ webhook-status — 200, массив (1), ключи: id,is_active,secret_key, is_active: true',
	);
	expect(out).toMatch(
		/✓ rate — 70 запросов за \d+ мс, 429: 0, последний ответ 200, x-ratelimit-limit=60/,
	);
	expect(out).toContain('✓ cleanup — DELETE → 204');
	expect(out).toContain('контракт подтверждён');
	for (const leak of ['LEAK-WEBHOOK', 'SECRET-COMMENT', 'tok123456789', 'csecret']) {
		expect(out).not.toContain(leak);
	}
	const create = stub.seen.find((r) => r.method === 'POST' && r.path.endsWith('/p1/work-items/'));
	expect(JSON.parse(create?.body ?? '{}')).toMatchObject({
		priority: 'none',
		external_source: 'plane-discord-probe',
	});
	expect(create?.auth).toBe('Bearer tok123456789');
	expect(
		stub.seen.filter((r) => r.path.endsWith('/example-ws/projects/') && r.method === 'GET'),
	).toHaveLength(70);
	expect(stub.seen.at(-1)).toMatchObject({ method: 'DELETE' });
	expect(
		stub.seen.some((r) => r.path.includes('/module-issues/item-1/') && r.method === 'DELETE'),
	).toBe(true);
});

test('--keep: задача остаётся, id в строке cleanup, DELETE работы не было', async () => {
	const stub = stubPlane();
	try {
		expect(await main(['--keep'], appEnv(stub.url))).toBe(0);
	} finally {
		stub.server.stop(true);
	}
	expect(logs.join('\n')).toContain('✓ cleanup — --keep: задача пробы оставлена, id=item-1');
	expect(
		stub.seen.some((r) => r.method === 'DELETE' && r.path.endsWith('/work-items/item-1/')),
	).toBe(false);
});

test('запись бота: 403 → ✗ без подсказки, код 1, 70 запросов rate всё равно идут', async () => {
	const stub = stubPlane({
		'POST /projects/p1/work-items/': () => new Response('{}', { status: 403 }),
		'GET /projects/': () => new Response('{}', { status: 429, headers: { 'retry-after': '9' } }),
	});
	try {
		expect(await main([], appEnv(stub.url))).toBe(1);
	} finally {
		stub.server.stop(true);
	}
	const out = logs.join('\n');
	expect(out).toContain('✗ bot-write — POST /work-items/ → 403');
	expect(out).not.toContain('не участник');
	expect(out).toContain('rate 429 на запросе 1: Retry-After=9');
	expect(out).toMatch(/✓ rate — 70 запросов за \d+ мс, 429: 70 \(первый на 1\)/);
	expect(out).toContain('✓ cleanup — нечего удалять');
	expect(out).toContain('расхождений: 3');
});

test('сеть упала в одной строке: ✗ с именем ошибки, следующие строки идут', async () => {
	const stub = stubPlane();
	const flaky = (url: string, init?: RequestInit): Promise<Response> =>
		url.includes('/webhooks/') ? Promise.reject(new TypeError('boom')) : fetch(url, init);
	try {
		expect(await main([], appEnv(stub.url), flaky)).toBe(1);
	} finally {
		stub.server.stop(true);
	}
	const out = logs.join('\n');
	expect(out).toContain('✗ webhook-status — TypeError: boom');
	expect(out).toContain('✓ rate');
});

test('нет PROBE_PROJECT_ID: ✗ env, код 1', async () => {
	const stub = stubPlane();
	try {
		expect(await main([], { ...appEnv(stub.url), PROBE_PROJECT_ID: '' })).toBe(1);
	} finally {
		stub.server.stop(true);
	}
	expect(logs.join('\n')).toContain('✗ env — PROBE_PROJECT_ID не задан');
});

test('token отказан в обоих вариантах: код 1, дальше не идём', async () => {
	const stub = stubPlane({
		'POST /auth/o/token/': () => new Response('{"error":"invalid_client"}', { status: 401 }),
	});
	try {
		expect(await main([], appEnv(stub.url))).toBe(1);
	} finally {
		stub.server.stop(true);
	}
	const out = logs.join('\n');
	expect(out).toContain('✗ token — ни один вариант не выдал токен');
	expect(out).toContain('token со scope: 401 error=invalid_client');
	expect(out).toContain('нет авторизации');
	expect(stub.seen.every((r) => r.path === '/auth/o/token/')).toBe(true);
});

test('run-reply: POST activities с type response', async () => {
	const stub = stubPlane();
	try {
		expect(await main(['run-reply', 'run-1'], appEnv(stub.url))).toBe(0);
	} finally {
		stub.server.stop(true);
	}
	expect(logs.join('\n')).toContain('✓ run-reply — 201');
	const post = stub.seen.find((r) => r.path.endsWith('/runs/run-1/activities/'));
	expect(JSON.parse(post?.body ?? '{}')).toMatchObject({
		type: 'response',
		content: { type: 'response' },
	});
	expect(await main(['run-reply'], appEnv(stub.url))).toBe(2);
});

test('comment-get: сырой JSON в файл, в stdout только размер и путь', async () => {
	const stub = stubPlane();
	const out = join(mkdtempSync(join(tmpdir(), 'cg-')), 'c.json');
	try {
		expect(await main(['comment-get', 'p1', 'item-1', 'c1', out], appEnv(stub.url))).toBe(0);
		expect(readFileSync(out, 'utf8')).toContain('SECRET-COMMENT');
		expect(statSync(out).mode & 0o777).toBe(0o600);
		const missing = join(mkdtempSync(join(tmpdir(), 'cg-')), 'none.json');
		expect(await main(['comment-get', 'p1', 'item-1', 'nope', missing], appEnv(stub.url))).toBe(1);
		expect(existsSync(missing)).toBe(false);
	} finally {
		stub.server.stop(true);
	}
	const printed = logs.join('\n');
	expect(printed).toContain(`✓ comment-get — 200, ${readFileSync(out).length} байт → ${out}`);
	expect(printed).toContain('✗ comment-get — 404');
	expect(printed).not.toContain('SECRET-COMMENT');
});
