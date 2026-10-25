import { Database } from 'bun:sqlite';

/** SQLite state: dedup keys, thread and work item links, per-tenant heartbeat. */
export class Store {
	readonly #db: Database;

	/** ':memory:' in tests. Creates the schema if missing. */
	constructor(path: string) {
		this.#db = new Database(path, { create: true });
		this.#db.run('PRAGMA journal_mode = WAL');
		this.#db.run('CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL)');
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS threads (
				tenant TEXT NOT NULL,
				work_item_id TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				thread_id TEXT NOT NULL UNIQUE,
				PRIMARY KEY (tenant, work_item_id, channel_id)
			)`,
		);
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS discord_items (
				tenant TEXT NOT NULL,
				message_id TEXT NOT NULL,
				project_id TEXT NOT NULL,
				work_item_id TEXT NOT NULL,
				PRIMARY KEY (tenant, message_id)
			)`,
		);
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS heartbeat (
				tenant TEXT PRIMARY KEY,
				last_event_at INTEGER,
				alerted_at INTEGER
			)`,
		);
	}

	/** Dedup: true the first time a key is seen. */
	claim(key: string, now: number = Date.now()): boolean {
		return (
			this.#db.query('INSERT OR IGNORE INTO seen (key, at) VALUES (?, ?)').run(key, now).changes ===
			1
		);
	}

	prune(olderThanMs: number, now: number = Date.now()): number {
		return this.#db.query('DELETE FROM seen WHERE at < ?').run(now - olderThanMs).changes;
	}

	getThread(tenant: string, workItemId: string, channelId: string): string | null {
		const row = this.#db
			.query<{ thread_id: string }, [string, string, string]>(
				'SELECT thread_id FROM threads WHERE tenant = ? AND work_item_id = ? AND channel_id = ?',
			)
			.get(tenant, workItemId, channelId);
		return row?.thread_id ?? null;
	}

	/** Upsert: a recreated forum post replaces the old thread id. */
	putThread(tenant: string, workItemId: string, channelId: string, threadId: string): void {
		this.#db
			.query(
				`INSERT INTO threads (tenant, work_item_id, channel_id, thread_id) VALUES (?, ?, ?, ?)
				ON CONFLICT (tenant, work_item_id, channel_id) DO UPDATE SET thread_id = excluded.thread_id`,
			)
			.run(tenant, workItemId, channelId, threadId);
	}

	getDiscordItem(
		tenant: string,
		messageId: string,
	): { projectId: string; workItemId: string } | null {
		const row = this.#db
			.query<{ project_id: string; work_item_id: string }, [string, string]>(
				'SELECT project_id, work_item_id FROM discord_items WHERE tenant = ? AND message_id = ?',
			)
			.get(tenant, messageId);
		return row ? { projectId: row.project_id, workItemId: row.work_item_id } : null;
	}

	putDiscordItem(tenant: string, messageId: string, projectId: string, workItemId: string): void {
		this.#db
			.query(
				`INSERT INTO discord_items (tenant, message_id, project_id, work_item_id) VALUES (?, ?, ?, ?)
				ON CONFLICT (tenant, message_id) DO UPDATE SET
					project_id = excluded.project_id, work_item_id = excluded.work_item_id`,
			)
			.run(tenant, messageId, projectId, workItemId);
	}

	touchEvent(tenant: string, at: number): void {
		this.#db
			.query(
				`INSERT INTO heartbeat (tenant, last_event_at) VALUES (?, ?)
				ON CONFLICT (tenant) DO UPDATE SET last_event_at = excluded.last_event_at`,
			)
			.run(tenant, at);
	}

	silence(tenant: string): { lastEventAt: number | null; alertedAt: number | null } {
		const row = this.#db
			.query<{ last_event_at: number | null; alerted_at: number | null }, [string]>(
				'SELECT last_event_at, alerted_at FROM heartbeat WHERE tenant = ?',
			)
			.get(tenant);
		return { lastEventAt: row?.last_event_at ?? null, alertedAt: row?.alerted_at ?? null };
	}

	markAlerted(tenant: string, at: number | null): void {
		this.#db
			.query(
				`INSERT INTO heartbeat (tenant, alerted_at) VALUES (?, ?)
				ON CONFLICT (tenant) DO UPDATE SET alerted_at = excluded.alerted_at`,
			)
			.run(tenant, at);
	}

	close(): void {
		this.#db.close();
	}
}
