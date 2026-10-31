// Adapted from apps/plane-miro/test/sanitize.test.ts.
import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, createSanitizer, fixtureOf } from '../scripts/sanitize-fixture.ts';

const UUID_A = '3f2b8c1e-9d4a-4e7b-a1c2-5b6d7e8f9a0b';
const UUID_B = 'c0ffee00-1234-4abc-8def-0123456789ab';

test('ни один UUID, slug, хост и email входа не доживает до выхода', () => {
	const input = JSON.stringify({
		id: UUID_A,
		project: UUID_B,
		url: 'https://plane.real.io/real-ws/browse/ACME-1/',
		by: 'a@real.io',
	});
	const out = createSanitizer({ slugs: ['real-ws'], hosts: ['plane.real.io'] })(input);
	for (const secret of [UUID_A, UUID_B, 'real-ws', 'plane.real.io', 'a@real.io', 'real.io']) {
		expect(out).not.toContain(secret);
	}
	const parsed = JSON.parse(out);
	expect(parsed.url).toBe('https://plane.example.com/example-ws/browse/ABC-1/');
});

test('один UUID — одна подмена во всех строках одного санитайзера', () => {
	const sanitize = createSanitizer({ slugs: [], hosts: [] });
	const first = JSON.parse(sanitize(`{"a":"${UUID_A}","b":"${UUID_B}"}`));
	const second = JSON.parse(sanitize(`{"x":"${UUID_B.toUpperCase()}","y":"${UUID_A}"}`));
	expect(first.a).toBe('00000000-0000-4000-8000-000000000001');
	expect(first.b).toBe('00000000-0000-4000-8000-000000000002');
	expect(second).toEqual({ x: first.b, y: first.a });
});

test('display_name, first_name, last_name, email, avatar заменены', () => {
	const sanitize = createSanitizer({ slugs: [], hosts: [] });
	const out = JSON.parse(
		sanitize(
			JSON.stringify({
				actor: {
					display_name: 'Ivan Real',
					first_name: 'Ivan',
					last_name: 'Real',
					email: 'ivan@corp.test',
					avatar: 'https://cdn.test/ivan.png',
					avatar_url: 'https://cdn.test/ivan2.png',
				},
				nested: [{ deep: { display_name: 'Olga Real', email: 'olga@corp.test', avatar: null } }],
			}),
		),
	);
	expect(out.actor).toEqual({
		display_name: 'User1',
		first_name: 'User2',
		last_name: 'User3',
		email: 'user4@example.com',
		avatar: null,
		avatar_url: null,
	});
	expect(out.nested[0].deep).toEqual({
		display_name: 'User5',
		email: 'user6@example.com',
		avatar: null,
	});
});

test('не-JSON текст чистится по регулярным выражениям, без падения', () => {
	const out = createSanitizer({ slugs: ['real-ws'], hosts: [] })(
		`path /real-ws/x ${UUID_A} b@c.test`,
	);
	expect(out).toBe('path /example-ws/x 00000000-0000-4000-8000-000000000001 user1@example.com');
});

test('slug не вырезается из середины чужого слова', () => {
	const out = createSanitizer({ slugs: ['ws'], hosts: [] })(
		'{"a":"/ws/x","b":"news","c":"ws-two"}',
	);
	expect(JSON.parse(out)).toEqual({ a: '/example-ws/x', b: 'news', c: 'ws-two' });
});

test('fixtureOf подписывает тело test-secret', () => {
	const raw = '{"event":"issue","action":"created"}';
	const fx = fixtureOf(raw, 'issue');
	expect(fx.raw).toBe(raw);
	expect(fx.headers['x-plane-event']).toBe('issue');
	expect(fx.headers['x-plane-signature']).toBe(
		createHmac('sha256', 'test-secret').update(raw).digest('hex'),
	);
});

test('fixtureOf с явным секретом подписывает им', () => {
	const fx = fixtureOf('{"a":1}', 'x', 'other');
	expect(fx.headers['x-plane-signature']).toBe(
		createHmac('sha256', 'other').update('{"a":1}').digest('hex'),
	);
});

