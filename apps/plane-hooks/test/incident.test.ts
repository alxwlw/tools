import { beforeEach, describe, expect, test } from 'bun:test';
import {
	createIncidentReporter,
	type IncidentReporter,
	type IncidentSignal,
} from '../src/incident.ts';
import { PlaneApiError } from '../src/plane.ts';
import { FakePlane } from './fake-plane.ts';

type Firing = Extract<IncidentSignal, { status: 'firing' }>;
type Resolved = Extract<IncidentSignal, { status: 'resolved' }>;

const T0 = '2026-10-06T10:00:00Z';
const T1 = '2026-10-06T11:00:00Z';
const DEPLOY_KEY = 'deploy:prj_terminal:production:main';

function firing(overrides: Partial<Firing> = {}): Firing {
	return {
		status: 'firing',
		source: 'grafana',
		key: 'fp1',
		occurrence: T0,
		at: T0,
		title: '[prod] ServiceDown',
		bodyHtml: '<p>body</p>',
		noteHtml: '<p>Сработал</p>',
		priority: 'urgent',
		label: 'alert',
		...overrides,
	};
}

function resolved(overrides: Partial<Resolved> = {}): Resolved {
	return {
		status: 'resolved',
		source: 'grafana',
		key: 'fp1',
		occurrence: T0,
		at: '2026-10-06T10:05:00Z',
		noteHtml: '<p>Погас</p>',
		...overrides,
	};
}

const deployFiring = (occurrence: string) =>
	firing({
		source: 'vercel',
		key: DEPLOY_KEY,
		occurrence,
		label: 'deploy-failed',
		priority: 'high',
	});
const deployResolved = () => resolved({ source: 'vercel', key: DEPLOY_KEY, occurrence: undefined });

class LostAckPlane extends FakePlane {
	loseNextCommentAck = false;
	override async createComment(...args: Parameters<FakePlane['createComment']>) {
		const result = await super.createComment(...args);
		if (this.loseNextCommentAck) {
			this.loseNextCommentAck = false;
			throw new PlaneApiError(504, 'POST', '/comments/');
		}
		return result;
	}
}

class LostUnarchiveAckPlane extends FakePlane {
	loseNextAck = false;
	override async unarchiveWorkItem(...args: Parameters<FakePlane['unarchiveWorkItem']>) {
		await super.unarchiveWorkItem(...args);
		if (this.loseNextAck) {
			this.loseNextAck = false;
			throw new PlaneApiError(504, 'DELETE', '/unarchive/');
		}
	}
}

class NoDefaultStatePlane extends FakePlane {
	override async listStates(...args: Parameters<FakePlane['listStates']>) {
		return (await super.listStates(...args)).map((state) => ({ ...state, default: false }));
	}
}

let plane: FakePlane;
let incidents: IncidentReporter;

beforeEach(() => {
	plane = new FakePlane();
	incidents = createIncidentReporter({ plane, projectId: 'p-ops' });
});

