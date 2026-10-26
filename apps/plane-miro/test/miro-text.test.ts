import { describe, expect, test } from 'bun:test';
import { plainText } from '../src/miro/text.ts';

describe('plainText', () => {
	test('абзацы и переносы → строки, теги убраны, сущности раскрыты', () => {
		expect(plainText('<p>Купить &amp; <b>собрать</b></p><p>шаг&nbsp;2<br>шаг 3</p>')).toBe(
			'Купить & собрать\nшаг 2\nшаг 3',
		);
	});

	test('пустой стикер → пустая строка', () => {
		expect(plainText('<p></p><p> </p>')).toBe('');
		expect(plainText('')).toBe('');
	});

	test('div и li заканчивают строку; пустые строки сжаты; края обрезаны', () => {
		expect(plainText('<div>а</div><ul><li>б</li><li>в</li></ul>\n\n<p>г</p>')).toBe('а\nб\nв\nг');
		expect(plainText('  <p>  x  </p>  ')).toBe('x');
		expect(plainText('a<br/>b<BR />c')).toBe('a\nb\nc');
	});

	test('сущности: именованные, &#39;, числовые десятичные и шестнадцатеричные; неизвестная остаётся', () => {
		expect(plainText('&lt;a&gt; &quot;q&quot; it&#39;s &#1078; &#x436; &foo; &#99999999;')).toBe(
			'<a> "q" it\'s ж ж &foo;',
		);
	});

	test('раскрытые сущности не становятся тегами и не раскрываются дважды', () => {
		expect(plainText('&lt;b&gt;x&lt;/b&gt;')).toBe('<b>x</b>');
		expect(plainText('&amp;lt;')).toBe('&lt;');
	});

	test('имя сущности — не свойство прототипа', () => {
		expect(plainText('&Constructor; &toString; &__proto__;')).toBe(
			'&Constructor; &toString; &__proto__;',
		);
	});
});
