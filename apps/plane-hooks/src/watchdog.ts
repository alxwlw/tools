// Adapted from apps/plane-miro/src/watchdog.ts: silence per input, Plane access and GitHub App health.
import { PlaneAuthError } from '@alxwlw/plane-app';

import { SILENCE_INPUTS } from './config.ts';
import type { Log } from './log.ts';
import { PlaneApiError } from './plane.ts';
import type { Runtimes, TenantRuntime } from './runtime.ts';

const HOUR_MS = 3_600_000;

/** What the previous checks saw; owned by the caller between ticks. A line is logged only when it changes. */
export type WatchdogState = {
	/** tenant → the bot could list projects. */
	planeOk: Map<string, boolean>;
	/** App id → GET /app answered. */
	appOk: Map<number, boolean>;
	/** App id → the last window had failed deliveries. */
	deliveriesFailing: Map<number, boolean>;
	/** App id → end of the last window whose deliveries were counted (ms). */
	countedUntil: Map<number, number>;
	/** `<tenant>:<input>` of the inputs reported silent. */
	silent: Set<string>;
};

export function watchdogState(): WatchdogState {
	return {
		planeOk: new Map(),
		appOk: new Map(),
		deliveriesFailing: new Map(),
		countedUntil: new Map(),
		silent: new Set(),
	};
}

/** The error's class name is all a log line gets: messages of failed calls may quote paths with ids. */
const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

/**
 * Design §5 «Тихая смерть», run every 15 minutes: per tenant the silence of each input in `silenceHours` and the
 * bot's access to Plane; per GitHub App whether it still exists and whether GitHub failed to deliver to us.
 * Error lines only on a change of state, an `…_ok` / `input.alive` line on recovery. A check that fails for
 * another reason (Plane or GitHub down) is `watchdog.failed` and changes no state; one tenant or App never
 * stops the others.
 */
export async function checkHealth(deps: {
	runtimes: Runtimes;
	log: Log;
	now: number;
	startedAt: number;
	state: WatchdogState;
}): Promise<void> {
	for (const [id, runtime] of deps.runtimes.tenants) {
		checkSilence(deps, id, runtime);
		try {
			await checkPlane(deps, id, runtime);
		} catch (error) {
			deps.log({
				event: 'watchdog.failed',
				level: 'error',
				tenant: id,
				check: 'plane',
				error: errorName(error),
			});
		}
	}
	for (const [appId, { app, runtime }] of deps.runtimes.apps) {
		const tenant = runtime.tenant.id;
		const name = app.config.name;
		try {
			// A valid ISO time, never NaN: the first window starts at the service start.
			const since = new Date(deps.state.countedUntil.get(appId) ?? deps.startedAt).toISOString();
			const health = await app.health(since);
			changed(deps, deps.state.appOk, appId, health.appOk, {
				bad: { event: 'github.app_unreachable', level: 'error', tenant, app: name },
				good: { event: 'github.app_ok', tenant, app: name },
			});
			// An unreachable App counts no deliveries: its window stays open until it answers again.
			if (!health.appOk) continue;
			deps.state.countedUntil.set(appId, deps.now);
			changed(deps, deps.state.deliveriesFailing, appId, health.failed === 0, {
				bad: {
					event: 'github.deliveries_failed',
					level: 'error',
					tenant,
					app: name,
					failed: health.failed,
				},
				good: { event: 'github.deliveries_ok', tenant, app: name },
			});
		} catch (error) {
			deps.log({
				event: 'watchdog.failed',
				level: 'error',
				tenant,
				app: name,
				check: 'github',
				error: errorName(error),
			});
		}
	}
}

/** Logs `bad` when the state turns bad (or is bad on the first check), `good` when it turns good again. */
function changed<K>(
	deps: { log: Log },
	map: Map<K, boolean>,
	key: K,
	ok: boolean,
	lines: { bad: Parameters<Log>[0]; good: Parameters<Log>[0] },
): void {
	const before = map.get(key);
	if (!ok && before !== false) deps.log(lines.bad);
	if (ok && before === false) deps.log(lines.good);
	map.set(key, ok);
}

/** An input in `silenceHours` with no delivery for longer than that, counted from the start at the earliest. */
function checkSilence(
	deps: { log: Log; now: number; startedAt: number; state: WatchdogState },
	tenant: string,
	runtime: TenantRuntime,
): void {
	for (const input of SILENCE_INPUTS) {
		const hours = runtime.tenant.silenceHours[input];
		const off =
			input === 'github'
				? runtime.tenant.github.length === 0
				: runtime.tenant.inputs[input] === null;
		if (hours === undefined || off) continue;
		const key = `${tenant}:${input}`;
		const quiet = deps.now - Math.max(runtime.lastDelivery.get(input) ?? 0, deps.startedAt);
		if (quiet > hours * HOUR_MS) {
			if (deps.state.silent.has(key)) continue;
			deps.state.silent.add(key);
			deps.log({
				event: 'input.silent',
				level: 'error',
				tenant,
				input,
				hours: Math.floor(quiet / HOUR_MS),
			});
		} else if (deps.state.silent.delete(key)) {
			deps.log({ event: 'input.alive', tenant, input });
		}
	}
}

/** A bot that lost its installation or its project access fails here: 401/403 from Plane or from the token request. */
async function checkPlane(
	deps: { log: Log; state: WatchdogState },
	tenant: string,
	runtime: TenantRuntime,
): Promise<void> {
	let ok = true;
	try {
		await runtime.plane.listProjects();
	} catch (error) {
		if (!isAuthFailure(error)) throw error;
		ok = false;
	}
	changed(deps, deps.state.planeOk, tenant, ok, {
		bad: { event: 'plane.auth_failed', level: 'error', tenant },
		good: { event: 'plane.auth_ok', tenant },
	});
}

/**
 * 401/403 of a Plane call, or a token request Plane refused (4xx: a revoked installation, a wrong secret).
 * A token request that got no answer (PlaneAuthError 0) or a 5xx is Plane being down, not an auth failure.
 */
function isAuthFailure(error: unknown): boolean {
	if (error instanceof PlaneApiError) return error.status === 401 || error.status === 403;
	return error instanceof PlaneAuthError && error.status >= 400 && error.status < 500;
}
