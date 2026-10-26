// Adapted from apps/plane-discord/test/plane-auth.test.ts.
import { describe, expect, test } from 'bun:test';
import { botTokenAuth, PLANE_SCOPES, PlaneAuthError } from '../src/plane/auth.ts';

type Call = { url: string; headers: Record<string, string>; body: string; signal: unknown };

/** fetch stub: every call answers with the next token `tok-N`, expires_in 36000 unless `replies` says otherwise. */
function stub(replies: Array<{ status: number; body?: unknown; delay?: Promise<void> }> = []) {
	const calls: Call[] = [];
	let n = 0;
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({
			url,
			headers: init.headers as Record<string, string>,
			body: String(init.body),
			signal: init.signal,
		});
		const reply = replies.shift() ?? {
			status: 200,
			body: { access_token: `tok-${++n}`, expires_in: 36000 },
		};
		await reply.delay;
		return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
	};
	return { calls, fetch };
}

function make(fetch: (u: string, i: RequestInit) => Promise<Response>, now: () => number) {
	return botTokenAuth({
		planeUrl: 'https://plane.test/',
		clientId: 'cid',
		clientSecret: 'sec',
		appInstallationId: 'inst-1',
		fetch,
		now,
	});
}

describe('botTokenAuth', () => {
	test('bot token: Basic из client id и secret, форма с grant_type, app_installation_id и scope из PLANE_SCOPES', async () => {
		const { calls, fetch } = stub();
		const headers = await make(fetch, () => 0).headers();
		expect(headers).toEqual({ Authorization: 'Bearer tok-1' });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://plane.test/auth/o/token/');
		expect(calls[0]?.headers.Authorization).toBe(`Basic ${btoa('cid:sec')}`);
		expect(calls[0]?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
		const form = new URLSearchParams(calls[0]?.body);
		expect(form.get('grant_type')).toBe('client_credentials');
		expect(form.get('app_installation_id')).toBe('inst-1');
		expect(form.get('scope')).toBe(PLANE_SCOPES.join(' '));
		expect(PLANE_SCOPES).toEqual([
			'projects:read',
			'projects.work_items:read',
			'projects.work_items:write',
			'projects.work_items.comments:read',
			'projects.work_items.comments:write',
			'projects.work_items.links:read',
			'projects.work_items.links:write',
			'projects.states:read',
			'projects.members:read',
			'workspaces.members:read',
		]);
		expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
	});

	test('токен живёт до expires_in − 600 с, потом запрашивается новый', async () => {
		const { calls, fetch } = stub();
		let t = 1_000;
		const auth = make(fetch, () => t);
		expect((await auth.headers()).Authorization).toBe('Bearer tok-1');
		t += (36000 - 600) * 1000 - 1;
		expect((await auth.headers()).Authorization).toBe('Bearer tok-1');
		expect(calls).toHaveLength(1);
		t += 1;
		expect((await auth.headers()).Authorization).toBe('Bearer tok-2');
		expect(calls).toHaveLength(2);
	});

	test('два параллельных headers() — один запрос к /auth/o/token/', async () => {
		const { calls, fetch } = stub();
		const auth = make(fetch, () => 0);
		const [a, b] = await Promise.all([auth.headers(), auth.headers()]);
		expect(calls).toHaveLength(1);
		expect(a).toEqual({ Authorization: 'Bearer tok-1' });
		expect(b).toEqual({ Authorization: 'Bearer tok-1' });
	});

	test('invalidate — следующий headers() за новым токеном', async () => {
		const { calls, fetch } = stub();
		const auth = make(fetch, () => 0);
		await auth.headers();
		auth.invalidate();
		expect((await auth.headers()).Authorization).toBe('Bearer tok-2');
		expect(calls).toHaveLength(2);
	});

	test('invalidate во время запроса токена: его результат не кэшируется', async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { calls, fetch } = stub([
			{ status: 200, body: { access_token: 'stale', expires_in: 36000 }, delay: gate },
		]);
		const auth = make(fetch, () => 0);
		const first = auth.headers();
		auth.invalidate();
		// Asked before the stale request lands: must not join it.
		const second = auth.headers();
		release();
		expect((await first).Authorization).toBe('Bearer stale');
		expect((await second).Authorization).toBe('Bearer tok-1');
		expect((await auth.headers()).Authorization).toBe('Bearer tok-1');
		expect(calls).toHaveLength(2);
	});

	test('401 от /auth/o/token/ — PlaneAuthError 401, тела ответа в message нет', async () => {
		const { fetch } = stub([{ status: 401, body: { error: 'secret-detail-xyz' } }]);
		const err = await make(fetch, () => 0)
			.headers()
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(err).toBeInstanceOf(PlaneAuthError);
		expect((err as PlaneAuthError).status).toBe(401);
		expect((err as PlaneAuthError).message).toBe('Plane token request → 401');
		expect((err as PlaneAuthError).message).not.toContain('secret-detail-xyz');
	});

	test('неудача не кэшируется: следующий headers() спрашивает снова', async () => {
		const { calls, fetch } = stub([{ status: 500 }]);
		const auth = make(fetch, () => 0);
		await expect(auth.headers()).rejects.toBeInstanceOf(PlaneAuthError);
		expect((await auth.headers()).Authorization).toBe('Bearer tok-1');
		expect(calls).toHaveLength(2);
	});

	test('200 без access_token или без expires_in — PlaneAuthError, а не токен undefined', async () => {
		for (const body of [
			{ expires_in: 36000 },
			{ access_token: 'x' },
			{ access_token: 'x', expires_in: 0 },
		]) {
			const { fetch } = stub([{ status: 200, body }]);
			await expect(make(fetch, () => 0).headers()).rejects.toBeInstanceOf(PlaneAuthError);
		}
	});

	test('500 даже с телом токена — PlaneAuthError 500', async () => {
		const { fetch } = stub([{ status: 500, body: { access_token: 'x', expires_in: 36000 } }]);
		const err = await make(fetch, () => 0)
			.headers()
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(err).toBeInstanceOf(PlaneAuthError);
		expect((err as PlaneAuthError).status).toBe(500);
	});

	test('пустой токен и expires_in строкой — PlaneAuthError', async () => {
		for (const body of [
			{ access_token: '', expires_in: 36000 },
			{ access_token: 'x', expires_in: '36000' },
		]) {
			const { fetch } = stub([{ status: 200, body }]);
			await expect(make(fetch, () => 0).headers()).rejects.toBeInstanceOf(PlaneAuthError);
		}
	});

	test('expires_in короче запаса в 600 с: токен выдан, но не кэшируется', async () => {
		const { calls, fetch } = stub([
			{ status: 200, body: { access_token: 'short-1', expires_in: 1 } },
			{ status: 200, body: { access_token: 'short-2', expires_in: 1 } },
		]);
		const auth = make(fetch, () => 0);
		expect((await auth.headers()).Authorization).toBe('Bearer short-1');
		expect((await auth.headers()).Authorization).toBe('Bearer short-2');
		expect(calls).toHaveLength(2);
	});
});
