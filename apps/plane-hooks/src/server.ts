import { createHash, timingSafeEqual } from 'node:crypto';

import {
	DEPLOY_SIGNATURE_HEADER,
	isDeploySignatureShaped,
	parseDeployEvent,
	verifyDeploySignature,
} from './deploy-event.ts';
import type { DeployNote, DeployNoteResult, DeployOutcome, ReleaseDraft } from './deploy-note.ts';
import { parseGrafanaWebhook } from './grafana.ts';
import type { IncidentReporter, IncidentSignal, Source } from './incident.ts';
import { BadPayload } from './payload.ts';
import { releaseExternalId, type ReleaseItem, type ReleaseResult } from './release.ts';
import { isVercelSignatureShaped, parseVercelWebhook, verifyVercelSignature } from './vercel.ts';

export const MAX_BODY_BYTES = 1_048_576;

const ROUTES: Record<string, Source | undefined> = {
	'/hooks/grafana': 'grafana',
	'/hooks/vercel': 'vercel',
	'/hooks/deploy': 'github',
};

export type LogAction =
	| 'created'
	| 'commented'
	| 'reopened'
	| 'noop'
	| 'skipped'
	| 'ignored'
	| 'error';

export type LogEntry = {
	source: Source;
	event: string;
	key: string;
	action: LogAction;
	workItemId: string | null;
	ms: number;
	/** Exactly one line per event carries it: the Grafana annotation layers query on it (spec «Отметки в Grafana»). */
	annotation?: 'deploy' | 'incident';
	title?: string;
	env?: string;
	sha?: string;
	/** `warn` — the event was served, but a non-essential part failed (the Plane release of a deploy). */
	level?: 'warn';
	releaseId?: string;
	error?: string;
};

type Annotation = Pick<LogEntry, 'annotation' | 'title' | 'env' | 'sha'>;

export type ServerDeps = {
	grafanaToken: string;
	vercelSecret: string;
	deploySecret: string;
	incidents: IncidentReporter;
	deployNotes: (note: DeployNote) => Promise<DeployNoteResult[]>;
	releases: (draft: ReleaseDraft, items: ReleaseItem[]) => Promise<ReleaseResult>;
	log: (entry: LogEntry) => void;
};

/**
 * HTTP surface of plane-hooks (spec «Ошибки и безопасность»): authenticate,
 * cap the body, parse, hand off. Any Plane failure answers 502 so the sender
 * retries — everything downstream is idempotent, a retry cannot duplicate.
 */
