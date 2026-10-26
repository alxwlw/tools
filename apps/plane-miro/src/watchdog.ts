// Adapted from apps/plane-discord/src/watchdog.ts (silence rules); the Miro token check is new.
import type { Log } from './log.ts';
import { MiroNotConnected } from './miro/rest.ts';
import type { TenantRuntime } from './runtime.ts';
import type { Store } from './store.ts';

const HOUR_MS = 3_600_000;

/** The error's class name is all a log line gets: messages of failed calls may quote payloads. */
const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

/**
 * Per tenant: Plane silence (log only) and the Miro service token. One tenant's failure never stops the others.
 * Plane's own webhook status is not readable with a bot token (403, design §10), so silence is all there is.
 */
export async function checkHealth(deps: {
	runtimes: ReadonlyMap<string, TenantRuntime>;
	store: Store;
	log: Log;
	now: number;
	startedAt: number;
	/** Previous token state per tenant (true: valid), owned by the caller between ticks. */
	tokenOk: Map<string, boolean>;
}): Promise<void> {
	for (const [id, runtime] of deps.runtimes) {
		try {
			checkSilence(deps, id, runtime.tenant.silenceHours);
			await checkToken(deps, id, runtime);
		} catch (error) {
			deps.log({ event: 'watchdog.failed', level: 'error', tenant: id, error: errorName(error) });
		}
	}
}

function checkSilence(
	deps: { store: Store; log: Log; now: number; startedAt: number },
	tenant: string,
	silenceHours: number,
): void {
	const { store, log, now } = deps;
	const { lastEventAt, alertedAt } = store.silence(tenant);
	if (alertedAt !== null) {
		if (lastEventAt === null || lastEventAt <= alertedAt) return;
		log({ event: 'plane.alive', tenant });
		store.markAlerted(tenant, null);
		return;
	}
	// A tenant that never got an event is counted from the start, so a restart does not alert at once.
	const quiet = now - (lastEventAt ?? deps.startedAt);
	if (quiet <= silenceHours * HOUR_MS) return;
	log({ event: 'plane.silent', level: 'error', tenant, hours: Math.floor(quiet / HOUR_MS) });
	store.markAlerted(tenant, now);
}

/** Logs on a change of state only; a network error leaves the state as it was and goes to the caller. */
async function checkToken(
	deps: { log: Log; tokenOk: Map<string, boolean> },
	tenant: string,
	runtime: TenantRuntime,
): Promise<void> {
	let ok: boolean;
	let event = 'miro.token_invalid';
	try {
		ok = await runtime.miro.tokenValid();
	} catch (error) {
		if (!(error instanceof MiroNotConnected)) throw error;
		ok = false;
		event = 'miro.not_connected';
	}
	const before = deps.tokenOk.get(tenant);
	if (ok) {
		if (before === false) deps.log({ event: 'miro.token_ok', tenant });
	} else if (before !== false) deps.log({ event, level: 'error', tenant });
	deps.tokenOk.set(tenant, ok);
}
