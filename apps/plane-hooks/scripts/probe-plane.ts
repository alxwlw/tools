#!/usr/bin/env bun
/**
 * Contract probe for the Plane API calls plane-hooks relies on.
 *
 * Creates one throwaway work item (and one label) in PLANE_HOOKS_PROJECT_ID,
 * one throwaway release in the workspace,
 * exercises every call, prints «вызов — ожидание — факт» and deletes what it
 * created. Exit 0 only when every row matches; 1 on any mismatch; 2 on missing env.
 *
 * It needs a real API token, so the owner runs it.
 */

import type { ReleaseDraft } from '../src/deploy-note.ts';
import { changelogHtml } from '../src/release.ts';

// A module, so top-level await type-checks.
export {};

// Changelog markup of the real shape (<h3>/<ul>/<li>/<a href>/<code>); the <script> must come out escaped.
const probeDraft: ReleaseDraft = {
	repository: 'example-org/app',
	sha: '0123456789abcdef0123456789abcdef01234567',
	at: new Date().toISOString(),
	runUrl: 'https://github.com/example-org/app/actions/runs/1',
	commits: [
		{
			sha: '0123456789abcdef0123456789abcdef01234567',
			message: 'probe <script>alert(1)</script>\n\nbody',
		},
	],
};

const REQUIRED = [
	'PLANE_HOOKS_PLANE_URL',
	'PLANE_HOOKS_WORKSPACE',
	'PLANE_HOOKS_PROJECT_ID',
	'PLANE_HOOKS_PLANE_API_KEY',
] as const;

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
	console.error(`missing env: ${missing.join(', ')}`);
	process.exit(2);
}

const env = Object.fromEntries(
	REQUIRED.map((name) => [name, process.env[name] as string]),
) as Record<(typeof REQUIRED)[number], string>;
const base = `${env.PLANE_HOOKS_PLANE_URL.replace(/\/+$/, '')}/api/v1/workspaces/${env.PLANE_HOOKS_WORKSPACE}`;
const project = `${base}/projects/${env.PLANE_HOOKS_PROJECT_ID}`;
const SOURCE = 'plane-hooks-probe';
const tag = `probe-${crypto.randomUUID()}`;

type Reply = { status: number; body: any };

async function call(method: string, url: string, body?: unknown): Promise<Reply> {
	const res = await fetch(url, {
		method,
		headers: { 'X-API-Key': env.PLANE_HOOKS_PLANE_API_KEY, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	});
	const text = await res.text();
	let parsed: unknown = text;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		// keep the raw text: a non-JSON reply is itself a finding
	}
	return { status: res.status, body: parsed };
}

/** List endpoints answer either a bare array or a page `{ results, next_cursor, … }`. */
function rowsOf(body: any): any[] {
	if (Array.isArray(body)) return body;
	if (Array.isArray(body?.results)) return body.results;
	return [];
}

function shapeOf(body: any): string {
	return Array.isArray(body) ? 'массив' : Array.isArray(body?.results) ? 'страница' : 'иное';
}

const rows: { '№': string; вызов: string; ожидание: string; факт: string; '': string }[] = [];
let failed = 0;
function row(n: string, what: string, expected: string, actual: string, ok: boolean): void {
	if (!ok) failed++;
	rows.push({ '№': n, вызов: what, ожидание: expected, факт: actual, '': ok ? '✓' : '✗' });
}

let itemId: string | null = null;
let labelId: string | null = null;
let releaseId: string | null = null;

