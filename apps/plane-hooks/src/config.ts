import { createPrivateKey } from 'node:crypto';

export type Config = {
	port: number;
	planeUrl: string;
	workspace: string;
	projectId: string;
	planeApiKey: string;
	grafanaToken: string;
	/** `null` — the variable is unset: the input is off and its path answers 404. */
	vercelSecret: string | null;
	deploySecret: string | null;
};

const REQUIRED = {
	planeUrl: 'PLANE_HOOKS_PLANE_URL',
	workspace: 'PLANE_HOOKS_WORKSPACE',
	projectId: 'PLANE_HOOKS_PROJECT_ID',
	planeApiKey: 'PLANE_HOOKS_PLANE_API_KEY',
	grafanaToken: 'PLANE_HOOKS_GRAFANA_TOKEN',
} as const;

const OPTIONAL = {
	vercelSecret: 'PLANE_HOOKS_VERCEL_SECRET',
	deploySecret: 'PLANE_HOOKS_DEPLOY_SECRET',
} as const;

// Grafana re-parses env-substituted provisioning values through YAML type
// inference: a token that looks like a number would turn into an int (the
// `chatid` trap in contact-points.yaml). The `ph_` prefix keeps it a string.
const GRAFANA_TOKEN = /^ph_[0-9a-f]{48}$/;
// Any other value (a pasted project URL) makes every project-scoped Plane call 404: every delivery 502s forever.
const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the service config. Errors name the variables, never their values. */
export function loadConfig(env: Record<string, string | undefined>): Config {
	const missing = Object.values(REQUIRED).filter((name) => !env[name]?.trim());
	if (missing.length > 0) throw new Error(`plane-hooks: missing env ${missing.join(', ')}`);
	const read = (name: string) => (env[name] as string).trim();
	// Unset turns the input off; set-but-blank is a misconfiguration (a stray space would silently disable it).
	const readOptional = (name: string): string | null => {
		if (env[name] === undefined) return null;
		if (!read(name))
			throw new Error(`plane-hooks: ${name} is set but empty (unset it to disable the input)`);
		return read(name);
	};

	const planeUrl = read(REQUIRED.planeUrl).replace(/\/+$/, '');
	if (!/^https?:\/\//.test(planeUrl))
		throw new Error(`plane-hooks: ${REQUIRED.planeUrl} must start with http(s)://`);
	const grafanaToken = read(REQUIRED.grafanaToken);
	if (!GRAFANA_TOKEN.test(grafanaToken)) {
		throw new Error(`plane-hooks: ${REQUIRED.grafanaToken} must look like ph_<48 lowercase hex>`);
	}
	const projectId = read(REQUIRED.projectId);
	if (!PROJECT_UUID.test(projectId)) {
		throw new Error(
			`plane-hooks: ${REQUIRED.projectId} must be a project UUID (copy it from …/projects/<UUID>/issues)`,
		);
	}
	const port = env.PORT?.trim() ? Number(env.PORT) : 8080;
	if (!Number.isInteger(port) || port < 1 || port > 65_535)
		throw new Error('plane-hooks: PORT must be an integer 1..65535');

	return {
		port,
		planeUrl,
		workspace: read(REQUIRED.workspace),
		projectId,
		planeApiKey: read(REQUIRED.planeApiKey),
		grafanaToken,
		vercelSecret: readOptional(OPTIONAL.vercelSecret),
		deploySecret: readOptional(OPTIONAL.deploySecret),
	};
}

export function enabledInputs(config: Config): Array<'grafana' | 'vercel' | 'deploy'> {
	const inputs: Array<'grafana' | 'vercel' | 'deploy'> = ['grafana'];
	if (config.vercelSecret !== null) inputs.push('vercel');
	if (config.deploySecret !== null) inputs.push('deploy');
	return inputs;
}

// ---------------------------------------------------------------------------
// Multi-tenant config (tenants.json + env). The single-tenant `loadConfig` above stays until the hub replaces it.

export type InputName = 'grafana' | 'vercel' | 'dokploy';
export type GitHubAppConfig = {
	name: string;
	appId: number;
	owner: string;
	privateKeyPem: string;
	webhookSecret: string;
};
export type EnvironmentRule = { name: string; state: string; release: boolean };
export type RepoRule = { repo: string; environments: readonly EnvironmentRule[] };
export type DeliveryConfig = {
	states: { review: string; done: string };
	hold: readonly string[];
	repos: readonly RepoRule[];
	/** Project identifier → target state name → that project's state name, or null: never set there. */
	projects: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
};
/** Severity (or `*`) → environment (or `*`) → work-item priority of a firing alert. */
export type PriorityTable = Readonly<
	Record<string, Readonly<Record<string, 'urgent' | 'high' | 'medium'>>>
>;
/** The table the README documents; a tenant's `incidents.priority` is merged over it cell by cell. */
export const DEFAULT_PRIORITY: PriorityTable = {
	critical: { '*': 'urgent', staging: 'high' },
	warning: { '*': 'high', staging: 'medium' },
	'*': { '*': 'urgent', staging: 'high' },
};
// Keys that would write into or shadow Object.prototype when used on a plain object.
const UNSAFE_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];
const PRIORITIES: readonly string[] = ['urgent', 'high', 'medium'];
export type DokployAppRule = { name: string; repo: string; environment: string };
export type Tenant = {
	id: string;
	workspace: string;
	plane: { clientId: string; clientSecret: string; appInstallationId: string };
	github: readonly GitHubAppConfig[];
	incidents: { project: string; priority: PriorityTable } | null;
	delivery: DeliveryConfig | null;
	dokploy: readonly DokployAppRule[];
	inputs: Readonly<Record<InputName, string | null>>;
	silenceHours: Readonly<Partial<Record<InputName, number>>>;
};
export type ServiceConfig = {
	port: number;
	planeUrl: string;
	publicUrl: string;
	tenants: readonly Tenant[];
};

