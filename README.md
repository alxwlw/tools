# tools

Small standalone tools, one per directory under `apps/`. A pnpm + moon monorepo on the
[`@alxwlw/stack`](https://github.com/alxwlw/stack) toolchain canon.

## Tools

- [`apps/plane-hooks`](apps/plane-hooks/README.md) — a Bun webhook receiver that turns Grafana, Vercel and CI
  events into Plane work items and comments.
- [`apps/plane-discord`](apps/plane-discord/README.md) — a Bun service that bridges Plane and Discord: Plane
  events into channels and DMs, a message command that turns a Discord message into a work item.

## Development

```bash
pnpm install
pnpm exec moon run :lint :format :typecheck :test
pnpm exec stack check
```

## License

[MIT](LICENSE)
