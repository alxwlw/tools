// Messages of a thread bound to a work item become Plane comments (design §3 «Этап 3», Discord → Plane).
// Edits and deletions are not synced (design §9). Logs carry ids and reasons, never message text.
import type { GatewayMessage } from './discord/gateway.ts';
import { attachmentsHtml, isHidden, messageLinkHtml } from './discord/ix-common.ts';
import { esc, truncate } from './html.ts';
import type { Log } from './log.ts';
import type { TenantRuntime } from './notify.ts';
import { PlaneApiError } from './plane/client.ts';
import type { Store } from './store.ts';
import { discordToPlaneHtml, planeMentionHtml } from './text.ts';

const SOURCE = 'discord';
/** Message types worth a comment: DEFAULT and REPLY. */
const COMMENTED_TYPES: ReadonlySet<number> = new Set([0, 19]);
const TEXT_MAX = 4000;
const NAME_MAX = 80;

export function createThreadSync(deps: {
	runtimes: ReadonlyMap<string, TenantRuntime>;
	store: Store;
	applicationId: string;
	log: Log;
}): (message: GatewayMessage) => Promise<void> {
	const { runtimes, store, applicationId, log } = deps;

	/** Rows written before `project_id` existed: find the project by asking each for the item. */
	async function resolveProject(rt: TenantRuntime, workItemId: string): Promise<string | null> {
		for (const project of await rt.projects()) {
			try {
				await rt.plane.getWorkItem(project.id, workItemId);
				return project.id;
			} catch (error) {
				if (!(error instanceof PlaneApiError && error.status === 404)) throw error;
			}
		}
		return null;
	}

	return async (message) => {
		const link = store.findByThread(message.channelId);
		if (link === null) return;
		if (
			message.applicationId === applicationId ||
			message.author.id === applicationId ||
			(message.webhookId !== null && store.isOwnWebhook(message.webhookId)) ||
			!COMMENTED_TYPES.has(message.type)
		)
			return;
		const ids = { tenant: link.tenant, thread: message.channelId, message: message.id };
		const rt = runtimes.get(link.tenant);
		if (rt === undefined) {
			log({ event: 'sync.skipped', level: 'warn', ...ids, reason: 'no_tenant' });
			return;
		}
		if (message.content.trim() === '' && message.attachments.length === 0) {
			// What a Gateway without MESSAGE_CONTENT delivers.
			log({ event: 'sync.empty', level: 'warn', ...ids });
			return;
		}

		let projectId = link.projectId;
		if (projectId === null) {
			projectId = await resolveProject(rt, link.workItemId);
			if (projectId === null) {
				log({ event: 'sync.unresolved', level: 'warn', ...ids, item: link.workItemId });
				return;
			}
			// Same primary key and thread id, so this only fills in the project; threads rows are never deleted.
			store.putThread(link.tenant, link.workItemId, link.channelId, message.channelId, projectId);
		}
		if (isHidden(rt, projectId)) {
			// Discord text must not reach Plane (and so SLU) from a hidden project.
			log({ event: 'sync.skipped', ...ids, reason: 'hidden' });
			return;
		}

		const started = Date.now();
		const dup = await rt.plane.findCommentByExternalId(
			projectId,
			link.workItemId,
			SOURCE,
			message.id,
		);
		if (dup !== null) {
			log({ event: 'sync.duplicate', ...ids });
			return;
		}
		const names = new Map(message.mentions.map((m) => [m.id, truncate(m.name, NAME_MAX)]));
		const person = (discordId: string, fallback: string): string => {
			const planeId = rt.users.toPlane(discordId);
			return planeId !== null ? planeMentionHtml(planeId) : esc(fallback);
		};
		const text = truncate(message.content.trim(), TEXT_MAX);
		const html =
			`<p><strong>${person(message.author.id, truncate(message.author.name, NAME_MAX))}</strong> (Discord):</p>` +
			(text === ''
				? ''
				: discordToPlaneHtml(text, (id) => person(id, names.get(id) ?? 'пользователь'))) +
			attachmentsHtml(message.attachments) +
			`<p>${messageLinkHtml(message.guildId ?? rt.tenant.guildId, message.channelId, message.id, 'сообщение')}</p>`;
		const result = await rt.plane.createComment(projectId, link.workItemId, {
			comment_html: html,
			external_id: message.id,
			external_source: SOURCE,
		});
		log({
			event: 'sync.done',
			...ids,
			created: result.created,
			ms: Date.now() - started,
		});
	};
}
