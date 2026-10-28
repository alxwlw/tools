import { Database } from 'bun:sqlite';

import type { DeployCursor } from './delivery/deploy.ts';

/** Bump together with a migration; a file written by a newer build is refused, never half-read. */
const SCHEMA_VERSION = 1;

/** Durable state of the hub. Today only the deploy cursor; the inbox and the journal join it later. */
export class Store {
	readonly #db: Database;

	constructor(path: string) {
		this.#db = new Database(path, { create: true });
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
		this.#db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