describe('срабатывание', () => {
	test('первое создаёт задачу с меткой и маркер', async () => {
		const result = await incidents.report(firing());
		expect(result.action).toBe('created');
		expect(plane.workItems).toHaveLength(1);
		const item = plane.workItems[0];
		expect(item).toMatchObject({
			project: 'p-ops',
			name: '[prod] ServiceDown',
			description_html: '<p>body</p>',
			priority: 'urgent',
			external_id: 'fp1',
			external_source: 'grafana',
		});
		const alertLabel = plane.labels.get('p-ops')?.find((l) => l.name === 'alert');
		expect(alertLabel).toBeDefined();
		expect(item?.labels).toStrictEqual([alertLabel!.id]);
		expect(result.workItemId).toBe(item?.id as string);
		expect(
			plane
				.commentsOf(item?.id as string)
				.map((c) => [c.external_id, c.external_source, c.comment_html]),
		).toEqual([['fp1:2026-10-06T10:00:00Z:firing', 'grafana', '<p>Сработал</p>']]);
	});

	test('повтор того же срабатывания ничего не меняет', async () => {
		await incidents.report(firing());
		const again = await incidents.report(firing());
		expect(again.action).toBe('noop');
		expect(plane.workItems).toHaveLength(1);
		expect(plane.comments).toHaveLength(1);
	});

	test('новое срабатывание открытой задачи — комментарий без смены состояния', async () => {
		await incidents.report(firing());
		const next = await incidents.report(firing({ occurrence: T1, at: T1 }));
		expect(next.action).toBe('commented');
		expect(plane.comments).toHaveLength(2);
		expect(plane.workItems[0]?.state).toBe('st-backlog');
		expect(plane.calls).not.toContain('setWorkItemState');
	});

	test.each(['st-done', 'st-cancelled'])(
		'новое срабатывание задачи в %s — переоткрытие',
		async (closed) => {
			await incidents.report(firing());
			(plane.workItems[0] as { state: string }).state = closed;
			const next = await incidents.report(firing({ occurrence: T1, at: T1 }));
			expect(next.action).toBe('reopened');
			expect(plane.workItems[0]?.state).toBe('st-backlog');
		},
	);

	test('метка находится по имени и не создаётся заново', async () => {
		plane.labels.set('p-ops', [{ id: 'l-existing', name: 'alert' }]);
		await incidents.report(firing());
		await incidents.report(firing({ key: 'fp2' }));
		expect(plane.workItems.map((w) => w.labels)).toEqual([['l-existing'], ['l-existing']]);
		expect(plane.calls).not.toContain('createLabel');
		expect(plane.calls.filter((c) => c === 'listLabels')).toHaveLength(1);
	});

	test('неизвестное состояние считается открытым', async () => {
		await incidents.report(firing());
		(plane.workItems[0] as { state: string }).state = 'st-unknown';
		const next = await incidents.report(firing({ occurrence: T1, at: T1 }));
		expect(next.action).toBe('commented');
		expect(plane.calls).not.toContain('setWorkItemState');
	});

	test('деплой: метка deploy-failed и приоритет из сигнала', async () => {
		const result = await incidents.report(deployFiring('dpl_1'));
		expect(plane.workItems).toHaveLength(1);
		const item = plane.workItems[0];
		expect(item?.priority).toBe('high');
		const deployFailedLabel = plane.labels.get('p-ops')?.find((l) => l.name === 'deploy-failed');
		expect(deployFailedLabel).toBeDefined();
		expect(item?.labels).toStrictEqual([deployFailedLabel!.id]);
	});
});

describe('восстановление', () => {
	test('пишется один раз', async () => {
		await incidents.report(firing());
		expect((await incidents.report(resolved())).action).toBe('commented');
		expect((await incidents.report(resolved())).action).toBe('noop');
		expect(plane.comments.map((c) => [c.external_id, c.comment_html])).toEqual([
			['fp1:2026-10-06T10:00:00Z:firing', '<p>Сработал</p>'],
			['fp1:2026-10-06T10:00:00Z:resolved', '<p>Погас</p>'],
		]);
	});

	test('без задачи — ничего', async () => {
		expect(await incidents.report(resolved())).toEqual({ action: 'noop', workItemId: null });
		expect(plane.workItems).toHaveLength(0);
		expect(plane.calls).not.toContain('createComment');
	});

	test('Vercel: срабатывание выводится из маркеров, второй успех подряд — ничего', async () => {
		await incidents.report(deployFiring('dpl_1'));
		expect((await incidents.report(deployResolved())).action).toBe('commented');
		expect((await incidents.report(deployResolved())).action).toBe('noop');
		expect(plane.comments.map((c) => c.external_id)).toEqual([
			`${DEPLOY_KEY}:dpl_1:firing`,
			`${DEPLOY_KEY}:dpl_1:resolved`,
		]);
	});

	test('Vercel: берётся самое позднее по created_at срабатывание, а не порядок списка', async () => {
		const item = plane.seedWorkItem('p-ops', {
			external_id: DEPLOY_KEY,
			external_source: 'vercel',
		});
		plane.seedComment(item.id, `${DEPLOY_KEY}:dpl_1:firing`, '2026-10-06T10:00:00Z');
		plane.seedComment(item.id, `${DEPLOY_KEY}:dpl_3:firing`, '2026-10-06T12:00:00Z');
		plane.seedComment(item.id, `${DEPLOY_KEY}:dpl_2:firing`, '2026-10-06T11:00:00Z');
		plane.seedComment(item.id, `${DEPLOY_KEY}:dpl_1:resolved`, '2026-10-06T10:30:00Z');
		plane.seedComment(item.id, `${DEPLOY_KEY}:dpl_2:resolved`, '2026-10-06T11:30:00Z');
		plane.seedComment(item.id, null, '2026-10-06T13:00:00Z');
		expect((await incidents.report(deployResolved())).action).toBe('commented');
		expect(plane.commentsOf(item.id).at(-1)?.external_id).toBe(`${DEPLOY_KEY}:dpl_3:resolved`);
	});

	test('Vercel: маркеров нет — ничего', async () => {
		plane.seedWorkItem('p-ops', { external_id: DEPLOY_KEY, external_source: 'vercel' });
		expect((await incidents.report(deployResolved())).action).toBe('noop');
		expect(plane.calls).not.toContain('createComment');
	});

	test('Vercel: последнее срабатывание уже разрешено — маркер восстановления не отправляется вовсе', async () => {
		const { workItemId } = await incidents.report(deployFiring('dpl_1'));
		await incidents.report(deployResolved());
		const posts = () => plane.calls.filter((call) => call === 'createComment').length;
		const before = posts();
		// Without the short-circuit Plane would answer 409 and the action would still read noop.
		expect(await incidents.report(deployResolved())).toEqual({ action: 'noop', workItemId });
		expect(posts()).toBe(before);
	});
});

