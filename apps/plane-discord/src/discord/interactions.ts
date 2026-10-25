// Discord HTTP interactions: «message → work item», «add to work item» (design §3 «1c»), `/plane KEY` (phase 2)
// and `/plane-link KEY` (phase 3).
// Order of every request: signature over the raw bytes, then parse, then claim, then dispatch. A modal must open
// within 3 s (primary response, cache only); a form submit gets a deferred ephemeral reply and the work runs after it.
import { esc, truncate } from '../html.ts';
import type { Log } from '../log.ts';
import type { TenantRuntime } from '../notify.ts';
import { PlaneApiError, type ProjectSummary, type WorkItem } from '../plane/client.ts';
import { readBounded } from '../server.ts';
import type { Store } from '../store.ts';
import { discordToPlaneHtml, planeMentionHtml, titleFrom, workItemUrl } from '../text.ts';
import { APPEND_COMMAND, CREATE_COMMAND, PLANE_COMMAND, PLANE_LINK_COMMAND } from './commands.ts';
import {
	describe,
	ephemeral,
	failedEntry,
	FLAG_EPHEMERAL,
	isHidden,
	isThreadType,
	itemLink as linkTo,
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
import { CHANNEL, type DiscordApi, DiscordApiError } from './rest.ts';
import { createSlashCommands } from './slash.ts';
import { verifyDiscordRequest } from './verify.ts';

export type InteractionDeps = {
	publicKey: string;
	runtimesByGuild: ReadonlyMap<string, TenantRuntime>;
	discord: DiscordApi;
	store: Store;
	planeUrl: string;
	/** Synchronous: a modal must open within 3 s. null — the cache is cold. */
	projectsCached: (tenantId: string) => ProjectSummary[] | null;
	log: Log;
	now?: () => number;
	nonce?: () => string;
	/** Runs work after the deferred reply; prod: fire and log, tests: await. */
	defer?: (work: () => Promise<void>) => void;
};

const TYPE = { PING: 1, COMMAND: 2, MODAL_SUBMIT: 5 } as const;
const COMPONENT = { STRING_SELECT: 3, TEXT_INPUT: 4, LABEL: 18 } as const;
const CHAT_INPUT_COMMAND = 1;
const MESSAGE_COMMAND = 3;

const TITLE_MAX = 255;
const DESCRIPTION_MAX = 4000;
const SELECT_MAX = 25;
const OPTION_LABEL_MAX = 100;
const ATTACHMENTS_MAX = 10;
const MENTIONS_MAX = 50;
const NAME_MAX = 80;
const FILENAME_MAX = 200;
const FORM_TTL_MS = 15 * 60_000;
const FORMS_MAX = 1000;
const FIELDS_MAX = 20;
const WALK_DEPTH = 4;

const HTTP_URL = /^https?:\/\//i;
const CUSTOM_ID = /^(create|append):(.{1,64})$/;
const SOURCE = 'discord';

const TEXT = {
	notConfigured: 'Этот сервер не настроен.',
	done: 'Уже обработано.',
	broken: 'Не удалось разобрать запрос Discord.',
	unknownCommand: 'Неизвестная команда.',
	noMessage: 'Не удалось прочитать сообщение.',
	noChannel: 'Не удалось определить канал.',
	coldCache: 'Plane недоступен, повтори через минуту.',
	noProjects: 'Нет проектов, в которые можно создать задачу.',
	hidden: 'Для этого проекта создание задач из Discord отключено.',
	expired: 'Форма устарела, вызови команду ещё раз.',
	itemMissing: 'Задача не найдена.',
	internal: 'Внутренняя ошибка, повтори через минуту.',
} as const;

type Attachment = { url: string; filename: string };
type FormContext = {
	kind: 'create' | 'append';
	tenantId: string;
	guildId: string;
	/** Where the message lives (a thread itself, not its forum): the public reply goes here. */
	channelId: string;
	/** `channel.type` of the command payload; null when absent. A thread opens on the reply only in a text or announcement channel. */
	channelType: number | null;
	/** The mapped project of the routing channel; null when the form asks for one. */
	projectId: string | null;
	/** Project ids the select offered: a submitted value outside it is refused. */
	offered: ReadonlySet<string>;
	messageId: string;
	author: { id: string | null; name: string };
	attachments: Attachment[];
	mentionNames: ReadonlyMap<string, string>;
	expires: number;
};

type Fields = {
	text: (id: string) => string | undefined;
	chosen: (id: string) => string | undefined;
};

/** Text inputs (`value`) and selects (`values`) of a modal submit, found wherever the labels nest them. */
function collectFields(components: unknown): Fields {
	const texts = new Map<string, string>();
	const chosen = new Map<string, string>();
	const walk = (node: unknown, depth: number): void => {
		if (depth > WALK_DEPTH || texts.size + chosen.size >= FIELDS_MAX) return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child, depth + 1);
			return;
		}
		const item = rec(node);
		if (item === null) return;
		const id = str(item.custom_id);
		if (id !== null) {
			if (typeof item.value === 'string') texts.set(id, item.value);
			const first: unknown = Array.isArray(item.values) ? (item.values[0] as unknown) : undefined;
			if (typeof first === 'string') chosen.set(id, first);
		}
		walk(item.components, depth + 1);
		walk(item.component, depth + 1);
	};
	walk(components, 0);
	return { text: (id) => texts.get(id), chosen: (id) => chosen.get(id) };
}

