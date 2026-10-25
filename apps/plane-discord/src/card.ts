import type { Embed } from './discord/rest.ts';
import { truncate } from './html.ts';

const TITLE_MAX = 256;
const FIELD_MAX = 1024;
const EMPTY = '—';

const PRIORITY: Readonly<Record<string, string>> = {
	urgent: 'Срочный',
	high: 'Высокий',
	medium: 'Средний',
	low: 'Низкий',
	none: EMPTY,
};

/** Embed field values must be non-empty and at most 1024 characters. */
const fieldValue = (text: string): string => truncate(text, FIELD_MAX) || EMPTY;

/** The public card of a work item (design §3 «Этап 2»). */
export function workItemCard(input: {
	key: string;
	url: string;
	name: string;
	stateName: string | null;
	/** Already rendered: `<@id>` for people in the user table, display names otherwise. */
	assignees: readonly string[];
	priority: string;
}): Embed {
	// Own-property lookup: a priority such as `constructor` must not reach Object.prototype.
	const priority = Object.hasOwn(PRIORITY, input.priority)
		? (PRIORITY[input.priority] as string)
		: input.priority;
	return {
		title: truncate(`${input.key} ${input.name}`, TITLE_MAX),
		url: input.url,
		fields: [
			{ name: 'Состояние', value: fieldValue(input.stateName ?? EMPTY), inline: true },
			{ name: 'Исполнители', value: fieldValue(input.assignees.join(', ')), inline: true },
			{ name: 'Приоритет', value: fieldValue(priority), inline: true },
		],
	};
}
