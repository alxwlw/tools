import type { Pull } from '../github/client.ts';
import { extractWorkItemKeys } from '../work-item-keys.ts';

const OWNED_MAX = 10;
const MENTIONED_MAX = 20;

/** Keys in the title and the branch: the work items the PR belongs to. */
export function ownedKeys(
	pull: Pick<Pull, 'title' | 'head'>,
	identifiers: ReadonlySet<string>,
): string[] {
	return extractWorkItemKeys([pull.title, pull.head], identifiers, OWNED_MAX);
}

/** Keys only in the description: mentioned, never moved by the PR. */
export function mentionedKeys(
	pull: Pick<Pull, 'title' | 'head' | 'body'>,
	identifiers: ReadonlySet<string>,
): string[] {
	const owned = new Set(ownedKeys(pull, identifiers));
	return extractWorkItemKeys([pull.body], identifiers, MENTIONED_MAX + OWNED_MAX)
		.filter((key) => !owned.has(key))
		.slice(0, MENTIONED_MAX);
}

export const PULL_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/;

export function pullUrl(repo: string, number: number): string {
	return `https://github.com/${repo}/pull/${number}`;
}
