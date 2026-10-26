// Adapted from apps/plane-discord/scripts/sanitize-fixture.ts.
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

// Miro ids: every 19-digit id (items, users, teams: 3458764…, 3074457…) and board ids (uXjV…=, also with the = percent-encoded in URLs).
const MIRO_ITEM = /(?<!\d)\d{19}(?!\d)/g;
const MIRO_BOARD = /uXjV[A-Za-z0-9_-]+(?:=|%3D)/gi;
// Already-sanitized placeholders pass through, so running the sanitizer twice changes nothing.
const ITEM_PLACEHOLDER = /^3458764500000000\d{3}$/;
const BOARD_PLACEHOLDER = /^uXjVexample\d*(?:=|%3D)$/i;

// Free text in Miro responses: board and user names, sticker content, frame titles.
const MIRO_TEXT_KEY = /^(?:name|title|content|description)$/;

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
	/** Raw Miro REST responses: names, titles and texts are replaced too. */
	miro?: boolean;
	/** Literal board ids to replace even when they do not look like uXjV…= */
	boards?: string[];
}): (text: string) => string {
	const uuids = new Map<string, string>();
	const items = new Map<string, string>();
	const boards = new Map<string, string>();
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
	// Literal board ids need not start with uXjV; the trailing = may be percent-encoded.
	const boardBases = (opts.boards ?? [])
		.map((b) => b.replace(/(?:=|%3D)$/i, ''))
		.filter((b) => b !== '');
	const boardRe =
		boardBases.length === 0
			? null
			: new RegExp(
					`(?<![A-Za-z0-9_-])(?:${boardBases
						.sort((x, y) => y.length - x.length)
						.map(escapeRegExp)
						.join('|')})(=|%3D)?(?![A-Za-z0-9_-])`,
					'g',
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

	const boardSub = (key: string): string => {
		let sub = boards.get(key);
		if (sub === undefined) {
			sub = `uXjVexample${boards.size + 1}`;
			boards.set(key, sub);
		}
		return sub;
	};

	const walk = (node: unknown, key?: string): unknown => {
		if (Array.isArray(node)) return node.map((x) => walk(x));
		if (node !== null && typeof node === 'object') {
			return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
		}
		if (key !== undefined && key.startsWith('avatar')) return null;
		if (typeof node === 'string' && node !== '') {
			if (key !== undefined && NAME_KEY.test(key)) return `User${person(node)}`;
			if (key !== undefined && MIN_NAME_KEY.test(key)) return `Name${freeName(node)}`;
			if (key !== undefined && CLIENT_ID_KEY.test(key)) return 'example-client-id';
			if (opts.miro && key !== undefined && MIRO_TEXT_KEY.test(key)) return `Name${freeName(node)}`;
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
		if (boardRe) {
			out = out.replace(boardRe, (m, eq: string | undefined) => {
				const base = m.slice(0, m.length - (eq?.length ?? 0));
				return `${boardSub(base)}${eq ?? ''}`;
			});
		}
		out = out.replace(MIRO_BOARD, (m) => {
			if (BOARD_PLACEHOLDER.test(m)) return m;
			const suffix = m.endsWith('=') ? '=' : m.slice(-3);
			return `${boardSub(m.slice(0, m.length - suffix.length))}${suffix}`;
		});
		out = out.replace(MIRO_ITEM, (m) => {
			if (ITEM_PLACEHOLDER.test(m)) return m;
			let sub = items.get(m);
			if (sub === undefined) {
				sub = `3458764500000000${String(items.size + 1).padStart(3, '0')}`;
				items.set(m, sub);
			}
			return sub;
		});
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

const USAGE = `usage: bun scripts/sanitize-fixture.ts <capture.bin> <event> [--slug <ws>]... [--host <host>]...
       bun scripts/sanitize-fixture.ts --miro <response.json> [--board <id>]... [--slug <ws>]... [--host <host>]...
--miro: a raw Miro REST response, printed sanitized as it is (no Plane delivery wrapper).
--board: a literal Miro board id to replace even when it does not start with uXjV.`;

/** Returns the fixture JSON for `argv` (without bun/script). */
export function cli(argv: string[]): string {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			slug: { type: 'string', multiple: true },
			host: { type: 'string', multiple: true },
			board: { type: 'string', multiple: true },
			miro: { type: 'boolean' },
		},
	});
	const [file, event] = positionals;
	if (file === undefined) throw new Error(USAGE);
	const sanitize = createSanitizer({
		slugs: values.slug ?? [],
		hosts: values.host ?? [],
		miro: values.miro,
		boards: values.board ?? [],
	});
	const text = sanitize(readFileSync(file, 'utf8'));
	if (values.miro) return `${text}\n`;
	if (event === undefined) throw new Error(USAGE);
	return `${JSON.stringify(fixtureOf(text, event), null, 2)}\n`;
}

if (import.meta.main) {
	try {
		process.stdout.write(cli(process.argv.slice(2)));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(2);
	}
}
