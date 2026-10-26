import { describe, expect, test } from 'bun:test';
import { CONVERTIBLE as serverConvertible } from '../src/convert.ts';
import {
	BATCH_SIZE,
	bindableId,
	CONVERTIBLE as webConvertible,
	chunk,
	convertibleIds,
	errorText,
	mergeBatch,
	summary,
} from '../web/logic.ts';

describe('convertibleIds', () => {
	test('стикер, карточка, фигура, текст — да; фрейм, коннектор, app_card — нет', () => {
		expect(
			convertibleIds([
				{ id: '1', type: 'sticky_note' },
				{ id: '2', type: 'frame' },
				{ id: '3', type: 'text' },
				{ id: '4', type: 'app_card' },
				{ id: '5', type: 'connector' },
				{ id: '6', type: 'card' },
				{ id: '7', type: 'shape' },
			]),
		).toEqual(['1', '3', '6', '7']);
	});

	test('CONVERTIBLE фронта и бэкенда совпадают', () => {
		expect(webConvertible).toEqual(serverConvertible);
	});
});

describe('bindableId', () => {
	test('ровно одна конвертируемая запись — её id; иначе null', () => {
		const sticky = { id: '1', type: 'sticky_note' };
		expect(bindableId([sticky])).toBe('1');
		expect(bindableId([])).toBeNull();
		expect(bindableId([sticky, { id: '2', type: 'text' }])).toBeNull();
		expect(bindableId([{ id: '2', type: 'frame' }])).toBeNull();
		expect(bindableId([sticky, { id: '2', type: 'frame' }])).toBe('1');
	});
});

describe('summary', () => {
	test('ключи и ошибки', () => {
		expect(
			summary([
				{ ok: true, key: 'LAB-1' },
				{ ok: true, key: 'LAB-2' },
				{ ok: false, error: 'empty_text' },
			]),
		).toBe('Готово: LAB-1, LAB-2. Не вышло: 1 — пустой стикер.');
	});

	test('только успех и только неудача', () => {
		expect(summary([{ ok: true, key: 'LAB-7' }])).toBe('Готово: LAB-7.');
		expect(summary([{ ok: false, error: 'not_found' }])).toBe('Не вышло: 1 — элемент не найден.');
	});

	test('разные причины перечисляются один раз, точка в конце причины не двоится', () => {
		expect(
			summary([
				{ ok: false, error: 'plane_failed' },
				{ ok: false, error: 'empty_text' },
				{ ok: false, error: 'plane_failed' },
				{ ok: false, error: 'zzz' },
				{ ok: false, error: 'yyy' },
			]),
		).toBe(
			'Не вышло: 5 — Plane не ответил — попробуйте ещё раз, пустой стикер, Что-то пошло не так.',
		);
	});

	test('пусто — пустая строка', () => {
		expect(summary([])).toBe('');
	});
});

describe('errorText', () => {
	test('известный код и неизвестный', () => {
		expect(errorText('board_no_access')).toContain('Служебный аккаунт');
		expect(errorText('zzz')).toBe('Что-то пошло не так.');
	});

	test('каждый код из таблицы', () => {
		const table: Record<string, string> = {
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
		for (const [code, text] of Object.entries(table)) expect(errorText(code)).toBe(text);
	});

	test('ключи прототипа — не коды', () => {
		expect(errorText('constructor')).toBe('Что-то пошло не так.');
		expect(errorText('toString')).toBe('Что-то пошло не так.');
	});
});

describe('chunk и пакеты', () => {
	test('BATCH_SIZE — 10', () => {
		expect(BATCH_SIZE).toBe(10);
	});

	test('chunk режет по размеру, остаток — последним, пустой вход — пусто', () => {
		const ids = Array.from({ length: 25 }, (_, i) => String(i));
		const parts = chunk(ids, BATCH_SIZE);
		expect(parts.map((p) => p.length)).toEqual([10, 10, 5]);
		expect(parts.flat()).toEqual(ids);
		expect(chunk(ids.slice(0, 10), 10)).toEqual([ids.slice(0, 10)]);
		expect(chunk([], 10)).toEqual([]);
	});

	test('mergeBatch: ответ бэкенда отдаёт результаты как есть', () => {
		const results = [
			{ itemId: '1', ok: true as const, key: 'LAB-1', cardId: 'c1' },
			{ itemId: '2', ok: false as const, error: 'empty_text' },
		];
		expect(mergeBatch(['1', '2'], { ok: true, data: { results } })).toEqual(results);
	});

	test('mergeBatch: упавший запрос — каждая запись пакета с этой ошибкой', () => {
		expect(mergeBatch(['1', '2', '3'], { ok: false, error: 'plane_failed' })).toEqual([
			{ ok: false, error: 'plane_failed' },
			{ ok: false, error: 'plane_failed' },
			{ ok: false, error: 'plane_failed' },
		]);
	});

	test('пакеты с упавшим вторым: итог собирает все три, summary считает 10 неудач', () => {
		const ids = Array.from({ length: 25 }, (_, i) => String(i));
		const merged = chunk(ids, BATCH_SIZE).flatMap((batch, i) =>
			i === 1
				? mergeBatch(batch, { ok: false, error: 'network' })
				: mergeBatch(batch, {
						ok: true,
						data: {
							results: batch.map((id) => ({ itemId: id, ok: true as const, key: `LAB-${id}` })),
						},
					}),
		);
		expect(merged).toHaveLength(25);
		expect(summary(merged)).toContain('Не вышло: 10 — Что-то пошло не так.');
		expect(summary(merged)).toStartWith('Готово: LAB-0, LAB-1');
	});
});
