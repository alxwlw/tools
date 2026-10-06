import { describe, expect, test } from "bun:test";
import { type NewWorkItem, PlaneApiError, PlaneClient } from "../src/plane.ts";

type Reply = { status: number; body?: unknown; raw?: string };
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

const ROOT = "https://plane.test/api/v1/workspaces/liq-egn";

function stub(replies: Reply[]) {
	const calls: Call[] = [];
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({
			url,
			method: init.method ?? "GET",
			headers: init.headers as Record<string, string>,
			body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
		});
		const reply = replies.shift();
		if (!reply) throw new Error(`unexpected request ${init.method} ${url}`);
		const text = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
		return new Response(text, { status: reply.status });
	};
	const client = new PlaneClient({ baseUrl: "https://plane.test/", workspace: "liq-egn", apiKey: "key-1", fetch });
	return { calls, client };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("expected a rejection");
		},
		(err: unknown) => err,
	);
}

const item: NewWorkItem = {
	name: "[prod] ServiceDown",
	description_html: "<p>d</p>",
	priority: "urgent",
	labels: ["label-1"],
	external_id: "fp1",
	external_source: "grafana",
};

describe("PlaneClient: создание с 409", () => {
	test("201 → created:true; URL, метод, ключ и тело запроса", async () => {
		const { calls, client } = stub([{ status: 201, body: { id: "w1" } }]);
		expect(await client.createWorkItem("p1", item)).toEqual({ id: "w1", created: true });
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/`);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.headers["X-API-Key"]).toBe("key-1");
		expect(calls[0]?.body).toEqual(item);
	});

	test("409 → created:false и id существующей задачи", async () => {
		const { client } = stub([{ status: 409, body: { error: "exists", id: "w0" } }]);
		expect(await client.createWorkItem("p1", item)).toEqual({ id: "w0", created: false });
	});

	test("комментарий: 201 и 409", async () => {
		const comment = { comment_html: "<p>c</p>", external_id: "fp1:t:firing", external_source: "grafana" };
		const { calls, client } = stub([
			{ status: 201, body: { id: "c1" } },
			{ status: 409, body: { error: "exists", id: "c1" } },
		]);
		expect(await client.createComment("p1", "w1", comment)).toEqual({ id: "c1", created: true });
		expect(await client.createComment("p1", "w1", comment)).toEqual({ id: "c1", created: false });
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/comments/`);
		expect(calls[0]?.body).toEqual(comment);
	});
});

