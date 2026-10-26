#!/usr/bin/env bun
// One-off probe of live Plane and Miro for plane-miro (design §10). The owner runs it with real
// credentials from env. One JSON line per call goes to stdout (method, path, status, short result);
// the raw response bodies go to files in --out (they become fixtures after sanitize-fixture.ts).
// Never prints a token, a client secret or an Authorization header.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const PLANE_SCOPES = [
	'projects:read',
	'projects.work_items:read',
	'projects.work_items:write',
	'projects.work_items.comments:read',
	'projects.work_items.comments:write',
	'projects.work_items.links:read',
	'projects.work_items.links:write',
	'projects.states:read',
	'projects.members:read',
	'workspaces.members:read',
];

const MIRO = 'https://api.miro.com';

const STATUS_FILL: Record<string, string> = {
	backlog: '#e6e6e6',
	unstarted: '#dbe4ff',
	started: '#fff3bf',
	completed: '#d3f9d8',
	cancelled: '#ffe3e3',
};

export const USAGE = `usage: bun scripts/probe.ts <subcommand> [args] --out <dir> [--tenant acme|beta]

Plane (tenant acme by default for single-workspace subcommands):
  plane-token                      bot token of both tenants, GET /projects/ of both
  plane-search --q <text>          GET /work-items/search/?search=<text>
  plane-item --project <uuid> [--name <text>]       create a work item
  plane-read <project-uuid> <id>                    GET the work item
  plane-write-desc <project-uuid> <id> --html-file <file>   PATCH description_html
  plane-link <project-uuid> <id> --url <u> --title <t>      POST a link (run twice,
                                   the second time with --step link-dup, for the duplicate answer)
  plane-delete <project-uuid> <id>                  DELETE the work item
Miro (board from PROBE_MIRO_BOARD_ID):
  miro-setup                       two stickies and a connector between them; prints the ids
  miro-replace <sticker-id>        GET sticker (must be a sticky_note), tags, the board's connectors (paged,
                                   ours kept); POST app_card in its place (status connected); PATCH our
                                   connectors onto it; DELETE the sticker. Any non-2xx before the DELETE
                                   stops the run with the sticker left in place (exit 1).
  miro-access --board <id> [--board <id>...]   GET each named board (e.g. a foreign public one, a missing one)

env, Plane:
  PROBE_PLANE_URL                  e.g. https://plane.example.com
  PROBE_PLANE_CLIENT_ID, PROBE_PLANE_CLIENT_SECRET     the Plane App credentials
  PROBE_ACME_WORKSPACE, PROBE_ACME_INSTALLATION_ID     workspace slug and app installation id, tenant acme
  PROBE_BETA_WORKSPACE, PROBE_BETA_INSTALLATION_ID     the same for tenant beta
env, Miro:
  PROBE_MIRO_TOKEN                 access token of the service account
  PROBE_MIRO_BOARD_ID              probe board

--step <name> (any single-workspace Plane subcommand) replaces the default step in the file name,
so a repeated run keeps both answers.
--out <dir> is required: one raw response file per call, named <subcommand>-<step>.json.`;

type Env = Record<string, string | undefined>;
type Fetch = (input: string, init: RequestInit) => Promise<Response>;
type Tenant = 'acme' | 'beta';

type Reply = { status: number; body: unknown };

class Probe {
	#tokens = new Map<Tenant, string>();

	constructor(
		readonly env: Env,
		readonly out: string,
		readonly subcommand: string,
		readonly fetchFn: Fetch,
	) {}

	need(name: string): string {
		const v = this.env[name];
		if (v === undefined || v === '') throw new Error(`missing env ${name}`);
		return v;
	}

