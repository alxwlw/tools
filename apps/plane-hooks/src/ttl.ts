/**
 * Memoises an async loader for `ttlMs`. Concurrent callers share one in-flight
 * load; a rejected load is dropped, so the next call retries instead of
 * replaying the failure for the rest of the TTL.
 */
export function ttl<T>(
	load: () => Promise<T>,
	ttlMs: number,
	now: () => number = Date.now,
): () => Promise<T> {
	let entry: { value: Promise<T>; expires: number } | null = null;
	return () => {
		const at = now();
		if (entry !== null && at < entry.expires) return entry.value;
		const current = { value: load(), expires: at + ttlMs };
		entry = current;
		current.value.catch(() => {
			if (entry === current) entry = null;
		});
		return current.value;
	};
}
