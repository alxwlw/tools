// Adapted from apps/plane-miro/src/config.ts.

export type TenantConfig = {
	id: string;
	workspaceSlug: string;
	workspaceId: string;
	clientId: string;
	installationId: string;
	planeSecret: string;
	webhookSecret: string;
	readKey: string;
	agentKey: string;
};
export type Config = {
	planeUrl: string;
	publicUrl: string;
	dbPath: string;
	port: number;
	tenants: ReadonlyMap<string, TenantConfig>;
};

/** Read-only scopes of the Plane App (Plane oauth-scopes page); the install wizard asks for the same list. */
export const PLANE_SCOPES: readonly string[] = [
	'projects:read',
	'projects.work_items:read',
	'projects.work_items.relations:read',
	'projects.states:read',
	'projects.labels:read',
	'projects.modules:read',
];

// A Plane id: a UUID, any case.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ID = /^[a-z][a-z0-9]{0,15}$/;
const TENANT_KEYS = ['id', 'workspaceSlug', 'workspaceId', 'clientId', 'installationId'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throws one Error listing every problem; messages name env vars and JSON paths, never values. */
export function loadConfig(
	env: Record<string, string | undefined>,
	readFile: (path: string) => string,
): Config {
	const problems: string[] = [];
	const bad = (msg: string) => problems.push(msg);
	const read = (name: string) => env[name]?.trim() ?? '';

	const missing = ['PLANE_GRAPH_PLANE_URL', 'PLANE_GRAPH_PUBLIC_URL'].filter((n) => !read(n));
	if (missing.length > 0) bad(`missing env ${missing.join(', ')}`);

	const url = (name: string): string => {
		const value = read(name).replace(/\/+$/, '');
		if (value && !/^https?:\/\//.test(value)) bad(`${name} must start with http(s)://`);
		return value;
	};
	const planeUrl = url('PLANE_GRAPH_PLANE_URL');
	const publicUrl = url('PLANE_GRAPH_PUBLIC_URL');

	const port = env.PORT?.trim() ? Number(env.PORT) : 8080;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) bad('PORT must be an integer 1..65535');
	const configPath = read('PLANE_GRAPH_CONFIG') || '/config/tenants.json';
	const dbPath = read('PLANE_GRAPH_DB') || '/data/plane-graph.sqlite';

	const tenants = parseTenants(env, readFile, configPath, bad);

	if (problems.length > 0) throw new Error(`plane-graph: ${problems.join('; ')}`);
	return { planeUrl, publicUrl, dbPath, port, tenants };
}

function parseTenants(
	env: Record<string, string | undefined>,
	readFile: (path: string) => string,
	configPath: string,
	bad: (msg: string) => void,
): Map<string, TenantConfig> {
	const tenants = new Map<string, TenantConfig>();
	let root: unknown;
	try {
		root = JSON.parse(readFile(configPath));
	} catch {
		// The cause is dropped on purpose: a JSON.parse message quotes file content.
		bad(`PLANE_GRAPH_CONFIG: cannot read ${configPath} as JSON`);
		return tenants;
	}
	if (!isObj(root) || !Array.isArray(root.tenants) || Object.keys(root).length !== 1) {
		bad('tenants file must be an object {"tenants": [...]}');
		return tenants;
	}

	const seen = { id: new Set<string>(), workspaceId: new Set<string>() };
	root.tenants.forEach((raw, i) => {
		const at = `tenants[${i}]`;
		const { tenant, id, workspaceId } = parseTenant(raw, at, env, bad);
		// Checked even when the tenant itself is invalid, so one run reports every problem.
		for (const [key, value] of [
			['id', id],
			['workspaceId', workspaceId],
		] as const) {
			if (!value) continue;
			if (seen[key].has(value)) bad(`${at}.${key} is a duplicate`);
			seen[key].add(value);
		}
		if (tenant) tenants.set(tenant.id, tenant);
	});
	return tenants;
}

function parseTenant(
	raw: unknown,
	at: string,
	env: Record<string, string | undefined>,
	bad: (msg: string) => void,
): { tenant: TenantConfig | null; id: string; workspaceId: string } {
	if (!isObj(raw)) {
		bad(`${at} must be an object`);
		return { tenant: null, id: '', workspaceId: '' };
	}
	let failed = 0;
	const fail = (msg: string) => {
		failed++;
		bad(msg);
	};
	for (const key of Object.keys(raw))
		if (!(TENANT_KEYS as readonly string[]).includes(key)) fail(`${at}.${key} is not a known key`);
	const str = (key: string, re?: RegExp, hint = ''): string => {
		const value = raw[key];
		if (typeof value !== 'string' || !value.trim() || (re && !re.test(value))) {
			fail(`${at}.${key} must be ${hint || 'a non-empty string'}`);
			return '';
		}
		return value;
	};

	const id = str('id', TENANT_ID, 'a-z then up to 15 of a-z0-9');
	const workspaceSlug = str('workspaceSlug');
	// UUIDs are kept lower-case: Plane sends them so, and the routing compares exactly.
	const workspaceId = str('workspaceId', UUID, 'a UUID').toLowerCase();
	const clientId = str('clientId');
	const installationId = str('installationId');

	// Secrets live in env only; every one is required, the two keys must differ.
	const secrets = { planeSecret: '', webhookSecret: '', readKey: '', agentKey: '' };
	if (TENANT_ID.test(id)) {
		const prefix = `PLANE_GRAPH_${id.toUpperCase()}`;
		const names = {
			planeSecret: 'PLANE_SECRET',
			webhookSecret: 'WEBHOOK_SECRET',
			readKey: 'READ_KEY',
			agentKey: 'AGENT_KEY',
		} as const;
		for (const field of Object.keys(names) as (keyof typeof names)[]) {
			secrets[field] = env[`${prefix}_${names[field]}`]?.trim() ?? '';
			if (!secrets[field]) fail(`missing env ${prefix}_${names[field]}`);
		}
		if (secrets.readKey && secrets.readKey === secrets.agentKey)
			fail(`${prefix}_READ_KEY and ${prefix}_AGENT_KEY must differ`);
	}

	if (failed > 0) return { tenant: null, id, workspaceId };
	return {
		tenant: { id, workspaceSlug, workspaceId, clientId, installationId, ...secrets },
		id,
		workspaceId,
	};
}
