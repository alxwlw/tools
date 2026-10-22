// Text translation between Plane (HTML) and Discord (markdown), design §3 «1b» and §6.
// Truncation to Discord's 2000 characters is DiscordRest's job, not this module's.
import type { UserLink } from './config.ts';
import { esc, truncate } from './html.ts';

export type UserMap = {
	toDiscord(planeUserId: string): string | null;
	toPlane(discordUserId: string): string | null;
};

export function userMap(users: readonly UserLink[]): UserMap {
	const toDiscord = new Map(users.map((u) => [u.plane, u.discord]));
	const toPlane = new Map(users.map((u) => [u.discord, u.plane]));
	return {
		toDiscord: (planeUserId) => toDiscord.get(planeUserId) ?? null,
		toPlane: (discordUserId) => toPlane.get(discordUserId) ?? null,
	};
}

// A tag, with quoted attribute values allowed to hold `>`.
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const NAMED: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
};

/** Decodes HTML entities in one pass (`&amp;lt;` → `&lt;`); unknown or invalid ones stay as written. */
function decode(text: string): string {
	return text.replace(
		/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
		(whole: string, dec?: string, hex?: string, name?: string) => {
			if (name !== undefined) return NAMED[name.toLowerCase()] ?? whole;
			const cp = Number.parseInt((dec ?? hex) as string, dec !== undefined ? 10 : 16);
			const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
			return valid ? String.fromCodePoint(cp) : whole;
		},
	);
}

function attr(attrs: string, name: string): string | null {
	const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
	if (!m) return null;
	// One of the two quoted groups always took part.
	return decode((m[1] ?? m[2]) as string);
}

/** Plane user UUIDs mentioned in Plane HTML, unique, in document order. */
export function planeMentions(html: string): string[] {
	const ids = new Set<string>();
	for (const m of html.matchAll(TAG)) {
		if (m[1] === '/' || m[2]?.toLowerCase() !== 'mention-component') continue;
		const attrs = m[3] as string;
		const id = attr(attrs, 'entity_identifier');
		if (attr(attrs, 'entity_name') === 'user_mention' && id) ids.add(id);
	}
	return [...ids];
}

/** Plane HTML for a user mention, in the format planeMentions reads; `id` is a fresh node UUID. */
export function planeMentionHtml(
	planeUserId: string,
	nodeId: () => string = () => crypto.randomUUID(),
): string {
	return `<mention-component id="${esc(nodeId())}" entity_identifier="${esc(planeUserId)}" entity_name="user_mention"></mention-component>`;
}

// Private-use markers for already-final fragments (mentions, links) inside the text being built:
// the mention guard below runs over the whole string and must not touch them.
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const MARKERS = new RegExp(`[${OPEN}${CLOSE}]`, 'g');
const MARKED = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');

/** Breaks everything Discord would parse as a ping, however the pieces ended up adjacent. */
function defang(text: string): string {
	return text.replace(/<(?=@)|@(?=everyone|here)/gi, (m) => `${m}​`);
}

/**
 * Plane HTML → Discord markdown. `mention` renders one mentioned Plane user (`<@id>` or `@Name`) and is the only
 * source of pings: anything that looks like one in the Plane text is broken with a zero-width space.
 */
