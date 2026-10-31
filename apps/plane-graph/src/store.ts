// Adapted from apps/plane-miro/src/store.ts.
import { Database } from 'bun:sqlite';

import type {
	AgentMark,
	AgentRunIn,
	CopyData,
	CopyView,
	Edge,
	ItemRow,
	MarkKey,
	RunSummary,
	SnapshotJson,
	StateGroup,
} from './contract.ts';

type MarkDbRow = {
	kind: 'relation' | 'label';
	from_id: string;
	to_id: string;
	item_id: string;
	label: string;
	run_id: string;
	added_at: string;
	confirmed_at: string | null;
	rejected_at: string | null;
};

type ItemDbRow = {
	id: string;
	project_id: string;
	sequence_id: number;
	name: string;
	description: string;
	state_id: string;
	parent_id: string | null;
	label_ids: string;
	created_at: string;
	updated_at: string;
};

const toItem = (r: ItemDbRow): ItemRow => ({
	id: r.id,
	projectId: r.project_id,
	sequenceId: r.sequence_id,
	name: r.name,
	description: r.description,
	stateId: r.state_id,
	parentId: r.parent_id,
	labelIds: JSON.parse(r.label_ids) as string[],
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

const toMark = (r: MarkDbRow): AgentMark => {
	const tail = {
		runId: r.run_id,
		addedAt: r.added_at,
		confirmedAt: r.confirmed_at,
		rejectedAt: r.rejected_at,
	};
	return r.kind === 'relation'
		? { kind: 'relation', fromId: r.from_id, toId: r.to_id, ...tail }
		: { kind: 'label', itemId: r.item_id, label: r.label, ...tail };
};

/** Mark key columns; the unused side is '' (not NULL), so the UNIQUE key really is unique. */
const markColumns = (key: MarkKey): [string, string, string, string, string] =>
	key.kind === 'relation'
		? ['relation', key.fromId, key.toId, '', '']
		: ['label', '', '', key.itemId, key.label];

const MARK_SELECT = `SELECT kind, from_id, to_id, item_id, label, run_id, added_at, confirmed_at, rejected_at
	FROM marks`;
const MARK_ORDER = 'ORDER BY added_at, kind, from_id, to_id, item_id, label';

/** SQLite state: dedup keys, per-tenant heartbeat, the Plane copy, agent runs and their marks. */
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
				last_event_at INTEGER
			)`,
		);
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS sync (
				tenant TEXT PRIMARY KEY,
				synced_at TEXT NOT NULL
			)`,
		);
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS projects (
				tenant TEXT NOT NULL, id TEXT NOT NULL, identifier TEXT NOT NULL, name TEXT NOT NULL,
				PRIMARY KEY (tenant, id)
			)`,
		);
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS states (
				tenant TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL, grp TEXT NOT NULL,
				PRIMARY KEY (tenant, id)
			)`,
		);
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS labels (
				tenant TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL,
				PRIMARY KEY (tenant, id)
			)`,
		);
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS modules (
				tenant TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL,
				item_ids TEXT NOT NULL,
				PRIMARY KEY (tenant, id)
			)`,
		);
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS items (
				tenant TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL, sequence_id INTEGER NOT NULL,
				name TEXT NOT NULL, description TEXT NOT NULL, state_id TEXT NOT NULL, parent_id TEXT,
				label_ids TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				PRIMARY KEY (tenant, id)
			)`,
		);
		// parent edges are not stored: buildGraph derives them from items.parent_id
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS edges (
				tenant TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
				type TEXT NOT NULL CHECK (type IN ('blocks', 'relates')),
				PRIMARY KEY (tenant, from_id, to_id, type)
			)`,
		);
		this.#db.run('CREATE INDEX IF NOT EXISTS edges_by_to ON edges (tenant, to_id)');
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS runs (
				tenant TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL,
				started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
				relations_added INTEGER NOT NULL, labels_added INTEGER NOT NULL,
				skipped INTEGER NOT NULL, cost_usd REAL,
				PRIMARY KEY (tenant, run_id)
			)`,
		);
		this.#db.run(
			`CREATE TABLE IF NOT EXISTS marks (
				tenant TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('relation', 'label')),
				from_id TEXT NOT NULL, to_id TEXT NOT NULL, item_id TEXT NOT NULL, label TEXT NOT NULL,
				run_id TEXT NOT NULL, added_at TEXT NOT NULL,
				confirmed_at TEXT, rejected_at TEXT,
				PRIMARY KEY (tenant, kind, from_id, to_id, item_id, label)
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

	touchEvent(tenant: string, at: number): void {
		this.#db
			.query(
				`INSERT INTO heartbeat (tenant, last_event_at) VALUES (?, ?)
				ON CONFLICT (tenant) DO UPDATE SET last_event_at = excluded.last_event_at`,
			)
			.run(tenant, at);
	}

	lastEventAt(tenant: string): number | null {
		const row = this.#db
			.query<{ last_event_at: number | null }, [string]>(
				'SELECT last_event_at FROM heartbeat WHERE tenant = ?',
			)
			.get(tenant);
		return row?.last_event_at ?? null;
	}

	/** Replaces the tenant's whole copy in one transaction; a throw (duplicate id, bad edge type) keeps the old one. */
	replaceCopy(tenant: string, copy: CopyData, syncedAt: string): void {
		this.#db.transaction(() => {
			for (const table of ['projects', 'states', 'labels', 'modules', 'items', 'edges']) {
				this.#db.query(`DELETE FROM ${table} WHERE tenant = ?`).run(tenant);
			}
			for (const p of copy.projects) {
				this.#db
					.query('INSERT INTO projects (tenant, id, identifier, name) VALUES (?, ?, ?, ?)')
					.run(tenant, p.id, p.identifier, p.name);
			}
			for (const s of copy.states) {
				this.#db
					.query('INSERT INTO states (tenant, id, project_id, grp) VALUES (?, ?, ?, ?)')
					.run(tenant, s.id, s.projectId, s.group);
			}
			for (const l of copy.labels) {
				this.#db
					.query('INSERT INTO labels (tenant, id, project_id, name) VALUES (?, ?, ?, ?)')
					.run(tenant, l.id, l.projectId, l.name);
			}
			for (const m of copy.modules) {
				this.#db
					.query(
						'INSERT INTO modules (tenant, id, project_id, name, item_ids) VALUES (?, ?, ?, ?, ?)',
					)
					.run(tenant, m.id, m.projectId, m.name, JSON.stringify(m.itemIds));
			}
			for (const item of copy.items) this.#insertItem(tenant, item);
			for (const e of copy.edges) this.#insertEdge(tenant, e);
			this.#db
				.query(
					`INSERT INTO sync (tenant, synced_at) VALUES (?, ?)
					ON CONFLICT (tenant) DO UPDATE SET synced_at = excluded.synced_at`,
				)
				.run(tenant, syncedAt);
		})();
	}

	#insertItem(tenant: string, i: ItemRow): void {
		this.#db
			.query(
				`INSERT INTO items (tenant, id, project_id, sequence_id, name, description, state_id,
					parent_id, label_ids, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				tenant,
				i.id,
				i.projectId,
				i.sequenceId,
				i.name,
				i.description,
				i.stateId,
				i.parentId,
				JSON.stringify(i.labelIds),
				i.createdAt,
				i.updatedAt,
			);
	}

	#insertEdge(tenant: string, e: Edge): void {
		this.#db
			.query(
				'INSERT INTO edges (tenant, from_id, to_id, type) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
			)
			.run(tenant, e.from, e.to, e.type);
	}

	#deleteEdgesOf(tenant: string, itemId: string): void {
		this.#db
			.query('DELETE FROM edges WHERE tenant = ? AND (from_id = ? OR to_id = ?)')
			.run(tenant, itemId, itemId);
	}

	/** Replaces the item and every edge it is part of, in one transaction. */
	putItem(tenant: string, item: ItemRow, edges: Edge[]): void {
		this.#db.transaction(() => {
			this.#deleteEdgesOf(tenant, item.id);
			this.#db.query('DELETE FROM items WHERE tenant = ? AND id = ?').run(tenant, item.id);
			this.#insertItem(tenant, item);
			for (const e of edges) this.#insertEdge(tenant, e);
		})();
	}

	/** Removes the item and its edges in both directions. */
	deleteItem(tenant: string, itemId: string): void {
		this.#db.transaction(() => {
			this.#deleteEdgesOf(tenant, itemId);
			this.#db.query('DELETE FROM items WHERE tenant = ? AND id = ?').run(tenant, itemId);
		})();
	}

	copy(tenant: string): CopyView {
		const db = this.#db;
		const syncedAt =
			db
				.query<{ synced_at: string }, [string]>('SELECT synced_at FROM sync WHERE tenant = ?')
				.get(tenant)?.synced_at ?? null;
		return {
			syncedAt,
			projects: db
				.query<{ id: string; identifier: string; name: string }, [string]>(
					'SELECT id, identifier, name FROM projects WHERE tenant = ? ORDER BY id',
				)
				.all(tenant),
			states: db
				.query<{ id: string; project_id: string; grp: StateGroup }, [string]>(
					'SELECT id, project_id, grp FROM states WHERE tenant = ? ORDER BY id',
				)
				.all(tenant)
				.map((r) => ({ id: r.id, projectId: r.project_id, group: r.grp })),
			labels: db
				.query<{ id: string; project_id: string; name: string }, [string]>(
					'SELECT id, project_id, name FROM labels WHERE tenant = ? ORDER BY id',
				)
				.all(tenant)
				.map((r) => ({ id: r.id, projectId: r.project_id, name: r.name })),
			modules: db
				.query<{ id: string; project_id: string; name: string; item_ids: string }, [string]>(
					'SELECT id, project_id, name, item_ids FROM modules WHERE tenant = ? ORDER BY id',
				)
				.all(tenant)
				.map((r) => ({
					id: r.id,
					projectId: r.project_id,
					name: r.name,
					itemIds: JSON.parse(r.item_ids) as string[],
				})),
			items: db
				.query<ItemDbRow, [string]>(
					`SELECT id, project_id, sequence_id, name, description, state_id, parent_id, label_ids,
						created_at, updated_at FROM items WHERE tenant = ? ORDER BY id`,
				)
				.all(tenant)
				.map(toItem),
			edges: db
				.query<{ from_id: string; to_id: string; type: 'blocks' | 'relates' }, [string]>(
					'SELECT from_id, to_id, type FROM edges WHERE tenant = ? ORDER BY from_id, to_id, type',
				)
				.all(tenant)
				.map((r) => ({ from: r.from_id, to: r.to_id, type: r.type })),
		};
	}

	/**
	 * Stores an agent run and its marks (addedAt = receivedAt, never confirmed or rejected).
	 * false when the runId was seen before; a mark already on file keeps its row.
	 */
	putRun(tenant: string, run: AgentRunIn, receivedAt: string): boolean {
		return this.#db.transaction((): boolean => {
			const inserted = this.#db
				.query(
					`INSERT OR IGNORE INTO runs (tenant, run_id, kind, started_at, finished_at,
						relations_added, labels_added, skipped, cost_usd)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					tenant,
					run.runId,
					run.kind,
					run.startedAt,
					run.finishedAt,
					run.relationsAdded.length,
					run.labelsAdded.length,
					run.skipped,
					run.costUsd,
				);
			if (inserted.changes === 0) return false;
			const keys: MarkKey[] = [
				...run.relationsAdded.map((r): MarkKey => ({ kind: 'relation', ...r })),
				...run.labelsAdded.map((l): MarkKey => ({ kind: 'label', ...l })),
			];
			for (const key of keys) {
				this.#db
					.query(
						`INSERT OR IGNORE INTO marks (tenant, kind, from_id, to_id, item_id, label, run_id, added_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(tenant, ...markColumns(key), run.runId, receivedAt);
			}
			return true;
		})();
	}

	/** The run with the latest finishedAt. */
	lastRun(tenant: string): RunSummary | null {
		const row = this.#db
			.query<
				{
					kind: RunSummary['kind'];
					finished_at: string;
					relations_added: number;
					labels_added: number;
				},
				[string]
			>(
				`SELECT kind, finished_at, relations_added, labels_added FROM runs
				WHERE tenant = ? ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
			)
			.get(tenant);
		return row
			? {
					at: row.finished_at,
					kind: row.kind,
					relationsAdded: row.relations_added,
					labelsAdded: row.labels_added,
				}
			: null;
	}

	/** All marks, or with itemIds only those where one of the items is fromId, toId or itemId. */
	marks(tenant: string, itemIds?: readonly string[]): AgentMark[] {
		if (itemIds === undefined) {
			return this.#db
				.query<MarkDbRow, [string]>(`${MARK_SELECT} WHERE tenant = ? ${MARK_ORDER}`)
				.all(tenant)
				.map(toMark);
		}
		return this.#db
			.query<MarkDbRow, [string, string, string, string]>(
				`${MARK_SELECT} WHERE tenant = ? AND (
					from_id IN (SELECT value FROM json_each(?)) OR to_id IN (SELECT value FROM json_each(?))
					OR item_id IN (SELECT value FROM json_each(?))
				) ${MARK_ORDER}`,
			)
			.all(tenant, JSON.stringify(itemIds), JSON.stringify(itemIds), JSON.stringify(itemIds))
			.map(toMark);
	}

	/** Sets the given timestamps on one mark; an unknown mark is left alone. */
	setMark(
		tenant: string,
		key: MarkKey,
		patch: { confirmedAt?: string; rejectedAt?: string },
	): void {
		const [kind, fromId, toId, itemId, label] = markColumns(key);
		this.#db
			.query(
				`UPDATE marks SET confirmed_at = COALESCE(?, confirmed_at), rejected_at = COALESCE(?, rejected_at)
				WHERE tenant = ? AND kind = ? AND from_id = ? AND to_id = ? AND item_id = ? AND label = ?`,
			)
			.run(
				patch.confirmedAt ?? null,
				patch.rejectedAt ?? null,
				tenant,
				kind,
				fromId,
				toId,
				itemId,
				label,
			);
	}

	/** Marks the agent added that the copy saw and then lost. */
	rejected(tenant: string): SnapshotJson['rejected'] {
		const out: SnapshotJson['rejected'] = { relations: [], labels: [] };
		for (const m of this.marks(tenant)) {
			if (m.rejectedAt === null) continue;
			if (m.kind === 'relation') out.relations.push({ fromId: m.fromId, toId: m.toId });
			else out.labels.push({ itemId: m.itemId, label: m.label });
		}
		return out;
	}

	close(): void {
		this.#db.close();
	}
}
