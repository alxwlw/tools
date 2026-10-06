import { describe, expect, test } from "bun:test";
import { esc, link, p, truncate, utc } from "../src/html.ts";

describe("esc", () => {
	test("экранирует все пять символов", () => {
		expect(esc(`<script>alert("x") & 'y'</script>`)).toBe(
			"&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;",
		);
	});
});

describe("link", () => {
	test("http(s) превращается в ссылку с экранированием", () => {
		expect(link("https://a.test/?x=1&y=2", "t<")).toBe('<a href="https://a.test/?x=1&amp;y=2">t&lt;</a>');
		expect(link("HTTP://a.test/", "t")).toBe('<a href="HTTP://a.test/">t</a>');
	});

	test("не http(s) и пустые значения отбрасываются", () => {
		expect(link("javascript:alert(1)", "t")).toBeNull();
		expect(link("JAVASCRIPT:alert(1)", "t")).toBeNull();
		expect(link("data:text/html,x", "t")).toBeNull();
		expect(link("/relative", "t")).toBeNull();
		expect(link("", "t")).toBeNull();
		expect(link(undefined, "t")).toBeNull();
		expect(link(null, "t")).toBeNull();
	});
});

describe("p", () => {
	test("оборачивает в абзац без экранирования", () => {
		expect(p("<b>x</b>")).toBe("<p><b>x</b></p>");
	});
});

describe("utc", () => {
	test("ISO с Z и со смещением → минуты в UTC", () => {
		expect(utc("2026-10-06T12:34:56.789Z")).toBe("2026-10-06 12:34");
		expect(utc("2026-10-06T15:34:00+03:00")).toBe("2026-10-06 12:34");
	});

	test("неразборная дата бросает", () => {
		expect(() => utc("not-a-date")).toThrow(RangeError);
	});
});

describe("truncate", () => {
	test("короткий текст не меняется", () => {
		expect(truncate("abc", 3)).toBe("abc");
	});

	test("длинный режется до max и кончается многоточием", () => {
		const out = truncate("x".repeat(300), 200);
		expect(out).toHaveLength(200);
		expect(out.endsWith("…")).toBe(true);
	});

	test("считает кодовые точки: эмодзи на границе не разрезается на одинокий суррогат", () => {
		const out = truncate(`${"a".repeat(198)}😀tail`, 200);
		expect(out).toBe(`${"a".repeat(198)}😀…`);
		expect(out).not.toMatch(/\p{Surrogate}/u);
		expect(Array.from(out)).toHaveLength(200);
	});

	test("ровно max кодовых точек с эмодзи (201 код. единица) не режется", () => {
		const text = `${"a".repeat(199)}😀`;
		expect(text).toHaveLength(201);
		expect(truncate(text, 200)).toBe(text);
	});
});
