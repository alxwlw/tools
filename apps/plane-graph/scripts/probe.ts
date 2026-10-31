#!/usr/bin/env bun
// One-off probe of live Plane for plane-graph (design §10). The owner runs it with real credentials
// from env. One JSON line per call goes to stdout (method, path, status, short result); the raw
// response bodies go to files in --out (they become fixtures after sanitize-fixture.ts).
// Never prints a token, a client secret or an Authorization header.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { botTokenAuth, type Fetch, type PlaneAuth, PlaneAuthError } from '@alxwlw/plane-app';

import { PLANE_SCOPES } from '../src/config.ts';

export const USAGE = `usage: bun scripts/probe.ts <subcommand> [args] --out <dir>

  token                            bot token (installation scopes), GET /projects/
  items --project <uuid>           GET the first page of work items
  labels --project <uuid>          GET the labels
  modules --project <uuid>         GET the modules, then module-issues/ of the first module
  relations --project <uuid> --item <id>   GET the relations of a work item
  burst [--n 70]                   n GET /projects/ in a row; prints every status and each
                                   x-ratelimit-* / retry-after header; stops after the first 429

env:
  PROBE_PLANE_URL                  e.g. https://plane.example.com
  PROBE_PLANE_CLIENT_ID, PROBE_PLANE_CLIENT_SECRET     the Plane App credentials
  PROBE_PLANE_WORKSPACE            workspace slug
  PROBE_PLANE_INSTALLATION_ID      app installation id
  PROBE_PLANE_SCOPES               optional, space-separated; default is PLANE_SCOPES of src/config.ts

--out <dir> is required: one raw response file per call, named <subcommand>-<step>.json.`;

type Env = Record<string, string | undefined>;
type Reply = { status: number; body: unknown };

const need = (env: Env, name: string): string => {
	const v = env[name];
	if (v === undefined || v === '') throw new Error(`missing env ${name}`);
	return v;
};

const RATE_HEADER = /^(x-ratelimit-.*|retry-after)$/i;

class Probe {
	readonly #auth: PlaneAuth;
	readonly #base: string;
	readonly #workspace: string;

	constructor(
		env: Env,
		readonly out: string,
		readonly subcommand: string,
		readonly fetchFn: Fetch,
	) {
		this.#base = need(env, 'PROBE_PLANE_URL').replace(/\/+$/, '');
		this.#workspace = encodeURIComponent(need(env, 'PROBE_PLANE_WORKSPACE'));
		const scopes = env.PROBE_PLANE_SCOPES?.split(/\s+/).filter((s) => s !== '');
		this.#auth = botTokenAuth({
			planeUrl: this.#base,
			clientId: need(env, 'PROBE_PLANE_CLIENT_ID'),
			clientSecret: need(env, 'PROBE_PLANE_CLIENT_SECRET'),
			appInstallationId: need(env, 'PROBE_PLANE_INSTALLATION_ID'),
			scopes: scopes !== undefined && scopes.length > 0 ? scopes : PLANE_SCOPES,
			fetch: fetchFn,
		});
	}

	/** Requests the bot token and reports only whether there is one. */
	async token(): Promise<void> {
		let ok = false;
		let status: number | undefined;
		try {
			await this.#auth.headers();
			ok = true;
		} catch (err) {
			if (err instanceof PlaneAuthError) status = err.status;
			else throw err;
		}
		console.log(
			JSON.stringify({
				step: `${this.subcommand}-token`,
				method: 'POST',
				path: '/auth/o/token/',
				status,
				result: { hasToken: ok },
			}),
		);
		if (!ok) throw new Error(`no bot token (status ${status})`);
	}

	/** Records one GET: a JSON line on stdout, the raw body in a file. */
	async get(
		step: string,
		path: string,
		show?: (b: unknown) => unknown,
		withHeaders = false,
	): Promise<Reply> {
		const res = await this.fetchFn(`${this.#base}/api/v1/workspaces/${this.#workspace}${path}`, {
			method: 'GET',
			headers: { ...(await this.#auth.headers()), Accept: 'application/json' },
			signal: AbortSignal.timeout(15_000),
		});
		const text = await res.text();
		let parsed: unknown = text;
		try {
			parsed = text === '' ? null : JSON.parse(text);
		} catch {
			// not JSON: keep the text
		}
		writeFileSync(
			join(this.out, `${this.subcommand}-${step}.json`),
			typeof parsed === 'string' ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2),
		);
		const rate: Record<string, string> = {};
		if (withHeaders) {
			for (const [name, value] of res.headers) if (RATE_HEADER.test(name)) rate[name] = value;
		}
		console.log(
			JSON.stringify({
				step: `${this.subcommand}-${step}`,
				method: 'GET',
				path,
				status: res.status,
				headers: withHeaders ? rate : undefined,
				result: show ? show(parsed) : undefined,
			}),
		);
		return { status: res.status, body: parsed };
	}
}

