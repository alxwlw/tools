/**
 * Narrowing helpers for untyped JSON from external APIs and YAML: read what we need,
 * fall back to a default for anything malformed, never trust a shape.
 */

export type JsonObject = Record<string, unknown>;

export const isObject = (v: unknown): v is JsonObject =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** `v` as an object, or `{}`. */
export const obj = (v: unknown): JsonObject => (isObject(v) ? v : {});

/** `v` as an array, or `[]`. */
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

/** String form of a scalar; undefined for null/undefined/objects. */
export function str(v: unknown): string | undefined {
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
	return undefined;
}

export function num(v: unknown): number | undefined {
	if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

/** Walk nested objects: `path(x, 'a', 'b')` ≈ `x?.a?.b`. */
export function path(v: unknown, ...keys: string[]): unknown {
	let cur = v;
	for (const k of keys) {
		if (!isObject(cur)) return undefined;
		cur = cur[k];
	}
	return cur;
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
