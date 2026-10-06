import { describe, expect, test } from "bun:test";
import { extractWorkItemKeys } from "../src/work-item-keys.ts";

const ids = new Set(["OPS", "MONO"]);

describe("extractWorkItemKeys", () => {
	test("ветка в нижнем регистре", () => {
		expect(extractWorkItemKeys(["feat/ops-12-plane-hooks"], ids)).toEqual(["OPS-12"]);
	});

	test("сообщение коммита: скобки, несколько ключей, без повторов", () => {
		expect(extractWorkItemKeys(["fix(x): [OPS-3] and MONO-45, see OPS-3 again"], ids)).toEqual(["OPS-3", "MONO-45"]);
	});

	test("чужие префиксы отбрасываются", () => {
		expect(extractWorkItemKeys(["release-2026-10-06 FOO-1"], ids)).toEqual([]);
	});

	test("подчёркивание — разделитель", () => {
		expect(extractWorkItemKeys(["feat_ops-7"], ids)).toEqual(["OPS-7"]);
	});

	test("ведущие нули отбрасываются", () => {
		expect(extractWorkItemKeys(["OPS-007"], ids)).toEqual(["OPS-7"]);
	});

	test("больше шести цифр — не ключ", () => {
		expect(extractWorkItemKeys(["OPS-1234567"], ids)).toEqual([]);
	});

	test("порядок первого упоминания по всем текстам", () => {
		expect(extractWorkItemKeys(["ops-2", "OPS-1 OPS-2"], ids)).toEqual(["OPS-2", "OPS-1"]);
	});

	test("не больше limit ключей, первые по порядку", () => {
		const text = Array.from({ length: 12 }, (_, i) => `OPS-${i + 1}`).join(" ");
		expect(extractWorkItemKeys([text], ids)).toEqual(Array.from({ length: 10 }, (_, i) => `OPS-${i + 1}`));
		expect(extractWorkItemKeys([text], ids, 2)).toEqual(["OPS-1", "OPS-2"]);
	});

	test("соседи отбрасывают совпадение: цифра или буква перед префиксом", () => {
		expect(extractWorkItemKeys(["2OPS-1 verylongwordops-2"], ids)).toEqual([]);
	});

	test("префикс ровно 12 букв принимается, 13 отбрасывается", () => {
		const set12 = new Set(["ABCDEFGHIJKL", "ABCDEFGHIJKLM"]);
		expect(extractWorkItemKeys(["ABCDEFGHIJKL-1"], set12)).toEqual(["ABCDEFGHIJKL-1"]);
		expect(extractWorkItemKeys(["ABCDEFGHIJKLM-1"], set12)).toEqual([]);
	});
});
