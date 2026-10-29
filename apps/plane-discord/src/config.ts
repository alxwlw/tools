export type EventKind = 'created' | 'closed' | 'mention';
export type ChannelRoute = {
	channelId: string;
	projectId: string;
	moduleId: string | null;
	events: readonly EventKind[];
};
/** Plane App only: the key mode (API key + workspace webhook v2) was dropped after the probe (design §10). */
export type PlaneAuthConfig = { clientId: string; clientSecret: string; appInstallationId: string };
export type UserLink = { plane: string; discord: string };
export type Tenant = {
	id: string;
	guildId: string;
	workspace: string;
	workspaceId: string;
	auth: PlaneAuthConfig;
	webhookSecret: string;
	serviceChannelId: string | null;
	silenceHours: number;
	hiddenProjects: readonly string[];
	channels: readonly ChannelRoute[];
	users: readonly UserLink[];
};
export type Config = {
	port: number;
	planeUrl: string;
	publicUrl: string;
	configPath: string;
	dbPath: string;
	discord: { applicationId: string; publicKey: string; botToken: string };
	tenants: readonly Tenant[];
};

const EVENT_KINDS: readonly EventKind[] = ['created', 'closed', 'mention'];
const SNOWFLAKE = /^\d{17,20}$/;
// A Plane id: a UUID, any case.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_KEY = /^[0-9a-f]{64}$/i;
const TENANT_ID = /^[a-z][a-z0-9]{0,15}$/;

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
		'PLANE_DISCORD_PLANE_URL',
		'PLANE_DISCORD_PUBLIC_URL',
		'PLANE_DISCORD_DISCORD_APPLICATION_ID',
		'PLANE_DISCORD_DISCORD_PUBLIC_KEY',
		'PLANE_DISCORD_DISCORD_BOT_TOKEN',
	];
	const missing = required.filter((name) => !read(name));
	if (missing.length > 0) bad(`missing env ${missing.join(', ')}`);

	const url = (name: string): string => {
		const value = read(name).replace(/\/+$/, '');
		if (value && !/^https?:\/\//.test(value)) bad(`${name} must start with http(s)://`);
		return value;
	};
	const planeUrl = url('PLANE_DISCORD_PLANE_URL');
	const publicUrl = url('PLANE_DISCORD_PUBLIC_URL');
	const applicationId = read('PLANE_DISCORD_DISCORD_APPLICATION_ID');
	if (applicationId && !SNOWFLAKE.test(applicationId))
		bad('PLANE_DISCORD_DISCORD_APPLICATION_ID must be a snowflake (17-20 digits)');
	const publicKey = read('PLANE_DISCORD_DISCORD_PUBLIC_KEY');
	if (publicKey && !PUBLIC_KEY.test(publicKey))
		bad('PLANE_DISCORD_DISCORD_PUBLIC_KEY must be 64 hex characters');
	const botToken = read('PLANE_DISCORD_DISCORD_BOT_TOKEN');

	const port = env.PORT?.trim() ? Number(env.PORT) : 8080;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) bad('PORT must be an integer 1..65535');
	const configPath = read('PLANE_DISCORD_CONFIG') || '/config/tenants.json';
	const dbPath = read('PLANE_DISCORD_DB') || '/data/plane-discord.sqlite';

	const tenants = parseTenants(env, readFile, configPath, bad);

	if (problems.length > 0) throw new Error(`plane-discord: ${problems.join('; ')}`);
	return {
		port,
		planeUrl,
		publicUrl,
		configPath,
		dbPath,
		discord: { applicationId, publicKey, botToken },
		tenants,
	};
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
		bad(`PLANE_DISCORD_CONFIG: cannot read ${configPath} as JSON`);
		return [];
	}
	if (!isObj(root) || !Array.isArray(root.tenants) || Object.keys(root).length !== 1) {
		bad('tenants file must be an object {"tenants": [...]}');
		return [];
	}

	const tenants: Tenant[] = [];
	const seen = {
		id: new Set<string>(),
		guildId: new Set<string>(),
		workspaceId: new Set<string>(),
	};
	root.tenants.forEach((raw, i) => {
		const at = `tenants[${i}]`;
		const { tenant, ids } = parseTenant(raw, at, env, bad);
		// Checked even when the tenant itself is invalid, so one run reports every problem.
		for (const key of ['id', 'guildId', 'workspaceId'] as const) {
			if (!ids[key]) continue;
			if (seen[key].has(ids[key])) bad(`${at}.${key} is a duplicate`);
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
): { tenant: Tenant | null; ids: { id: string; guildId: string; workspaceId: string } } {
	if (!isObj(raw)) {
		bad(`${at} must be an object`);
		return { tenant: null, ids: { id: '', guildId: '', workspaceId: '' } };
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
	const nullableId = (
		obj: Obj,
		key: string,
		path: string,
		re: RegExp,
		hint: string,
	): string | null => {
		if (obj[key] === undefined || obj[key] === null) return null;
		return str(obj, key, path, re, hint) || null;
	};

	unknownKeys(
		raw,
		[
			'id',
			'guildId',
			'workspace',
			'workspaceId',
			'plane',
			'serviceChannelId',
			'silenceHours',
			'hiddenProjects',
			'channels',
			'users',
		],
		at,
	);
	const id = str(raw, 'id', at, TENANT_ID, 'a-z then up to 15 of a-z0-9');
	const guildId = str(raw, 'guildId', at, SNOWFLAKE, 'a snowflake (17-20 digits)');
	const workspace = str(raw, 'workspace', at);
	const workspaceId = str(raw, 'workspaceId', at, UUID, 'a UUID');

	let clientId = '';
	let appInstallationId = '';
	if (!isObj(raw.plane)) fail(`${at}.plane must be an object`);
	else {
		unknownKeys(raw.plane, ['clientId', 'appInstallationId'], `${at}.plane`);
		clientId = str(raw.plane, 'clientId', `${at}.plane`);
		appInstallationId = str(raw.plane, 'appInstallationId', `${at}.plane`);
	}

	const serviceChannelId = nullableId(
		raw,
		'serviceChannelId',
		at,
		SNOWFLAKE,
		'a snowflake or null',
	);
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
				if (typeof p === 'string' && UUID.test(p)) hiddenProjects.push(p);
				else fail(`${at}.hiddenProjects[${j}] must be a UUID`);
			});
	}

	const channels: ChannelRoute[] = [];
	const channelIds = new Set<string>();
	if (!Array.isArray(raw.channels)) fail(`${at}.channels must be an array`);
	else
		raw.channels.forEach((c, j) => {
			const path = `${at}.channels[${j}]`;
			if (!isObj(c)) {
				fail(`${path} must be an object`);
				return;
			}
			unknownKeys(c, ['channelId', 'projectId', 'moduleId', 'events'], path);
			const channelId = str(c, 'channelId', path, SNOWFLAKE, 'a snowflake (17-20 digits)');
			const projectId = str(c, 'projectId', path, UUID, 'a UUID');
			const moduleId = nullableId(c, 'moduleId', path, UUID, 'a UUID or null');
			let events: EventKind[] = [...EVENT_KINDS];
			if (c.events !== undefined) {
				const list = c.events;
				if (
					!Array.isArray(list) ||
					list.length === 0 ||
					!list.every((e): e is EventKind => EVENT_KINDS.includes(e as EventKind))
				)
					fail(`${path}.events must be a non-empty array of ${EVENT_KINDS.join('|')}`);
				else events = [...new Set(list)];
			}
			if (channelId && channelIds.has(channelId)) fail(`${path}.channelId is a duplicate`);
			channelIds.add(channelId);
			channels.push({ channelId, projectId, moduleId, events });
		});

	const users: UserLink[] = [];
	const planeIds = new Set<string>();
	const discordIds = new Set<string>();
	if (!Array.isArray(raw.users)) fail(`${at}.users must be an array`);
	else
		raw.users.forEach((u, j) => {
			const path = `${at}.users[${j}]`;
			if (!isObj(u)) {
				fail(`${path} must be an object`);
				return;
			}
			unknownKeys(u, ['plane', 'discord'], path);
			const plane = str(u, 'plane', path);
			const discord = str(u, 'discord', path, SNOWFLAKE, 'a snowflake (17-20 digits)');
			if (plane && planeIds.has(plane)) fail(`${path}.plane is a duplicate`);
			if (discord && discordIds.has(discord)) fail(`${path}.discord is a duplicate`);
			planeIds.add(plane);
			discordIds.add(discord);
			users.push({ plane, discord });
		});

	// Secrets: both are required and distinct (the webhook is signed with the form's own secret, design §10).
	let clientSecret = '';
	let webhookSecret = '';
	if (TENANT_ID.test(id)) {
		const prefix = `PLANE_DISCORD_${id.toUpperCase()}`;
		clientSecret = env[`${prefix}_PLANE_SECRET`]?.trim() ?? '';
		webhookSecret = env[`${prefix}_WEBHOOK_SECRET`]?.trim() ?? '';
		if (!clientSecret) fail(`missing env ${prefix}_PLANE_SECRET`);
		if (!webhookSecret) fail(`missing env ${prefix}_WEBHOOK_SECRET`);
	}

	const ids = { id, guildId, workspaceId };
	if (failed.count > 0) return { tenant: null, ids };
	const tenant: Tenant = {
		id,
		guildId,
		workspace,
		workspaceId,
		auth: { clientId, clientSecret, appInstallationId },
		webhookSecret,
		serviceChannelId,
		silenceHours,
		hiddenProjects,
		channels,
		users,
	};
	return { tenant, ids };
}

export function describeTenants(
	config: Config,
): Array<{ id: string; channels: number; users: number }> {
	return config.tenants.map((t) => ({
		id: t.id,
		channels: t.channels.length,
		users: t.users.length,
	}));
}
