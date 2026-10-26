export type MiroLink = { boardId: string; itemId: string | null };
export const MAX_LINKS = 5;

// The host is exactly miro.com or www.miro.com right after `//`, then `/app/`: look-alike hosts do not match.
const LINK =
	/https?:\/\/(?:www\.)?miro\.com\/app\/(?:board|live-embed)\/([^\s/?#"'<>]+)([^\s"'<>]*)/g;
const BOARD_ID = /^[A-Za-z0-9_=-]{1,64}$/;
const WIDGET_ID = /^\d{1,24}$/;
/** Punctuation that ends a sentence, not a URL. */
const TRAILING = /[.,;:!)]+$/;

function decode(raw: string): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
}

/** Boards linked in the HTML (href or text), once per board — the first link to it wins; at most MAX_LINKS. */
export function findMiroLinks(html: string): MiroLink[] {
	const out: MiroLink[] = [];
	for (const match of html.replaceAll('&amp;', '&').matchAll(LINK)) {
		const boardId = decode(match[1] as string);
		if (boardId === null || !BOARD_ID.test(boardId)) continue;
		if (out.some((l) => l.boardId === boardId)) continue;
		const rest = (match[2] as string).replace(TRAILING, '');
		const query = rest.split('#')[0]?.split('?')[1] ?? '';
		const widget = new URLSearchParams(query).get('moveToWidget');
		out.push({ boardId, itemId: widget !== null && WIDGET_ID.test(widget) ? widget : null });
		if (out.length === MAX_LINKS) break;
	}
	return out;
}
