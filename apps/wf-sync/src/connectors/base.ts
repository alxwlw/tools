/**
 * Connector base class and plugin registry.
 *
 * Writing your own integration
 * ----------------------------
 * Create `plugins/my-bank.ts`:
 *
 *   import { Connector, HoldingsSnapshot, type AccountData } from "wf-sync";
 *
 *   export default class MyBank extends Connector {
 *     async fetch(): Promise<AccountData[]> {
 *       const { balance } = await this.http(`https://api.my-bank.com/balance`, {
 *         headers: { authorization: `Bearer ${this.opt("token")}` },
 *       });
 *       const snap = new HoldingsSnapshot();
 *       snap.addCash("EUR", String(balance));
 *       return [{ key: this.id, name: this.displayName("My bank"), currency: "EUR",
 *                 accountType: "CASH", holdings: snap }];
 *     }
 *   }
 *
 * and reference it from config.yaml:
 *
 *   plugins_dir: ./plugins
 *   connectors:
 *     - id: mybank
 *       type: ./my-bank.ts        # path relative to plugins_dir; optional "#ExportName"
 *       token: ${MY_BANK_TOKEN}   # → this.opt("token")
 */

import { isAbsolute, resolve } from 'node:path';

import { requestJson, type RequestOptions } from '../http.ts';
import { path, str } from '../json.ts';
import type { Logger } from '../log.ts';
import type { AccountData } from '../models.ts';

export interface ConnectorContext {
	/** Persistent object private to this connector; saved after every run. */
	state: Record<string, unknown>;
	log: Logger;
	saveState: () => void;
}

export abstract class Connector {
	readonly log: Logger;

	constructor(
		readonly id: string,
		readonly type: string,
		readonly name: string | undefined,
		readonly options: Record<string, unknown>,
		readonly ctx: ConnectorContext,
	) {
		this.log = ctx.log;
	}

	displayName(fallback: string): string {
		return this.name ?? fallback;
	}

	/** Required string option. */
	opt(key: string): string {
		const v = str(this.options[key]);
		if (!v) throw new Error(`[${this.id}] missing required option '${key}'`);
		return v;
	}

	optional<T = unknown>(key: string, fallback: T): T {
		const v = this.options[key];
		return v === undefined || v === null ? fallback : (v as T);
	}

	/**
	 * A value in this connector's persistent state, created on first use. The state is
	 * our own JSON written by this connector, so the shape is trusted.
	 */
	protected stored<T>(key: string, init: () => T): T {
		const s = this.ctx.state;
		if (s[key] === undefined) s[key] = init();
		return s[key] as T;
	}

	/** JSON HTTP helper with retries. */
	http<T = unknown>(url: string, opts?: RequestOptions): Promise<T> {
		return requestJson<T>(url, opts);
	}

	/** Called once to validate credentials/config without writing anything. */
	async check(): Promise<string> {
		const accounts = await this.fetch();
		return `${accounts.length} account(s): ${accounts.map((a) => a.name).join(', ')}`;
	}

	abstract fetch(): Promise<AccountData[]>;

	/** Optional: called after everything fetch() returned was written to Wealthfolio (commit cursors here). */
	onSynced?(): void | Promise<void>;
}

export type ConnectorClass = new (
	id: string,
	type: string,
	name: string | undefined,
	options: Record<string, unknown>,
	ctx: ConnectorContext,
) => Connector;

const BUILTIN: Record<string, () => Promise<ConnectorClass>> = {
	binance: async () => (await import('./exchanges.ts')).ExchangeConnector,
	okx: async () => (await import('./exchanges.ts')).ExchangeConnector,
	kraken: async () => (await import('./exchanges.ts')).ExchangeConnector,
	whitebit: async () => (await import('./exchanges.ts')).ExchangeConnector,
	ccxt: async () => (await import('./exchanges.ts')).ExchangeConnector,
	evm: async () => (await import('./evm.ts')).EvmConnector,
	solana: async () => (await import('./solana.ts')).SolanaConnector,
	monobank: async () => (await import('./monobank.ts')).MonobankConnector,
	manual: async () => (await import('./manual.ts')).ManualConnector,
};

export const builtinTypes = () => Object.keys(BUILTIN);

let sdkRegistered = false;

/** Make `import … from "wf-sync"` resolve for plugins in any folder (they share our class instances). */
async function registerSdk(): Promise<void> {
	if (sdkRegistered) return;
	sdkRegistered = true;
	const sdk = await import('../sdk.ts');
	Bun.plugin({
		name: 'wf-sync-sdk',
		setup(build) {
			build.module('wf-sync', () => ({ exports: { ...sdk }, loader: 'object' }));
		},
	});
}

export async function resolveConnector(type: string, pluginsDir?: string): Promise<ConnectorClass> {
	const builtin = BUILTIN[type];
	if (builtin) return builtin();
	await registerSdk();

	const looksLikePath =
		type.startsWith('.') || type.startsWith('/') || /\.(ts|js|mjs)(#|$)/.test(type);
	if (!looksLikePath) {
		throw new Error(
			`Unknown connector type '${type}'. Built-in: ${builtinTypes().join(', ')}. ` +
				'Plugins are referenced by path, e.g. ./my-bank.ts or ./my-bank.ts#MyBank',
		);
	}
	const [file = '', exportName = 'default'] = type.split('#');
	const full = isAbsolute(file) ? file : resolve(pluginsDir ?? process.cwd(), file);
	const mod = (await import(full)) as Record<string, unknown>;
	const cls = mod[exportName];
	// Duck-typed: a plugin may import Connector through a different module path.
	const proto: unknown = typeof cls === 'function' ? (cls.prototype as unknown) : undefined;
	if (typeof cls !== 'function' || typeof path(proto, 'fetch') !== 'function') {
		throw new Error(`${type}: export '${exportName}' is not a class extending Connector`);
	}
	return cls as ConnectorClass;
}
