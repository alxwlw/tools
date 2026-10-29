import { Database } from 'bun:sqlite';

import type { DeployCursor } from './delivery/deploy.ts';

/** Bump together with a migration; a file written by a newer build is refused, never half-read. */
const SCHEMA_VERSION = 2;
/** How long a write waits for another connection's lock before "database is locked". */
const BUSY_TIMEOUT_MS = 5_000;
const DAY_MS = 86_400_000;
/** Done deliveries stay this long: a GitHub redelivery within the window is recognised as a duplicate. */
const KEEP_DONE_MS = 14 * DAY_MS;
const KEEP_JOURNAL_MS = 180 * DAY_MS;

/** One accepted delivery waiting to be handled; `payload` is the normalised event as JSON. */
export type InboxJob = { id: number; tenant: string; kind: string; payload: string };
export type FailedJob = { id: number; tenant: string; kind: string; error: string; at: string };
/** One status transition a delivery made; `from`/`to` are state names, `cause` names the PR or the deploy. */
export type JournalRow = {
	tenant: string;
	key: string;
	from: string;
	to: string;
	cause: string;
	at: string;
};

/** Where the SQLite file lives unless `PLANE_HOOKS_DB` says otherwise. */
export const DEFAULT_DB = '/data/plane-hooks.sqlite';

/** Durable state of the hub: the deploy cursor, the inbox of deliveries and the journal of transitions. */
export class Store {
	readonly #db: Database;

	constructor(path: string) {
		this.#db = new Database(path, { create: true });
		// Operators run scripts/inbox.ts and journal.ts against the live file: a write waits for the other
		// connection's lock instead of failing at once with "database is locked" (bun:sqlite waits 0 ms).
		this.#db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		this.#db.run('PRAGMA journal_mode = WAL');
		this.#migrate();
	}

