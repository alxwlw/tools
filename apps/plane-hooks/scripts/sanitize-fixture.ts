// Turns a captured GitHub, Vercel or Dokploy delivery (or an API response) into a committable
// fixture `{headers, body}`: owners, repositories, people, ids, shas, emails and hosts are replaced.
// Run: bun scripts/sanitize-fixture.ts <github|vercel|dokploy> <file> [--capture] > fixture.json
// With --capture <file> is the `N-<hash>.json` metadata of scripts/capture.ts (its `.bin` sits beside);
// without it <file> is a plain JSON body (an API response) and the headers are empty.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export type Fixture = { headers: Record<string, string>; body: unknown };

type Leaf = string | number;
/** Returns the replacement of a leaf, or undefined to leave it to the generic rules. */
type LeafRule = (
	value: Leaf,
	key: string | undefined,
	parent: string | undefined,
) => Leaf | undefined;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/g;
const SHA = /(?<![0-9a-fA-F])[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const AVATAR = /avatars\.githubusercontent\.com\/u\/\d+/g;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Deterministic fake sha: the same input gives the same output, in any run. */
export const fakeSha = (sha: string): string =>
	createHash('sha256').update(sha.toLowerCase()).digest('hex').slice(0, 40);

/** The n-th distinct value gets n (from 1); the same value always gets the same n. */
function numbering(): (value: string | number) => number {
	const seen = new Map<string, number>();
	return (value) => {
		const key = String(value).toLowerCase();
		let n = seen.get(key);
		if (n === undefined) {
			n = seen.size + 1;
			seen.set(key, n);
		}
		return n;
	};
}

/** Alternation of literals, longest first, matched case-insensitively and not inside a longer word. */
function literalsRegExp(values: Iterable<string>): RegExp | null {
	const parts = [...values]
		.filter((v) => v !== '')
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp);
	return parts.length === 0
		? null
		: new RegExp(`(?<![A-Za-z0-9-])(?:${parts.join('|')})(?![A-Za-z0-9-])`, 'gi');
}

/** Rebuilds `node` with every leaf passed through `rule` (array elements keep the key of the array). */
function mapLeaves(node: unknown, rule: LeafRule, key?: string, parent?: string): unknown {
	if (Array.isArray(node)) return node.map((x) => mapLeaves(x, rule, key, parent));
	if (node !== null && typeof node === 'object') {
		return Object.fromEntries(
			Object.entries(node).map(([k, v]) => [k, mapLeaves(v, rule, k, key)]),
		);
	}
	if (typeof node === 'string' || typeof node === 'number') return rule(node, key, parent) ?? node;
	return node;
}

function eachLeaf(
	node: unknown,
	visit: (value: Leaf, key: string | undefined) => void,
	key?: string,
): void {
	if (Array.isArray(node)) for (const x of node) eachLeaf(x, visit, key);
	else if (node !== null && typeof node === 'object') {
		for (const [k, v] of Object.entries(node)) eachLeaf(v, visit, k);
	} else if (typeof node === 'string' || typeof node === 'number') visit(node, key);
}

// ---------------------------------------------------------------- GitHub

/**
 * Owner and repository -> `acme/api` (every further repository `acme/repoN`), logins -> `octocat`
 * (further ones `octocatN`; a login that owns a repository becomes `acme`), `id` -> a sequence,
 * `node_id` -> `<N>_kwDOexample`, shas -> a deterministic fake, emails -> `octocat@example.com`.
 */
