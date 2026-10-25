// Turns a captured Plane delivery into a committable fixture: real ids, hosts, workspace slugs
// and people are replaced, then the body is signed with a test secret.
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

export function createSanitizer(opts: {
	slugs: string[];
	hosts: string[];
}): (text: string) => string {
	const uuids = new Map<string, string>();
	const people = new Map<string, number>();
	const names = new Map<string, number>();
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

	const person = (value: string): number => {
		const known = people.get(value);
		if (known !== undefined) return known;
		const n = people.size + 1;
		people.set(value, n);
		return n;
	};

	const freeName = (value: string): number => {
		const known = names.get(value);
		if (known !== undefined) return known;
		names.set(value, names.size + 1);
		return names.size;
	};

	const walk = (node: unknown, key?: string): unknown => {
		if (Array.isArray(node)) return node.map((x) => walk(x));
		if (node !== null && typeof node === 'object') {
			return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
		}
		if (key !== undefined && /^avatar/.test(key)) return null;
		if (typeof node === 'string' && node !== '') {
			if (key !== undefined && NAME_KEY.test(key)) return `User${person(node)}`;
			if (key !== undefined && MIN_NAME_KEY.test(key)) return `Name${freeName(node)}`;
			if (key !== undefined && CLIENT_ID_KEY.test(key)) return 'example-client-id';
			if (key === 'email') return `user${person(node)}@example.com`;
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
			m.toLowerCase().endsWith('@example.com') ? m : `user${person(m)}@example.com`,
		);
		if (hostRe) out = out.replace(hostRe, (m) => hostMap.get(m.toLowerCase()) as string);
		if (slugRe) out = out.replace(slugRe, (m) => slugMap.get(m.toLowerCase()) as string);
		return out.replace(UUID, (m) => {
			const key = m.toLowerCase();
			let sub = uuids.get(key);
			if (sub === undefined) {
				sub = `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, '0')}`;
				uuids.set(key, sub);
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

const USAGE =
	'usage: bun scripts/sanitize-fixture.ts <capture.bin> <event> [--slug <ws>]... [--host <host>]...';

/** Returns the fixture JSON for `argv` (without bun/script). */
export function cli(argv: string[]): string {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { slug: { type: 'string', multiple: true }, host: { type: 'string', multiple: true } },
	});
	const [file, event] = positionals;
	if (file === undefined || event === undefined) throw new Error(USAGE);
	const sanitize = createSanitizer({ slugs: values.slug ?? [], hosts: values.host ?? [] });
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
