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
		url: 'https://plane.real.io/real-ws/browse/DX-1/',
		by: 'a@real.io',
	});
	const out = createSanitizer({ slugs: ['real-ws'], hosts: ['plane.real.io'] })(input);
	for (const secret of [UUID_A, UUID_B, 'real-ws', 'plane.real.io', 'a@real.io', 'real.io']) {
		expect(out).not.toContain(secret);
	}
	const parsed = JSON.parse(out);
	expect(parsed.url).toBe('https://plane.example.com/example-ws/browse/DX-1/');
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
