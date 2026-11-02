/**
 * Static balances from config — handy for cash or anything without an API,
 * and the smallest possible example of a connector.
 *
 *   - id: cash
 *     type: manual
 *     name: Наличка
 *     currency: UAH
 *     cash: { UAH: 12000, USD: 300 }
 *     positions: { BTC: 0.01 }        # optional, e.g. a paper/hardware wallet you don't want to expose
 */

import { type AccountData, HoldingsSnapshot } from '../models.ts';
import { Connector } from './base.ts';

export class ManualConnector extends Connector {
	fetch(): Promise<AccountData[]> {
		const snap = new HoldingsSnapshot();
		for (const [ccy, amount] of Object.entries(
			this.optional<Record<string, number | string>>('cash', {}),
		)) {
			snap.addCash(ccy.toUpperCase(), String(amount));
		}
		for (const [sym, qty] of Object.entries(
			this.optional<Record<string, number | string>>('positions', {}),
		)) {
			snap.addPosition({ symbol: sym.toUpperCase(), quantity: String(qty) });
		}
		return Promise.resolve([
			{
				key: this.id,
				name: this.displayName('Cash'),
				currency: this.optional<string>('currency', 'USD').toUpperCase(),
				accountType: snap.positions.length ? 'CRYPTOCURRENCY' : 'CASH',
				group: this.optional<string>('group', 'Cash'),
				holdings: snap,
			},
		]);
	}
}
