import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
	miroOauthCallback,
	miroOauthHandler,
	miroSetupRedirect,
	readState,
	signState,
} from '../src/miro/oauth.ts';
import type { LogEntry } from '../src/log.ts';
import { Store } from '../src/store.ts';
import { configOf } from './config-fixture.ts';

const config = configOf();
const SECRET = config.miro.clientSecret;
const TEAM = config.tenants[0]!.miroTeamId;
const NOW = 1_000_000;
const DONE = (team: string) =>
	`https://miro.com/app-install-completed/?client_id=${config.miro.clientId}&team_id=${team}`;

type Reply = { status: number; text: string } | Error;
const ok = (body: unknown): Reply => ({ status: 200, text: JSON.stringify(body) });

function setup(reply: Reply = ok({ access_token: 'at-1', team_id: TEAM, user_id: '42' })) {
	const store = new Store(':memory:');
	const logs: LogEntry[] = [];
	const fetched: { url: string; method: string; accept: string; timeoutSignal: boolean }[] = [];
	const fetchFn = async (url: string, init: RequestInit) => {
		fetched.push({
			url,
			method: String(init.method),
			accept: String((init.headers as Record<string, string>).accept),
			timeoutSignal: init.signal instanceof AbortSignal,
		});
		if (reply instanceof Error) throw reply;
		return new Response(reply.text, { status: reply.status });
	};
	const deps = { config, store, fetch: fetchFn, log: (e: LogEntry) => logs.push(e), nowMs: NOW };
	return { store, logs, fetched, deps };
}
const cb = (query: string) =>
	new URL(`https://plane-miro.example.com/miro/oauth/callback?${query}`);
const good = () => signState('acme', NOW + 60_000, SECRET);

describe('state', () => {
	test('подписанный state читается, пока не истёк', () => {
		expect(readState(signState('acme', NOW + 1, SECRET), SECRET, NOW)).toBe('acme');
		expect(readState(signState('acme', NOW, SECRET), SECRET, NOW)).toBeNull();
	});

	test('чужой секрет, подмена тенанта или срока, мусор → null', () => {
		const s = signState('acme', NOW + 60_000, SECRET);
		const [, exp, mac] = s.split('.') as [string, string, string];
		for (const bad of [
			signState('acme', NOW + 60_000, 'other'),
			`beta.${exp}.${mac}`,
			`acme.${Number(exp) + 1}.${mac}`,
			`acme.${exp}.${mac.slice(0, -1)}0`,
			`acme.${exp}.abcd`,
			`acme.12ab.${mac}`,
			`acme.${exp}.${'z'.repeat(64)}`,
			`acme.${exp}`,
			`acme.${exp}.${mac}.x`,
			'',
			'a.b.c',
		])
			expect(readState(bad, SECRET, NOW), bad).toBeNull();
	});
});

describe('state и JWT одним секретом', () => {
	test('HMAC без префикса state (как у подписи JWT) state не открывает', () => {
		const payload = `acme.${NOW + 60_000}`;
		const mac = createHmac('sha256', SECRET).update(payload).digest('hex');
		expect(readState(`${payload}.${mac}`, SECRET, NOW)).toBeNull();
	});
});

describe('miroSetupRedirect', () => {
	test('setup: 302 на authorize с state и team_id тенанта; чужой тенант → 404', () => {
		const res = miroSetupRedirect(config, new URL('https://x/miro/setup?tenant=acme'), NOW);
		expect(res.status).toBe(302);
		const to = new URL(res.headers.get('location')!);
		expect(`${to.origin}${to.pathname}`).toBe('https://miro.com/oauth/authorize');
		expect(Object.fromEntries(to.searchParams)).toEqual({
			response_type: 'code',
			client_id: config.miro.clientId,
			redirect_uri: 'https://plane-miro.example.com/miro/oauth/callback',
			state: signState('acme', NOW + 15 * 60_000, SECRET),
			team_id: TEAM,
		});
		expect(miroSetupRedirect(config, new URL('https://x/miro/setup?tenant=nope'), NOW).status).toBe(
			404,
		);
		expect(miroSetupRedirect(config, new URL('https://x/miro/setup'), NOW).status).toBe(404);
	});
});

