#!/usr/bin/env bun
/**
 * The inbox of plane-hooks — the SQLite file in PLANE_HOOKS_DB (default /data/plane-hooks.sqlite):
 *   bun scripts/inbox.ts failed       failed deliveries, one per line: id, tenant, kind, accepted at, error
 *   bun scripts/inbox.ts retry <id>   that failed delivery goes back to pending; the next start runs it
 * Inside the container: docker exec <container> bun scripts/inbox.ts failed
 * Exit 0; 1 when `retry` finds no failed delivery with that id; 2 on bad usage.
 */
import { Store } from '../src/store.ts';

export const USAGE = 'usage: bun scripts/inbox.ts failed | retry <id>';

export function inbox(
	args: readonly string[],
	store: Store,
	print: (line: string) => void,
): number {
	const [command, id, ...rest] = args;
	if (command === 'failed' && id === undefined) {
		const rows = store.inboxFailedList();
		print(['id', 'tenant', 'kind', 'at', 'error'].join('\t'));
		for (const row of rows) print([row.id, row.tenant, row.kind, row.at, row.error].join('\t'));
		return 0;
	}
	if (command === 'retry' && id !== undefined && /^[1-9][0-9]*$/.test(id) && rest.length === 0) {
		if (store.inboxRetry(Number(id))) {
			print(`delivery ${id} is pending again: restart the service to run it`);
			return 0;
		}
		print(`no failed delivery ${id}`);
		return 1;
	}
	print(USAGE);
	return 2;
}

if (import.meta.main) {
	const store = new Store(process.env.PLANE_HOOKS_DB?.trim() || '/data/plane-hooks.sqlite');
	const code = inbox(process.argv.slice(2), store, (line) => console.log(line));
	store.close();
	process.exit(code);
}