describe('архивная задача (проверка дубля её видит, чтение по id — 404)', () => {
	const unarchives = () => plane.calls.filter((call) => call === 'unarchiveWorkItem').length;

	async function archivedIncident(): Promise<string> {
		const { workItemId } = await incidents.report(firing());
		const id = workItemId as string;
		(plane.workItems[0] as { state: string }).state = 'st-done';
		await plane.archiveWorkItem('p-ops', id);
		return id;
	}

	test('срабатывание по архивной закрытой задаче: разархивирована, в состоянии по умолчанию, маркер, reopened', async () => {
		const id = await archivedIncident();
		const next = await incidents.report(firing({ occurrence: T1, at: T1 }));
		expect(next).toEqual({ action: 'reopened', workItemId: id });
		expect(plane.archived.has(id)).toBe(false);
		expect(plane.workItems).toHaveLength(1);
		expect(plane.workItems[0]?.state).toBe('st-backlog');
		expect(plane.commentsOf(id).map((c) => c.external_id)).toEqual([
			'fp1:2026-10-06T10:00:00Z:firing',
			'fp1:2026-10-06T11:00:00Z:firing',
		]);
		expect(unarchives()).toBe(1);
	});

	test('повторная доставка того же срабатывания после разархивации — noop, без второго маркера', async () => {
		const id = await archivedIncident();
		await incidents.report(firing({ occurrence: T1, at: T1 }));
		const again = await incidents.report(firing({ occurrence: T1, at: T1 }));
		expect(again).toEqual({ action: 'noop', workItemId: id });
		expect(plane.comments).toHaveLength(2);
		expect(unarchives()).toBe(1);
	});

	test('ответ потерян после unarchive: повтор доставки доводит до reopened и одного маркера', async () => {
		plane = new LostUnarchiveAckPlane();
		incidents = createIncidentReporter({ plane, projectId: 'p-ops' });
		const id = await archivedIncident();
		(plane as LostUnarchiveAckPlane).loseNextAck = true;
		await expect(incidents.report(firing({ occurrence: T1, at: T1 }))).rejects.toBeInstanceOf(
			PlaneApiError,
		);
		expect(plane.archived.has(id)).toBe(false);
		expect(plane.comments).toHaveLength(1);
		const retry = await incidents.report(firing({ occurrence: T1, at: T1 }));
		expect(retry).toEqual({ action: 'reopened', workItemId: id });
		expect(plane.workItems[0]?.state).toBe('st-backlog');
		expect(plane.commentsOf(id).map((c) => c.external_id)).toEqual([
			'fp1:2026-10-06T10:00:00Z:firing',
			'fp1:2026-10-06T11:00:00Z:firing',
		]);
		expect(unarchives()).toBe(1);
	});

	test('погасание по архивной задаче: не разархивирует; маркер «Погас» или noop, не исключение', async () => {
		// Probe: an archived item takes comments (201), so the marker is written and the item stays archived.
		const id = await archivedIncident();
		expect(await incidents.report(resolved())).toEqual({ action: 'commented', workItemId: id });
		expect(plane.archived.has(id)).toBe(true);
		expect(plane.workItems[0]?.state).toBe('st-done');
		expect(unarchives()).toBe(0);
		expect(plane.commentsOf(id).map((c) => c.external_id)).toEqual([
			'fp1:2026-10-06T10:00:00Z:firing',
			'fp1:2026-10-06T10:00:00Z:resolved',
		]);
	});

	test('открытая неархивная задача: unarchive не вызывается', async () => {
		const { workItemId } = await incidents.report(firing());
		const next = await incidents.report(firing({ occurrence: T1, at: T1 }));
		expect(next).toEqual({ action: 'commented', workItemId });
		expect(plane.calls.filter((call) => call === 'isWorkItemArchived')).toHaveLength(1);
		expect(unarchives()).toBe(0);
	});
});

