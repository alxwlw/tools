// Adapted from apps/plane-miro/src/index.ts.
import type { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import type { Fetch } from '@alxwlw/plane-app';

import { INPUT_NAMES, loadServiceConfig, type ServiceConfig } from './config.ts';
import { describeError, jsonLog, type Log } from './log.ts';
import { createRuntimes, type RuntimeDeps } from './runtime.ts';
import { createHandler, MAX_BODY_BYTES, text } from './server.ts';
import { DEFAULT_DB, Store } from './store.ts';
import { checkHealth, watchdogState } from './watchdog.ts';

const MINUTE_MS = 60_000;
const HEALTH_CHECK_MS = 15 * MINUTE_MS;
const PRUNE_MS = 24 * 60 * MINUTE_MS;
const DRAIN_MS = 10_000;
/**
 * Grafana batches are handled while the sender waits, and a batch may wait minutes on the Plane rate limit.
 * 240 (max 255) keeps such a request from being cut; GitHub deliveries are answered at once anyway.
 */
const IDLE_TIMEOUT_S = 240;

export type Service = {
	port: number;
	config: ServiceConfig;
	/** Resolves when every tenant's queue is empty (tests, shutdown). */
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
	/** Shutdown wait for jobs in flight, ms (default 10 s); the rest stays pending in the inbox. */
	drainMs?: number;
	/** Runs `tick` every `ms`; returns the canceller. Tests drive the ticks by hand. */
	every?: (tick: () => void, ms: number) => () => void;
	/** Tests: Plane and GitHub doubles. */
	runtime?: Pick<RuntimeDeps, 'plane' | 'githubApp' | 'sleep'>;
};

/** The production `every`: a real interval; the returned function cancels it. */
export function intervalEvery(tick: () => void, ms: number): () => void {
	const timer = setInterval(tick, ms);
	return () => clearInterval(timer);
}

/** Throws on a bad config (loadServiceConfig lists every problem); otherwise returns a running service. */
export function startService(
	env: Record<string, string | undefined>,
	options: ServiceOptions = {},
): Service {
	const config = loadServiceConfig(env, options.readFile ?? ((path) => readFileSync(path, 'utf8')));
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
	const every = options.every ?? intervalEvery;
	const startedAt = now();
	const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
	const store = new Store(env.PLANE_HOOKS_DB?.trim() || DEFAULT_DB);
	const prune = () => {
		try {
			store.prune(new Date(now()).toISOString());
		} catch (error) {
			log({ event: 'prune.failed', level: 'error', error: describeError(error) });
		}
	};
	prune();
	// Resumes the deliveries a previous run left pending.
	const runtimes = createRuntimes(config, {
		store,
		log,
		fetch: options.fetch,
		now,
		...options.runtime,
	});
	const handler = createHandler({ config, runtimes, log, now, fetch: doFetch });

	const server = Bun.serve({
		port: options.listenPort ?? config.port,
		// Never Bun's development error page: it shows the message, source lines and paths to the sender.
		development: false,
		// The handler enforces the exact limit with a 413; this only stops absurd bodies earlier.
		maxRequestBodySize: MAX_BODY_BYTES * 2,
		idleTimeout: IDLE_TIMEOUT_S,
		async fetch(req) {
			try {
				return await handler(req);
			} catch (error) {
				log({ event: 'server.error', level: 'error', error: describeError(error) });
				return text(500, 'internal error');
			}
		},
	});

	const state = watchdogState();
	const cancel = [
		every(() => {
			checkHealth({ runtimes, log, now: now(), startedAt, state }).catch((error: unknown) =>
				log({ event: 'watchdog.failed', level: 'error', error: describeError(error) }),
			);
		}, HEALTH_CHECK_MS),
		every(prune, PRUNE_MS),
	];

	log({
		event: 'listening',
		port: server.port ?? 0,
		tenants: config.tenants.map((tenant) => ({
			id: tenant.id,
			inputs: [
				...(tenant.github.length > 0 ? ['github'] : []),
				...INPUT_NAMES.filter((input) => tenant.inputs[input] !== null),
			],
			apps: tenant.github.map((app) => app.name),
		})),
	});

	const idle = async () => {
		await Promise.all([...runtimes.tenants.values()].map((runtime) => runtime.queue.idle()));
	};
	return {
		port: server.port ?? 0,
		config,
		idle,
		async stop() {
			for (const stopTimer of cancel) stopTimer();
			// Not awaited: it resolves only when keep-alive connections close. New connections are refused at once.
			server.stop().catch(() => {});
			// Jobs in flight get a few seconds; what is left stays pending in the inbox for the next start.
			let giveUp: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				idle(),
				new Promise<void>((resolve) => {
					giveUp = setTimeout(resolve, options.drainMs ?? DRAIN_MS);
				}),
			]);
			clearTimeout(giveUp);
			store.close();
		},
	};
}

/** Wires the process-level handlers: a stray rejection is logged, SIGTERM and SIGINT shut down. */
export function installProcessHandlers(proc: EventEmitter, sink: Log, shutdown: () => void): void {
	// A rejection nobody awaits must not kill the process.
	proc.on('unhandledRejection', (reason: unknown) => {
		try {
			sink({ event: 'unhandled.rejection', level: 'error', error: describeError(reason) });
		} catch {
			// nothing else to do with a broken log
		}
	});
	proc.on('SIGTERM', shutdown);
	proc.on('SIGINT', shutdown);
}

function main(): void {
	let service: Service | undefined;
	installProcessHandlers(process, jsonLog(), () => {
		(service?.stop() ?? Promise.resolve()).catch(() => {}).finally(() => process.exit(0));
	});
	try {
		service = startService(process.env);
	} catch (error) {
		// loadServiceConfig names env vars and JSON paths, never values.
		process.stderr.write(`${error instanceof Error ? error.message : 'startup failed'}\n`);
		process.exit(1);
	}
}

if (import.meta.main) main();
