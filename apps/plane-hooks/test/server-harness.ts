import { createHmac } from 'node:crypto';

import type { DeployNote, DeployNoteResult, ReleaseDraft } from '../src/deploy-note.ts';
import type { IncidentResult, IncidentSignal } from '../src/incident.ts';
import type { ReleaseItem, ReleaseResult } from '../src/release.ts';
import { createHandler, type LogEntry } from '../src/server.ts';

export const SHA = '0123456789abcdef0123456789abcdef01234567';
export const TOKEN = `ph_${'a1'.repeat(24)}`;
export const SECRET = 'vercel-test-secret';
export const DEPLOY_SECRET = 'deploy-test-secret';
export const DEPLOY_SHA = '89abcdef0123456789abcdef0123456789abcdef';
export const BASE = 'http://plane-hooks:8080';

export type Options = {
	report?: (signal: IncidentSignal) => Promise<IncidentResult>;
	notes?: (note: DeployNote) => Promise<DeployNoteResult[]>;
	releases?: (draft: ReleaseDraft, items: ReleaseItem[]) => Promise<ReleaseResult>;
};

export function harness(options: Options = {}) {
	const signals: IncidentSignal[] = [];
	const notes: DeployNote[] = [];
	const logs: LogEntry[] = [];
	const releases: { draft: ReleaseDraft; items: ReleaseItem[] }[] = [];
	const order: string[] = [];
	const handler = createHandler({
		grafanaToken: TOKEN,
		vercelSecret: SECRET,
		deploySecret: DEPLOY_SECRET,
		incidents: {
			report: async (signal) => {
				signals.push(signal);
				return options.report ? options.report(signal) : { action: 'created', workItemId: 'w1' };
			},
		},
		deployNotes: async (note) => {
			order.push('notes');
			notes.push(note);
			return options.notes
				? options.notes(note)
				: [{ key: 'OPS-12', action: 'commented', workItemId: 'w12', ms: 3 }];
		},
		releases: async (draft, items) => {
			order.push('release');
			releases.push({ draft, items });
			return options.releases
				? options.releases(draft, items)
				: { action: 'created', releaseId: 'r1' };
		},
		log: (entry) => logs.push(entry),
	});
	return { handler, signals, notes, logs, releases, order };
}

export function grafana(
	body: string | Uint8Array,
	authorization: string | null = `Bearer ${TOKEN}`,
): Request {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (authorization !== null) headers.authorization = authorization;
	return new Request(`${BASE}/hooks/grafana`, { method: 'POST', headers, body });
}

export function vercel(
	raw: Uint8Array,
	signature: string | null = createHmac('sha1', SECRET).update(raw).digest('hex'),
): Request {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (signature !== null) headers['x-vercel-signature'] = signature;
	return new Request(`${BASE}/hooks/vercel`, { method: 'POST', headers, body: raw });
}

export function deployRequest(
	raw: Uint8Array,
	signature: string | null = createHmac('sha256', DEPLOY_SECRET).update(raw).digest('hex'),
	headers: Record<string, string> = {},
): Request {
	const all: Record<string, string> = { 'content-type': 'application/json', ...headers };
	if (signature !== null) all['x-plane-hooks-signature'] = signature;
	return new Request(`${BASE}/hooks/deploy`, { method: 'POST', headers: all, body: raw });
}

export const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
