import { describe, expect, test } from 'bun:test';

import type { LogEntry } from '../src/log.ts';
import { PLANE_SCOPES } from '../src/plane/auth.ts';
import { oauthCallback, setupRedirect } from '../src/plane/setup.ts';
import { configOf } from './config-fixture.ts';

describe('setupRedirect', () => {
	test('setup: тенант → 302 на authorize-app с client_id, redirect_uri и scope', () => {
		const res = setupRedirect(configOf(), new URL('http://x/plane/setup?tenant=acme'));
		expect(res.status).toBe(302);
		const location = res.headers.get('location')!;
		expect(location.startsWith('https://plane.example.com/auth/o/authorize-app/?')).toBe(true);
		const query = new URL(location).searchParams;
		expect(query.get('client_id')).toBe('client&id');
		expect(query.get('response_type')).toBe('code');
		expect(query.get('redirect_uri')).toBe(
			'https://plane-discord.example.com/plane/oauth/callback',
		);
		expect(query.get('scope')).toBe(PLANE_SCOPES.join(' '));
		// '&' in a value stays one parameter, and the scopes are separated by %20.
		expect(location).toContain('client_id=client%26id&response_type=code&');
		expect(location).toContain('&scope=projects%3Aread%20projects.work_items%3Aread%20');
	});

	test('setup: неизвестный тенант → 404', () => {
		for (const q of ['?tenant=nobody', '', '?tenant=']) {
			const res = setupRedirect(configOf(), new URL(`http://x/plane/setup${q}`));
			expect(res.status).toBe(404);
			expect(res.headers.get('location')).toBeNull();
		}
	});
});

describe('oauthCallback', () => {
	test('callback: app_installation_id в теле text/plain и в логе plane.installed; без id → 400', async () => {
		const logs: LogEntry[] = [];
		const ok = oauthCallback(
			new URL('http://x/plane/oauth/callback?app_installation_id=inst-1&code=SECRETCODE'),
			(e) => logs.push(e),
		);
		expect(ok.status).toBe(200);
		expect(ok.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(await ok.text()).toBe('app_installation_id=inst-1\n');
		expect(logs).toEqual([{ event: 'plane.installed', appInstallationId: 'inst-1' }]);

		const none = oauthCallback(new URL('http://x/plane/oauth/callback?code=c'), (e) =>
			logs.push(e),
		);
		expect(none.status).toBe(400);
		expect(logs).toHaveLength(1);
	});

	test('callback: id не из допустимых символов → 400, ничего не эхом и не в лог', async () => {
		const logs: LogEntry[] = [];
		const hostile = ['<script>', 'a b', 'x'.repeat(65), ''];
		for (const id of hostile) {
			const url = new URL('http://x/plane/oauth/callback');
			url.searchParams.set('app_installation_id', id);
			const res = oauthCallback(url, (e) => logs.push(e));
			expect(res.status).toBe(400);
			expect(await res.text()).not.toContain(id || '\u0000');
		}
		expect(logs).toEqual([]);
	});

	test('callback: code не попадает ни в тело, ни в лог', async () => {
		const logs: LogEntry[] = [];
		const res = oauthCallback(
			new URL('http://x/plane/oauth/callback?app_installation_id=i&code=SECRETCODE'),
			(e) => logs.push(e),
		);
		expect(await res.text()).not.toContain('SECRETCODE');
		expect(JSON.stringify(logs)).not.toContain('SECRETCODE');
	});
});
