/** A webhook body that parsed as JSON but is not the shape its sender documents → HTTP 400. */
export class BadPayload extends Error {
	override name = 'BadPayload';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, otherwise null. */
export function optString(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

/** The string-valued entries of an object; anything that is not an object → {}. */
export function stringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string',
		),
	);
}

export function isTimestamp(value: unknown): value is string {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
