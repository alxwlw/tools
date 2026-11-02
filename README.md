# tools

Small standalone tools, one per directory under `apps/`, and shared code under `packages/`. A pnpm + moon monorepo on the
[`@alxwlw/stack`](https://github.com/alxwlw/stack) toolchain canon.

## Tools

- [`apps/plane-hooks`](apps/plane-hooks/README.md) — a multi-tenant Plane App that moves work items along by
  the facts of their pull requests and deploys (GitHub, Vercel, Dokploy) and opens incidents from Grafana
  alerts and failed deploys, builds and backups.
- [`apps/plane-discord`](apps/plane-discord/README.md) — a Bun service that bridges Plane and Discord: Plane
  events into channels and DMs, two message commands (a Discord message into a work item, or into a comment
  on one) and `/plane KEY`, a public card of a work item.
- [`apps/plane-miro`](apps/plane-miro/README.md) — a Bun service that links Plane and Miro: stickers become
  work items, a work item's status shows on its cards on the board, and a Miro link in a comment puts a card there.
- [`apps/plane-graph`](apps/plane-graph/README.md) — a Bun service that keeps a read-only copy of Plane work items
  and relations, draws the order the work can be done in, and serves an agent that adds the missing relations.
- [`apps/wf-sync`](apps/wf-sync/README.md) — a Bun service that syncs crypto exchanges (Binance, OKX, Kraken,
  WhiteBIT), EVM and Solana wallets and Monobank into a self-hosted Wealthfolio, with plugins for any other source.

## Packages

- [`packages/plane-app`](packages/plane-app) — shared Plane App code: bot-token auth (`botTokenAuth`) and the
  install redirect and callback (`planeSetupRedirect`, `planeOauthCallback`).

## Development

```bash
pnpm install
pnpm exec moon run :lint :format :typecheck :test
pnpm exec stack check
```

## License

[MIT](LICENSE)
