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
// Boards the access probe asks about: someone else's public board and one that does not exist.
const FOREIGN_BOARD = 'o9J_kkQxX78=';
const MISSING_BOARD = 'uXjVnotexist0=';

const STATUS_FILL: Record<string, string> = {
	backlog: '#e6e6e6',
	unstarted: '#dbe4ff',
	started: '#fff3bf',
	completed: '#d3f9d8',
	cancelled: '#ffe3e3',
};

export const USAGE = `usage: bun scripts/probe.ts <subcommand> [args] --out <dir> [--tenant liq|yulii]

Plane (tenant liq by default for single-workspace subcommands):
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
  miro-replace <sticker-id>        GET sticker, tags, connectors; POST app_card in its place
                                   (status connected); PATCH connectors onto it; DELETE the sticker
  miro-access                      GET two boards that are not ours: a foreign public one and a missing one

env, Plane:
  PROBE_PLANE_URL                  e.g. https://plane.example.com
  PROBE_PLANE_CLIENT_ID, PROBE_PLANE_CLIENT_SECRET     the Plane App credentials
  PROBE_LIQ_WORKSPACE, PROBE_LIQ_INSTALLATION_ID       workspace slug and app installation id, tenant liq
  PROBE_YULII_WORKSPACE, PROBE_YULII_INSTALLATION_ID   the same for tenant yulii
env, Miro:
  PROBE_MIRO_TOKEN                 access token of the service account
  PROBE_MIRO_BOARD_ID              probe board

--out <dir> is required: one raw response file per call, named <subcommand>-<step>.json.`;

type Env = Record<string, string | undefined>;
type Fetch = (input: string, init: RequestInit) => Promise<Response>;
type Tenant = 'liq' | 'yulii';

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
const seg = (s: string): string => encodeURIComponent(s);

function tenantOf(raw: string | undefined): Tenant {
	if (raw === undefined || raw === 'liq') return 'liq';
	if (raw === 'yulii') return 'yulii';
	throw new Error(`--tenant must be liq or yulii, got ${raw}`);
}

async function run(p: Probe, cmd: string, pos: string[], opt: Record<string, string | undefined>) {
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
	const item = (project: string, id: string): string =>
		`/projects/${seg(project)}/work-items/${seg(id)}/`;

	switch (cmd) {
		case 'plane-token':
			for (const t of ['liq', 'yulii'] as const) {
				await p.plane(t, `projects-${t}`, 'GET', '/projects/', undefined, (b) =>
					listOf(b).map((x) => ({ id: x.id, identifier: x.identifier })),
				);
			}
			return;
		case 'plane-search':
			await p.plane(
				tenant,
				'search',
				'GET',
				`/work-items/search/?search=${encodeURIComponent(flag('q'))}`,
			);
			return;
		case 'plane-item':
			await p.plane(
				tenant,
				'create',
				'POST',
				`/projects/${seg(flag('project'))}/work-items/`,
				{ name: opt.name ?? 'probe: plane-miro' },
				(b) => ({ id: idOf(b), sequence_id: asRecord(b).sequence_id }),
			);
			return;
		case 'plane-read':
			await p.plane(tenant, 'read', 'GET', item(want(0, 'project-uuid'), want(1, 'id')));
			return;
		case 'plane-write-desc':
			await p.plane(
				tenant,
				'write-desc',
				'PATCH',
				item(want(0, 'project-uuid'), want(1, 'id')),
				{ description_html: readFileSync(flag('html-file'), 'utf8') },
				(b) => ({ id: idOf(b) }),
			);
			return;
		case 'plane-link':
			// A second run with the same URL records the duplicate answer; the file is overwritten,
			// so the second step name carries a counter via --step.
			await p.plane(
				tenant,
				opt.step ?? 'link',
				'POST',
				`${item(want(0, 'project-uuid'), want(1, 'id'))}links/`,
				{ url: flag('url'), title: flag('title') },
				(b) => ({ id: idOf(b) }),
			);
			return;
		case 'plane-delete':
			await p.plane(tenant, 'delete', 'DELETE', item(want(0, 'project-uuid'), want(1, 'id')));
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
			const sticker = await p.miro(
				'get-sticker',
				'GET',
				`/v2/boards/${b}/items/${seg(sid)}`,
				undefined,
				(r) => ({
					type: asRecord(r).type,
				}),
			);
			await p.miro('get-tags', 'GET', `/v2/boards/${b}/items/${seg(sid)}/tags`, undefined, (r) => ({
				count: listOf(r).length,
			}));
			const conns = await p.miro(
				'get-connectors',
				'GET',
				`/v2/boards/${b}/items/${seg(sid)}/connectors`,
				undefined,
				(r) => ({ count: listOf(r).length }),
			);
			const parent = asRecord(asRecord(sticker.body).parent);
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
					position: asRecord(asRecord(sticker.body).position),
					...(typeof parent.id === 'string' ? { parent: { id: parent.id } } : {}),
				},
				(r) => ({ id: idOf(r) }),
			);
			const cardId = idOf(card.body);
			if (cardId === '') throw new Error('app card was not created; sticker left in place');
			for (const c of listOf(conns.body)) {
				const id = idOf(c);
				const start = idOf(c.startItem);
				const patch = start === sid ? { startItem: { id: cardId } } : { endItem: { id: cardId } };
				await p.miro(
					`patch-connector-${id}`,
					'PATCH',
					`/v2/boards/${b}/connectors/${seg(id)}`,
					patch,
				);
			}
			await p.miro('delete-sticker', 'DELETE', `/v2/boards/${b}/items/${seg(sid)}`);
			return;
		}
		case 'miro-access':
			await p.miro('foreign', 'GET', `/v2/boards/${seg(FOREIGN_BOARD)}`, undefined, (r) => ({
				keys: Object.keys(asRecord(r)),
			}));
			await p.miro('missing', 'GET', `/v2/boards/${seg(MISSING_BOARD)}`, undefined, (r) => ({
				keys: Object.keys(asRecord(r)),
			}));
			return;
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
		const opts: Record<string, string | undefined> = { ...values, help: undefined };
		await run(new Probe(env, values.out, cmd, fetchFn), cmd, pos, opts);
		return 0;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2), process.env));
}
