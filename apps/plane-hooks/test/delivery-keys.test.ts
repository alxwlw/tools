import { describe, expect, test } from 'bun:test';

import { mentionedKeys, ownedKeys, PULL_URL, pullUrl } from '../src/delivery/keys.ts';

const ids = new Set(['ENG', 'MR', 'QA']);
const pull = (over: { title?: string; head?: string; body?: string } = {}) => ({
	title: 'plain title',
	head: 'main-x',
	body: '',
	...over,
});

describe('ownedKeys', () => {
	test('ключ строчными в ветке feat-cld/mr-12-fix — MR-12', () => {
		expect(ownedKeys(pull({ head: 'feat-cld/mr-12-fix' }), ids)).toEqual(['MR-12']);
	});

	test('ключ в URL в заголовке — свой', () => {
		const title = 'Fix https://plane.example.com/example-ws/browse/ENG-7/ today';
		expect(ownedKeys(pull({ title }), ids)).toEqual(['ENG-7']);
	});

	test('ключ неизвестного проекта и семь цифр — нет', () => {
		expect(ownedKeys(pull({ title: 'FOO-1 and ENG-1234567' }), ids)).toEqual([]);
	});

	test('ключ только в описании — mentioned, не owned', () => {
		const p = pull({ body: 'relates to ENG-5' });
		expect(ownedKeys(p, ids)).toEqual([]);
		expect(mentionedKeys(p, ids)).toEqual(['ENG-5']);
	});

	test('два ключа в заголовке — оба owned', () => {
		expect(ownedKeys(pull({ title: 'ENG-1 and QA-2' }), ids)).toEqual(['ENG-1', 'QA-2']);
	});

	test('mentioned без уже принадлежащих и до 20', () => {
		const body = Array.from({ length: 25 }, (_, i) => `ENG-${i + 1}`).join(' ');
		const mentioned = mentionedKeys(pull({ title: 'ENG-1', body }), ids);
		expect(mentioned).not.toContain('ENG-1');
		expect(mentioned).toHaveLength(20);
		expect(mentioned[0]).toBe('ENG-2');
	});

	test('owned — не больше десяти', () => {
		const title = Array.from({ length: 12 }, (_, i) => `ENG-${i + 1}`).join(' ');
		expect(ownedKeys(pull({ title }), ids)).toHaveLength(10);
	});
});

describe('pullUrl', () => {
	test('URL PR разбирается обратно в репозиторий и номер', () => {
		const url = pullUrl('acme/api', 12);
		expect(url).toBe('https://github.com/acme/api/pull/12');
		const m = PULL_URL.exec(url);
		expect([m?.[1], m?.[2]]).toEqual(['acme/api', '12']);
		expect(PULL_URL.test('https://github.com/acme/api/pull/12/files')).toBe(false);
		expect(PULL_URL.test('https://github.com/acme/api/issues/12')).toBe(false);
	});
});
