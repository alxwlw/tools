import { DEFAULT_PRIORITY, type PriorityTable } from './config.ts';
import { esc, link, p, truncate, utc } from './html.ts';
import type { IncidentSignal } from './incident.ts';
import { BadPayload, isRecord, isTimestamp, optString, stringMap } from './payload.ts';

const TITLE_MAX = 200;

/**
 * Grafana webhook contact point payload → one signal per entry of `alerts[]`
 * the alert fingerprint is the incident key, its
 * startsAt the occurrence. Throws BadPayload on a body Grafana would not send.
 */
export function parseGrafanaWebhook(
	body: unknown,
	table: PriorityTable = DEFAULT_PRIORITY,
): IncidentSignal[] {
	if (!isRecord(body) || !Array.isArray(body.alerts))
		throw new BadPayload('grafana: body has no alerts[]');
	return body.alerts.map((alert, index) => toSignal(alert, index, table));
}

function toSignal(alert: unknown, index: number, table: PriorityTable): IncidentSignal {
	const where = `grafana: alerts[${index}]`;
	if (!isRecord(alert)) throw new BadPayload(`${where} is not an object`);
	const fingerprint = optString(alert.fingerprint);
	if (fingerprint === null) throw new BadPayload(`${where} has no fingerprint`);
	if (!isTimestamp(alert.startsAt)) throw new BadPayload(`${where} has no valid startsAt`);
	const startsAt = alert.startsAt;
	const labels = stringMap(alert.labels);
	const annotations = stringMap(alert.annotations);
	// An empty label value means "no label" in Prometheus/Grafana — hence ||, not ??.
	const env = labels.env || 'prod';
	const name = labels.alertname || 'alert';
	const summary = annotations.summary;
	const title = truncate(`[${env}] ${name}${summary ? `: ${summary}` : ''}`, TITLE_MAX);

	if (alert.status === 'resolved') {
		if (!isTimestamp(alert.endsAt))
			throw new BadPayload(`${where} is resolved without a valid endsAt`);
		return {
			status: 'resolved',
			source: 'grafana',
			key: fingerprint,
			occurrence: startsAt,
			at: alert.endsAt,
			noteHtml: p(`Погас ${utc(alert.endsAt)} UTC`),
			title,
			env,
		};
	}
	if (alert.status !== 'firing') throw new BadPayload(`${where} has an unknown status`);

	return {
		status: 'firing',
		source: 'grafana',
		key: fingerprint,
		occurrence: startsAt,
		at: startsAt,
		title,
		bodyHtml: describeAlert(alert, labels, annotations),
		noteHtml: p(`Сработал ${utc(startsAt)} UTC`),
		priority: alertPriority(labels, table),
		label: 'alert',
		env,
	};
}

/**
 * Work-item priority of a firing alert from the tenant's table: the severity row (compared after trim +
 * lowercase; a missing or unknown severity uses the `*` row), then the env cell (else the row's `*`).
 * `env` is the `env` label, `prod` when empty.
 */
export function alertPriority(
	labels: Record<string, string>,
	table: PriorityTable,
): 'urgent' | 'high' | 'medium' {
	const level = (labels.severity ?? '').trim().toLowerCase();
	const env = labels.env || 'prod';
	const row = table[level] ?? {};
	const fallback = table['*'] ?? {};
	return row[env] ?? row['*'] ?? fallback[env] ?? fallback['*'] ?? 'urgent';
}

function describeAlert(
	alert: Record<string, unknown>,
	labels: Record<string, string>,
	annotations: Record<string, string>,
): string {
	const parts: string[] = [];
	if (annotations.summary) parts.push(p(esc(annotations.summary)));
	if (annotations.description) parts.push(p(esc(annotations.description)));
	const labelItems = Object.entries(labels)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([labelName, value]) => `<li><code>${esc(labelName)}</code>: ${esc(value)}</li>`);
	if (labelItems.length > 0) parts.push(`<p>Метки:</p><ul>${labelItems.join('')}</ul>`);
	const links = [
		link(optString(alert.generatorURL), 'Правило'),
		link(optString(alert.dashboardURL), 'Дашборд'),
		link(optString(alert.panelURL), 'Панель'),
		link(optString(alert.silenceURL), 'Заглушить'),
		link(annotations.runbook_url, 'Runbook'),
	].filter((html): html is string => html !== null);
	if (links.length > 0) parts.push(p(links.join(' · ')));
	return parts.join('');
}
