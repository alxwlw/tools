import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { isDeploySignatureShaped, parseDeployEvent, verifyDeploySignature } from "../src/deploy-event.ts";
import type { DeployOutcome } from "../src/deploy-note.ts";
import { BadPayload } from "../src/payload.ts";
import { fixture, fixtureBytes } from "./fixtures.ts";

const SECRET = "deploy-test-secret";
const SHA = "89abcdef0123456789abcdef0123456789abcdef";
const NOW = () => new Date("2026-10-06T12:00:00.000Z");
const RUN_FAIL = "https://github.com/liqu-fi/monorepo/actions/runs/37483709613";
const RUN_OK = "https://github.com/liqu-fi/monorepo/actions/runs/37483709612";
const sign = (raw: Uint8Array, secret = SECRET) => createHmac("sha256", secret).update(raw).digest("hex");

async function parse(name: string, mutate: (body: any) => void = () => undefined): Promise<DeployOutcome> {
	const body = await fixture(name);
	mutate(body);
	return parseDeployEvent(body, NOW);
}

describe("подпись", () => {
	test("верная HMAC-SHA256 по сырым байтам, регистр hex не важен", async () => {
		const raw = await fixtureBytes("deploy-success.json");
		expect(verifyDeploySignature(raw, sign(raw), SECRET)).toBe(true);
		expect(verifyDeploySignature(raw, sign(raw).toUpperCase(), SECRET)).toBe(true);
	});

	test("чужой секрет, изменённое тело, нет заголовка, неверная форма — false без исключений", async () => {
		const raw = await fixtureBytes("deploy-success.json");
		expect(verifyDeploySignature(raw, sign(raw, "other"), SECRET)).toBe(false);
		expect(verifyDeploySignature(new Uint8Array([...raw, 32]), sign(raw), SECRET)).toBe(false);
		expect(verifyDeploySignature(raw, null, SECRET)).toBe(false);
		expect(verifyDeploySignature(raw, sign(raw).slice(0, 63), SECRET)).toBe(false);
		expect(verifyDeploySignature(raw, `${sign(raw)}0`, SECRET)).toBe(false);
	});

	test("форма: ровно 64 hex", () => {
		expect(isDeploySignatureShaped("a".repeat(64))).toBe(true);
		expect(isDeploySignatureShaped("A".repeat(64))).toBe(true);
		expect(isDeploySignatureShaped("a".repeat(63))).toBe(false);
		expect(isDeploySignatureShaped("g".repeat(64))).toBe(false);
		expect(isDeploySignatureShaped(null)).toBe(false);
	});
});

describe("провал", () => {
	test("сигнал срабатывания по окружению, срабатывание — прогон и попытка", async () => {
		const ev = await parse("deploy-failure.json");
		expect(ev).toEqual({
			kind: "failed",
			signal: {
				status: "firing",
				source: "github",
				key: "deploy:monorepo:staging",
				occurrence: "37483709613.2",
				at: "2026-10-06T12:00:00.000Z",
				title: "Деплой упал: monorepo (staging) · bootstrap-smoke",
				bodyHtml:
					"<p>Репозиторий: <code>liqu-fi/monorepo</code>, окружение: <code>staging</code>, стадия: <code>bootstrap-smoke</code></p>" +
					`<p>Коммит: <a href="https://github.com/liqu-fi/monorepo/commit/${SHA}">89abcde</a></p>` +
					`<p><a href="${RUN_FAIL}">Прогон GitHub Actions</a></p>`,
				noteHtml: `<p>Сработал 2026-10-06 12:00 UTC: стадия <code>bootstrap-smoke</code>, <a href="${RUN_FAIL}">прогон</a></p>`,
				priority: "high",
				label: "deploy-failed",
			},
			summary: { title: "✗ monorepo → staging упал · 89abcde · bootstrap-smoke", env: "staging", sha: SHA },
		});
	});

	test.each(["build", "bootstrap-smoke", "deploy"])("стадия %s принимается и попадает в заголовок", async (stage) => {
		const ev = await parse("deploy-failure.json", (b) => (b.stage = stage));
		if (ev.kind !== "failed" || ev.signal.status !== "firing") throw new Error("expected failed");
		expect(ev.signal.title).toBe(`Деплой упал: monorepo (staging) · ${stage}`);
	});

	test("prod — приоритет urgent", async () => {
		const ev = await parse("deploy-failure.json", (b) => (b.environment = "production"));
		if (ev.kind !== "failed" || ev.signal.status !== "firing") throw new Error("expected failed");
		expect(ev.signal.priority).toBe("urgent");
		expect(ev.signal.key).toBe("deploy:monorepo:production");
	});

	test("мусор в commits при провале не мешает разбору", async () => {
		const ev = await parse("deploy-failure.json", (b) => (b.commits = "not an array"));
		expect(ev.kind).toBe("failed");
	});
});

