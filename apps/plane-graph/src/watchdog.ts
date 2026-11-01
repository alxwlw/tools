// Adapted from apps/plane-miro/src/watchdog.ts (silence rules); the stale-sync check is new.
import type { Log } from './log.ts';
import type { Store } from './store.ts';

const HOUR_MS = 3_600_000;
/** A tenant without a delivery for longer than this is silent (plane-miro's default). */
export const SILENCE_HOURS = 72;
/** The daily reconcile runs every 24 h; two missed hours of slack, then the copy counts as stale. */
export const STALE_SYNC_HOURS = 26;
const STALE_ALERT_EVERY_MS = 24 * HOUR_MS;

/** State between ticks, owned by the caller; it lives in memory, so a restart may repeat an alert. */
export type WatchdogState = {
	/** Tenant -> when `plane.silent` was logged; absent: no alert is open. */
	silentAt: Map<string, number>;
	/** Tenant -> when `watchdog.stale_sync` was last logged. */
	staleAt: Map<string, number>;
};
export const newWatchdogState = (): WatchdogState => ({
	silentAt: new Map(),
	staleAt: new Map(),
});

/** The error's class name is all a log line gets: messages of failed calls may quote payloads. */
const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

/**
 * Per tenant: webhook silence and the age of the last successful reconcile (log lines only).
 * One tenant's failure never stops the others.
 */
export function checkHealth(deps: {
	tenants: Iterable<string>;
	store: Store;
	log: Log;
	now: number;
	startedAt: number;
	state: WatchdogState;
}): void {
	for (const id of deps.tenants) {
		try {
			checkSilence(deps, id);
			checkStaleSync(deps, id);
		} catch (error) {
			deps.log({ event: 'watchdog.failed', level: 'error', tenant: id, error: errorName(error) });
		}
	}
}

function checkSilence(
	deps: { store: Store; log: Log; now: number; startedAt: number; state: WatchdogState },
	tenant: string,
): void {
	const { store, log, now, state } = deps;
	const lastEventAt = store.lastEventAt(tenant);
	const alertedAt = state.silentAt.get(tenant);
	if (alertedAt !== undefined) {
		if (lastEventAt === null || lastEventAt <= alertedAt) return;
		log({ event: 'plane.alive', tenant });
		state.silentAt.delete(tenant);
		return;
	}
	// A tenant that never got an event is counted from the start, so a restart does not alert at once.
	const quiet = now - (lastEventAt ?? deps.startedAt);
	if (quiet <= SILENCE_HOURS * HOUR_MS) return;
	log({ event: 'plane.silent', level: 'error', tenant, hours: Math.floor(quiet / HOUR_MS) });
	state.silentAt.set(tenant, now);
}

function checkStaleSync(
	deps: { store: Store; log: Log; now: number; startedAt: number; state: WatchdogState },
	tenant: string,
): void {
	const { store, log, now, state } = deps;
	// A copy that was never synced is counted from the start, like a tenant without events.
	const parsed = Date.parse(store.copy(tenant).syncedAt ?? '');
	const last = Number.isNaN(parsed) ? deps.startedAt : parsed;
	const age = now - last;
	if (age <= STALE_SYNC_HOURS * HOUR_MS) return;
	const alertedAt = state.staleAt.get(tenant);
	if (alertedAt !== undefined && now - alertedAt < STALE_ALERT_EVERY_MS) return;
	log({
		event: 'watchdog.stale_sync',
		level: 'error',
		tenant,
		hours: Math.floor(age / HOUR_MS),
	});
	state.staleAt.set(tenant, now);
}
