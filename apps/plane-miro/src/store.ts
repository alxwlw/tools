// Adapted from apps/plane-discord/src/store.ts.
import { Database } from 'bun:sqlite';

export type CardRow = {
	tenant: string;
	boardId: string;
	cardId: string;
	workItemId: string;
	projectId: string;
	/** sha256 of the last fields written to the card; null right after creation failed half-way. */
	fieldsHash: string | null;
};

export type SourceRow = {
	workItemId: string;
	projectId: string;
	key: string;
	cardId: string | null;
};

type CardDbRow = {
	tenant: string;
	board_id: string;
	card_id: string;
	work_item_id: string;
	project_id: string;
	fields_hash: string | null;
};

const toCard = (r: CardDbRow): CardRow => ({
	tenant: r.tenant,
	boardId: r.board_id,
	cardId: r.card_id,
	workItemId: r.work_item_id,
	projectId: r.project_id,
	fieldsHash: r.fields_hash,
});

/** SQLite state: dedup keys, Miro item/card links and tokens, per-tenant heartbeat. */
export class Store {
	readonly #db: Database;

	/** ':memory:' in tests. Creates the schema if missing. */
	constructor(path: string) {
		this.#db = new Database(path, { create: true });
		this.#db.run('PRAGMA journal_mode = WAL');
		this.#db.run('CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL)');
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS heartbeat (
				tenant TEXT PRIMARY KEY,
				last_event_at INTEGER,
				alerted_at INTEGER
			)`,
		);
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS sources (
				tenant TEXT NOT NULL,
				board_id TEXT NOT NULL,
				item_id TEXT NOT NULL,
				work_item_id TEXT NOT NULL,
				project_id TEXT NOT NULL,
				key TEXT NOT NULL,
				card_id TEXT,
				PRIMARY KEY (tenant, board_id, item_id)
			)`,
		);
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS cards (
				board_id TEXT NOT NULL,
				card_id TEXT NOT NULL,
				tenant TEXT NOT NULL,
				work_item_id TEXT NOT NULL,
				project_id TEXT NOT NULL,
				fields_hash TEXT,
				PRIMARY KEY (board_id, card_id)
			)`,
		);
		this.#db.run('CREATE INDEX IF NOT EXISTS cards_by_item ON cards (tenant, work_item_id)');
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS miro_tokens (
				team_id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				token TEXT NOT NULL,
				saved_at INTEGER NOT NULL
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

	getSource(tenant: string, boardId: string, itemId: string): SourceRow | null {
		const row = this.#db
			.query<
				{ work_item_id: string; project_id: string; key: string; card_id: string | null },
				[string, string, string]
			>(
				`SELECT work_item_id, project_id, key, card_id FROM sources
				WHERE tenant = ? AND board_id = ? AND item_id = ?`,
			)
			.get(tenant, boardId, itemId);
		return row
			? {
					workItemId: row.work_item_id,
					projectId: row.project_id,
					key: row.key,
					cardId: row.card_id,
				}
			: null;
	}

	/** Upsert: a repeated conversion replaces the work item and clears the card link until it is set again. */
	putSource(tenant: string, boardId: string, itemId: string, row: Omit<SourceRow, 'cardId'>): void {
		this.#db
			.query(
				`INSERT INTO sources (tenant, board_id, item_id, work_item_id, project_id, key, card_id)
				VALUES (?, ?, ?, ?, ?, ?, NULL)
				ON CONFLICT (tenant, board_id, item_id) DO UPDATE SET
					work_item_id = excluded.work_item_id, project_id = excluded.project_id,
					key = excluded.key, card_id = NULL`,
			)
			.run(tenant, boardId, itemId, row.workItemId, row.projectId, row.key);
	}

	setSourceCard(tenant: string, boardId: string, itemId: string, cardId: string): void {
		this.#db
			.query('UPDATE sources SET card_id = ? WHERE tenant = ? AND board_id = ? AND item_id = ?')
			.run(cardId, tenant, boardId, itemId);
	}

	/** Upsert by (boardId, cardId). */
	putCard(row: CardRow): void {
		this.#db
			.query(
				`INSERT INTO cards (board_id, card_id, tenant, work_item_id, project_id, fields_hash)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT (board_id, card_id) DO UPDATE SET
					tenant = excluded.tenant, work_item_id = excluded.work_item_id,
					project_id = excluded.project_id, fields_hash = excluded.fields_hash`,
			)
			.run(row.boardId, row.cardId, row.tenant, row.workItemId, row.projectId, row.fieldsHash);
	}

	/** Every card of a work item, ordered by board then card. */
	cardsOfItem(tenant: string, workItemId: string): CardRow[] {
		return this.#db
			.query<CardDbRow, [string, string]>(
				`SELECT tenant, board_id, card_id, work_item_id, project_id, fields_hash FROM cards
				WHERE tenant = ? AND work_item_id = ? ORDER BY board_id, card_id`,
			)
			.all(tenant, workItemId)
			.map(toCard);
	}

	cardOnBoard(tenant: string, workItemId: string, boardId: string): CardRow | null {
		const row = this.#db
			.query<CardDbRow, [string, string, string]>(
				`SELECT tenant, board_id, card_id, work_item_id, project_id, fields_hash FROM cards
				WHERE tenant = ? AND work_item_id = ? AND board_id = ? ORDER BY card_id LIMIT 1`,
			)
			.get(tenant, workItemId, boardId);
		return row ? toCard(row) : null;
	}

	findCard(boardId: string, cardId: string): CardRow | null {
		const row = this.#db
			.query<CardDbRow, [string, string]>(
				`SELECT tenant, board_id, card_id, work_item_id, project_id, fields_hash FROM cards
				WHERE board_id = ? AND card_id = ?`,
			)
			.get(boardId, cardId);
		return row ? toCard(row) : null;
	}

	setFieldsHash(boardId: string, cardId: string, hash: string): void {
		this.#db
			.query('UPDATE cards SET fields_hash = ? WHERE board_id = ? AND card_id = ?')
			.run(hash, boardId, cardId);
	}

	deleteCard(boardId: string, cardId: string): void {
		this.#db.query('DELETE FROM cards WHERE board_id = ? AND card_id = ?').run(boardId, cardId);
	}

	getMiroToken(teamId: string): string | null {
		const row = this.#db
			.query<{ token: string }, [string]>('SELECT token FROM miro_tokens WHERE team_id = ?')
			.get(teamId);
		return row?.token ?? null;
	}

	/** Replaces the team's token. */
	putMiroToken(teamId: string, userId: string, token: string, now: number = Date.now()): void {
		this.#db
			.query(
				`INSERT INTO miro_tokens (team_id, user_id, token, saved_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (team_id) DO UPDATE SET
					user_id = excluded.user_id, token = excluded.token, saved_at = excluded.saved_at`,
			)
			.run(teamId, userId, token, now);
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