describe("успех", () => {
	test("восстановление по тому же ключу и заметка с сообщениями коммитов", async () => {
		const ev = await parse("deploy-success.json");
		expect(ev).toEqual({
			kind: "succeeded",
			resolve: {
				status: "resolved",
				source: "github",
				key: "deploy:monorepo:production",
				at: "2026-10-06T12:00:00.000Z",
				noteHtml: "<p>Деплой снова проходит: <code>89abcde</code></p>",
			},
			note: {
				deploymentId: `gh:production:${SHA}`,
				project: "monorepo",
				target: "production",
				sha: SHA,
				url: RUN_OK,
				texts: [
					"Merge pull request #830 from liqu-fi/staging\n\nrelease",
					"feat(gateway): [OPS-12] faster fills (#829)\n\nbody",
					"fix(settler): [MONO-3] <script>x</script> (#828)",
				],
				source: "github",
				keyLimit: 50,
			},
			summary: { title: "monorepo → production · 89abcde", env: "production", sha: SHA },
		});
	});

	test("sha в верхнем регистре приводится к нижнему", async () => {
		const ev = await parse("deploy-success.json", (b) => (b.sha = SHA.toUpperCase()));
		if (ev.kind !== "succeeded") throw new Error("expected succeeded");
		expect(ev.note.deploymentId).toBe(`gh:production:${SHA}`);
	});

	test("пустой список коммитов — заметок нет, но событие валидно", async () => {
		const ev = await parse("deploy-success.json", (b) => (b.commits = []));
		if (ev.kind !== "succeeded") throw new Error("expected succeeded");
		expect(ev.note.texts).toEqual([]);
	});

	test("ровно 200 коммитов разбираются", async () => {
		const ev = await parse("deploy-success.json", (b) => (b.commits = Array.from({ length: 200 }, () => ({ sha: SHA, message: "m" }))));
		if (ev.kind !== "succeeded") throw new Error("expected succeeded");
		expect(ev.note.texts).toHaveLength(200);
	});
});

describe("отказ в разборе", () => {
	const longMessage = "x".repeat(65_537);
	test.each([
		["тело не объект", () => [] as unknown, "body is not an object"],
		["repository без слэша", (b: any) => (b.repository = "monorepo"), "repository"],
		["environment preview", (b: any) => (b.environment = "preview"), "environment"],
		["outcome cancelled", (b: any) => (b.outcome = "cancelled"), "outcome"],
		["success со стадией", (b: any) => (b.stage = "deploy"), "stage"],
		["sha короче 40", (b: any) => (b.sha = "89abcde"), "sha"],
		["runId не цифры", (b: any) => (b.runId = "12a"), "runId"],
		["runAttempt пустой", (b: any) => (b.runAttempt = ""), "runAttempt"],
		["runUrl http", (b: any) => (b.runUrl = "http://github.com/x"), "runUrl"],
		["commits не массив", (b: any) => (b.commits = {}), "commits"],
		["201 коммит", (b: any) => (b.commits = Array.from({ length: 201 }, () => ({ sha: SHA, message: "m" }))), "200"],
		["коммит без message", (b: any) => (b.commits = [{ sha: SHA }]), "commits[0]"],
		["коммит с коротким sha", (b: any) => (b.commits = [{ sha: "abc", message: "m" }]), "commits[0]"],
		["сообщение длиннее 65536", (b: any) => (b.commits = [{ sha: SHA, message: longMessage }]), "too long"],
		["repository массивом", (b: any) => (b.repository = ["liqu-fi/monorepo"]), "repository"],
		["sha массивом", (b: any) => (b.sha = [SHA]), "sha"],
		["runId числом", (b: any) => (b.runId = 37483709612), "runId"],
		["commits: [null]", (b: any) => (b.commits = [null]), "commits[0]"],
		["одинокий суррогат в runUrl", (b: any) => (b.runUrl = "https://github.com/\ud800"), "runUrl"],
		["repository длиннее 140", (b: any) => (b.repository = `o/${"r".repeat(300)}`), "repository"],
		["runId длиннее 20 цифр", (b: any) => (b.runId = "9".repeat(300)), "runId"],
	])("%s → BadPayload", async (_name, mutate, fragment) => {
		const body = await fixture("deploy-success.json");
		const target = typeof mutate === "function" && mutate.length === 0 ? (mutate as () => unknown)() : body;
		if (target === body) (mutate as (b: any) => void)(body);
		let error: unknown;
		try {
			parseDeployEvent(target, NOW);
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(BadPayload);
		expect((error as Error).message).toContain(fragment);
	});

	test("провал без стадии или с чужой стадией → BadPayload", async () => {
		for (const stage of [null, "test", undefined]) {
			const body = await fixture("deploy-failure.json");
			body.stage = stage;
			expect(() => parseDeployEvent(body, NOW)).toThrow(BadPayload);
		}
	});

	test("сообщения об ошибке не содержат данных тела", async () => {
		const body = await fixture("deploy-success.json");
		body.repository = "SECRET-BODY-VALUE/x y";
		let error: unknown;
		try {
			parseDeployEvent(body, NOW);
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(BadPayload);
		expect((error as Error).message).toMatch(/^deploy: repository is missing or malformed$/);
		expect((error as Error).message).not.toContain("SECRET-BODY-VALUE");
	});

	test("сообщение ровно 65 536 символов принимается", async () => {
		const ev = await parse("deploy-success.json", (b) => (b.commits = [{ sha: SHA, message: "x".repeat(65_536) }]));
		expect(ev.kind).toBe("succeeded");
	});
});
