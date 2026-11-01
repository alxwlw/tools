// Adapted from apps/plane-miro/scripts/sanitize-fixture.ts.
// Turns a captured Plane delivery or REST response into a committable fixture: real ids, hosts,
// workspace slugs, people, work-item keys, names and descriptions are replaced, then the body is
// signed with a test secret.
// Run: bun scripts/sanitize-fixture.ts <capture.bin> <event> --slug <ws> --host <host> > fixture.json
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export type PlaneFixture = {
	headers: { 'x-plane-event': string; 'x-plane-signature': string };
	raw: string;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// display_name, first_name, last_name and derived keys such as min_assignee_first_name.
const NAME_KEY = /(?:^|_)(?:display|first|last)_name$/;
// Free-text names Plane denormalizes into work items: min_module_name, min_label_name, ... (the
// person ones are already caught by NAME_KEY). Each distinct value becomes Name<N>.
const MIN_NAME_KEY = /^min_.*_name$/;
// The Plane App client id (agent_run_* deliveries) is internal and stable: one placeholder.
const CLIENT_ID_KEY = /(?:^|_)client_id$/;

// A work-item key such as PRJ-35 becomes ABC-<n>; a key that is already ABC-<n> passes through.
const ITEM_KEY = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-\d{1,6}(?![A-Za-z0-9-])/g;
const KEY_PLACEHOLDER = /^ABC-\d+$/;
// The project identifier on its own (PRJ), not a key.
const PROJECT_IDENTIFIER_KEY = /^(?:identifier|project_identifier)$/;
// Text of a work item: its name and descriptions become Задача <n>.
const ITEM_TEXT_KEY = /^(?:name|description_html|description_stripped)$/;
// Free text of any object (labels, modules, states, projects) when the names option is on.
const ANY_TEXT_KEY = /^(?:name|title|description|description_html|description_stripped)$/;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Alternation of literals, longest first, so a longer value is never cut by a shorter one.
function literalsRegExp(values: string[], boundary: boolean): RegExp | null {
	const parts = values
		.filter((v) => v !== '')
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp);
	if (parts.length === 0) return null;
	const body = parts.join('|');
	return new RegExp(boundary ? `(?<![A-Za-z0-9-])(?:${body})(?![A-Za-z0-9-])` : body, 'gi');
}

// A work item has a sequence number; a relation list entry has no sequence number but names a state
// and a project.
const isWorkItem = (o: Record<string, unknown>): boolean =>
	'sequence_id' in o ||
	('name' in o && ('state_id' in o || 'state' in o) && ('project_id' in o || 'project' in o));

