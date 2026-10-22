export type QueueLog = (entry: {
	event: 'job.retry' | 'job.dropped';
	label: string;
	/** number of the failed attempt; for job.dropped, the last one */
	attempt: number;
	error: string;
}) => void;

type Job = { label: string; run: () => Promise<void> };

const DEFAULT_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000];

/** In-memory FIFO that runs one job at a time; a retryable failure is retried after each delay in turn. */
export class SerialQueue {
	readonly #log: QueueLog;
	readonly #delaysMs: readonly number[];
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #jobs: Job[] = [];
	#running = false;
	#waiters: Array<() => void> = [];

	/** delaysMs defaults to [1_000, 5_000, 30_000]: one retry per entry. */
	constructor(opts: {
		log: QueueLog;
		delaysMs?: readonly number[];
		sleep?: (ms: number) => Promise<void>;
	}) {
		this.#log = opts.log;
		this.#delaysMs = opts.delaysMs ?? DEFAULT_DELAYS_MS;
		this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	push(label: string, job: () => Promise<void>): void {
		this.#jobs.push({ label, run: job });
		if (!this.#running) {
			this.#running = true;
			void this.#drain();
		}
	}

	/** Resolves when the queue is empty and nothing runs (tests, shutdown). */
	idle(): Promise<void> {
		if (!this.#running && this.#jobs.length === 0) return Promise.resolve();
		return new Promise((resolve) => this.#waiters.push(resolve));
	}

	get size(): number {
		return this.#jobs.length + (this.#running ? 1 : 0);
	}

	async #drain(): Promise<void> {
		try {
			for (let job = this.#jobs.shift(); job; job = this.#jobs.shift()) await this.#runJob(job);
		} finally {
			this.#running = false;
			const waiters = this.#waiters;
			this.#waiters = [];
			for (const wake of waiters) wake();
		}
	}

	/** A throwing logger must not abort the drain: jobs still queued would never run. */
	#safeLog(entry: Parameters<QueueLog>[0]): void {
		try {
			this.#log(entry);
		} catch {
			// logging is best-effort
		}
	}

	async #runJob(job: Job): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			try {
				await job.run();
				return;
			} catch (err) {
				const error = describe(err);
				const delay = this.#delaysMs[attempt - 1];
				if (delay === undefined || !isRetryable(err)) {
					this.#safeLog({ event: 'job.dropped', label: job.label, attempt, error });
					return;
				}
				this.#safeLog({ event: 'job.retry', label: job.label, attempt, error });
				await this.#sleep(delay);
			}
		}
	}
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** true: an error with numeric `status` ≥ 500 or 429; a fetch TypeError; a TimeoutError/AbortError. */
export function isRetryable(err: unknown): boolean {
	if (err instanceof TypeError) return true;
	if (typeof err !== 'object' || err === null) return false;
	const { status, name } = err as { status?: unknown; name?: unknown };
	if (typeof status === 'number') return status >= 500 || status === 429;
	return name === 'TimeoutError' || name === 'AbortError';
}
