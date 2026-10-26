import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/probe.ts';

const ENV = { PROBE_MIRO_TOKEN: 'tok', PROBE_MIRO_BOARD_ID: 'fakeboard=' };
const B = '/v2/boards/fakeboard%3D';

type Route = (method: string, path: string) => { status?: number; body: unknown } | undefined;

// Answers only the paths of the Miro spec and counts every request; anything else is a 404.
function world(routes: Route) {
	const calls: string[] = [];
	const fetchFn = (url: string, init: RequestInit): Promise<Response> => {
		const path = url.replace('https://api.miro.com', '');
		const method = init.method ?? 'GET';
		calls.push(`${method} ${path}`);
		const hit = routes(method, path);
		return Promise.resolve(
			new Response(JSON.stringify(hit?.body ?? {}), { status: hit?.status ?? 404 }),
		);
	};
	return { calls, fetchFn };
}

const sticker = { id: 's1', type: 'sticky_note', position: { x: 1, y: 2, origin: 'center' } };
const connector = { id: 'c1', startItem: { id: 's1' }, endItem: { id: 's2' } };
const other = { id: 'c9', startItem: { id: 's7' }, endItem: { id: 's8' } };

const happy: Route = (m, p) => {
	if (m === 'GET' && p === `${B}/items/s1`) return { status: 200, body: sticker };
	if (m === 'GET' && p === `${B}/items/s1/tags`) return { status: 200, body: { data: [] } };
	if (m === 'GET' && p === `${B}/connectors?limit=50`) {
		return { status: 200, body: { data: [other], cursor: 'next' } };
	}
	if (m === 'GET' && p === `${B}/connectors?limit=50&cursor=next`) {
		return { status: 200, body: { data: [connector] } };
	}
	if (m === 'POST' && p === `${B}/app_cards`) return { status: 201, body: { id: 'card1' } };
	if (m === 'PATCH' && p === `${B}/connectors/c1`) return { status: 200, body: { id: 'c1' } };
	if (m === 'DELETE' && p === `${B}/items/s1`) return { status: 204, body: null };
	return undefined;
};

let out = '';
let logs: string[] = [];
beforeEach(() => {
	out = mkdtempSync(join(tmpdir(), 'probe-'));
	logs = [];
	spyOn(console, 'log').mockImplementation((l: string) => void logs.push(l));
	spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
	(console.log as unknown as { mockRestore(): void }).mockRestore();
	(console.error as unknown as { mockRestore(): void }).mockRestore();
});

test('miro-replace: коннектор берётся из списка доски (с курсором) и переносится на карточку до удаления стикера', async () => {
	const w = world(happy);
	expect(await main(['miro-replace', 's1', '--out', out], ENV, w.fetchFn)).toBe(0);
	expect(w.calls).toEqual([
		`GET ${B}/items/s1`,
		`GET ${B}/items/s1/tags`,
		`GET ${B}/connectors?limit=50`,
		`GET ${B}/connectors?limit=50&cursor=next`,
		`POST ${B}/app_cards`,
		`PATCH ${B}/connectors/c1`,
		`DELETE ${B}/items/s1`,
	]);
});

test('miro-replace: позиция карточки — только x, y', async () => {
	let posted: unknown;
	const w = world(happy);
	const f = (url: string, init: RequestInit) => {
		if (init.method === 'POST') posted = JSON.parse(init.body as string);
		return w.fetchFn(url, init);
	};
	await main(['miro-replace', 's1', '--out', out], ENV, f);
	expect((posted as { position: unknown }).position).toEqual({ x: 1, y: 2 });
	expect(posted).not.toHaveProperty('parent');
});