export function createSanitizer(opts: {
	slugs: string[];
	hosts: string[];
	/** Names, titles and descriptions of every object (labels, modules, states) are replaced too. */
	names?: boolean;
}): (text: string) => string {
	const uuids = new Map<string, string>();
	const people = new Map<string, number>();
	const names = new Map<string, number>();
	const tasks = new Map<string, number>();
	const keys = new Map<string, string>();
	const slugMap = new Map(
		opts.slugs.map((s, i) => [s.toLowerCase(), i === 0 ? 'example-ws' : `example-ws-${i + 1}`]),
	);
	const hostMap = new Map(
		opts.hosts.map((h, i) => [
			h.toLowerCase(),
			i === 0 ? 'plane.example.com' : `host${i + 1}.example.com`,
		]),
	);
	const slugRe = literalsRegExp(opts.slugs, true);
	const hostRe = literalsRegExp(opts.hosts, false);

	const numbered = (map: Map<string, number>, value: string): number => {
		const known = map.get(value);
		if (known !== undefined) return known;
		map.set(value, map.size + 1);
		return map.size;
	};

	const walk = (node: unknown, key?: string, item = false): unknown => {
		if (Array.isArray(node)) return node.map((x) => walk(x, undefined, false));
		if (node !== null && typeof node === 'object') {
			const obj = node as Record<string, unknown>;
			const itemHere = isWorkItem(obj);
			// An activity record of a name or description change carries the texts as values.
			const textChange = obj.field === 'name' || obj.field === 'description';
			return Object.fromEntries(
				Object.entries(obj).map(([k, v]) => [
					k,
					walk(v, k, itemHere || (textChange && (k === 'old_value' || k === 'new_value'))),
				]),
			);
		}
		if (key !== undefined && key.startsWith('avatar')) return null;
		if (typeof node === 'string' && node !== '') {
			if (key !== undefined && NAME_KEY.test(key)) return `User${numbered(people, node)}`;
			if (key !== undefined && MIN_NAME_KEY.test(key)) return `Name${numbered(names, node)}`;
			if (key !== undefined && CLIENT_ID_KEY.test(key)) return 'example-client-id';
			if (key !== undefined && PROJECT_IDENTIFIER_KEY.test(key)) return 'ABC';
			if (item && key !== undefined && (ITEM_TEXT_KEY.test(key) || key.endsWith('_value'))) {
				return `Задача ${numbered(tasks, node)}`;
			}
			if (opts.names && key !== undefined && ANY_TEXT_KEY.test(key)) {
				return `Name${numbered(names, node)}`;
			}
			if (key === 'email') return `user${numbered(people, node)}@example.com`;
		}
		return node;
	};

	return (text) => {
		let out = text;
		try {
			out = JSON.stringify(walk(JSON.parse(text)), null, 2);
		} catch {
			// not JSON: the regular expressions below still apply
		}
		out = out.replace(EMAIL, (m) =>
			m.toLowerCase().endsWith('@example.com') ? m : `user${numbered(people, m)}@example.com`,
		);
		if (hostRe) out = out.replace(hostRe, (m) => hostMap.get(m.toLowerCase()) as string);
		if (slugRe) out = out.replace(slugRe, (m) => slugMap.get(m.toLowerCase()) as string);
		// UUIDs go before the keys: an upper-case UUID segment can look like a key.
		out = out.replace(UUID, (m) => {
			const k = m.toLowerCase();
			let sub = uuids.get(k);
			if (sub === undefined) {
				sub = `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, '0')}`;
				uuids.set(k, sub);
			}
			return sub;
		});
		return out.replace(ITEM_KEY, (m) => {
			if (KEY_PLACEHOLDER.test(m)) return m;
			let sub = keys.get(m);
			if (sub === undefined) {
				sub = `ABC-${keys.size + 1}`;
				keys.set(m, sub);
			}
			return sub;
		});
	};
}

export function fixtureOf(raw: string, event: string, secret = 'test-secret'): PlaneFixture {
	return {
		headers: {
			'x-plane-event': event,
			'x-plane-signature': createHmac('sha256', secret).update(raw).digest('hex'),
		},
		raw,
	};
}

const USAGE = `usage: bun scripts/sanitize-fixture.ts <capture.bin> <event> [--names] [--slug <ws>]... [--host <host>]...
A REST response is wrapped the same way, with any <event> (e.g. rest).
--names: names, titles and descriptions of labels, modules and states are replaced too.`;

/** Returns the fixture JSON for `argv` (without bun/script). */
export function cli(argv: string[]): string {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			slug: { type: 'string', multiple: true },
			host: { type: 'string', multiple: true },
			names: { type: 'boolean' },
		},
	});
	const [file, event] = positionals;
	if (file === undefined || event === undefined) throw new Error(USAGE);
	const sanitize = createSanitizer({
		slugs: values.slug ?? [],
		hosts: values.host ?? [],
		names: values.names,
	});
	return `${JSON.stringify(fixtureOf(sanitize(readFileSync(file, 'utf8')), event), null, 2)}\n`;
}

if (import.meta.main) {
	try {
		process.stdout.write(cli(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(2);
	}
}
