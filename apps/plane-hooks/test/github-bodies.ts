// GitHub REST (API version 2022-11-28) response bodies as the docs show them, trimmed to realistic fields.
// Hand-built until Task 1's captured fixtures exist; swap them in here, nowhere else.

type Json = Record<string, unknown>;

export function pullBody(over: Json = {}): Json {
	return {
		url: 'https://api.github.com/repos/acme/api/pulls/12',
		id: 1_000_012,
		html_url: 'https://github.com/acme/api/pull/12',
		number: 12,
		state: 'open',
		draft: false,
		title: 'Add retry to the uploader',
		body: 'Closes ENG-7',
		user: { login: 'octocat', id: 1 },
		head: { label: 'acme:eng-7-retry', ref: 'eng-7-retry', sha: 'a'.repeat(40) },
		base: { label: 'acme:main', ref: 'main', sha: 'b'.repeat(40) },
		merged: false,
		merged_at: null,
		// GitHub fills this with a throwaway test merge even for an unmerged PR.
		merge_commit_sha: 'c'.repeat(40),
		...over,
	};
}

export function mergedPullBody(over: Json = {}): Json {
	return pullBody({
		state: 'closed',
		merged: true,
		merged_at: '2026-10-20T10:00:00Z',
		merge_commit_sha: 'd'.repeat(40),
		...over,
	});
}

/** A row of `commits/{sha}/pulls` and `pulls?head=`: the "simple" PR has no `merged` field, only `merged_at`. */
export function pullRow(over: Json = {}): Json {
	const { merged: _merged, ...rest } = pullBody(over);
	return rest;
}

export function compareCommit(sha: string, message: string): Json {
	return {
		sha,
		node_id: `C_${sha.slice(0, 8)}`,
		commit: { message, author: { name: 'The Octocat', date: '2026-10-20T09:00:00Z' } },
		author: { login: 'octocat', id: 1 },
		parents: [],
	};
}

export function compareBody(status: string, commits: Json[], over: Json = {}): Json {
	return {
		url: 'https://api.github.com/repos/acme/api/compare/main...eng-7-retry',
		status,
		ahead_by: commits.length,
		behind_by: 0,
		total_commits: commits.length,
		commits,
		files: [],
		...over,
	};
}

export function deploymentBody(over: Json = {}): Json {
	return {
		url: 'https://api.github.com/repos/acme/api/deployments/501',
		id: 501,
		sha: 'e'.repeat(40),
		ref: 'main',
		task: 'deploy',
		environment: 'production',
		description: 'Deploy main',
		creator: { login: 'github-actions[bot]', id: 41_898_282, type: 'Bot' },
		created_at: '2026-10-20T10:05:00Z',
		production_environment: true,
		...over,
	};
}

export function deploymentStatusBody(state: string, over: Json = {}): Json {
	return {
		url: 'https://api.github.com/repos/acme/api/deployments/501/statuses/9001',
		id: 9001,
		state,
		creator: { login: 'github-actions[bot]', id: 41_898_282, type: 'Bot' },
		description: '',
		environment: 'production',
		log_url: 'https://example.com/deploys/501',
		created_at: '2026-10-20T10:06:00Z',
		...over,
	};
}

export function installationBody(id: number): Json {
	return { id, account: { login: 'acme', id: 7, type: 'Organization' }, app_id: 1_000_001 };
}

export function accessTokenBody(expiresAt: string, token = 'ghs_installationtoken'): Json {
	return {
		token,
		expires_at: expiresAt,
		permissions: { pull_requests: 'read' },
		repository_selection: 'all',
	};
}

export function appBody(): Json {
	return { id: 1_000_001, slug: 'acme-hub', name: 'acme-hub', owner: { login: 'acme', id: 7 } };
}

export function deliveryBody(deliveredAt: string, statusCode: number | null, id = 1): Json {
	return {
		id,
		guid: `0b989ba4-242f-11e5-81e1-c7b6966d2516-${id}`,
		delivered_at: deliveredAt,
		redelivery: false,
		duration: 0.27,
		status: statusCode === null ? 'timed out' : statusCode < 400 ? 'OK' : 'Invalid HTTP Response',
		status_code: statusCode,
		event: 'pull_request',
		action: 'opened',
		installation_id: 7,
		repository_id: 100,
	};
}