export function createHandler(deps: ServerDeps): (req: Request) => Promise<Response> {
	async function reportLogged(
		signal: IncidentSignal,
		event: string,
		annotate: (action: LogAction) => Annotation | undefined = () => undefined,
	): Promise<boolean> {
		const started = performance.now();
		try {
			const result = await deps.incidents.report(signal);
			deps.log({
				source: signal.source,
				event,
				key: signal.key,
				action: result.action,
				workItemId: result.workItemId,
				ms: since(started),
				...annotate(result.action),
			});
			return true;
		} catch (err) {
			deps.log({
				source: signal.source,
				event,
				key: signal.key,
				action: 'error',
				workItemId: null,
				ms: since(started),
				...annotate('error'),
				error: describeError(err),
			});
			return false;
		}
	}

	async function grafana(body: unknown): Promise<Response> {
		const signals = parseGrafanaWebhook(body);
		let failed = 0;
		for (const signal of signals) {
			if (!(await reportLogged(signal, `alert.${signal.status}`, incidentAnnotation(signal))))
				failed++;
		}
		return failed === 0
			? text(200, 'ok')
			: text(502, `plane: ${failed} of ${signals.length} alerts failed`);
	}

	/**
	 * The Plane release of a production deploy, after its notes: the work item ids come from their results, with no
	 * second lookup by key. A failure is a warn line, never a 502 — CI would resend the whole event for it.
	 */
	async function release(
		source: 'vercel' | 'github',
		draft: ReleaseDraft,
		notes: readonly DeployNoteResult[],
	): Promise<void> {
		const started = performance.now();
		const key = `release:${releaseExternalId(draft)}`;
		const items = notes.flatMap((note) =>
			note.workItemId === null ? [] : [{ key: note.key, workItemId: note.workItemId }],
		);
		try {
			const result = await deps.releases(draft, items);
			deps.log({
				source,
				event: 'release',
				key,
				action: result.action,
				workItemId: null,
				ms: since(started),
				releaseId: result.releaseId,
			});
		} catch (err) {
			deps.log({
				source,
				event: 'release',
				key,
				action: 'error',
				workItemId: null,
				ms: since(started),
				level: 'warn',
				error: describeError(err),
			});
		}
	}

	/** One deploy, from Vercel or from CI. Its incident line carries the deploy annotation whatever the action: every deploy is a mark. */
	async function deploy(source: 'vercel' | 'github', outcome: DeployOutcome): Promise<Response> {
		const { summary } = outcome;
		const annotate = (): Annotation => ({
			annotation: 'deploy',
			title: summary.title,
			env: summary.env,
			sha: summary.sha,
		});
		if (outcome.kind === 'failed') {
			return (await reportLogged(outcome.signal, 'deployment.error', annotate))
				? text(200, 'ok')
				: text(502, 'plane failed');
		}
		if (!(await reportLogged(outcome.resolve, 'deployment.succeeded', annotate)))
			return text(502, 'plane failed');
		const started = performance.now();
		let results: DeployNoteResult[] = [];
		try {
			// deployNotes has finished every Plane call before this loop starts: each key's own duration comes with its result.
			results = await deps.deployNotes(outcome.note);
			for (const result of results) {
				deps.log({
					source,
					event: 'deployment.succeeded',
					key: result.key,
					action: result.action,
					workItemId: result.workItemId,
					ms: result.ms,
				});
			}
		} catch (err) {
			deps.log({
				source,
				event: 'deployment.succeeded',
				key: `note:${outcome.note.deploymentId}`,
				action: 'error',
				workItemId: null,
				ms: since(started),
				error: describeError(err),
			});
			return text(502, 'plane failed');
		}
		if (outcome.release) await release(source, outcome.release, results);
		return text(200, 'ok');
	}

	async function vercel(body: unknown): Promise<Response> {
		const event = parseVercelWebhook(body);
		if (event.kind === 'ignored') {
			deps.log({
				source: 'vercel',
				event: event.type,
				key: '-',
				action: 'ignored',
				workItemId: null,
				ms: 0,
			});
			return text(200, 'ignored');
		}
		return deploy('vercel', event);
	}

	return async (req) => {
		const { pathname } = new URL(req.url);
		if (pathname === '/healthz')
			return req.method === 'GET' ? text(200, 'ok') : text(405, 'method not allowed');
		const source = ROUTES[pathname];
		if (source === undefined) return text(404, 'not found');
		if (req.method !== 'POST') return text(405, 'method not allowed');

		if (
			source === 'grafana' &&
			!bearerMatches(req.headers.get('authorization'), deps.grafanaToken)
		) {
			return text(401, 'unauthorized');
		}
		const signature =
			source === 'vercel'
				? req.headers.get('x-vercel-signature')
				: source === 'github'
					? req.headers.get(DEPLOY_SIGNATURE_HEADER)
					: null;
		// A signature of the wrong shape can never match: refuse before buffering an unauthenticated body.
		if (source === 'vercel' && !isVercelSignatureShaped(signature))
			return text(401, 'unauthorized');
		if (source === 'github' && !isDeploySignatureShaped(signature))
			return text(401, 'unauthorized');
		// Refused after authentication: the sender does not retry a 4xx, so this log line is the only trace.
		// Every 401 and the signed-route 413 come before authentication (the HMAC needs the body) — anyone on
		// the internet can produce them, so they stay unlogged. The Grafana 413 comes after the Bearer check.
		const rejected = (status: 400 | 413, error: string, answer: string = error): Response => {
			deps.log({
				source,
				event: 'rejected',
				key: '-',
				action: 'error',
				workItemId: null,
				ms: 0,
				error,
			});
			return text(status, answer);
		};
		const raw = await readBody(req);
		if (raw === null)
			return source === 'grafana'
				? rejected(413, 'payload too large')
				: text(413, 'payload too large');
		if (source === 'vercel' && !verifyVercelSignature(raw, signature, deps.vercelSecret)) {
			return text(401, 'unauthorized');
		}
		if (source === 'github' && !verifyDeploySignature(raw, signature, deps.deploySecret)) {
			return text(401, 'unauthorized');
		}

		let body: unknown;
		try {
			body = JSON.parse(new TextDecoder().decode(raw));
		} catch {
			return rejected(400, 'invalid json');
		}
		try {
			if (source === 'grafana') return await grafana(body);
			if (source === 'vercel') return await vercel(body);
			return await deploy('github', parseDeployEvent(body));
		} catch (err) {
			if (err instanceof BadPayload) return rejected(400, describeError(err), err.message);
			throw err;
		}
	};
}

async function readBody(req: Request): Promise<Uint8Array | null> {
	const declared = Number(req.headers.get('content-length') ?? 0);
	if (declared > MAX_BODY_BYTES) return null;
	const raw = new Uint8Array(await req.arrayBuffer());
	return raw.byteLength > MAX_BODY_BYTES ? null : raw;
}

/** Grafana alerts: a new firing or a new resolution is a mark on the dashboards; a replay (noop) or an error is not. */
function incidentAnnotation(signal: IncidentSignal): (action: LogAction) => Annotation | undefined {
	return (action) => {
		const fresh =
			signal.status === 'firing'
				? action === 'created' || action === 'reopened' || action === 'commented'
				: action === 'commented';
		if (!fresh) return undefined;
		const verb = signal.status === 'firing' ? 'Сработал' : 'Погас';
		return {
			annotation: 'incident',
			title: `${verb}: ${signal.title ?? signal.key}`,
			env: markEnv(signal.env),
		};
	};
}

/** Deploy marks tag `production` / `staging`; an alert without an env label defaults to `prod` in its title, but the mark must match the deploy vocabulary. */
function markEnv(env: string | undefined): string | undefined {
	return env === 'prod' ? 'production' : env;
}

/** Constant-time check of `Authorization: Bearer <token>`; hashing first makes both sides the same length. */
function bearerMatches(header: string | null, token: string): boolean {
	if (header === null || !header.startsWith('Bearer ')) return false;
	const presented = header.slice('Bearer '.length);
	return timingSafeEqual(
		createHash('sha256').update(presented).digest(),
		createHash('sha256').update(token).digest(),
	);
}

export function describeError(err: unknown): string {
	return err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
}

function since(started: number): number {
	return Math.round(performance.now() - started);
}

export function text(status: number, body: string): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
