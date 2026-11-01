import { createHash, timingSafeEqual } from 'node:crypto';

import type { TenantConfig } from './config.ts';
import type { AgentRunIn } from './contract.ts';

/** Constant-time comparison: both sides are hashed first, so the lengths always match. */
function sameKey(given: string, expected: string): boolean {
	if (given === '' || expected === '') return false;
	const a = createHash('sha256').update(given).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

/** `?k=` against the tenant's read key. */
export function readKeyOk(t: TenantConfig, url: URL): boolean {
	return sameKey(url.searchParams.get('k') ?? '', t.readKey);
}

/** `Authorization: Bearer <key>` against the tenant's agent key. */
export function agentKeyOk(t: TenantConfig, req: Request): boolean {
	const match = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '');
	return match !== null && sameKey(match[1] as string, t.agentKey);
}

const KINDS: readonly string[] = ['batch', 'daily', 'first'];

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';
/** Canonical ISO UTC only: marks are ordered by these strings as text. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isTime = (v: unknown): v is string =>
	typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));

/** Validates `rows` as an array of objects whose `fields` are non-empty strings; returns the path of the first bad one. */
function rows<F extends string>(
	name: string,
	value: unknown,
	fields: readonly F[],
): { ok: Record<F, string>[] } | { error: string } {
	if (!Array.isArray(value)) return { error: name };
	const out: Record<F, string>[] = [];
	for (const [i, row] of value.entries()) {
		if (!isObject(row)) return { error: `${name}[${i}]` };
		const copy = {} as Record<F, string>;
		for (const field of fields) {
			const v = row[field];
			if (!isText(v)) return { error: `${name}[${i}].${field}` };
			copy[field] = v;
		}
		out.push(copy);
	}
	return { ok: out };
}

/** The first invalid field of an agent run, by path (`relationsAdded[0].fromId`); unknown fields are dropped. */
export function parseAgentRun(body: unknown): AgentRunIn | { error: string } {
	if (!isObject(body)) return { error: 'body' };
	const { runId, kind, startedAt, finishedAt, skipped, costUsd } = body;
	if (!isText(runId)) return { error: 'runId' };
	if (typeof kind !== 'string' || !KINDS.includes(kind)) return { error: 'kind' };
	if (!isTime(startedAt)) return { error: 'startedAt' };
	if (!isTime(finishedAt)) return { error: 'finishedAt' };
	const relations = rows('relationsAdded', body.relationsAdded, ['fromId', 'toId']);
	if ('error' in relations) return relations;
	const labels = rows('labelsAdded', body.labelsAdded, ['itemId', 'label']);
	if ('error' in labels) return labels;
	if (typeof skipped !== 'number' || !Number.isInteger(skipped) || skipped < 0)
		return { error: 'skipped' };
	if (costUsd !== null && (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0))
		return { error: 'costUsd' };
	return {
		runId,
		kind: kind as AgentRunIn['kind'],
		startedAt,
		finishedAt,
		relationsAdded: relations.ok,
		labelsAdded: labels.ok,
		skipped,
		costUsd,
	};
}
