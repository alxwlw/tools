import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type DeployNote, postDeployNotes } from "../src/deploy-note.ts";
import { PlaneApiError } from "../src/plane.ts";
import { FakePlane, type FakeWorkItem } from "./fake-plane.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const URL_ = "https://terminal-abc123-liq.vercel.app";

function note(texts: string[], overrides: Partial<DeployNote> = {}): DeployNote {
	return {
		deploymentId: "dpl_ok1",
		project: "terminal",
		target: "production",
		sha: SHA,
		url: URL_,
		texts,
		source: "vercel",
		keyLimit: 10,
		...overrides,
	};
}

let plane: FakePlane;
let ops12: FakeWorkItem;
let mono3: FakeWorkItem;
const post = (n: DeployNote) =>
	postDeployNotes({ plane, projectIdentifiers: async () => new Set(await plane.listProjectIdentifiers()) }, n);

beforeEach(() => {
	plane = new FakePlane({ OPS: "p-ops", MONO: "p-mono", SEC: "p-sec" });
	ops12 = plane.seedWorkItem("p-ops", { sequence: 12 });
	mono3 = plane.seedWorkItem("p-mono", { sequence: 3 });
	plane.seedWorkItem("p-sec", { sequence: 1 });
});

describe("postDeployNotes", () => {
	test("комментарий в каждую найденную задачу, в её проекте", async () => {
		const results = await post(note(["feat/ops-12-plane-hooks", "fix: [MONO-3] y"]));
		expect(results).toEqual([
			{ key: "OPS-12", action: "commented", workItemId: ops12.id, ms: expect.any(Number) },
			{ key: "MONO-3", action: "commented", workItemId: mono3.id, ms: expect.any(Number) },
		]);
		const [opsNote] = plane.commentsOf(ops12.id);
		expect(opsNote).toMatchObject({
			project: "p-ops",
			external_id: "note:dpl_ok1:OPS-12",
			external_source: "vercel",
			comment_html: `<p>Выкачено: <code>terminal</code> → production · <code>0123456</code> · <a href="${URL_}">${URL_}</a></p>`,
		});
		expect(plane.commentsOf(mono3.id)[0]?.project).toBe("p-mono");
	});

	test("повтор того же деплоя — noop, комментарии не множатся", async () => {
		await post(note(["ops-12"]));
		expect(await post(note(["ops-12"]))).toEqual([{ key: "OPS-12", action: "noop", workItemId: ops12.id, ms: expect.any(Number) }]);
		expect(plane.commentsOf(ops12.id)).toHaveLength(1);
	});

	test("несуществующая задача — skipped", async () => {
		expect(await post(note(["OPS-99"]))).toEqual([{ key: "OPS-99", action: "skipped", workItemId: null, ms: expect.any(Number) }]);
		expect(plane.comments).toHaveLength(0);
	});

	test("проект без доступа (403) — skipped, остальные ключи обрабатываются", async () => {
		plane.forbiddenProjects.add("p-sec");
		const results = await post(note(["SEC-1 OPS-12"]));
		expect(results.map((r) => [r.key, r.action])).toEqual([
			["SEC-1", "skipped"],
			["OPS-12", "commented"],
		]);
	});

	test("чужой префикс в Plane не запрашивается", async () => {
		expect(await post(note(["FOO-1 main"]))).toEqual([]);
		expect(plane.calls).not.toContain("getWorkItemByKey");
	});

	test("без текстов — ни одного вызова Plane", async () => {
		expect(await post(note([]))).toEqual([]);
		expect(plane.calls).toEqual([]);
	});

	test("сбой Plane кроме 403/404 пробрасывается", async () => {
		plane.failNext("createComment", new PlaneApiError(500, "POST", "/comments/"));
		const err = await post(note(["ops-12"])).catch((e: unknown) => e);
		expect((err as PlaneApiError).status).toBe(500);
	});

	test("без sha и с HTML в имени проекта", async () => {
		await post(note(["ops-12"], { sha: undefined, project: "<x>" }));
		expect(plane.commentsOf(ops12.id)[0]?.comment_html).toBe(
			`<p>Выкачено: <code>&lt;x&gt;</code> → production · <a href="${URL_}">${URL_}</a></p>`,
		);
	});

	test("404 при комментарии — skipped", async () => {
		plane.failNext("createComment", new PlaneApiError(404, "POST", "/comments/"));
		expect(await post(note(["ops-12"]))).toEqual([{ key: "OPS-12", action: "skipped", workItemId: null, ms: expect.any(Number) }]);
		expect(plane.comments).toHaveLength(0);
	});

	test("текст target в комментарии", async () => {
		await post(note(["ops-12"], { target: "preview" }));
		expect(plane.commentsOf(ops12.id)[0]?.comment_html).toBe(
			`<p>Выкачено: <code>terminal</code> → preview · <code>0123456</code> · <a href="${URL_}">${URL_}</a></p>`,
		);
	});

	test("ms у каждого ключа — длительность его собственных вызовов Plane", async () => {
		const ticks = [100, 105, 200, 211];
		const now = spyOn(performance, "now").mockImplementation(() => ticks.shift() ?? Number.NaN);
		try {
			const results = await post(note(["feat/ops-12", "fix: [MONO-3]"]));
			expect(results.map((r) => [r.key, r.ms])).toEqual([
				["OPS-12", 5],
				["MONO-3", 11],
			]);
		} finally {
			now.mockRestore();
		}
	});

	test("запасной вывод url когда link() отклоняет", async () => {
		await post(note(["ops-12"], { url: "javascript:alert(1)" }));
		expect(plane.commentsOf(ops12.id)[0]?.comment_html).toBe(
			`<p>Выкачено: <code>terminal</code> → production · <code>0123456</code> · javascript:alert(1)</p>`,
		);
	});

	test("external_source заметки — источник события", async () => {
		await post(note(["ops-12"], { deploymentId: "gh:staging:" + SHA, source: "github" }));
		expect(plane.commentsOf(ops12.id)[0]).toMatchObject({
			external_id: `note:gh:staging:${SHA}:OPS-12`,
			external_source: "github",
		});
	});

	test("лимит ключей берётся из заметки", async () => {
		const many = Array.from({ length: 12 }, (_, i) => `OPS-${i + 1}`).join(" ");
		expect(await post(note([many], { keyLimit: 11 }))).toHaveLength(11);
		expect(await post(note([many], { deploymentId: "dpl_ok2" }))).toHaveLength(10);
	});
});