describe("PlaneClient: поиск", () => {
	test("по external_id: 404 → null, 200 → id, параметры закодированы", async () => {
		const { calls, client } = stub([{ status: 404, body: { error: "nope" } }, { status: 200, body: { id: "w1" } }]);
		expect(await client.findWorkItemByExternalId("p1", "vercel", "deploy:prj:production:main")).toBeNull();
		expect(await client.findWorkItemByExternalId("p1", "vercel", "deploy:prj:production:main")).toEqual({ id: "w1" });
		expect(calls[0]?.url).toBe(
			`${ROOT}/projects/p1/work-items/?external_id=deploy%3Aprj%3Aproduction%3Amain&external_source=vercel`,
		);
	});

	test("по ключу: 404 → null, 200 → ref", async () => {
		const { calls, client } = stub([
			{ status: 404, raw: "<html>not found</html>" },
			{ status: 200, body: { id: "w12", project: "p-ops", state: "s1", name: "x" } },
		]);
		expect(await client.getWorkItemByKey("OPS-99")).toBeNull();
		expect(await client.getWorkItemByKey("OPS-12")).toEqual({ id: "w12", project: "p-ops", state: "s1" });
		expect(calls[1]?.url).toBe(`${ROOT}/work-items/OPS-12/`);
	});

	test("getWorkItem и смена состояния", async () => {
		const { calls, client } = stub([
			{ status: 200, body: { id: "w1", project: "p1", state: "s-done" } },
			{ status: 200, body: { id: "w1", project: "p1", state: "s-backlog" } },
		]);
		expect(await client.getWorkItem("p1", "w1")).toEqual({ id: "w1", project: "p1", state: "s-done" });
		await client.setWorkItemState("p1", "w1", "s-backlog");
		expect(calls[1]?.method).toBe("PATCH");
		expect(calls[1]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/`);
		expect(calls[1]?.body).toEqual({ state: "s-backlog" });
	});
});

describe("PlaneClient: списки", () => {
	test("комментарии: идёт по курсору через все страницы", async () => {
		const { calls, client } = stub([
			{
				status: 200,
				body: {
					results: [{ id: "c1", external_id: "k:a:firing", created_at: "2026-10-06T10:00:00Z" }],
					next_page_results: true,
					next_cursor: "100:1:0",
				},
			},
			{
				status: 200,
				body: {
					results: [{ id: "c2", external_id: null, created_at: "2026-10-06T10:05:00Z" }],
					next_page_results: false,
					next_cursor: "100:2:0",
				},
			},
		]);
		expect(await client.listComments("p1", "w1")).toEqual([
			{ id: "c1", external_id: "k:a:firing", created_at: "2026-10-06T10:00:00Z" },
			{ id: "c2", external_id: null, created_at: "2026-10-06T10:05:00Z" },
		]);
		expect(calls[0]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/comments/?per_page=100`);
		expect(calls[1]?.url).toBe(`${ROOT}/projects/p1/work-items/w1/comments/?per_page=100&cursor=100%3A1%3A0`);
	});

	test("состояния: голый массив", async () => {
		const { client } = stub([
			{
				status: 200,
				body: [
					{ id: "s1", group: "backlog", default: true, name: "Backlog" },
					{ id: "s2", group: "completed", default: false, name: "Done" },
				],
			},
		]);
		expect(await client.listStates("p1")).toEqual([
			{ id: "s1", group: "backlog", default: true },
			{ id: "s2", group: "completed", default: false },
		]);
	});

	test("идентификаторы проектов, метки, создание метки", async () => {
		const { calls, client } = stub([
			{ status: 200, body: { results: [{ id: "p1", identifier: "OPS" }], next_page_results: false } },
			{ status: 200, body: { results: [{ id: "l1", name: "alert" }], next_page_results: false } },
			{ status: 201, body: { id: "l2", name: "deploy-failed" } },
		]);
		expect(await client.listProjectIdentifiers()).toEqual(["OPS"]);
		expect(await client.listLabels("p1")).toEqual([{ id: "l1", name: "alert" }]);
		expect(await client.createLabel("p1", "deploy-failed")).toEqual({ id: "l2", name: "deploy-failed" });
		expect(calls[2]?.body).toEqual({ name: "deploy-failed", color: "#d9534f" });
	});

	test("неожиданная форма списка → ошибка", async () => {
		const { client } = stub([{ status: 200, body: { foo: 1 } }]);
		expect(await failure(client.listStates("p1"))).toBeInstanceOf(Error);
	});
});

describe("PlaneClient: ошибки", () => {
	test("429 и 500 → PlaneApiError со статусом, без тела ответа в сообщении", async () => {
		const { client } = stub([
			{ status: 429, body: { detail: "secret-ish body" } },
			{ status: 500, body: { detail: "boom" } },
		]);
		const rateLimited = await failure(client.createWorkItem("p1", item));
		expect(rateLimited).toBeInstanceOf(PlaneApiError);
		expect((rateLimited as PlaneApiError).status).toBe(429);
		expect((rateLimited as PlaneApiError).message).not.toContain("secret-ish");
		const broken = await failure(client.createWorkItem("p1", item));
		expect((broken as PlaneApiError).status).toBe(500);
	});

	test("404 там, где его не ждут, — ошибка, а не null", async () => {
		const { client } = stub([{ status: 404, body: { error: "nope" } }]);
		const err = await failure(client.getWorkItem("p1", "w404"));
		expect((err as PlaneApiError).status).toBe(404);
	});

	test("200 не-JSON → ошибка именно о не-JSON", async () => {
		const { client } = stub([{ status: 200, raw: "<html>proxy page</html>" }]);
		const err = await failure(client.getWorkItem("p1", "w1"));
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe("Plane GET /projects/p1/work-items/w1/: response is not JSON");
	});

	test("ошибка запроса с параметрами: в сообщении путь без query (external_id в лог не попадает)", async () => {
		const { client } = stub([{ status: 429, body: { detail: "throttled" } }]);
		const err = await failure(client.findWorkItemByExternalId("p1", "vercel", "deploy:prj_x:production:secret-branch"));
		expect((err as PlaneApiError).status).toBe(429);
		expect((err as PlaneApiError).message).toBe("Plane GET /projects/p1/work-items/ → 429");
		expect((err as PlaneApiError).message).not.toContain("?");
		expect((err as PlaneApiError).path).toBe("/projects/p1/work-items/");
	});

	test("таймаут прерывает запрос", async () => {
		const hang = (_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			});
		const client = new PlaneClient({ baseUrl: "https://plane.test", workspace: "liq-egn", apiKey: "k", timeoutMs: 20, fetch: hang });
		expect(await failure(client.listStates("p1"))).toBeDefined();
	});
});