const INPUT_NAMES: readonly InputName[] = ['grafana', 'vercel', 'dokploy'];
const NAME_RE = /^[a-z][a-z0-9]{0,15}$/;
const NAME_HINT = 'a-z then up to 15 of a-z0-9';
const ENV_SEGMENT = /^[A-Za-z][A-Za-z0-9]{0,15}$/;
const PROJECT_IDENTIFIER = /^[A-Z][A-Z0-9]{0,11}$/;
const REPO_RULE = /^[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+|\*)$/;
const REPO_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

type Obj = Record<string, unknown>;
type Env = Record<string, string | undefined>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** First rule whose `repo` is `owner/name` or `owner/*` of `fullName` (case-insensitive); null — no rule. */
export function matchRepo(rules: readonly RepoRule[], fullName: string): RepoRule | null {
	const full = fullName.toLowerCase();
	const owner = full.split('/')[0];
	for (const rule of rules) {
		const repo = rule.repo.toLowerCase();
		if (repo === full || (repo.endsWith('/*') && repo.slice(0, -2) === owner)) return rule;
	}
	return null;
}

/** Throws one Error listing every problem; messages name env vars and JSON paths, never values. */
export function loadServiceConfig(env: Env, readFile: (path: string) => string): ServiceConfig {
	const problems: string[] = [];
	const bad = (msg: string) => problems.push(msg);
	const read = (name: string) => env[name]?.trim() ?? '';

	const url = (name: string): string => {
		const value = read(name).replace(/\/+$/, '');
		if (!value) bad(`missing env ${name}`);
		else if (!/^https?:\/\//.test(value)) bad(`${name} must start with http(s)://`);
		return value;
	};
	const planeUrl = url('PLANE_HOOKS_PLANE_URL');
	const publicUrl = url('PLANE_HOOKS_PUBLIC_URL');
	const port = env.PORT?.trim() ? Number(env.PORT) : 8080;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) bad('PORT must be an integer 1..65535');
	const configPath = read('PLANE_HOOKS_CONFIG') || '/config/tenants.json';

	const tenants = parseServiceTenants(env, readFile, configPath, bad);
	if (problems.length > 0) throw new Error(`plane-hooks: ${problems.join('; ')}`);
	return { port, planeUrl, publicUrl, tenants };
}

