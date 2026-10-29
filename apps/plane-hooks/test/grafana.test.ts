import { describe, expect, test } from 'bun:test';
import { DEFAULT_PRIORITY } from '../src/config.ts';
import { alertPriority, parseGrafanaWebhook } from '../src/grafana.ts';
import type { IncidentSignal } from '../src/incident.ts';
import { BadPayload } from '../src/payload.ts';
import { fixture } from './fixtures.ts';

const T = '2026-10-06T10:00:00Z';
type Firing = Extract<IncidentSignal, { status: 'firing' }>;

function single(alert: Record<string, unknown>): IncidentSignal {
	const [signal] = parseGrafanaWebhook({
		alerts: [{ status: 'firing', fingerprint: 'f', startsAt: T, ...alert }],
	});
	return signal as IncidentSignal;
}

describe('parseGrafanaWebhook: срабатывание', () => {
	test('пачка из двух алертов → два сигнала в том же порядке', async () => {
		const signals = parseGrafanaWebhook(await fixture('grafana-firing.json'));
		expect(signals.map((s) => s.key)).toEqual(['a1b2c3d4e5f60718', '0f1e2d3c4b5a6978']);
	});

	test('prod-алерт: ключ, срабатывание, заголовок, приоритет, маркер, описание', async () => {
		const [prod] = parseGrafanaWebhook(await fixture('grafana-firing.json')) as Firing[];
		expect(prod).toMatchObject({
			status: 'firing',
			source: 'grafana',
			key: 'a1b2c3d4e5f60718',
			occurrence: '2026-10-06T10:00:00Z',
			at: '2026-10-06T10:00:00Z',
			title: '[prod] ServiceDown: order-gateway is down',
			priority: 'urgent',
			label: 'alert',
			noteHtml: '<p>Сработал 2026-10-06 10:00 UTC</p>',
		});
		const body = prod?.bodyHtml ?? '';
		expect(body).toContain('<p>order-gateway is down</p>');
		expect(body).toContain('<p>up == 0 for 2m</p>');
		expect(body).toContain('<li><code>job</code>: order-gateway</li>');
		expect(body).toContain(
			'<a href="https://grafana.example.com/alerting/grafana/abc/view?orgId=1">Правило</a>',
		);
		expect(body).toContain('alertmanager=grafana&amp;matcher=alertname%3DServiceDown');
		expect(body).toContain('>Runbook</a>');
		expect(body).not.toContain('Дашборд');
		expect(body).not.toContain('Панель');
	});

	test('staging-алерт: окружение из метки, приоритет high, javascript:-ссылка отброшена', async () => {
		const [, staging] = parseGrafanaWebhook(await fixture('grafana-firing.json')) as Firing[];
		expect(staging?.title).toBe('[staging] QueueStalled: settle queue stalled');
		expect(staging?.priority).toBe('high');
		expect(staging?.bodyHtml).not.toContain('javascript:');
		expect(staging?.bodyHtml).not.toContain('Правило');
	});

	test('HTML в аннотациях и метках экранируется', () => {
		const signal = single({
			labels: { alertname: 'X', '<k>': '<v>' },
			annotations: { description: '<img src=x onerror=alert(1)>' },
		}) as Firing;
		expect(signal.bodyHtml).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(signal.bodyHtml).toContain('<li><code>&lt;k&gt;</code>: &lt;v&gt;</li>');
		expect(signal.bodyHtml).not.toContain('<img');
	});

	test('summary в аннотациях экранируется', () => {
		const signal = single({
			labels: { alertname: 'X' },
			annotations: { summary: '<script>x</script>' },
		}) as Firing;
		expect(signal.bodyHtml).toContain('&lt;script&gt;x&lt;/script&gt;');
		expect(signal.bodyHtml).not.toContain('<script');
	});

	test('дашборд и панель ссылки отрендерены', () => {
		const signal = single({
			labels: { alertname: 'X' },
			annotations: {},
			dashboardURL: 'https://g/d',
			panelURL: 'https://g/p',
		}) as Firing;
		expect(signal.bodyHtml).toContain('<a href="https://g/d">Дашборд</a>');
		expect(signal.bodyHtml).toContain('<a href="https://g/p">Панель</a>');
	});

	test('заголовок обрезается до 200 символов', () => {
		const signal = single({
			labels: { alertname: 'X' },
			annotations: { summary: 's'.repeat(300) },
		}) as Firing;
		expect(signal.title).toHaveLength(200);
		expect(signal.title.endsWith('…')).toBe(true);
	});

	test('без alertname и с пустым env — prod и «alert»', () => {
		expect((single({ labels: {} }) as Firing).title).toBe('[prod] alert');
		expect((single({ labels: { alertname: 'X', env: '' } }) as Firing).title).toBe('[prod] X');
	});
});

