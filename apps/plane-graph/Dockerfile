# plane-graph — read-only copy of Plane work items and relations, an order graph and agent endpoints.
# Build context: the repository root (docker build -f apps/plane-graph/Dockerfile .): the image carries
# packages/plane-app as its only dependency, copied as source. Nothing is installed.
FROM oven/bun:1.4.2-alpine

WORKDIR /app
COPY apps/plane-graph/tsconfig.json ./
COPY apps/plane-graph/src ./src
# web/ is bundled by Bun.build at start and served by the service itself.
COPY apps/plane-graph/web ./web
COPY apps/plane-graph/scripts ./scripts
COPY packages/plane-app/package.json ./node_modules/@alxwlw/plane-app/package.json
COPY packages/plane-app/src ./node_modules/@alxwlw/plane-app/src
# A new named volume copies the owner of this directory from the image; without it SQLite cannot open for writing.
RUN mkdir -p /data && chown bun:bun /data

USER bun
EXPOSE 8080
CMD ["bun", "src/index.ts"]