function parseServiceTenants(
	env: Env,
	readFile: (path: string) => string,
	configPath: string,
	bad: (msg: string) => void,
): Tenant[] {
	let root: unknown;
	try {
		root = JSON.parse(readFile(configPath));
	} catch {
		// The cause is dropped on purpose: a JSON.parse message quotes file content.
		bad(`PLANE_HOOKS_CONFIG: cannot read ${configPath} as JSON`);
		return [];
	}
	if (!isObj(root) || !Array.isArray(root.tenants) || Object.keys(root).length !== 1) {
		bad('tenants file must be an object {"tenants": [...]}');
		return [];
	}
	const tenants: Tenant[] = [];
	const seen = { id: new Set<string>(), appName: new Set<string>(), appId: new Set<number>() };
	root.tenants.forEach((raw, i) => {
		const at = `tenants[${i}]`;
		if (isObj(raw) && typeof raw.id === 'string' && NAME_RE.test(raw.id)) {
			if (seen.id.has(raw.id)) bad(`${at}.id is a duplicate`);
			seen.id.add(raw.id);
		}
		const tenant = parseServiceTenant(raw, at, env, seen, bad);
		if (tenant) tenants.push(tenant);
	});
	return tenants;
}

function parseServiceTenant(
	raw: unknown,
	at: string,
	env: Env,
	seen: { appName: Set<string>; appId: Set<number> },
	bad: (msg: string) => void,
): Tenant | null {
	if (!isObj(raw)) {
		bad(`${at} must be an object`);
		return null;
	}
	let failed = 0;
	const fail = (msg: string) => {
		failed++;
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
	const obj = (value: unknown, path: string): Obj | null => {
		if (isObj(value)) return value;
		fail(`${path} must be an object`);
		return null;
	};
	const list = (value: unknown, path: string): unknown[] => {
		if (Array.isArray(value)) return value;
		fail(`${path} must be an array`);
		return [];
	};

	unknownKeys(
		raw,
		['id', 'workspace', 'plane', 'github', 'incidents', 'delivery', 'dokploy', 'silenceHours'],
		at,
	);
	const rawId = typeof raw.id === 'string' ? raw.id : '';
	const id = str(raw, 'id', at, NAME_RE, NAME_HINT);
	const workspace = str(raw, 'workspace', at);

	let clientId = '';
	let appInstallationId = '';
	const planeObj = obj(raw.plane, `${at}.plane`);
	if (planeObj) {
		unknownKeys(planeObj, ['clientId', 'appInstallationId'], `${at}.plane`);
		clientId = str(planeObj, 'clientId', `${at}.plane`);
		appInstallationId = str(planeObj, 'appInstallationId', `${at}.plane`);
	}

	// Secrets come from env. A wrongly cased id still names its variables, so one run reports them all.
	const idOk = ENV_SEGMENT.test(rawId);
	const envName = (suffix: string) => `PLANE_HOOKS_${rawId.toUpperCase()}_${suffix}`;
	let clientSecret = '';
	const inputs: Record<InputName, string | null> = { grafana: null, vercel: null, dokploy: null };
	if (idOk) {
		clientSecret = readEnv(env, envName('PLANE_SECRET'));
		if (!clientSecret) fail(`missing env ${envName('PLANE_SECRET')}`);
		for (const input of INPUT_NAMES) {
			const name = envName(`${input.toUpperCase()}_${input === 'grafana' ? 'TOKEN' : 'SECRET'}`);
			if (env[name] === undefined) continue;
			const value = readEnv(env, name);
			if (!value) fail(`${name} is set but empty (unset it to disable the input)`);
			else if (input === 'grafana' && !GRAFANA_TOKEN.test(value))
				fail(`${name} must look like ph_<48 lowercase hex>`);
			else inputs[input] = value;
		}
	}

	const github: GitHubAppConfig[] = [];
	list(raw.github ?? [], `${at}.github`).forEach((app, j) => {
		const path = `${at}.github[${j}]`;
		const appObj = obj(app, path);
		if (!appObj) return;
		unknownKeys(appObj, ['name', 'appId', 'owner'], path);
		const name = str(appObj, 'name', path, NAME_RE, NAME_HINT);
		const owner = str(appObj, 'owner', path);
		const appId = appObj.appId;
		if (typeof appId !== 'number' || !Number.isSafeInteger(appId) || appId < 1)
			fail(`${path}.appId must be a positive integer`);
		else {
			if (seen.appId.has(appId)) fail(`${path}.appId is a duplicate`);
			seen.appId.add(appId);
		}
		let privateKeyPem = '';
		let webhookSecret = '';
		if (NAME_RE.test(name)) {
			if (seen.appName.has(name)) fail(`${path}.name is a duplicate`);
			seen.appName.add(name);
			const prefix = `PLANE_HOOKS_GH_${name.toUpperCase()}`;
			const encoded = readEnv(env, `${prefix}_PRIVATE_KEY`);
			if (!encoded) fail(`missing env ${prefix}_PRIVATE_KEY`);
			else {
				const pem = Buffer.from(encoded, 'base64').toString('utf8');
				try {
					if (createPrivateKey(pem).asymmetricKeyType !== 'rsa') throw new Error('not rsa');
					privateKeyPem = pem;
				} catch {
					fail(`${prefix}_PRIVATE_KEY must be an RSA private key in PEM, base64 on one line`);
				}
			}
			webhookSecret = readEnv(env, `${prefix}_WEBHOOK_SECRET`);
			if (!webhookSecret) fail(`missing env ${prefix}_WEBHOOK_SECRET`);
		}
		github.push({
			name,
			appId: typeof appId === 'number' ? appId : 0,
			owner,
			privateKeyPem,
			webhookSecret,
		});
	});

	let incidents: Tenant['incidents'] = null;
	if (raw.incidents !== undefined) {
		const inc = obj(raw.incidents, `${at}.incidents`);
		if (inc) {
			unknownKeys(inc, ['project', 'priority'], `${at}.incidents`);
			incidents = {
				project: str(inc, 'project', `${at}.incidents`, PROJECT_IDENTIFIER, 'a project identifier'),
				priority: parsePriority(inc.priority, `${at}.incidents.priority`, { fail, obj }),
			};
		}
	}
	if (inputs.grafana !== null && incidents === null)
		fail(`${at}.incidents.project is required for grafana`);

	let delivery: DeliveryConfig | null = null;
	if (raw.delivery !== undefined) {
		const d = obj(raw.delivery, `${at}.delivery`);
		if (d) delivery = parseDelivery(d, `${at}.delivery`, { fail, unknownKeys, str, obj, list });
	}

	const dokploy: DokployAppRule[] = [];
	if (raw.dokploy !== undefined) {
		const dok = obj(raw.dokploy, `${at}.dokploy`);
		if (dok) {
			unknownKeys(dok, ['apps'], `${at}.dokploy`);
			const names = new Set<string>();
			list(dok.apps, `${at}.dokploy.apps`).forEach((app, j) => {
				const path = `${at}.dokploy.apps[${j}]`;
				const appObj = obj(app, path);
				if (!appObj) return;
				unknownKeys(appObj, ['name', 'repo', 'environment'], path);
				const name = str(appObj, 'name', path);
				if (names.has(name)) fail(`${path}.name is a duplicate`);
				names.add(name);
				dokploy.push({
					name,
					repo: str(appObj, 'repo', path, REPO_NAME, 'owner/name'),
					environment: str(appObj, 'environment', path),
				});
			});
		}
	}

	const silenceHours: Partial<Record<InputName, number>> = {};
	if (raw.silenceHours !== undefined) {
		const silence = obj(raw.silenceHours, `${at}.silenceHours`);
		if (silence) {
			unknownKeys(silence, INPUT_NAMES, `${at}.silenceHours`);
			for (const input of INPUT_NAMES) {
				const hours = silence[input];
				if (hours === undefined) continue;
				if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > 720)
					fail(`${at}.silenceHours.${input} must be an integer 1..720`);
				else silenceHours[input] = hours;
			}
		}
	}

	if (failed > 0) return null;
	return {
		id,
		workspace,
		plane: { clientId, clientSecret, appInstallationId },
		github,
		incidents,
		delivery,
		dokploy,
		inputs,
		silenceHours,
	};
}

