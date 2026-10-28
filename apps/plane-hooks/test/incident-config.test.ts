import { describe, expect, test } from 'bun:test';
import { DEFAULT_PRIORITY, loadServiceConfig } from '../src/config.ts';
import { resolveIncidentProject } from '../src/incident.ts';
import { PlaneApiError } from '../src/plane.ts';
import { FakePlane } from './fake-plane.ts';
import { TEST_KEY_PEM } from './config-fixture.ts';

const ENV = {
	PLANE_HOOKS_PLANE_URL: 'https://plane.example.com',
	PLANE_HOOKS_PUBLIC_URL: 'https://hooks.example.com',
	PLANE_HOOKS_ACME_PLANE_SECRET: 'plane-secret',
	PLANE_HOOKS_GH_ACME_PRIVATE_KEY: Buffer.from(TEST_KEY_PEM).toString('base64'),
	PLANE_HOOKS_GH_ACME_WEBHOOK_SECRET: 'gh-secret',
};

function tenantWith(incidents: unknown) {
	const file = {
		tenants: [
			{
				id: 'acme',
				workspace: 'example-ws',
				plane: { clientId: 'cid', appInstallationId: 'inst' },
				github: [{ name: 'acme', appId: 1000001, owner: 'acme' }],
				incidents,
			},
		],
	};
	return loadServiceConfig(ENV, () => JSON.stringify(file)).tenants[0];
}

describe('incidents.priority', () => {
	test('без priority — умолчание', () => {
		expect(tenantWith({ project: 'INC' })?.incidents).toEqual({
			project: 'INC',
			priority: DEFAULT_PRIORITY,
		});
	});

	test('priority из конфига перекрывает умолчание по ячейке', () => {
		const priority = tenantWith({
			project: 'INC',
			priority: { warning: { prod: 'medium' }, info: { '*': 'medium' } },
		})?.incidents?.priority;
		expect(priority).toEqual({
			critical: { '*': 'urgent', staging: 'high' },
			warning: { '*': 'high', staging: 'medium', prod: 'medium' },
			'*': { '*': 'urgent', staging: 'high' },
			info: { '*': 'medium' },
		});
	});

	test('неизвестный приоритет — ошибка с путём, без значения', () => {
		expect(() =>
			tenantWith({ project: 'INC', priority: { warning: { prod: 'low-secret' } } }),
		).toThrow('tenants[0].incidents.priority.warning.prod must be urgent, high or medium');
		try {
			tenantWith({ project: 'INC', priority: { warning: { prod: 'low-secret' } } });
		} catch (err) {
			expect((err as Error).message).not.toContain('low-secret');
		}
	});

	test('строка severity — не объект: ошибка с путём', () => {
		expect(() => tenantWith({ project: 'INC', priority: { warning: 'high' } })).toThrow(
			'tenants[0].incidents.priority.warning must be an object',
		);
	});

	test('priority не объект — ошибка с путём', () => {
		expect(() => tenantWith({ project: 'INC', priority: 5 })).toThrow(
			'tenants[0].incidents.priority must be an object',
		);
	});

	test('умолчание не мутируется слиянием', () => {
		tenantWith({ project: 'INC', priority: { warning: { prod: 'medium' } } });
		expect(DEFAULT_PRIORITY.warning).toEqual({ '*': 'high', staging: 'medium' });
	});
});

describe('resolveIncidentProject', () => {
	test('находит id проекта по идентификатору', async () => {
		const plane = new FakePlane({ OPS: 'p-ops', INC: 'p-inc' });
		expect(await resolveIncidentProject(plane, 'INC')).toBe('p-inc');
	});

	test('resolveIncidentProject: нет проекта — ошибка с идентификатором', async () => {
		const plane = new FakePlane({ OPS: 'p-ops' });
		await expect(resolveIncidentProject(plane, 'INC')).rejects.toThrow(
			'incident project INC not found',
		);
	});

	test('ошибка Plane пробрасывается как есть', async () => {
		const plane = new FakePlane({ INC: 'p-inc' });
		plane.failNext('listProjects');
		await expect(resolveIncidentProject(plane, 'INC')).rejects.toBeInstanceOf(PlaneApiError);
	});
});