test('miro-replace: путь коннекторов уровня элемента (нет в спеке) → код 1, ни одного DELETE', async () => {
	const w = world((m, p) =>
		p.includes('/connectors') && !p.includes('/items/') ? undefined : happy(m, p),
	);
	expect(await main(['miro-replace', 's1', '--out', out], ENV, w.fetchFn)).toBe(1);
	expect(w.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
	expect(w.calls.some((c) => c.startsWith('POST'))).toBe(false);
});

test('miro-replace: 404 на PATCH коннектора → код 1, стикер не удалён', async () => {
	const w = world((m, p) => (m === 'PATCH' ? { status: 404, body: {} } : happy(m, p)));
	expect(await main(['miro-replace', 's1', '--out', out], ENV, w.fetchFn)).toBe(1);
	expect(w.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
});

test('miro-replace: 404 на GET стикера → код 1, карточка не создана', async () => {
	const w = world((m, p) => (p === `${B}/items/s1` ? { status: 404, body: {} } : happy(m, p)));
	expect(await main(['miro-replace', 's1', '--out', out], ENV, w.fetchFn)).toBe(1);
	expect(w.calls.some((c) => c.startsWith('POST') || c.startsWith('DELETE'))).toBe(false);
});

test('miro-replace: не sticky_note → код 1, ни POST, ни DELETE', async () => {
	const w = world((m, p) =>
		p === `${B}/items/s1` ? { status: 200, body: { ...sticker, type: 'shape' } } : happy(m, p),
	);
	expect(await main(['miro-replace', 's1', '--out', out], ENV, w.fetchFn)).toBe(1);
	expect(w.calls.some((c) => c.startsWith('POST') || c.startsWith('DELETE'))).toBe(false);
});

test('miro-replace: родитель-фрейм стикера уходит в parent карточки', async () => {
	let posted: { parent?: unknown } = {};
	const w = world((m, p) =>
		p === `${B}/items/s1`
			? { status: 200, body: { ...sticker, parent: { id: 'f1', links: {} } } }
			: happy(m, p),
	);
	const f = (url: string, init: RequestInit) => {
		if (init.method === 'POST') posted = JSON.parse(init.body as string);
		return w.fetchFn(url, init);
	};
	await main(['miro-replace', 's1', '--out', out], ENV, f);
	expect(posted.parent).toEqual({ id: 'f1' });
});

test('miro-access: доски берутся из --board, файлы по номеру; без --board — код 1', async () => {
	const w = world((_m, p) =>
		p === '/v2/boards/a%3D' ? { status: 200, body: { id: 'a' } } : undefined,
	);
	expect(
		await main(['miro-access', '--board', 'a=', '--board', 'b=', '--out', out], ENV, w.fetchFn),
	).toBe(0);
	expect(w.calls).toEqual(['GET /v2/boards/a%3D', 'GET /v2/boards/b%3D']);
	expect(readdirSync(out).sort()).toEqual(['miro-access-board-1.json', 'miro-access-board-2.json']);
	expect(await main(['miro-access', '--out', out], ENV, w.fetchFn)).toBe(1);
});

test('--step переименовывает файл plane-read: два запуска — два файла', async () => {
	const env = {
		PROBE_PLANE_URL: 'https://plane.example.com',
		PROBE_PLANE_CLIENT_ID: 'c',
		PROBE_PLANE_CLIENT_SECRET: 's',
		PROBE_LIQ_WORKSPACE: 'ws',
		PROBE_LIQ_INSTALLATION_ID: 'i',
	};
	const fetchFn = (url: string): Promise<Response> =>
		Promise.resolve(
			new Response(
				JSON.stringify(url.endsWith('/auth/o/token/') ? { access_token: 't' } : { id: 'x' }),
			),
		);
	await main(['plane-read', 'p', 'a', '--step', 'read-a', '--out', out], env, fetchFn);
	await main(['plane-read', 'p', 'b', '--step', 'read-b', '--out', out], env, fetchFn);
	expect(readdirSync(out).sort()).toEqual(['plane-read-read-a.json', 'plane-read-read-b.json']);
	expect(existsSync(join(out, 'plane-read-read.json'))).toBe(false);
	expect(logs.join('\n')).not.toContain('"t"');
});

test('miro-replace: PATCH переводит нужный конец коннектора на карточку (start и end)', async () => {
	const patched: Record<string, unknown> = {};
	const ends = { id: 'c2', startItem: { id: 's3' }, endItem: { id: 's1' } };
	const w = world((m, p) => {
		if (p === `${B}/connectors?limit=50`) return { status: 200, body: { data: [connector, ends] } };
		if (m === 'PATCH') return { status: 200, body: {} };
		return happy(m, p);
	});
	const f = (url: string, init: RequestInit) => {
		if (init.method === 'PATCH')
			patched[url.split('/').pop() as string] = JSON.parse(init.body as string);
		return w.fetchFn(url, init);
	};
	expect(await main(['miro-replace', 's1', '--out', out], ENV, f)).toBe(0);
	expect(patched).toEqual({ c1: { startItem: { id: 'card1' } }, c2: { endItem: { id: 'card1' } } });
});

test('miro-replace: карточка не создана (500 или без id) → код 1, стикер не удалён', async () => {
	for (const reply of [
		{ status: 500, body: { id: 'card1' } },
		{ status: 201, body: {} },
	]) {
		const w = world((m, p) => (m === 'POST' ? reply : happy(m, p)));
		expect(await main(['miro-replace', 's1', '--out', out], ENV, w.fetchFn)).toBe(1);
		expect(w.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
	}
});
