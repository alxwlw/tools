import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { DeployNote, DeployNoteResult } from "../src/deploy-note.ts";
import type { IncidentResult, IncidentSignal } from "../src/incident.ts";
import { PlaneApiError } from "../src/plane.ts";
import { createHandler, type LogEntry, MAX_BODY_BYTES } from "../src/server.ts";
import { fixture, fixtureBytes } from "./fixtures.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = `ph_${"a1".repeat(24)}`;
const SECRET = "vercel-test-secret";
const DEPLOY_SECRET = "deploy-test-secret";
const DEPLOY_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const BASE = "http://plane-hooks:8080";

type Options = {
	report?: (signal: IncidentSignal) => Promise<IncidentResult>;
	notes?: (note: DeployNote) => Promise<DeployNoteResult[]>;
};

function harness(options: Options = {}) {
	const signals: IncidentSignal[] = [];
	const notes: DeployNote[] = [];
	const logs: LogEntry[] = [];
	const handler = createHandler({
		grafanaToken: TOKEN,
		vercelSecret: SECRET,
		deploySecret: DEPLOY_SECRET,
		incidents: {
			report: async (signal) => {
				signals.push(signal);
				return options.report ? options.report(signal) : { action: "created", workItemId: "w1" };
			},
		},
		deployNotes: async (note) => {
			notes.push(note);
			return options.notes ? options.notes(note) : [{ key: "OPS-12", action: "commented", workItemId: "w12", ms: 3 }];
		},
		log: (entry) => logs.push(entry),
	});
	return { handler, signals, notes, logs };
}

function grafana(body: string | Uint8Array, authorization: string | null = `Bearer ${TOKEN}`): Request {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (authorization !== null) headers.authorization = authorization;
	return new Request(`${BASE}/hooks/grafana`, { method: "POST", headers, body });
}

function vercel(raw: Uint8Array, signature: string | null = createHmac("sha1", SECRET).update(raw).digest("hex")): Request {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (signature !== null) headers["x-vercel-signature"] = signature;
	return new Request(`${BASE}/hooks/vercel`, { method: "POST", headers, body: raw });
}

