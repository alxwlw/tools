# wf-sync — exchanges, wallets and Monobank → Wealthfolio.
# Build context: apps/wf-sync. Unlike the other tools it has runtime dependencies (ccxt, yaml),
# pinned exactly in package.json; the dev-only catalog entries are dropped before install.
FROM oven/bun:1.4.4-alpine

WORKDIR /app
COPY package.json ./
RUN bun -e 'const p = await Bun.file("package.json").json(); delete p.devDependencies; await Bun.write("package.json", JSON.stringify(p));' \
	&& bun install --production --ignore-scripts \
	&& rm -rf /root/.bun/install/cache
COPY tsconfig.json ./
COPY src ./src
COPY plugins ./plugins
# state.json lives here; a new named volume copies this directory's owner from the image.
RUN mkdir -p /app/data && chown bun:bun /app/data

USER bun
# Same layout as a checkout: config.yaml next to plugins/ and data/, so relative paths
# in the config work in both places.
ENV WF_SYNC_CONFIG=/app/config.yaml
ENTRYPOINT ["bun", "src/cli.ts"]
CMD ["daemon"]
