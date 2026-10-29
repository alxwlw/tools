// Adapted from apps/plane-discord/test/setup.test.ts.
import { describe, expect, test } from 'bun:test';

import { planeOauthCallback, planeSetupRedirect } from '../src/setup.ts';

type Entry = { event: 'plane.installed'; appInstallationId: string };

describe('planeSetupRedirect', () => {
	test('setup: 302 на authorize-app с client_id, redirect_uri и scope', () => {
		const res = planeSetupRedirect({
			planeUrl: 'https://plane.example.com',
			publicUrl: 'https://hooks.example.com',
			clientId: 'client&id',
			scopes: ['projects:read', 'projects.work_items:read'],
		});
		expect(res.status).toBe(302);
		const location = res.headers.get('location')!;
		expect(location.startsWith('https://plane.example.com/auth/o/authorize-app/?')).toBe(true);
		const query = new URL(location).searchParams;
		expect(query.get('client_id')).toBe('client&id');
		expect(query.get('response_type')).toBe('code');
		expect(query.get('redirect_uri')).toBe('https://hooks.example.com/plane/oauth/callback');
		expect(query.get('scope')).toBe('projects:read projects.work_items:read');
		// '&' in a value stays one parameter.
		expect(location).toContain('client_id=client%26id&response_type=code&');
	});

	test('planeSetupRedirect кодирует пробел между скоупами как %20', () => {
		const res = planeSetupRedirect({
			planeUrl: 'https://plane.example.com',
			publicUrl: 'https://hooks.example.com',
			clientId: 'cid',
			scopes: ['a:read', 'b:write'],
		});
		const location = res.headers.get('location')!;
		expect(location).toEndWith('&scope=a%3Aread%20b%3Awrite');
		expect(location).not.toContain('+');
	});
});

describe('planeOauthCallback', () => {
	test('callback: app_installation_id в теле text/plain и в логе plane.installed; без id → 400', async () => {
		const logs: Entry[] = [];
		const ok = planeOauthCallback(
			new URL('http://x/plane/oauth/callback?app_installation_id=inst-1&code=SECRETCODE'),
			(e) => logs.push(e),
		);
		expect(ok.status).toBe(200);
		expect(ok.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(await ok.text()).toBe('app_installation_id=inst-1\n');
		expect(logs).toEqual([{ event: 'plane.installed', appInstallationId: 'inst-1' }]);

		const none = planeOauthCallback(new URL('http://x/plane/oauth/callback?code=c'), (e) =>
			logs.push(e),
		);
		expect(none.status).toBe(400);
		expect(logs).toHaveLength(1);
	});

	test('callback: id не из допустимых символов → 400, ничего не эхом и не в лог', async () => {
		const logs: Entry[] = [];
		const hostile = ['<script>', 'a b', 'x'.repeat(65), ''];
		for (const id of hostile) {
			const url = new URL('http://x/plane/oauth/callback');
			url.searchParams.set('app_installation_id', id);
			const res = planeOauthCallback(url, (e) => logs.push(e));
			expect(res.status).toBe(400);
			expect(await res.text()).not.toContain(id || '\u0000');
		}
		expect(logs).toEqual([]);
	});

	test('callback: code не попадает ни в тело, ни в лог', async () => {
		const logs: Entry[] = [];
		const res = planeOauthCallback(
			new URL('http://x/plane/oauth/callback?app_installation_id=i&code=SECRETCODE'),
			(e) => logs.push(e),
		);
		expect(await res.text()).not.toContain('SECRETCODE');
		expect(JSON.stringify(logs)).not.toContain('SECRETCODE');
	});
});
