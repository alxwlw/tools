import { describe, expect, test } from 'bun:test';
import { createPublicKey, createVerify } from 'node:crypto';
import { appJwt, createGitHubApp } from '../src/github/app.ts';
import { GitHubApiError } from '../src/github/client.ts';
import { tenantOf, TEST_KEY_PEM } from './config-fixture.ts';
import {
	accessTokenBody,
	appBody,
	deliveryBody,
	installationBody,
	pullBody,
} from './github-bodies.ts';

type Reply = { status: number; body?: unknown; link?: string };
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function stub(replies: Reply[]) {
	const calls: Call[] = [];
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({
			url,
			method: init.method ?? 'GET',
			headers: init.headers as Record<string, string>,
			body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
		});
		const reply = replies.shift();
		if (!reply) throw new Error(`unexpected request ${init.method} ${url}`);
		return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
			status: reply.status,
			headers: reply.link === undefined ? {} : { link: reply.link },
		});
	};
	return { calls, fetch };
}

const CONFIG = tenantOf().github[0]!;
const T0 = Date.parse('2026-10-20T10:00:00Z');
const EXPIRES = '2026-10-20T11:00:00Z';
const EXPIRES_MS = Date.parse(EXPIRES);

function decode(part: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('appJwt', () => {
	test('JWT — RS256, iss = appId, iat на 60 с раньше, exp через 540 с, подпись проверяется открытым ключом', () => {
		const jwt = appJwt(1000001, TEST_KEY_PEM, 1_800_000_000);
		const [header, payload, signature] = jwt.split('.') as [string, string, string];
		expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
		expect(decode(payload)).toEqual({
			iat: 1_800_000_000 - 60,
			exp: 1_800_000_000 + 540,
			iss: 1000001,
		});
		const verifier = createVerify('RSA-SHA256').update(`${header}.${payload}`);
		expect(
			verifier.verify(createPublicKey(TEST_KEY_PEM), Buffer.from(signature, 'base64url')),
		).toBe(true);
	});
});

describe('токен установки', () => {
	test('токен установки кэшируется и обновляется за 5 минут до expires_at', async () => {
		const { calls, fetch } = stub([
			{ status: 200, body: accessTokenBody(EXPIRES, 'ghs_first') },
			{ status: 200, body: pullBody() },
			{ status: 200, body: pullBody() },
			{ status: 200, body: pullBody() },
			{ status: 200, body: accessTokenBody('2026-10-20T12:00:00Z', 'ghs_second') },
			{ status: 200, body: pullBody() },
		]);
		let clock = T0;
		const app = createGitHubApp(CONFIG, { fetch, now: () => clock });
		const client = app.client(7);

		await client.getPull('acme/api', 12);
		await client.getPull('acme/api', 12);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			'POST https://api.github.com/app/installations/7/access_tokens',
			'GET https://api.github.com/repos/acme/api/pulls/12',
			'GET https://api.github.com/repos/acme/api/pulls/12',
		]);
		expect(calls[0]?.headers.Authorization).toMatch(/^Bearer ey/);
		expect(calls[1]?.headers.Authorization).toBe('Bearer ghs_first');
		expect(calls[0]?.headers['X-GitHub-Api-Version']).toBe('2022-11-28');

		clock = EXPIRES_MS - 5 * 60_000 - 1; // 1 ms before the margin: still cached
		await client.getPull('acme/api', 12);
		expect(calls).toHaveLength(4);
		expect(calls[3]?.headers.Authorization).toBe('Bearer ghs_first');

		clock = EXPIRES_MS - 5 * 60_000; // at the margin: renewed
		await client.getPull('acme/api', 12);
		expect(calls).toHaveLength(6);
		expect(calls[4]?.method).toBe('POST');
		expect(calls[5]?.headers.Authorization).toBe('Bearer ghs_second');
	});

	test('JWT запроса токена строится от часов now, а не от системных', async () => {
		const { calls, fetch } = stub([
			{ status: 200, body: accessTokenBody(EXPIRES) },
			{ status: 200, body: pullBody() },
		]);
		const app = createGitHubApp(CONFIG, { fetch, now: () => T0 });
		await app.client(7).getPull('acme/api', 12);
		const jwt = (calls[0]?.headers.Authorization ?? '').replace('Bearer ', '');
		expect(decode(jwt.split('.')[1] as string).iat).toBe(T0 / 1000 - 60);
	});

	test('одновременные вызовы одной установки делят один запрос токена, у разных установок токены разные', async () => {
		const { calls, fetch } = stub([
			{ status: 200, body: accessTokenBody(EXPIRES, 'ghs_seven') },
			{ status: 200, body: accessTokenBody(EXPIRES, 'ghs_eight') },
			{ status: 200, body: pullBody() },
			{ status: 200, body: pullBody() },
			{ status: 200, body: pullBody() },
		]);
		const app = createGitHubApp(CONFIG, { fetch, now: () => T0 });
		await Promise.all([
			app.client(7).getPull('acme/api', 1),
			app.client(7).getPull('acme/api', 2),
			app.client(8).getPull('acme/api', 3),
		]);
		expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
			'https://api.github.com/app/installations/7/access_tokens',
			'https://api.github.com/app/installations/8/access_tokens',
		]);
		const auth = Object.fromEntries(
			calls.filter((c) => c.method === 'GET').map((c) => [c.url, c.headers.Authorization]),
		);
		expect(auth['https://api.github.com/repos/acme/api/pulls/1']).toBe('Bearer ghs_seven');
		expect(auth['https://api.github.com/repos/acme/api/pulls/2']).toBe('Bearer ghs_seven');
		expect(auth['https://api.github.com/repos/acme/api/pulls/3']).toBe('Bearer ghs_eight');
	});

	test('неудачный запрос токена не кэшируется: следующий вызов пробует снова', async () => {
		const { calls, fetch } = stub([
			{ status: 500 },
			{ status: 200, body: accessTokenBody(EXPIRES) },
			{ status: 200, body: pullBody() },
		]);
		const app = createGitHubApp(CONFIG, { fetch, now: () => T0 });
		const client = app.client(7);
		await expect(client.getPull('acme/api', 12)).rejects.toMatchObject({
			status: 500,
			path: '/app/installations/7/access_tokens',
		});
		expect((await client.getPull('acme/api', 12))?.number).toBe(12);
		expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'GET']);
	});

	test('ответ без token или с непонятным expires_at — ошибка, не кэш', async () => {
		const { fetch } = stub([{ status: 200, body: { token: 'ghs_x', expires_at: 'soon' } }]);
		const app = createGitHubApp(CONFIG, { fetch, now: () => T0 });
		await expect(app.client(7).getPull('acme/api', 12)).rejects.toThrow('unexpected shape');
	});
});