export function planeHtmlToDiscord(html: string, mention: (planeUserId: string) => string): string {
	const parts: string[] = [];
	// Fragments are final and marker-free: anything from outside has had MARKERS stripped before it gets here.
	const hold = (fragment: string): string => {
		parts.push(fragment);
		return `${OPEN}${parts.length - 1}${CLOSE}`;
	};
	// One pass, no recursion; an index nobody issued expands to nothing.
	const resolve = (text: string): string => text.replace(MARKED, (_, i) => parts[Number(i)] ?? '');
	let out = '';
	let link: { url: string; start: number } | null = null;

	const onTag = (closing: boolean, name: string, attrs: string): void => {
		if (name === 'br' || name === 'p' || (name === 'li' && !closing)) {
			out += '\n';
		} else if (name === 'mention-component' && !closing) {
			const id = attr(attrs, 'entity_identifier');
			if (attr(attrs, 'entity_name') === 'user_mention' && id) {
				// A real ping is `<@id>`; any other text from the callback (a display name) goes through the guard.
				const rendered = mention(id).replace(MARKERS, '');
				out += hold(/^<@!?[\w-]+>$/.test(rendered) ? rendered : defang(rendered));
			}
		} else if (name === 'a' && !closing) {
			const href = attr(attrs, 'href');
			link = href && /^https?:\/\//i.test(href) ? { url: href, start: out.length } : null;
		} else if (name === 'a' && link) {
			// `<`, `>` and whitespace would end the `<url>` form early.
			// `@everyone` in a URL is percent-encoded so the link still works.
			const url = link.url
				.replace(MARKERS, '')
				.replace(/[<>\s]/g, (c) => encodeURIComponent(c))
				.replace(/@(?=everyone|here)/gi, '%40');
			const inner = defang(out.slice(link.start)).replace(/\s+/g, ' ').trim();
			const label = resolve((inner || url).replace(/[[\]]/g, '\\$&'));
			out = out.slice(0, link.start) + hold(`[${label}](<${url}>)`);
			link = null;
		}
	};

	let last = 0;
	for (const m of html.matchAll(TAG)) {
		const text = html.slice(last, m.index);
		out += decode(text.replace(/[ \t\r\n\f]+/g, ' ')).replace(MARKERS, '');
		last = m.index + m[0].length;
		onTag(m[1] === '/', (m[2] as string).toLowerCase(), m[3] as string);
	}
	out += decode(html.slice(last).replace(/[ \t\r\n\f]+/g, ' ')).replace(MARKERS, '');

	return resolve(
		defang(out)
			.replace(/[ \t]*\n[ \t]*/g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim(),
	);
}

const FENCE = /```(?:[\w+#.-]*\n)?([\s\S]*?)```/g;
// 1 inline code, 2 user id, 3 emoji name, 4 link text, 5 link url; then role, channel, bare URL.
const INLINE =
	/`([^`\n]+)`|<@!?(\d+)>|<a?:(\w+):\d+>|\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)|<@&\d+>|<#\d+>|https?:\/\/[^\s<>]+/gi;

function inline(line: string, mention: (discordUserId: string) => string): string {
	let out = '';
	let last = 0;
	for (const m of line.matchAll(INLINE)) {
		out += esc(line.slice(last, m.index));
		last = m.index + m[0].length;
		if (m[1] !== undefined) out += `<code>${esc(m[1])}</code>`;
		else if (m[2] !== undefined) out += mention(m[2]);
		else if (m[3] !== undefined) out += esc(`:${m[3]}:`);
		else if (m[4] !== undefined) out += `<a href="${esc(m[5] as string)}">${esc(m[4])}</a>`;
		else if (m[0].startsWith('<@&')) out += esc('@роль');
		else if (m[0].startsWith('<#')) out += esc('#канал');
		else {
			// Trailing punctuation belongs to the sentence, not the URL.
			const url = m[0].replace(/[.,;:!?)\]]+$/, '');
			out += `<a href="${esc(url)}">${esc(url)}</a>${esc(m[0].slice(url.length))}`;
		}
	}
	return out + esc(line.slice(last));
}

function paragraphs(chunk: string, mention: (discordUserId: string) => string): string {
	return chunk
		.split(/\n\s*\n/)
		.map((par) => par.trim())
		.filter((par) => par !== '')
		.map(
			(par) =>
				`<p>${par
					.split('\n')
					.map((line) => inline(line, mention))
					.join('<br>')}</p>`,
		)
		.join('');
}

/** Discord text → Plane HTML. Everything is escaped; `mention` returns ready HTML for one mentioned Discord user. */
export function discordToPlaneHtml(
	text: string,
	mention: (discordUserId: string) => string,
): string {
	const source = text.replace(/\r\n?/g, '\n');
	let out = '';
	let last = 0;
	for (const m of source.matchAll(FENCE)) {
		out += paragraphs(source.slice(last, m.index), mention);
		out += `<pre><code>${esc((m[1] as string).replace(/\n$/, ''))}</code></pre>`;
		last = m.index + m[0].length;
	}
	return out + paragraphs(source.slice(last), mention);
}

export function workItemKey(identifier: string, sequenceId: number): string {
	return `${identifier}-${sequenceId}`;
}

export function workItemUrl(planeUrl: string, workspace: string, key: string): string {
	return `${planeUrl.replace(/\/+$/, '')}/${encodeURIComponent(workspace)}/browse/${encodeURIComponent(key)}/`;
}

/** First non-blank line, trimmed, at most 255 code points; '' when the text has none. */
export function titleFrom(text: string): string {
	const line = text.split(/\r?\n/).find((l) => l.trim() !== '');
	return truncate((line ?? '').trim(), 255);
}
