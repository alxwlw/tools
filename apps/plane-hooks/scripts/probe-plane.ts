#!/usr/bin/env bun
/**
 * Contract probe for the Plane API calls plane-hooks relies on.
 *
 * Authenticates as the "plane-hooks" Plane App bot (client_credentials token of a workspace
 * installation), the way the service does. Creates two throwaway work items (one of them archived and unarchived on the
 * way) and one label in PLANE_HOOKS_PROJECT_ID, one throwaway release in the
 * workspace, exercises every call, prints «вызов — ожидание — факт» and deletes
 * what it created. Three sections — work items, archive, releases — run
 * independently: a section that throws records one ✗ row and the next one still
 * runs. A workspace whose plan has no releases (402) skips the release section.
 * Exit 0 only when every row matches; 1 on any mismatch; 2 on missing env.
 *
 * It needs a real API token, so the owner runs it.
 */

import { botTokenAuth } from '@alxwlw/plane-app';

import type { ReleaseDraft } from '../src/deploy-note.ts';
import { PLANE_HOOKS_SCOPES } from '../src/plane.ts';
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
	'PLANE_HOOKS_PROBE_CLIENT_ID',
	'PLANE_HOOKS_PROBE_CLIENT_SECRET',
	'PLANE_HOOKS_PROBE_INSTALLATION_ID',
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

const auth = botTokenAuth({
	planeUrl: env.PLANE_HOOKS_PLANE_URL,
	clientId: env.PLANE_HOOKS_PROBE_CLIENT_ID,
	clientSecret: env.PLANE_HOOKS_PROBE_CLIENT_SECRET,
	appInstallationId: env.PLANE_HOOKS_PROBE_INSTALLATION_ID,
	scopes: PLANE_HOOKS_SCOPES,
});

type Reply = { status: number; body: any };

