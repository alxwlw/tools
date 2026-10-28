import { describe, expect, test } from 'bun:test';

import { inbox, USAGE as INBOX_USAGE } from '../scripts/inbox.ts';
import { journal, USAGE as JOURNAL_USAGE, sinceOf } from '../scripts/journal.ts';
import { replayRequest } from '../scripts/replay.ts';
import { Store } from '../src/store.ts';
import { BASE, DOKPLOY_SECRET, GRAFANA_TOKEN, VERCEL_SECRET, world } from './server-harness.ts';

const NOW = Date.parse('2026-10-29T12:00:00Z');

function run(fn: (print: (line: string) => void) => number) {
	const out: string[] = [];
	const code = fn((line) => out.push(line));
	return { code, out };
}

describe('scripts/inbox.ts', () => {
	test('failed — таблица упавших; retry — снова pending; чужой id — 1; без команды — 2', () => {
		const store = new Store(':memory:');
		const id = store.inboxAdd('acme', 'github', 'd-1', 'p', '2026-10-28T10:00:00Z') as number;
		store.inboxFailed(id, 'Plane POST /links/ → 400');
		expect(run((print) => inbox(['failed'], store, print))).toEqual({
			code: 0,
			out: [
				'id\ttenant\tkind\tat\terror',
				'1\tacme\tgithub\t2026-10-28T10:00:00.000Z\tPlane POST /links/ → 400',
			],
		});
		expect(run((print) => inbox(['retry', '1'], store, print))).toEqual({
			code: 0,
			out: ['delivery 1 is pending again: restart the service to run it'],
		});
		expect(store.inboxPending().map((job) => job.id)).toEqual([1]);
		expect(run((print) => inbox(['retry', '1'], store, print)).code).toBe(1);
		expect(run((print) => inbox(['retry', '1'], store, print)).out).toEqual([
			'no failed delivery 1',
		]);
		expect(run((print) => inbox([], store, print)).out).toEqual([INBOX_USAGE]);
		for (const args of [[], ['retry'], ['retry', 'x'], ['retry', '0'], ['failed', '1'], ['purge']])
			expect(run((print) => inbox(args, store, print)).code).toBe(2);
	});
});

describe('scripts/journal.ts', () => {
	test('sinceOf: Nd — дни назад, ISO — как есть, остальное — null', () => {
		expect(sinceOf('7d', NOW)).toBe('2026-10-22T12:00:00.000Z');
		expect(sinceOf('2026-10-28T10:00:00+02:00', NOW)).toBe('2026-10-28T08:00:00.000Z');
		for (const bad of ['0d', '7', 'week', 'd', '1e3d', 'October 2026', ''])
			expect(sinceOf(bad, NOW)).toBeNull();
	});

	test('переходы таблицей, с тенантом и без; без --since — 2', () => {
		const store = new Store(':memory:');
		const row = (tenant: string, key: string, at: string) =>
			store.journalAdd({ tenant, key, from: 'Todo', to: 'In Review', cause: `pr:acme/api#1`, at });
		row('acme', 'ENG-1', '2026-10-28T10:00:00Z');
		row('beta', 'QA-2', '2026-10-28T11:00:00Z');
		row('acme', 'ENG-0', '2026-10-01T00:00:00Z');
		expect(run((print) => journal(['--since', '7d'], store, NOW, print))).toEqual({
			code: 0,
			out: [
				'at\ttenant\tkey\tfrom\tto\tcause',
				'2026-10-28T10:00:00.000Z\tacme\tENG-1\tTodo\tIn Review\tpr:acme/api#1',
				'2026-10-28T11:00:00.000Z\tbeta\tQA-2\tTodo\tIn Review\tpr:acme/api#1',
			],
		});
		expect(
			run((print) => journal(['--since', '7d', '--tenant', 'beta'], store, NOW, print)).out,
		).toHaveLength(2);
		expect(run((print) => journal(['--since', 'week'], store, NOW, print)).out).toEqual([
			JOURNAL_USAGE,
		]);
		expect(run((print) => journal(['--from', '7d'], store, NOW, print)).out).toEqual([
			JOURNAL_USAGE,
		]);
		for (const args of [[], ['--since', 'week'], ['--since', '7d', 'extra'], ['--from', '7d']])
			expect(run((print) => journal(args, store, NOW, print)).code).toBe(2);
	});
});

describe('scripts/replay.ts', () => {
	const env = {
		PLANE_HOOKS_ACME_GRAFANA_TOKEN: GRAFANA_TOKEN,
		PLANE_HOOKS_ACME_VERCEL_SECRET: VERCEL_SECRET,
		PLANE_HOOKS_ACME_DOKPLOY_SECRET: DOKPLOY_SECRET,
		PLANE_HOOKS_GH_ACME_WEBHOOK_SECRET: 'gh-secret',
		PLANE_HOOKS_CONFIG: '/config/tenants.json',
	};
	const tenants = JSON.stringify({
		tenants: [{ id: 'acme', github: [{ name: 'acme', appId: 1_000_001 }] }],
	});
	const readFile = (path: string) => {
		if (path !== '/config/tenants.json') throw new Error(path);
		return tenants;
	};
	const send = async (args: string[], body: string) => {
		const replay = replayRequest(args, env, body, readFile, () => 'replay-1');
		if ('error' in replay) throw new Error(replay.error);
		const w = world();
		const res = await w.send(
			new Request(`${BASE}${replay.path}`, { method: 'POST', headers: replay.headers, body }),
		);
		return { status: res.status, w };
	};

	test('подписи настоящих отправителей принимает сервис', async () => {
		expect((await send(['acme', 'grafana'], '{"alerts":[]}')).status).toBe(200);
		expect((await send(['acme', 'vercel'], '{"type":"project.created"}')).status).toBe(200);
		const dokploy =
			'{"title":"Docker Cleanup","type":"docker-cleanup","status":"success","timestamp":"2026-10-29T04:00:00.000Z"}';
		expect((await send(['acme', 'dokploy'], dokploy)).status).toBe(200);
		const ping = await send(['github', 'ping'], '{"zen":"z"}');
		expect(ping.status).toBe(200);
		expect(ping.w.lines('github.ping')).toHaveLength(1);
		const named = replayRequest(['github', 'ping', 'acme'], env, '{}', readFile, () => 'd');
		expect(named).toMatchObject({
			headers: { 'x-github-hook-installation-target-id': '1000001', 'x-github-delivery': 'd' },
		});
	});

	test('без секрета, без App, неверный вызов — ошибка без значений', () => {
		expect(replayRequest(['acme', 'vercel'], {}, '{}', readFile)).toEqual({
			error: 'missing env PLANE_HOOKS_ACME_VERCEL_SECRET',
		});
		expect(replayRequest(['github', 'ping', 'other'], env, '{}', readFile)).toEqual({
			error: 'name the App: acme',
		});
		expect(replayRequest(['github', 'ping'], env, '{}', () => '{oops')).toEqual({
			error: 'cannot read the App ids from tenants.json',
		});
		for (const args of [
			[],
			['acme'],
			['acme', 'deploy'],
			['Acme', 'grafana'],
			['acme', 'grafana', 'x'],
			['github', 'Ping'],
		])
			expect(replayRequest(args, env, '{}', readFile)).toHaveProperty('error');
		expect(JSON.stringify(replayRequest(['acme', 'deploy'], env, '{}', readFile))).not.toContain(
			VERCEL_SECRET,
		);
	});
});
