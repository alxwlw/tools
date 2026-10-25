import { describe, expect, test } from 'bun:test';

import { workItemCard } from '../src/card.ts';

const base = {
	key: 'LAB-40',
	url: 'https://plane.example.com/example-ws/browse/LAB-40/',
	name: 'Починить вход',
	stateName: 'В работе',
	assignees: ['<@1>', 'Мира'],
	priority: 'high',
};

describe('workItemCard', () => {
	test('workItemCard: заголовок, ссылка, состояние, исполнители, приоритет по-русски; без исполнителей — «—»', () => {
		expect(workItemCard(base)).toEqual({
			title: 'LAB-40 Починить вход',
			url: 'https://plane.example.com/example-ws/browse/LAB-40/',
			fields: [
				{ name: 'Состояние', value: 'В работе', inline: true },
				{ name: 'Исполнители', value: '<@1>, Мира', inline: true },
				{ name: 'Приоритет', value: 'Высокий', inline: true },
			],
		});
		const names = { urgent: 'Срочный', medium: 'Средний', low: 'Низкий', none: '—' };
		for (const [priority, text] of Object.entries(names))
			expect(workItemCard({ ...base, priority }).fields?.[2]?.value).toBe(text);
		const bare = workItemCard({ ...base, assignees: [], stateName: null, priority: '' });
		expect(bare.fields?.map((f) => f.value)).toEqual(['—', '—', '—']);
	});

	test('приоритет вне пяти известных — как есть, включая имена из прототипа', () => {
		expect(workItemCard({ ...base, priority: 'critical' }).fields?.[2]?.value).toBe('critical');
		expect(workItemCard({ ...base, priority: 'constructor' }).fields?.[2]?.value).toBe(
			'constructor',
		);
	});

	test('лимиты embed: заголовок ≤ 256 code points, поле ≤ 1024, эмодзи не рвутся', () => {
		const card = workItemCard({
			...base,
			name: '😀'.repeat(300),
			assignees: ['я'.repeat(600), 'ю'.repeat(600)],
		});
		expect(Array.from(card.title ?? '')).toHaveLength(256);
		expect((card.title ?? '').isWellFormed()).toBe(true);
		expect(Array.from(card.fields?.[1]?.value ?? '')).toHaveLength(1024);
	});
});