type Helpers = {
	fail: (msg: string) => void;
	unknownKeys: (obj: Obj, allowed: readonly string[], path: string) => void;
	str: (obj: Obj, key: string, path: string, re?: RegExp, hint?: string) => string;
	obj: (value: unknown, path: string) => Obj | null;
	list: (value: unknown, path: string) => unknown[];
};

/** `DEFAULT_PRIORITY` with the configured cells laid over it; an unset table is the default. */
function parsePriority(
	value: unknown,
	at: string,
	h: Pick<Helpers, 'fail' | 'obj'>,
): PriorityTable {
	if (value === undefined) return DEFAULT_PRIORITY;
	const merged: Record<string, Record<string, 'urgent' | 'high' | 'medium'>> = {};
	for (const [severity, row] of Object.entries(DEFAULT_PRIORITY)) merged[severity] = { ...row };
	for (const [severity, envs] of Object.entries(h.obj(value, at) ?? {})) {
		if (UNSAFE_KEYS.includes(severity)) {
			h.fail(`${at}.${severity} is not an allowed key`);
			continue;
		}
		const rowObj = h.obj(envs, `${at}.${severity}`);
		for (const [env, priority] of Object.entries(rowObj ?? {})) {
			if (UNSAFE_KEYS.includes(env)) {
				h.fail(`${at}.${severity}.${env} is not an allowed key`);
				continue;
			}
			if (typeof priority === 'string' && PRIORITIES.includes(priority)) {
				(merged[severity] ??= {})[env] = priority as 'urgent' | 'high' | 'medium';
			} else h.fail(`${at}.${severity}.${env} must be urgent, high or medium`);
		}
	}
	return merged;
}

