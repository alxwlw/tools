// A Plane key is `<PROJECT IDENTIFIER>-<sequence>`. Neighbour checks instead of
// \b so that `_` separates too (`feat_ops-7`), and a 7th digit voids the match.
const KEY = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,11})-(\d{1,6})(?![0-9])/g;

/**
 * Work item keys (`OPS-12`) mentioned in free text — branch names, commit
 * messages. Prefixes match case-insensitively and survive only when they name
 * an existing Plane project. First-mention order, no duplicates, at most `limit`.
 */
export function extractWorkItemKeys(
	texts: readonly string[],
	projectIdentifiers: ReadonlySet<string>,
	limit = 10,
): string[] {
	const keys: string[] = [];
	for (const text of texts) {
		for (const match of text.matchAll(KEY)) {
			const prefix = (match[1] as string).toUpperCase();
			if (!projectIdentifiers.has(prefix)) continue;
			const key = `${prefix}-${Number(match[2])}`;
			if (keys.includes(key)) continue;
			keys.push(key);
			if (keys.length === limit) return keys;
		}
	}
	return keys;
}
