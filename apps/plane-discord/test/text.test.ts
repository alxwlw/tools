import { describe, expect, test } from 'bun:test';
import {
	discordToPlaneHtml,
	planeHtmlToDiscord,
	planeMentionHtml,
	planeMentions,
	titleFrom,
	userMap,
	workItemKey,
	workItemUrl,
} from '../src/text.ts';
import { fixture } from './fixtures.ts';

const UUID_A = '00000000-0000-4000-8000-0000000000aa';
const UUID_B = '00000000-0000-4000-8000-0000000000bb';
const m = (id: string) => `<@${id}>`;
const tag = (id: string, name = 'user_mention') =>
	`<mention-component id="node-${id}" entity_identifier="${id}" entity_name="${name}"></mention-component>`;

describe('userMap', () => {
	const map = userMap([
		{ plane: 'p1', discord: 'd1' },
		{ plane: 'p2', discord: 'd2' },
	]);
	test('в обе стороны по таблице, чужой id → null', () => {
		expect(map.toDiscord('p2')).toBe('d2');
		expect(map.toPlane('d1')).toBe('p1');
		expect(map.toDiscord('d1')).toBeNull();
		expect(map.toPlane('p1')).toBeNull();
	});
});

describe('planeMentions', () => {
	test('читает из фикстуры plane-comment-get-mention.json два UUID — бота и человека, по порядку, без id узлов', () => {
		const html = (fixture('plane-comment-get-mention').body as { comment_html: string })
			.comment_html;
		expect(planeMentions(html)).toEqual([
			'00000000-0000-4000-8000-000000000006',
			'00000000-0000-4000-8000-000000000008',
		]);
	});

	test('без дублей; чужой entity_name, закрывающий тег и тег без идентификатора пропускаются', () => {
		const html = `${tag(UUID_B)}${tag(UUID_A)}${tag(UUID_B)}${tag('x', 'issue_mention')}</mention-component entity_identifier="closing" entity_name="user_mention"></mention-component><mention-component entity_name="user_mention"></mention-component><b entity_identifier="y" entity_name="user_mention"></b>`;
		expect(planeMentions(html)).toEqual([UUID_B, UUID_A]);
	});

	test('атрибуты в одинарных кавычках и с сущностями', () => {
		expect(
			planeMentions(`<mention-component entity_identifier='a&amp;b' entity_name='user_mention'>`),
		).toEqual(['a&b']);
	});
});

describe('planeMentionHtml', () => {
	test('planeMentionHtml → planeMentions возвращает тот же UUID', () => {
		expect(planeMentions(planeMentionHtml(UUID_A))).toEqual([UUID_A]);
	});

	test('id узла берётся из nodeId, по умолчанию — свежий UUID; всё экранируется', () => {
		expect(planeMentionHtml('u"<', () => 'n')).toBe(
			'<mention-component id="n" entity_identifier="u&quot;&lt;" entity_name="user_mention"></mention-component>',
		);
		const a = planeMentionHtml(UUID_A);
		expect(a).toMatch(/ id="[\da-f-]{36}" /);
		expect(a).not.toBe(planeMentionHtml(UUID_A));
	});
});

