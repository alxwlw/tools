import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { verifyIdToken } from '../src/miro/jwt.ts';

const opts = { clientId: '3458764500000000099', clientSecret: 'miro-sec', nowSec: 1_000 };
const b64 = (v: unknown): string =>
	Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const good = {
	iss: 'miro',
	sub: opts.clientId,
	exp: 2_000,
	team: '3458764500000000001',
	user: '42',
};

function tok(
	over: Record<string, unknown> = {},
	{ secret = opts.clientSecret, header = { alg: 'HS256', typ: 'JWT' } as unknown } = {},
): string {
	const body = `${b64(header)}.${b64({ ...good, ...over })}`;
	return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

describe('verifyIdToken', () => {
	test('верный токен → команда и пользователь строками', () => {
		expect(verifyIdToken(tok(), opts)).toEqual({ teamId: '3458764500000000001', userId: '42' });
		expect(verifyIdToken(tok({ team: 12345, user: 67 }), opts)).toEqual({
			teamId: '12345',
			userId: '67',
		});
	});

	test('просрочен, чужой секрет, чужой sub, iss не miro, alg none, мусор → null', () => {
		const forged = `${b64({ alg: 'none' })}.${b64(good)}.`;
		const hs512 = tok({}, { header: { alg: 'HS512' } });
		const bad: Record<string, string> = {
			просрочен: tok({ exp: 1_000 }),
			'exp не число': tok({ exp: '2000' }),
			'без exp': tok({ exp: undefined }),
			'чужой секрет': tok({}, { secret: 'other' }),
			'чужой sub': tok({ sub: 'other-client' }),
			'iss не miro': tok({ iss: 'evil' }),
			'alg none': forged,
			'alg none с подписью': `${b64({ alg: 'none' })}.${b64(good)}.${createHmac(
				'sha256',
				opts.clientSecret,
			)
				.update(`${b64({ alg: 'none' })}.${b64(good)}`)
				.digest('base64url')}`,
			HS512: hs512,
			'нет alg': tok({}, { header: {} }),
			'заголовок не объект': tok({}, { header: [] }),
			'без команды': tok({ team: undefined }),
			'пустая команда': tok({ team: '' }),
			'команда — объект': tok({ team: {} }),
			'команда не помещается в число': tok({ team: 3458764500000000001 }),
			'отрицательный пользователь': tok({ user: -1 }),
			'без пользователя': tok({ user: undefined }),
			'две части': 'a.b',
			'четыре части': `${tok()}.x`,
			пустая: '',
			мусор: 'not a token',
			'подпись не base64url': `${tok().split('.').slice(0, 2).join('.')}.@@@`,
			'подпись короче': tok().slice(0, -4),
			'payload не JSON': (() => {
				const body = `${b64({ alg: 'HS256' })}.${b64('{nope')}`;
				return `${body}.${createHmac('sha256', opts.clientSecret).update(body).digest('base64url')}`;
			})(),
		};
		for (const [name, t] of Object.entries(bad)) expect(verifyIdToken(t, opts), name).toBeNull();
	});

	test('граница exp: ровно сейчас — просрочен, секунда в запасе — верный', () => {
		expect(verifyIdToken(tok({ exp: 1_000 }), opts)).toBeNull();
		expect(verifyIdToken(tok({ exp: 1_001 }), opts)).not.toBeNull();
	});
});
