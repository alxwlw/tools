// Pure front-end logic: no DOM, no imports from src/ (the bundle must not pull server code).

/** Item types that carry text a work item can be made of; a test pins it to src/convert.ts. */
export const CONVERTIBLE: readonly string[] = ['sticky_note', 'card', 'shape', 'text'];
/**
 * Ids per POST /miro/api/convert. The backend converts synchronously under Plane's request limit, so a
 * 50-item request can run for minutes: the panel sends short batches one after another instead.
 */
export const BATCH_SIZE = 10;

export type Item = { id: string; type: string };
export type Outcome = { ok: true; key: string } | { ok: false; error: string };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

const TEXTS: Readonly<Record<string, string>> = {
	unauthorized: 'Сессия Miro устарела — перезагрузите доску.',
	unknown_team: 'Эта команда Miro не подключена к Plane.',
	board_no_access:
		'Служебный аккаунт не может писать на эту доску. Откройте доступ к доске команде и повторите; на плане Free редактируются только три последние доски команды.',
	miro_not_connected: 'Сервис ещё не подключён к Miro. Напишите администратору.',
	unknown_project: 'Проект не найден или скрыт.',
	unknown_card: 'Карточка не связана с задачей.',
	plane_failed: 'Plane не ответил — попробуйте ещё раз.',
	miro_failed: 'Miro не ответил — попробуйте ещё раз.',
	not_found: 'элемент не найден',
	unsupported_type: 'этот тип элемента не переносится',
	empty_text: 'пустой стикер',
	already_linked: 'стикер уже связан с другой задачей',
};
const FALLBACK = 'Что-то пошло не так.';

export function convertibleIds(items: readonly Item[]): string[] {
	return items.filter((item) => CONVERTIBLE.includes(item.type)).map((item) => item.id);
}

/** The one item a work item can be bound to: exactly one convertible entry in the selection. */
export function bindableId(items: readonly Item[]): string | null {
	const ids = convertibleIds(items);
	return ids.length === 1 ? (ids[0] ?? null) : null;
}

export function errorText(code: string): string {
	return Object.hasOwn(TEXTS, code) ? (TEXTS[code] ?? FALLBACK) : FALLBACK;
}

/** `Готово: <keys>.` and/or `Не вышло: <n> — <distinct reasons>.`, joined by a space. */
export function summary(results: readonly Outcome[]): string {
	const keys: string[] = [];
	const reasons = new Set<string>();
	let failed = 0;
	for (const result of results) {
		if (result.ok) {
			keys.push(result.key);
		} else {
			failed += 1;
			reasons.add(errorText(result.error).replace(/\.$/, ''));
		}
	}
	const parts: string[] = [];
	if (keys.length > 0) parts.push(`Готово: ${keys.join(', ')}.`);
	if (failed > 0) parts.push(`Не вышло: ${failed} — ${[...reasons].join(', ')}.`);
	return parts.join(' ');
}

export function chunk<T>(list: readonly T[], size: number): T[][] {
	const parts: T[][] = [];
	for (let at = 0; at < list.length; at += size) parts.push(list.slice(at, at + size));
	return parts;
}

/** One batch's outcomes: the backend's results, or — when the request itself failed — its error for every item. */
export function mergeBatch(
	ids: readonly string[],
	response: ApiResult<{ results: readonly Outcome[] }>,
): Outcome[] {
	if (response.ok) return [...response.data.results];
	return ids.map(() => ({ ok: false, error: response.error }));
}
