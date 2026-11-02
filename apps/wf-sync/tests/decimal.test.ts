import { describe, expect, test } from 'bun:test';

import { ConfigError, expandEnv, parseConfig } from '../src/config.ts';
import { add, cmp, fromFixed, fromUnits, neg, sub, toFixed } from '../src/decimal.ts';
import { normalizeSymbol } from '../src/symbols.ts';

describe('decimal', () => {
	test('exact 18-decimal sums', () => {
		expect(add('0.1', '0.2')).toBe('0.3');
		expect(add('1.000000000000000001', '2')).toBe('3.000000000000000001');
		expect(sub('5', '7.5')).toBe('-2.5');
		expect(neg('0')).toBe('0');
		expect(add('1e-8', 0)).toBe('0.00000001');
		expect(add('0', 0.1)).toBe('0.1');
		expect(cmp('10', '9.99')).toBe(1);
	});

	test('base units', () => {
		expect(fromUnits(1234567890123456789n, 18)).toBe('1.234567890123456789');
		expect(fromUnits(-150, 2)).toBe('-1.5');
		expect(fromUnits(100, 2)).toBe('1');
		expect(fromUnits(5, 0)).toBe('5');
	});

	test('round trip', () => {
		for (const v of ['0', '-0.000001', '123456789.123456789', '42'])
			expect(fromFixed(toFixed(v))).toBe(v);
	});
});

describe('config', () => {
	test('env expansion with defaults', () => {
		expect(expandEnv({ a: '${X}', b: ['${Y:-dflt}'] }, { X: '1' })).toEqual({
			a: '1',
			b: ['dflt'],
		});
		expect(() => expandEnv('${MISSING}', {})).toThrow(ConfigError);
	});

	test('parse', () => {
		const cfg = parseConfig(
			`
wealthfolio: { url: "http://wf:8088/", password: "\${PW}" }
min_value_usd: 5
pricing: { manual_symbols: [wbt] }
connectors:
  - { type: binance, api_key: k, secret: s }
  - { id: mono, type: monobank, token: t, enabled: false }
`,
			'/app',
			{ PW: 'secret' },
		);
		expect(cfg.wealthfolioUrl).toBe('http://wf:8088');
		expect(cfg.wealthfolioPassword).toBe('secret');
		expect(cfg.stateFile).toBe('/app/state.json');
		expect(cfg.pricing.manualSymbols).toEqual(['WBT']);
		expect(cfg.connectors[0]).toMatchObject({
			id: 'binance',
			type: 'binance',
			options: { api_key: 'k' },
		});
		expect(cfg.connectors[1]!.enabled).toBe(false);
	});

	test('duplicate ids rejected', () => {
		expect(() =>
			parseConfig(`wealthfolio: {url: x}\nconnectors: [{type: okx}, {type: okx}]`, '/', {}),
		).toThrow(/Duplicate/);
	});
});

test('kraken symbol normalization', () => {
	expect(normalizeSymbol('kraken', 'ETH2.S')).toBe('ETH');
	expect(normalizeSymbol('kraken', 'DOT.S')).toBe('DOT');
	expect(normalizeSymbol('kraken', 'XBT.M')).toBe('BTC');
	expect(normalizeSymbol('kraken', 'USD.HOLD')).toBe('USD');
	expect(normalizeSymbol('binance', 'BTC')).toBe('BTC');
});
