import type { Fetch } from '@alxwlw/plane-app';

import { isRecord } from '../payload.ts';

export type Pull = {
	repo: string; // owner/name
	number: number;
	url: string; // https://github.com/<repo>/pull/<n>
	title: string;
	body: string;
	head: string; // branch name
	base: string;
	draft: boolean;
	state: 'open' | 'closed';
	merged: boolean;
	mergeSha: string | null;
};
export type Commit = { sha: string; message: string };
export type Comparison = {
	status: 'ahead' | 'behind' | 'identical' | 'diverged';
	commits: Commit[];
	truncated: boolean;
};
export type Deployment = {
	id: number;
	repo: string;
	sha: string;
	environment: string;
	creator: string;
	description: string | null;
};
export type DeploymentState =
	| 'success'
	| 'failure'
	| 'error'
	| 'inactive'
	| 'in_progress'
	| 'queued'
	| 'pending';

export interface GitHubApi {
	getPull(repo: string, number: number): Promise<Pull | null>; // 404 → null
	/** Merged PRs that brought the commit in (`commits/{sha}/pulls`, merged only); a sha that is gone (404/422) → []. */
	mergedPullsForCommit(repo: string, sha: string): Promise<Pull[]>;
	openPullsForBranch(repo: string, branch: string): Promise<Pull[]>;
	/** 404/422 (a sha gone after force-push) → null. At most 250 commits; more → truncated: true. */
	compare(repo: string, base: string, head: string): Promise<Comparison | null>;
	/** Newest first, at most `limit` (pages of 100). */
	listDeployments(repo: string, environment: string, limit: number): Promise<Deployment[]>;
	latestState(repo: string, deploymentId: number): Promise<DeploymentState | null>;
	createDeployment(
		repo: string,
		input: { sha: string; environment: string; description: string },
	): Promise<number>;
	createDeploymentStatus(
		repo: string,
		deploymentId: number,
		state: 'success' | 'failure',
		logUrl: string | null,
	): Promise<void>;
}

/** The response body is never part of the error: it can echo request data. */
export class GitHubApiError extends Error {
	readonly status: number;
	readonly method: string;
	readonly path: string;

	constructor(status: number, method: string, path: string) {
		super(`GitHub ${method} ${path} → ${status}`);
		this.name = 'GitHubApiError';
		this.status = status;
		this.method = method;
		this.path = path;
	}
}

const API_ROOT = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
/** `compare` returns at most 250 commits whatever the total. */
const COMPARE_MAX_COMMITS = 250;
const DEPLOYMENT_STATES: readonly string[] = [
	'success',
	'failure',
	'error',
	'inactive',
	'in_progress',
	'queued',
	'pending',
];
/** A sha that no longer exists answers 404 or 422, depending on the endpoint. */
const GONE: readonly number[] = [404, 422];
const COMPARE_STATUSES: readonly string[] = ['ahead', 'behind', 'identical', 'diverged'];

/** How one GitHub request is authorised and sent; the bearer is a JWT (App level) or an installation token. */
export type Transport = {
	fetch: Fetch;
	bearer: () => Promise<string>;
	timeoutMs?: number;
};

export type GitHubResponse = {
	status: number;
	body: unknown;
	/** `rel="next"` of the Link header, absolute URL, or null. */
	next: string | null;
};

/** Sends one request; a non-2xx not listed in `allowed` throws GitHubApiError. `path` starts with `/`. */
export async function githubRequest(
	transport: Transport,
	method: string,
	path: string,
	body?: unknown,
	allowed: readonly number[] = [],
): Promise<GitHubResponse> {
	const token = await transport.bearer();
	const res = await transport.fetch(`${API_ROOT}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'plane-hooks',
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(transport.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	const text = await res.text();
	const cleanPath = path.split('?')[0] as string;
	if (!res.ok && !allowed.includes(res.status)) {
		throw new GitHubApiError(res.status, method, cleanPath);
	}
	let parsed: unknown = null;
	if (res.ok && text !== '') {
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error(`GitHub ${method} ${cleanPath}: response is not JSON`);
		}
	}
	const link = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '');
	return { status: res.status, body: parsed, next: link?.[1] ?? null };
}

function shape(method: string, path: string, what: string): Error {
	return new Error(`GitHub ${method} ${path}: unexpected shape (${what})`);
}

function recordAt(value: unknown, where: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`GitHub response: ${where} is not an object`);
	return value;
}

function str(rec: Record<string, unknown>, key: string, where: string): string {
	const value = rec[key];
	if (typeof value !== 'string')
		throw new Error(`GitHub response: ${where}.${key} is not a string`);
	return value;
}

function nullableText(rec: Record<string, unknown>, key: string, where: string): string | null {
	const value = rec[key];
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string')
		throw new Error(`GitHub response: ${where}.${key} is not a string`);
	return value;
}

function integer(rec: Record<string, unknown>, key: string, where: string): number {
	const value = rec[key];
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		throw new Error(`GitHub response: ${where}.${key} is not an integer`);
	}
	return value;
}

function list(value: unknown, where: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`GitHub response: ${where} is not an array`);
	return value;
}

/** Works for `pulls/{n}` and for the PR rows of list endpoints: both carry `merged_at`, only the first `merged`. */
function toPull(repo: string, value: unknown): Pull {
	const rec = recordAt(value, 'pull');
	const number = integer(rec, 'number', 'pull');
	const state = str(rec, 'state', 'pull');
	if (state !== 'open' && state !== 'closed')
		throw new Error('GitHub response: pull.state unknown');
	const merged = nullableText(rec, 'merged_at', 'pull') !== null;
	return {
		repo,
		number,
		url: `https://github.com/${repo}/pull/${number}`,
		title: str(rec, 'title', 'pull'),
		body: nullableText(rec, 'body', 'pull') ?? '',
		head: str(recordAt(rec.head, 'pull.head'), 'ref', 'pull.head'),
		base: str(recordAt(rec.base, 'pull.base'), 'ref', 'pull.base'),
		draft: rec.draft === true,
		state,
		merged,
		// merge_commit_sha of a closed unmerged PR is a throwaway test merge.
		mergeSha: merged ? nullableText(rec, 'merge_commit_sha', 'pull') : null,
	};
}

