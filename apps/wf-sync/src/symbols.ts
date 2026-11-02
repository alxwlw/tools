/** Classification of currency codes coming from exchanges and wallets. */

export const FIAT = new Set([
	'USD',
	'EUR',
	'UAH',
	'GBP',
	'PLN',
	'CHF',
	'CZK',
	'TRY',
	'KZT',
	'GEL',
	'BRL',
	'ARS',
	'AUD',
	'CAD',
	'JPY',
	'CNY',
	'HKD',
	'SGD',
	'AED',
	'INR',
	'MXN',
	'NGN',
	'RON',
	'HUF',
	'SEK',
	'NOK',
	'DKK',
	'ZAR',
	'KRW',
	'IDR',
	'THB',
	'VND',
	'PHP',
	'BGN',
]);

/** USD-pegged stablecoins. With stablecoins_as_cash they become USD cash in Wealthfolio. */
export const USD_STABLES = new Set([
	'USDT',
	'USDC',
	'FDUSD',
	'TUSD',
	'USDP',
	'DAI',
	'BUSD',
	'PYUSD',
	'USDE',
	'USDS',
	'USD1',
	'RLUSD',
	'USDG',
	'USDD',
	'GUSD',
	'LUSD',
	'FRAX',
	'USDB',
	'USDTB',
	'USDC.E',
	'USDT0',
]);

export const isFiat = (code: string) => FIAT.has(code.toUpperCase());
export const isUsdStable = (code: string) => USD_STABLES.has(code.toUpperCase());

/** Normalize exchange-specific wrappers to the underlying asset. */
export function normalizeSymbol(exchange: string, code: string): string {
	let c = code.toUpperCase().trim();
	if (exchange === 'kraken') {
		// Kraken staking/earn sub-balances: "DOT.S", "ETH2.S", "SOL.F", "USD.HOLD", "XBT.M".
		c = c.split('.')[0] ?? c;
		if (c === 'ETH2') c = 'ETH';
		if (c === 'XBT') c = 'BTC';
		if (c === 'XDG') c = 'DOGE';
	}
	return c;
}
