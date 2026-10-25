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
				project_id TEXT,
				PRIMARY KEY (tenant, work_item_id, channel_id)
			)`,
		);
		// Phase 1-2 databases have no project_id; their rows keep NULL until a thread binding rewrites them.
		const columns = this.#db.query<{ name: string }, []>('PRAGMA table_info(threads)').all();
		if (!columns.some((c) => c.name === 'project_id'))
			this.#db.run('ALTER TABLE threads ADD COLUMN project_id TEXT');
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
			`CREATE TABLE IF NOT EXISTS webhooks (
				channel_id TEXT PRIMARY KEY,
				webhook_id TEXT NOT NULL UNIQUE,
				token TEXT NOT NULL
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

	/** Upsert: a recreated forum post (or a re-linked thread) replaces the old thread id. */
	putThread(
		tenant: string,
		workItemId: string,
		channelId: string,
		threadId: string,
		projectId: string | null,
	): void {
		this.#db
			.query(
				`INSERT INTO threads (tenant, work_item_id, channel_id, thread_id, project_id) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (tenant, work_item_id, channel_id) DO UPDATE SET
					thread_id = excluded.thread_id, project_id = excluded.project_id`,
			)
			.run(tenant, workItemId, channelId, threadId, projectId);
	}

	/** The work item a thread is bound to; `projectId` is null on rows written before it was recorded. */
	findByThread(threadId: string): {
		tenant: string;
		projectId: string | null;
		workItemId: string;
		channelId: string;
	} | null {
		const row = this.#db
			.query<
				{ tenant: string; project_id: string | null; work_item_id: string; channel_id: string },
				[string]
			>('SELECT tenant, project_id, work_item_id, channel_id FROM threads WHERE thread_id = ?')
			.get(threadId);
		return row
			? {
					tenant: row.tenant,
					projectId: row.project_id,
					workItemId: row.work_item_id,
					channelId: row.channel_id,
				}
			: null;
	}

	/** Every thread bound to a work item, one per channel. */
	threadsOfItem(tenant: string, workItemId: string): { channelId: string; threadId: string }[] {
		return this.#db
			.query<{ channel_id: string; thread_id: string }, [string, string]>(
				`SELECT channel_id, thread_id FROM threads WHERE tenant = ? AND work_item_id = ?
				ORDER BY channel_id, thread_id`,
			)
			.all(tenant, workItemId)
			.map((r) => ({ channelId: r.channel_id, threadId: r.thread_id }));
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

	getWebhook(channelId: string): { id: string; token: string } | null {
		const row = this.#db
			.query<{ webhook_id: string; token: string }, [string]>(
				'SELECT webhook_id, token FROM webhooks WHERE channel_id = ?',
			)
			.get(channelId);
		return row ? { id: row.webhook_id, token: row.token } : null;
	}

	/** Upsert by channel: a recreated webhook replaces the old one. */
	putWebhook(channelId: string, id: string, token: string): void {
		this.#db
			.query(
				`INSERT INTO webhooks (channel_id, webhook_id, token) VALUES (?, ?, ?)
				ON CONFLICT (channel_id) DO UPDATE SET webhook_id = excluded.webhook_id, token = excluded.token`,
			)
			.run(channelId, id, token);
	}

	/** True for a webhook this service created: its messages in a bound thread are our own echo. */
	isOwnWebhook(webhookId: string): boolean {
		return this.#db.query('SELECT 1 FROM webhooks WHERE webhook_id = ?').get(webhookId) !== null;
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