function toDeployment(repo: string, value: unknown): Deployment {
	const rec = recordAt(value, 'deployment');
	return {
		id: integer(rec, 'id', 'deployment'),
		repo,
		sha: str(rec, 'sha', 'deployment'),
		environment: str(rec, 'environment', 'deployment'),
		// GitHub's schema makes the creator nullable (a deleted account); '' never equals a login.
		creator:
			rec.creator === null
				? ''
				: str(recordAt(rec.creator, 'deployment.creator'), 'login', 'deployment.creator'),
		description: nullableText(rec, 'description', 'deployment'),
	};
}

export type GitHubClientOptions = Transport;

export function createGitHubClient(options: GitHubClientOptions): GitHubApi {
	const call = (method: string, path: string, body?: unknown, allowed: readonly number[] = []) =>
		githubRequest(options, method, path, body, allowed);
	const repoPath = (repo: string) => `/repos/${repo}`;

	return {
		async getPull(repo, number) {
			const res = await call('GET', `${repoPath(repo)}/pulls/${number}`, undefined, [404]);
			return res.status === 404 ? null : toPull(repo, res.body);
		},

		async mergedPullsForCommit(repo, sha) {
			const path = `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/pulls?per_page=${PAGE_SIZE}`;
			// 404/422: the commit is gone (force-push) — no PR brought it in.
			const res = await call('GET', path, undefined, GONE);
			if (GONE.includes(res.status)) return [];
			return list(res.body, 'pulls')
				.map((row) => toPull(repo, row))
				.filter((pull) => pull.merged);
		},

		async openPullsForBranch(repo, branch) {
			const owner = repo.split('/')[0] as string;
			const query = new URLSearchParams({
				state: 'open',
				head: `${owner}:${branch}`,
				per_page: String(PAGE_SIZE),
			});
			const res = await call('GET', `${repoPath(repo)}/pulls?${query.toString()}`);
			return list(res.body, 'pulls').map((row) => toPull(repo, row));
		},

		async compare(repo, base, head) {
			const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
			const commits: Commit[] = [];
			let status: Comparison['status'] | null = null;
			let total = 0;
			for (let page = 1; commits.length < COMPARE_MAX_COMMITS; page++) {
				const path = `${repoPath(repo)}/compare/${range}?per_page=${PAGE_SIZE}&page=${page}`;
				const res = await call('GET', path, undefined, GONE);
				if (GONE.includes(res.status)) return null;
				const rec = recordAt(res.body, 'comparison');
				const rawStatus = str(rec, 'status', 'comparison');
				if (!COMPARE_STATUSES.includes(rawStatus)) {
					throw shape('GET', 'compare', 'status');
				}
				status = rawStatus as Comparison['status'];
				total = integer(rec, 'total_commits', 'comparison');
				const rows = list(rec.commits, 'comparison.commits');
				for (const row of rows) {
					const item = recordAt(row, 'comparison.commit');
					const inner = recordAt(item.commit, 'comparison.commit.commit');
					commits.push({
						sha: str(item, 'sha', 'comparison.commit'),
						message: str(inner, 'message', 'comparison.commit.commit'),
					});
				}
				if (rows.length < PAGE_SIZE || commits.length >= total) break;
			}
			if (status === null) throw shape('GET', 'compare', 'no page');
			return { status, commits, truncated: total > commits.length };
		},

		async listDeployments(repo, environment, limit) {
			const out: Deployment[] = [];
			for (let page = 1; out.length < limit; page++) {
				const query = new URLSearchParams({
					environment,
					per_page: String(PAGE_SIZE),
					page: String(page),
				});
				const res = await call('GET', `${repoPath(repo)}/deployments?${query.toString()}`);
				const rows = list(res.body, 'deployments');
				for (const row of rows) out.push(toDeployment(repo, row));
				if (rows.length < PAGE_SIZE) break;
			}
			return out.slice(0, limit);
		},

		async latestState(repo, deploymentId) {
			const path = `${repoPath(repo)}/deployments/${deploymentId}/statuses?per_page=1`;
			const res = await call('GET', path);
			const [first] = list(res.body, 'statuses');
			if (first === undefined) return null;
			const state = str(recordAt(first, 'status'), 'state', 'status');
			if (!DEPLOYMENT_STATES.includes(state)) throw shape('GET', 'statuses', 'state');
			return state as DeploymentState;
		},

		async createDeployment(repo, input) {
			const res = await call('POST', `${repoPath(repo)}/deployments`, {
				ref: input.sha,
				environment: input.environment,
				description: input.description,
				auto_merge: false,
				required_contexts: [],
				production_environment: input.environment === 'production',
			});
			return integer(recordAt(res.body, 'deployment'), 'id', 'deployment');
		},

		async createDeploymentStatus(repo, deploymentId, state, logUrl) {
			await call('POST', `${repoPath(repo)}/deployments/${deploymentId}/statuses`, {
				state,
				...(logUrl === null ? {} : { log_url: logUrl }),
			});
		},
	};
}
