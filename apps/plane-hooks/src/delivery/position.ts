import type { DeliveryConfig, RepoRule } from '../config.ts';
import type { Pull } from '../github/client.ts';
import type { StateSummary } from '../plane.ts';
import { stateByName } from './states.ts';

type Renames = Readonly<Record<string, string | null>>;

/** review — index 0; every later step is the next element of the chain. */
export function chainFor(rule: RepoRule, delivery: DeliveryConfig): string[] {
	if (rule.environments.length === 0) return [delivery.states.review, delivery.states.done];
	return [delivery.states.review, ...rule.environments.map((env) => env.state)];
}

export type PullPosition =
	| { kind: 'draft' }
	| { kind: 'ignored' }
	| { kind: 'at'; chain: string[]; index: number };

/** `contains(env)` — the latest successful deployment of that environment of the PR's repo contains its merge commit. */
export async function pullPosition(
	pull: Pull,
	rule: RepoRule,
	delivery: DeliveryConfig,
	contains: (environment: string) => Promise<boolean>,
): Promise<PullPosition> {
	const chain = chainFor(rule, delivery);
	if (pull.state === 'open')
		return pull.draft ? { kind: 'draft' } : { kind: 'at', chain, index: 0 };
	if (!pull.merged) return { kind: 'ignored' };
	if (rule.environments.length === 0) return { kind: 'at', chain, index: 1 };
	// Merged but the commit is unknown: nothing can be proven deployed.
	if (pull.mergeSha === null) return { kind: 'at', chain, index: 0 };
	for (let i = rule.environments.length - 1; i >= 0; i--) {
		if (await contains((rule.environments[i] as RepoRule['environments'][number]).name))
			return { kind: 'at', chain, index: i + 1 };
	}
	return { kind: 'at', chain, index: 0 };
}

/** The project's name of a chain step after its renames; null — never set there. */
function projectName(chain: readonly string[], i: number, renames: Renames): string | null {
	const name = chain[i] as string;
	return Object.hasOwn(renames, name) ? (renames[name] ?? null) : name;
}

/** Walks the chain back from `index` until a state the project has (after its renames); null — none. */
export function resolveStep(
	chain: readonly string[],
	index: number,
	renames: Renames,
	states: readonly StateSummary[],
): StateSummary | null {
	for (let i = index; i >= 0; i--) {
		const name = projectName(chain, i, renames);
		const found = name === null ? null : stateByName(states, name);
		if (found) return found;
	}
	return null;
}

/** Names of chain steps up to `index` that the project is expected to have (not renamed to null) but does not. */
export function missingSteps(
	chain: readonly string[],
	index: number,
	renames: Renames,
	states: readonly StateSummary[],
): string[] {
	const missing: string[] = [];
	for (let i = 0; i <= index; i++) {
		const name = projectName(chain, i, renames);
		if (name !== null && !stateByName(states, name)) missing.push(name);
	}
	return missing;
}