function parseDelivery(d: Obj, at: string, h: Helpers): DeliveryConfig {
	h.unknownKeys(d, ['states', 'hold', 'repos', 'projects'], at);
	let review = '';
	let done = '';
	const states = h.obj(d.states, `${at}.states`);
	if (states) {
		h.unknownKeys(states, ['review', 'done'], `${at}.states`);
		review = h.str(states, 'review', `${at}.states`);
		done = h.str(states, 'done', `${at}.states`);
	}
	const hold: string[] = [];
	h.list(d.hold ?? [], `${at}.hold`).forEach((state, i) => {
		if (typeof state === 'string' && state.trim()) hold.push(state);
		else h.fail(`${at}.hold[${i}] must be a non-empty string`);
	});

	const repos: RepoRule[] = [];
	h.list(d.repos ?? [], `${at}.repos`).forEach((rule, i) => {
		const path = `${at}.repos[${i}]`;
		const ruleObj = h.obj(rule, path);
		if (!ruleObj) return;
		h.unknownKeys(ruleObj, ['repo', 'environments'], path);
		const repo = h.str(ruleObj, 'repo', path, REPO_RULE, 'owner/name or owner/*');
		const environments: EnvironmentRule[] = [];
		const names = new Set<string>();
		h.list(ruleObj.environments ?? [], `${path}.environments`).forEach((env, j) => {
			const envPath = `${path}.environments[${j}]`;
			const envObj = h.obj(env, envPath);
			if (!envObj) return;
			h.unknownKeys(envObj, ['name', 'state', 'release'], envPath);
			const name = h.str(envObj, 'name', envPath);
			if (names.has(name)) h.fail(`${envPath}.name is a duplicate`);
			names.add(name);
			const state = h.str(envObj, 'state', envPath);
			if (envObj.release !== undefined && typeof envObj.release !== 'boolean')
				h.fail(`${envPath}.release must be a boolean`);
			environments.push({ name, state, release: envObj.release === true });
		});
		repos.push({ repo, environments });
	});

	const projects: Record<string, Record<string, string | null>> = {};
	const projectsObj = d.projects === undefined ? {} : h.obj(d.projects, `${at}.projects`);
	for (const [identifier, renames] of Object.entries(projectsObj ?? {})) {
		const path = `${at}.projects.${identifier}`;
		if (!PROJECT_IDENTIFIER.test(identifier))
			h.fail(`${path} must be a project identifier (A-Z0-9)`);
		const renamesObj = h.obj(renames, path);
		const target: Record<string, string | null> = {};
		for (const [state, name] of Object.entries(renamesObj ?? {})) {
			if (name === null || (typeof name === 'string' && name.trim())) target[state] = name;
			else h.fail(`${path}.${state} must be a non-empty string or null`);
		}
		projects[identifier] = target;
	}
	return { states: { review, done }, hold, repos, projects };
}

const readEnv = (env: Env, name: string): string => env[name]?.trim() ?? '';
