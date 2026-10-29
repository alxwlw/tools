#!/usr/bin/env bun
/**
 * Posts stdin to a running plane-hooks with the auth the real sender uses:
 *   bun scripts/replay.ts <tenant> grafana   Authorization: Bearer $PLANE_HOOKS_<TENANT>_GRAFANA_TOKEN
 *   bun scripts/replay.ts <tenant> vercel    x-vercel-signature: hex HMAC-SHA1(body, $PLANE_HOOKS_<TENANT>_VERCEL_SECRET)
 *   bun scripts/replay.ts <tenant> dokploy   Authorization: Bearer $PLANE_HOOKS_<TENANT>_DOKPLOY_SECRET
 *   bun scripts/replay.ts github <event> [<app>]
 *       x-github-event: <event>, x-hub-signature-256 with $PLANE_HOOKS_GH_<APP>_WEBHOOK_SECRET, the App id from
 *       tenants.json (PLANE_HOOKS_CONFIG, default /config/tenants.json) and a fresh x-github-delivery;
 *       <app> may be left out when the file names one App only
 * Inside the container the env is already there:
 *   docker exec -i <container> bun scripts/replay.ts acme grafana < grafana-firing.json
 * PLANE_HOOKS_URL overrides the target (default http://localhost:$PORT, 8080 without PORT).
 * Exit 0 on a 2xx answer, 1 otherwise, 2 on bad usage.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

type Env = Record<string, string | undefined>;
export type Replay = { path: string; headers: Record<string, string> } | { error: string };

export const USAGE =
	'usage: bun scripts/replay.ts <tenant> grafana|vercel|dokploy < body.json\n' +
	'       bun scripts/replay.ts github <event> [<app>] < body.json';

/** The path and headers that sign `body` like the real sender, or what is missing. */
export function replayRequest(
	args: readonly string[],
	env: Env,
	body: string,
	readFile: (path: string) => string,
	deliveryId: () => string = randomUUID,
): Replay {
	const read = (name: string): string | null => env[name]?.trim() || null;
	const [first, second, third, ...rest] = args;
	if (first === undefined || second === undefined || rest.length > 0) return { error: USAGE };
	const json = { 'content-type': 'application/json' };

	if (first === 'github') {
		if (!/^[a-z_]+$/.test(second)) return { error: USAGE };
		const apps = appsOf(readFile, read('PLANE_HOOKS_CONFIG') ?? '/config/tenants.json');
		if (apps === null) return { error: 'cannot read the App ids from tenants.json' };
		const app =
			third === undefined && apps.length === 1 ? apps[0] : apps.find((a) => a.name === third);
		if (app === undefined) return { error: `name the App: ${apps.map((a) => a.name).join(', ')}` };
		const secretName = `PLANE_HOOKS_GH_${app.name.toUpperCase()}_WEBHOOK_SECRET`;
		const secret = read(secretName);
		if (secret === null) return { error: `missing env ${secretName}` };
		return {
			path: '/hooks/github',
			headers: {
				...json,
				'x-github-event': second,
				'x-github-delivery': deliveryId(),
				'x-github-hook-installation-target-id': String(app.appId),
				'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
			},
		};
	}

	if (third !== undefined || !/^[a-z][a-z0-9]{0,15}$/.test(first)) return { error: USAGE };
	const name = (suffix: string) => `PLANE_HOOKS_${first.toUpperCase()}_${suffix}`;
	const secretOf = (suffix: string): Replay | string => {
		const value = read(name(suffix));
		return value === null ? { error: `missing env ${name(suffix)}` } : value;
	};
	const input = second;
	const suffix =
		input === 'grafana'
			? 'GRAFANA_TOKEN'
			: input === 'vercel'
				? 'VERCEL_SECRET'
				: input === 'dokploy'
					? 'DOKPLOY_SECRET'
					: null;
	if (suffix === null) return { error: USAGE };
	const secret = secretOf(suffix);
	if (typeof secret !== 'string') return secret;
	const path = `/hooks/${first}/${input}`;
	if (input === 'vercel')
		return {
			path,
			headers: {
				...json,
				'x-vercel-signature': createHmac('sha1', secret).update(body).digest('hex'),
			},
		};
	return { path, headers: { ...json, authorization: `Bearer ${secret}` } };
}

/** name and appId of every App in tenants.json; null — the file is not readable as one. */
function appsOf(
	readFile: (path: string) => string,
	path: string,
): Array<{ name: string; appId: number }> | null {
	try {
		const root = JSON.parse(readFile(path)) as { tenants?: Array<{ github?: unknown[] }> };
		const apps = (root.tenants ?? []).flatMap((tenant) => tenant.github ?? []);
		return apps.flatMap((app) => {
			const { name, appId } = (app ?? {}) as { name?: unknown; appId?: unknown };
			return typeof name === 'string' && typeof appId === 'number' ? [{ name, appId }] : [];
		});
	} catch {
		return null;
	}
}

if (import.meta.main) {
	const body = await Bun.stdin.text();
	const replay = replayRequest(process.argv.slice(2), process.env, body, (path) =>
		readFileSync(path, 'utf8'),
	);
	if ('error' in replay) {
		console.error(replay.error);
		process.exit(2);
	}
	const base = (
		process.env.PLANE_HOOKS_URL ?? `http://localhost:${process.env.PORT?.trim() || 8080}`
	).replace(/\/+$/, '');
	const res = await fetch(`${base}${replay.path}`, {
		method: 'POST',
		headers: replay.headers,
		body,
	});
	console.log(res.status, await res.text());
	process.exit(res.ok ? 0 : 1);
}
