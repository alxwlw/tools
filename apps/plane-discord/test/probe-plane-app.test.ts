import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
