import { createHash, timingSafeEqual } from "node:crypto";
import type { DeployNote, DeployNoteResult } from "./deploy-note.ts";
import { parseGrafanaWebhook } from "./grafana.ts";
import type { IncidentReporter, IncidentSignal, Source } from "./incident.ts";
import { BadPayload } from "./payload.ts";
import { isVercelSignatureShaped, parseVercelWebhook, verifyVercelSignature } from "./vercel.ts";

export const MAX_BODY_BYTES = 1_048_576;

export type LogAction = "created" | "commented" | "reopened" | "noop" | "skipped" | "ignored" | "error";

export type LogEntry = {
	source: Source;
	event: string;
	key: string;
	action: LogAction;
	workItemId: string | null;
	ms: number;
	error?: string;
};

export type ServerDeps = {
	grafanaToken: string;
	vercelSecret: string;
	incidents: IncidentReporter;
	deployNotes: (note: DeployNote) => Promise<DeployNoteResult[]>;
	log: (entry: LogEntry) => void;
};

/**
 * HTTP surface of plane-hooks (spec «Ошибки и безопасность»): authenticate,
 * cap the body, parse, hand off. Any Plane failure answers 502 so the sender
 * retries — everything downstream is idempotent, a retry cannot duplicate.
 */
export function createHandler(deps: ServerDeps): (req: Request) => Promise<Response> {
	async function reportLogged(signal: IncidentSignal, event: string): Promise<boolean> {
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
			});
			return true;
		} catch (err) {
			deps.log({
				source: signal.source,
				event,
				key: signal.key,
				action: "error",
				workItemId: null,
				ms: since(started),
				error: describeError(err),
			});
			return false;
		}
	}

	async function grafana(body: unknown): Promise<Response> {
		const signals = parseGrafanaWebhook(body);
		let failed = 0;
		for (const signal of signals) {
			if (!(await reportLogged(signal, `alert.${signal.status}`))) failed++;
		}
		return failed === 0 ? text(200, "ok") : text(502, `plane: ${failed} of ${signals.length} alerts failed`);
	}

	async function vercel(body: unknown): Promise<Response> {
		const event = parseVercelWebhook(body);
		if (event.kind === "ignored") {
			deps.log({ source: "vercel", event: event.type, key: "-", action: "ignored", workItemId: null, ms: 0 });
			return text(200, "ignored");
		}
		if (event.kind === "failed") {
			return (await reportLogged(event.signal, "deployment.error")) ? text(200, "ok") : text(502, "plane failed");
		}
		if (!(await reportLogged(event.resolve, "deployment.succeeded"))) return text(502, "plane failed");
		const started = performance.now();
		try {
			// deployNotes has finished every Plane call before this loop starts: each key's own duration comes with its result.
			for (const result of await deps.deployNotes(event.note)) {
				deps.log({
					source: "vercel",
					event: "deployment.succeeded",
					key: result.key,
					action: result.action,
					workItemId: result.workItemId,
					ms: result.ms,
				});
			}
			return text(200, "ok");
		} catch (err) {
			deps.log({
				source: "vercel",
				event: "deployment.succeeded",
				key: `note:${event.note.deploymentId}`,
				action: "error",
				workItemId: null,
				ms: since(started),
				error: describeError(err),
			});
			return text(502, "plane failed");
		}
	}

	return async (req) => {
		const { pathname } = new URL(req.url);
		if (pathname === "/healthz") return req.method === "GET" ? text(200, "ok") : text(405, "method not allowed");
		if (pathname !== "/hooks/grafana" && pathname !== "/hooks/vercel") return text(404, "not found");
		if (req.method !== "POST") return text(405, "method not allowed");

		const isGrafana = pathname === "/hooks/grafana";
		if (isGrafana && !bearerMatches(req.headers.get("authorization"), deps.grafanaToken)) {
			return text(401, "unauthorized");
		}
		const signature = req.headers.get("x-vercel-signature");
		// A signature of the wrong shape can never match: refuse before buffering an unauthenticated body.
		if (!isGrafana && !isVercelSignatureShaped(signature)) return text(401, "unauthorized");
		// Refused after authentication: the sender does not retry a 4xx, so this log line is the only trace.
		// Every 401 and the Vercel 413 come before authentication (the HMAC needs the body) — anyone on the
		// internet can produce them, so they stay unlogged. The Grafana 413 comes after the Bearer check.
		const rejected = (status: 400 | 413, error: string, answer: string = error): Response => {
			deps.log({
				source: isGrafana ? "grafana" : "vercel",
				event: "rejected",
				key: "-",
				action: "error",
				workItemId: null,
				ms: 0,
				error,
			});
			return text(status, answer);
		};
		const raw = await readBody(req);
		if (raw === null) return isGrafana ? rejected(413, "payload too large") : text(413, "payload too large");
		if (!isGrafana && !verifyVercelSignature(raw, signature, deps.vercelSecret)) {
			return text(401, "unauthorized");
		}

		let body: unknown;
		try {
			body = JSON.parse(new TextDecoder().decode(raw));
		} catch {
			return rejected(400, "invalid json");
		}
		try {
			return isGrafana ? await grafana(body) : await vercel(body);
		} catch (err) {
			if (err instanceof BadPayload) return rejected(400, describeError(err), err.message);
			throw err;
		}
	};
}

async function readBody(req: Request): Promise<Uint8Array | null> {
	const declared = Number(req.headers.get("content-length") ?? 0);
	if (declared > MAX_BODY_BYTES) return null;
	const raw = new Uint8Array(await req.arrayBuffer());
	return raw.byteLength > MAX_BODY_BYTES ? null : raw;
}

/** Constant-time check of `Authorization: Bearer <token>`; hashing first makes both sides the same length. */
function bearerMatches(header: string | null, token: string): boolean {
	if (header === null || !header.startsWith("Bearer ")) return false;
	const presented = header.slice("Bearer ".length);
	return timingSafeEqual(createHash("sha256").update(presented).digest(), createHash("sha256").update(token).digest());
}

export function describeError(err: unknown): string {
	return err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
}

function since(started: number): number {
	return Math.round(performance.now() - started);
}

export function text(status: number, body: string): Response {
	return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
