#!/usr/bin/env bun
/**
 * Posts stdin to a running plane-hooks with the auth the real sender uses:
 *   grafana — Authorization: Bearer $PLANE_HOOKS_GRAFANA_TOKEN
 *   vercel  — x-vercel-signature: hex HMAC-SHA1(body, $PLANE_HOOKS_VERCEL_SECRET)
 *   deploy  — x-plane-hooks-signature: hex HMAC-SHA256(body, $PLANE_HOOKS_DEPLOY_SECRET)
 * Inside the container the env is already there:
 *   docker exec -i <container> bun scripts/replay.ts grafana < grafana-firing.json
 * PLANE_HOOKS_URL overrides the target (default http://localhost:8080).
 * Exit 0 on a 2xx answer, 1 otherwise, 2 on bad usage.
 */
import { createHmac } from 'node:crypto';

const source = process.argv[2];
if (source !== 'grafana' && source !== 'vercel' && source !== 'deploy') {
	console.error('usage: bun scripts/replay.ts grafana|vercel|deploy < payload.json');
	process.exit(2);
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		console.error(`missing env ${name}`);
		process.exit(2);
	}
	return value;
}

const body = await Bun.stdin.text();
const target = `${(process.env.PLANE_HOOKS_URL ?? 'http://localhost:8080').replace(/\/+$/, '')}/hooks/${source}`;
const headers: Record<string, string> = { 'content-type': 'application/json' };
if (source === 'grafana') {
	headers.authorization = `Bearer ${required('PLANE_HOOKS_GRAFANA_TOKEN')}`;
} else if (source === 'vercel') {
	headers['x-vercel-signature'] = createHmac('sha1', required('PLANE_HOOKS_VERCEL_SECRET'))
		.update(body)
		.digest('hex');
} else {
	headers['x-plane-hooks-signature'] = createHmac('sha256', required('PLANE_HOOKS_DEPLOY_SECRET'))
		.update(body)
		.digest('hex');
}

const res = await fetch(target, { method: 'POST', headers, body });
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
