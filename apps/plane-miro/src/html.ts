// Copy of apps/plane-discord/src/html.ts; keep in sync until a shared package exists.
const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
};

/** Escapes text for HTML element content and attribute values. */
export function esc(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] as string);
}

/** `<a>` for an http(s) URL; anything else (javascript:, data:, relative, empty) → null. */
export function link(url: string | null | undefined, text: string): string | null {
	if (!url || !/^https?:\/\//i.test(url)) return null;
	return `<a href="${esc(url)}">${esc(text)}</a>`;
}

/** Wraps already-safe HTML in a paragraph. */
export function p(html: string): string {
	return `<p>${html}</p>`;
}

/** "2026-10-06 12:34" (UTC) from an ISO timestamp; throws RangeError on an unparseable one. */
export function utc(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) throw new RangeError(`not a timestamp: ${iso}`);
	return date.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Cuts `text` to at most `max` characters (code points, as Plane's length caps count), the last one being "…".
 * A UTF-16 slice could split a surrogate pair, and Plane fails to store a lone surrogate (500 on every retry).
 */
export function truncate(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}
