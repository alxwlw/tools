// Adapted from apps/plane-miro/src/index.ts.
import type { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { botTokenAuth, type Fetch } from '@alxwlw/plane-app';

import { type Config, loadConfig, PLANE_SCOPES, type TenantConfig } from './config.ts';
import { jsonLog, type Log } from './log.ts';
import { PlaneClient, type PlaneReader } from './plane/client.ts';
import type { PlaneEvent } from './plane/webhook.ts';
import { SerialQueue } from './queue.ts';
import { createHandler } from './server.ts';
import { Store } from './store.ts';
import { acceptRun, createRefresher, nextReconcileAt, reconcile, type SyncDeps } from './sync.ts';
import { checkHealth, newWatchdogState } from './watchdog.ts';
import { buildWeb } from './web.ts';

const MINUTE_MS = 60_000;
const HEALTH_CHECK_MS = 15 * MINUTE_MS;
const PRUNE_MS = 60 * MINUTE_MS;
const KEEP_SEEN_MS = 30 * 24 * 60 * MINUTE_MS;
/** An early reconcile waits until this long after the previous one finished. */
const MIN_RECONCILE_GAP_MS = 10 * MINUTE_MS;
/** Above MAX_PLANE_BODY, so an oversized delivery gets our 200 + log line instead of Bun's own 413. */
const MAX_REQUEST_BODY = 8 * 1024 * 1024;
/**
 * Seconds Bun waits on an idle connection: a stalled body must not hold a request for ever.
 * Body bytes do not reset the timer (measured for plane-miro on Bun 1.4.2), so no separate body deadline is needed.
 */
const IDLE_TIMEOUT_S = 10;
const DRAIN_MS = 10_000;

export type Service = {
	port: number;
	config: Config;
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
	/** Shutdown wait for jobs in flight, ms (default 10 s). */
	drainMs?: number;
	/** Runs `tick` every `ms`; returns the canceller. Tests drive the ticks by hand. */
	every?: (tick: () => void, ms: number) => () => void;
	/** Runs `fire` once after `ms`; returns the canceller. The reconcile timers use it; tests fire them by hand. */
	after?: (fire: () => void, ms: number) => () => void;
	/** Tests: Plane in memory instead of the real client. */
	plane?: (tenant: TenantConfig) => PlaneReader;
	/** Default: <app>/web. */
	webDir?: string;
};

/** The production `every`: a real interval; the returned function cancels it. */
export function intervalEvery(tick: () => void, ms: number): () => void {
	const timer = setInterval(tick, ms);
	return () => clearInterval(timer);
}

/** The production `after`: a real timeout; the returned function cancels it. */
export function timeoutAfter(fire: () => void, ms: number): () => void {
	const timer = setTimeout(fire, ms);
	return () => clearTimeout(timer);
}

/** The error's class name is all a log line gets: messages of failed calls may quote payloads. */
const errorName = (error: unknown): string => {
	try {
		return error instanceof Error ? error.name : 'unknown';
	} catch {
		return 'unknown';
	}
};

/**
 * One reconcile timer per tenant. A reconcile always runs as a job of the tenant's queue (never beside it), and
 * after each one the next is at `nextReconcileAt`: 03:00 UTC after a success, 10 minutes after a failure.
 * `request` (an item refresh found the copy stale) pulls the next one forward to the 10-minute mark after the
 * last finish; it does nothing while a reconcile is queued or running.
 */
function reconcileTimer(o: {
	tenant: string;
	deps: SyncDeps;
	queue: SerialQueue;
	log: Log;
	now: () => number;
	after: (fire: () => void, ms: number) => () => void;
}) {
	let cancel: (() => void) | null = null;
	let nextAt = Number.POSITIVE_INFINITY;
	let busy = false;
	let lastFinish: number | null = null;
	let stopped = false;

	function arm(at: number): void {
		cancel?.();
		nextAt = at;
		cancel = o.after(fire, Math.max(0, at - o.now()));
	}

	function fire(): void {
		cancel = null;
		nextAt = Number.POSITIVE_INFINITY;
		run();
	}

	function run(): void {
		if (busy || stopped) return;
		busy = true;
		try {
			o.queue.push(`reconcile:${o.tenant}`, async () => {
				let ok = false;
				try {
					ok = await reconcile(o.deps);
				} catch (error) {
					o.log({
						event: 'reconcile.failed',
						level: 'error',
						tenant: o.tenant,
						error: errorName(error),
					});
				} finally {
					// Every exit re-arms: a throw must not leave the tenant without a next reconcile.
					busy = false;
					lastFinish = o.now();
					if (!stopped) arm(nextReconcileAt(new Date(lastFinish), ok).getTime());
				}
			});
		} catch (error) {
			busy = false;
			o.log({
				event: 'reconcile.failed',
				level: 'error',
				tenant: o.tenant,
				error: errorName(error),
			});
			arm(o.now() + MIN_RECONCILE_GAP_MS);
		}
	}

	return {
		start: run,
		request(): void {
			if (busy || stopped) return;
			const at = Math.max(o.now(), (lastFinish ?? Number.NEGATIVE_INFINITY) + MIN_RECONCILE_GAP_MS);
			if (at < nextAt) arm(at);
		},
		stop(): void {
			stopped = true;
			cancel?.();
			cancel = null;
		},
	};
}

/** Throws on a bad config (loadConfig lists every problem) or a failed web build; otherwise returns a running service. */
export async function startService(
	env: Record<string, string | undefined>,
	options: ServiceOptions = {},
): Promise<Service> {
	const config = loadConfig(env, options.readFile ?? ((path) => readFileSync(path, 'utf8')));
	const webDir = options.webDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
	// Built before anything is opened: a build error leaves no store and no port behind.
	const assets = await buildWeb(webDir);
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
	const after = options.after ?? timeoutAfter;
	const startedAt = now();
	const store = new Store(config.dbPath);

	const queues: SerialQueue[] = [];
	const refreshers = new Map<string, (event: PlaneEvent) => void>();
	const syncDeps = new Map<string, SyncDeps>();
	const timers = new Map<string, ReturnType<typeof reconcileTimer>>();
	for (const tenant of config.tenants.values()) {
		const plane =
			options.plane?.(tenant) ??
			new PlaneClient({
				baseUrl: config.planeUrl,
				workspace: tenant.workspaceSlug,
				fetch: options.fetch,
				auth: botTokenAuth({
					planeUrl: config.planeUrl,
					clientId: tenant.clientId,
					clientSecret: tenant.planeSecret,
					appInstallationId: tenant.installationId,
					scopes: PLANE_SCOPES,
					fetch: options.fetch,
					now,
				}),
			});
		const queue = new SerialQueue({
			log: ({ event, ...rest }) =>
				log({
					event,
					level: event === 'job.dropped' ? 'error' : 'warn',
					tenant: tenant.id,
					...rest,
				}),
		});
		const deps: SyncDeps = {
			tenant: tenant.id,
			plane,
			store,
			log,
			now: () => new Date(now()),
			requestReconcile: () => timers.get(tenant.id)?.request(),
		};
		queues.push(queue);
		syncDeps.set(tenant.id, deps);
		refreshers.set(tenant.id, createRefresher(deps, queue));
		timers.set(tenant.id, reconcileTimer({ tenant: tenant.id, deps, queue, log, now, after }));
	}

	const handler = createHandler({
		config,
		store,
		log,
		now,
		assets,
		enqueue: (event) => refreshers.get(event.tenant)?.(event),
		acceptRun: (tenant, run) => {
			const deps = syncDeps.get(tenant);
			const refresh = refreshers.get(tenant);
			if (deps === undefined || refresh === undefined) return Promise.reject(new Error('tenant'));
			return acceptRun(deps, run, refresh);
		},
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

	const watchdog = newWatchdogState();
	const cancel = [
		every(() => {
			try {
				checkHealth({
					tenants: config.tenants.keys(),
					store,
					log,
					now: now(),
					startedAt,
					state: watchdog,
				});
			} catch (error) {
				log({ event: 'watchdog.failed', level: 'error', error: errorName(error) });
			}
		}, HEALTH_CHECK_MS),
		every(() => {
			try {
				store.prune(KEEP_SEEN_MS, now());
			} catch (error) {
				log({ event: 'prune.failed', level: 'error', error: errorName(error) });
			}
		}, PRUNE_MS),
	];

	log({
		event: 'listening',
		port: server.port ?? 0,
		tenants: [...config.tenants.keys()].map((id) => ({ id })),
	});
	for (const timer of timers.values()) timer.start();

	const idle = async (): Promise<void> => {
		await Promise.all(queues.map((q) => q.idle()));
	};
	return {
		port: server.port ?? 0,
		config,
		idle,
		async stop() {
			for (const stopTimer of cancel) stopTimer();
			for (const timer of timers.values()) timer.stop();
			// Not awaited: it resolves only when keep-alive connections close. New connections are refused at once.
			server.stop().catch(() => {});
			// Jobs in flight get a few seconds; the rest is lost (the queue is in memory by design).
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

/** The handler for `unhandledRejection`: logs the error class and carries on; a broken log changes nothing. */
export function logUnhandled(sink: Log): (reason: unknown) => void {
	return (reason) => {
		try {
			sink({ event: 'unhandled.rejection', level: 'error', error: errorName(reason) });
		} catch {
			// nothing else to do with a broken log
		}
	};
}

/** Wires the process-level handlers: a stray rejection is logged, SIGTERM and SIGINT shut down. */
export function installProcessHandlers(proc: EventEmitter, sink: Log, shutdown: () => void): void {
	// A rejection nobody awaits must not kill the process.
	proc.on('unhandledRejection', logUnhandled(sink));
	proc.on('SIGTERM', shutdown);
	proc.on('SIGINT', shutdown);
}

async function main(): Promise<void> {
	let service: Service | undefined;
	installProcessHandlers(process, jsonLog(), () => {
		(service?.stop() ?? Promise.resolve()).catch(() => {}).finally(() => process.exit(0));
	});
	try {
		service = await startService(process.env);
	} catch (error) {
		// loadConfig names env vars and JSON paths, never values; a build error names the file.
		process.stderr.write(`${error instanceof Error ? error.message : 'startup failed'}\n`);
		process.exit(1);
	}
}

if (import.meta.main) void main();