	/** Records one call: a JSON line on stdout, the raw body in a file. */
	async call(
		step: string,
		method: string,
		url: string,
		headers: Record<string, string>,
		body?: unknown,
		show?: (b: unknown) => unknown,
	): Promise<Reply> {
		const res = await this.fetchFn(url, {
			method,
			headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
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
		const path = url.replace(/^https?:\/\/[^/]+/, '');
		console.log(
			JSON.stringify({
				step: `${this.subcommand}-${step}`,
				method,
				path,
				status: res.status,
				result: show ? show(parsed) : undefined,
			}),
		);
		return { status: res.status, body: parsed };
	}

	// ---- Plane

	async planeToken(tenant: Tenant): Promise<string> {
		const known = this.#tokens.get(tenant);
		if (known !== undefined) return known;
		const T = tenant.toUpperCase();
		const base = this.need('PROBE_PLANE_URL').replace(/\/+$/, '');
		const basic = Buffer.from(
			`${this.need('PROBE_PLANE_CLIENT_ID')}:${this.need('PROBE_PLANE_CLIENT_SECRET')}`,
		).toString('base64');
		const res = await this.fetchFn(`${base}/auth/o/token/`, {
			method: 'POST',
			headers: {
				Authorization: `Basic ${basic}`,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				grant_type: 'client_credentials',
				app_installation_id: this.need(`PROBE_${T}_INSTALLATION_ID`),
				scope: PLANE_SCOPES.join(' '),
			}).toString(),
			signal: AbortSignal.timeout(15_000),
		});
		let token: unknown;
		let expiresIn: unknown;
		try {
			const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
			token = body.access_token;
			expiresIn = body.expires_in;
		} catch {
			// no JSON body: reported below as a failure
		}
		console.log(
			JSON.stringify({
				step: `${this.subcommand}-token-${tenant}`,
				method: 'POST',
				path: '/auth/o/token/',
				status: res.status,
				result: { hasToken: typeof token === 'string' && token !== '', expiresIn },
			}),
		);
		if (typeof token !== 'string' || token === '') {
			throw new Error(`no bot token for ${tenant} (status ${res.status})`);
		}
		this.#tokens.set(tenant, token);
		return token;
	}

	async plane(
		tenant: Tenant,
		step: string,
		method: string,
		path: string,
		body?: unknown,
		show?: (b: unknown) => unknown,
	): Promise<Reply> {
		const token = await this.planeToken(tenant);
		const base = this.need('PROBE_PLANE_URL').replace(/\/+$/, '');
		const ws = encodeURIComponent(this.need(`PROBE_${tenant.toUpperCase()}_WORKSPACE`));
		return this.call(
			step,
			method,
			`${base}/api/v1/workspaces/${ws}${path}`,
			{ Authorization: `Bearer ${token}`, Accept: 'application/json' },
			body,
			show,
		);
	}

	// ---- Miro

	miro(step: string, method: string, path: string, body?: unknown, show?: (b: unknown) => unknown) {
		return this.call(
			step,
			method,
			`${MIRO}${path}`,
			{ Authorization: `Bearer ${this.need('PROBE_MIRO_TOKEN')}`, Accept: 'application/json' },
			body,
			show,
		);
	}

	board(): string {
		return encodeURIComponent(this.need('PROBE_MIRO_BOARD_ID'));
	}
}

const asRecord = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const idOf = (v: unknown): string => {
	const id = asRecord(v).id;
	return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
};
const listOf = (v: unknown): Record<string, unknown>[] => {
	const r = asRecord(v);
	const rows = Array.isArray(v) ? v : Array.isArray(r.data) ? r.data : [];
	return rows.map(asRecord);
};
const is2xx = (status: number): boolean => status >= 200 && status < 300;
const seg = (s: string): string => encodeURIComponent(s);

function tenantOf(raw: string | undefined): Tenant {
	if (raw === undefined || raw === 'acme') return 'acme';
	if (raw === 'beta') return 'beta';
	throw new Error(`--tenant must be acme or beta, got ${raw}`);
}

async function run(
	p: Probe,
	cmd: string,
	pos: string[],
	opt: Record<string, string | undefined>,
	boards: string[],
) {
	const tenant = tenantOf(opt.tenant);
	const want = (i: number, what: string): string => {
		const v = pos[i];
		if (v === undefined) throw new Error(`missing <${what}>\n${USAGE}`);
		return v;
	};
	const flag = (name: string): string => {
		const v = opt[name];
		if (v === undefined) throw new Error(`missing --${name}\n${USAGE}`);
		return v;
	};
	// --step renames the output file, so a repeated run does not overwrite the first answer.
	const step = (dflt: string): string => opt.step ?? dflt;
	const item = (project: string, id: string): string =>
		`/projects/${seg(project)}/work-items/${seg(id)}/`;

	switch (cmd) {
		case 'plane-token':
			for (const t of ['acme', 'beta'] as const) {
				await p.plane(t, `projects-${t}`, 'GET', '/projects/', undefined, (b) =>
					listOf(b).map((x) => ({ id: x.id, identifier: x.identifier })),
				);
			}
			return;
		case 'plane-search':
			await p.plane(
				tenant,
				step('search'),
				'GET',
				`/work-items/search/?search=${encodeURIComponent(flag('q'))}`,
			);
			return;
		case 'plane-item':
			await p.plane(
				tenant,
				step('create'),
				'POST',
				`/projects/${seg(flag('project'))}/work-items/`,
				{ name: opt.name ?? 'probe: plane-miro' },
				(b) => ({ id: idOf(b), sequence_id: asRecord(b).sequence_id }),
			);
			return;
		case 'plane-read':
			await p.plane(tenant, step('read'), 'GET', item(want(0, 'project-uuid'), want(1, 'id')));
			return;
		case 'plane-write-desc':
			await p.plane(
				tenant,
				step('write-desc'),
				'PATCH',
				item(want(0, 'project-uuid'), want(1, 'id')),
				{ description_html: readFileSync(flag('html-file'), 'utf8') },
				(b) => ({ id: idOf(b) }),
			);
			return;
		case 'plane-link':
			// A second run with the same URL records the duplicate answer (use --step link-dup).
			await p.plane(
				tenant,
				step('link'),
				'POST',
				`${item(want(0, 'project-uuid'), want(1, 'id'))}links/`,
				{ url: flag('url'), title: flag('title') },
				(b) => ({ id: idOf(b) }),
			);
			return;
		case 'plane-delete':
			await p.plane(tenant, step('delete'), 'DELETE', item(want(0, 'project-uuid'), want(1, 'id')));
			return;
		case 'miro-setup': {
			const b = p.board();
			const sticky = (text: string, x: number) =>
				p.miro(
					text === 'probe one' ? 'sticker-1' : 'sticker-2',
					'POST',
					`/v2/boards/${b}/sticky_notes`,
					{ data: { content: text, shape: 'square' }, position: { x, y: 0 } },
					(r) => ({ id: idOf(r) }),
				);
			const one = await sticky('probe one', 0);
			const two = await sticky('probe two', 400);
			const conn = await p.miro(
				'connector',
				'POST',
				`/v2/boards/${b}/connectors`,
				{ startItem: { id: idOf(one.body) }, endItem: { id: idOf(two.body) } },
				(r) => ({ id: idOf(r) }),
			);
			console.log(
				JSON.stringify({
					ids: { first: idOf(one.body), second: idOf(two.body), connector: idOf(conn.body) },
				}),
			);
			return;
		}
		case 'miro-replace': {
			const b = p.board();
			const sid = want(0, 'sticker-id');
			const keep = (what: string): never => {
				throw new Error(`${what}; sticker left in place`);
			};
			const sticker = await p.miro(
				'get-sticker',
				'GET',
				`/v2/boards/${b}/items/${seg(sid)}`,
				undefined,
				(r) => ({ type: asRecord(r).type }),
			);
			if (!is2xx(sticker.status)) keep(`get-sticker → ${sticker.status}`);
			if (asRecord(sticker.body).type !== 'sticky_note') keep('item is not a sticky_note');
			await p.miro('get-tags', 'GET', `/v2/boards/${b}/items/${seg(sid)}/tags`, undefined, (r) => ({
				count: listOf(r).length,
			}));
			// The spec has no item-level connectors path: list the board's connectors and keep ours.
			const ours: Record<string, unknown>[] = [];
			let cursor: string | undefined;
			for (let page = 1; page <= 100; page++) {
				const query = new URLSearchParams({ limit: '50' });
				if (cursor !== undefined) query.set('cursor', cursor);
				const res = await p.miro(
					`get-connectors-${page}`,
					'GET',
					`/v2/boards/${b}/connectors?${query.toString()}`,
					undefined,
					(r) => ({ count: listOf(r).length }),
				);
				if (!is2xx(res.status)) keep(`get-connectors → ${res.status}`);
				for (const c of listOf(res.body)) {
					if (idOf(c.startItem) === sid || idOf(c.endItem) === sid) ours.push(c);
				}
				const next = asRecord(res.body).cursor;
				if (typeof next !== 'string' || next === '') break;
				cursor = next;
			}
			const parent = asRecord(asRecord(sticker.body).parent);
			const at = asRecord(asRecord(sticker.body).position);
			const card = await p.miro(
				'post-app-card',
				'POST',
				`/v2/boards/${b}/app_cards`,
				{
					data: {
						title: 'PROBE-1 probe card',
						description: '',
						status: 'connected',
						fields: [
							{ value: 'In progress', fillColor: STATUS_FILL.started, textColor: '#1a1a1a' },
							{ value: '—', textColor: '#1a1a1a' },
						],
					},
					position: { x: at.x, y: at.y },
					...(typeof parent.id === 'string' ? { parent: { id: parent.id } } : {}),
				},
				(r) => ({ id: idOf(r) }),
			);
			const cardId = idOf(card.body);
			if (!is2xx(card.status) || cardId === '') keep('app card was not created');
			for (const c of ours) {
				const id = idOf(c);
				const patch =
					idOf(c.startItem) === sid ? { startItem: { id: cardId } } : { endItem: { id: cardId } };
				const res = await p.miro(
					`patch-connector-${id}`,
					'PATCH',
					`/v2/boards/${b}/connectors/${seg(id)}`,
					patch,
				);
				if (!is2xx(res.status)) keep(`patch-connector → ${res.status}`);
			}
			await p.miro('delete-sticker', 'DELETE', `/v2/boards/${b}/items/${seg(sid)}`);
			return;
		}
		case 'miro-access': {
			if (boards.length === 0)
				throw new Error(`miro-access needs at least one --board <id>\n${USAGE}`);
			for (const [i, board] of boards.entries()) {
				await p.miro(`board-${i + 1}`, 'GET', `/v2/boards/${seg(board)}`, undefined, (r) => ({
					keys: Object.keys(asRecord(r)),
				}));
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
			tenant: { type: 'string' },
			q: { type: 'string' },
			project: { type: 'string' },
			name: { type: 'string' },
			'html-file': { type: 'string' },
			url: { type: 'string' },
			title: { type: 'string' },
			step: { type: 'string' },
			board: { type: 'string', multiple: true },
		},
	});
	const [cmd, ...pos] = positionals;
	if (values.help || cmd === undefined) {
		console.log(USAGE);
		return values.help ? 0 : 2;
	}
	try {
		if (values.out === undefined) throw new Error(`missing --out\n${USAGE}`);
		mkdirSync(values.out, { recursive: true });
		const rest: Record<string, string | undefined> = {
			tenant: values.tenant,
			q: values.q,
			project: values.project,
			name: values.name,
			'html-file': values['html-file'],
			url: values.url,
			title: values.title,
			step: values.step,
		};
		await run(new Probe(env, values.out, cmd, fetchFn), cmd, pos, rest, values.board ?? []);
		return 0;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2), process.env));
}