describe('parseGrafanaWebhook: восстановление', () => {
	test('сигнал resolved с тем же ключом и срабатыванием', async () => {
		const [signal] = parseGrafanaWebhook(await fixture('grafana-resolved.json'));
		expect(signal).toEqual({
			status: 'resolved',
			source: 'grafana',
			key: 'a1b2c3d4e5f60718',
			occurrence: '2026-10-06T10:00:00Z',
			at: '2026-10-06T10:07:30Z',
			noteHtml: '<p>Погас 2026-10-06 10:07 UTC</p>',
			title: '[prod] ServiceDown: order-gateway is down',
			env: 'prod',
		});
	});
});

describe('parseGrafanaWebhook: чужая форма → BadPayload', () => {
	const bad: unknown[] = [
		null,
		{},
		{ alerts: 'x' },
		{ alerts: [1] },
		{ alerts: [{ status: 'firing', startsAt: T }] },
		{ alerts: [{ status: 'firing', fingerprint: 'f', startsAt: 'nope' }] },
		{ alerts: [{ status: 'resolved', fingerprint: 'f', startsAt: T, endsAt: 'nope' }] },
		{ alerts: [{ status: 'pending', fingerprint: 'f', startsAt: T }] },
	];
	test.each(bad.map((body, index) => [index, body] as const))('случай %d', (_index, body) => {
		expect(() => parseGrafanaWebhook(body)).toThrow(BadPayload);
	});
});

