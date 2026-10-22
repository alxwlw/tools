#!/usr/bin/env bun
// Contract probe for the Plane App API calls plane-discord relies on (design §10).
// It needs real credentials, so the owner runs it. Prints «✓/✗ row — detail» lines; never a
// secret, a whole token, or the text of a comment or description (comment-get writes to a file).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_SCOPES = [
	'projects:read',
	'projects.work_items:read',
	'projects.work_items:write',
	'projects.work_items.comments:read',
	'projects.work_items.comments:write',
	'projects.states:read',
	'projects.members:read',
	'projects.modules:read',
	'workspaces.members:read',
	'agents.runs:read',
	'agents.runs:write',
	'agents.run_activities:read',
	'agents.run_activities:write',
];

export const USAGE = `usage: bun scripts/probe-plane-app.ts [--keep]
       bun scripts/probe-plane-app.ts run-reply <runId>
       bun scripts/probe-plane-app.ts comment-get <projectId> <workItemId> <commentId> <outFile>
       bun scripts/probe-plane-app.ts --verify <captureDir> <SECRET_ENV_NAME>...
       bun scripts/probe-plane-app.ts --help

env (probe rows, run-reply, comment-get):
  PROBE_PLANE_URL, PROBE_WORKSPACE (slug)
  PROBE_PROJECT_ID                       project for the throwaway work item (rows)
  PROBE_CLIENT_ID, PROBE_CLIENT_SECRET, PROBE_INSTALLATION_ID   (the app is the only mode)
  PROBE_SCOPES                           optional, space-separated; default is the plan's 13 scopes
rows: token, installation, bot-write, browse-url, modules, webhook-status, rate, cleanup
--keep keeps the throwaway work item.
--verify reads <n>-<sha8>.json + .bin pairs written by scripts/capture.ts and prints, per pair,
  the x-plane-event, the family (v1 | v2 | agent_run | unknown) and which of the named env
  variables (each holds a candidate signing secret) reproduces the HMAC-SHA256 signature.
exit codes: 0 all rows match, 1 a row failed, 2 missing env or arguments.`;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------- token

export type TokenAttempt = { variant: 'без scope' | 'со scope'; status: number; error?: string };
export type TokenResult = {
	attempts: TokenAttempt[];
	token?: string;
	variant?: TokenAttempt['variant'];
	expiresIn?: unknown;
};

/** The `error` field of an OAuth error body, nothing else from it. */
function errorField(body: unknown): string | undefined {
	if (body !== null && typeof body === 'object' && 'error' in body) {
		const e = (body as { error: unknown }).error;
		if (typeof e === 'string') return e.slice(0, 80);
	}
	return undefined;
}

async function parseBody(res: Response): Promise<unknown> {
	const text = await res.text();
	try {
		return text ? JSON.parse(text) : null;
	} catch {
		return text;
	}
}

/**
 * Plane v3.3.0 authorize-app rejects a request without `scope` (invalid_scope), so the token
 * request is tried without `scope` first and, when refused, with the scope list.
 */
export async function requestToken(
	fetchFn: Fetch,
	url: string,
	creds: { clientId: string; clientSecret: string; installationId: string },
	scopes: string[],
): Promise<TokenResult> {
	const result: TokenResult = { attempts: [] };
	const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
	for (const variant of ['без scope', 'со scope'] as const) {
		const form = new URLSearchParams({
			grant_type: 'client_credentials',
			app_installation_id: creds.installationId,
		});
		if (variant === 'со scope') form.set('scope', scopes.join(' '));
		const res = await fetchFn(`${url}/auth/o/token/`, {
			method: 'POST',
			headers: {
				Authorization: `Basic ${basic}`,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: form,
			signal: AbortSignal.timeout(10_000),
		});
		const body = await parseBody(res);
		const token =
			res.ok && body !== null && typeof body === 'object'
				? (body as { access_token?: unknown }).access_token
				: undefined;
		if (typeof token === 'string' && token !== '') {
			result.attempts.push({ variant, status: res.status });
			result.token = token;
			result.variant = variant;
			result.expiresIn = (body as { expires_in?: unknown }).expires_in;
			return result;
		}
		result.attempts.push({
			variant,
			status: res.status,
			error: errorField(body) ?? (res.ok ? 'нет access_token' : undefined),
		});
	}
	return result;
}

// ---------------------------------------------------------------- verify

export type Family = 'v1' | 'v2' | 'agent_run' | 'unknown';

export function familyOf(raw: string): Family {
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return 'unknown';
	}
	if (body === null || typeof body !== 'object') return 'unknown';
	const o = body as Record<string, unknown>;
	if (typeof o.type === 'string' && o.type.startsWith('agent_run')) return 'agent_run';
	if ('agent_run' in o) return 'agent_run';
	if (o.version === 'v2') return 'v2';
	if ('event' in o && 'action' in o) return 'v1';
	return 'unknown';
}

