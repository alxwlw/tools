import { matchRepo, type Tenant } from '../config.ts';
import { esc, link, p, truncate } from '../html.ts';
import type { IncidentSignal } from '../incident.ts';
import type { GitHubEvent } from './webhook.ts';

const TITLE_MAX = 200;

/**
 * A failed GitHub deployment is one incident per repo and environment (`deploy:<repo>:<env>`);
 * the next successful one resolves it. Only environments listed in the repo's rule count, and a
 * Vercel-created deployment is skipped when the tenant's Vercel input reports it on its own.
 */
export function deploymentSignal(
	event: Extract<GitHubEvent, { kind: 'deployment_status' }>,
	tenant: Tenant,
	now: () => Date = () => new Date(),
): IncidentSignal | null {
	const { deployment, state } = event;
	if (state !== 'failure' && state !== 'error' && state !== 'success') return null;
	if (deployment.creator === 'vercel[bot]' && tenant.inputs.vercel !== null) return null;
	const rule = matchRepo(tenant.delivery?.repos ?? [], deployment.repo);
	const environment = rule?.environments.find((env) => env.name === deployment.environment);
	if (!environment) return null;

	const key = `deploy:${deployment.repo}:${environment.name}`;
	const sha7 = deployment.sha.slice(0, 7);
	const at = now().toISOString();
	if (state === 'success') {
		return {
			status: 'resolved',
			source: 'github',
			key,
			at,
			noteHtml: p(`Деплой снова проходит: <code>${esc(sha7)}</code>`),
		};
	}
	const commitUrl = `https://github.com/${deployment.repo}/commit/${deployment.sha}`;
	const logLink = link(event.logUrl, 'Лог деплоя');
	return {
		status: 'firing',
		source: 'github',
		key,
		occurrence: String(deployment.id),
		at,
		title: truncate(`Деплой упал: ${deployment.repo} → ${environment.name} · ${sha7}`, TITLE_MAX),
		bodyHtml: [
			p(
				`Репозиторий: <code>${esc(deployment.repo)}</code>, окружение: <code>${esc(environment.name)}</code>`,
			),
			p(`Коммит: ${link(commitUrl, sha7) ?? `<code>${esc(sha7)}</code>`}`),
			...(logLink ? [p(logLink)] : []),
		].join(''),
		noteHtml: p(`Деплой упал: <code>${esc(sha7)}</code>${logLink ? `, ${logLink}` : ''}`),
		priority: environment.release ? 'urgent' : 'high',
		label: 'deploy-failed',
		env: environment.name,
	};
}
