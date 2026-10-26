const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	nbsp: ' ',
};

function codePoint(n: number): string {
	return Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
		? String.fromCodePoint(n)
		: '';
}

/** Miro item HTML → plain text: block ends become newlines, tags are dropped, entities decoded, blanks collapsed. */
export function plainText(html: string): string {
	const text = html
		.replace(/<(?:br|\/p|\/div|\/li)\b[^>]*>/gi, '\n')
		.replace(/<p\b[^>]*>/gi, '\n')
		.replace(/<[^>]*>/g, '')
		// one pass, so `&amp;lt;` stays `&lt;`
		.replace(
			/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
			(all: string, dec?: string, hex?: string, name?: string) => {
				if (dec !== undefined) return codePoint(Number(dec));
				if (hex !== undefined) return codePoint(parseInt(hex, 16));
				const key = (name ?? '').toLowerCase();
				return Object.hasOwn(ENTITIES, key) ? ENTITIES[key]! : all;
			},
		)
		.replace(/\u00a0/g, ' ');
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
		.join('\n');
}
