// Adapted from apps/plane-discord/src/index.ts.
import type { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApi } from './api.ts';
import { type Config, loadConfig, type Tenant } from './config.ts';
import { handleCommentLinks, handleLinkCreated } from './links.ts';
import { jsonLog, type Log } from './log.ts';
import { verifyIdToken } from './miro/jwt.ts';
import { miroOauthHandler } from './miro/oauth.ts';
import type { Fetch } from './plane/auth.ts';
import type { PlaneEvent } from './plane/webhook.ts';
import { SerialQueue } from './queue.ts';
import { createRuntime, type TenantRuntime } from './runtime.ts';
import { createHandler } from './server.ts';
import { Store } from './store.ts';
import { disableWorkItem, syncWorkItem } from './sync.ts';
import { checkHealth } from './watchdog.ts';
import { buildWeb, createWeb } from './web.ts';

const MINUTE_MS = 60_000;
const HEALTH_CHECK_MS = 15 * MINUTE_MS;
const PRUNE_MS = 24 * 60 * MINUTE_MS;
const KEEP_SEEN_MS = 30 * 24 * 60 * MINUTE_MS;
/** Above MAX_PLANE_BODY, so an oversized delivery gets our 200 + log line instead of Bun's own 413. */
const MAX_REQUEST_BODY = 8 * 1024 * 1024;
/**
 * Seconds Bun waits on an idle connection: a stalled body must not hold a request for ever.
 * Measured on Bun 1.4.2: body bytes do not reset the timer, so even a slow drip is cut after
 * about IDLE_TIMEOUT_S + 2 s; no separate body-read deadline is needed.
 */
const IDLE_TIMEOUT_S = 10;
const DRAIN_MS = 10_000;
/**
 * Convert and bind may wait minutes on the Plane rate limiter: the idle timeout is lifted for them (see `longCall`).
 * Measured on Bun 1.4.2: a handler still running is not cut by `idleTimeout` anyway, so this guards a version that does.
 */
const LONG_ROUTES: readonly string[] = ['/miro/api/convert', '/miro/api/bind'];
const BEARER = /^Bearer (\S+)$/;

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
	/** Shutdown wait for jobs in flight, ms (default 10 s). */
	drainMs?: number;
	/** Runs `tick` every `ms`; returns the canceller. Tests drive the ticks by hand. */
	every?: (tick: () => void, ms: number) => () => void;
	/** Tests: a runtime with FakePlane/FakeMiro instead of the real clients. */
	runtimeFor?: (tenant: Tenant, store: Store) => TenantRuntime;
	/** Default: <app>/web. */
	webDir?: string;
	/** Bun's idle timeout in seconds (default 10); tests shorten it to show that convert and bind outlive it. */
	idleTimeoutS?: number;
};

/** The production `every`: a real interval; the returned function cancels it. */
export function intervalEvery(tick: () => void, ms: number): () => void {
	const timer = setInterval(tick, ms);
	return () => clearInterval(timer);
}

/** The error's class name is all a log line gets: messages of failed calls may quote payloads. */
const errorName = (error: unknown): string => {
	try {
		return error instanceof Error ? error.name : 'unknown';
	} catch {
		return 'unknown';
	}
};

/** Throws on a bad config (loadConfig lists every problem) or a failed web build; otherwise returns a running service. */
export async function startService(
	env: Record<string, string | undefined>,
	options: ServiceOptions = {},
): Promise<Service> {
	const config = loadConfig(env, options.readFile ?? ((path) => readFileSync(path, 'utf8')));
	const webDir = options.webDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
	// Built before anything is opened: a build error leaves no store and no port behind.
	const web = createWeb(webDir, await buildWeb(webDir));
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
	const store = new Store(config.dbPath);
	const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));

	const runtimes = new Map<string, TenantRuntime>();
	for (const tenant of config.tenants)
		runtimes.set(
			tenant.id,
			options.runtimeFor?.(tenant, store) ??
				createRuntime(tenant, { planeUrl: config.planeUrl, store, fetch: options.fetch, now }),
		);

	const queue = new SerialQueue({
		log: ({ event, ...rest }) =>
			log({ event, level: event === 'job.dropped' ? 'error' : 'warn', ...rest }),
	});
	const job = (event: PlaneEvent, runtime: TenantRuntime): (() => Promise<void>) => {
		switch (event.kind) {
			case 'workitem.changed':
				return () => syncWorkItem(runtime, store, event, log);
			case 'workitem.deleted':
				return () => disableWorkItem(runtime, store, event, log);
			case 'comment.created':
				return () => handleCommentLinks(runtime, store, event, log);
			case 'link.created':
				return () => handleLinkCreated(runtime, store, event, log);
		}
	};
	// The label carries no work item id: it reaches the log on a retry or a drop.
	const enqueue = (event: PlaneEvent) => {
		const runtime = runtimes.get(event.tenant);
		if (runtime !== undefined) queue.push(`${event.kind}:${event.tenant}`, job(event, runtime));
	};

	const nowSec = () => Math.floor(now() / 1000);
	const handler = createHandler({
		tenantsByWorkspace: new Map(config.tenants.map((t) => [t.workspaceId, t])),
		store,
		enqueue,
		config,
		miroOauth: miroOauthHandler({ config, store, fetch: doFetch, log, now }),
		api: createApi({ config, runtimes, store, log, nowSec }),
		web,
		log,
		now,
	});

	/** A signed-in front's convert or bind: only these may outlive the idle timeout, so an anonymous stalled body cannot.
	 * The API also answers 401/403/405 before it reads a body, which keeps an anonymous stalled body under the timeout. */
	const longCall = (req: Request): boolean => {
		if (req.method !== 'POST' || !LONG_ROUTES.includes(new URL(req.url).pathname)) return false;
		const token = BEARER.exec(req.headers.get('authorization') ?? '')?.[1];
		return (
			token !== undefined && verifyIdToken(token, { ...config.miro, nowSec: nowSec() }) !== null
		);
	};

	const idleTimeoutS = options.idleTimeoutS ?? IDLE_TIMEOUT_S;
	const server = Bun.serve({
		port: options.listenPort ?? config.port,
		development: false,
		maxRequestBodySize: MAX_REQUEST_BODY,
		idleTimeout: idleTimeoutS,
		async fetch(req, srv) {
			if (!longCall(req)) return handler(req);
			srv.timeout(req, 0);
			try {
				return await handler(req);
			} finally {
				// The connection may stay open for the next request: it goes back under the normal timeout.
				srv.timeout(req, idleTimeoutS);
			}
		},
		error(error) {
			log({ event: 'server.error', level: 'error', error: errorName(error) });
			return new Response('internal error', { status: 500 });
		},
	});

	const tokenOk = new Map<string, boolean>();
	const cancel = [
		every(() => {
			checkHealth({ runtimes, store, log, now: now(), startedAt, tokenOk }).catch(
				(error: unknown) =>
					log({ event: 'watchdog.failed', level: 'error', error: errorName(error) }),
			);
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
		tenants: config.tenants.map((t) => ({ id: t.id })),
	});

	return {
		port: server.port ?? 0,
		config,
		idle: () => queue.idle(),
		async stop() {
			for (const stopTimer of cancel) stopTimer();
			// Not awaited: it resolves only when keep-alive connections close. New connections are refused at once.
			server.stop().catch(() => {});
			// Jobs in flight get a few seconds; the rest is lost (the queue is in memory by design).
			let giveUp: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				queue.idle(),
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
