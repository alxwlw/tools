import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { startService } from '../src/index.ts';
import { Store } from '../src/store.ts';
import { TEST_KEY_PEM } from './config-fixture.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '..', 'tenants.example.json'), 'utf8');
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envOf(db: string): Record<string, string> {
	return {
		PLANE_HOOKS_PLANE_URL: 'https://plane.example.com',
		PLANE_HOOKS_PUBLIC_URL: 'https://hooks.example.com',
		PLANE_HOOKS_DB: db,
		PLANE_HOOKS_ACME_PLANE_SECRET: 'plane-secret',
		PLANE_HOOKS_ACME_GRAFANA_TOKEN: `ph_${'b'.repeat(48)}`,
		PLANE_HOOKS_ACME_DOKPLOY_SECRET: 'dokploy-secret',
		PLANE_HOOKS_GH_ACME_PRIVATE_KEY: Buffer.from(TEST_KEY_PEM).toString('base64'),
		PLANE_HOOKS_GH_ACME_WEBHOOK_SECRET: 'gh-secret',
	};
}

describe('startService', () => {
	test('пример конфига поднимается: строка listening с тенантом, входами и App; база в PLANE_HOOKS_DB', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'plane-hooks-index-'));
		dirs.push(dir);
		// A done delivery 15 days old is pruned at the start, a pending one is kept for the queue.
		const seeded = join(dir, 'hooks.sqlite');
		const store = new Store(seeded);
		const old = store.inboxAdd('acme', 'github', 'd-old', 'p', '2026-10-01T00:00:00Z') as number;
		store.inboxDone(old);
		store.close();

		const lines: string[] = [];
		const ticks: Array<{ ms: number; tick: () => void }> = [];
		const fetches: string[] = [];
		const service = startService(
			{ ...envOf(seeded), PLANE_HOOKS_CONFIG: '/config/tenants.json' },
			{
				readFile: (path) => {
					if (path !== '/config/tenants.json') throw new Error(`unexpected ${path}`);
					return EXAMPLE;
				},
				write: (line) => lines.push(line),
				listenPort: 0,
				now: () => Date.parse('2026-10-29T00:00:00Z'),
				every: (tick, ms) => {
					ticks.push({ ms, tick });
					return () => {};
				},
				fetch: async (url) => {
					fetches.push(url);
					return new Response('{}', { status: 503 });
				},
			},
		);
		try {
			const listening = lines.map((line) => JSON.parse(line)).find((e) => e.event === 'listening');
			expect(listening).toEqual({
				ts: expect.any(String),
				event: 'listening',
				port: service.port,
				tenants: [{ id: 'acme', inputs: ['github', 'grafana', 'dokploy'], apps: ['acme'] }],
			});
			const health = await fetch(`http://localhost:${service.port}/healthz`);
			expect(await health.text()).toBe('ok');
			expect(ticks.map((t) => t.ms)).toEqual([15 * 60_000, 24 * 60 * 60_000]);
			expect(fetches).toEqual([]);
		} finally {
			await service.stop();
		}
		const after = new Store(seeded);
		expect(after.inboxAdd('acme', 'github', 'd-old', 'p', '2026-10-29T00:00:00Z')).not.toBeNull();
		after.close();
	});

	test('плохой конфиг — одна ошибка с переменными, без значений', () => {
		const env = envOf(':memory:');
		const start = () =>
			startService(
				{ ...env, PLANE_HOOKS_ACME_PLANE_SECRET: '', PLANE_HOOKS_ACME_DOKPLOY_SECRET: ' ' },
				{ readFile: () => EXAMPLE, listenPort: 0, write: () => {} },
			);
		expect(start).toThrow(
			'plane-hooks: missing env PLANE_HOOKS_ACME_PLANE_SECRET; PLANE_HOOKS_ACME_DOKPLOY_SECRET is set but empty (unset it to disable the input)',
		);
	});

	test('тик сторожа: сбой проверки — строка watchdog.failed, процесс живёт', async () => {
		const lines: string[] = [];
		let watchdog: (() => void) | undefined;
		const service = startService(envOf(':memory:'), {
			readFile: () => EXAMPLE,
			write: (line) => lines.push(line),
			listenPort: 0,
			every: (tick, ms) => {
				if (ms === 15 * 60_000) watchdog = tick;
				return () => {};
			},
			fetch: async () => {
				throw new TypeError('fetch failed');
			},
		});
		try {
			watchdog?.();
			const settled = () => lines.some((l) => l.includes('"event":"github.app_unreachable"'));
			for (let i = 0; i < 50 && !settled(); i++)
				await new Promise((resolve) => setImmediate(resolve));
			const events = lines
				.map((line) => JSON.parse(line))
				.filter((e) => e.event !== 'listening')
				.map((e) => [e.event, e.tenant, e.check, e.error]);
			expect(events).toEqual([
				['watchdog.failed', 'acme', 'plane', 'PlaneAuthError'],
				['github.app_unreachable', 'acme', undefined, undefined],
			]);
		} finally {
			await service.stop();
		}
	});
});