function deployRequest(
	raw: Uint8Array,
	signature: string | null = createHmac("sha256", DEPLOY_SECRET).update(raw).digest("hex"),
	headers: Record<string, string> = {},
): Request {
	const all: Record<string, string> = { "content-type": "application/json", ...headers };
	if (signature !== null) all["x-plane-hooks-signature"] = signature;
	return new Request(`${BASE}/hooks/deploy`, { method: "POST", headers: all, body: raw });
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("маршруты", () => {
	test("healthz, неизвестный путь, неверный метод", async () => {
		const { handler } = harness();
		const health = await handler(new Request(`${BASE}/healthz`));
		expect(health.status).toBe(200);
		expect(await health.text()).toBe("ok");
		expect((await handler(new Request(`${BASE}/healthz`, { method: "POST" }))).status).toBe(405);
		expect((await handler(new Request(`${BASE}/nope`))).status).toBe(404);
		expect((await handler(new Request(`${BASE}/hooks/grafana`))).status).toBe(405);
	});
});

describe("/hooks/grafana", () => {
	test.each([null, "Bearer wrong", `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, TOKEN])("авторизация %p → 401", async (auth) => {
		const { handler, signals } = harness();
		const res = await handler(grafana(await fixtureBytes("grafana-firing.json"), auth));
		expect(res.status).toBe(401);
		expect(signals).toHaveLength(0);
	});

	test("пачка обработана: 200, по строке лога на алерт, без токена в логе", async () => {
		const { handler, signals, logs } = harness();
		const res = await handler(grafana(await fixtureBytes("grafana-firing.json")));
		expect(res.status).toBe(200);
		expect(signals.map((s) => s.key)).toEqual(["a1b2c3d4e5f60718", "0f1e2d3c4b5a6978"]);
		expect(logs.map((l) => [l.source, l.event, l.key, l.action, l.workItemId])).toEqual([
			["grafana", "alert.firing", "a1b2c3d4e5f60718", "created", "w1"],
			["grafana", "alert.firing", "0f1e2d3c4b5a6978", "created", "w1"],
		]);
		expect(logs.every((l) => typeof l.ms === "number")).toBe(true);
		expect(JSON.stringify(logs)).not.toContain(TOKEN);
	});

	test("не JSON и чужая форма → 400", async () => {
		const { handler, signals } = harness();
		expect((await handler(grafana("{not json"))).status).toBe(400);
		expect((await handler(grafana("{}"))).status).toBe(400);
		expect(signals).toHaveLength(0);
	});

	test("тело больше 1 МБ → 413, ровно 1 МБ разбирается", async () => {
		const { handler } = harness();
		expect((await handler(grafana(" ".repeat(MAX_BODY_BYTES + 1)))).status).toBe(413);
		expect((await handler(grafana(" ".repeat(MAX_BODY_BYTES)))).status).toBe(400);
	});

	test("один алерт упал (429) → 502, остальные всё равно обработаны", async () => {
		const { handler, signals, logs } = harness({
			report: async (signal) => {
				if (signal.key === "a1b2c3d4e5f60718") throw new PlaneApiError(429, "POST", "/projects/p/work-items/");
				return { action: "created", workItemId: "w2" };
			},
		});
		const res = await handler(grafana(await fixtureBytes("grafana-firing.json")));
		expect(res.status).toBe(502);
		expect(signals).toHaveLength(2);
		expect(logs.map((l) => l.action)).toEqual(["error", "created"]);
		expect(logs[0]?.error).toBe("PlaneApiError: Plane POST /projects/p/work-items/ → 429");
	});
});

describe("/hooks/vercel", () => {
	test("неверная или отсутствующая подпись → 401", async () => {
		const raw = await fixtureBytes("vercel-deployment-error.json");
		for (const signature of [null, "0".repeat(40), createHmac("sha1", "other").update(raw).digest("hex")]) {
			const { handler, signals } = harness();
			expect((await handler(vercel(raw, signature))).status).toBe(401);
			expect(signals).toHaveLength(0);
		}
	});

	test("другой тип события → 200 ignored, Plane не трогается", async () => {
		const { handler, signals, notes, logs } = harness();
		const res = await handler(vercel(bytes({ type: "deployment.created", payload: {} })));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ignored");
		expect(signals).toHaveLength(0);
		expect(notes).toHaveLength(0);
		expect(logs[0]?.action).toBe("ignored");
	});

	test("deployment.error → сигнал срабатывания", async () => {
		const { handler, signals } = harness();
		const res = await handler(vercel(await fixtureBytes("vercel-deployment-error.json")));
		expect(res.status).toBe(200);
		expect(signals.map((s) => [s.status, s.key])).toEqual([
			["firing", "deploy:prj_terminal:production:feat/ops-12-plane-hooks"],
		]);
	});

	test("deployment.succeeded → восстановление и заметки, по строке лога на ключ", async () => {
		const { handler, signals, notes, logs } = harness({ report: async () => ({ action: "noop", workItemId: null }) });
		const res = await handler(vercel(await fixtureBytes("vercel-deployment-succeeded.json")));
		expect(res.status).toBe(200);
		expect(signals[0]?.status).toBe("resolved");
		expect(notes[0]?.deploymentId).toBe("dpl_ok1");
		expect(logs.map((l) => [l.key, l.action])).toEqual([
			["deploy:prj_terminal:production:feat/ops-12-plane-hooks", "noop"],
			["OPS-12", "commented"],
		]);
	});

	test("Plane упал на восстановлении → 502, заметки не пишутся", async () => {
		const { handler, notes } = harness({
			report: async () => {
				throw new PlaneApiError(429, "GET", "/work-items/");
			},
		});
		expect((await handler(vercel(await fixtureBytes("vercel-deployment-succeeded.json")))).status).toBe(502);
		expect(notes).toHaveLength(0);
	});

	test("Plane упал на заметках → 502", async () => {
		const { handler } = harness({
			notes: async () => {
				throw new PlaneApiError(500, "POST", "/comments/");
			},
		});
		expect((await handler(vercel(await fixtureBytes("vercel-deployment-succeeded.json")))).status).toBe(502);
	});

	test("подписанный не-JSON и подписанная чужая форма → 400", async () => {
		const { handler } = harness();
		expect((await handler(vercel(new TextEncoder().encode("{not json")))).status).toBe(400);
		expect((await handler(vercel(bytes({ type: "deployment.error" })))).status).toBe(400);
	});
});

describe("аутентификация и размер тела: порядок проверок", () => {
	test("Grafana: без токена 401 раньше чтения тела — даже у огромного тела", async () => {
		const { handler } = harness();
		const req = grafana(" ".repeat(MAX_BODY_BYTES + 1), null);
		expect((await handler(req)).status).toBe(401);
		expect(req.bodyUsed).toBe(false);
	});

	test("Grafana: префикс ровно «Bearer » (7 символов другого вида не подходят)", async () => {
		const { handler, signals } = harness();
		expect((await handler(grafana(await fixtureBytes("grafana-firing.json"), `Token: ${TOKEN}`))).status).toBe(401);
		expect(signals).toHaveLength(0);
	});

	test("Vercel: подпись не того вида или её нет → 401 раньше чтения тела, без строки лога", async () => {
		const raw = await fixtureBytes("vercel-deployment-error.json");
		for (const signature of [null, "abc", "z".repeat(40)]) {
			const { handler, signals, logs } = harness();
			const req = vercel(raw, signature);
			expect((await handler(req)).status).toBe(401);
			expect(req.bodyUsed).toBe(false);
			expect(signals).toHaveLength(0);
			expect(logs).toEqual([]);
		}
	});

	test("Vercel: подпись верного вида, но неверная — тело читается для HMAC, не-JSON всё равно 401, а не 400", async () => {
		const { handler, logs } = harness();
		const raw = new TextEncoder().encode("{not json");
		const req = vercel(raw, "0".repeat(40));
		expect((await handler(req)).status).toBe(401);
		expect(req.bodyUsed).toBe(true);
		expect((await handler(vercel(raw, null))).status).toBe(401);
		expect(logs).toEqual([]);
	});

	test("413 после аутентификации (Grafana) пишет строку rejected; до неё (401, 413 Vercel) — нет", async () => {
		const oversize = { "content-length": String(MAX_BODY_BYTES + 1) };
		const authed = harness();
		const res = await authed.handler(
			new Request(`${BASE}/hooks/grafana`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, ...oversize }, body: "{}" }),
		);
		expect(res.status).toBe(413);
		expect(authed.logs).toEqual([
			{ source: "grafana", event: "rejected", key: "-", action: "error", workItemId: null, ms: 0, error: "payload too large" },
		]);

		const anonymous = harness();
		const unauthorized = await anonymous.handler(
			new Request(`${BASE}/hooks/grafana`, { method: "POST", headers: oversize, body: "{}" }),
		);
		expect(unauthorized.status).toBe(401);
		expect(anonymous.logs).toEqual([]);

		const unsigned = harness();
		const vercelOversize = await unsigned.handler(
			new Request(`${BASE}/hooks/vercel`, {
				method: "POST",
				headers: { "x-vercel-signature": "0".repeat(40), ...oversize },
				body: "{}",
			}),
		);
		expect(vercelOversize.status).toBe(413);
		expect(unsigned.logs).toEqual([]);
	});

	test("заявленный content-length больше лимита → 413 без чтения тела", async () => {
		const { handler, signals } = harness();
		const req = new Request(`${BASE}/hooks/grafana`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-length": String(MAX_BODY_BYTES + 1) },
			body: "{}",
		});
		expect((await handler(req)).status).toBe(413);
		expect(req.bodyUsed).toBe(false);
		expect(signals).toHaveLength(0);
	});
});

describe("лог и ответы: поля строк", () => {
	test("Grafana resolved: событие alert.resolved, без поля error на успехе, ms неотрицательно", async () => {
		const { handler, logs } = harness({ report: async () => ({ action: "commented", workItemId: "w9" }) });
		const res = await handler(grafana(await fixtureBytes("grafana-resolved.json")));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
		expect(logs.length).toBeGreaterThan(0);
		for (const l of logs) {
			expect(l.event).toBe("alert.resolved");
			expect(l).not.toHaveProperty("error");
			expect(l.ms).toBeGreaterThanOrEqual(0);
		}
	});

	test("Grafana: тело 502 называет число упавших и всего; в логе ошибки workItemId null", async () => {
		const { handler, logs } = harness({
			report: async (signal) => {
				if (signal.key === "a1b2c3d4e5f60718") throw new PlaneApiError(500, "POST", "/x/");
				return { action: "created", workItemId: "w2" };
			},
		});
		const res = await handler(grafana(await fixtureBytes("grafana-firing.json")));
		expect(await res.text()).toBe("plane: 1 of 2 alerts failed");
		expect(logs[0]?.workItemId).toBeNull();
		expect(logs[0]?.source).toBe("grafana");
	});

	test("ignored: полная строка лога", async () => {
		const { handler, logs } = harness();
		await handler(vercel(bytes({ type: "deployment.created", payload: {} })));
		expect(logs).toEqual([
			{ source: "vercel", event: "deployment.created", key: "-", action: "ignored", workItemId: null, ms: 0 },
		]);
	});

	test("deployment.error: сбой Plane → 502, строка лога deployment.error", async () => {
		const { handler, logs } = harness({
			report: async () => {
				throw new PlaneApiError(500, "POST", "/x/");
			},
		});
		const res = await handler(vercel(await fixtureBytes("vercel-deployment-error.json")));
		expect(res.status).toBe(502);
		expect(logs.map((l) => [l.source, l.event, l.action])).toEqual([["vercel", "deployment.error", "error"]]);
	});

	test("deployment.error: успех → строка лога с действием и workItemId", async () => {
		const { handler, logs } = harness();
		await handler(vercel(await fixtureBytes("vercel-deployment-error.json")));
		expect(logs.map((l) => [l.source, l.event, l.action, l.workItemId])).toEqual([
			["vercel", "deployment.error", "created", "w1"],
		]);
	});

	test("deployment.succeeded: поля обеих строк лога", async () => {
		const { handler, logs } = harness({ report: async () => ({ action: "noop", workItemId: null }) });
		await handler(vercel(await fixtureBytes("vercel-deployment-succeeded.json")));
		expect(logs.map((l) => [l.source, l.event, l.workItemId])).toEqual([
			["vercel", "deployment.succeeded", null],
			["vercel", "deployment.succeeded", "w12"],
		]);
		for (const l of logs) expect(l).not.toHaveProperty("error");
	});

	test("сбой заметок: строка лога note:<deploymentId> с error", async () => {
		const { handler, logs } = harness({
			report: async () => ({ action: "noop", workItemId: null }),
			notes: async () => {
				throw new PlaneApiError(500, "POST", "/comments/");
			},
		});
		await handler(vercel(await fixtureBytes("vercel-deployment-succeeded.json")));
		expect(logs[1]).toMatchObject({
			source: "vercel",
			event: "deployment.succeeded",
			key: "note:dpl_ok1",
			action: "error",
			workItemId: null,
			error: "PlaneApiError: Plane POST /comments/ → 500",
		});
		expect(logs.filter((l) => l.annotation !== undefined)).toHaveLength(1);
		expect(logs[1]?.annotation).toBeUndefined();
	});

	test("сбой, не являющийся Error → «unknown error»", async () => {
		const { handler, logs } = harness({
			report: async () => {
				throw "boom";
			},
		});
		await handler(grafana(await fixtureBytes("grafana-firing.json")));
		expect(logs[0]?.error).toBe("unknown error");
	});

	test("ошибка не от Plane (у проекта нет состояния по умолчанию) → 502 и строка лога с ней", async () => {
		const { handler, logs } = harness({
			report: async () => {
				throw new Error("Plane project p-ops has no default state");
			},
		});
		const res = await handler(vercel(await fixtureBytes("vercel-deployment-error.json")));
		expect(res.status).toBe(502);
		expect(logs).toEqual([
			{
				source: "vercel",
				event: "deployment.error",
				key: "deploy:prj_terminal:production:feat/ops-12-plane-hooks",
				action: "error",
				workItemId: null,
				ms: expect.any(Number),
				annotation: "deploy",
				title: "✗ terminal → production упал · 0123456",
				env: "production",
				sha: SHA,
				error: "Error: Plane project p-ops has no default state",
			},
		]);
	});

	test("заметки о деплое: ms у каждого ключа свой, а не общий с начала цикла", async () => {
		const { handler, logs } = harness({
			report: async () => ({ action: "noop", workItemId: null }),
			notes: async () => [
				{ key: "OPS-12", action: "commented", workItemId: "w12", ms: 7 },
				{ key: "MONO-3", action: "skipped", workItemId: null, ms: 11 },
			],
		});
		await handler(vercel(await fixtureBytes("vercel-deployment-succeeded.json")));
		expect(logs.slice(1).map((l) => [l.key, l.action, l.workItemId, l.ms])).toEqual([
			["OPS-12", "commented", "w12", 7],
			["MONO-3", "skipped", null, 11],
		]);
	});
});

describe("аутентифицированное, но неразборное тело: 400 и строка лога rejected", () => {
	test("Vercel: подписанный не-JSON", async () => {
		const { handler, logs } = harness();
		const res = await handler(vercel(new TextEncoder().encode("{not json")));
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("invalid json");
		expect(logs).toEqual([
			{ source: "vercel", event: "rejected", key: "-", action: "error", workItemId: null, ms: 0, error: "invalid json" },
		]);
	});

	test("Grafana: верный токен, чужая форма", async () => {
		const { handler, logs } = harness();
		const res = await handler(grafana("{}"));
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("grafana: body has no alerts[]");
		expect(logs).toEqual([
			{
				source: "grafana",
				event: "rejected",
				key: "-",
				action: "error",
				workItemId: null,
				ms: 0,
				error: "BadPayload: grafana: body has no alerts[]",
			},
		]);
	});
});

describe("ms в логе", () => {
	test("ms измеряет длительность вызова Plane (нижняя граница, без привязки к верхней)", async () => {
		const { handler, logs } = harness({
			report: async () => {
				await Bun.sleep(20);
				return { action: "created", workItemId: "w1" };
			},
		});
		await handler(grafana(await fixtureBytes("grafana-firing.json")));
		expect(logs[0]?.ms).toBeGreaterThanOrEqual(15);
	});
});

describe("поля отметки в логе", () => {
	test("новое срабатывание алерта — отметка «инцидент» с заголовком задачи и env", async () => {
		const { handler, logs, signals } = harness();
		expect((await handler(grafana(await fixtureBytes("grafana-firing.json")))).status).toBe(200);
		expect(logs[0]).toMatchObject({
			annotation: "incident",
			title: "Сработал: [prod] ServiceDown: order-gateway is down",
			env: "production",
		});
		const second = signals[1] as { title: string };
		expect(logs[1]).toMatchObject({ annotation: "incident", title: `Сработал: ${second.title}`, env: "staging" });
	});

	test("алерт без метки env: отметка в словаре деплоев (production), заголовок остаётся [prod]", async () => {
		const body = JSON.stringify({
			alerts: [
				{
					status: "firing",
					fingerprint: "fp-no-env",
					startsAt: "2026-10-06T10:00:00Z",
					labels: { alertname: "NoEnv", severity: "critical" },
					annotations: {},
				},
			],
		});
		const { handler, logs } = harness();
		expect((await handler(grafana(body))).status).toBe(200);
		expect(logs[0]).toMatchObject({ annotation: "incident", title: "Сработал: [prod] NoEnv", env: "production" });
	});

	test.each(["created", "reopened", "commented"] as const)("срабатывание с действием %s — отметка есть", async (action) => {
		const { handler, logs } = harness({ report: async () => ({ action, workItemId: "w1" }) });
		await handler(grafana(await fixtureBytes("grafana-firing.json")));
		expect(logs.every((l) => l.annotation === "incident")).toBe(true);
	});

	test("повтор (noop) и ошибка Plane у алерта — без отметки", async () => {
		const noop = harness({ report: async () => ({ action: "noop", workItemId: "w1" }) });
		await noop.handler(grafana(await fixtureBytes("grafana-firing.json")));
		expect(noop.logs.some((l) => "annotation" in l && l.annotation !== undefined)).toBe(false);
		const failing = harness({
			report: async () => {
				throw new PlaneApiError(500, "POST", "/x/");
			},
		});
		await failing.handler(grafana(await fixtureBytes("grafana-firing.json")));
		expect(failing.logs.some((l) => l.annotation !== undefined)).toBe(false);
	});

	test("восстановление: commented — «Погас», noop — без отметки", async () => {
		const commented = harness({ report: async () => ({ action: "commented", workItemId: "w1" }) });
		await commented.handler(grafana(await fixtureBytes("grafana-resolved.json")));
		expect(commented.logs[0]).toMatchObject({
			annotation: "incident",
			title: "Погас: [prod] ServiceDown: order-gateway is down",
			env: "production",
		});
		const noop = harness({ report: async () => ({ action: "noop", workItemId: "w1" }) });
		await noop.handler(grafana(await fixtureBytes("grafana-resolved.json")));
		expect(noop.logs[0]?.annotation).toBeUndefined();
	});

	test.each([
		["created", 200],
		["noop", 200],
	] as const)("упавший деплой Vercel (%s) — отметка «деплой» на строке события", async (action, status) => {
		const { handler, logs } = harness({ report: async () => ({ action, workItemId: "w1" }) });
		expect((await handler(vercel(await fixtureBytes("vercel-deployment-error.json")))).status).toBe(status);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			event: "deployment.error",
			annotation: "deploy",
			title: "✗ terminal → production упал · 0123456",
			env: "production",
			sha: SHA,
		});
	});

	test("упавший деплой Vercel при ошибке Plane — отметка всё равно есть, ответ 502", async () => {
		const { handler, logs } = harness({
			report: async () => {
				throw new PlaneApiError(503, "POST", "/x/");
			},
		});
		expect((await handler(vercel(await fixtureBytes("vercel-deployment-error.json")))).status).toBe(502);
		expect(logs[0]).toMatchObject({ action: "error", annotation: "deploy" });
	});

	test("успешный деплой Vercel — ровно одна строка с отметкой, у строк заметок её нет", async () => {
		const { handler, logs } = harness({
			report: async () => ({ action: "noop", workItemId: null }),
			notes: async () => [
				{ key: "OPS-12", action: "commented", workItemId: "w12", ms: 3 },
				{ key: "MONO-3", action: "skipped", workItemId: null, ms: 1 },
			],
		});
		expect((await handler(vercel(await fixtureBytes("vercel-deployment-succeeded.json")))).status).toBe(200);
		const marked = logs.filter((l) => l.annotation !== undefined);
		expect(marked).toHaveLength(1);
		expect(marked[0]).toMatchObject({
			event: "deployment.succeeded",
			annotation: "deploy",
			title: "terminal → production · 0123456",
			env: "production",
			sha: SHA,
		});
		expect(logs).toHaveLength(3);
	});
});

describe("/hooks/deploy", () => {
	test.each([null, "short", "z".repeat(64)])("подпись %p не той формы → 401 до чтения тела, без строки лога", async (signature) => {
		const { handler, logs, signals } = harness();
		const req = deployRequest(await fixtureBytes("deploy-failure.json"), signature);
		expect((await handler(req)).status).toBe(401);
		expect(req.bodyUsed).toBe(false);
		expect(logs).toEqual([]);
		expect(signals).toHaveLength(0);
	});

	test("подпись правильной формы, но чужая → 401 после чтения тела, без строки лога", async () => {
		const { handler, logs } = harness();
		const req = deployRequest(await fixtureBytes("deploy-failure.json"), "0".repeat(64));
		expect((await handler(req)).status).toBe(401);
		expect(req.bodyUsed).toBe(true);
		expect(logs).toEqual([]);
	});

	test("чужая подпись при плохом теле → 401 без строки лога: подпись проверяется до разбора", async () => {
		const bodies = [
			new TextEncoder().encode("{not json"),
			bytes({ ...(await fixture("deploy-failure.json")), environment: "preview" }),
		];
		for (const raw of bodies) {
			const { handler, logs } = harness();
			expect((await handler(deployRequest(raw, "0".repeat(64)))).status).toBe(401);
			expect(logs).toEqual([]);
		}
	});

	test("тело больше 1 MiB → 413 без строки лога (до аутентификации)", async () => {
		const { handler, logs } = harness();
		const raw = await fixtureBytes("deploy-failure.json");
		const res = await handler(deployRequest(raw, "0".repeat(64), { "content-length": String(MAX_BODY_BYTES + 1) }));
		expect(res.status).toBe(413);
		expect(logs).toEqual([]);
	});

	test("не JSON → 400 и строка rejected с источником github", async () => {
		const { handler, logs } = harness();
		const raw = new TextEncoder().encode("{not json");
		expect((await handler(deployRequest(raw))).status).toBe(400);
		expect(logs).toEqual([
			{ source: "github", event: "rejected", key: "-", action: "error", workItemId: null, ms: 0, error: "invalid json" },
		]);
	});

	test("неверная форма события → 400 и rejected с текстом ошибки разбора", async () => {
		const { handler, logs } = harness();
		const raw = bytes({ ...(await fixture("deploy-failure.json")), environment: "preview" });
		const res = await handler(deployRequest(raw));
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("deploy: environment must be staging or production");
		expect(logs[0]).toMatchObject({
			source: "github",
			event: "rejected",
			error: "BadPayload: deploy: environment must be staging or production",
		});
	});

	test("провал → сигнал срабатывания, 200, отметка «деплой» на строке события", async () => {
		const { handler, logs, signals } = harness();
		expect((await handler(deployRequest(await fixtureBytes("deploy-failure.json")))).status).toBe(200);
		expect(signals).toHaveLength(1);
		expect(signals[0]).toMatchObject({ status: "firing", source: "github", key: "deploy:monorepo:staging" });
		expect(logs).toEqual([
			{
				source: "github",
				event: "deployment.error",
				key: "deploy:monorepo:staging",
				action: "created",
				workItemId: "w1",
				ms: expect.any(Number),
				annotation: "deploy",
				title: "✗ monorepo → staging упал · 89abcde · bootstrap-smoke",
				env: "staging",
				sha: DEPLOY_SHA,
			},
		]);
	});

	test("успех → восстановление и заметки, строки заметок с источником github, отметка одна", async () => {
		const { handler, logs, signals, notes } = harness({ report: async () => ({ action: "noop", workItemId: null }) });
		expect((await handler(deployRequest(await fixtureBytes("deploy-success.json")))).status).toBe(200);
		expect(signals[0]).toMatchObject({ status: "resolved", key: "deploy:monorepo:production" });
		expect(notes[0]).toMatchObject({ deploymentId: `gh:production:${DEPLOY_SHA}`, source: "github", keyLimit: 50 });
		expect(logs.filter((l) => l.annotation === "deploy")).toHaveLength(1);
		expect(logs[0]).toMatchObject({ source: "github", event: "deployment.succeeded", annotation: "deploy" });
		expect(logs[1]).toMatchObject({ source: "github", event: "deployment.succeeded", key: "OPS-12", action: "commented" });
	});

	test("успех без коммитов (повторный деплой того же sha) → 200 и отметка есть", async () => {
		const { handler, logs, notes } = harness({ notes: async () => [] });
		const raw = bytes({ ...(await fixture("deploy-success.json")), commits: [] });
		expect((await handler(deployRequest(raw))).status).toBe(200);
		expect(notes[0]?.texts).toEqual([]);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({ annotation: "deploy", title: "monorepo → production · 89abcde" });
	});

	test("ошибка Plane → 502", async () => {
		const { handler } = harness({
			report: async () => {
				throw new PlaneApiError(503, "POST", "/x/");
			},
		});
		expect((await handler(deployRequest(await fixtureBytes("deploy-failure.json")))).status).toBe(502);
	});

	test("GET /hooks/deploy → 405", async () => {
		const { handler } = harness();
		expect((await handler(new Request(`${BASE}/hooks/deploy`))).status).toBe(405);
	});
});