export function sanitizeGithub(value: unknown): unknown {
	const repos = new Map<string, string>();
	const owners = new Set<string>();
	const logins = new Set<string>();
	const repoNames = new Map<string, string>();
	eachLeaf(value, (v, key) => {
		if (typeof v !== 'string') return;
		const full = key === 'full_name' ? /^([^/\s]+)\/([^/\s]+)$/.exec(v) : null;
		if (full?.[1] !== undefined && full[2] !== undefined && !repos.has(v.toLowerCase())) {
			const n = repoNames.size + 1;
			const name = repoNames.get(full[2].toLowerCase()) ?? (n === 1 ? 'api' : `repo${n}`);
			repoNames.set(full[2].toLowerCase(), name);
			repos.set(v.toLowerCase(), `acme/${name}`);
			owners.add(full[1].toLowerCase());
		}
		if (key === 'login') logins.add(v);
	});
	const people = new Map<string, string>();
	for (const login of logins) {
		if (owners.has(login.toLowerCase())) continue;
		if (!people.has(login.toLowerCase())) {
			const n = people.size + 1;
			people.set(login.toLowerCase(), n === 1 ? 'octocat' : `octocat${n}`);
		}
	}
	const names = new Map<string, string>([...repos].map(([k, v]) => [k, v]));
	for (const o of owners) names.set(o, 'acme');
	for (const [k, v] of people) names.set(k, v);
	const literals = literalsRegExp(names.keys());
	const ids = numbering();
	const nodeIds = numbering();

	const text = (s: string): string => {
		let out = s.replace(EMAIL, 'octocat@example.com');
		if (literals) out = out.replace(literals, (m) => names.get(m.toLowerCase()) ?? m);
		return out.replace(SHA, fakeSha).replace(AVATAR, 'avatars.githubusercontent.com/u/1');
	};
	return mapLeaves(value, (v, key) => {
		if (key === 'id' && typeof v === 'number') return ids(v);
		if (key === 'node_id' && typeof v === 'string') return `${nodeIds(v)}_kwDOexample`;
		if (key === 'name' && typeof v === 'string') return repoNames.get(v.toLowerCase()) ?? text(v);
		return typeof v === 'string' ? text(v) : undefined;
	});
}

// ---------------------------------------------------------------- Vercel

/**
 * Vercel webhook: `meta.githubCommit*` / `githubOrg` / `githubRepo`, deployment, project, team and
 * user ids, `*.vercel.app` hosts and `vercel.com/<team>/<project>` links.
 */
export function sanitizeVercel(value: unknown): unknown {
	const projects = numbering();
	const logins = numbering();
	const vercelIds = new Map<string, ReturnType<typeof numbering>>();
	const userIds = numbering();
	const hosts = numbering();
	const repos = numbering();
	const orgIds = numbering();
	const projectName = (name: string): string => `app${projects(name)}`;
	const text = (s: string): string =>
		s
			.replace(EMAIL, 'octocat@example.com')
			.replace(SHA, fakeSha)
			.replace(/\b(dpl|prj|team)_[A-Za-z0-9]+/g, (m, prefix: string) => {
				let n = vercelIds.get(prefix);
				if (n === undefined) vercelIds.set(prefix, (n = numbering()));
				return `${prefix}_example${n(m)}`;
			})
			.replace(/[a-z0-9-]+\.vercel\.app/gi, (m) => `deployment-${hosts(m)}.vercel.app`)
			.replace(
				/vercel\.com\/([^/\s"]+)(?:\/([^/\s"]+))?/g,
				(_m, _team: string, project?: string) =>
					project === undefined ? 'vercel.com/acme' : `vercel.com/acme/${projectName(project)}`,
			);
	return mapLeaves(value, (v, key, parent) => {
		if (typeof v !== 'string') return undefined;
		switch (key) {
			case 'githubCommitOrg':
			case 'githubOrg':
				return 'acme';
			case 'githubCommitRepo':
			case 'githubRepo':
				return repos(v) === 1 ? 'api' : `repo${repos(v)}`;
			case 'githubCommitSha':
				return fakeSha(v);
			case 'githubCommitAuthorLogin':
				return `octocat${logins(v) === 1 ? '' : logins(v)}`;
			case 'githubCommitAuthorName':
				return 'Octo Cat';
			case 'githubCommitMessage':
				return 'Example commit message';
			case 'githubOrgId':
			case 'githubRepoId':
			case 'githubCommitOrgId':
			case 'githubCommitRepoId':
				return String(orgIds(`${key}:${v}`));
		}
		if ((parent === 'team' && (key === 'name' || key === 'slug')) || key === 'teamSlug')
			return 'acme';
		if ((parent === 'deployment' || parent === 'project') && key === 'name') return projectName(v);
		if (key === 'id' && (parent === 'user' || parent === 'team') && !/^(dpl|prj|team)_/.test(v)) {
			return `user_example${userIds(v)}`;
		}
		return text(v);
	});
}