/** Short view of a list reply: the keys, and the length of the array (`results` or the body itself). */
const shape = (body: unknown): unknown => {
	const rows = Array.isArray(body)
		? body
		: ((body as { results?: unknown } | null)?.results ?? undefined);
	return {
		keys: body !== null && typeof body === 'object' ? Object.keys(body) : typeof body,
		count: Array.isArray(rows) ? rows.length : undefined,
	};
};

const idOfFirst = (body: unknown): string | undefined => {
	const rows = Array.isArray(body) ? body : (body as { results?: unknown } | null)?.results;
	const first: unknown = Array.isArray(rows) ? rows[0] : undefined;
	const id = (first as { id?: unknown } | null | undefined)?.id;
	return typeof id === 'string' ? id : undefined;
};

const segment = (v: string | undefined, flag: string): string => {
	if (v === undefined || v === '') throw new Error(`missing --${flag}\n${USAGE}`);
	return encodeURIComponent(v);
};

async function run(
	probe: Probe,
	cmd: string,
	opts: { project?: string; item?: string; n: number },
): Promise<void> {
	switch (cmd) {
		case 'token':
			await probe.token();
			await probe.get('projects', '/projects/', shape);
			return;
		case 'items': {
			const p = segment(opts.project, 'project');
			await probe.get('page', `/projects/${p}/work-items/?per_page=100`, shape);
			return;
		}
		case 'labels': {
			const p = segment(opts.project, 'project');
			await probe.get('labels', `/projects/${p}/labels/`, shape);
			return;
		}
		case 'modules': {
			const p = segment(opts.project, 'project');
			const list = await probe.get('modules', `/projects/${p}/modules/`, shape);
			const first = idOfFirst(list.body);
			if (first === undefined) {
				console.log(JSON.stringify({ step: 'modules-items', skipped: 'no module' }));
				return;
			}
			await probe.get(
				'items',
				`/projects/${p}/modules/${encodeURIComponent(first)}/module-issues/`,
				shape,
			);
			return;
		}
		case 'relations': {
			const p = segment(opts.project, 'project');
			const item = segment(opts.item, 'item');
			await probe.get('relations', `/projects/${p}/work-items/${item}/relations/`, (b) => ({
				keys: b !== null && typeof b === 'object' ? Object.keys(b) : typeof b,
			}));
			return;
		}
		case 'burst': {
			await probe.token();
			for (let i = 1; i <= opts.n; i += 1) {
				const r = await probe.get(`${String(i).padStart(3, '0')}`, '/projects/', undefined, true);
				if (r.status === 429) {
					console.log(JSON.stringify({ step: 'burst-stop', at: i, reason: '429' }));
					return;
				}
			}
			return;
		}
		default:
			throw new Error(`unknown subcommand ${cmd}\n${USAGE}`);
	}
}

export async function main(argv: string[], env: Env, fetchFn: Fetch = fetch): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			help: { type: 'boolean' },
			out: { type: 'string' },
			project: { type: 'string' },
			item: { type: 'string' },
			n: { type: 'string' },
		},
	});
	const [cmd] = positionals;
	if (values.help || cmd === undefined) {
		console.log(USAGE);
		return values.help ? 0 : 2;
	}
	try {
		if (values.out === undefined) throw new Error(`missing --out\n${USAGE}`);
		const n = values.n === undefined ? 70 : Number(values.n);
		if (!Number.isSafeInteger(n) || n < 1) throw new Error(`bad --n ${values.n}`);
		mkdirSync(values.out, { recursive: true });
		await run(new Probe(env, values.out, cmd, fetchFn), cmd, {
			project: values.project,
			item: values.item,
			n,
		});
		return 0;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2), process.env));
}
