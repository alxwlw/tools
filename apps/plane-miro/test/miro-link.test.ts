import { describe, expect, test } from 'bun:test';

import { findMiroLinks, MAX_LINKS } from '../src/miro/link.ts';

const sixBoards = Array.from(
	{ length: 6 },
	(_, i) => `https://miro.com/app/board/uXjVb${i}=/`,
).join(' ');

describe('findMiroLinks', () => {
	test('href и голый текст, %3D в id доски', () => {
		expect(
			findMiroLinks(
				'<p><a href="https://miro.com/app/board/uXjVb1%3D/?moveToWidget=3458764500000000101&amp;cot=14">x</a> и https://miro.com/app/board/uXjVb2=/</p>',
			),
		).toEqual([
			{ boardId: 'uXjVb1=', itemId: '3458764500000000101' },
			{ boardId: 'uXjVb2=', itemId: null },
		]);
	});
	test('moveToWidget не первым параметром', () => {
		expect(
			findMiroLinks('https://miro.com/app/board/uXjVb1=/?share_link_id=1&moveToWidget=42')[0]
				?.itemId,
		).toBe('42');
	});
	test('live-embed → доска', () => {
		expect(
			findMiroLinks('https://miro.com/app/live-embed/uXjVb1=/?embedMode=view_only_without_ui'),
		).toEqual([{ boardId: 'uXjVb1=', itemId: null }]);
	});
	test('две ссылки на одну доску → одна, первая', () => {
		expect(
			findMiroLinks(
				'https://miro.com/app/board/uXjVb1=/?moveToWidget=1 https://miro.com/app/board/uXjVb1=/?moveToWidget=2',
			),
		).toEqual([{ boardId: 'uXjVb1=', itemId: '1' }]);
	});
	test('поддельные хосты → ничего', () => {
		expect(
			findMiroLinks(
				'https://miro.com.evil.example/app/board/uXjVb1=/ https://evilmiro.com/app/board/uXjVb1=/ https://x.miro.com/app/board/uXjVb1=/',
			),
		).toEqual([]);
	});
	test('www.miro.com принимается, http тоже', () => {
		expect(findMiroLinks('http://www.miro.com/app/board/uXjVb1=/')).toEqual([
			{ boardId: 'uXjVb1=', itemId: null },
		]);
	});
	test('шесть досок → первые пять', () => {
		const found = findMiroLinks(sixBoards);
		expect(MAX_LINKS).toBe(5);
		expect(found.map((l) => l.boardId)).toEqual([
			'uXjVb0=',
			'uXjVb1=',
			'uXjVb2=',
			'uXjVb3=',
			'uXjVb4=',
		]);
	});
	test('moveToWidget не из цифр → itemId null; точка в конце текста не часть адреса', () => {
		expect(findMiroLinks('https://miro.com/app/board/uXjVb1=/?moveToWidget=abc')).toEqual([
			{ boardId: 'uXjVb1=', itemId: null },
		]);
		expect(findMiroLinks('см. https://miro.com/app/board/uXjVb1=/?moveToWidget=42.')).toEqual([
			{ boardId: 'uXjVb1=', itemId: '42' },
		]);
	});
	test('id доски с недопустимыми символами пропускается', () => {
		expect(
			findMiroLinks('https://miro.com/app/board/a%20b/ https://miro.com/app/board/%E0%A4%A/'),
		).toEqual([]);
	});
	test('длинный хвост из точек не вешает разбор', () => {
		const started = performance.now();
		const found = findMiroLinks(`https://miro.com/app/board/uXjVb1=/?x=${'.'.repeat(200_000)}a`);
		expect(found).toEqual([{ boardId: 'uXjVb1=', itemId: null }]);
		expect(performance.now() - started).toBeLessThan(200);
	});
});
