/**
 * Data model shared by connectors and the sync engine.
 *
 * A connector returns AccountData[]; each one becomes (or updates) one
 * Wealthfolio account:
 *  - `holdings` set     → HOLDINGS tracking mode; every run writes today's
 *                         balance snapshot (positions + cash).
 *  - `transactions` set → TRANSACTIONS tracking mode; new cash operations are
 *                         imported once, deduplicated by CashTransaction.id.
 */

import { add, type Dec } from './decimal.ts';

export type AccountType = 'CRYPTOCURRENCY' | 'CASH' | 'SECURITIES';

export interface Position {
	/** Ticker as Wealthfolio should show it, e.g. "BTC". */
	symbol: string;
	quantity: Dec;
	name?: string;
	/**
	 * DefiLlama coin id used when Wealthfolio can't price the asset itself:
	 * "coingecko:bitcoin", "ethereum:0xa0b8…", "solana:<mint>".
	 */
	priceRef?: string;
	/** Exchange id whose public ticker is the most natural price source. */
	priceExchange?: string;
	/** USD price the source reports itself; no lookup is made for it. */
	priceUsd?: number | undefined;
}

export class HoldingsSnapshot {
	positions: Position[] = [];
	cash: Record<string, Dec> = {};

	addPosition(p: Position): void {
		const existing = this.positions.find((x) => x.symbol === p.symbol);
		if (!existing) {
			this.positions.push({ ...p });
			return;
		}
		existing.quantity = add(existing.quantity, p.quantity);
		existing.priceRef ??= p.priceRef;
		existing.priceExchange ??= p.priceExchange;
		existing.priceUsd ??= p.priceUsd;
		existing.name ??= p.name;
	}

	addCash(currency: string, amount: Dec): void {
		this.cash[currency] = add(this.cash[currency] ?? '0', amount);
	}

	merge(other: HoldingsSnapshot): void {
		for (const p of other.positions) this.addPosition(p);
		for (const [ccy, amt] of Object.entries(other.cash)) this.addCash(ccy, amt);
	}
}

export interface CashTransaction {
	/** Stable unique id from the source — used for deduplication. */
	id: string;
	time: Date;
	/** Signed amount in the account currency, major units. */
	amount: Dec;
	currency: string;
	description?: string;
	/** Own-funds balance right after this operation, if the source reports it. */
	balanceAfter?: Dec;
	mcc?: number;
	metadata?: Record<string, unknown>;
}

export interface AccountData {
	/** Stable unique key, e.g. "binance" or "monobank:abc123". */
	key: string;
	name: string;
	/** Account currency (ISO code). */
	currency: string;
	accountType: AccountType;
	group?: string;
	holdings?: HoldingsSnapshot;
	transactions?: CashTransaction[];
	/** TRANSACTIONS accounts: own-funds balance reported by the source right now. */
	currentBalance?: Dec;
}

/** A Wealthfolio rule that sorts spending into a category when a regex matches the note. */
export interface SpendingRule {
	id: string;
	name: string;
	pattern: string;
	categoryId: string;
}

export const trackingMode = (a: AccountData): 'HOLDINGS' | 'TRANSACTIONS' =>
	a.transactions ? 'TRANSACTIONS' : 'HOLDINGS';