test('cli: capture.bin → фикстура с очищенным телом и подписью', () => {
	const dir = mkdtempSync(join(tmpdir(), 'sanitize-'));
	const file = join(dir, '1-aaaaaaaa.bin');
	writeFileSync(file, JSON.stringify({ id: UUID_A, ws: 'real-ws', host: 'plane.real.io' }));
	const out = JSON.parse(cli([file, 'issue', '--slug', 'real-ws', '--host', 'plane.real.io'])) as {
		headers: Record<string, string>;
		raw: string;
	};
	expect(out.headers['x-plane-event']).toBe('issue');
	expect(JSON.parse(out.raw)).toEqual({
		id: '00000000-0000-4000-8000-000000000001',
		ws: 'example-ws',
		host: 'plane.example.com',
	});
	expect(out.headers['x-plane-signature']).toBe(
		createHmac('sha256', 'test-secret').update(out.raw).digest('hex'),
	);
});

test('cli: без аргументов — ошибка с подсказкой', () => {
	expect(() => cli([])).toThrow(/usage/);
});

test('один человек — один номер во всех ключах и строках, пустые и null не трогаются', () => {
	const sanitize = createSanitizer({ slugs: [], hosts: [] });
	const out = JSON.parse(
		sanitize(
			JSON.stringify({
				a: { display_name: 'Ivan', email: 'ivan@corp.test', first_name: null, last_name: '' },
				b: { display_name: 'Ivan', email: 'ivan@corp.test', first_name: 7 },
				text: 'cc ivan@corp.test',
			}),
		),
	);
	expect(out.a).toEqual({
		display_name: 'User1',
		email: 'user2@example.com',
		first_name: null,
		last_name: '',
	});
	expect(out.b).toEqual({ display_name: 'User1', email: 'user2@example.com', first_name: 7 });
	expect(out.text).toBe('cc user2@example.com');
});

test('производные ключи имени и client_id заменены; name и client_identifier — нет', () => {
	const sanitize = createSanitizer({ slugs: [], hosts: [] });
	const out = JSON.parse(
		sanitize(
			JSON.stringify({
				min_assignee_first_name: 'ivanr',
				app_client_id: 'AbCdEf0123456789',
				client_id: 'ZyX987',
				min_label_name: 'bug',
				name: 'Задача',
				client_identifier: 'keep',
			}),
		),
	);
	expect(out).toEqual({
		min_assignee_first_name: 'User1',
		app_client_id: 'example-client-id',
		client_id: 'example-client-id',
		min_label_name: 'Name1',
		name: 'Задача',
		client_identifier: 'keep',
	});
});

test('пустые slug и host в списке не превращают весь текст в подмену', () => {
	const out = createSanitizer({ slugs: [''], hosts: [''] })('{"a":"plain text"}');
	expect(JSON.parse(out)).toEqual({ a: 'plain text' });
});

test('несколько хостов и slug получают разные подмены; ключ avatar* в любом регистре значения', () => {
	const sanitize = createSanitizer({
		slugs: ['one-ws', 'two-ws'],
		hosts: ['a.real.io', 'b.real.io'],
	});
	const out = JSON.parse(
		sanitize(
			JSON.stringify({
				u: 'https://a.real.io/one-ws/x',
				v: 'https://b.real.io/two-ws/y',
				avatar_asset: 'z',
			}),
		),
	);
	expect(out).toEqual({
		u: 'https://plane.example.com/example-ws/x',
		v: 'https://host2.example.com/example-ws-2/y',
		avatar_asset: null,
	});
});

test('cli: без --slug и --host работает, UUID всё равно чистятся', () => {
	const dir = mkdtempSync(join(tmpdir(), 'sanitize-'));
	const file = join(dir, '1-aaaaaaaa.bin');
	writeFileSync(file, `{"id":"${UUID_A}"}`);
	const out = JSON.parse(cli([file, 'issue'])) as { raw: string };
	expect(JSON.parse(out.raw)).toEqual({ id: '00000000-0000-4000-8000-000000000001' });
	expect(() => cli([file])).toThrow(/usage/);
});

test('min_module_name / min_label_name — свободные имена заменены, одинаковые → одна подмена', () => {
	const sanitize = createSanitizer({ slugs: [], hosts: [] });
	const out = JSON.parse(
		sanitize(
			JSON.stringify({
				a: {
					min_module_name: 'x',
					min_label_name: 'secret-label',
					min_assignee_first_name: 'Ivan',
				},
				b: { min_module_name: 'x', min_label_name: null, min_cycle_name: '' },
			}),
		),
	);
	expect(out.a).toEqual({
		min_module_name: 'Name1',
		min_label_name: 'Name2',
		min_assignee_first_name: 'User1',
	});
	expect(out.b).toEqual({ min_module_name: 'Name1', min_label_name: null, min_cycle_name: '' });
});

