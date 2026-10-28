#!/usr/bin/env bun
// One-off probe of the live systems plane-hooks depends on (Plane App, GitHub App). It needs real
// credentials, so the owner runs it. Every step prints one JSON line {step, status, body}; with --out
// the same line is also written to <out>/<step>.json. Secrets come from the environment only; a token
// in a response is cut to its first four characters, and no header is ever printed.
import { createSign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

/** Scopes of the Plane App (plan Global Constraints), without the releases scope that the probe looks for. */
export const BASE_SCOPES = [
	'projects:read',
	'projects.work_items:read',
	'projects.work_items:write',
	'projects.work_items.comments:read',
	'projects.work_items.comments:write',
	'projects.work_items.links:read',
	'projects.work_items.links:write',
	'projects.states:read',
	'projects.labels:read',
	'projects.labels:write',
];

export const USAGE = `usage: bun scripts/probe-app.ts <command> [options]

commands:
  plane-token   --tenant <id> [--scope <extra>]... [--out <dir>]
      bot token with the base scopes plus the extra ones, GET projects, GET states of the project
      PROBE_PROJECT_IDENTIFIER (is there a "sequence" field?)
  plane-release --tenant <id> --scope <candidate>... [--out <dir>]
      token with the candidate scope(s); create work item + release "probe <ISO>" (external_source
      "probe"), attach the item, delete both; prints every status
  gh-token      --app <name> [--out <dir>]
      App JWT -> GET /app, GET /app/installations, installation token (prefix only)
  gh-compare    --app <name> <owner/repo> <base> <head> [--out <dir>]
  gh-pulls      --app <name> <owner/repo> <sha> [--out <dir>]
  gh-deployments --app <name> <owner/repo> [--env <environment>] [--out <dir>]
      deployments, each with its latest statuses
  gh-deploy     --app <name> <owner/repo> <sha> --env probe [--out <dir>]
      create a Deployment and a "success" status, then "inactive", then delete it (deployments: write)
  --help

env (names are given by the id after --tenant / --app, upper-cased: acme -> ACME):
  PLANE_HOOKS_PLANE_URL                   Plane base URL, e.g. https://plane.example.com
  PLANE_HOOKS_<TENANT>_PLANE_SECRET       client secret of the Plane App
  PROBE_PLANE_CLIENT_ID                   client id of the Plane App
  PROBE_PLANE_INSTALLATION_ID             installation id of the App in the workspace
  PROBE_WORKSPACE                         workspace slug, e.g. example-ws
  PROBE_PROJECT_IDENTIFIER                project identifier for states and the throwaway item, e.g. ENG
  PLANE_HOOKS_GH_<APP>_PRIVATE_KEY        GitHub App private key, PEM in base64 on one line
  PROBE_GH_<APP>_APP_ID                   GitHub App id

exit codes: 0 done, 1 a step failed, 2 missing env or arguments.`;

type Env = Record<string, string | undefined>;
type Reply = { status: number; body: unknown };

class UsageError extends Error {}

const ID = /^[a-z][a-z0-9]{0,15}$/;

function idOf(value: string | undefined, what: string): string {
	if (value === undefined || !ID.test(value)) throw new UsageError(`${what} must match ${ID}`);
	return value;
}

/** Values of the named variables; a missing one is reported by name (never by value). */
function need(env: Env, names: string[]): Record<string, string> {
	const missing = names.filter((n) => !env[n]);
	if (missing.length > 0) throw new UsageError(`missing env: ${missing.join(', ')}`);
	return Object.fromEntries(names.map((n) => [n, env[n] as string]));
}

const SECRET_KEYS = new Set(['access_token', 'refresh_token', 'token']);

/** A copy of `body` where a token value is cut to its first four characters. */
export function redact(body: unknown): unknown {
	if (Array.isArray(body)) return body.map(redact);
	if (body !== null && typeof body === 'object') {
		return Object.fromEntries(
			Object.entries(body).map(([k, v]) => [
				k,
				SECRET_KEYS.has(k) && typeof v === 'string' ? `${v.slice(0, 4)}…` : redact(v),
			]),
		);
	}
	return body;
}

class Probe {
	failed = 0;
	constructor(readonly out: string | undefined) {
		if (out !== undefined) mkdirSync(out, { recursive: true });
	}

	/** Prints (and saves) one step; a status outside 2xx counts as a failure unless `expected` says otherwise. */
	report(step: string, reply: Reply, expected: (status: number) => boolean = (s) => s < 300): void {
		if (!expected(reply.status)) this.failed++;
		const line = JSON.stringify({ step, status: reply.status, body: redact(reply.body) });
		console.log(line);
		if (this.out !== undefined) writeFileSync(join(this.out, `${step}.json`), `${line}\n`);
	}
}

async function send(
	method: string,
	url: string,
	init: { headers?: Record<string, string>; body?: string | URLSearchParams } = {},
): Promise<Reply> {
	const res = await fetch(url, {
		method,
		headers: init.headers,
		body: init.body,
		signal: AbortSignal.timeout(15_000),
	});
	const text = await res.text();
	try {
		return { status: res.status, body: text ? JSON.parse(text) : null };
	} catch {
		return { status: res.status, body: text };
	}
}

const field = (body: unknown, name: string): string | undefined => {
	if (body !== null && typeof body === 'object' && name in body) {
		const v = (body as Record<string, unknown>)[name];
		if (typeof v === 'string' || typeof v === 'number') return String(v);
	}
	return undefined;
};

const rowsOf = (body: unknown): unknown[] =>
	Array.isArray(body)
		? body
		: body !== null &&
			  typeof body === 'object' &&
			  Array.isArray((body as { results?: unknown }).results)
			? (body as { results: unknown[] }).results
			: [];

// ---------------------------------------------------------------- Plane

type PlaneSession = { root: string; auth: Record<string, string>; probe: Probe };

async function planeSession(
	p: Probe,
	tenant: string,
	scopes: string[],
	env: Env,
): Promise<PlaneSession | null> {
	const v = need(env, [
		'PLANE_HOOKS_PLANE_URL',
		`PLANE_HOOKS_${tenant.toUpperCase()}_PLANE_SECRET`,
		'PROBE_PLANE_CLIENT_ID',
		'PROBE_PLANE_INSTALLATION_ID',
		'PROBE_WORKSPACE',
	]);
	const url = (v.PLANE_HOOKS_PLANE_URL as string).replace(/\/+$/, '');
	const basic = Buffer.from(
		`${v.PROBE_PLANE_CLIENT_ID}:${v[`PLANE_HOOKS_${tenant.toUpperCase()}_PLANE_SECRET`]}`,
	).toString('base64');
	const reply = await send('POST', `${url}/auth/o/token/`, {
		headers: {
			Authorization: `Basic ${basic}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			app_installation_id: v.PROBE_PLANE_INSTALLATION_ID as string,
			scope: scopes.join(' '),
		}),
	});
	const token = field(reply.body, 'access_token');
	p.report('plane-token', {
		status: reply.status,
		body: {
			scopes,
			token: token === undefined ? undefined : token,
			error: field(reply.body, 'error'),
			expires_in: field(reply.body, 'expires_in'),
		},
	});
	if (token === undefined) return null;
	return {
		root: `${url}/api/v1/workspaces/${encodeURIComponent(v.PROBE_WORKSPACE as string)}`,
		auth: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		probe: p,
	};
}

async function planeProject(s: PlaneSession, env: Env): Promise<string | null> {
	const identifier = need(env, ['PROBE_PROJECT_IDENTIFIER']).PROBE_PROJECT_IDENTIFIER;
	const projects = await send('GET', `${s.root}/projects/`, { headers: s.auth });
	const rows = rowsOf(projects.body);
	s.probe.report('plane-projects', {
		status: projects.status,
		body: { count: rows.length, identifiers: rows.map((r) => field(r, 'identifier')) },
	});
	return (
		rows
			.map((r) => ({ id: field(r, 'id'), identifier: field(r, 'identifier') }))
			.find((r) => r.identifier === identifier)?.id ?? null
	);
}

async function planeToken(p: Probe, tenant: string, extra: string[], env: Env): Promise<void> {
	const s = await planeSession(p, tenant, [...BASE_SCOPES, ...extra], env);
	if (s === null) return;
	const project = await planeProject(s, env);
	if (project === null)
		return p.report('plane-states', {
			status: 0,
			body: 'project not found by PROBE_PROJECT_IDENTIFIER',
		});
	const states = await send('GET', `${s.root}/projects/${project}/states/`, { headers: s.auth });
	const rows = rowsOf(states.body);
	p.report('plane-states', {
		status: states.status,
		body: {
			count: rows.length,
			hasSequence: rows.length > 0 && rows.every((r) => field(r, 'sequence') !== undefined),
			stateKeys: rows.length > 0 ? Object.keys(rows[0] as object).sort() : [],
			groups: rows.map((r) => ({ group: field(r, 'group'), sequence: field(r, 'sequence') })),
		},
	});
}

async function planeRelease(
	p: Probe,
	tenant: string,
	candidates: string[],
	env: Env,
): Promise<void> {
	const s = await planeSession(p, tenant, [...BASE_SCOPES, ...candidates], env);
	if (s === null) return;
	const project = await planeProject(s, env);
	if (project === null)
		return p.report('plane-release-create', {
			status: 0,
			body: 'project not found by PROBE_PROJECT_IDENTIFIER',
		});
	const stamp = new Date().toISOString();
	let itemId: string | undefined;
	let releaseId: string | undefined;
	try {
		const item = await send('POST', `${s.root}/projects/${project}/work-items/`, {
			headers: s.auth,
			body: JSON.stringify({
				name: `probe ${stamp}`,
				external_source: 'probe',
				external_id: `probe-${stamp}`,
			}),
		});
		itemId = field(item.body, 'id');
		p.report('plane-item-create', { status: item.status, body: { id: itemId } });
		const release = await send('POST', `${s.root}/releases/`, {
			headers: s.auth,
			body: JSON.stringify({
				name: `probe ${stamp}`,
				status: 'released',
				external_source: 'probe',
				external_id: `probe-${stamp}`,
			}),
		});
		releaseId = field(release.body, 'id');
		p.report('plane-release-create', release);
		if (releaseId !== undefined && itemId !== undefined) {
			p.report(
				'plane-release-attach',
				await send('POST', `${s.root}/releases/${releaseId}/work-items/`, {
					headers: s.auth,
					body: JSON.stringify({ work_item_ids: [itemId] }),
				}),
			);
		}
	} finally {
		if (releaseId !== undefined) {
			p.report(
				'plane-release-delete',
				await send('DELETE', `${s.root}/releases/${releaseId}/`, { headers: s.auth }),
			);
		}
		if (itemId !== undefined) {
			p.report(
				'plane-item-delete',
				await send('DELETE', `${s.root}/projects/${project}/work-items/${itemId}/`, {
					headers: s.auth,
				}),
			);
		}
	}
}

// ---------------------------------------------------------------- GitHub

const GITHUB = 'https://api.github.com';
const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

/** GitHub App JWT (RS256), valid for ten minutes. */
export function appJwt(appId: string, privateKeyPem: string, nowSeconds: number): string {
	const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const claims = b64url(
		JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }),
	);
	const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(privateKeyPem);
	return `${head}.${claims}.${b64url(signature)}`;
}

function githubHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'plane-hooks-probe',
	};
}

function jwtFromEnv(app: string, env: Env): string {
	const upper = app.toUpperCase();
	const v = need(env, [`PLANE_HOOKS_GH_${upper}_PRIVATE_KEY`, `PROBE_GH_${upper}_APP_ID`]);
	const pem = Buffer.from(v[`PLANE_HOOKS_GH_${upper}_PRIVATE_KEY`] as string, 'base64').toString(
		'utf8',
	);
	return appJwt(v[`PROBE_GH_${upper}_APP_ID`] as string, pem, Math.floor(Date.now() / 1000));
}

async function ghToken(p: Probe, app: string, env: Env): Promise<void> {
	const jwt = jwtFromEnv(app, env);
	p.report('gh-app', await send('GET', `${GITHUB}/app`, { headers: githubHeaders(jwt) }));
	const installations = await send('GET', `${GITHUB}/app/installations`, {
		headers: githubHeaders(jwt),
	});
	p.report('gh-installations', installations);
	const first = rowsOf(installations.body)[0];
	const id = field(first, 'id');
	if (id === undefined) return;
	p.report(
		'gh-installation-token',
		await send('POST', `${GITHUB}/app/installations/${id}/access_tokens`, {
			headers: githubHeaders(jwt),
		}),
	);
}

/** Installation token for the repository, or null (the step is reported). */
async function repoToken(p: Probe, app: string, repo: string, env: Env): Promise<string | null> {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new UsageError('repository must be owner/name');
	const jwt = jwtFromEnv(app, env);
	const inst = await send('GET', `${GITHUB}/repos/${repo}/installation`, {
		headers: githubHeaders(jwt),
	});
	const id = field(inst.body, 'id');
	if (id === undefined) {
		p.report('gh-repo-installation', inst);
		return null;
	}
	const res = await send('POST', `${GITHUB}/app/installations/${id}/access_tokens`, {
		headers: githubHeaders(jwt),
	});
	const token = field(res.body, 'token');
	if (token === undefined) p.report('gh-repo-token', res);
	return token ?? null;
}

async function ghGet(
	p: Probe,
	step: string,
	app: string,
	repo: string,
	path: string,
	env: Env,
): Promise<Reply | null> {
	const token = await repoToken(p, app, repo, env);
	if (token === null) return null;
	const reply = await send('GET', `${GITHUB}/repos/${repo}${path}`, {
		headers: githubHeaders(token),
	});
	p.report(step, reply);
	return reply;
}

async function ghDeployments(
	p: Probe,
	app: string,
	repo: string,
	environment: string | undefined,
	env: Env,
): Promise<void> {
	const query = new URLSearchParams({ per_page: '30' });
	if (environment !== undefined) query.set('environment', environment);
	const list = await ghGet(p, 'gh-deployments', app, repo, `/deployments?${query}`, env);
	if (list === null) return;
	const token = await repoToken(p, app, repo, env);
	if (token === null) return;
	const withStatuses = [];
	for (const d of rowsOf(list.body)) {
		const id = field(d, 'id');
		const statuses =
			id === undefined
				? null
				: await send('GET', `${GITHUB}/repos/${repo}/deployments/${id}/statuses?per_page=5`, {
						headers: githubHeaders(token),
					});
		withStatuses.push({ deployment: d, statuses: statuses?.body ?? null });
	}
	p.report('gh-deployments-statuses', { status: list.status, body: withStatuses });
}

async function ghDeploy(
	p: Probe,
	app: string,
	repo: string,
	sha: string,
	environment: string,
	env: Env,
): Promise<void> {
	const token = await repoToken(p, app, repo, env);
	if (token === null) return;
	const h = { ...githubHeaders(token), 'Content-Type': 'application/json' };
	const created = await send('POST', `${GITHUB}/repos/${repo}/deployments`, {
		headers: h,
		body: JSON.stringify({
			ref: sha,
			environment,
			auto_merge: false,
			required_contexts: [],
			transient_environment: true,
			description: 'plane-hooks probe',
		}),
	});
	p.report('gh-deploy-create', created);
	const id = field(created.body, 'id');
	if (id === undefined) return;
	try {
		for (const state of ['success', 'inactive']) {
			p.report(
				`gh-deploy-status-${state}`,
				await send('POST', `${GITHUB}/repos/${repo}/deployments/${id}/statuses`, {
					headers: h,
					body: JSON.stringify({ state, environment }),
				}),
			);
		}
	} finally {
		p.report(
			'gh-deploy-delete',
			await send('DELETE', `${GITHUB}/repos/${repo}/deployments/${id}`, { headers: h }),
		);
	}
}

// ---------------------------------------------------------------- main

export async function run(argv: string[], env: Env): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			tenant: { type: 'string' },
			app: { type: 'string' },
			scope: { type: 'string', multiple: true },
			env: { type: 'string' },
			out: { type: 'string' },
			help: { type: 'boolean' },
		},
	});
	const [command, a, b, c] = positionals;
	if (values.help || command === undefined) {
		console.log(USAGE);
		return command === undefined && !values.help ? 2 : 0;
	}
	const p = new Probe(values.out);
	switch (command) {
		case 'plane-token':
			await planeToken(p, idOf(values.tenant, '--tenant'), values.scope ?? [], env);
			break;
		case 'plane-release':
			if ((values.scope ?? []).length === 0)
				throw new UsageError('plane-release needs --scope <candidate>');
			await planeRelease(p, idOf(values.tenant, '--tenant'), values.scope ?? [], env);
			break;
		case 'gh-token':
			await ghToken(p, idOf(values.app, '--app'), env);
			break;
		case 'gh-compare':
			if (a === undefined || b === undefined || c === undefined) throw new UsageError(USAGE);
			await ghGet(
				p,
				'gh-compare',
				idOf(values.app, '--app'),
				a,
				`/compare/${encodeURIComponent(b)}...${encodeURIComponent(c)}`,
				env,
			);
			break;
		case 'gh-pulls':
			if (a === undefined || b === undefined) throw new UsageError(USAGE);
			await ghGet(
				p,
				'gh-pulls',
				idOf(values.app, '--app'),
				a,
				`/commits/${encodeURIComponent(b)}/pulls`,
				env,
			);
			break;
		case 'gh-deployments':
			if (a === undefined) throw new UsageError(USAGE);
			await ghDeployments(p, idOf(values.app, '--app'), a, values.env, env);
			break;
		case 'gh-deploy':
			if (a === undefined || b === undefined || values.env !== 'probe')
				throw new UsageError('gh-deploy <owner/repo> <sha> --env probe');
			await ghDeploy(p, idOf(values.app, '--app'), a, b, values.env, env);
			break;
		default:
			throw new UsageError(USAGE);
	}
	return p.failed > 0 ? 1 : 0;
}

if (import.meta.main) {
	try {
		process.exit(await run(process.argv.slice(2), process.env));
	} catch (err) {
		console.error(
			err instanceof UsageError ? err.message : `${(err as Error).name}: ${(err as Error).message}`,
		);
		process.exit(err instanceof UsageError ? 2 : 1);
	}
}
