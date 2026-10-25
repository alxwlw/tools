// Slash commands: `/plane KEY` (phase 2) and `/plane-link KEY` (phase 3). Built on the handler's own deps.
import { workItemCard } from '../card.ts';
import type { Log } from '../log.ts';
import type { TenantRuntime } from '../notify.ts';
import { workItemUrl } from '../text.ts';
import { PLANE_KEY_OPTION } from './commands.ts';
import type { InteractionDeps } from './interactions.ts';
import {
	describe,
	failedEntry,
	Failure,
	isHidden,
	isThreadType,
	json,
	KEY_MAX,
	KEY_RE,
	keyOf,
	mdLabel,
	own,
	type Rec,
	rec,
	REPLY,
	snowflake,
	str,
} from './ix-common.ts';
import { DiscordApiError } from './rest.ts';

const UNKNOWN_ASSIGNEE = 'кто-то';
const TEXT = {
	broken: 'Не удалось разобрать запрос Discord.',
	noChannel: 'Не удалось определить канал.',
	notThread: 'Команда работает в треде.',
	badKey: 'Нужен ключ вида LAB-40.',
} as const;

export type SlashEnv = {
	deps: InteractionDeps;
	now: () => number;
	defer: (work: () => Promise<void>) => void;
	log: Log;
	refuse: (
		tenantId: string | undefined,
		interaction: string,
		reason: string,
		text: string,
	) => Response;
};

