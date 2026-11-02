/**
 * Public API for plugins. Plugins import it as a bare module from any folder:
 *
 *   import { Connector, HoldingsSnapshot, type AccountData } from "wf-sync";
 *
 * (resolveConnector registers "wf-sync" as a virtual module before loading plugins).
 */

export { Connector, type ConnectorContext } from './connectors/base.ts';
export { rpcBatch } from './connectors/evm.ts';
export { abs, add, cmp, type Dec, fromUnits, isZero, neg, sub, toNumber } from './decimal.ts';
export { HttpError, request, requestJson, type RequestOptions, sleep } from './http.ts';
export {
	type AccountData,
	type AccountType,
	type CashTransaction,
	HoldingsSnapshot,
	type Position,
} from './models.ts';