try {
	const projects = await call('GET', `${base}/projects/`);
	const mine = rowsOf(projects.body).find((p) => p?.id === env.PLANE_HOOKS_PROJECT_ID);
	row(
		'8',
		'GET /projects/',
		'200, проект с identifier',
		`${projects.status}, ${shapeOf(projects.body)}, identifier=${mine?.identifier ?? '—'}`,
		projects.status === 200 && typeof mine?.identifier === 'string',
	);

	const states = await call('GET', `${project}/states/`);
	const stateRows = rowsOf(states.body);
	const defaultState = stateRows.find((s) => s?.default === true);
	const doneState = stateRows.find((s) => s?.group === 'completed');
	row(
		'9',
		'GET /states/',
		'200, есть default и группа completed',
		`${states.status}, ${shapeOf(states.body)}, default=${defaultState?.name ?? '—'}, completed=${doneState?.name ?? '—'}`,
		states.status === 200 && !!defaultState && !!doneState,
	);

	const labels = await call('GET', `${project}/labels/`);
	row(
		'9',
		'GET /labels/',
		'200, список',
		`${labels.status}, ${shapeOf(labels.body)}`,
		labels.status === 200,
	);
	const newLabel = await call('POST', `${project}/labels/`, { name: tag, color: '#888888' });
	labelId = typeof newLabel.body?.id === 'string' ? newLabel.body.id : null;
	row(
		'9',
		'POST /labels/',
		'201 {id}',
		`${newLabel.status}`,
		newLabel.status === 201 && labelId !== null,
	);

	const create = await call('POST', `${project}/work-items/`, {
		name: `plane-hooks probe ${tag}`,
		priority: 'none',
		external_id: tag,
		external_source: SOURCE,
	});
	itemId = typeof create.body?.id === 'string' ? create.body.id : null;
	const sequence = create.body?.sequence_id;
	row(
		'1',
		'POST /work-items/ с external_id',
		'201 {id, sequence_id}',
		`${create.status}, sequence_id=${sequence ?? '—'}`,
		create.status === 201 && itemId !== null && typeof sequence === 'number',
	);

	const duplicate = await call('POST', `${project}/work-items/`, {
		name: 'plane-hooks probe duplicate',
		external_id: tag,
		external_source: SOURCE,
	});
	row(
		'1',
		'POST /work-items/ повтор',
		'409, id = id первой',
		`${duplicate.status}, id ${duplicate.body?.id === itemId ? 'совпал' : 'не совпал'}`,
		duplicate.status === 409 && duplicate.body?.id === itemId,
	);

	const byExternal = await call(
		'GET',
		`${project}/work-items/?${new URLSearchParams({ external_id: tag, external_source: SOURCE })}`,
	);
	row(
		'2',
		'GET /work-items/?external_id=…',
		'200, id = id задачи',
		`${byExternal.status}`,
		byExternal.status === 200 && byExternal.body?.id === itemId,
	);
	const byExternalMissing = await call(
		'GET',
		`${project}/work-items/?${new URLSearchParams({ external_id: `${tag}-none`, external_source: SOURCE })}`,
	);
	row(
		'2',
		'GET ?external_id=несуществующий',
		'404',
		`${byExternalMissing.status}`,
		byExternalMissing.status === 404,
	);

	const item = await call('GET', `${project}/work-items/${itemId}/`);
	row(
		'3',
		'GET /work-items/{id}/',
		'200, state — строка-uuid',
		`${item.status}, state: ${typeof item.body?.state}`,
		item.status === 200 && typeof item.body?.state === 'string',
	);

	const close = await call('PATCH', `${project}/work-items/${itemId}/`, { state: doneState?.id });
	row('4', 'PATCH state → completed', '200', `${close.status}`, close.status === 200);
	const reopen = await call('PATCH', `${project}/work-items/${itemId}/`, {
		state: defaultState?.id,
	});
	row('4', 'PATCH state → default', '200', `${reopen.status}`, reopen.status === 200);

	const comment = {
		comment_html: '<p>plane-hooks probe</p>',
		external_id: `${tag}:c`,
		external_source: SOURCE,
	};
	const c1 = await call('POST', `${project}/work-items/${itemId}/comments/`, comment);
	row(
		'5',
		'POST /comments/ с external_id',
		'201 {id}',
		`${c1.status}`,
		c1.status === 201 && typeof c1.body?.id === 'string',
	);
	const c2 = await call('POST', `${project}/work-items/${itemId}/comments/`, comment);
	row(
		'5',
		'POST /comments/ повтор',
		'409, id = id первого',
		`${c2.status}, id ${c2.body?.id === c1.body?.id ? 'совпал' : 'не совпал'}`,
		c2.status === 409 && c2.body?.id === c1.body?.id,
	);

	const comments = await call('GET', `${project}/work-items/${itemId}/comments/`);
	const listed = rowsOf(comments.body).find((c) => c?.external_id === `${tag}:c`);
	row(
		'6',
		'GET /comments/',
		'200, у комментария external_id и created_at',
		`${comments.status}, ${shapeOf(comments.body)}, next_cursor: ${typeof comments.body?.next_cursor}`,
		comments.status === 200 && typeof listed?.created_at === 'string',
	);

	const identifier = mine?.identifier ?? 'UNKNOWN';
	const byKey = await call('GET', `${base}/work-items/${identifier}-${sequence}/`);
	row(
		'7',
		'GET /work-items/{KEY}-{N}/',
		'200, id и project совпали',
		`${byKey.status}, project: ${typeof byKey.body?.project}`,
		byKey.status === 200 &&
			byKey.body?.id === itemId &&
			byKey.body?.project === env.PLANE_HOOKS_PROJECT_ID,
	);
	const byKeyMissing = await call('GET', `${base}/work-items/${identifier}-999999/`);
	row(
		'7',
		'GET /work-items/{KEY}-999999/',
		'404',
		`${byKeyMissing.status}`,
		byKeyMissing.status === 404,
	);

	const releaseTag = `${tag}-release`;
	const newRelease = await call('POST', `${base}/releases/`, {
		name: `plane-hooks probe ${tag}`,
		status: 'released',
		release_date: new Date().toISOString().slice(0, 10),
		external_source: SOURCE,
		external_id: releaseTag,
	});
	releaseId = typeof newRelease.body?.id === 'string' ? newRelease.body.id : null;
	row(
		'10',
		'POST /releases/ с external_id',
		'201 {id}',
		`${newRelease.status}`,
		newRelease.status === 201 && releaseId !== null,
	);

	// For the record only: plane-hooks looks a release up before creating it, whatever Plane answers here.
	const duplicateRelease = await call('POST', `${base}/releases/`, {
		name: 'plane-hooks probe duplicate',
		external_source: SOURCE,
		external_id: releaseTag,
	});
	const duplicateId =
		typeof duplicateRelease.body?.id === 'string' ? duplicateRelease.body.id : null;
	row(
		'10',
		'POST /releases/ повтор (сведения)',
		'409 — Plane держит уникальность; 201 — нет',
		`${duplicateRelease.status}, id ${duplicateId === releaseId ? 'совпал' : 'другой'}`,
		true,
	);
	if (duplicateId !== null && duplicateId !== releaseId) {
		const del = await call('DELETE', `${base}/releases/${duplicateId}/`);
		row('—', 'DELETE /releases/{dup}/ (уборка)', '204', `${del.status}`, del.status === 204);
	}

	const releases = await call('GET', `${base}/releases/?per_page=100`);
	const listedRelease = rowsOf(releases.body).find((r) => r?.id === releaseId);
	row(
		'11',
		'GET /releases/',
		'200, у релиза external_source и external_id',
		`${releases.status}, ${shapeOf(releases.body)}, external_id: ${listedRelease?.external_id ?? '—'}`,
		releases.status === 200 &&
			listedRelease?.external_source === SOURCE &&
			listedRelease?.external_id === releaseTag,
	);

	const changelog = await call('PATCH', `${base}/releases/${releaseId}/changelog/`, {
		description_html: changelogHtml(probeDraft, [{ key: 'OPS-1', workItemId: 'probe' }]),
	});
	row(
		'12',
		'PATCH /releases/{id}/changelog/',
		'200',
		`${changelog.status}`,
		changelog.status === 200,
	);

	const attach = await call('POST', `${base}/releases/${releaseId}/work-items/`, {
		work_item_ids: [itemId],
	});
	row(
		'13',
		'POST /releases/{id}/work-items/',
		'2xx',
		`${attach.status}`,
		attach.status >= 200 && attach.status < 300,
	);
	const attachAgain = await call('POST', `${base}/releases/${releaseId}/work-items/`, {
		work_item_ids: [itemId],
	});
	row(
		'13',
		'POST /releases/{id}/work-items/ повтор',
		'2xx (уже привязана — не ошибка)',
		`${attachAgain.status}`,
		attachAgain.status >= 200 && attachAgain.status < 300,
	);
} catch (err) {
	row(
		'—',
		'сеть / разбор',
		'ответ Plane',
		err instanceof Error ? `${err.name}: ${err.message}` : String(err),
		false,
	);
} finally {
	if (releaseId) {
		const del = await call('DELETE', `${base}/releases/${releaseId}/`).catch(() => ({
			status: 0,
			body: null,
		}));
		row('—', 'DELETE /releases/{id}/ (уборка)', '204', `${del.status}`, del.status === 204);
	}
	if (itemId) {
		const del = await call('DELETE', `${project}/work-items/${itemId}/`).catch(() => ({
			status: 0,
			body: null,
		}));
		row('—', 'DELETE /work-items/{id}/ (уборка)', '204', `${del.status}`, del.status === 204);
	}
	if (labelId) {
		const del = await call('DELETE', `${project}/labels/${labelId}/`).catch(() => ({
			status: 0,
			body: null,
		}));
		row('—', 'DELETE /labels/{id}/ (уборка)', '204', `${del.status}`, del.status === 204);
	}
}

console.table(rows);
console.log(failed === 0 ? 'контракт подтверждён' : `расхождений: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
