import type { Pull } from '../github/client.ts';
import { esc, link, p } from '../html.ts';
import type { DeployFact } from './deploy.ts';

/** `<repo> → <environment> · <sha7>` in code tags, then the run link when the deploy has one. */
function head(label: string, fact: DeployFact): string[] {
	const parts = [
		`${label}: <code>${esc(fact.repo)}</code> → ${esc(fact.environment)}`,
		`<code>${esc(fact.sha.slice(0, 7))}</code>`,
	];
	const run = fact.logUrl === null ? null : link(fact.logUrl, 'прогон');
	if (run !== null) parts.push(run);
	return parts;
}

/** «Выкачено» on a work item: where, which commit, and the PRs of this task that were in the deploy. */
export function deployedHtml(fact: DeployFact, pulls: readonly Pull[]): string {
	const parts = head('Выкачено', fact);
	// A commit without a PR (number 0) has nothing to link: the sha above already names it.
	const prs = pulls
		.filter((pull) => pull.number > 0)
		.map((pull) => link(pull.url, `${pull.repo}#${pull.number}`))
		.filter((html) => html !== null);
	if (prs.length > 0) parts.push(`PR: ${prs.join(', ')}`);
	return p(parts.join(' · '));
}

/** «Откачено» on a work item whose PR left the environment: the environment now stands at `fact.sha`. */
export function rolledBackHtml(fact: DeployFact): string {
	return p(head('Откачено', fact).join(' · '));
}
