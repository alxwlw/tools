// Sanitized Plane deliveries captured from a live workspace. All files were produced by ONE
// createSanitizer over every capture, so a placeholder UUID means the same entity in every file
// (the app bot in a mention equals agent_user_id of the agent run, and so on).
// plane-comment-get-mention.json is an API response (GET comment), not a delivery: it is kept in
// the same shape so that one loader serves both; its x-plane-event is the label 'api:comment-get'.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlaneFixture } from '../scripts/sanitize-fixture.ts';

export const FIXTURES_DIR = join(import.meta.dir, 'fixtures');

/** `name` without `.json`, e.g. `fixture('plane-app-workitem-created')`. */
export function fixture(name: string): PlaneFixture & { body: unknown } {
	const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')) as PlaneFixture;
	return { ...fx, body: JSON.parse(fx.raw) };
}