describe('planeHtmlToDiscord', () => {
	const toText = (html: string) => planeHtmlToDiscord(html, m);

	test('абзацы, br, список → строки; не больше одной пустой строки подряд', () => {
		expect(toText('<p>a</p><p></p><p></p><p>b<br>c</p><ul><li>x</li><li>y</li></ul>')).toBe(
			'a\n\nb\nc\n\nx\ny',
		);
		expect(toText('<p>a</p><p>b</p>')).toBe('a\n\nb');
		expect(toText('  a \n  b  <br/> c ')).toBe('a b\nc');
	});

	test('https-ссылка → [t](<url>); javascript: — только текст; &lt;b&gt; → <b> как текст', () => {
		expect(toText('<a href="https://a.test/?x=1&amp;y=2">t</a>')).toBe(
			'[t](<https://a.test/?x=1&y=2>)',
		);
		expect(toText('<a href="HTTP://a.test/">t</a>')).toBe('[t](<HTTP://a.test/>)');
		expect(toText('<a href="javascript:alert(1)">t</a>')).toBe('t');
		expect(toText('<a>t</a>')).toBe('t');
		expect(toText('see <a href="https://a.test/">t</a> now')).toBe(
			'see [t](<https://a.test/>) now',
		);
		expect(toText('&lt;b&gt;x&lt;/b&gt;')).toBe('<b>x</b>');
	});

	test('ссылка: пустой текст → url; скобки в тексте и < > пробел в url не ломают разметку', () => {
		expect(toText('<a href="https://a.test/"></a>')).toBe('[https://a.test/](<https://a.test/>)');
		expect(toText('<a href="https://a.test/">x [1] <b>y</b></a>')).toBe(
			'[x \\[1\\] y](<https://a.test/>)',
		);
		expect(toText('<a href="https://a.test/a b&gt;c&lt;d">t</a>')).toBe(
			'[t](<https://a.test/a%20b%3Ec%3Cd>)',
		);
	});

	test('ссылка: закрывающий </a> без открывающего и незакрытая <a> остаются текстом', () => {
		expect(toText('x</a>y')).toBe('xy');
		expect(toText('<a href="https://a.test/">open')).toBe('open');
		expect(toText('<a href="https://a.test/">one</a></a>two')).toBe('[one](<https://a.test/>)two');
	});

	test('упоминание → то, что вернул mention; чужой entity_name и тег без id — ничего', () => {
		expect(toText(`<p>${tag(UUID_A)} ${tag(UUID_B)} hi ${tag('z', 'issue_mention')}</p>`)).toBe(
			`<@${UUID_A}> <@${UUID_B}> hi`,
		);
		expect(toText('<mention-component entity_name="user_mention"></mention-component>x')).toBe('x');
		expect(toText(`<mention-component entity_identifier="${UUID_A}"></mention-component>x`)).toBe(
			'x',
		);
		expect(planeHtmlToDiscord(tag(UUID_A), () => '@Имя')).toBe('@Имя');
		expect(
			toText(`</mention-component entity_identifier="${UUID_A}" entity_name="user_mention">x`),
		).toBe('x');
		// the same mention inside a link label
		expect(toText(`<a href="https://a.test/">${tag('7')}</a>`)).toBe('[<@7>](<https://a.test/>)');
	});

	test('текст из Plane не порождает упоминаний: @everyone, @here, <@id>, <@&id>, в том числе через сущности и разрыв тегами', () => {
		expect(toText('<p>@everyone @here @EVERYONE</p>')).toBe('@​everyone @​here @​EVERYONE');
		expect(toText('<p>&lt;@1&gt; &lt;@&amp;2&gt; &lt;@!3&gt;</p>')).toBe('<​@1> <​@&2> <​@!3>');
		expect(toText('&#64;everyone &#x40;here')).toBe('@​everyone @​here');
		expect(toText('@<b></b>everyone')).toBe('@​everyone');
		expect(toText('&lt;<i></i>@5>')).toBe('<​@5>');
		expect(toText('<a href="https://a.test/">@everyone</a>')).toBe(
			'[@​everyone](<https://a.test/>)',
		);
		expect(toText('mail a@b.test')).toBe('mail a@b.test');
		// the mention callback's own output is not defanged
		expect(toText(tag('9'))).toBe('<@9>');
	});

	test('служебные символы из входа не подделывают вставки; сущности — за один проход', () => {
		const [open, close] = [String.fromCharCode(0xe000), String.fromCharCode(0xe001)];
		expect(toText(`x${open}0${close}y &#xE000;0&#xE001;`)).toBe('x0y 0');
		expect(toText('&amp;lt; &#65;&#x42; a&nbsp;b')).toBe('&lt; AB a b');
		expect(toText('&#0; &#1114112; &#xD800; &foo; &AMP;')).toBe('&#0; &#1114112; &#xD800; &foo; &');
	});

	test('служебные символы перед тегом и внутри тега удаляются, не бросают', () => {
		expect(toText('<p>x&#xE000;0&#xE001;y</p>')).toBe('x0y');
		expect(toText('<b>a&#xE000;7&#xE001;</b>')).toBe('a7');
	});

	test('подделка вставок через href не ломает разбор: нет TypeError и бесконечной рекурсии', () => {
		const a = toText('<a href="https://x/&#xE000;99&#xE001;">l</a>');
		expect(a).toBe('[l](<https://x/99>)');
		const b = toText(`${tag('1')}<a href="https://x/&#xE000;1&#xE001;">l</a>`);
		expect(b).toBe('<@1>[l](<https://x/1>)');
		// ...and via the label (same link text, marker in the visible part)
		expect(toText('<a href="https://x/">a&#xE000;5&#xE001;</a>')).toBe('[a5](<https://x/>)');
	});

	test('имя пользователя из callback проходит через защиту от упоминаний; <@id> остаётся', () => {
		expect(planeHtmlToDiscord(tag(UUID_A), () => '@everyone')).toBe('@​everyone');
		expect(planeHtmlToDiscord(tag(UUID_A), () => '@here x')).toBe('@​here x');
		expect(planeHtmlToDiscord(tag(UUID_A), () => '<@&5>')).toBe('<​@&5>');
		expect(planeHtmlToDiscord(tag(UUID_A), () => '<@42>')).toBe('<@42>');
		expect(planeHtmlToDiscord(tag(UUID_A), () => '@a\uE000b')).toBe('@ab');
	});

	test('имя из callback не склеивается с соседним текстом в пинг; пустое имя ничего не склеивает', () => {
		const at = (html: string, name: string) => planeHtmlToDiscord(html, () => name);
		expect(at(`@${tag(UUID_A)}`, 'everyone')).toBe('@​everyone');
		expect(at(`@${tag(UUID_A)}everyone`, '')).toBe('@​everyone');
		expect(at(`<p>&lt;${tag(UUID_A)}</p>`, '@123>')).toBe('<​@123>');
		// a genuine ping next to the same neighbours stays a ping
		expect(at(`@${tag(UUID_A)}`, '<@123456789012345678>')).toBe('@<@123456789012345678>');
		expect(at(tag(UUID_A), '<@123456789012345678>')).toBe('<@123456789012345678>');
	});

	test('имя упоминания в метке ссылки не внедряет вторую ссылку', () => {
		const html = `<a href="https://a.test/">${tag(UUID_A)}</a>`;
		expect(planeHtmlToDiscord(html, () => 'x](<https://evil>)[')).toBe(
			'[x\\](<https://evil>)\\[](<https://a.test/>)',
		);
	});

	test('@everyone в адресе ссылки кодируется как %40, ссылка остаётся ссылкой', () => {
		expect(toText('<a href="https://x/@everyone/@here">t</a>')).toBe(
			'[t](<https://x/%40everyone/%40here>)',
		);
		expect(toText('<a href="https://u@host/">t</a>')).toBe('[t](<https://u@host/>)');
	});

	test('фикстура: упоминания из ответа Plane', () => {
		const html = (fixture('plane-comment-get-mention').body as { comment_html: string })
			.comment_html;
		expect(planeHtmlToDiscord(html, (id) => `[${id.slice(-1)}]`)).toBe('[6] [8] test');
	});
});

