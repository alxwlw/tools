// Adapted from apps/plane-discord/test/fixtures.ts.
// Sanitized Plane deliveries and API replies captured by the probe (Task 1). All files were produced by ONE
// createSanitizer over every capture, so a placeholder UUID means the same entity in every file.
// Deliveries are { headers, raw } and `fixture` adds the parsed `body`; API replies such as
// plane-search.json are plain JSON, read with `apiFixture`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlaneFixture } from '../scripts/sanitize-fixture.ts';

export const FIXTURES_DIR = join(import.meta.dir, 'fixtures');

/** A delivery fixture by `name` without `.json`, e.g. `fixture('plane-issue-renamed')`. */
export function fixture(name: string): PlaneFixture & { body: unknown } {
	const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as PlaneFixture;
	return { ...fx, body: JSON.parse(fx.raw) };
}

/** The JSON of a non-delivery fixture (an API reply). */
export function apiFixture(name: string): unknown {
	return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8'));
}
