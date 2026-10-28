import { describe, expect, test } from 'bun:test';

import {
	githubCallback,
	githubManifest,
	githubSetupPage,
	setupState,
	verifySetupState,
} from '../src/github/setup.ts';
import { tenantOf } from './config-fixture.ts';

const NOW = 1_800_000_000;
const PUBLIC_URL = 'https://hooks.example.com';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n';
const WEBHOOK_SECRET = 'whsec_created_by_github';

describe('манифест', () => {
	test('манифест равен манифесту Global Constraints', () => {
		expect(githubManifest(PUBLIC_URL, 'plane-hooks-acme')).toEqual({
			name: 'plane-hooks-acme',
			url: 'https://hooks.example.com',
			hook_attributes: { url: 'https://hooks.example.com/hooks/github' },
			redirect_url: 'https://hooks.example.com/github/callback',
			public: false,
			default_permissions: {
				contents: 'read',
				pull_requests: 'read',
				deployments: 'write',
				metadata: 'read',
			},
			default_events: ['pull_request', 'deployment_status'],
		});
	});
});

describe('страница установки', () => {
	const tenant = tenantOf();

	async function page(owner: string, kind: 'org' | 'user') {
		const res = githubSetupPage({ publicUrl: PUBLIC_URL, tenant, owner, kind, nowSeconds: NOW });
		return { res, html: await res.text() };
	}

	test('организация: форма на organizations/acme/settings/apps/new?state=…, манифест в скрытом поле, экранирован', async () => {
		const { res, html } = await page('acme', 'org');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(res.headers.get('cache-control')).toBe('no-store');
		const state = setupState(tenant, NOW);
		expect(html).toContain(
			`<form method="post" action="https://github.com/organizations/acme/settings/apps/new?state=${state}">`,
		);
		const manifest = JSON.stringify(githubManifest(PUBLIC_URL, 'plane-hooks-acme'));
		const escaped = manifest.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
		expect(html).toContain(`<input type="hidden" name="manifest" value="${escaped}">`);
		expect(html).not.toContain(`value="${manifest}"`);
		expect(html.match(/<button/g)).toHaveLength(1);
	});

	test('аккаунт: github.com/settings/apps/new', async () => {
		const { html } = await page('octocat', 'user');
		expect(html).toContain('action="https://github.com/settings/apps/new?state=');
		expect(html).not.toContain('organizations/');
		expect(html).toContain('plane-hooks-octocat');
	});

	test('имя App из владельца: acme-corp → plane-hooks-acmecorp, 1password → g1password', async () => {
		expect((await page('acme-corp', 'org')).html).toContain('plane-hooks-acmecorp');
		expect((await page('1password', 'org')).html).toContain('plane-hooks-g1password');
		const long = await page('a'.repeat(20), 'org');
		expect(long.html).toContain(`plane-hooks-${'a'.repeat(16)}`);
		expect(long.html).not.toContain(`plane-hooks-${'a'.repeat(17)}`);
	});

	test('владелец с символами вне логина GitHub не попадает в адрес как есть', async () => {
		const { html } = await page('a/b"><x', 'org');
		expect(html).not.toContain('<x');
		expect(html).toContain('organizations/a%2Fb%22%3E%3Cx/settings');
	});
});

describe('state', () => {
	const tenant = tenantOf();
	const other = tenantOf({ id: 'other', plane: { ...tenantOf().plane, clientSecret: 'another' } });
	const tenants = [tenant, other];

	test('свой тенант в пределах часа — тенант', () => {
		expect(verifySetupState(tenants, setupState(tenant, NOW), NOW)?.id).toBe('acme');
		expect(verifySetupState(tenants, setupState(other, NOW), NOW + 3600)?.id).toBe('other');
	});

	test('просроченный (час и секунда) — null', () => {
		expect(verifySetupState(tenants, setupState(tenant, NOW), NOW + 3601)).toBeNull();
	});

	test('из будущего — null', () => {
		expect(verifySetupState(tenants, setupState(tenant, NOW + 10), NOW)).toBeNull();
	});

	test('чужая подпись — null', () => {
		const [id, ts] = setupState(tenant, NOW).split('.');
		const forged = setupState(other, NOW).split('.')[2];
		expect(verifySetupState(tenants, `${id}.${ts}.${forged}`, NOW)).toBeNull();
		expect(
			verifySetupState(tenants, `other.${ts}.${setupState(tenant, NOW).split('.')[2]}`, NOW),
		).toBeNull();
	});

	test('кривой — null', () => {
		const good = setupState(tenant, NOW);
		for (const state of [
			'',
			'acme',
			'acme.1',
			`${good}.x`,
			`ghost.${NOW}.${'0'.repeat(64)}`,
			`acme.${NOW}.zz`,
		]) {
			expect(verifySetupState(tenants, state, NOW)).toBeNull();
		}
		expect(verifySetupState(tenants, `acme.12abc.${good.split('.')[2]}`, NOW)).toBeNull();
	});
});