	#migrate(): void {
		const { user_version: version } = this.#db.query('PRAGMA user_version').get() as {
			user_version: number;
		};
		if (version > SCHEMA_VERSION) {
			throw new Error(
				`store: schema version ${version} is newer than this build (${SCHEMA_VERSION})`,
			);
		}
		if (version < 1) {
			this.#db.run(`CREATE TABLE IF NOT EXISTS deploy_cursor (
				tenant TEXT NOT NULL,
				repo TEXT NOT NULL,
				environment TEXT NOT NULL,
				sha TEXT NOT NULL,
				at TEXT NOT NULL,
				PRIMARY KEY (tenant, repo, environment)
			)`);
		}
		if (version < 2) {
			// delivery_id is GitHub's x-github-delivery; NULL (Vercel, Dokploy) never collides with another row.
			this.#db.run(`CREATE TABLE IF NOT EXISTS inbox (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				tenant TEXT NOT NULL,
				kind TEXT NOT NULL,
				delivery_id TEXT UNIQUE,
				payload TEXT,
				status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
				error TEXT,
				at TEXT NOT NULL
			)`);
			this.#db.run('CREATE INDEX IF NOT EXISTS inbox_status ON inbox (status, id)');
			this.#db.run(`CREATE TABLE IF NOT EXISTS journal (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				tenant TEXT NOT NULL,
				key TEXT NOT NULL,
				from_state TEXT NOT NULL,
				to_state TEXT NOT NULL,
				cause TEXT NOT NULL,
				at TEXT NOT NULL
			)`);
			this.#db.run('CREATE INDEX IF NOT EXISTS journal_at ON journal (at)');
		}
		// Written only on a change: opening an up-to-date file takes no write lock.
		if (version !== SCHEMA_VERSION) this.#db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	}

	/**
	 * Records an accepted delivery as pending and returns its id. A GitHub delivery id seen before answers null
	 * when that delivery is done or still pending (a redelivery must not run it twice); a failed one is reset to
	 * pending with the new payload and runs again under its old id.
	 */
	inboxAdd(
		tenant: string,
		kind: string,
		deliveryId: string | null,
		payload: string,
		at: string,
	): number | null {
		return (
			this.#db
				.transaction((): number | null => {
					if (deliveryId !== null) {
						const seen = this.#db
							.query('SELECT id, status FROM inbox WHERE delivery_id = ?')
							.get(deliveryId) as { id: number; status: string } | null;
						if (seen !== null) {
							if (seen.status !== 'failed') return null;
							this.#db
								.query(
									`UPDATE inbox SET status = 'pending', payload = ?, error = NULL, at = ? WHERE id = ?`,
								)
								.run(payload, isoOf(at), seen.id);
							return seen.id;
						}
					}
					const row = this.#db
						.query(
							`INSERT INTO inbox (tenant, kind, delivery_id, payload, status, at)
					VALUES (?, ?, ?, ?, 'pending', ?) RETURNING id`,
						)
						.get(tenant, kind, deliveryId, payload, isoOf(at)) as { id: number };
					return row.id;
				})
				// IMMEDIATE takes the write lock up front, through busy_timeout: a deferred transaction that has read
				// and then needs to write fails at once with SQLITE_BUSY while another connection holds the lock.
				.immediate()
		);
	}

	/** The payload is dropped: it can carry PR titles and bodies. */
	inboxDone(id: number): void {
		this.#db
			.query(`UPDATE inbox SET status = 'done', payload = NULL, error = NULL WHERE id = ?`)
			.run(id);
	}

	/** Kept with its payload, so `inboxRetry` can run it again. */
	inboxFailed(id: number, error: string): void {
		this.#db
			.query(`UPDATE inbox SET status = 'failed', error = ? WHERE id = ? AND status = 'pending'`)
			.run(error, id);
	}

	/** Pending deliveries, oldest first: what a restart has to finish. */
	inboxPending(): InboxJob[] {
		return this.#db
			.query(
				`SELECT id, tenant, kind, payload FROM inbox WHERE status = 'pending' AND payload IS NOT NULL
				ORDER BY id`,
			)
			.all() as InboxJob[];
	}

	/** Failed deliveries, oldest first; `at` is when the delivery was accepted. */
	inboxFailedList(): FailedJob[] {
		return this.#db
			.query(
				`SELECT id, tenant, kind, COALESCE(error, '') AS error, at FROM inbox WHERE status = 'failed'
				ORDER BY id`,
			)
			.all() as FailedJob[];
	}

	/** failed → pending, picked up by the next start; false when `id` is not a failed delivery. */
	inboxRetry(id: number): boolean {
		return (
			this.#db
				.query(
					`UPDATE inbox SET status = 'pending', error = NULL WHERE id = ? AND status = 'failed'`,
				)
				.run(id).changes > 0
		);
	}

	journalAdd(row: JournalRow): void {
		this.#db
			.query(
				'INSERT INTO journal (tenant, key, from_state, to_state, cause, at) VALUES (?, ?, ?, ?, ?, ?)',
			)
			.run(row.tenant, row.key, row.from, row.to, row.cause, isoOf(row.at));
	}

	/** Transitions at or after `sinceIso`, oldest first; `tenant` narrows to one tenant. */
	journalSince(sinceIso: string, tenant?: string): JournalRow[] {
		const since = isoOf(sinceIso);
		const select =
			'SELECT tenant, key, from_state AS "from", to_state AS "to", cause, at FROM journal WHERE at >= ?';
		const rows =
			tenant === undefined
				? this.#db.query(`${select} ORDER BY at, id`).all(since)
				: this.#db.query(`${select} AND tenant = ? ORDER BY at, id`).all(since, tenant);
		return rows as JournalRow[];
	}

	/** Done deliveries older than 14 days and journal rows older than 180 days. Pending and failed ones stay. */
	prune(nowIso: string): void {
		const now = Date.parse(isoOf(nowIso));
		this.#db
			.query(`DELETE FROM inbox WHERE status = 'done' AND at < ?`)
			.run(new Date(now - KEEP_DONE_MS).toISOString());
		this.#db
			.query('DELETE FROM journal WHERE at < ?')
			.run(new Date(now - KEEP_JOURNAL_MS).toISOString());
	}

	/** The sha the last handled deploy of repo/environment reached and when that deploy happened; null — none yet. */
	deployCursor(
		tenant: string,
		repo: string,
		environment: string,
	): { sha: string; at: string } | null {
		return this.#db
			.query('SELECT sha, at FROM deploy_cursor WHERE tenant = ? AND repo = ? AND environment = ?')
			.get(tenant, repo, environment) as { sha: string; at: string } | null;
	}

	setDeployCursor(
		tenant: string,
		repo: string,
		environment: string,
		sha: string,
		at: string,
	): void {
		this.#db
			.query(
				`INSERT INTO deploy_cursor (tenant, repo, environment, sha, at) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (tenant, repo, environment) DO UPDATE SET sha = excluded.sha, at = excluded.at`,
			)
			.run(tenant, repo, environment, sha, at);
	}

	cursorFor(tenant: string): DeployCursor {
		return {
			get: (repo, environment) => this.deployCursor(tenant, repo, environment),
			set: (repo, environment, sha, at) => this.setDeployCursor(tenant, repo, environment, sha, at),
		};
	}

	close(): void {
		this.#db.close();
	}
}

/**
 * Times are compared as text in SQLite, so every one is normalised to `toISOString()` (UTC, milliseconds);
 * an unparseable time throws instead of matching everything or nothing.
 */
function isoOf(value: string): string {
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) throw new RangeError(`store: not a timestamp: ${value}`);
	return new Date(ms).toISOString();
}