export type VerifyRow = {
	name: string;
	method: string;
	path: string;
	event: string;
	family: Family;
	/** Names of the env variables whose secret reproduces the signature. */
	matched: string[];
	signature: 'absent' | 'present';
};

function hmacHex(secret: string, body: Uint8Array): string {
	return createHmac('sha256', secret).update(body).digest('hex');
}

function sameHex(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/** One row per `<n>-<sha8>.json` that has a sibling `.bin`, ordered by n. */
export function verifyDir(dir: string, secrets: { name: string; value: string }[]): VerifyRow[] {
	const rows: { n: number; row: VerifyRow }[] = [];
	for (const file of readdirSync(dir)) {
		const m = /^(\d+)-([0-9a-f]{8})\.json$/.exec(file);
		if (!m) continue;
		const base = file.slice(0, -'.json'.length);
		if (!existsSync(join(dir, `${base}.bin`))) continue;
		const meta = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
			method?: string;
			path?: string;
			headers?: Record<string, string>;
		};
		const bytes = readFileSync(join(dir, `${base}.bin`));
		const sig = (meta.headers?.['x-plane-signature'] ?? '').replace(/^sha256=/, '').toLowerCase();
		rows.push({
			n: Number(m[1]),
			row: {
				name: base,
				method: meta.method ?? '?',
				path: meta.path ?? '?',
				event: meta.headers?.['x-plane-event'] ?? '-',
				family: familyOf(bytes.toString('utf8')),
				signature: sig === '' ? 'absent' : 'present',
				matched:
					sig === ''
						? []
						: secrets.filter((s) => sameHex(sig, hmacHex(s.value, bytes))).map((s) => s.name),
			},
		});
	}
	return rows.sort((a, b) => a.n - b.n).map((r) => r.row);
}

export function formatVerifyRow(r: VerifyRow): string {
	const sig =
		r.signature === 'absent'
			? 'подписи нет'
			: r.matched.length > 0
				? `подпись сошлась: ${r.matched.join(', ')}`
				: 'подпись не сошлась ни с одним секретом';
	return `${r.matched.length > 0 ? '✓' : '·'} ${r.name} ${r.method} ${r.path} event=${r.event} family=${r.family} — ${sig}`;
}

// ---------------------------------------------------------------- live rows

type Reply = { status: number; body: any; headers: Headers };
type Env = Record<string, string | undefined>;

class Probe {
	failed = 0;
	auth: Record<string, string> = {};
	constructor(
		readonly url: string,
		readonly slug: string,
		readonly fetchFn: Fetch,
	) {}

	get base(): string {
		return `${this.url}/api/v1/workspaces/${this.slug}`;
	}

