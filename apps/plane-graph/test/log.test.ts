// Adapted from apps/plane-miro/test/server-plane.test.ts (the jsonLog block).
import { describe, expect, test } from 'bun:test';

import { jsonLog } from '../src/log.ts';

describe('jsonLog', () => {
	test('одна JSON-строка на запись: ts первым, поля записи следом, level сохраняется', () => {
		const lines: string[] = [];
		const log = jsonLog(
			(line) => lines.push(line),
			() => new Date('2026-10-22T12:00:00.000Z'),
		);
		log({ event: 'plane.rejected', level: 'error', reason: 'bad_signature', tenant: 'initech' });
		log({ event: 'plane.accepted', ms: 3, note: undefined });
		expect(lines).toEqual([
			'{"ts":"2026-10-22T12:00:00.000Z","event":"plane.rejected","level":"error","reason":"bad_signature","tenant":"initech"}',
			'{"ts":"2026-10-22T12:00:00.000Z","event":"plane.accepted","ms":3}',
		]);
	});

	test('по умолчанию пишет строку в stdout', () => {
		const written: string[] = [];
		const original = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			written.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			jsonLog()({ event: 'x' });
		} finally {
			process.stdout.write = original;
		}
		expect(written).toHaveLength(1);
		expect(written[0]!.endsWith('\n')).toBe(true);
		expect(JSON.parse(written[0]!)).toMatchObject({ event: 'x' });
		expect(Date.now() - Date.parse(JSON.parse(written[0]!).ts)).toBeLessThan(60_000);
	});
});
