import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Fetch } from '@alxwlw/plane-app';

import type { Tenant } from '../config.ts';
import { esc } from '../html.ts';
import { isRecord, optString } from '../payload.ts';

const STATE_TTL_SECONDS = 3600;
const NAME_MAX = 16;
const CONVERT_TIMEOUT_MS = 10_000;

const NO_STORE = {
	'Cache-Control': 'no-store',
	'Referrer-Policy': 'no-referrer',
	'X-Content-Type-Options': 'nosniff',
};

/** `acme-corp` → `acmecorp`; `1password` → `g1password`: the name of tenants.json and of the env variables. */
function appNameOf(owner: string): string {
	const cleaned = owner.toLowerCase().replace(/[^a-z0-9]/g, '');
	return (/^[a-z]/.test(cleaned) ? cleaned : `g${cleaned}`).slice(0, NAME_MAX);
}

/** The GitHub App manifest, with `name` and the URLs of `publicUrl`. */
export function githubManifest(publicUrl: string, name: string): Record<string, unknown> {
	return {
		name,
		url: publicUrl,
		hook_attributes: { url: `${publicUrl}/hooks/github` },
		redirect_url: `${publicUrl}/github/callback`,
		public: false,
		default_permissions: {
			contents: 'read',
			pull_requests: 'read',
			deployments: 'write',
			metadata: 'read',
		},
		default_events: ['pull_request', 'deployment_status'],
	};
}

function sign(tenant: Tenant, seconds: number): string {
	return createHmac('sha256', tenant.plane.clientSecret)
		.update(`${tenant.id}.${seconds}`)
		.digest('hex');
}

/** `<tenant>.<unix seconds>.<hex HMAC-SHA256(tenant.ts, tenant.plane.clientSecret)>`; valid for 1 hour. */
export function setupState(tenant: Tenant, nowSeconds: number): string {
	return `${tenant.id}.${nowSeconds}.${sign(tenant, nowSeconds)}`;
}

export function verifySetupState(
	tenants: readonly Tenant[],
	state: string,
	nowSeconds: number,
): Tenant | null {
	const parts = state.split('.');
	if (parts.length !== 3) return null;
	const [id, ts, mac] = parts as [string, string, string];
	if (!/^\d{1,15}$/.test(ts) || !/^[0-9a-f]{64}$/.test(mac)) return null;
	const tenant = tenants.find((t) => t.id === id);
	if (!tenant) return null;
	const seconds = Number(ts);
	if (!timingSafeEqual(Buffer.from(sign(tenant, seconds), 'hex'), Buffer.from(mac, 'hex')))
		return null;
	const age = nowSeconds - seconds;
	return age >= 0 && age <= STATE_TTL_SECONDS ? tenant : null;
}

/** HTML page: one button, a form POST to github.com/(organizations/<owner>/)settings/apps/new?state=… with the manifest. */
export function githubSetupPage(opts: {
	publicUrl: string;
	tenant: Tenant;
	owner: string;
	kind: 'org' | 'user';
	nowSeconds: number;
}): Response {
	const name = `plane-hooks-${appNameOf(opts.owner)}`;
	const base =
		opts.kind === 'org'
			? `https://github.com/organizations/${encodeURIComponent(opts.owner)}/settings/apps/new`
			: 'https://github.com/settings/apps/new';
	const action = `${base}?state=${setupState(opts.tenant, opts.nowSeconds)}`;
	const manifest = JSON.stringify(githubManifest(opts.publicUrl, name));
	const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>GitHub App ${esc(name)}</title>
</head>
<body>
<h1>GitHub App ${esc(name)}</h1>
<p>Тенант ${esc(opts.tenant.id)}, владелец ${esc(opts.owner)}. Кнопка откроет GitHub с готовым манифестом: там останется нажать «Create GitHub App». Ссылка действует час.</p>
<form method="post" action="${esc(action)}">
<input type="hidden" name="manifest" value="${esc(manifest)}">
<button type="submit">Создать GitHub App</button>
</form>
</body>
</html>
`;
	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE },
	});
}

function plain(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE },
	});
}

const GATEWAY =
	'GitHub не вернул данные App. Начните заново: страница установки выдаст новую ссылку.\n';

/** Exchanges the code (POST /app-manifests/{code}/conversions) and shows what to put in tenants.json and env. */
export async function githubCallback(
	url: URL,
	deps: {
		tenants: readonly Tenant[];
		fetch: Fetch;
		nowSeconds: number;
		log: (entry: {
			event: 'github.app_created';
			tenant: string;
			appId: number;
			owner: string;
		}) => void;
	},
): Promise<Response> {
	const tenant = verifySetupState(
		deps.tenants,
		url.searchParams.get('state') ?? '',
		deps.nowSeconds,
	);
	if (!tenant)
		return plain(400, 'Ссылка устарела или не наша. Начните заново со страницы установки.\n');
	const code = url.searchParams.get('code') ?? '';
	if (!/^[A-Za-z0-9_-]+$/.test(code))
		return plain(400, 'В адресе нет кода GitHub. Начните заново.\n');

	let res: Response;
	try {
		res = await deps.fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
			method: 'POST',
			headers: {
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'plane-hooks',
			},
			signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
		});
	} catch {
		return plain(502, GATEWAY);
	}
	if (res.status === 404)
		return plain(400, 'GitHub не знает этот код: код истёк, начните заново.\n');
	if (!res.ok) return plain(502, GATEWAY);

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return plain(502, GATEWAY);
	}
	if (!isRecord(body)) return plain(502, GATEWAY);
	const appId = body.id;
	const slug = optString(body.slug);
	const pem = optString(body.pem);
	const secret = optString(body.webhook_secret);
	const owner = isRecord(body.owner) ? optString(body.owner.login) : null;
	if (
		typeof appId !== 'number' ||
		!Number.isSafeInteger(appId) ||
		appId <= 0 ||
		slug === null ||
		!/^[a-z0-9][a-z0-9-]*$/.test(slug) ||
		pem === null ||
		secret === null ||
		owner === null
	) {
		return plain(502, GATEWAY);
	}

	const name = appNameOf(owner);
	const upper = name.toUpperCase();
	deps.log({ event: 'github.app_created', tenant: tenant.id, appId, owner });
	return plain(
		200,
		[
			`GitHub App ${slug} created for ${owner}.`,
			`1. Add to tenants.json, tenant "${tenant.id}", key "github":`,
			`   { "name": "${name}", "appId": ${appId}, "owner": "${owner}" }`,
			'2. Add to the service env:',
			`   PLANE_HOOKS_GH_${upper}_PRIVATE_KEY=${Buffer.from(pem).toString('base64')}`,
			`   PLANE_HOOKS_GH_${upper}_WEBHOOK_SECRET=${secret}`,
			`3. Restart the service, then install the App: https://github.com/apps/${slug}/installations/new`,
			'This page is shown once: GitHub does not give the key again.',
			'',
		].join('\n'),
	);
}