	async call(method: string, url: string, body?: unknown): Promise<Reply> {
		const res = await this.fetchFn(url, {
			method,
			headers: { ...this.auth, 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		return { status: res.status, body: await parseBody(res), headers: res.headers };
	}

	row(name: string, ok: boolean, detail: string): void {
		if (!ok) this.failed++;
		console.log(`${ok ? '✓' : '✗'} ${name} — ${detail}`);
	}

	/** Runs one row; a throw becomes one ✗ line so the next row still runs. */
	async guard(name: string, run: () => Promise<void>): Promise<void> {
		try {
			await run();
		} catch (err) {
			this.row(name, false, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
		}
	}
}

function rowsOf(body: any): any[] {
	if (Array.isArray(body)) return body;
	if (Array.isArray(body?.results)) return body.results;
	return [];
}

const shape = (body: any): string =>
	Array.isArray(body) ? 'массив' : Array.isArray(body?.results) ? 'страница' : typeof body;

const keysOf = (o: unknown): string =>
	o !== null && typeof o === 'object' ? Object.keys(o).sort().join(',') : typeof o;

const prefix = (token: string): string => `${token.slice(0, 6)}…`;

type Creds = { clientId: string; clientSecret: string; installationId: string };

function credsFromEnv(env: Env): { creds: Creds } | string[] {
	const app = ['PROBE_CLIENT_ID', 'PROBE_CLIENT_SECRET', 'PROBE_INSTALLATION_ID'];
	const missing = app.filter((n) => !env[n]);
	if (missing.length > 0) return missing;
	return {
		creds: {
			clientId: env.PROBE_CLIENT_ID as string,
			clientSecret: env.PROBE_CLIENT_SECRET as string,
			installationId: env.PROBE_INSTALLATION_ID as string,
		},
	};
}

function scopesFromEnv(env: Env): string[] {
	const given = (env.PROBE_SCOPES ?? '').split(/[\s,]+/).filter(Boolean);
	return given.length > 0 ? given : DEFAULT_SCOPES;
}

async function authenticate(
	p: Probe,
	c: ReturnType<typeof credsFromEnv>,
	scopes: string[],
): Promise<boolean> {
	if (Array.isArray(c)) return false;
	let ok = false;
	await p.guard('token', async () => {
		const r = await requestToken(p.fetchFn, p.url, c.creds, scopes);
		for (const a of r.attempts) {
			console.log(`  token ${a.variant}: ${a.status}${a.error ? ` error=${a.error}` : ''}`);
		}
		ok = r.token !== undefined;
		p.row(
			'token',
			ok,
			ok
				? `сработал вариант «${r.variant}», префикс ${prefix(r.token as string)}, expires_in=${String(r.expiresIn)}`
				: 'ни один вариант не выдал токен',
		);
		if (r.token) p.auth = { Authorization: `Bearer ${r.token}` };
	});
	return ok;
}

async function liveRows(p: Probe, env: Env, creds: Creds, keep: boolean): Promise<void> {
	const projectId = env.PROBE_PROJECT_ID;
	if (!projectId) {
		p.row('env', false, 'PROBE_PROJECT_ID не задан');
		return;
	}
	const project = `${p.base}/projects/${projectId}`;
	const tag = crypto.randomUUID();
	const source = 'plane-discord-probe';
	let itemId: string | null = null;
	let botId: string | undefined;

	try {
		await p.guard('installation', async () => {
			const r = await p.call(
				'GET',
				`${p.url}/auth/o/app-installation/?${new URLSearchParams({ id: creds.installationId })}`,
			);
			const inst = Array.isArray(r.body) ? r.body[0] : r.body;
			botId = typeof inst?.app_bot === 'string' ? inst.app_bot : undefined;
			const hook = inst?.webhook;
			p.row(
				'installation',
				r.status === 200 && inst !== undefined,
				`${r.status}, workspace=${inst?.workspace ?? '—'}, slug=${inst?.workspace_detail?.slug ?? '—'}, app_bot=${botId ?? '—'}, status=${inst?.status ?? '—'}, webhook=${hook === undefined ? 'нет поля' : `${typeof hook}${hook !== null && typeof hook === 'object' ? ` {${keysOf(hook)}}` : ''}`}`,
			);
		});

		await p.guard('bot-write', async () => {
			const created = await p.call('POST', `${project}/work-items/`, {
				name: `plane-discord probe ${tag}`,
				priority: 'none',
				external_id: tag,
				external_source: source,
			});
			itemId = typeof created.body?.id === 'string' ? created.body.id : null;
			if (itemId === null) {
				p.row(
					'bot-write',
					false,
					`POST /work-items/ → ${created.status}`,
				);
				return;
			}
			const comment = await p.call('POST', `${project}/work-items/${itemId}/comments/`, {
				comment_html: '<p>plane-discord probe</p>',
				external_id: tag,
				external_source: source,
			});
			const commentId = typeof comment.body?.id === 'string' ? comment.body.id : null;
			const read =
				commentId === null
					? null
					: await p.call('GET', `${project}/work-items/${itemId}/comments/${commentId}/`);
			const actors = ['actor', 'created_by'].map((k) => {
				const v = read?.body?.[k];
				return `${k}=${v === undefined ? 'нет поля' : v === botId ? 'app_bot' : 'не app_bot'}`;
			});
			const members = await p.call('GET', `${project}/members/`);
			const list = rowsOf(members.body);
			const bot = list.find((m) => (m?.member?.id ?? m?.id) === botId);
			const who = bot?.member ?? bot;
			p.row(
				'bot-write',
				created.status === 201 && comment.status === 201 && read?.status === 200,
				`задача ${created.status}, комментарий ${comment.status}, чтение ${read?.status ?? '—'}, ${actors.join(', ')}; ` +
					`GET /members/ ${members.status} ${shape(members.body)} (${list.length}), ключи строки: ${keysOf(list[0])}, ` +
					`бот в списке: ${bot ? `да, display_name=${who?.display_name ?? '—'}` : botId ? 'нет' : 'app_bot неизвестен'}`,
			);
		});

		await p.guard('browse-url', async () => {
			const proj = await p.call('GET', `${project}/`);
			const item = itemId === null ? null : await p.call('GET', `${project}/work-items/${itemId}/`);
			const key = `${proj.body?.identifier ?? '?'}-${item?.body?.sequence_id ?? '?'}`;
			p.row(
				'browse-url',
				proj.status === 200 && item?.status === 200,
				`открыть и подтвердить: ${p.url}/${p.slug}/browse/${key}/`,
			);
		});

		await p.guard('modules', async () => {
			if (itemId === null) {
				p.row('modules', false, 'нет задачи пробы');
				return;
			}
			const modules = await p.call('GET', `${project}/modules/`);
			const first = rowsOf(modules.body)[0]?.id as string | undefined;
			let added = 'модулей нет';
			if (first) {
				const add = await p.call('POST', `${project}/modules/${first}/module-issues/`, {
					issues: [itemId],
				});
				added = `добавление в модуль ${add.status}`;
			}
			const detail = await p.call('GET', `${project}/work-items/${itemId}/`);
			const expanded = await p.call('GET', `${project}/work-items/${itemId}/?expand=modules`);
			const viaModule = first
				? await p.call('GET', `${project}/modules/${first}/module-issues/`)
				: null;
			const listed = rowsOf(viaModule?.body).some(
				(x) => (x?.id ?? x?.issue) === itemId || x?.issue_id === itemId,
			);
			if (first) {
				await p.call('DELETE', `${project}/modules/${first}/module-issues/${itemId}/`);
			}
			p.row(
				'modules',
				modules.status === 200 && detail.status === 200,
				`${added}; GET /modules/ ${modules.status}; деталь: module_ids=${Array.isArray(detail.body?.module_ids) ? `массив(${detail.body.module_ids.length})` : typeof detail.body?.module_ids}; ` +
					`?expand=modules ${expanded.status}: modules=${Array.isArray(expanded.body?.modules) ? `массив(${expanded.body.modules.length})` : typeof expanded.body?.modules}, module_ids=${Array.isArray(expanded.body?.module_ids) ? `массив(${expanded.body.module_ids.length})` : typeof expanded.body?.module_ids}; ` +
					`GET /modules/{m}/module-issues/ ${viaModule?.status ?? '—'}, задача в списке: ${viaModule ? (listed ? 'да' : 'нет') : '—'}`,
			);
		});

		await p.guard('webhook-status', async () => {
			const r = await p.call('GET', `${p.base}/webhooks/`);
			const list = rowsOf(r.body);
			// Key names and is_active only: a webhook row can carry its signing secret.
			p.row(
				'webhook-status',
				r.status === 200,
				`${r.status}, ${shape(r.body)} (${list.length}), ключи: ${keysOf(list[0])}, is_active: ${list.map((w) => String(w?.is_active)).join(',') || '—'}`,
			);
		});

		await p.guard('rate', async () => {
			let limited = 0;
			let firstLimited = 0;
			let last: Reply | null = null;
			const started = Date.now();
			for (let i = 1; i <= 70; i++) {
				const r = await p.call('GET', `${p.base}/projects/`);
				last = r;
				if (r.status === 429) {
					limited++;
					if (firstLimited === 0) firstLimited = i;
					const wait = r.headers.get('retry-after');
					if (wait !== null) console.log(`  rate 429 на запросе ${i}: Retry-After=${wait}`);
				}
			}
			const limits = [...(last?.headers ?? [])]
				.filter(([k]) => /^x-ratelimit-/i.test(k))
				.map(([k, v]) => `${k}=${v}`);
			p.row(
				'rate',
				true,
				`70 запросов за ${Date.now() - started} мс, 429: ${limited}${limited ? ` (первый на ${firstLimited})` : ''}, последний ответ ${last?.status}, ${limits.join(' ') || 'X-RateLimit-* нет'}`,
			);
		});
	} finally {
		if (itemId !== null && keep) {
			p.row('cleanup', true, `--keep: задача пробы оставлена, id=${itemId}`);
		} else if (itemId !== null) {
			await p.guard('cleanup', async () => {
				const del = await p.call('DELETE', `${project}/work-items/${itemId}/`);
				p.row('cleanup', del.status === 204, `DELETE → ${del.status}`);
			});
		} else {
			p.row('cleanup', true, 'нечего удалять');
		}
	}
}

// ---------------------------------------------------------------- entry point

export async function main(argv: string[], env: Env, fetchFn: Fetch = fetch): Promise<number> {
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(USAGE);
		return 0;
	}

	if (argv[0] === '--verify') {
		const [, dir, ...names] = argv;
		if (dir === undefined || names.length === 0) {
			console.error(USAGE);
			return 2;
		}
		const unset = names.filter((n) => !env[n]);
		const secrets = names.filter((n) => env[n]).map((n) => ({ name: n, value: env[n] as string }));
		if (unset.length > 0) console.log(`env не задан: ${unset.join(', ')}`);
		if (secrets.length === 0) return 2;
		const rows = verifyDir(dir, secrets);
		for (const r of rows) console.log(formatVerifyRow(r));
		const signed = rows.filter((r) => r.matched.length > 0).length;
		console.log(`пар: ${rows.length}, подпись сошлась: ${signed}`);
		return rows.length > 0 ? 0 : 1;
	}

	const subcommand = ['run-reply', 'comment-get'].includes(argv[0] ?? '') ? argv[0] : undefined;
	const args = subcommand ? argv.slice(1) : argv.filter((a) => a !== '--keep');
	const needed = subcommand === 'comment-get' ? 4 : subcommand === 'run-reply' ? 1 : 0;
	const common = ['PROBE_PLANE_URL', 'PROBE_WORKSPACE'].filter((n) => !env[n]);
	const creds = credsFromEnv(env);
	if (common.length > 0 || Array.isArray(creds) || args.length !== needed) {
		const missing = [...common, ...(Array.isArray(creds) ? creds : [])];
		if (missing.length > 0) console.error(`missing env: ${missing.join(', ')}`);
		else console.error(USAGE);
		return 2;
	}

	const p = new Probe(
		(env.PROBE_PLANE_URL as string).replace(/\/+$/, ''),
		env.PROBE_WORKSPACE as string,
		fetchFn,
	);
	if (!(await authenticate(p, creds, scopesFromEnv(env)))) {
		console.log('нет авторизации — дальше идти нельзя');
		return 1;
	}

	if (subcommand === 'run-reply') {
		await p.guard('run-reply', async () => {
			const r = await p.call(
				'POST',
				`${p.base}/runs/${encodeURIComponent(args[0] as string)}/activities/`,
				{
					type: 'response',
					content: { type: 'response', body: 'plane-discord probe reply' },
				},
			);
			p.row(
				'run-reply',
				r.status >= 200 && r.status < 300,
				`${r.status}${errorField(r.body) ? ` error=${errorField(r.body)}` : ''}`,
			);
		});
	} else if (subcommand === 'comment-get') {
		const [projectId, itemId, commentId, outFile] = args as [string, string, string, string];
		await p.guard('comment-get', async () => {
			const res = await p.fetchFn(
				`${p.base}/projects/${projectId}/work-items/${itemId}/comments/${commentId}/`,
				{ headers: p.auth, signal: AbortSignal.timeout(10_000) },
			);
			const text = await res.text();
			if (res.status === 200) writeFileSync(outFile, text, { mode: 0o600 });
			p.row(
				'comment-get',
				res.status === 200,
				`${res.status}, ${text.length} байт${res.status === 200 ? ` → ${outFile}` : ''}`,
			);
		});
	} else {
		await liveRows(p, env, creds.creds, argv.includes('--keep'));
	}
	console.log(p.failed === 0 ? 'контракт подтверждён' : `расхождений: ${p.failed}`);
	return p.failed === 0 ? 0 : 1;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2), process.env));
}
