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
