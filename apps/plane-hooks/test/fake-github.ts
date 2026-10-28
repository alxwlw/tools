import type {
	Commit,
	Comparison,
	Deployment,
	DeploymentState,
	GitHubApi,
	Pull,
} from '../src/github/client.ts';

const COMPARE_MAX_COMMITS = 250;

type StoredDeployment = Deployment & { states: DeploymentState[] };

/**
 * In-memory GitHub: a commit graph (shared by all repos), pulls and deployments.
 * `calls` logs every API call as `<method> <repo> <args>`.
 */
export class FakeGitHub implements GitHubApi {
	readonly calls: string[] = [];
	readonly #commits = new Map<string, { parents: string[]; message: string }>();
	readonly #pulls = new Map<string, Pull>();
	/** Branch commits of merged PRs: GitHub reports the PR for them too, not only for the merge commit. */
	readonly #branchCommits = new Map<string, string[]>();
	readonly #deployments: StoredDeployment[] = [];
	#nextDeploymentId = 1;

	commit(sha: string, parents: string[], message: string): this {
		this.#commits.set(sha, { parents, message });
		return this;
	}

	/** A commit gone after a force-push; its children keep pointing at it. */
	removeCommit(sha: string): this {
		this.#commits.delete(sha);
		return this;
	}

	pull(p: Partial<Pull> & { repo: string; number: number }): this {
		this.#pulls.set(`${p.repo}#${p.number}`, {
			url: `https://github.com/${p.repo}/pull/${p.number}`,
			title: `PR ${p.number}`,
			body: '',
			head: `branch-${p.number}`,
			base: 'main',
			draft: false,
			state: 'open',
			merged: false,
			mergeSha: null,
			...p,
		});
		return this;
	}

	/** `branchCommits` — commits of the PR's branch that reached the base with it (a merge commit, not a squash). */
	mergePull(repo: string, number: number, mergeSha: string, branchCommits: string[] = []): this {
		const pull = this.#pulls.get(`${repo}#${number}`);
		if (!pull) throw new Error(`FakeGitHub: no pull ${repo}#${number}`);
		this.#branchCommits.set(`${repo}#${number}`, branchCommits);
		this.#pulls.set(`${repo}#${number}`, { ...pull, state: 'closed', merged: true, mergeSha });
		return this;
	}

	deploy(
		repo: string,
		environment: string,
		sha: string,
		state: DeploymentState,
		creator = 'github-actions[bot]',
	): number {
		const id = this.#nextDeploymentId++;
		this.#deployments.push({
			id,
			repo,
			sha,
			environment,
			creator,
			description: null,
			states: [state],
		});
		return id;
	}

	async getPull(repo: string, number: number): Promise<Pull | null> {
		this.calls.push(`getPull ${repo}#${number}`);
		const pull = this.#pulls.get(`${repo}#${number}`);
		return pull ? { ...pull } : null;
	}

	/** Merged PRs whose merge commit is `sha` or that carry `sha` on their branch (like `commits/{sha}/pulls`). */
	async mergedPullsForCommit(repo: string, sha: string): Promise<Pull[]> {
		this.calls.push(`mergedPullsForCommit ${repo} ${sha}`);
		return [...this.#pulls.entries()]
			.filter(
				([key, p]) =>
					p.repo === repo &&
					p.merged &&
					(p.mergeSha === sha || (this.#branchCommits.get(key) ?? []).includes(sha)),
			)
			.map(([, p]) => ({ ...p }));
	}

	async openPullsForBranch(repo: string, branch: string): Promise<Pull[]> {
		this.calls.push(`openPullsForBranch ${repo} ${branch}`);
		return [...this.#pulls.values()]
			.filter((p) => p.repo === repo && p.state === 'open' && p.head === branch)
			.map((p) => ({ ...p }));
	}

	/** Like GitHub: `commits` are the head's commits missing from base, oldest first; a missing sha → null. */
	async compare(repo: string, base: string, head: string): Promise<Comparison | null> {
		this.calls.push(`compare ${repo} ${base}...${head}`);
		if (!this.#commits.has(base) || !this.#commits.has(head)) return null;
		const baseSide = this.#ancestors(base);
		const headSide = this.#ancestors(head);
		const status: Comparison['status'] =
			base === head
				? 'identical'
				: baseSide.has(head)
					? 'behind'
					: headSide.has(base)
						? 'ahead'
						: 'diverged';
		const commits: Commit[] = status === 'behind' ? [] : this.#oldestFirst(head, baseSide);
		return {
			status,
			commits: commits.slice(0, COMPARE_MAX_COMMITS),
			truncated: commits.length > COMPARE_MAX_COMMITS,
		};
	}

	async listDeployments(repo: string, environment: string, limit: number): Promise<Deployment[]> {
		this.calls.push(`listDeployments ${repo} ${environment} ${limit}`);
		return this.#deployments
			.filter((d) => d.repo === repo && d.environment === environment)
			.sort((a, b) => b.id - a.id)
			.slice(0, limit)
			.map(({ states: _states, ...deployment }) => deployment);
	}

	async latestState(repo: string, deploymentId: number): Promise<DeploymentState | null> {
		this.calls.push(`latestState ${repo} ${deploymentId}`);
		return this.#find(repo, deploymentId).states.at(-1) ?? null;
	}

	async createDeployment(
		repo: string,
		input: { sha: string; environment: string; description: string },
	): Promise<number> {
		this.calls.push(`createDeployment ${repo} ${input.environment} ${input.sha}`);
		const id = this.#nextDeploymentId++;
		this.#deployments.push({
			id,
			repo,
			sha: input.sha,
			environment: input.environment,
			creator: 'plane-hooks[bot]',
			description: input.description,
			states: [],
		});
		return id;
	}

	async createDeploymentStatus(
		repo: string,
		deploymentId: number,
		state: 'success' | 'failure',
		logUrl: string | null,
	): Promise<void> {
		this.calls.push(`createDeploymentStatus ${repo} ${deploymentId} ${state} ${logUrl ?? '-'}`);
		this.#find(repo, deploymentId).states.push(state);
	}

	#find(repo: string, id: number): StoredDeployment {
		const found = this.#deployments.find((d) => d.repo === repo && d.id === id);
		if (!found) throw new Error(`FakeGitHub: no deployment ${repo}#${id}`);
		return found;
	}

	/** `sha` and everything reachable through parents that still exist. */
	#ancestors(sha: string): Set<string> {
		const seen = new Set<string>();
		const stack = [sha];
		while (stack.length > 0) {
			const current = stack.pop() as string;
			const node = this.#commits.get(current);
			if (node === undefined || seen.has(current)) continue;
			seen.add(current);
			stack.push(...node.parents);
		}
		return seen;
	}

	/** Commits reachable from `head` and not in `exclude`, parents before children. */
	#oldestFirst(head: string, exclude: Set<string>): Commit[] {
		const out: Commit[] = [];
		const seen = new Set<string>(exclude);
		const visit = (sha: string) => {
			const node = this.#commits.get(sha);
			if (node === undefined || seen.has(sha)) return;
			seen.add(sha);
			for (const parent of node.parents) visit(parent);
			out.push({ sha, message: node.message });
		};
		visit(head);
		return out;
	}
}
