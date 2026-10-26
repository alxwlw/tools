// Adapted from apps/plane-discord/src/config.ts.

/** Plane App only: the key mode (API key + workspace webhook v2) was dropped after the probe (design §10). */
export type PlaneAuthConfig = { clientId: string; clientSecret: string; appInstallationId: string };
export type Tenant = {
	id: string;
	workspace: string;
	workspaceId: string;
	auth: PlaneAuthConfig;
	webhookSecret: string;
	miroTeamId: string;
	/** Enabled per tenant: an Embed block of the card's place goes into the work item description. */
	embed: boolean;
	/** true: the source item stays and the card goes next to it (design §3.1, probe 2026-10-26). */
	keepSource: boolean;
	silenceHours: number;
	hiddenProjects: readonly string[];
};
export type Config = {
	port: number;
	planeUrl: string;
	publicUrl: string;
	configPath: string;
	dbPath: string;
	miro: { clientId: string; clientSecret: string };
	tenants: readonly Tenant[];
};

/** Design §10 «Итоги пробы»: a Miro comment dies with its sticker, so the source item stays by default. */
export const KEEP_SOURCE_DEFAULT = true;

// Same shape as PROJECT_UUID in plane-hooks.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ID = /^[a-z][a-z0-9]{0,15}$/;
const MIRO_TEAM_ID = /^\d{1,24}$/;

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

	// Required globals: every missing name is listed in one pass.
	const required = [
		'PLANE_MIRO_PLANE_URL',
		'PLANE_MIRO_PUBLIC_URL',
		'PLANE_MIRO_MIRO_CLIENT_ID',
		'PLANE_MIRO_MIRO_CLIENT_SECRET',
	];
	const missing = required.filter((name) => !read(name));
	if (missing.length > 0) bad(`missing env ${missing.join(', ')}`);

	const url = (name: string): string => {
		const value = read(name).replace(/\/+$/, '');
		if (value && !/^https?:\/\//.test(value)) bad(`${name} must start with http(s)://`);
		return value;
	};
	const planeUrl = url('PLANE_MIRO_PLANE_URL');
	const publicUrl = url('PLANE_MIRO_PUBLIC_URL');
	const miro = {
		clientId: read('PLANE_MIRO_MIRO_CLIENT_ID'),
		clientSecret: read('PLANE_MIRO_MIRO_CLIENT_SECRET'),
	};

	const port = env.PORT?.trim() ? Number(env.PORT) : 8080;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) bad('PORT must be an integer 1..65535');
	const configPath = read('PLANE_MIRO_CONFIG') || '/config/tenants.json';
	const dbPath = read('PLANE_MIRO_DB') || '/data/plane-miro.sqlite';

	const tenants = parseTenants(env, readFile, configPath, bad);

	if (problems.length > 0) throw new Error(`plane-miro: ${problems.join('; ')}`);
	return { port, planeUrl, publicUrl, configPath, dbPath, miro, tenants };
}

function parseTenants(
	env: Record<string, string | undefined>,
	readFile: (path: string) => string,
	configPath: string,
	bad: (msg: string) => void,
): Tenant[] {
	let root: unknown;
	try {
		root = JSON.parse(readFile(configPath));
	} catch {
		// The cause is dropped on purpose: a JSON.parse message quotes file content.
		bad(`PLANE_MIRO_CONFIG: cannot read ${configPath} as JSON`);
		return [];
	}
	if (!isObj(root) || !Array.isArray(root.tenants) || Object.keys(root).length !== 1) {
		bad('tenants file must be an object {"tenants": [...]}');
		return [];
	}

	const tenants: Tenant[] = [];
	// Each unique key maps to the JSON path named in the duplicate error.
	const uniqueKeys = [
		['id', 'id'],
		['workspaceId', 'workspaceId'],
		['miroTeamId', 'miro.teamId'],
	] as const;
	const seen = {
		id: new Set<string>(),
		workspaceId: new Set<string>(),
		miroTeamId: new Set<string>(),
	};
	root.tenants.forEach((raw, i) => {
		const at = `tenants[${i}]`;
		const { tenant, ids } = parseTenant(raw, at, env, bad);
		// Checked even when the tenant itself is invalid, so one run reports every problem.
		for (const [key, path] of uniqueKeys) {
			if (!ids[key]) continue;
			if (seen[key].has(ids[key])) bad(`${at}.${path} is a duplicate`);
			seen[key].add(ids[key]);
		}
		if (tenant) tenants.push(tenant);
	});
	return tenants;
}

