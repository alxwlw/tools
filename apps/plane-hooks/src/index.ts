import { loadConfig } from "./config.ts";
import { postDeployNotes } from "./deploy-note.ts";
import { createIncidentReporter } from "./incident.ts";
import { PlaneClient } from "./plane.ts";
import { MAX_BODY_BYTES, createHandler, describeError, text } from "./server.ts";
import { ttl } from "./ttl.ts";

const PROJECT_IDENTIFIERS_TTL_MS = 10 * 60_000;

const config = loadConfig(process.env);
const plane = new PlaneClient({ baseUrl: config.planeUrl, workspace: config.workspace, apiKey: config.planeApiKey });
const projectIdentifiers = ttl(
	async (): Promise<ReadonlySet<string>> => new Set(await plane.listProjectIdentifiers()),
	PROJECT_IDENTIFIERS_TTL_MS,
);
const log = (entry: object) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));

const server = Bun.serve({
	port: config.port,
	// Never Bun's development error page: it shows the message, source lines and paths to the sender.
	development: false,
	// The handler enforces the exact 1 MiB limit with a 413; this only stops absurd bodies earlier.
	maxRequestBodySize: MAX_BODY_BYTES * 2,
	error(err) {
		log({ source: "-", event: "unhandled", key: "-", action: "error", workItemId: null, ms: 0, error: describeError(err) });
		return text(500, "internal error");
	},
	fetch: createHandler({
		grafanaToken: config.grafanaToken,
		vercelSecret: config.vercelSecret,
		incidents: createIncidentReporter({ plane, projectId: config.projectId }),
		deployNotes: (note) => postDeployNotes({ plane, projectIdentifiers }, note),
		log,
	}),
});

log({ event: "listening", port: server.port });
