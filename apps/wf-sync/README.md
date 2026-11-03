# wf-sync

A [Bun](https://bun.sh) service that keeps a self-hosted [Wealthfolio](https://wealthfolio.app) up to date
with balances and transactions from crypto exchanges, on-chain wallets and Monobank, so net worth and
savings plans stay current without manual entry. It talks to Wealthfolio through its REST API (`/api/v1`).

| Source                                                                                       | Becomes in Wealthfolio                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Binance, OKX, Kraken, WhiteBIT (and any other [ccxt](https://github.com/ccxt/ccxt) exchange) | a **Holdings** account: a balance snapshot every run, Spot + Funding + Earn          |
| EVM and Solana wallets, through the [Zerion API](https://developers.zerion.io)               | a **Holdings** account per address: every token that has a price, on every chain     |
| TRON wallets, through the public TronGrid API                                                | a **Holdings** account per address: TRX, staked TRX, USDT and USDC                   |
| Bitcoin addresses, through the public mempool.space API                                      | a **Holdings** account per address                                                   |
| Monobank cards                                                                               | a **Transactions** cash account: each operation imported once, exact opening balance |
| Monobank jars ("банки")                                                                      | a savings account with a balance snapshot                                            |
| Cash and anything without an API                                                             | the `manual` connector: amounts from the config                                      |
| Anything else                                                                                | your own plugin, one `.ts` file                                                      |

Exchange keys are read-only. Wallets need only a public address; EVM and Solana also a free Zerion API key.

## Why a service and not a Wealthfolio addon

Wealthfolio addons run in a sandboxed iframe and only when their page is open, so they can't sync on a
schedule. wf-sync runs next to Wealthfolio (web/server mode) as its own process.

## Quick start (Docker Compose)

```bash
cp .env.example .env              # passwords, exchange keys, Monobank token
cp config.example.yaml config.yaml
# .env: WF_PASSWORD, its argon2id hash WF_AUTH_PASSWORD_HASH, WF_SECRET_KEY (commands are in the file)
# config.yaml: keep the connectors you use, fill in wallet addresses
docker compose run --rm wf-sync check     # Wealthfolio login + every connector
docker compose run --rm wf-sync dry-run   # what would be written, nothing is written
docker compose up -d                      # Wealthfolio + a sync every interval_minutes
```

Wealthfolio is on http://localhost:8088. Already running one? Drop the `wealthfolio` service and point
`wealthfolio.url` in `config.yaml` at it. The desktop app has no HTTP API; the server build does.

A fresh Wealthfolio whose onboarding was skipped has no base currency, and then values nothing; wf-sync
sets it to `base_currency` from the config (USD by default). Change it in Wealthfolio settings at any time.

## On Dokploy

[`deploy/`](deploy) runs the same two services as a Dokploy compose app, for a host with Docker, Tailscale
and read access to 1Password. The UI stays off the internet: Wealthfolio listens on `127.0.0.1:8088` and
`tailscale serve` publishes it to the tailnet on port 8445.

1. In Dokploy, create an API key. Where `op` can write, run `deploy/op-init.sh`: it creates the 1Password
   item with a generated password and encryption key. **Without `WF_SECRET_KEY` neither the database nor
   its backups can be opened.**
2. Write `~/.config/wf-sync/config.yaml` from `config.example.yaml`. It holds no secrets, only `${NAME}`.
3. Publish the UI once: `sudo tailscale serve --bg --https=8445 http://127.0.0.1:8088`.
4. From `apps/wf-sync/deploy`, run `dokploy-rollout.sh`. It finds or creates the app, replaces its env and
   config, deploys and runs `check`. Run it again after any change to the item or the config.

To switch a connector on, add its variables to the 1Password item (one field per variable, named as in
`docker-compose.dokploy.yml`), add the connector to `config.yaml`, and run the rollout. A `${NAME}` that
isn't set stops the whole config from loading, not only that connector.

## Without Docker

```bash
pnpm install                      # from the repository root
cd apps/wf-sync
bun src/cli.ts check
bun src/cli.ts run                # one pass; exit code 2 if a connector failed
bun src/cli.ts daemon             # a pass every interval_minutes
bun src/cli.ts dry-run            # fetch and print, write nothing
```

`-v` turns on debug logging; the config path is `-c path` or `WF_SYNC_CONFIG` (default `config.yaml`).

## Keys and tokens

- **Binance:** API Management → Create API → only _Enable Reading_. Earn is read with the same key.
- **OKX:** API → Create → _Read_ only, set a passphrase.
- **Kraken:** Settings → API → _Query Funds_ and _Query Ledger Entries_.
- **WhiteBIT:** API keys → read-only.
- **Monobank:** https://api.monobank.ua/ → "Отримати токен" (confirmed in the app).
- **Zerion:** https://developers.zerion.io → create a key in the dashboard.

Restrict keys to the server's IP wherever the exchange allows it.

## How a run works

1. Every connector reports the current state of its accounts. One failing connector is logged; the others
   still sync.
2. Positions are normalized: stablecoins become USD cash (`stablecoins_as_cash`); dust below
   `min_value_usd` and unpriceable tokens are dropped; Kraken staking suffixes (`DOT.S`, `ETH2.S`) and
   Binance `LD*` earn shares collapse into the base coin.
3. Accounts are found or created in Wealthfolio, tagged `provider = WF_SYNC` with a stable key, so they
   can be renamed in the UI.
4. Holdings accounts get today's snapshot (one per day, updated in place); one coin is one asset across
   all accounts.
5. Transactions accounts get only new operations, deduplicated by operation id and `idempotencyKey`.
   After a lost `state.json` or a crash mid-write, operations already in Wealthfolio are skipped, not
   duplicated; the Monobank cursor moves only after a successful write.

### Prices

Coins are `CRYPTO` assets quoted in USD, and Wealthfolio prices the common ones itself (Yahoo `BTC-USD`).
If its providers return no quote at all within 6 hours (an obscure token), wf-sync switches the asset to
`MANUAL` and writes its own price every run: Zerion's for wallets, public exchange tickers (no keys)
otherwise. An asset that had quotes and only went stale is left alone and logged.
Symbols in `pricing.manual_symbols` are priced by wf-sync from the start (WBT is not on Yahoo).

### Monobank

- A card is a cash account: spending is `WITHDRAWAL`, income `DEPOSIT`, moves between your own cards and
  into jars `TRANSFER_OUT` / `TRANSFER_IN`, so spending analytics count them as savings, not expenses.
- Balances are own funds: the credit limit is subtracted.
- The opening balance comes from the `balance` field of the earliest operation: a positive one is a
  `CREDIT` (neither income nor spending), a negative one a `TRANSFER_OUT`.
- After each import the balance is reconciled with the bank's. A difference (a hold that settled for
  another amount, say) becomes an adjustment flagged _needs review_: `CREDIT` when there's more money,
  `WITHDRAWAL` when there's less. (Wealthfolio's `ADJUSTMENT` type does not move cash.) A credit limit
  that changed inside the history window can cause one false adjustment; delete it.
- The API allows one request a minute: the first import takes a minute per 31 days of history per card,
  later runs one request per card.

## Your own connector (plugin)

Copy [`plugins/example-bank.ts`](plugins/example-bank.ts):

```ts
import { Connector, HoldingsSnapshot, type AccountData } from 'wf-sync';

export default class MyBank extends Connector {
	async fetch(): Promise<AccountData[]> {
		const data = await this.http<{ balance: number }>('https://api.my-bank.com/balance', {
			headers: { authorization: `Bearer ${this.opt('token')}` },
		});
		const snap = new HoldingsSnapshot();
		snap.addCash('EUR', String(data.balance));
		return [
			{
				key: this.id,
				name: this.displayName('My bank'),
				currency: 'EUR',
				accountType: 'CASH',
				holdings: snap,
			},
		];
	}
}
```

```yaml
plugins_dir: ./plugins
connectors:
  - id: my-bank
    type: ./my-bank.ts # or ./my-bank.ts#NamedExport
    token: ${MY_BANK_TOKEN} # this.opt('token')
```

`import … from 'wf-sync'` works from any folder: wf-sync registers the module before loading plugins. It
exports `Connector`, `HoldingsSnapshot`, decimal helpers (`add`, `fromUnits`, …) and
`requestJson`. Return a snapshot (`holdings`: positions + cash) or operations (`transactions` +
`currentBalance`); the engine does accounts, assets, prices, dedupe, opening balance and reconciliation.
`this.stored(key, init)` is persistent per-connector state (cursors); `onSynced()` runs after a successful
write.

## Limits

- **Cost basis.** Exchange snapshots don't carry it, so per-position gains in Wealthfolio are not real
  P&L. Total value and its history are correct; history starts with the first run.
- **Wallets depend on Zerion.** It sees the addresses you track. A run makes one request per address, and
  the free plan allows 2000 a day. An API error fails the connector instead of writing a zero snapshot.
- **What a wallet account leaves out.** Tokens with no price, and rent locked in Solana token accounts. Debt
  isn't counted either, only logged as a warning, and Zerion has no protocol positions for Solana.
- **TRON and Bitcoin.** TRON reads TRX, USDT and USDC only: its other token balances are mostly airdropped
  spam. Bitcoin reads the listed addresses only, so a wallet that moves change to new addresses of its own
  holds more than they show.
- **Protocol positions can overlap.** A receipt token in the wallet (Aave's aToken, say) counts beside its
  deposit. Debt isn't subtracted.
- **Unverified tokens** that have a price show with part of their contract in the symbol
  (`SOL-USDC-8HOQNE`), so a fake USDT can't count as cash. Their value is whatever Zerion reports.

## Development

```bash
pnpm exec moon run wf-sync:lint wf-sync:format wf-sync:typecheck wf-sync:test
```

Tests run every connector and the engine against mocked APIs (exchanges, Zerion, TronGrid, mempool.space,
Monobank, DefiLlama, Wealthfolio). The engine was also checked against a locally built Wealthfolio server.

```text
src/
  cli.ts            run / daemon / dry-run / check
  engine.ts         one sync pass
  wealthfolio.ts    Wealthfolio REST client
  pricing.ts        prices: stablecoins → the source's own → DefiLlama → exchange tickers
  connectors/       binance/okx/kraken/whitebit (ccxt), zerion, tron, bitcoin, monobank, manual
  sdk.ts            the 'wf-sync' module plugins import
plugins/            your connectors
```
