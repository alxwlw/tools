import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSanitizer } from '../scripts/sanitize-fixture.ts';

const DIR = join(import.meta.dir, 'fixtures');

const FAKE_ITEM = /^3458764500000000\d{3}$/;
const FAKE_BOARD = /^uXjVexample\d+(?:=|%3D)$/;
const FAKE_UUID = /^00000000-0000-4000-8000-\d{12}$/;
const FAKE_HOST =
	/^(?:(?:[a-z0-9-]+\.)*example\.(?:com|org)|(?:[a-z0-9-]+\.)*miro(?:static)?\.com)$/i;

/** Shapes a committed fixture must not contain: whatever the sanitizer would have replaced. */
export function forbiddenIn(text: string): string[] {
	const found: string[] = [];
	for (const m of text.match(/(?<!\d)\d{19}(?!\d)/g) ?? []) if (!FAKE_ITEM.test(m)) found.push(m);
	for (const m of text.match(/uXjV[A-Za-z0-9_-]+(?:=|%3D)/gi) ?? []) {
		if (!FAKE_BOARD.test(m)) found.push(m);
	}
	for (const m of text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ??
		[]) {
		if (!FAKE_UUID.test(m)) found.push(m);
	}
	for (const m of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) {
		if (!m.toLowerCase().endsWith('@example.com')) found.push(m);
	}
	for (const m of text.matchAll(/https?:\/\/([^/\s"'\\?#]+)/gi)) {
		if (!FAKE_HOST.test(m[1] as string)) found.push(m[0]);
	}
	return found;
}

// Every string value of the JSON (and of JSON nested in a string, as a Plane delivery's `raw`).
function strings(node: unknown, out: string[] = []): string[] {
	if (Array.isArray(node)) for (const x of node) strings(x, out);
	else if (node !== null && typeof node === 'object') {
		for (const v of Object.values(node)) strings(v, out);
	} else if (typeof node === 'string') {
		let nested: unknown;
		try {
			nested = JSON.parse(node);
		} catch {
			// plain text
		}
		if (nested !== null && typeof nested === 'object') strings(nested, out);
		else out.push(node);
	}
	return out;
}

const DIRTY = {
	team: '3458764555444333222',
	board: 'uXjVRealBoard1=',
	id: '3f2b8c1e-9d4a-4e7b-a1c2-5b6d7e8f9a0b',
	by: 'a@real.io',
	link: 'https://plane.real.io/ws/browse/ACME-1/',
};

test('проверка находит каждую запрещённую форму, в том числе во вложенной JSON-строке', () => {
	const found = strings({ raw: JSON.stringify(DIRTY) }).flatMap(forbiddenIn);
	expect(found.sort()).toEqual(
		[
			'3458764555444333222',
			'uXjVRealBoard1=',
			'3f2b8c1e-9d4a-4e7b-a1c2-5b6d7e8f9a0b',
			'a@real.io',
			'https://plane.real.io',
		].sort(),
	);
});

test('вывод санитайзера проходит проверку, разрешённые хосты и подмены — тоже', () => {
	const clean = createSanitizer({ slugs: [], hosts: ['plane.real.io'], miro: true })(
		JSON.stringify({ ...DIRTY, ok: 'https://miro.com/app/board/uXjVexample9=/' }),
	);
	expect(strings(JSON.parse(clean)).flatMap(forbiddenIn)).toEqual([]);
});

test('все test/fixtures/*.json очищены', () => {
	const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];
	for (const f of files) {
		const found = strings(JSON.parse(readFileSync(join(DIR, f), 'utf8'))).flatMap(forbiddenIn);
		expect({ file: f, found }).toEqual({ file: f, found: [] });
	}
});