export function createSlashCommands(env: SlashEnv): {
	plane: (rt: TenantRuntime, ix: Rec, id: string, data: Rec) => Response;
	link: (rt: TenantRuntime, ix: Rec, id: string, data: Rec) => Response;
} {
	const { deps, now, defer, log, refuse } = env;

	const mdState = (name: string | undefined): string | null =>
		name === undefined ? null : mdLabel(name);

	/** `/plane KEY`: the public card, or a private note after the public placeholder is withdrawn. */
	async function runCard(rt: TenantRuntime, key: string, token: string): Promise<void> {
		const item = await rt.plane.getWorkItemByKey(key);
		// A hidden project answers like a missing one: a public card must not confirm its keys.
		if (item === null || isHidden(rt, item.projectId))
			throw new Failure(`Задача ${key} не найдена`);
		let states = await rt.states(item.projectId);
		// A state created after the cache was filled: ask again, as notify does.
		if (!states.some((s) => s.id === item.stateId))
			states = await rt.states(item.projectId, { refresh: true });
		// Names are fetched only when somebody is not in the user table.
		let members: Awaited<ReturnType<TenantRuntime['members']>> | null = null;
		const assignees: string[] = [];
		for (const planeId of item.assignees) {
			const discordId = rt.users.toDiscord(planeId);
			if (discordId !== null) {
				assignees.push(`<@${discordId}>`);
				continue;
			}
			members ??= await rt.members();
			const name = members.find((m) => m.id === planeId)?.displayName ?? '';
			// Discord renders markdown and masked links in embed field values.
			assignees.push(name === '' ? UNKNOWN_ASSIGNEE : mdLabel(name));
		}
		const card = workItemCard({
			key,
			url: workItemUrl(deps.planeUrl, rt.tenant.workspace, key),
			name: item.name,
			stateName: mdState(states.find((s) => s.id === item.stateId)?.name),
			assignees,
			priority: item.priority,
		});
		await deps.discord.editOriginal(token, { content: '', embeds: [card] });
	}

	/** The public placeholder is withdrawn; the explanation is private. */
	async function withdraw(
		token: string,
		base: Record<string, string>,
		text: string,
	): Promise<void> {
		try {
			await deps.discord.deleteOriginal(token);
		} catch {
			log({ event: 'ix.cleanup_failed', level: 'warn', ...base });
		}
		try {
			await deps.discord.followup(token, { content: text, ephemeral: true });
		} catch {
			log({ event: 'ix.reply_failed', level: 'error', ...base });
		}
	}

	function plane(rt: TenantRuntime, ix: Rec, id: string, data: Rec): Response {
		const options = Array.isArray(data.options) ? data.options : [];
		const option = options.map(rec).find((o) => own(o, 'name') === PLANE_KEY_OPTION);
		const raw = own(option ?? null, 'value');
		const key = (typeof raw === 'string' ? raw : '').trim().toUpperCase();
		const token = str(ix.token);
		if (key.length > KEY_MAX || !KEY_RE.test(key))
			return refuse(rt.tenant.id, id, 'bad_key', 'Нужен ключ вида LAB-40.');
		if (token === null) return refuse(rt.tenant.id, id, 'no_token', TEXT.broken);
		const started = now();
		defer(async () => {
			const base = { tenant: rt.tenant.id, interaction: id, kind: 'card' };
			try {
				await runCard(rt, key, token);
				log({ event: 'ix.done', ...base, ms: now() - started });
			} catch (error) {
				const missing = error instanceof Failure;
				// Missing and hidden keys share one outcome, as they share one answer.
				if (missing) log({ event: 'ix.done', ...base, result: 'not_found', ms: now() - started });
				else log(failedEntry(base, error, now() - started));
				await withdraw(
					token,
					base,
					missing ? `${error.message}.` : `Не получилось: ${describe(error)}.`,
				);
			}
		});
		// No ephemeral flag: the card is for the whole channel.
		return json({ type: REPLY.DEFERRED });
	}

	/** The key of the work item a thread is already bound to, or null when it cannot be told safely. */
	async function boundKey(
		rt: TenantRuntime,
		bound: { projectId: string | null; workItemId: string },
	): Promise<string | null> {
		// A hidden project's key is not shown, even in a private reply.
		if (bound.projectId === null || isHidden(rt, bound.projectId)) return null;
		try {
			const other = await rt.plane.getWorkItem(bound.projectId, bound.workItemId);
			return await keyOf(rt, other.projectId, other.sequenceId);
		} catch {
			return null;
		}
	}

	/** `/plane-link KEY`: binds the thread to a work item; a refusal is private, the confirmation public. */
	async function runLink(
		rt: TenantRuntime,
		key: string,
		thread: { id: string; parentId: string },
		token: string,
		base: Record<string, string>,
	): Promise<string> {
		const item = await rt.plane.getWorkItemByKey(key);
		// A hidden project answers like a missing one: its keys are not confirmed from Discord.
		if (item === null || isHidden(rt, item.projectId)) {
			await withdraw(token, base, `Задача ${key} не найдена.`);
			return 'not_found';
		}
		const bound = deps.store.findByThread(thread.id);
		if (bound !== null && bound.workItemId !== item.id) {
			const otherKey = await boundKey(rt, bound);
			await withdraw(
				token,
				base,
				otherKey === null
					? 'Тред уже привязан к другой задаче.'
					: `Тред уже привязан к ${otherKey}.`,
			);
			return 'already_linked';
		}
		// A private thread's messages reach only its members, and a slash command does not make the bot one.
		try {
			await deps.discord.joinThread(thread.id);
		} catch (error) {
			if (!(error instanceof DiscordApiError)) throw error;
			log({
				event: 'ix.join_failed',
				level: 'warn',
				...base,
				status: error.status,
				code: error.code ?? undefined,
			});
			await withdraw(token, base, 'Не могу войти в тред: добавь @Plane в тред и повтори.');
			return 'join_failed';
		}
		deps.store.putThread(rt.tenant.id, item.id, thread.parentId, thread.id, item.projectId);
		const text = `Тред привязан к [\`${key}\` «${mdLabel(item.name)}»](<${workItemUrl(deps.planeUrl, rt.tenant.workspace, key)}>).`;
		try {
			await deps.discord.editOriginal(token, { content: text });
		} catch (error) {
			// The binding stands (no rollback): the thread is told privately that it is bound.
			log({
				event: 'ix.confirm_failed',
				level: 'warn',
				...base,
				status: error instanceof DiscordApiError ? error.status : undefined,
				code: error instanceof DiscordApiError ? error.code : undefined,
			});
			try {
				await deps.discord.followup(token, { content: text, ephemeral: true });
			} catch {
				log({ event: 'ix.reply_failed', level: 'error', ...base });
			}
		}
		return 'linked';
	}

	function link(rt: TenantRuntime, ix: Rec, id: string, data: Rec): Response {
		const channel = rec(ix.channel);
		const type = channel?.type;
		const threadId = snowflake(channel?.id) ?? snowflake(ix.channel_id);
		const parentId = snowflake(channel?.parent_id);
		if (!isThreadType(type)) return refuse(rt.tenant.id, id, 'not_thread', TEXT.notThread);
		if (threadId === null || parentId === null)
			return refuse(rt.tenant.id, id, 'no_channel', TEXT.noChannel);
		const options = Array.isArray(data.options) ? data.options : [];
		const option = options.map(rec).find((o) => own(o, 'name') === PLANE_KEY_OPTION);
		const raw = own(option ?? null, 'value');
		const key = (typeof raw === 'string' ? raw : '').trim().toUpperCase();
		const token = str(ix.token);
		if (key.length > KEY_MAX || !KEY_RE.test(key))
			return refuse(rt.tenant.id, id, 'bad_key', TEXT.badKey);
		if (token === null) return refuse(rt.tenant.id, id, 'no_token', TEXT.broken);
		const started = now();
		defer(async () => {
			const base = { tenant: rt.tenant.id, interaction: id, kind: 'link' };
			try {
				const result = await runLink(rt, key, { id: threadId, parentId }, token, base);
				log({ event: 'ix.done', ...base, result, ms: now() - started });
			} catch (error) {
				log(failedEntry(base, error, now() - started));
				await withdraw(token, base, `Не получилось: ${describe(error)}.`);
			}
		});
		// No ephemeral flag: the confirmation is for the whole thread.
		return json({ type: REPLY.DEFERRED });
	}

	return { plane, link };
}