async function call(method: string, url: string, body?: unknown): Promise<Reply> {
	const res = await fetch(url, {
		method,
		headers: { ...(await auth.headers()), 'Content-Type': 'application/json' },
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
let archivedItemId: string | null = null;
/** A second work item, should Plane not dedupe an archived external_id. */
let strayItemId: string | null = null;
let doneStateId: string | undefined;

/** Runs one section; a throw becomes one ✗ row, so the next section still runs. */
async function section(name: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (err) {
		row(
			'—',
			`${name}: сеть / разбор`,
			'ответ Plane',
			err instanceof Error ? `${err.name}: ${err.message}` : String(err),
			false,
		);
	}
}

const ARCHIVED_AT = 'archived_at';
function archivedAtOf(body: any): string {
	if (body === null || typeof body !== 'object' || !(ARCHIVED_AT in body)) return 'нет поля';
	return body[ARCHIVED_AT] === null ? 'null' : typeof body[ARCHIVED_AT];
}

async function archive(id: string): Promise<Reply> {
	return call('POST', `${project}/work-items/${id}/archive/`);
}

/**
 * Archive (14): what an archived work item answers to each call plane-hooks makes,
 * and which unarchive path brings it back.
 */
async function archiveSection(doneId: string | undefined): Promise<void> {
	const archTag = `${tag}-archive`;
	const create = await call('POST', `${project}/work-items/`, {
		name: `plane-hooks probe ${archTag}`,
		priority: 'none',
		external_id: archTag,
		external_source: SOURCE,
	});
	archivedItemId = typeof create.body?.id === 'string' ? create.body.id : null;
	row(
		'14',
		'POST /work-items/ (для архива)',
		'201 {id}',
		`${create.status}`,
		create.status === 201 && archivedItemId !== null,
	);
	if (archivedItemId === null) return;
	const id = archivedItemId;
	const detailPath = `${project}/work-items/${id}/`;

	const open = await call('GET', detailPath);
	row(
		'14',
		'GET деталь неархивной',
		'200, archived_at: null',
		`${open.status}, archived_at: ${archivedAtOf(open.body)}`,
		open.status === 200 && archivedAtOf(open.body) === 'null',
	);

	const openArchiveOpen = await archive(id);
	row(
		'14',
		'POST /archive/ в группе backlog',
		'400 (архив только для completed/cancelled)',
		`${openArchiveOpen.status}`,
		openArchiveOpen.status === 400,
	);

	const close = await call('PATCH', detailPath, { state: doneId });
	row('14', 'PATCH state → completed', '200', `${close.status}`, close.status === 200);

	const archived = await archive(id);
	row(
		'14',
		'POST /work-items/{id}/archive/',
		'200, archived_at — строка',
		`${archived.status}, archived_at: ${archivedAtOf(archived.body)}`,
		archived.status === 200 && archivedAtOf(archived.body) === 'string',
	);

	// The rows below pin what test/fake-plane.ts does with an archived item.
	const detail = await call('GET', detailPath);
	row('14', 'архивная: GET деталь', '404', `${detail.status}`, detail.status === 404);

	const archivedDetail = await call('GET', `${project}/archived-work-items/${id}/`);
	row(
		'14',
		'архивная: GET /archived-work-items/{id}/ (сведения)',
		'404 — деталью архив не проверить',
		`${archivedDetail.status}`,
		true,
	);

	const archivedList = await call('GET', `${project}/archived-work-items/?per_page=100`);
	const inList = rowsOf(archivedList.body).find((w) => w?.id === id);
	row(
		'14',
		'архивная: GET /archived-work-items/',
		'200, страница, задача есть по id, archived_at — строка',
		`${archivedList.status}, ${shapeOf(archivedList.body)}, по id: ${inList ? 'есть' : 'нет'}, archived_at: ${archivedAtOf(inList)}`,
		archivedList.status === 200 &&
			shapeOf(archivedList.body) === 'страница' &&
			archivedAtOf(inList) === 'string',
	);

	const comments = await call('GET', `${detailPath}comments/`);
	row(
		'14',
		'архивная: GET /comments/',
		'200',
		`${comments.status}, ${shapeOf(comments.body)}`,
		comments.status === 200,
	);

	const comment = await call('POST', `${detailPath}comments/`, {
		comment_html: '<p>plane-hooks probe archived</p>',
		external_id: `${archTag}:c`,
		external_source: SOURCE,
	});
	row(
		'14',
		'архивная: POST /comments/ с external_id',
		'201 {id}',
		`${comment.status}`,
		comment.status === 201 && typeof comment.body?.id === 'string',
	);

	const duplicate = await call('POST', `${project}/work-items/`, {
		name: 'plane-hooks probe archived duplicate',
		external_id: archTag,
		external_source: SOURCE,
	});
	if (
		duplicate.status === 201 &&
		typeof duplicate.body?.id === 'string' &&
		duplicate.body.id !== id
	)
		strayItemId = duplicate.body.id;
	row(
		'14',
		'архивная: POST /work-items/ повтор external_id',
		'409, id = id архивной',
		`${duplicate.status}, id ${duplicate.body?.id === id ? 'совпал' : 'другой'}`,
		duplicate.status === 409 && duplicate.body?.id === id,
	);

	const byExternal = await call(
		'GET',
		`${project}/work-items/?${new URLSearchParams({ external_id: archTag, external_source: SOURCE })}`,
	);
	row(
		'14',
		'архивная: GET ?external_id=…',
		'200, id = id архивной, archived_at — строка',
		`${byExternal.status}, id ${byExternal.body?.id === id ? 'совпал' : '—'}, archived_at: ${archivedAtOf(byExternal.body)}`,
		byExternal.status === 200 &&
			byExternal.body?.id === id &&
			archivedAtOf(byExternal.body) === 'string',
	);

	// Unarchive: each path variant on a freshly archived item, then the detail must be back with archived_at empty.
	const variants: [string, string, boolean][] = [
		['DELETE /work-items/{id}/unarchive/', `${detailPath}unarchive/`, true],
		['DELETE /work-items/{id}/unarchive', `${detailPath}unarchive`, true],
		[
			'DELETE /archived-work-items/{id}/unarchive/ (сведения)',
			`${project}/archived-work-items/${id}/unarchive/`,
			false,
		],
	];
	for (const [what, url, required] of variants) {
		const state = await call('GET', detailPath);
		if (state.status === 200) {
			const again = await archive(id);
			if (again.status !== 200) {
				row('14', `${what}: повторный архив`, '200', `${again.status}`, false);
				continue;
			}
		}
		const unarchived = await call('DELETE', url);
		const back = await call('GET', detailPath);
		const ok =
			unarchived.status === 204 && back.status === 200 && archivedAtOf(back.body) === 'null';
		row(
			'14',
			what,
			required ? '204, затем деталь 200 с archived_at: null' : 'сведения',
			`${unarchived.status}; деталь ${back.status}, archived_at: ${archivedAtOf(back.body)}`,
			required ? ok : true,
		);
	}

	// The last variant may have left it archived: the path the client uses brings it back.
	await call('DELETE', `${detailPath}unarchive/`);
	const twice = await call('DELETE', `${detailPath}unarchive/`);
	row('14', 'DELETE /unarchive/ неархивной (сведения)', 'сведения', `${twice.status}`, true);
	const finalDetail = await call('GET', detailPath);
	row(
		'14',
		'после unarchive: GET деталь',
		'200, archived_at: null',
		`${finalDetail.status}, archived_at: ${archivedAtOf(finalDetail.body)}`,
		finalDetail.status === 200 && archivedAtOf(finalDetail.body) === 'null',
	);
}

let linkItemId: string | null = null;

/** Calls added for the delivery core: state order, links (twice), comment edit. */
async function planeAppSection(): Promise<void> {
	const states = await call('GET', `${project}/states/`);
	const stateRows = rowsOf(states.body);
	const ordered = stateRows.every(
		(s) => typeof s?.sequence === 'number' && typeof s?.name === 'string',
	);
	row(
		'15',
		'GET /states/: name и sequence',
		'200, у каждого состояния name и числовой sequence',
		`${states.status}, ${stateRows.map((s) => `${s?.name}:${s?.sequence}`).join(', ')}`,
		states.status === 200 && stateRows.length > 0 && ordered,
	);

	const linkTag = `${tag}-links`;
	const create = await call('POST', `${project}/work-items/`, {
		name: `plane-hooks probe ${linkTag}`,
		priority: 'none',
		external_id: linkTag,
		external_source: SOURCE,
	});
	linkItemId = typeof create.body?.id === 'string' ? create.body.id : null;
	row('15', 'POST /work-items/ (для ссылок)', '201 {id}', `${create.status}`, linkItemId !== null);
	if (linkItemId === null) return;
	const itemUrl = `${project}/work-items/${linkItemId}`;

	const link = {
		url: `https://github.com/example-org/app/pull/${Date.now()}`,
		title: 'GitHub: example-org/app#1',
	};
	const first = await call('POST', `${itemUrl}/links/`, link);
	row('15', 'POST /links/', '201', `${first.status}`, first.status === 201);
	const second = await call('POST', `${itemUrl}/links/`, link);
	const listed = rowsOf((await call('GET', `${itemUrl}/links/?per_page=100`)).body);
	row(
		'15',
		'POST /links/ повтор того же URL',
		'400, URL есть в GET /links/',
		`${second.status}, в списке: ${listed.some((l) => l?.url === link.url) ? 'есть' : 'нет'}`,
		second.status === 400 && listed.some((l) => l?.url === link.url),
	);

	const comment = await call('POST', `${itemUrl}/comments/`, {
		comment_html: '<p>до</p>',
		external_id: `${linkTag}:c`,
		external_source: SOURCE,
	});
	const commentId = typeof comment.body?.id === 'string' ? comment.body.id : null;
	row('15', 'POST /comments/', '201 {id}', `${comment.status}`, commentId !== null);
	if (commentId === null) return;
	const patched = await call('PATCH', `${itemUrl}/comments/${commentId}/`, {
		comment_html: '<p>после</p>',
	});
	const listedComments = rowsOf((await call('GET', `${itemUrl}/comments/?per_page=100`)).body);
	const mine = listedComments.find((c) => c?.id === commentId);
	row(
		'15',
		'PATCH /comments/{id}/ comment_html',
		'200, список отдаёт новый текст и external_source',
		`${patched.status}, external_source: ${mine?.external_source ?? '—'}, html: ${mine?.comment_html ?? '—'}`,
		patched.status === 200 &&
			mine?.comment_html === '<p>после</p>' &&
			mine?.external_source === SOURCE,
	);
}

try {
	await section('задачи', async () => {
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
		doneStateId = doneState?.id;
	});

	await section('архив', () => archiveSection(doneStateId));
	await section('Plane App', () => planeAppSection());

	await section('релизы', async () => {
		const releaseTag = `${tag}-release`;
		const newRelease = await call('POST', `${base}/releases/`, {
			name: `plane-hooks probe ${tag}`,
			status: 'released',
			release_date: new Date().toISOString().slice(0, 10),
			external_source: SOURCE,
			external_id: releaseTag,
		});
		releaseId = typeof newRelease.body?.id === 'string' ? newRelease.body.id : null;
		// 402 Payment Required: the workspace plan has no releases (Free). A fact, not a contract break.
		if (newRelease.status === 402) {
			row(
				'10',
				'POST /releases/ с external_id',
				'201 {id}; 402 — тариф без релизов',
				'402, секция релизов пропущена',
				true,
			);
			return;
		}
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
	});
} finally {
	if (releaseId) {
		const del = await call('DELETE', `${base}/releases/${releaseId}/`).catch(() => ({
			status: 0,
			body: null,
		}));
		row('—', 'DELETE /releases/{id}/ (уборка)', '204', `${del.status}`, del.status === 204);
	}
	if (linkItemId) {
		const del = await call('DELETE', `${project}/work-items/${linkItemId}/`).catch(() => ({
			status: 0,
			body: null,
		}));
		row(
			'—',
			'DELETE /work-items/{id}/ (уборка, ссылки)',
			'204',
			`${del.status}`,
			del.status === 204,
		);
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
	for (const stray of [archivedItemId, strayItemId]) {
		if (!stray) continue;
		const path = `${project}/work-items/${stray}/`;
		let del = await call('DELETE', path).catch(() => ({ status: 0, body: null }));
		if (del.status !== 204) {
			// An item left archived by a failed row: bring it back, then delete.
			await call('DELETE', `${path}unarchive/`).catch(() => null);
			del = await call('DELETE', path).catch(() => ({ status: 0, body: null }));
		}
		row(
			'—',
			'DELETE /work-items/{id}/ (уборка, архив)',
			'204',
			`${del.status}`,
			del.status === 204,
		);
	}
}

console.table(rows);
console.log(failed === 0 ? 'контракт подтверждён' : `расхождений: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
