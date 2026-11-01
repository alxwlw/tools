// Adapted from apps/plane-miro/test/fixtures.ts.
// Sanitized Plane deliveries and REST replies captured by the probe. A delivery is { headers, raw }
// signed with `test-secret`; REST fixtures carry x-plane-event "rest" and only their `raw` matters.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PlaneFixture } from '../scripts/sanitize-fixture.ts';

export const FIXTURES_DIR = join(import.meta.dir, 'fixtures');

/** A fixture by name without `.json`, e.g. `fixture('plane-issue-state')`, plus its parsed `body`. */
export function fixture(name: string): PlaneFixture & { body: unknown } {
	const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as PlaneFixture;
	return { ...fx, body: JSON.parse(fx.raw) };
}
