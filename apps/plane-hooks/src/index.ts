import { enabledInputs, loadConfig } from './config.ts';
import { postDeployNotes } from './deploy-note.ts';
import { createIncidentReporter } from './incident.ts';
import { apiKeyAuth, PlaneClient } from './plane.ts';
import { publishRelease } from './release.ts';
import { createHandler, describeError, MAX_BODY_BYTES, text } from './server.ts';
import { ttl } from './ttl.ts';

const PROJECT_IDENTIFIERS_TTL_MS = 10 * 60_000;

const config = loadConfig(process.env);
const plane = new PlaneClient({
	baseUrl: config.planeUrl,
	workspace: config.workspace,
	auth: apiKeyAuth(config.planeApiKey),
});
const projectIdentifiers = ttl(
	async (): Promise<ReadonlySet<string>> => new Set(await plane.listProjectIdentifiers()),
	PROJECT_IDENTIFIERS_TTL_MS,
);
const log = (entry: object) =>
	console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));

const server = Bun.serve({
	port: config.port,
	// Never Bun's development error page: it shows the message, source lines and paths to the sender.
	development: false,
	// The handler enforces the exact 1 MiB limit with a 413; this only stops absurd bodies earlier.
	maxRequestBodySize: MAX_BODY_BYTES * 2,
	// A prod promotion with up to 50 keys can keep one request busy for ~2 minutes. Measured on Bun 1.3.14: the default
	// idleTimeout (10 s) closed GET and empty-bodied POST at 10 s, while a POST with a body ran 30 s to 200.
	// 240 (max 255) guards against that cut reaching POSTs.
	idleTimeout: 240,
	error(err) {
		log({
			source: '-',
			event: 'unhandled',
			key: '-',
			action: 'error',
			workItemId: null,
			ms: 0,
			error: describeError(err),
		});
		return text(500, 'internal error');
	},
	fetch: createHandler({
		grafanaToken: config.grafanaToken,
		vercelSecret: config.vercelSecret,
		deploySecret: config.deploySecret,
		incidents: createIncidentReporter({ plane, projectId: config.projectId }),
		deployNotes: (note) => postDeployNotes({ plane, projectIdentifiers }, note),
		releases: (draft, items) => publishRelease({ plane }, draft, items),
		log,
	}),
});

log({ event: 'listening', port: server.port, inputs: enabledInputs(config) });
