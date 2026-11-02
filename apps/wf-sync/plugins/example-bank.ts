/**
 * Example plugin — copy this file to add any source wf-sync doesn't ship with.
 *
 * config.yaml:
 *   plugins_dir: ./plugins
 *   connectors:
 *     - id: my-bank
 *       type: ./example-bank.ts      # file in plugins_dir; "#ExportName" for a named export
 *       name: My bank
 *       balance: 1000                # any options → this.optional()/this.opt()
 *       currency: EUR
 *
 * Return HOLDINGS accounts (a balance snapshot: `holdings`) or TRANSACTIONS
 * accounts (`transactions` + `currentBalance`); the engine handles accounts,
 * assets, pricing, dedupe and opening balances.
 */

import { type AccountData, Connector, HoldingsSnapshot } from 'wf-sync';

export default class ExampleBank extends Connector {
	async fetch(): Promise<AccountData[]> {
		// A real plugin would call an API here, e.g.:
		//   const data = await this.http("https://api.example.com/balance", {
		//     headers: { authorization: `Bearer ${this.opt("token")}` },
		//   });
		const currency = this.optional<string>('currency', 'EUR');
		const snap = new HoldingsSnapshot();
		snap.addCash(currency, String(this.optional<number>('balance', 0)));

		return [
			{
				key: this.id, // must be stable: it links to the Wealthfolio account
				name: this.displayName('Example bank'),
				currency,
				accountType: 'CASH',
				group: 'Banks',
				holdings: snap,
			},
		];
	}
}
