import { readFileSync } from 'node:fs';

import { type Config, describeTenants, loadConfig } from './config.ts';
import { createInteractionHandler } from './discord/interactions.ts';
import { DiscordRest } from './discord/rest.ts';
import { jsonLog, type Log } from './log.ts';
import { createNotifier } from './notify.ts';
import type { Fetch } from './plane/auth.ts';
import type { PlaneEvent } from './plane/webhook.ts';
import { SerialQueue } from './queue.ts';
import { createRuntime, type Runtime } from './runtime.ts';
import { createHandler } from './server.ts';
import { Store } from './store.ts';
import { checkSilence } from './watchdog.ts';

const MINUTE_MS = 60_000;
const SILENCE_CHECK_MS = 15 * MINUTE_MS;
const WARM_MS = 10 * MINUTE_MS;
const PRUNE_MS = 24 * 60 * MINUTE_MS;
const KEEP_SEEN_MS = 7 * 24 * 60 * MINUTE_MS;
/** Above MAX_PLANE_BODY, so an oversized delivery gets our 200 + log line instead of Bun's own 413. */
const MAX_REQUEST_BODY = 8 * 1024 * 1024;
/** Seconds Bun waits on an idle connection: a stalled body must not hold a request for ever. */
const IDLE_TIMEOUT_S = 10;
const DRAIN_MS = 10_000;

export type Service = {
	port: number;
	config: Config;
	/** Resolves when the delivery queue is empty (tests, shutdown). */
	idle: () => Promise<void>;
	stop: () => Promise<void>;
};
export type ServiceOptions = {
	readFile?: (path: string) => string;
	fetch?: Fetch;
	write?: (line: string) => void;
	/** Tests: 0 picks a free port. */
	listenPort?: number;
	now?: () => number;
	/** Runs `tick` every `ms`; returns the canceller. Tests drive the ticks by hand. */
	every?: (tick: () => void, ms: number) => () => void;
};

/** The error's class name is all a log line gets: messages of failed calls may quote payloads. */
const errorName = (error: unknown): string => {
	try {
		return error instanceof Error ? error.name : 'unknown';
	} catch {
		return 'unknown';
	}
};

