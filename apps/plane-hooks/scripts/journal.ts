#!/usr/bin/env bun
/**
 * Status transitions plane-hooks made, from the SQLite file in PLANE_HOOKS_DB (default /data/plane-hooks.sqlite):
 *   bun scripts/journal.ts --since <ISO time | Nd> [--tenant <id>]
 * One tab-separated line per transition, oldest first: at, tenant, key, from, to, cause.
 * `--since 7d` is seven days back from now. Exit 0; 2 on bad usage.
 */
import { parseArgs } from 'node:util';

import { Store } from '../src/store.ts';

const DAY_MS = 86_400_000;
export const USAGE = 'usage: bun scripts/journal.ts --since <ISO|Nd> [--tenant <id>]';

/** `7d` → seven days before `now`; an ISO time → itself, normalised; anything else → null. */
export function sinceOf(value: string, now: number): string | null {
	const days = /^([1-9][0-9]{0,3})d$/.exec(value);
	if (days !== null) return new Date(now - Number(days[1]) * DAY_MS).toISOString();
	const ms = Date.parse(value);
	return /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(ms) ? new Date(ms).toISOString() : null;
}

export function journal(
	args: string[],
	store: Store,
	now: number,
	print: (line: string) => void,
): number {
	let values: { since?: string; tenant?: string };
	try {
		({ values } = parseArgs({
			args,
			options: { since: { type: 'string' }, tenant: { type: 'string' } },
			strict: true,
			allowPositionals: false,
		}));
	} catch {
		print(USAGE);
		return 2;
	}
	const since = values.since === undefined ? null : sinceOf(values.since, now);
	if (since === null) {
		print(USAGE);
		return 2;
	}
	print(['at', 'tenant', 'key', 'from', 'to', 'cause'].join('\t'));
	for (const row of store.journalSince(since, values.tenant))
		print([row.at, row.tenant, row.key, row.from, row.to, row.cause].join('\t'));
	return 0;
}

if (import.meta.main) {
	const store = new Store(process.env.PLANE_HOOKS_DB?.trim() || '/data/plane-hooks.sqlite');
	const code = journal(process.argv.slice(2), store, Date.now(), (line) => console.log(line));
	store.close();
	process.exit(code);
}
