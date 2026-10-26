import { describe, expect, test } from 'bun:test';
import { embedBlock } from '../src/plane/embed.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

describe('embedBlock', () => {
	test('с заданным id — ровно разметка из пробы', () => {
		expect(embedBlock('https://miro.com/app/board/uXjVexample1=/', 'id-1')).toBe(
			'<external-embed-component id="id-1" data-id="id-1" src="https://miro.com/app/board/uXjVexample1=/" data-is-rich-card="false" data-has-embed-failed="false" data-has-tried-embedding="false" data-entity-name="Miro" data-entity-type="embed" data-spacing-group="container"></external-embed-component>',
		);
	});

	test('без id — каждый вызов берёт новый UUID и ставит его и в id, и в data-id', () => {
		const a = embedBlock('https://miro.com/app/board/x/');
		const b = embedBlock('https://miro.com/app/board/x/');
		const idOf = (html: string) => html.match(/ id="([^"]+)"/)?.[1];
		expect(idOf(a)).toMatch(UUID);
		expect(idOf(b)).toMatch(UUID);
		expect(idOf(a)).not.toBe(idOf(b));
		expect(a).toContain(`data-id="${idOf(a)}"`);
	});

	test('кавычка и скобка в URL экранированы, атрибут не закрывается раньше времени', () => {
		const html = embedBlock('https://miro.com/a"b<c>&d', 'i');
		expect(html).toContain('src="https://miro.com/a&quot;b&lt;c&gt;&amp;d"');
		expect(html).not.toContain('<c>');
		expect(html.match(/ src="/g)).toHaveLength(1);
	});
});