test('ключи задач → ABC-<n>, один ключ — один номер, в тексте и ссылках; ABC-<n> и UUID не путаются', () => {
	const sanitize = createSanitizer({ slugs: [], hosts: [] });
	const out = JSON.parse(
		sanitize(
			JSON.stringify({
				a: 'PRJ-35',
				b: 'https://h.test/ws/browse/PRJ-7/',
				c: 'PRJ-35 blocks QQ-9',
				d: 'ABC-5',
				id: '3F2B8C1E-9D4A-4E7B-A1C2-5B6D7E8F9A0B',
				utf: 'xPRJ-35',
			}),
		),
	);
	expect(out).toEqual({
		a: 'ABC-1',
		b: 'https://h.test/ws/browse/ABC-2/',
		c: 'ABC-1 blocks ABC-3',
		d: 'ABC-5',
		id: '00000000-0000-4000-8000-000000000001',
		utf: 'xPRJ-35',
	});
});

test('идентификатор проекта сам по себе → ABC, client_identifier не трогается', () => {
	const out = JSON.parse(
		createSanitizer({ slugs: [], hosts: [] })(
			JSON.stringify({
				project_detail: { identifier: 'PRJ' },
				project_identifier: 'PRJ',
				client_identifier: 'keep',
			}),
		),
	);
	expect(out).toEqual({
		project_detail: { identifier: 'ABC' },
		project_identifier: 'ABC',
		client_identifier: 'keep',
	});
});

test('название и описания задачи → Задача <n>: в доставке, во вложенной задаче и в списке связей', () => {
	const sanitize = createSanitizer({ slugs: [], hosts: [] });
	const out = JSON.parse(
		sanitize(
			JSON.stringify({
				event: 'issue',
				data: {
					sequence_id: 35,
					name: 'Секретная задача',
					description_html: '<p>тайна</p>',
					description_stripped: 'тайна',
					label: { name: 'метка' },
				},
				blocked_by: [{ id: 'x', name: 'Секретная задача', project_id: 'p', state_id: 's' }],
				blocking: [{ sequence_id: 36, name: 'Другая задача', description_html: '<p>тайна</p>' }],
				state: { name: 'Done', project: 'p' },
			}),
		),
	);
	expect(out.data).toEqual({
		sequence_id: 35,
		name: 'Задача 1',
		description_html: 'Задача 2',
		description_stripped: 'Задача 3',
		label: { name: 'метка' },
	});
	expect(out.blocked_by[0].name).toBe('Задача 1');
	expect(out.blocking[0]).toEqual({
		sequence_id: 36,
		name: 'Задача 4',
		description_html: 'Задача 2',
	});
	expect(out.state.name).toBe('Done');
});

test('активность смены названия: old_value и new_value → Задача <n>, другие поля не трогаются', () => {
	const out = JSON.parse(
		createSanitizer({ slugs: [], hosts: [] })(
			JSON.stringify({
				activity: { field: 'name', old_value: 'Старое', new_value: 'Новое' },
				other: { field: 'priority', old_value: 'low', new_value: 'high' },
			}),
		),
	);
	expect(out.activity).toEqual({ field: 'name', old_value: 'Задача 1', new_value: 'Задача 2' });
	expect(out.other).toEqual({ field: 'priority', old_value: 'low', new_value: 'high' });
});

test('--names: названия меток, модулей и состояний → Name<n>; без опции остаются', () => {
	const input = JSON.stringify([{ id: 'a', name: 'код:проба', description: 'секрет' }]);
	expect(JSON.parse(createSanitizer({ slugs: [], hosts: [], names: true })(input))).toEqual([
		{ id: 'a', name: 'Name1', description: 'Name2' },
	]);
	expect(JSON.parse(createSanitizer({ slugs: [], hosts: [] })(input))[0].name).toBe('код:проба');
});

test('cli --names: флаг доходит до санитайзера', () => {
	const dir = mkdtempSync(join(tmpdir(), 'sanitize-'));
	const file = join(dir, 'labels.json');
	writeFileSync(file, JSON.stringify([{ name: 'Ярлык' }]));
	const out = JSON.parse(cli([file, 'rest', '--names'])) as { raw: string };
	expect(JSON.parse(out.raw)).toEqual([{ name: 'Name1' }]);
});
