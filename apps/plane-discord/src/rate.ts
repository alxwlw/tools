// Copy of apps/plane-hooks/src/rate.ts; keep in sync until a shared package exists.
/**
 * Sliding-window request budget: at most `max` acquisitions per `windowMs`.
 * Callers wait their turn in arrival order — a later caller never overtakes an
 * earlier one, so a burst from one webhook cannot starve another.
 */
export class SlidingWindow {
	readonly #max: number;
	readonly #windowMs: number;
	readonly #now: () => number;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #stamps: number[] = [];
	#tail: Promise<void> = Promise.resolve();

	constructor(options: {
		max: number;
		windowMs: number;
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
	}) {
		this.#max = options.max;
		this.#windowMs = options.windowMs;
		this.#now = options.now ?? (() => performance.now());
		this.#sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
	}

	/** Resolves when this caller may send one request. */
	acquire(): Promise<void> {
		const turn = this.#tail.then(() => this.#wait());
		this.#tail = turn.catch(() => {});
		return turn;
	}

	async #wait(): Promise<void> {
		for (;;) {
			const now = this.#now();
			while (this.#stamps.length > 0 && (this.#stamps[0] as number) <= now - this.#windowMs)
				this.#stamps.shift();
			if (this.#stamps.length < this.#max) {
				this.#stamps.push(now);
				return;
			}
			await this.#sleep((this.#stamps[0] as number) + this.#windowMs - now);
		}
	}
}