/** At most `max` code points AND `max` UTF-16 units, so the prefill fits whichever way Discord counts. */
function fit(text: string, max: number): string {
	let n = max;
	let out = truncate(text, n);
	while (out.length > max) out = truncate(text, --n);
	return out;
}

const label = (text: string, component: Rec): Rec => ({
	type: COMPONENT.LABEL,
	label: text,
	component,
});
const textInput = (id: string, style: 1 | 2, max: number, extra: Rec): Rec => ({
	type: COMPONENT.TEXT_INPUT,
	custom_id: id,
	style,
	max_length: max,
	...extra,
});

export function createInteractionHandler(
	deps: InteractionDeps,
): (req: Request) => Promise<Response> {
	const now = deps.now ?? Date.now;
	const nonce = deps.nonce ?? (() => crypto.randomUUID());
	const defer =
		deps.defer ??
		((work) => {
			// A timer, not a microtask: microtasks queued while the handler runs still go ahead of the
			// caller's continuation that writes the type 5 response, and an edit that overtakes the
			// initial callback can be answered 404. A timer fires after those continuations.
			setTimeout(() => {
				// The work reports its own failures; a rejection here would be an unhandled one.
				work().catch(() => {});
			}, 0);
		});
	// Logging is best-effort: a throwing sink must not turn an interaction into a 5xx.
	const log: Log = (entry) => {
		try {
			deps.log(entry);
		} catch {
			// nothing else to do with a broken log
		}
	};
	const forms = new Map<string, FormContext>();

	function remember(id: string, context: FormContext): void {
		for (const [key, value] of forms) {
			if (value.expires > now() && forms.size < FORMS_MAX) break;
			forms.delete(key);
		}
		forms.set(id, context);
	}

	// A signed request refused with an ephemeral answer: ids and a reason, never a text.
	function refuse(
		tenantId: string | undefined,
		interaction: string,
		reason: string,
		text: string,
	): Response {
		log({ event: 'ix.refused', level: 'warn', tenant: tenantId, interaction, reason });
		return ephemeral(text);
	}

	const slash = createSlashCommands({ deps, now, defer, log, refuse });

	const edit = (token: string, content: string) => deps.discord.editOriginal(token, { content });

	function mentionFor(rt: TenantRuntime, ctx: FormContext): (discordUserId: string) => string {
		return (discordUserId) => {
			const planeId = rt.users.toPlane(discordUserId);
			return planeId !== null
				? planeMentionHtml(planeId)
				: esc(ctx.mentionNames.get(discordUserId) ?? 'пользователь');
		};
	}

	function authorHtml(rt: TenantRuntime, ctx: FormContext): string {
		const planeId = ctx.author.id === null ? null : rt.users.toPlane(ctx.author.id);
		return planeId !== null ? planeMentionHtml(planeId) : esc(ctx.author.name);
	}

	// Attachment URLs were checked to be http(s) when the command came in.
	const attachmentsHtml = (ctx: FormContext): string =>
		ctx.attachments.length === 0
			? ''
			: `<ul>${ctx.attachments.map((a) => `<li><a href="${esc(a.url)}">${esc(a.filename)}</a></li>`).join('')}</ul>`;

	const messageLink = (ctx: FormContext, text: string): string =>
		`<a href="https://discord.com/channels/${ctx.guildId}/${ctx.channelId}/${ctx.messageId}">${esc(text)}</a>`;

	const itemLink = (rt: TenantRuntime, key: string): string => linkTo(deps.planeUrl, rt, key);

	async function runCreate(
		rt: TenantRuntime,
		ctx: FormContext,
		fields: Fields,
		token: string,
	): Promise<void> {
		const tenant = rt.tenant;
		const title = truncate((fields.text('title') ?? '').replace(/\s+/g, ' ').trim(), TITLE_MAX);
		if (title === '') return edit(token, 'Название обязательно.');
		let projectId = ctx.projectId;
		if (projectId === null) {
			const chosen = fields.chosen('project');
			if (chosen === undefined) return edit(token, 'Проект не выбран.');
			if (!ctx.offered.has(chosen) || isHidden(rt, chosen))
				return edit(token, 'Этого проекта нет в списке, вызови команду ещё раз.');
			projectId = chosen;
		}

		let item: WorkItem | null = null;
		let created = false;
		const known = deps.store.getDiscordItem(tenant.id, ctx.messageId);
		// A project hidden after the item was made answers like a missing item: no key, link or name,
		// and no second item in another project.
		if (known && isHidden(rt, known.projectId)) return edit(token, TEXT.itemMissing);
		if (known) {
			try {
				item = await rt.plane.getWorkItem(known.projectId, known.workItemId);
			} catch (error) {
				// Deleted in Plane: the message may become a work item again.
				if (!(error instanceof PlaneApiError && error.status === 404)) throw error;
			}
		}
		if (item === null) {
			const found = await rt.plane.findWorkItemByExternalId(projectId, SOURCE, ctx.messageId);
			let workItemId: string;
			if (found) {
				workItemId = found.id;
			} else {
				const description = truncate(fields.text('description') ?? '', DESCRIPTION_MAX);
				const html =
					discordToPlaneHtml(description, mentionFor(rt, ctx)) +
					`<p>Из Discord: ${messageLink(ctx, 'сообщение')} · автор: ${authorHtml(rt, ctx)}</p>` +
					attachmentsHtml(ctx);
				const made = await rt.plane.createWorkItem(projectId, {
					name: title,
					description_html: html,
					external_id: ctx.messageId,
					external_source: SOURCE,
				});
				workItemId = made.id;
				created = made.created;
			}
			deps.store.putDiscordItem(tenant.id, ctx.messageId, projectId, workItemId);
			item = await rt.plane.getWorkItem(projectId, workItemId);
		}

		const key = await keyOf(rt, item.projectId, item.sequenceId);
		const target = `${itemLink(rt, key)} «${mdLabel(item.name)}»`;
		if (!created) return edit(token, `Уже есть: ${target}`);

		let reply: { id: string };
		try {
			reply = await deps.discord.sendMessage(ctx.channelId, {
				content: `→ [\`${key}\` «${mdLabel(item.name)}»](<${workItemUrl(deps.planeUrl, tenant.workspace, key)}>)`,
				replyTo: ctx.messageId,
			});
		} catch (error) {
			if (!(error instanceof DiscordApiError)) throw error;
			const reason = error.status === 403 ? 'нет прав писать в канал' : describe(error);
			return edit(token, `Задача создана: ${target} — ${reason}.`);
		}
		if (ctx.channelType === CHANNEL.TEXT || ctx.channelType === CHANNEL.ANNOUNCEMENT) {
			try {
				const threadId = await deps.discord.startThreadFromMessage(
					ctx.channelId,
					reply.id,
					`${key} ${item.name}`,
				);
				deps.store.putThread(tenant.id, item.id, ctx.channelId, threadId, item.projectId);
			} catch (error) {
				if (!(error instanceof DiscordApiError)) throw error;
				// The item and the public reply stand; only the thread is missing.
				log({
					event: 'ix.thread_failed',
					level: 'warn',
					tenant: tenant.id,
					status: error.status,
					code: error.code,
				});
			}
		}
		try {
			await deps.discord.deleteOriginal(token);
		} catch {
			log({ event: 'ix.cleanup_failed', level: 'warn', tenant: tenant.id });
		}
	}

	async function runAppend(
		rt: TenantRuntime,
		ctx: FormContext,
		fields: Fields,
		token: string,
	): Promise<void> {
		const key = (fields.text('key') ?? '').trim().toUpperCase();
		if (key.length > KEY_MAX || !KEY_RE.test(key)) return edit(token, 'Нужен ключ вида LAB-40.');
		const item = await rt.plane.getWorkItemByKey(key);
		// A hidden project answers like a missing one: its keys are not confirmed from Discord.
		if (item === null || isHidden(rt, item.projectId))
			return edit(token, `Задача ${key} не найдена.`);
		const where = itemLink(rt, key);
		const dup = await rt.plane.findCommentByExternalId(
			item.projectId,
			item.id,
			SOURCE,
			ctx.messageId,
		);
		if (dup) return edit(token, `Уже добавлено: ${where}`);

		const text = truncate((fields.text('text') ?? '').trim(), DESCRIPTION_MAX);
		const html =
			(text === ''
				? ''
				: `<blockquote>${discordToPlaneHtml(text, mentionFor(rt, ctx))}</blockquote>`) +
			`<p>— ${authorHtml(rt, ctx)}, ${messageLink(ctx, 'сообщение в Discord')}</p>` +
			attachmentsHtml(ctx);
		await rt.plane.createComment(item.projectId, item.id, {
			comment_html: html,
			external_id: ctx.messageId,
			external_source: SOURCE,
		});
		await edit(token, `→ комментарий в ${where}`);
	}

	function submit(rt: TenantRuntime, ix: Rec, id: string, data: Rec | null): Response {
		const match = CUSTOM_ID.exec(str(own(data, 'custom_id')) ?? '');
		const token = str(ix.token);
		const ctx = match ? forms.get(match[2] as string) : undefined;
		if (
			!match ||
			token === null ||
			!ctx ||
			ctx.expires <= now() ||
			ctx.tenantId !== rt.tenant.id ||
			ctx.kind !== match[1]
		)
			return refuse(rt.tenant.id, id, 'expired_form', TEXT.expired);
		forms.delete(match[2] as string);
		const fields = collectFields(own(data, 'components'));
		const started = now();
		defer(async () => {
			const base = { tenant: rt.tenant.id, interaction: id, kind: ctx.kind };
			try {
				await (ctx.kind === 'create' ? runCreate : runAppend)(rt, ctx, fields, token);
				log({ event: 'ix.done', ...base, ms: now() - started });
			} catch (error) {
				log(failedEntry(base, error, now() - started));
				try {
					await edit(token, `Не получилось: ${describe(error)}.`);
				} catch {
					log({ event: 'ix.reply_failed', level: 'error', ...base });
				}
			}
		});
		return json({ type: REPLY.DEFERRED, data: { flags: FLAG_EPHEMERAL } });
	}

	function command(rt: TenantRuntime, ix: Rec, id: string, data: Rec | null): Response {
		const tenant = rt.tenant;
		const name = own(data, 'name');
		if (data !== null && data.type === CHAT_INPUT_COMMAND && name === PLANE_COMMAND)
			return slash.plane(rt, ix, id, data);
		if (data !== null && data.type === CHAT_INPUT_COMMAND && name === PLANE_LINK_COMMAND)
			return slash.link(rt, ix, id, data);
		const kind = name === CREATE_COMMAND ? 'create' : name === APPEND_COMMAND ? 'append' : null;
		if (data === null || data.type !== MESSAGE_COMMAND || kind === null)
			return refuse(tenant.id, id, 'unknown_command', TEXT.unknownCommand);
		const targetId = snowflake(data.target_id);
		const messages = rec(own(rec(data.resolved), 'messages'));
		const message = targetId === null ? null : rec(own(messages, targetId));
		const messageId = snowflake(message?.id);
		if (message === null || messageId === null)
			return refuse(tenant.id, id, 'no_message', TEXT.noMessage);

		const channel = rec(ix.channel);
		const channelId = snowflake(channel?.id) ?? snowflake(ix.channel_id);
		if (channelId === null) return refuse(tenant.id, id, 'no_channel', TEXT.noChannel);
		const routeId =
			(isThreadType(channel?.type) ? snowflake(channel?.parent_id) : null) ?? channelId;
		const mapped = tenant.channels.find((c) => c.channelId === routeId);

		let offered: ProjectSummary[] = [];
		if (mapped) {
			if (kind === 'create' && isHidden(rt, mapped.projectId))
				return refuse(tenant.id, id, 'hidden_project', TEXT.hidden);
		} else if (kind === 'create') {
			const cached = deps.projectsCached(tenant.id);
			if (cached === null) return refuse(tenant.id, id, 'cold_cache', TEXT.coldCache);
			offered = cached
				.filter((p) => !isHidden(rt, p.id))
				.sort((a, b) => a.identifier.localeCompare(b.identifier, 'en'))
				.slice(0, SELECT_MAX);
			if (offered.length === 0) return refuse(tenant.id, id, 'no_projects', TEXT.noProjects);
		}

		const content = typeof message.content === 'string' ? message.content : '';
		const author = rec(message.author);
		const names = new Map<string, string>();
		const mentions = Array.isArray(message.mentions) ? message.mentions.slice(0, MENTIONS_MAX) : [];
		for (const raw of mentions) {
			const user = rec(raw);
			const id = snowflake(user?.id);
			const display = str(user?.global_name) ?? str(user?.username);
			if (id !== null && display !== null) names.set(id, truncate(display, NAME_MAX));
		}
		const attachments: Attachment[] = [];
		for (const raw of Array.isArray(message.attachments) ? message.attachments : []) {
			if (attachments.length >= ATTACHMENTS_MAX) break;
			const file = rec(raw);
			const url = str(file?.url);
			if (url !== null && HTTP_URL.test(url))
				attachments.push({ url, filename: truncate(str(file?.filename) ?? 'файл', FILENAME_MAX) });
		}

		const formId = nonce();
		remember(formId, {
			kind,
			tenantId: tenant.id,
			guildId: tenant.guildId,
			channelId,
			channelType: typeof channel?.type === 'number' ? channel.type : null,
			projectId: mapped?.projectId ?? null,
			offered: new Set(offered.map((p) => p.id)),
			messageId,
			author: {
				id: snowflake(author?.id),
				name: truncate(
					str(author?.global_name) ?? str(author?.username) ?? 'неизвестный',
					NAME_MAX,
				),
			},
			attachments,
			mentionNames: names,
			expires: now() + FORM_TTL_MS,
		});

		if (kind === 'append') {
			return json({
				type: REPLY.MODAL,
				data: {
					custom_id: `append:${formId}`,
					title: 'Комментарий в задачу',
					components: [
						label(
							'Ключ задачи',
							textInput('key', 1, KEY_MAX, { required: true, placeholder: 'LAB-40' }),
						),
						label(
							'Текст',
							textInput('text', 2, DESCRIPTION_MAX, {
								required: false,
								...(content === '' ? {} : { value: fit(content, DESCRIPTION_MAX) }),
							}),
						),
					],
				},
			});
		}
		const title = fit(titleFrom(content), TITLE_MAX);
		const components = [
			label(
				'Название',
				textInput('title', 1, TITLE_MAX, {
					required: true,
					...(title === '' ? {} : { value: title }),
				}),
			),
			label(
				'Описание',
				textInput('description', 2, DESCRIPTION_MAX, {
					required: false,
					...(content === '' ? {} : { value: fit(content, DESCRIPTION_MAX) }),
				}),
			),
		];
		if (!mapped)
			components.push(
				label('Проект', {
					type: COMPONENT.STRING_SELECT,
					custom_id: 'project',
					required: true,
					options: offered.map((p) => ({
						label: truncate(`${p.identifier} — ${p.name}`, OPTION_LABEL_MAX),
						value: p.id,
					})),
				}),
			);
		return json({
			type: REPLY.MODAL,
			data: { custom_id: `create:${formId}`, title: 'Задача в Plane', components },
		});
	}

	return async (req) => {
		const bytes = await readBounded(req);
		if (bytes === null) return new Response('payload too large', { status: 413 });
		// The signature is checked over the raw bytes before anything is parsed.
		const signed = await verifyDiscordRequest(
			deps.publicKey,
			req.headers.get('x-signature-ed25519'),
			req.headers.get('x-signature-timestamp'),
			bytes,
		);
		if (!signed) {
			log({ event: 'ix.rejected', level: 'warn', reason: 'bad_signature' });
			return new Response('invalid request signature', { status: 401 });
		}
		let ix: Rec | null = null;
		try {
			ix = rec(JSON.parse(new TextDecoder().decode(bytes)));
		} catch {
			// falls through to the same answer as a non-object
		}
		if (ix === null) {
			log({ event: 'ix.rejected', level: 'error', reason: 'bad_json' });
			return new Response('bad request', { status: 400 });
		}
		if (ix.type === TYPE.PING) return json({ type: REPLY.PONG });

		const id = snowflake(ix.id);
		if (id === null) return ephemeral(TEXT.broken);
		try {
			if (!deps.store.claim(`ix:${id}`, now())) {
				log({ event: 'ix.duplicate', interaction: id });
				return ephemeral(TEXT.done);
			}
			const guildId = snowflake(ix.guild_id);
			const rt = guildId === null ? undefined : deps.runtimesByGuild.get(guildId);
			if (!rt) {
				log({ event: 'ix.unconfigured', interaction: id });
				return ephemeral(TEXT.notConfigured);
			}
			const data = rec(ix.data);
			if (ix.type === TYPE.COMMAND) return command(rt, ix, id, data);
			if (ix.type === TYPE.MODAL_SUBMIT) return submit(rt, ix, id, data);
			return refuse(rt.tenant.id, id, 'unknown_command', TEXT.unknownCommand);
		} catch {
			log({ event: 'ix.failed', level: 'error', interaction: id, error: 'handler' });
			return ephemeral(TEXT.internal);
		}
	};
}
