import { createHash } from 'node:crypto';

import { truncate } from './html.ts';
import type { AppCardInput } from './miro/rest.ts';
import type { TenantRuntime } from './runtime.ts';

/** Fill of the status field by Plane's state group (design §3.2). */
export const STATE_COLORS: Readonly<Record<string, string>> = {
	backlog: '#e6e6e6',
	unstarted: '#dbe4ff',
	started: '#fff3bf',
	completed: '#d3f9d8',
	cancelled: '#ffe3e3',
};
const TEXT_COLOR = '#1a1a1a';
const NONE = '—';
/** Plane's cap on a link title. */
const LINK_TITLE_MAX = 255;

export async function cardFor(
	rt: TenantRuntime,
	item: {
		projectId: string;
		sequenceId: number;
		name: string;
		stateId: string;
		assignees: readonly string[];
	},
	status: 'connected' | 'disabled' = 'connected',
): Promise<AppCardInput> {
	const [key, state, names] = await Promise.all([
		rt.keyOf(item.projectId, item.sequenceId),
		rt.state(item.projectId, item.stateId),
		rt.memberNames(item.assignees),
	]);
	const fill = state === null ? undefined : STATE_COLORS[state.group];
	return {
		title: `${key} ${item.name}`,
		status,
		fields: [
			state === null
				? { value: NONE }
				: fill === undefined
					? { value: state.name }
					: { value: state.name, fillColor: fill, textColor: TEXT_COLOR },
			{ value: names.length === 0 ? NONE : names.join(', ') },
		],
	};
}

/** sha256 hex of the card as sent: a change of any field changes it. */
export function fieldsHash(card: AppCardInput): string {
	return createHash('sha256').update(JSON.stringify(card)).digest('hex');
}

/** A link that opens the board scrolled to the item. */
export function boardLink(boardId: string, itemId: string): string {
	return `https://miro.com/app/board/${boardId}/?moveToWidget=${itemId}`;
}

/** 'Miro: <board>' or 'Miro: <board> / <frame title>' when frameId names a frame with a title. */
export async function linkTitle(
	rt: TenantRuntime,
	boardId: string,
	boardName: string,
	frameId: string | null,
): Promise<string> {
	const frame = frameId === null ? null : await rt.miro.getFrameTitle(boardId, frameId);
	const title =
		frame === null || frame === '' ? `Miro: ${boardName}` : `Miro: ${boardName} / ${frame}`;
	return truncate(title, LINK_TITLE_MAX);
}