function parseTenant(
	raw: unknown,
	at: string,
	env: Record<string, string | undefined>,
	bad: (msg: string) => void,
): { tenant: Tenant | null; ids: { id: string; workspaceId: string; miroTeamId: string } } {
	if (!isObj(raw)) {
		bad(`${at} must be an object`);
		return { tenant: null, ids: { id: '', workspaceId: '', miroTeamId: '' } };
	}
	const failed = { count: 0 };
	const fail = (msg: string) => {
		failed.count++;
		bad(msg);
	};
	const unknownKeys = (obj: Obj, allowed: readonly string[], path: string) => {
		for (const key of Object.keys(obj))
			if (!allowed.includes(key)) fail(`${path}.${key} is not a known key`);
	};
	const str = (obj: Obj, key: string, path: string, re?: RegExp, hint = ''): string => {
		const value = obj[key];
		if (typeof value !== 'string' || !value.trim() || (re && !re.test(value))) {
			fail(`${path}.${key} must be ${hint || 'a non-empty string'}`);
			return '';
		}
		return value;
	};

	unknownKeys(
		raw,
		[
			'id',
			'workspace',
			'workspaceId',
			'plane',
			'miro',
			'embed',
			'keepSource',
			'silenceHours',
			'hiddenProjects',
		],
		at,
	);
	const id = str(raw, 'id', at, TENANT_ID, 'a-z then up to 15 of a-z0-9');
	const workspace = str(raw, 'workspace', at);
	// UUIDs are kept lower-case: Plane sends them so, and the routing map and the hidden set compare exactly.
	const workspaceId = str(raw, 'workspaceId', at, UUID, 'a UUID').toLowerCase();

	let clientId = '';
	let appInstallationId = '';
	if (!isObj(raw.plane)) fail(`${at}.plane must be an object`);
	else {
		unknownKeys(raw.plane, ['clientId', 'appInstallationId'], `${at}.plane`);
		clientId = str(raw.plane, 'clientId', `${at}.plane`);
		appInstallationId = str(raw.plane, 'appInstallationId', `${at}.plane`);
	}

	let miroTeamId = '';
	if (!isObj(raw.miro)) fail(`${at}.miro must be an object`);
	else {
		unknownKeys(raw.miro, ['teamId'], `${at}.miro`);
		miroTeamId = str(raw.miro, 'teamId', `${at}.miro`, MIRO_TEAM_ID, 'digits only (1-24)');
	}

	const embed = raw.embed;
	if (typeof embed !== 'boolean') fail(`${at}.embed must be a boolean`);
	let keepSource = KEEP_SOURCE_DEFAULT;
	if (raw.keepSource !== undefined) {
		if (typeof raw.keepSource !== 'boolean') fail(`${at}.keepSource must be a boolean`);
		else keepSource = raw.keepSource;
	}

	let silenceHours = 72;
	if (raw.silenceHours !== undefined) {
		const h = raw.silenceHours;
		if (typeof h !== 'number' || !Number.isInteger(h) || h < 1 || h > 720)
			fail(`${at}.silenceHours must be an integer 1..720`);
		else silenceHours = h;
	}

	const hiddenProjects: string[] = [];
	if (raw.hiddenProjects !== undefined) {
		if (!Array.isArray(raw.hiddenProjects)) fail(`${at}.hiddenProjects must be an array`);
		else
			raw.hiddenProjects.forEach((p, j) => {
				if (typeof p === 'string' && UUID.test(p)) hiddenProjects.push(p.toLowerCase());
				else fail(`${at}.hiddenProjects[${j}] must be a UUID`);
			});
	}

	// Secrets: both are required and distinct (the webhook is signed with the form's own secret, design §10).
	let clientSecret = '';
	let webhookSecret = '';
	if (TENANT_ID.test(id)) {
		const prefix = `PLANE_MIRO_${id.toUpperCase()}`;
		clientSecret = env[`${prefix}_PLANE_SECRET`]?.trim() ?? '';
		webhookSecret = env[`${prefix}_WEBHOOK_SECRET`]?.trim() ?? '';
		if (!clientSecret) fail(`missing env ${prefix}_PLANE_SECRET`);
		if (!webhookSecret) fail(`missing env ${prefix}_WEBHOOK_SECRET`);
	}

	const ids = { id, workspaceId, miroTeamId };
	if (failed.count > 0 || typeof embed !== 'boolean') return { tenant: null, ids };
	const tenant: Tenant = {
		id,
		workspace,
		workspaceId,
		auth: { clientId, clientSecret, appInstallationId },
		webhookSecret,
		miroTeamId,
		embed,
		keepSource,
		silenceHours,
		hiddenProjects,
	};
	return { tenant, ids };
}
