import { createHmac, timingSafeEqual } from "node:crypto";
import type { DeployCommit, DeployOutcome } from "./deploy-note.ts";
import { esc, link, p, truncate, utc } from "./html.ts";
import { BadPayload, isRecord } from "./payload.ts";

const TITLE_MAX = 200;
const MAX_COMMITS = 200;
const MAX_MESSAGE = 65_536;
/** A prod promotion carries many work items; Vercel keeps its own 10. */
const KEY_LIMIT = 50;
const HEX40 = /^[0-9a-f]{40}$/i;
const DIGITS = /^[0-9]{1,20}$/;
const REPOSITORY_MAX = 140;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STAGES: readonly string[] = ["build", "bootstrap-smoke", "deploy"];

export const DEPLOY_SIGNATURE_HEADER = "x-plane-hooks-signature";

/** 64 hex digits — the only shape an HMAC-SHA256 signature can take; anything else fails before the body is read. */
export function isDeploySignatureShaped(header: string | null): header is string {
	return header !== null && /^[0-9a-f]{64}$/i.test(header);
}

/** `x-plane-hooks-signature` is the hex HMAC-SHA256 of the raw body keyed with PLANE_HOOKS_DEPLOY_SECRET. */
export function verifyDeploySignature(raw: Uint8Array, header: string | null, secret: string): boolean {
	if (!isDeploySignatureShaped(header)) return false;
	const expected = createHmac("sha256", secret).update(raw).digest();
	return timingSafeEqual(expected, Buffer.from(header, "hex"));
}

/**
 * A backend deploy reported by the monorepo's `report-deploy` CI job (spec «Событие из CI»).
 * failure opens or extends the incident of that environment; success resolves it and carries
 * the deploy notes for at most `keyLimit` (50) keys of the deployed commits, only keys with a known project prefix. A production success also carries the release draft. Error messages never quote the body.
 */
export function parseDeployEvent(body: unknown, now: () => Date = () => new Date()): DeployOutcome {
	if (!isRecord(body)) throw new BadPayload("deploy: body is not an object");
	const repository = shaped(body, "repository", REPOSITORY);
	const environment = body.environment;
	if (environment !== "staging" && environment !== "production") {
		throw new BadPayload("deploy: environment must be staging or production");
	}
	const sha = shaped(body, "sha", HEX40).toLowerCase();
	const runId = shaped(body, "runId", DIGITS);
	const runAttempt = shaped(body, "runAttempt", DIGITS);
	const runUrl = shaped(body, "runUrl", /^https:\/\//);
	const project = repository.split("/")[1] as string;
	const sha7 = sha.slice(0, 7);
	const key = `deploy:${project}:${environment}`;
	const at = now().toISOString();

	if (body.outcome === "failure") {
		const stage = body.stage;
		if (typeof stage !== "string" || !STAGES.includes(stage)) {
			throw new BadPayload("deploy: failure needs stage build, bootstrap-smoke or deploy");
		}
		const commitUrl = `https://github.com/${repository}/commit/${sha}`;
		return {
			kind: "failed",
			signal: {
				status: "firing",
				source: "github",
				key,
				occurrence: `${runId}.${runAttempt}`,
				at,
				title: truncate(`Деплой упал: ${project} (${environment}) · ${stage}`, TITLE_MAX),
				bodyHtml: [
					p(`Репозиторий: <code>${esc(repository)}</code>, окружение: <code>${environment}</code>, стадия: <code>${stage}</code>`),
					p(`Коммит: ${link(commitUrl, sha7) ?? `<code>${sha7}</code>`}`),
					p(link(runUrl, "Прогон GitHub Actions") ?? ""),
				].join(""),
				noteHtml: p(`Сработал ${utc(at)} UTC: стадия <code>${stage}</code>, ${link(runUrl, "прогон") ?? "прогон"}`),
				priority: environment === "production" ? "urgent" : "high",
				label: "deploy-failed",
			},
			summary: { title: `✗ ${project} → ${environment} упал · ${sha7} · ${stage}`, env: environment, sha },
		};
	}
	if (body.outcome !== "success") throw new BadPayload("deploy: outcome must be success or failure");
	if (body.stage !== null && body.stage !== undefined) throw new BadPayload("deploy: success must have stage null");

	const commits = commitList(body.commits);
	return {
		kind: "succeeded",
		resolve: {
			status: "resolved",
			source: "github",
			key,
			at,
			noteHtml: p(`Деплой снова проходит: <code>${sha7}</code>`),
		},
		note: {
			deploymentId: `gh:${environment}:${sha}`,
			project,
			target: environment,
			sha,
			url: runUrl,
			texts: commits.map((commit) => commit.message),
			source: "github",
			keyLimit: KEY_LIMIT,
		},
		summary: { title: `${project} → ${environment} · ${sha7}`, env: environment, sha },
		// A Plane release per production deploy (spec «plane-hooks: Release в Plane»); staging gets none.
		...(environment === "production" ? { release: { repository, sha, at, runUrl, commits } } : {}),
	};
}

function shaped(body: Record<string, unknown>, name: string, shape: RegExp): string {
	const value = body[name];
	// `\p{Cs}` under /u matches only a lone surrogate (ES2023 lib has no isWellFormed); Plane 500s on one.
	if (typeof value !== "string" || !shape.test(value) || /\p{Cs}/u.test(value) || (name === "repository" && value.length > REPOSITORY_MAX)) throw new BadPayload(`deploy: ${name} is missing or malformed`);
	return value;
}

function commitList(value: unknown): DeployCommit[] {
	if (!Array.isArray(value)) throw new BadPayload("deploy: commits must be an array");
	if (value.length > MAX_COMMITS) throw new BadPayload(`deploy: more than ${MAX_COMMITS} commits`);
	return value.map((commit, i) => {
		if (!isRecord(commit) || typeof commit.sha !== "string" || !HEX40.test(commit.sha) || typeof commit.message !== "string") {
			throw new BadPayload(`deploy: commits[${i}] must be {sha: 40 hex, message: string}`);
		}
		if (commit.message.length > MAX_MESSAGE) throw new BadPayload(`deploy: commits[${i}].message is too long`);
		return { sha: commit.sha.toLowerCase(), message: commit.message };
	});
}
