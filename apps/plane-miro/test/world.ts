import { createHmac } from 'node:crypto';

import { createApi } from '../src/api.ts';
import type { Tenant } from '../src/config.ts';
import type { LogEntry } from '../src/log.ts';
import { createRuntime } from '../src/runtime.ts';
import { Store } from '../src/store.ts';
import { configOf } from './config-fixture.ts';
import { FakeMiro } from './fake-miro.ts';
import { FakePlane } from './fake-plane.ts';

export const BOARD = 'uXjVb1=';
export const NOW_SEC = 1_000_000;
/** Names of the MiroApi methods that change the board. */
export const MIRO_WRITES = ['createAppCard', 'updateAppCard', 'reattachConnector', 'deleteItem'];

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

/** A signed Miro id token; `over` replaces claims, `secret` the signing key. */
export function jwt(over: Record<string, unknown> = {}, secret = 'miro-sec'): string {
	const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
		iss: 'miro',
		sub: '3458764500000000099',
		exp: NOW_SEC + 600,
		team: '3458764500000000001',
		user: '42',
		...over,
	})}`;
	return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/**
 * One tenant with FakePlane, FakeMiro, an in-memory Store and the real runtime and API on top.
 * Board `uXjVb1=` ("Доска") holds frame 77 ("Фрейм") with stickers 101 and 102 inside, and connector c1 101 → 102.
 * Project p1 (LAB) is visible; p-hidden is hidden by the tenant config, p-arch is archived.
 */
export function world(over: Partial<Tenant> = {}) {
	const base = configOf();
	const tenant: Tenant = {
		...(base.tenants[0] as Tenant),
		hiddenProjects: ['p-hidden'],
		...over,
	};
	const config = { ...base, tenants: [tenant] };
	const plane = new FakePlane();
	plane.projects = [
		{ id: 'p1', identifier: 'LAB', name: 'Лаборатория', archived: false },
		{ id: 'p-hidden', identifier: 'HID', name: 'Скрытый', archived: false },
		{ id: 'p-arch', identifier: 'OLD', name: 'Архив', archived: true },
	];
	plane.states.set('p1', [
		{ id: 's-backlog', name: 'Backlog', group: 'backlog' },
		{ id: 's-started', name: 'In Progress', group: 'started' },
		{ id: 's-odd', name: 'Особый', group: 'weird' },
	]);
	plane.members = [
		{ id: 'u1', displayName: 'Аня', avatarUrl: null },
		{ id: 'u2', displayName: 'Борис', avatarUrl: null },
	];
	const miro = new FakeMiro();
	const board = miro.addBoard(BOARD, 'Доска');
	board.items.set('77', frame('77', 'Фрейм'));
	board.items.set('101', sticky('101', '<p>Первый стикер</p>', 10, 20));
	board.items.set('102', sticky('102', '<p>Второй</p><p>стикер</p>', 300, 20));
	board.connectors.push(
		{ id: 'c1', startItemId: '101', endItemId: '102' },
		{ id: 'c3', startItemId: '500', endItemId: '501' },
	);
	const store = new Store(':memory:');
	const logs: LogEntry[] = [];
	const log = (e: LogEntry) => logs.push(e);
	const rt = createRuntime(tenant, { planeUrl: config.planeUrl, store, plane, miro });
	const api = createApi({
		config,
		runtimes: new Map([[tenant.id, rt]]),
		store,
		log,
		nowSec: () => NOW_SEC,
	});
	const call = (
		method: string,
		path: string,
		opts: {
			body?: unknown;
			raw?: string;
			token?: string | null;
			headers?: Record<string, string>;
		} = {},
	) => {
		const token = opts.token === undefined ? jwt() : opts.token;
		return api(
			new Request(`http://x${path}`, {
				method,
				headers: {
					...(token === null ? {} : { authorization: `Bearer ${token}` }),
					...opts.headers,
				},
				...(opts.raw !== undefined
					? { body: opts.raw }
					: opts.body !== undefined
						? { body: JSON.stringify(opts.body) }
						: {}),
			}),
			new URL(`http://x${path}`),
		);
	};
	return { tenant, config, plane, miro, board, store, logs, log, rt, api, call };
}

export function sticky(
	id: string,
	html: string,
	x: number,
	y: number,
	parentId: string | null = '77',
) {
	return { id, type: 'sticky_note', html, x, y, width: 200, height: 200, parentId };
}

export function frame(id: string, title: string) {
	return { id, type: 'frame', html: title, x: 0, y: 0, width: 800, height: 600, parentId: null };
}

/** A work item seeded straight into FakePlane. */
export function seedItem(
	plane: FakePlane,
	id: string,
	over: Partial<{
		projectId: string;
		sequenceId: number;
		name: string;
		stateId: string;
		assignees: string[];
		descriptionHtml: string | null;
	}> = {},
): void {
	plane.items.set(id, {
		id,
		projectId: 'p1',
		sequenceId: 7,
		name: 'Существующая',
		stateId: 's-backlog',
		assignees: [],
		descriptionHtml: '<p>Было</p>',
		...over,
	});
}