describe('installationFor', () => {
	test('installationFor: id установки из ответа, JWT в заголовке', async () => {
		const { calls, fetch } = stub([{ status: 200, body: installationBody(42) }]);
		const app = createGitHubApp(CONFIG, { fetch, now: () => T0 });
		expect(await app.installationFor('acme/api')).toBe(42);
		expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/api/installation');
		expect(calls[0]?.headers.Authorization).toMatch(/^Bearer ey/);
	});

	test('installationFor: 404 — null', async () => {
		const { fetch } = stub([{ status: 404, body: { message: 'Not Found' } }]);
		const app = createGitHubApp(CONFIG, { fetch, now: () => T0 });
		expect(await app.installationFor('acme/none')).toBeNull();
	});

	test('installationFor: не-404 ошибка — GitHubApiError', async () => {
		const { fetch } = stub([{ status: 403 }]);
		const app = createGitHubApp(CONFIG, { fetch, now: () => T0 });
		await expect(app.installationFor('acme/api')).rejects.toBeInstanceOf(GitHubApiError);
	});
});

describe('health', () => {
	test('health: GET /app 401 — appOk false', async () => {
		const { calls, fetch } = stub([{ status: 401, body: { message: 'Bad credentials' } }]);
		const app = createGitHubApp(CONFIG, { fetch, now: () => T0 });
		expect(await app.health('2026-10-20T00:00:00Z')).toEqual({ appOk: false, failed: 0 });
		expect(calls).toHaveLength(1);
	});

	test('health: сеть недоступна — appOk false', async () => {
		const app = createGitHubApp(CONFIG, {
			fetch: async () => {
				throw new TypeError('fetch failed');
			},
			now: () => T0,
		});
		expect(await app.health('2026-10-20T00:00:00Z')).toEqual({ appOk: false, failed: 0 });
	});

	test('health считает доставки с кодом ≥ 400 после sinceIso', async () => {
		const { calls, fetch } = stub([
			{ status: 200, body: appBody() },
			{
				status: 200,
				body: [
					deliveryBody('2026-10-20T09:30:00Z', 200, 1),
					deliveryBody('2026-10-20T09:20:00Z', 400, 2),
					deliveryBody('2026-10-20T09:10:00Z', 502, 3),
					deliveryBody('2026-10-20T09:05:00Z', 0, 4),
					deliveryBody('2026-10-20T09:00:00Z', 404, 5), // exactly at since: counted
					deliveryBody('2026-10-20T08:59:59Z', 500, 6), // older: not counted
				],
			},
		]);
		const app = createGitHubApp(CONFIG, { fetch, now: () => T0 });
		expect(await app.health('2026-10-20T09:00:00Z')).toEqual({ appOk: true, failed: 4 });
		expect(calls.map((c) => c.url)).toEqual([
			'https://api.github.com/app',
			'https://api.github.com/app/hook/deliveries?per_page=100',
		]);
	});

	test('health: доставка без status_code считается неудачной', async () => {
		const { fetch } = stub([
			{ status: 200, body: appBody() },
			{ status: 200, body: [deliveryBody('2026-10-20T09:30:00Z', null)] },
		]);
		const app = createGitHubApp(CONFIG, { fetch, now: () => T0 });
		expect(await app.health('2026-10-20T09:00:00Z')).toEqual({ appOk: true, failed: 1 });
	});

	test('health идёт по курсору Link, пока доставки не старше sinceIso', async () => {
		const { calls, fetch } = stub([
			{ status: 200, body: appBody() },
			{
				status: 200,
				body: [deliveryBody('2026-10-20T09:30:00Z', 500, 1)],
				link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_2>; rel="next"',
			},
			{
				status: 200,
				body: [
					deliveryBody('2026-10-20T09:20:00Z', 500, 2),
					deliveryBody('2026-10-19T00:00:00Z', 500, 3),
				],
				link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_4>; rel="next"',
			},
		]);
		const app = createGitHubApp(CONFIG, { fetch, now: () => T0 });
		expect(await app.health('2026-10-20T09:00:00Z')).toEqual({ appOk: true, failed: 2 });
		expect(calls.map((c) => c.url).slice(1)).toEqual([
			'https://api.github.com/app/hook/deliveries?per_page=100',
			'https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_2',
		]);
	});
});
