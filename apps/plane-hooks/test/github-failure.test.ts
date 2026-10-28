import { describe, expect, test } from 'bun:test';
import { deploymentSignal } from '../src/github/failure.ts';
import type { GitHubEvent } from '../src/github/webhook.ts';
import { tenantOf } from './config-fixture.ts';

type StatusEvent = Extract<GitHubEvent, { kind: 'deployment_status' }>;

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

function event(state: StatusEvent['state'], deployment: Partial<StatusEvent['deployment']> = {}) {
	return {
		kind: 'deployment_status',
		appId: 1000001,
		deliveryId: 'd-1',
		installationId: 77,
		deployment: {
			id: 501,
			repo: 'acme/api',
			sha: SHA,
			environment: 'production',
			creator: 'github-actions[bot]',
			description: null,
			...deployment,
		},
		state,
		logUrl: 'https://example.com/deploys/501',
	} satisfies StatusEvent;
}

describe('deploymentSignal', () => {
	test('провал CI в production — инцидент deploy:<repo>:production, urgent', () => {
		expect(deploymentSignal(event('failure'), tenantOf())).toMatchObject({
			status: 'firing',
			source: 'github',
			key: 'deploy:acme/api:production',
			occurrence: '501',
			title: 'Деплой упал: acme/api → production · abcdef0',
			priority: 'urgent',
			label: 'deploy-failed',
			env: 'production',
		});
	});

	test('error — тоже провал; ссылка на лог в описании и в заметке', () => {
		const signal = deploymentSignal(event('error'), tenantOf());
		expect(signal).toMatchObject({ status: 'firing' });
		const firing = signal as Extract<typeof signal, { status: 'firing' }>;
		expect(firing.bodyHtml).toContain('<a href="https://example.com/deploys/501">Лог деплоя</a>');
		expect(firing.noteHtml).toBe(
			'<p>Деплой упал: <code>abcdef0</code>, <a href="https://example.com/deploys/501">Лог деплоя</a></p>',
		);
	});

	test('провал в staging — high', () => {
		const signal = deploymentSignal(
			event('failure', { environment: 'staging', id: 502 }),
			tenantOf(),
		);
		expect(signal).toMatchObject({
			key: 'deploy:acme/api:staging',
			occurrence: '502',
			priority: 'high',
		});
	});

	test('провал от vercel[bot] при включённом Vercel — null; при выключенном — инцидент', () => {
		const vercel = event('failure', { creator: 'vercel[bot]' });
		expect(deploymentSignal(vercel, tenantOf())).toBeNull();
		const off = tenantOf({ inputs: { grafana: null, vercel: null, dokploy: null } });
		expect(deploymentSignal(vercel, off)).toMatchObject({ status: 'firing', priority: 'urgent' });
	});

	test('создатель без аккаунта (пустая строка) — не vercel[bot], инцидент есть', () => {
		expect(deploymentSignal(event('failure', { creator: '' }), tenantOf())).toMatchObject({
			status: 'firing',
		});
	});

	test('окружение не из конфига — null', () => {
		expect(deploymentSignal(event('failure', { environment: 'preview' }), tenantOf())).toBeNull();
	});

	test('репозиторий без правила — null', () => {
		expect(deploymentSignal(event('failure', { repo: 'other/api' }), tenantOf())).toBeNull();
	});

	test('тенант без delivery — null', () => {
		expect(deploymentSignal(event('failure'), tenantOf({ delivery: null }))).toBeNull();
	});

	test('успех — Погас того же ключа', () => {
		expect(deploymentSignal(event('success', { id: 503 }), tenantOf())).toMatchObject({
			status: 'resolved',
			source: 'github',
			key: 'deploy:acme/api:production',
			noteHtml: '<p>Деплой снова проходит: <code>abcdef0</code></p>',
		});
	});

	test('промежуточные состояния — null', () => {
		for (const state of ['in_progress', 'queued', 'pending', 'inactive'] as const) {
			expect(deploymentSignal(event(state), tenantOf())).toBeNull();
		}
	});
});
