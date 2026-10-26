// Pieces shared by the interaction handler and the slash commands: payload parsing, reply shapes, error texts.
import { esc, link, truncate } from '../html.ts';
import type { Log } from '../log.ts';
import type { TenantRuntime } from '../notify.ts';
import { PlaneApiError } from '../plane/client.ts';
import { workItemKey, workItemUrl } from '../text.ts';
import { CHANNEL, DiscordApiError } from './rest.ts';

export const REPLY = { PONG: 1, MESSAGE: 4, DEFERRED: 5, MODAL: 9 } as const;
export const FLAG_EPHEMERAL = 64;
export const KEY_MAX = 20;
export const FILENAME_MAX = 200;
export const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const SNOWFLAKE = /^\d{1,20}$/;

/** A thread of any kind: announcement (10), public (11) or private (12). */
export const isThreadType = (type: unknown): boolean =>
	type === CHANNEL.ANNOUNCEMENT_THREAD ||
	type === CHANNEL.PUBLIC_THREAD ||
	type === CHANNEL.PRIVATE_THREAD;

export type Rec = Record<string, unknown>;
export const rec = (value: unknown): Rec | null =>
	typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null;
export const own = (obj: Rec | null, key: string): unknown =>
	obj !== null && Object.hasOwn(obj, key) ? obj[key] : undefined;
export const str = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;
export const snowflake = (value: unknown): string | null => {
	const s = str(value);
	return s !== null && SNOWFLAKE.test(s) ? s : null;
};

/** Backslash-escapes what would end or restyle a markdown link label. */
export const mdLabel = (text: string): string =>
	text.replace(/\s+/g, ' ').replace(/[\\`*_~|[\]<>]/g, '\\$&');

export const json = (body: unknown): Response =>
	new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
export const ephemeral = (content: string): Response =>
	json({
		type: REPLY.MESSAGE,
		data: { content, flags: FLAG_EPHEMERAL, allowed_mentions: { parse: [] } },
	});

export class Failure extends Error {}

/** What the user is told; never the response body, never a path. */
export function describe(error: unknown): string {
	if (error instanceof PlaneApiError) return `Plane ответил ${error.status}`;
	if (error instanceof DiscordApiError) return `Discord ответил ${error.status}`;
	if (error instanceof Failure) return error.message;
	return 'внутренняя ошибка';
}

/** The `ix.failed` log entry of a deferred job: ids, the error class and an upstream status, never a text. */
export function failedEntry(
	base: Record<string, string>,
	error: unknown,
	ms: number,
): Parameters<Log>[0] {
	return {
		event: 'ix.failed',
		level: 'error',
		...base,
		error: error instanceof Error ? error.name : 'unknown',
		status:
			error instanceof PlaneApiError || error instanceof DiscordApiError ? error.status : undefined,
		ms,
	};
}

export const isHidden = (rt: TenantRuntime, projectId: string): boolean =>
	rt.tenant.hiddenProjects.includes(projectId);

export async function keyOf(
	rt: TenantRuntime,
	projectId: string,
	sequenceId: number,
): Promise<string> {
	const project = (await rt.projects()).find((p) => p.id === projectId);
	if (!project) throw new Failure('проект не найден в Plane');
	return workItemKey(project.identifier, sequenceId);
}

export const itemLink = (planeUrl: string, rt: TenantRuntime, key: string): string =>
	`[\`${key}\`](<${workItemUrl(planeUrl, rt.tenant.workspace, key)}>)`;

/** `<ul>` of attachment links for a Plane comment; a non-http(s) URL is dropped. */
export const attachmentsHtml = (files: readonly { url: string; filename: string }[]): string => {
	const items = files.flatMap((f) => {
		const a = link(f.url, truncate(f.filename === '' ? 'файл' : f.filename, FILENAME_MAX));
		return a === null ? [] : [`<li>${a}</li>`];
	});
	return items.length === 0 ? '' : `<ul>${items.join('')}</ul>`;
};

/** `<a>` to a Discord message. */
export const messageLinkHtml = (
	guildId: string,
	channelId: string,
	messageId: string,
	text: string,
): string =>
	`<a href="https://discord.com/channels/${guildId}/${channelId}/${messageId}">${esc(text)}</a>`;