describe('callback', () => {
	const tenant = tenantOf();
	const state = setupState(tenant, NOW);
	const conversion = {
		id: 1_000_002,
		slug: 'plane-hooks-acme',
		name: 'plane-hooks-acme',
		owner: { login: 'acme-corp', id: 7 },
		pem: PEM,
		webhook_secret: WEBHOOK_SECRET,
		client_secret: 'must-not-appear',
	};

	function harness(reply: Response | Error) {
		const calls: { url: string; method: string | undefined; accept: string | undefined }[] = [];
		const logs: unknown[] = [];
		return {
			calls,
			logs,
			deps: {
				tenants: [tenant],
				nowSeconds: NOW,
				fetch: async (url: string, init: RequestInit) => {
					calls.push({
						url,
						method: init.method,
						accept: (init.headers as Record<string, string>).Accept,
					});
					if (reply instanceof Error) throw reply;
					return reply;
				},
				log: (entry: unknown) => void logs.push(entry),
			},
		};
	}
	const callbackUrl = (code: string, st: string) =>
		new URL(`${PUBLIC_URL}/github/callback?code=${code}&state=${st}`);

	test('плохой state — 400 без запроса к GitHub', async () => {
		const h = harness(Response.json(conversion, { status: 201 }));
		for (const st of ['', 'acme.1.abc', setupState(tenant, NOW - 7200)]) {
			const res = await githubCallback(callbackUrl('abc', st), h.deps);
			expect(res.status).toBe(400);
		}
		expect(h.calls).toEqual([]);
		expect(h.logs).toEqual([]);
	});

	test('нет code или code с лишними символами — 400 без запроса к GitHub', async () => {
		const h = harness(Response.json(conversion, { status: 201 }));
		for (const code of ['', 'a/../b', 'a%20b']) {
			expect((await githubCallback(callbackUrl(code, state), h.deps)).status).toBe(400);
		}
		expect(
			(await githubCallback(new URL(`${PUBLIC_URL}/github/callback?state=${state}`), h.deps))
				.status,
		).toBe(400);
		expect(h.calls).toEqual([]);
	});

	test('404 от conversions — 400 «код истёк, начните заново»', async () => {
		const h = harness(new Response('{}', { status: 404 }));
		const res = await githubCallback(callbackUrl('abc123', state), h.deps);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('код истёк, начните заново');
		expect(h.logs).toEqual([]);
	});

	test('прочие сбои GitHub — 502 без тела ответа', async () => {
		for (const reply of [
			new Response('secret-echo', { status: 500 }),
			new Error('network down'),
			new Response('not json', { status: 201 }),
			Response.json({ id: 1 }, { status: 201 }),
			Response.json([], { status: 201 }),
			Response.json(null, { status: 201 }),
			...[
				{ id: 0 },
				{ id: 1.5 },
				{ id: '7' },
				{ slug: '' },
				{ pem: '' },
				{ webhook_secret: '' },
				{ owner: {} },
				{ owner: null },
			].map((over) => Response.json({ ...conversion, ...over }, { status: 201 })),
		]) {
			const h = harness(reply);
			const res = await githubCallback(callbackUrl('abc123', state), h.deps);
			expect(res.status).toBe(502);
			const body = await res.text();
			expect(body).not.toContain('secret-echo');
			expect(body).not.toContain('network down');
			expect(h.logs).toEqual([]);
		}
	});

	test('успех — текст со значениями, заголовки no-store и nosniff, строка лога без pem и секрета', async () => {
		const h = harness(Response.json(conversion, { status: 201 }));
		const res = await githubCallback(callbackUrl('abc123', state), h.deps);
		expect(h.calls).toEqual([
			{
				url: 'https://api.github.com/app-manifests/abc123/conversions',
				method: 'POST',
				accept: 'application/vnd.github+json',
			},
		]);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('referrer-policy')).toBe('no-referrer');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		const pemB64 = Buffer.from(PEM).toString('base64');
		expect(await res.text()).toBe(
			[
				'GitHub App plane-hooks-acme created for acme-corp.',
				'1. Add to tenants.json, tenant "acme", key "github":',
				'   { "name": "acmecorp", "appId": 1000002, "owner": "acme-corp" }',
				'2. Add to the service env:',
				`   PLANE_HOOKS_GH_ACMECORP_PRIVATE_KEY=${pemB64}`,
				`   PLANE_HOOKS_GH_ACMECORP_WEBHOOK_SECRET=${WEBHOOK_SECRET}`,
				'3. Restart the service, then install the App: https://github.com/apps/plane-hooks-acme/installations/new',
				'This page is shown once: GitHub does not give the key again.',
				'',
			].join('\n'),
		);
		expect(h.logs).toEqual([
			{ event: 'github.app_created', tenant: 'acme', appId: 1_000_002, owner: 'acme-corp' },
		]);
		const logged = JSON.stringify(h.logs);
		expect(logged).not.toContain('PRIVATE KEY');
		expect(logged).not.toContain(WEBHOOK_SECRET);
	});

	test('slug из ответа с лишними символами — 502, а не ссылка', async () => {
		const h = harness(Response.json({ ...conversion, slug: 'x/../evil?' }, { status: 201 }));
		expect((await githubCallback(callbackUrl('abc123', state), h.deps)).status).toBe(502);
	});
});