describe('discordToPlaneHtml', () => {
	const toHtml = (text: string) => discordToPlaneHtml(text, (id) => `[M${id}]`);

	test('<script> экранирован; пустая строка → два <p>; перевод строки → <br>', () => {
		expect(toHtml('<script>alert("x")</script>')).toBe(
			'<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>',
		);
		expect(toHtml('a\n\nb')).toBe('<p>a</p><p>b</p>');
		expect(toHtml('a\nb')).toBe('<p>a<br>b</p>');
		expect(toHtml('\r\na\r\n  \r\n\r\nb \r\n')).toBe('<p>a</p><p>b</p>');
		expect(toHtml('')).toBe('');
		expect(toHtml(' \n ')).toBe('');
	});

	test('<@1> и <@!1> → mention("1"); <@&2> → @роль; <#3> → #канал; <:ok:4> → :ok:', () => {
		expect(toHtml('<@1> <@!1> <@&2> <#3> <:ok:4> <a:wave:5>')).toBe(
			'<p>[M1] [M1] @роль #канал :ok: :wave:</p>',
		);
	});

	test('упоминание внутри кода остаётся текстом; код экранируется', () => {
		expect(toHtml('`<@1> <b>` и <@1>')).toBe('<p><code>&lt;@1&gt; &lt;b&gt;</code> и [M1]</p>');
	});

	test('голый URL и [t](https://x) → <a>; блок кода в тройных кавычках → <pre><code>', () => {
		expect(
			toHtml('see https://a.test/x?a=1&b=2, [t<](https://x.test) [u](<https://y.test/z>)'),
		).toBe(
			'<p>see <a href="https://a.test/x?a=1&amp;b=2">https://a.test/x?a=1&amp;b=2</a>, <a href="https://x.test">t&lt;</a> <a href="https://y.test/z">u</a></p>',
		);
		expect(toHtml('(https://a.test/x).')).toBe(
			'<p>(<a href="https://a.test/x">https://a.test/x</a>).</p>',
		);
		expect(toHtml('before\n```js\nlet a = "<b>";\n\nb\n```\nafter')).toBe(
			'<p>before</p><pre><code>let a = &quot;&lt;b&gt;&quot;;\n\nb</code></pre><p>after</p>',
		);
		expect(toHtml('```x y```')).toBe('<pre><code>x y</code></pre>');
		expect(toHtml('``````')).toBe('<pre><code></code></pre>');
	});

	test('нe-http схемы и разметка в атрибутах не проходят; остальной markdown остаётся как есть', () => {
		expect(toHtml('[t](javascript:alert(1)) [x](https://a.test/"onmouseover="y)')).toBe(
			'<p>[t](javascript:alert(1)) <a href="https://a.test/&quot;onmouseover=&quot;y">x</a></p>',
		);
		expect(toHtml('**b** _i_ ```unclosed')).toBe('<p>**b** _i_ ```unclosed</p>');
	});
});