/** Throws on a bad config (loadConfig lists every problem); otherwise returns a running service. */
export function startService(
	env: Record<string, string | undefined>,
	options: ServiceOptions = {},
): Service {
	const config = loadConfig(env, options.readFile ?? ((path) => readFileSync(path, 'utf8')));
	const sink = jsonLog(options.write);
	// A failing stdout (EPIPE) must not take a response, a job or the process down.
	const log: Log = (entry) => {
		try {
			sink(entry);
		} catch {
			// nothing else to do with a broken log
		}
	};
	const now = options.now ?? Date.now;
	const every =
		options.every ??
		((tick, ms) => {
			const timer = setInterval(tick, ms);
			return () => clearInterval(timer);
		});
	const startedAt = now();
	const store = new Store(config.dbPath);

	const runtimes = new Map<string, Runtime>();
	const runtimesByGuild = new Map<string, Runtime>();
	for (const tenant of config.tenants) {
		const runtime = createRuntime(tenant, { planeUrl: config.planeUrl, fetch: options.fetch, now });
		runtimes.set(tenant.id, runtime);
		runtimesByGuild.set(tenant.guildId, runtime);
	}

	const discord = new DiscordRest({
		botToken: config.discord.botToken,
		applicationId: config.discord.applicationId,
		fetch: options.fetch,
	});
	const channelTypes = new Map<string, Promise<number>>();
	const channelType = (channelId: string): Promise<number> => {
		let known = channelTypes.get(channelId);
		if (known === undefined) {
			const pending = discord.getChannel(channelId).then((channel) => channel.type);
			known = pending;
			channelTypes.set(channelId, pending);
			// A failed lookup is not remembered.
			pending.catch(() => {
				if (channelTypes.get(channelId) === pending) channelTypes.delete(channelId);
			});
		}
		return known;
	};

	const notify = createNotifier({
		runtimes,
		discord,
		store,
		planeUrl: config.planeUrl,
		channelType,
		log,
	});
	const queue = new SerialQueue({
		log: ({ event, ...rest }) =>
			log({ event, level: event === 'job.dropped' ? 'error' : 'warn', ...rest }),
	});
	// An event becomes one "expand" job: the Plane lookups (retried as a whole), then every send as its own job.
	const enqueue = (event: PlaneEvent) =>
		queue.push(`expand:${event.eventKey}`, async () => {
			for (const delivery of await notify(event)) queue.push(delivery.label, delivery.run);
		});

	const interactions = createInteractionHandler({
		publicKey: config.discord.publicKey,
		runtimesByGuild,
		discord,
		store,
		planeUrl: config.planeUrl,
		projectsCached: (tenantId) => runtimes.get(tenantId)?.projectsCached() ?? null,
		log,
		now,
		// A timer, not a microtask: the work must start after the type 5 response is written.
		defer: (work) => {
			setTimeout(() => {
				work().catch((error: unknown) =>
					log({ event: 'ix.defer_failed', level: 'error', error: errorName(error) }),
				);
			}, 0);
		},
	});
	const handler = createHandler({
		tenantsByWorkspace: new Map(config.tenants.map((t) => [t.workspaceId, t])),
		store,
		enqueue,
		interactions,
		config,
		log,
		now,
	});

	const server = Bun.serve({
		port: options.listenPort ?? config.port,
		development: false,
		maxRequestBodySize: MAX_REQUEST_BODY,
		idleTimeout: IDLE_TIMEOUT_S,
		fetch: handler,
		error(error) {
			log({ event: 'server.error', level: 'error', error: errorName(error) });
			return new Response('internal error', { status: 500 });
		},
	});

	// Startup waits for no network: warm-up (projects, the bot user) runs in the background and may fail.
	const warm = () => {
		for (const [tenant, runtime] of runtimes)
			runtime
				.warm()
				.catch((error: unknown) =>
					log({ event: 'warm.failed', level: 'warn', tenant, error: errorName(error) }),
				);
	};
	warm();
	const cancel = [
		every(warm, WARM_MS),
		every(() => {
			checkSilence({
				tenants: config.tenants,
				store,
				discord,
				log,
				now: now(),
				startedAt,
			}).catch((error: unknown) =>
				log({ event: 'watchdog.failed', level: 'error', error: errorName(error) }),
			);
		}, SILENCE_CHECK_MS),
		every(() => {
			try {
				store.prune(KEEP_SEEN_MS, now());
			} catch (error) {
				log({ event: 'prune.failed', level: 'error', error: errorName(error) });
			}
		}, PRUNE_MS),
	];

	log({ event: 'listening', port: server.port ?? 0, tenants: describeTenants(config) });

	return {
		port: server.port ?? 0,
		config,
		idle: () => queue.idle(),
		async stop() {
			for (const stopTimer of cancel) stopTimer();
			await server.stop();
			// Jobs in flight get a few seconds; the rest is lost (the queue is in memory by design).
			await Promise.race([queue.idle(), Bun.sleep(DRAIN_MS)]);
			store.close();
		},
	};
}

function main(): void {
	// A rejection nobody awaits must not kill the process: log it and carry on.
	const sink = jsonLog();
	process.on('unhandledRejection', (reason) => {
		try {
			sink({ event: 'unhandled.rejection', level: 'error', error: errorName(reason) });
		} catch {
			// nothing else to do with a broken log
		}
	});
	let service: Service;
	try {
		service = startService(process.env);
	} catch (error) {
		// loadConfig names env vars and JSON paths, never values.
		process.stderr.write(`${error instanceof Error ? error.message : 'startup failed'}\n`);
		process.exit(1);
	}
	const shutdown = () => {
		service
			.stop()
			.catch(() => {})
			.finally(() => process.exit(0));
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
}

if (import.meta.main) main();