describe('miroOauthCallback', () => {
	test('без code → 400, обмена нет', async () => {
		const { deps, fetched } = setup();
		expect((await miroOauthCallback(cb(`state=${good()}`), deps)).status).toBe(400);
		expect((await miroOauthCallback(cb('code='), deps)).status).toBe(400);
		expect(fetched.length).toBe(0);
	});

	test('отказ на согласии Miro (error без code) → 400 и строка miro.oauth_denied с кодом', async () => {
		const { deps, fetched, logs } = setup();
		const res = await miroOauthCallback(cb(`error=access_denied&state=${good()}`), deps);
		expect(res.status).toBe(400);
		expect(logs).toEqual([{ event: 'miro.oauth_denied', level: 'warn', error: 'access_denied' }]);
		await miroOauthCallback(cb('error=Bad%20%3Cvalue%3E'), deps);
		expect(logs[1]).toEqual({ event: 'miro.oauth_denied', level: 'warn', error: '' });
		expect(fetched.length).toBe(0);
	});

	test('без code и без error — 400 без строки в логе', async () => {
		const { deps, logs } = setup();
		await miroOauthCallback(cb(`state=${good()}`), deps);
		expect(logs).toEqual([]);
	});

	test('callback без state: код не обменивается, токена нет, 302 на app-install-completed', async () => {
		const { deps, fetched, store, logs } = setup();
		const res = await miroOauthCallback(cb(`code=c1&team_id=${TEAM}`), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe(DONE(TEAM));
		expect(fetched.length).toBe(0);
		expect(store.getMiroToken(TEAM)).toBeNull();
		expect(logs).toEqual([{ event: 'miro.installed', team: TEAM }]);
	});

	test('callback без state: team из query проверяется, лишнее не попадает в ссылку и лог', async () => {
		const { deps, logs } = setup();
		const res = await miroOauthCallback(cb('code=c1&team_id=1%26evil%3D1'), deps);
		expect(res.headers.get('location')).toBe(DONE(''));
		expect(logs).toEqual([{ event: 'miro.installed', team: '' }]);
	});

	test('callback с верным state: обмен, токен сохранён, в логе нет токена', async () => {
		const { deps, fetched, store, logs } = setup();
		const res = await miroOauthCallback(cb(`code=c1&state=${good()}`), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe(DONE(TEAM));
		expect(store.getMiroToken(TEAM)).toBe('at-1');
		expect(logs).toEqual([{ event: 'miro.service_connected', tenant: 'acme', user: '42' }]);
		expect(JSON.stringify(logs)).not.toContain('at-1');
		expect(fetched.length).toBe(1);
		expect(fetched[0]!.method).toBe('POST');
		expect(fetched[0]!.accept).toBe('application/json');
		expect(fetched[0]!.timeoutSignal).toBe(true);
		const sent = new URL(fetched[0]!.url);
		expect(`${sent.origin}${sent.pathname}`).toBe('https://api.miro.com/v1/oauth/token');
		expect(Object.fromEntries(sent.searchParams)).toEqual({
			grant_type: 'authorization_code',
			client_id: config.miro.clientId,
			client_secret: SECRET,
			code: 'c1',
			redirect_uri: 'https://plane-miro.example.com/miro/oauth/callback',
		});
	});

	test('callback: команда ответа не та → 400, токена нет', async () => {
		const { deps, store, logs } = setup(
			ok({ access_token: 'at-9', team_id: '3458764500000000777', user_id: '42' }),
		);
		const res = await miroOauthCallback(cb(`code=c1&state=${good()}`), deps);
		expect(res.status).toBe(400);
		expect(await res.text()).toBe('Это не та команда Miro');
		expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(store.getMiroToken(TEAM)).toBeNull();
		expect(store.getMiroToken('3458764500000000777')).toBeNull();
		expect(logs).toEqual([
			{ event: 'miro.wrong_team', level: 'error', tenant: 'acme', team: '3458764500000000777' },
		]);
		expect(JSON.stringify(logs)).not.toContain('at-9');
	});

	test('callback без state: team берётся и из параметра team', async () => {
		const { deps, logs } = setup();
		const res = await miroOauthCallback(cb(`code=c1&team=${TEAM}`), deps);
		expect(res.headers.get('location')).toBe(DONE(TEAM));
		expect(logs).toEqual([{ event: 'miro.installed', team: TEAM }]);
	});

	test('state просрочен или подделан → тот же ответ, но в логе miro.state_invalid', async () => {
		for (const state of [
			signState('acme', NOW, SECRET),
			signState('acme', NOW + 60_000, 'other'),
			'junk',
			signState('ghost', NOW + 60_000, SECRET),
		]) {
			const { deps, fetched, store, logs } = setup();
			const res = await miroOauthCallback(cb(`code=c1&team_id=${TEAM}&state=${state}`), deps);
			expect(res.status, state).toBe(302);
			expect(res.headers.get('location')).toBe(DONE(TEAM));
			expect(fetched.length).toBe(0);
			expect(store.getMiroToken(TEAM)).toBeNull();
			expect(logs).toEqual([{ event: 'miro.state_invalid', level: 'warn', team: TEAM }]);
		}
	});

	test('обмен не 2xx → 502, лог со статусом, токена нет', async () => {
		const { deps, store, logs } = setup({
			status: 400,
			text: JSON.stringify({ access_token: 'at-x', team_id: TEAM, user_id: '42' }),
		});
		const res = await miroOauthCallback(cb(`code=c1&state=${good()}`), deps);
		expect(res.status).toBe(502);
		expect(store.getMiroToken(TEAM)).toBeNull();
		expect(logs).toEqual([
			{ event: 'miro.exchange_failed', level: 'error', tenant: 'acme', status: 400 },
		]);
	});

	test('обрыв обмена → 502 со status 0, текст ошибки (в нём секрет) не в логе', async () => {
		const { deps, logs } = setup(
			new TypeError(`connect failed https://api.miro.com/?client_secret=${SECRET}&code=c1`),
		);
		expect((await miroOauthCallback(cb(`code=c1&state=${good()}`), deps)).status).toBe(502);
		expect(logs).toEqual([
			{ event: 'miro.exchange_failed', level: 'error', tenant: 'acme', status: 0 },
		]);
		expect(JSON.stringify(logs)).not.toContain(SECRET);
	});

	test('ответ обмена без токена или с неточным числовым team_id → 502', async () => {
		for (const body of [
			{ team_id: TEAM, user_id: '1' },
			{ access_token: '', team_id: TEAM, user_id: '1' },
			{ access_token: 'a', team_id: 3458764500000000001, user_id: '1' },
			{ access_token: 'a', team_id: TEAM },
			{ access_token: 'a', team_id: TEAM, user_id: -1 },
			'nope',
		]) {
			const { deps, store, logs } = setup({
				status: 200,
				text: typeof body === 'string' ? body : JSON.stringify(body),
			});
			expect((await miroOauthCallback(cb(`code=c1&state=${good()}`), deps)).status).toBe(502);
			expect(store.getMiroToken(TEAM)).toBeNull();
			expect(logs[0]).toMatchObject({ event: 'miro.exchange_failed', status: 200 });
		}
	});
});

describe('miroOauthHandler', () => {
	const run = (method: string, path: string, now = () => NOW) => {
		const s = setup();
		const handler = miroOauthHandler({ ...s.deps, now });
		const url = new URL(`https://plane-miro.example.com${path}`);
		return { ...s, res: handler(new Request(url.toString(), { method }), url) };
	};

	test('GET /miro/setup и /miro/oauth/callback идут в свои функции, время — из now', async () => {
		const setupRes = await run('GET', '/miro/setup?tenant=acme').res;
		expect(new URL(setupRes.headers.get('location')!).searchParams.get('state')).toBe(
			signState('acme', NOW + 15 * 60_000, SECRET),
		);
		const r = run('GET', `/miro/oauth/callback?code=c1&state=${good()}`);
		expect((await r.res).status).toBe(302);
		expect(r.store.getMiroToken(TEAM)).toBe('at-1');
	});

	test('другой метод → 405, другой путь → 404, обмена нет', async () => {
		const post = run('POST', '/miro/oauth/callback?code=c1');
		expect((await post.res).status).toBe(405);
		expect((await run('PUT', '/miro/setup?tenant=acme').res).status).toBe(405);
		const other = run('GET', '/miro/oauthx');
		expect((await other.res).status).toBe(404);
		expect(post.fetched.length + other.fetched.length).toBe(0);
	});

	test('без now берётся часы системы', async () => {
		const s = setup();
		const handler = miroOauthHandler(s.deps);
		const url = new URL('https://x/miro/setup?tenant=acme');
		const state = new URL(
			(await handler(new Request(url.toString()), url)).headers.get('location')!,
		).searchParams.get('state')!;
		expect(readState(state, SECRET, Date.now())).toBe('acme');
	});
});
