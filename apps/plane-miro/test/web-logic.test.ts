import { describe, expect, test } from 'bun:test';
import { CONVERTIBLE as serverConvertible, MAX_ITEMS } from '../src/convert.ts';
import {
	BATCH_SIZE,
	bindableId,
	CONVERTIBLE as webConvertible,
	chunk,
	convertInBatches,
	currentSelection,
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
		expect(BATCH_SIZE).toBeLessThanOrEqual(MAX_ITEMS);
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

	test('mergeBatch: 2xx без results — неудача каждой записи пакета', () => {
		const bad = { ok: true, data: {} } as never;
		expect(mergeBatch(['1', '2'], bad)).toEqual([
			{ ok: false, error: 'unknown' },
			{ ok: false, error: 'unknown' },
		]);
	});
});

describe('convertInBatches', () => {
	const ids = Array.from({ length: 25 }, (_, i) => String(i));
	const good = (batch: string[]) => ({
		ok: true as const,
		data: { results: batch.map((id) => ({ ok: true as const, key: `LAB-${id}` })) },
	});

	test('второй пакет упал: размеры [10,10,5], 25 исходов, 10 неудач, третий всё равно ушёл', async () => {
		const sizes: number[] = [];
		const out = await convertInBatches(ids, async (batch) => {
			sizes.push(batch.length);
			return sizes.length === 2 ? { ok: false as const, error: 'network' } : good(batch);
		});
		expect(sizes).toEqual([10, 10, 5]);
		expect(out).toHaveLength(25);
		expect(out.slice(10, 20)).toEqual(
			Array.from({ length: 10 }, () => ({ ok: false, error: 'network' })),
		);
		expect(out.slice(20).every((o) => o.ok)).toBe(true);
		expect(summary(out)).toContain('Не вышло: 10 —');
		expect(summary(out)).toStartWith('Готово: LAB-0, LAB-1');
	});

	test('пакеты уходят по очереди, а не вместе', async () => {
		let running = 0;
		let peak = 0;
		await convertInBatches(ids, async (batch) => {
			running += 1;
			peak = Math.max(peak, running);
			await Promise.resolve();
			running -= 1;
			return good(batch);
		});
		expect(peak).toBe(1);
	});

	test('2xx без results — неудача пакета, прежние исходы сохранены', async () => {
		let calls = 0;
		const out = await convertInBatches(ids.slice(0, 20), async (batch) => {
			calls += 1;
			return calls === 2 ? ({ ok: true, data: {} } as never) : good(batch);
		});
		expect(out).toHaveLength(20);
		expect(out.slice(0, 10).every((o) => o.ok)).toBe(true);
		expect(out.slice(10)).toEqual(
			Array.from({ length: 10 }, () => ({ ok: false, error: 'unknown' })),
		);
	});

	test('прогресс: сделано и всего перед каждым пакетом; пустой список — без вызовов', async () => {
		const seen: [number, number][] = [];
		await convertInBatches(
			ids,
			async (batch) => good(batch),
			(d, t) => seen.push([d, t]),
		);
		expect(seen).toEqual([
			[0, 25],
			[10, 25],
			[20, 25],
		]);
		let calls = 0;
		expect(await convertInBatches([], async (b) => (calls++, good(b)))).toEqual([]);
		expect(calls).toBe(0);
	});
});

describe('currentSelection', () => {
	test('обновление, пришедшее раньше стартового чтения, не затирается им', () => {
		const initial = [{ id: '1', type: 'text' }];
		const updated = [{ id: '2', type: 'text' }];
		expect(currentSelection(updated, initial)).toEqual(updated);
		expect(currentSelection([], initial)).toEqual([]);
		expect(currentSelection(null, initial)).toEqual(initial);
	});
});
