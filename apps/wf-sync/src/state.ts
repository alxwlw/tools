/** JSON state: Wealthfolio account/asset ids and per-connector cursors. Written atomically. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AssetState {
	id: string;
	mode: 'MARKET' | 'MANUAL';
	/** Set when wf-sync created the asset; MARKET assets get a grace period before the quote audit. */
	createdAt?: number;
}

interface StateData {
	accounts: Record<string, string>;
	assets: Record<string, AssetState>;
	connectors: Record<string, Record<string, unknown>>;
}

export class State {
	data: StateData = { accounts: {}, assets: {}, connectors: {} };

	constructor(readonly path: string) {
		if (existsSync(path)) {
			const loaded = JSON.parse(readFileSync(path, 'utf8') || '{}') as Partial<StateData>;
			Object.assign(this.data.accounts, loaded.accounts);
			Object.assign(this.data.assets, loaded.assets);
			Object.assign(this.data.connectors, loaded.connectors);
		}
	}

	get accounts() {
		return this.data.accounts;
	}

	get assets() {
		return this.data.assets;
	}

	connector(id: string): Record<string, unknown> {
		return (this.data.connectors[id] ??= {});
	}

	save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
		renameSync(tmp, this.path);
	}
}
