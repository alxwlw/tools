import { describe, expect, test } from 'bun:test';
import { BadPayload, isRecord, isTimestamp, optString, stringMap } from '../src/payload.ts';

describe('payload guards', () => {
	test('isRecord: только простой объект', () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
		expect(isRecord('x')).toBe(false);
	});

	test('optString: пустая строка и не-строки → null', () => {
		expect(optString('a')).toBe('a');
		expect(optString('')).toBeNull();
		expect(optString(1)).toBeNull();
		expect(optString(undefined)).toBeNull();
	});

	test('stringMap оставляет только строковые значения', () => {
		expect(stringMap({ a: '1', b: 2, c: null, d: 'x' })).toEqual({ a: '1', d: 'x' });
		expect(stringMap('nope')).toEqual({});
	});

	test('isTimestamp', () => {
		expect(isTimestamp('2026-10-06T10:00:00Z')).toBe(true);
		expect(isTimestamp('nope')).toBe(false);
		expect(isTimestamp(1)).toBe(false);
	});

	test('BadPayload — Error со своим именем', () => {
		const err = new BadPayload('x');
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('BadPayload');
	});
});
