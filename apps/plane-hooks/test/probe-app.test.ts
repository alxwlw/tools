import { afterEach, expect, spyOn, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { run } from '../scripts/probe-app.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const planeEnv = {
	PLANE_HOOKS_PLANE_URL: 'https://plane.example.com',
	PLANE_HOOKS_ACME_PLANE_SECRET: 's3cret',
	PROBE_PLANE_CLIENT_ID: 'client',
	PROBE_PLANE_INSTALLATION_ID: 'inst',
	PROBE_WORKSPACE: 'example-ws',
	PROBE_PROJECT_IDENTIFIER: 'ENG',
};

type Call = { method: string; url: string };

/** Plane stub: every answer is canned by `answer`; the calls are recorded. */
function stubFetch(answer: (c: Call) => Response | Error): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const call = { method: init?.method ?? 'GET', url: String(input) };
		calls.push(call);
		const r = answer(call);
		if (r instanceof Error) throw r;
		return r;
	}) as typeof fetch;
	return calls;
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status });

function planeAnswer(c: Call, deletes: (c: Call) => Response | Error): Response | Error {
	if (c.url.endsWith('/auth/o/token/')) return json({ access_token: 'tok-1234567890' });
	if (c.method === 'DELETE') return deletes(c);
	if (c.method === 'GET') return json({ results: [{ id: 'proj1', identifier: 'ENG' }] });
	if (c.url.endsWith('/work-items/')) return json({ id: 'ITEM1' }, 201);
	if (c.url.endsWith('/releases/')) return json({ id: 'REL1' }, 201);
	return json({}, 200);
}

function capture() {
	const lines: string[] = [];
	const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		lines.push(a.join(' '));
	});
	return { lines, restore: () => spy.mockRestore() };
}

test('plane-release: упавший DELETE релиза не отменяет DELETE задачи, оба id названы, код 1', async () => {
	const calls = stubFetch((c) =>
		planeAnswer(c, (d) => (d.url.includes('/releases/') ? new Error('boom') : json({}, 204))),
	);
	const out = capture();
	const code = await run(['plane-release', '--tenant', 'acme', '--scope', 'cand'], planeEnv);
	out.restore();
	const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
	expect(deletes).toEqual([
		'https://plane.example.com/api/v1/workspaces/example-ws/releases/REL1/',
		'https://plane.example.com/api/v1/workspaces/example-ws/projects/proj1/work-items/ITEM1/',
	]);
	expect(out.lines).toContain('LEFT: release REL1');
	expect(out.lines.some((l) => l.startsWith('LEFT: work-item'))).toBe(false);
	expect(code).toBe(1);
});

test('plane-release: DELETE с ответом 500 называет оба объекта', async () => {
	stubFetch((c) => planeAnswer(c, () => json({ error: 'x' }, 500)));
	const out = capture();
	const code = await run(['plane-release', '--tenant', 'acme', '--scope', 'cand'], planeEnv);
	out.restore();
	expect(out.lines).toContain('LEFT: release REL1');
	expect(out.lines).toContain('LEFT: work-item ITEM1');
	expect(code).toBe(1);
});

test('plane-release: id из тела ошибки создания не попадает в удаление', async () => {
	const calls = stubFetch((c) => {
		if (c.method === 'POST' && c.url.endsWith('/work-items/'))
			return json({ id: 'ERRID', error: 'no' }, 403);
		if (c.method === 'POST' && c.url.endsWith('/releases/')) return json({ id: 'ERRREL' }, 403);
		return planeAnswer(c, () => json({}, 204));
	});
	const out = capture();
	const code = await run(['plane-release', '--tenant', 'acme', '--scope', 'cand'], planeEnv);
	out.restore();
	expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
	expect(code).toBe(1);
});

test('gh-deploy: упавший DELETE называет Deployment, код 1', async () => {
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
	const calls = stubFetch((c) => {
		if (c.url.endsWith('/installation')) return json({ id: 5 });
		if (c.url.endsWith('/access_tokens')) return json({ token: 'ghs_abcdef' }, 201);
		if (c.method === 'DELETE') return new Error('boom');
		if (c.url.endsWith('/deployments')) return json({ id: 77 }, 201);
		return json({}, 201);
	});
	const out = capture();
	const code = await run(['gh-deploy', '--app', 'acme', 'acme/api', 'abc123', '--env', 'probe'], {
		PLANE_HOOKS_GH_ACME_PRIVATE_KEY: Buffer.from(pem).toString('base64'),
		PROBE_GH_ACME_APP_ID: '1',
	});
	out.restore();
	expect(calls.filter((c) => c.method === 'DELETE').length).toBe(1);
	expect(out.lines).toContain('LEFT: deployment 77');
	expect(code).toBe(1);
});

test('gh-deploy: id из тела отказа создания не попадает в удаление', async () => {
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
	const calls = stubFetch((c) => {
		if (c.url.endsWith('/installation')) return json({ id: 5 });
		if (c.url.endsWith('/access_tokens')) return json({ token: 'ghs_abcdef' }, 201);
		if (c.url.endsWith('/deployments')) return json({ id: 77 }, 403);
		return json({}, 204);
	});
	const out = capture();
	const code = await run(['gh-deploy', '--app', 'acme', 'acme/api', 'abc123', '--env', 'probe'], {
		PLANE_HOOKS_GH_ACME_PRIVATE_KEY: Buffer.from(pem).toString('base64'),
		PROBE_GH_ACME_APP_ID: '1',
	});
	out.restore();
	expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
	expect(code).toBe(1);
});