// ---------------------------------------------------------------- Dokploy

/**
 * Dokploy notification body: project, application and domain names, commit and repository fields,
 * error text. Extended against real deliveries (plan Task 1, Step 8).
 */
export function sanitizeDokploy(value: unknown): unknown {
	const apps = numbering();
	const projects = numbering();
	const domains = numbering();
	const repos = numbering();
	const text = (s: string): string =>
		s
			.replace(EMAIL, 'octocat@example.com')
			.replace(SHA, fakeSha)
			.replace(/https?:\/\/[^\s/"']+/g, (m) => `https://${`host${domains(m)}`}.example.com`);
	return mapLeaves(value, (v, key) => {
		if (typeof v !== 'string' || key === undefined) return undefined;
		if (/^(application|app|service|compose|database)Name$/i.test(key))
			return `example-app-${apps(v)}`;
		if (/^project(Name)?$/i.test(key)) return `example-project-${projects(v)}`;
		if (/^domains?$/i.test(key)) return `app${domains(v)}.example.com`;
		if (/^(repository|repo)$/i.test(key))
			return `acme/${repos(v) === 1 ? 'api' : `repo${repos(v)}`}`;
		if (/^owner$/i.test(key)) return 'acme';
		if (/commit.*(hash|sha|id)$|^(hash|sha)$/i.test(key)) return fakeSha(v);
		if (/commit.*message$/i.test(key)) return 'Example commit message';
		if (/^(error|errorMessage|buildLog|log)$/i.test(key)) return 'Example error message';
		return text(v);
	});
}

// ---------------------------------------------------------------- headers and CLI

const SANITIZERS = {
	github: sanitizeGithub,
	vercel: sanitizeVercel,
	dokploy: sanitizeDokploy,
} as const;
export type Kind = keyof typeof SANITIZERS;

/** Delivery headers worth keeping, with ids made fake; signatures and user agents are dropped (tests re-sign). */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const key = name.toLowerCase();
		if (key.startsWith('x-hub-signature') || key === 'x-vercel-signature' || key === 'user-agent')
			continue;
		if (key === 'x-github-delivery') {
			const h = createHash('sha256').update(value).digest('hex');
			out[key] =
				`${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
		} else if (key === 'x-github-hook-id') out[key] = '1';
		else if (key === 'x-github-hook-installation-target-id') out[key] = '1000001';
		else out[key] = value;
	}
	return out;
}

const USAGE = 'usage: bun scripts/sanitize-fixture.ts <github|vercel|dokploy> <file> [--capture]';

/** Returns the fixture JSON for `argv` (without bun/script). */
export function cli(argv: string[]): string {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { capture: { type: 'boolean' } },
	});
	const [kind, file] = positionals;
	if (kind === undefined || file === undefined || !(kind in SANITIZERS)) throw new Error(USAGE);
	const sanitize = SANITIZERS[kind as Kind];
	let headers: Record<string, string> = {};
	let raw: string;
	if (values.capture) {
		const meta = JSON.parse(readFileSync(file, 'utf8')) as { headers?: Record<string, string> };
		headers = sanitizeHeaders(meta.headers ?? {});
		raw = readFileSync(file.replace(/\.json$/, '.bin'), 'utf8');
	} else raw = readFileSync(file, 'utf8');
	const fixture: Fixture = { headers, body: sanitize(JSON.parse(raw)) };
	return `${JSON.stringify(fixture, null, 2)}\n`;
}

if (import.meta.main) {
	try {
		process.stdout.write(cli(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(2);
	}
}
