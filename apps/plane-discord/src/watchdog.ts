import type { Tenant } from './config.ts';
import type { DiscordApi } from './discord/rest.ts';
import type { Log } from './log.ts';
import type { Store } from './store.ts';

const HOUR_MS = 3_600_000;

/**
 * Alerts when a tenant's Plane stays silent longer than `silenceHours`, and again when it comes back.
 * Plane's own webhook status is not readable with a bot token (403, design §10), so silence is all there is.
 * One tenant's failure never stops the others; a failed send is retried on the next tick.
 */
export async function checkSilence(deps: {
	tenants: readonly Tenant[];
	store: Store;
	discord: DiscordApi;
	log: Log;
	now: number;
	startedAt: number;
}): Promise<void> {
	const { store, discord, log, now } = deps;
	for (const tenant of deps.tenants) {
		try {
			const { lastEventAt, alertedAt } = store.silence(tenant.id);
			const say = async (content: string) => {
				if (tenant.serviceChannelId !== null)
					await discord.sendMessage(tenant.serviceChannelId, { content });
			};
			if (alertedAt !== null) {
				if (lastEventAt === null || lastEventAt <= alertedAt) continue;
				await say('Plane снова на связи');
				log({ event: 'plane.alive', tenant: tenant.id });
				store.markAlerted(tenant.id, null);
				continue;
			}
			// A tenant that never got an event is counted from the start, so a restart does not alert at once.
			const quiet = now - (lastEventAt ?? deps.startedAt);
			if (quiet <= tenant.silenceHours * HOUR_MS) continue;
			const hours = Math.floor(quiet / HOUR_MS);
			await say(
				`Plane молчит ${hours} ч (${tenant.workspace}): проверь вебхук — runbook plane-discord`,
			);
			log({ event: 'plane.silent', level: 'error', tenant: tenant.id, hours });
			store.markAlerted(tenant.id, now);
		} catch (error) {
			// Error text stays out: a Discord failure carries status and code only, but the sink is a log.
			log({
				event: 'watchdog.failed',
				level: 'error',
				tenant: tenant.id,
				error: error instanceof Error ? error.name : 'unknown',
			});
		}
	}
}