describe('workItemKey / workItemUrl / titleFrom', () => {
	test('workItemKey LAB + 41 → LAB-41; workItemUrl без двойных слэшей', () => {
		expect(workItemKey('LAB', 41)).toBe('LAB-41');
		expect(workItemUrl('https://plane.example.com', 'example-ws', 'LAB-41')).toBe(
			'https://plane.example.com/example-ws/browse/LAB-41/',
		);
		expect(workItemUrl('https://plane.example.com//', 'example-ws', 'LAB-41')).toBe(
			'https://plane.example.com/example-ws/browse/LAB-41/',
		);
		expect(workItemUrl('https://plane.example.com', 'a/b', 'K 1')).toBe(
			'https://plane.example.com/a%2Fb/browse/K%201/',
		);
	});

	test('titleFrom: первая непустая строка; 300 символов → 255; одни пробелы → пустая строка', () => {
		expect(titleFrom('\n  \r\n  Привет мир  \nвторая')).toBe('Привет мир');
		expect(titleFrom('a'.repeat(255))).toBe('a'.repeat(255));
		const cut = titleFrom('😀'.repeat(300));
		expect(Array.from(cut).length).toBe(255);
		expect(cut.endsWith('😀…')).toBe(true);
		expect(titleFrom('  \n\t ')).toBe('');
		expect(titleFrom('')).toBe('');
	});
});
