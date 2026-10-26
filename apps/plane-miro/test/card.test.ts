import { describe, expect, test } from 'bun:test';

import { boardLink, cardFor, fieldsHash, linkTitle, STATE_COLORS } from '../src/card.ts';
import { BOARD, frame, world } from './world.ts';

const item = (over: Partial<Parameters<typeof cardFor>[1]> = {}) => ({
	projectId: 'p1',
	sequenceId: 7,
	name: 'Сделать',
	stateId: 's-started',
	assignees: ['u1', 'u2'],
	...over,
});

describe('cardFor', () => {
	test('статус started → жёлтое поле, исполнители через запятую', async () => {
		const { rt } = world();
		expect(await cardFor(rt, item())).toEqual({
			title: 'LAB-7 Сделать',
			status: 'connected',
			fields: [
				{ value: 'In Progress', fillColor: '#fff3bf', textColor: '#1a1a1a' },
				{ value: 'Аня, Борис' },
			],
		});
	});

	test('нет исполнителей и неизвестный статус → «—»', async () => {
		const { rt } = world();
		const c = await cardFor(rt, item({ stateId: 'nope', assignees: [] }));
		expect(c.fields).toEqual([{ value: '—' }, { value: '—' }]);
	});

	test('неизвестный исполнитель не попадает в поле; одни неизвестные → «—»', async () => {
		const { rt } = world();
		expect((await cardFor(rt, item({ assignees: ['u2', 'ghost'] }))).fields[1]).toEqual({
			value: 'Борис',
		});
		expect((await cardFor(rt, item({ assignees: ['ghost'] }))).fields[1]).toEqual({ value: '—' });
	});

	test('статус с неизвестной группой — имя без цвета', async () => {
		const { rt } = world();
		expect((await cardFor(rt, item({ stateId: 's-odd' }))).fields[0]).toEqual({ value: 'Особый' });
	});

	test('status disabled уходит в карточку', async () => {
		const { rt } = world();
		expect((await cardFor(rt, item(), 'disabled')).status).toBe('disabled');
	});

	test('цвета: пять групп, текст всегда #1a1a1a', () => {
		expect(STATE_COLORS).toEqual({
			backlog: '#e6e6e6',
			unstarted: '#dbe4ff',
			started: '#fff3bf',
			completed: '#d3f9d8',
			cancelled: '#ffe3e3',
		});
	});
});

describe('fieldsHash', () => {
	const a = { title: 'LAB-1 A', status: 'connected' as const, fields: [{ value: 'x' }] };
	test('хеш меняется вместе с полями и не меняется без них', () => {
		expect(fieldsHash(a)).toBe(fieldsHash({ ...a }));
		expect(fieldsHash(a)).not.toBe(fieldsHash({ ...a, fields: [{ value: 'y' }] }));
		expect(fieldsHash(a)).not.toBe(fieldsHash({ ...a, status: 'disabled' }));
		expect(fieldsHash(a)).not.toBe(fieldsHash({ ...a, title: 'LAB-1 B' }));
	});

	test('sha256 в hex от JSON карточки', () => {
		expect(fieldsHash(a)).toBe(
			new Bun.CryptoHasher('sha256').update(JSON.stringify(a)).digest('hex'),
		);
	});
});

test('boardLink: moveToWidget, id доски как есть', () => {
	expect(boardLink(BOARD, '345')).toBe('https://miro.com/app/board/uXjVb1=/?moveToWidget=345');
});

describe('linkTitle', () => {
	test('элемент во фрейме → «Miro: Доска / Фрейм», без фрейма → «Miro: Доска»', async () => {
		const { rt } = world();
		expect(await linkTitle(rt, BOARD, 'Доска', '77')).toBe('Miro: Доска / Фрейм');
		expect(await linkTitle(rt, BOARD, 'Доска', null)).toBe('Miro: Доска');
	});

	test('родитель не фрейм или без названия → только доска', async () => {
		const w = world();
		w.board.items.set('78', frame('78', ''));
		expect(await linkTitle(w.rt, BOARD, 'Доска', '999')).toBe('Miro: Доска');
		expect(await linkTitle(w.rt, BOARD, 'Доска', '78')).toBe('Miro: Доска');
	});

	test('без фрейма Miro не спрашивают; название не длиннее 255 символов', async () => {
		const w = world();
		await linkTitle(w.rt, BOARD, 'Доска', null);
		expect(w.miro.calls).toEqual([]);
		w.board.items.set('79', frame('79', 'ф'.repeat(300)));
		const title = await linkTitle(w.rt, BOARD, 'Доска', '79');
		expect(Array.from(title)).toHaveLength(255);
		expect(title.startsWith('Miro: Доска / ффф')).toBe(true);
	});
});
