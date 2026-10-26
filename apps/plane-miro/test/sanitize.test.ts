// Adapted from apps/plane-discord/test/sanitize.test.ts.
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
	expect(parsed.url).toBe('https://plane.example.com/example-ws/browse/ACME-1/');
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

const ITEM_A = '3458764512345678901';
const ITEM_B = '3458764598765432109';
const BOARD_A = 'uXjVRealBoardAa1=';
const BOARD_B = 'uXjVOtherBoardBb2=';

test('id элементов Miro подменяются на 3458764500000000NNN, один id — одна подмена', () => {
	const sanitize = createSanitizer({ slugs: [], hosts: [] });
	const first = JSON.parse(sanitize(`{"a":"${ITEM_A}","b":"${ITEM_B}","c":"${ITEM_A}:${ITEM_B}"}`));
	const second = JSON.parse(sanitize(`{"x":"${ITEM_B}"}`));
	expect(first).toEqual({
		a: '3458764500000000001',
		b: '3458764500000000002',
		c: '3458764500000000001:3458764500000000002',
	});
	expect(second).toEqual({ x: '3458764500000000002' });
});

test('id досок Miro подменяются на uXjVexampleN=, в том числе %3D в ссылке; два id — две подмены', () => {
	const sanitize = createSanitizer({ slugs: [], hosts: [] });
	const out = sanitize(
		`{"u":"https://miro.com/app/board/${BOARD_A}/?moveToWidget=${ITEM_A}","e":"/board/${encodeURIComponent(BOARD_A)}/","o":"${BOARD_B}","same":"${BOARD_A}"}`,
	);
	expect(JSON.parse(out)).toEqual({
		u: 'https://miro.com/app/board/uXjVexample1=/?moveToWidget=3458764500000000001',
		e: '/board/uXjVexample1%3D/',
		o: 'uXjVexample2=',
		same: 'uXjVexample1=',
	});
	expect(out).not.toContain('RealBoard');
	expect(out).not.toContain('OtherBoard');
});

test('уже очищенные id Miro и обычные длинные числа не трогаются', () => {
	const sanitize = createSanitizer({ slugs: [], hosts: [] });
	const input = {
		item: '3458764500000000042',
		board: 'uXjVexample3=',
		other: '123456789012345678',
		longer: '34587645123456789012',
	};
	expect(JSON.parse(sanitize(JSON.stringify(input)))).toEqual({
		item: '3458764500000000042',
		board: 'uXjVexample3=',
		other: '123456789012345678',
		longer: '34587645123456789012',
	});
});

const USER_ID = '3074457999888777666';
const TEAM_ID = '3458764555444333222';

test('любой 19-значный id (пользователь, команда, элемент) заменяется стабильно, 18 и 20 цифр — нет', () => {
	const sanitize = createSanitizer({ slugs: [], hosts: [] });
	const out = JSON.parse(
		sanitize(
			JSON.stringify({ u: USER_ID, t: TEAM_ID, again: USER_ID, short: '307445799988877766' }),
		),
	);
	expect(out).toEqual({
		u: '3458764500000000001',
		t: '3458764500000000002',
		again: '3458764500000000001',
		short: '307445799988877766',
	});
});

const MIRO_BOARD_RESPONSE = {
	id: 'RealBoardId9x',
	name: 'Секретная доска',
	team: { id: TEAM_ID, name: 'Real Team' },
	createdBy: { id: USER_ID, name: 'Ivan Real', type: 'user' },
	owner: { id: USER_ID, name: 'Ivan Real' },
	viewLink: 'https://miro.com/app/board/RealBoardId9x=/',
	data: { content: '<p>тайный текст</p>', title: 'Заголовок фрейма' },
};

test('raw Miro: имена, тексты, создатели и доска без uXjV --board не доживают до выхода', () => {
	const out = createSanitizer({
		slugs: [],
		hosts: [],
		miro: true,
		boards: ['RealBoardId9x='],
	})(JSON.stringify(MIRO_BOARD_RESPONSE));
	for (const secret of [
		'RealBoardId9x',
		'Секретная',
		'Real Team',
		'Ivan Real',
		'тайный',
		'Заголовок',
		USER_ID,
		TEAM_ID,
	]) {
		expect(out).not.toContain(secret);
	}
	const parsed = JSON.parse(out);
	expect(parsed.id).toBe('uXjVexample1');
	expect(parsed.viewLink).toBe('https://miro.com/app/board/uXjVexample1=/');
	expect(parsed.createdBy).toEqual({ id: '3458764500000000002', name: 'Name3', type: 'user' });
	expect(parsed.owner.name).toBe('Name3');
});

test('без miro: name и title остаются (Plane-доставки)', () => {
	const out = JSON.parse(
		createSanitizer({ slugs: [], hosts: [] })('{"name":"Задача","title":"T"}'),
	);
	expect(out).toEqual({ name: 'Задача', title: 'T' });
});

test('cli --miro: без обёртки Plane, --board повторяется', () => {
	const dir = mkdtempSync(join(tmpdir(), 'sanitize-'));
	const file = join(dir, 'board.json');
	writeFileSync(file, JSON.stringify({ a: 'ForeignOne=', b: 'ForeignTwo=', name: 'N' }));
	const out = JSON.parse(cli(['--miro', file, '--board', 'ForeignOne=', '--board', 'ForeignTwo=']));
	expect(out).toEqual({ a: 'uXjVexample1=', b: 'uXjVexample2=', name: 'Name1' });
	expect(() => cli(['--miro'])).toThrow(/usage/);
});