describe('гонки и сбои', () => {
	test('одновременные одинаковые срабатывания — одна задача и один маркер', async () => {
		const results = await Promise.all([incidents.report(firing()), incidents.report(firing())]);
		expect(results.map((r) => r.action).sort()).toEqual(['created', 'noop']);
		expect(plane.workItems).toHaveLength(1);
		expect(plane.comments).toHaveLength(1);
	});

	test('одновременные разные срабатывания одного ключа — одна задача, два маркера', async () => {
		const results = await Promise.all([
			incidents.report(firing()),
			incidents.report(firing({ occurrence: T1, at: T1 })),
		]);
		expect(results.map((r) => r.action).sort()).toEqual(['commented', 'created']);
		expect(plane.workItems).toHaveLength(1);
		expect(plane.comments).toHaveLength(2);
	});

	test('сбой посреди срабатывания: повтор доводит без дублей', async () => {
		plane.failNext('createComment');
		await expect(incidents.report(firing())).rejects.toBeInstanceOf(PlaneApiError);
		const retry = await incidents.report(firing());
		expect(retry.action).toBe('commented');
		expect(plane.workItems).toHaveLength(1);
		expect(plane.comments).toHaveLength(1);
	});

	test('429 от Plane пробрасывается наружу, очередь ключа не блокируется', async () => {
		plane.failNext('createWorkItem', new PlaneApiError(429, 'POST', '/work-items/'));
		const err = await incidents.report(firing()).catch((e: unknown) => e);
		expect((err as PlaneApiError).status).toBe(429);
		expect((await incidents.report(firing())).action).toBe('created');
	});

	test('сбой переоткрытия: повтор переоткрывает', async () => {
		await incidents.report(firing());
		(plane.workItems[0] as { state: string }).state = 'st-done';
		plane.failNext('setWorkItemState');
		await expect(incidents.report(firing({ occurrence: T1, at: T1 }))).rejects.toBeInstanceOf(
			PlaneApiError,
		);
		const retry = await incidents.report(firing({ occurrence: T1, at: T1 }));
		expect(retry.action).toBe('reopened');
		expect(plane.workItems[0]?.state).toBe('st-backlog');
		expect(plane.comments).toHaveLength(2);
	});

	test('сбой чтения задачи кроме 404 (429) пробрасывается: маркер не пишется, задача не переоткрыта', async () => {
		const first = await incidents.report(firing());
		const id = first.workItemId as string;
		(plane.workItems[0] as { state: string }).state = 'st-done';
		plane.failNext('getWorkItem', new PlaneApiError(429, 'GET', `/work-items/${id}/`));
		const err = await incidents.report(firing({ occurrence: T1, at: T1 })).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PlaneApiError);
		expect((err as PlaneApiError).status).toBe(429);
		expect(plane.comments).toHaveLength(1);
		expect(plane.workItems[0]?.state).toBe('st-done');
	});

	test('у проекта нет состояния по умолчанию: переоткрытие бросает, маркер не пишется', async () => {
		plane = new NoDefaultStatePlane();
		incidents = createIncidentReporter({ plane, projectId: 'p-ops' });
		await incidents.report(firing());
		(plane.workItems[0] as { state: string }).state = 'st-done';
		await expect(incidents.report(firing({ occurrence: T1, at: T1 }))).rejects.toThrow(
			'Plane project p-ops has no default state',
		);
		expect(plane.comments).toHaveLength(1);
		expect(plane.workItems[0]?.state).toBe('st-done');
	});

	test('потерянный ответ на маркер: повтор — noop, задача уже переоткрыта', async () => {
		plane = new LostAckPlane();
		incidents = createIncidentReporter({ plane, projectId: 'p-ops' });
		await incidents.report(firing());
		(plane.workItems[0] as { state: string }).state = 'st-done';
		(plane as LostAckPlane).loseNextCommentAck = true;
		await expect(incidents.report(firing({ occurrence: T1, at: T1 }))).rejects.toBeInstanceOf(
			PlaneApiError,
		);
		const retry = await incidents.report(firing({ occurrence: T1, at: T1 }));
		expect(retry.action).toBe('noop');
		expect(plane.workItems[0]?.state).toBe('st-backlog');
		expect(plane.comments).toHaveLength(2);
	});
});
