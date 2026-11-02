/**
 * Minimal exact decimal arithmetic on strings (bigint fixed-point, 18 places).
 * Crypto quantities (18-decimal tokens) don't survive float math, and
 * Wealthfolio accepts quantities as strings anyway.
 */

const SCALE = 18;
const FACTOR = 10n ** BigInt(SCALE);

export type Dec = string;

export function toFixed(value: Dec | number | bigint): bigint {
	if (typeof value === 'bigint') return value * FACTOR;
	let s = typeof value === 'number' ? numberToPlain(value) : value.trim();
	if (s === '' || s === '-' || s === '+') return 0n;
	let neg = false;
	if (s.startsWith('-')) {
		neg = true;
		s = s.slice(1);
	} else if (s.startsWith('+')) {
		s = s.slice(1);
	}
	if (/e/i.test(s)) s = numberToPlain(Number(s));
	if (!/^\d*\.?\d*$/.test(s)) throw new Error(`Invalid decimal: ${value}`);
	const [int = '0', frac = ''] = s.split('.');
	const fracPadded = (frac + '0'.repeat(SCALE)).slice(0, SCALE);
	const v = BigInt(int || '0') * FACTOR + BigInt(fracPadded || '0');
	return neg ? -v : v;
}

export function fromFixed(v: bigint): Dec {
	const neg = v < 0n;
	const abs = neg ? -v : v;
	const int = abs / FACTOR;
	const frac = (abs % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
	const out = frac ? `${int}.${frac}` : `${int}`;
	return neg && out !== '0' ? `-${out}` : out;
}

/** Convert an integer amount in base units (wei, lamports, kopecks) to a decimal string. */
export function fromUnits(raw: bigint | string | number, decimals: number): Dec {
	const r = BigInt(raw);
	const neg = r < 0n;
	const abs = neg ? -r : r;
	const base = 10n ** BigInt(decimals);
	const int = abs / base;
	const frac =
		decimals > 0 ? (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
	const out = frac ? `${int}.${frac}` : `${int}`;
	return neg && out !== '0' ? `-${out}` : out;
}

export const add = (a: Dec, b: Dec | number): Dec => fromFixed(toFixed(a) + toFixed(b));
export const sub = (a: Dec, b: Dec | number): Dec => fromFixed(toFixed(a) - toFixed(b));
export const neg = (a: Dec): Dec => fromFixed(-toFixed(a));
export const abs = (a: Dec): Dec => fromFixed(toFixed(a) < 0n ? -toFixed(a) : toFixed(a));
export const isZero = (a: Dec): boolean => toFixed(a) === 0n;
export const sign = (a: Dec): -1 | 0 | 1 => {
	const v = toFixed(a);
	return v === 0n ? 0 : v < 0n ? -1 : 1;
};
export const cmp = (a: Dec, b: Dec): number => {
	const d = toFixed(a) - toFixed(b);
	return d === 0n ? 0 : d < 0n ? -1 : 1;
};
/** Lossy: only for valuations / thresholds, never for stored quantities. */
export const toNumber = (a: Dec): number => Number(a);

/**
 * Shortest decimal that round-trips the float (what String(n) gives), with
 * exponent notation expanded — so 0.1 stays "0.1", not "0.100000000000000006".
 */
function numberToPlain(n: number): string {
	if (!Number.isFinite(n)) throw new Error(`Invalid number: ${n}`);
	const s = String(n);
	const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
	if (!m) return s;
	const [, sgn = '', lead = '', rest = '', expStr = '0'] = m;
	const digits = lead + rest;
	const exp = Number(expStr);
	const point = 1 + exp; // position of the decimal point within `digits`
	let out: string;
	if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
	else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
	else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
	return sgn + out;
}