describe('alertPriority: severity × env', () => {
	test.each([
		['critical', 'prod', 'urgent'],
		['critical', 'staging', 'high'],
		['warning', 'prod', 'high'],
		['warning', 'staging', 'medium'],
		[undefined, 'prod', 'urgent'],
		[undefined, 'staging', 'high'],
		['', 'prod', 'urgent'],
		['', 'staging', 'high'],
		['info', 'prod', 'urgent'],
		['info', 'staging', 'high'],
	] as const)('severity %p, env %p → %p', (severity, env, expected) => {
		expect(
			alertPriority({ ...(severity === undefined ? {} : { severity }), env }, DEFAULT_PRIORITY),
		).toBe(expected);
	});

	test('severity в другом регистре и с пробелами', () => {
		expect(alertPriority({ severity: ' Warning ', env: 'prod' }, DEFAULT_PRIORITY)).toBe('high');
		expect(alertPriority({ severity: 'CRITICAL', env: 'staging' }, DEFAULT_PRIORITY)).toBe('high');
		expect(alertPriority({ severity: 'WARNING', env: 'staging' }, DEFAULT_PRIORITY)).toBe('medium');
	});

	test('таблица тенанта: warning в prod — medium', () => {
		const table = {
			...DEFAULT_PRIORITY,
			warning: { ...DEFAULT_PRIORITY.warning, prod: 'medium' },
		} as const;
		expect(alertPriority({ severity: 'warning', env: 'prod' }, table)).toBe('medium');
		expect(alertPriority({ severity: 'warning', env: 'dev' }, table)).toBe('high');
		const [signal] = parseGrafanaWebhook(
			{
				alerts: [
					{
						status: 'firing',
						fingerprint: 'f',
						startsAt: T,
						labels: { severity: 'warning', env: 'prod' },
					},
				],
			},
			table,
		) as Firing[];
		expect(signal?.priority).toBe('medium');
	});

	test('пустой env — prod: ячейка prod, а не *', () => {
		const table = { '*': { '*': 'urgent', prod: 'medium' } } as const;
		expect(alertPriority({ severity: 'critical', env: '' }, table)).toBe('medium');
		expect(alertPriority({ severity: 'critical' }, table)).toBe('medium');
	});

	test('метки с именами из Object.prototype не дают функцию вместо приоритета', () => {
		for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
			expect(alertPriority({ severity: 'critical', env: name }, DEFAULT_PRIORITY)).toBe('urgent');
			expect(alertPriority({ severity: name, env: 'prod' }, DEFAULT_PRIORITY)).toBe('urgent');
			expect(alertPriority({ severity: name, env: 'staging' }, DEFAULT_PRIORITY)).toBe('high');
			expect(alertPriority({ severity: 'warning', env: name }, DEFAULT_PRIORITY)).toBe('high');
		}
	});

	test('порядок поиска: ячейка строки, * строки, ячейка строки *, * строки *, urgent', () => {
		const table = {
			warning: { dev: 'high', '*': 'medium' },
			info: { staging: 'high' },
			'*': { prod: 'medium', '*': 'high' },
		} as const;
		expect(alertPriority({ severity: 'warning', env: 'dev' }, table)).toBe('high');
		expect(alertPriority({ severity: 'warning', env: 'prod' }, table)).toBe('medium');
		expect(alertPriority({ severity: 'info', env: 'prod' }, table)).toBe('medium');
		expect(alertPriority({ severity: 'info', env: 'dev' }, table)).toBe('high');
		expect(alertPriority({ severity: 'other', env: 'prod' }, table)).toBe('medium');
		expect(alertPriority({ severity: 'info', env: 'dev' }, {})).toBe('urgent');
	});

	test('пачка со смешанными severity и статусами', () => {
		const signals = parseGrafanaWebhook({
			alerts: [
				{
					status: 'firing',
					fingerprint: 'fp-prod-critical',
					startsAt: T,
					labels: { alertname: 'DiskFull', severity: 'critical' },
				},
				{
					status: 'firing',
					fingerprint: 'fp-prod-warning',
					startsAt: T,
					labels: { alertname: 'CertExpiring', severity: 'warning' },
				},
				{
					status: 'resolved',
					fingerprint: 'fp-prod-resolved',
					startsAt: T,
					endsAt: '2026-10-06T10:05:00Z',
					labels: { alertname: 'LagHigh', severity: 'warning' },
				},
			],
		});
		expect(signals).toHaveLength(3);
		expect(signals[0]).toMatchObject({
			status: 'firing',
			key: 'fp-prod-critical',
			priority: 'urgent',
		});
		expect(signals[1]).toMatchObject({
			status: 'firing',
			key: 'fp-prod-warning',
			priority: 'high',
		});
		expect(signals[2]).toMatchObject({ status: 'resolved', key: 'fp-prod-resolved' });
		expect(signals[2]).not.toHaveProperty('priority');
	});
});

describe('поля для отметки', () => {
	test('срабатывание и восстановление несут заголовок задачи и env', async () => {
		const [firingProd, firingStaging] = parseGrafanaWebhook(await fixture('grafana-firing.json'));
		expect(firingProd).toMatchObject({ status: 'firing', env: 'prod' });
		expect(firingStaging).toMatchObject({ status: 'firing', env: 'staging' });
		const [resolved] = parseGrafanaWebhook(await fixture('grafana-resolved.json'));
		expect(resolved).toMatchObject({
			status: 'resolved',
			title: '[prod] ServiceDown: order-gateway is down',
			env: 'prod',
		});
	});
});
