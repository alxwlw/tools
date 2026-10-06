import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const TOKEN = `ph_${"0a".repeat(24)}`;
const valid = {
	PLANE_HOOKS_PLANE_URL: "https://plane.hype.cheap/",
	PLANE_HOOKS_WORKSPACE: "liq-egn",
	PLANE_HOOKS_PROJECT_ID: "11111111-2222-3333-4444-555555555555",
	PLANE_HOOKS_PLANE_API_KEY: "plane_api_secret_value",
	PLANE_HOOKS_GRAFANA_TOKEN: TOKEN,
	PLANE_HOOKS_VERCEL_SECRET: "vercel_secret_value",
	PLANE_HOOKS_DEPLOY_SECRET: "deploy_secret_value",
};

function message(env: Record<string, string | undefined>): string {
	try {
		loadConfig(env);
	} catch (err) {
		return (err as Error).message;
	}
	throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
	test("полный набор: порт по умолчанию, URL без завершающего слэша", () => {
		expect(loadConfig(valid)).toEqual({
			port: 8080,
			planeUrl: "https://plane.hype.cheap",
			workspace: "liq-egn",
			projectId: "11111111-2222-3333-4444-555555555555",
			planeApiKey: "plane_api_secret_value",
			grafanaToken: TOKEN,
			vercelSecret: "vercel_secret_value",
			deploySecret: "deploy_secret_value",
		});
	});

	test("пробелы по краям обрезаются", () => {
		expect(loadConfig({ ...valid, PLANE_HOOKS_WORKSPACE: " liq-egn \n" }).workspace).toBe("liq-egn");
	});

	test("PORT", () => {
		expect(loadConfig({ ...valid, PORT: "9090" }).port).toBe(9090);
		expect(message({ ...valid, PORT: "abc" })).toContain("PORT");
		expect(message({ ...valid, PORT: "0" })).toContain("PORT");
	});

	test("нет переменных — все имена в одном сообщении", () => {
		expect(message({ ...valid, PLANE_HOOKS_PLANE_API_KEY: undefined, PLANE_HOOKS_VERCEL_SECRET: "  " })).toBe(
			"plane-hooks: missing env PLANE_HOOKS_PLANE_API_KEY, PLANE_HOOKS_VERCEL_SECRET",
		);
	});

	test("токен Grafana не формата ph_<48 hex> — ошибка без значения в тексте", () => {
		for (const bad of ["1234567890", `ph_${"0A".repeat(24)}`, `ph_${"0a".repeat(23)}`, "secret-token-value"]) {
			const text = message({ ...valid, PLANE_HOOKS_GRAFANA_TOKEN: bad });
			expect(text).toContain("PLANE_HOOKS_GRAFANA_TOKEN");
			expect(text).not.toContain(bad);
		}
	});

	test("ID проекта не UUID (вставлен URL проекта) — ошибка с именем переменной, без значения", () => {
		const url = "plane.hype.cheap/liq-egn/projects/11111111-2222-3333-4444-555555555555/issues/";
		for (const bad of [url, `https://${url}`, "OPS", "11111111-2222-3333-4444-55555555555"]) {
			const text = message({ ...valid, PLANE_HOOKS_PROJECT_ID: bad });
			expect(text).toBe(
				"plane-hooks: PLANE_HOOKS_PROJECT_ID must be a project UUID (copy it from …/projects/<UUID>/issues)",
			);
			expect(text).not.toContain(bad);
		}
	});

	test("ID проекта: UUID в любом регистре и с пробелами по краям проходит", () => {
		expect(loadConfig({ ...valid, PLANE_HOOKS_PROJECT_ID: " 0A1B2C3D-4E5F-6789-ABCD-EF0123456789\n" }).projectId).toBe(
			"0A1B2C3D-4E5F-6789-ABCD-EF0123456789",
		);
	});

	test("пустой PLANE_HOOKS_DEPLOY_SECRET — сервис не стартует, ошибка называет переменную", () => {
		const text = message({ ...valid, PLANE_HOOKS_DEPLOY_SECRET: "  " });
		expect(text).toContain("PLANE_HOOKS_DEPLOY_SECRET");
	});

	test("URL Plane без схемы — ошибка", () => {
		expect(message({ ...valid, PLANE_HOOKS_PLANE_URL: "plane.hype.cheap" })).toContain("PLANE_HOOKS_PLANE_URL");
	});
});

describe("loadConfig: границы форматов", () => {
	test("несколько завершающих слэшей срезаются, http:// допустим", () => {
		expect(loadConfig({ ...valid, PLANE_HOOKS_PLANE_URL: "http://plane:8000///" }).planeUrl).toBe("http://plane:8000");
	});

	test("схема только в начале строки", () => {
		expect(message({ ...valid, PLANE_HOOKS_PLANE_URL: "ftp://plane/http://x" })).toContain("PLANE_HOOKS_PLANE_URL");
	});

	test("токен Grafana: мусор до и после отвергается", () => {
		for (const bad of [`x${TOKEN}`, `${TOKEN}0`, `ph_${"g".repeat(48)}`]) {
			expect(message({ ...valid, PLANE_HOOKS_GRAFANA_TOKEN: bad })).toContain("PLANE_HOOKS_GRAFANA_TOKEN");
		}
	});

	test("PORT: пустой — по умолчанию, границы 1..65535, дробный — ошибка", () => {
		expect(loadConfig({ ...valid, PORT: "  " }).port).toBe(8080);
		expect(loadConfig({ ...valid, PORT: "65535" }).port).toBe(65535);
		expect(message({ ...valid, PORT: "65536" })).toContain("PORT");
		expect(message({ ...valid, PORT: "9090.5" })).toContain("PORT");
	});
});
