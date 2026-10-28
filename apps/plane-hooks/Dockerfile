# plane-hooks — Plane App hub: GitHub, Vercel, Dokploy and Grafana → Plane work items.
# Build context: the repository root (docker build -f apps/plane-hooks/Dockerfile .): the image carries
# packages/plane-app as its only dependency, copied as source. Nothing is installed.
FROM oven/bun:1.4.2-alpine

WORKDIR /app
COPY apps/plane-hooks/tsconfig.json ./
COPY apps/plane-hooks/src ./src
# scripts/ stays: runbooks run inbox.ts, journal.ts, replay.ts and probe-plane.ts through docker exec.
COPY apps/plane-hooks/scripts ./scripts
COPY packages/plane-app/package.json ./node_modules/@alxwlw/plane-app/package.json
COPY packages/plane-app/src ./node_modules/@alxwlw/plane-app/src
# A new named volume copies the owner of this directory from the image; without it SQLite cannot open for writing.
RUN mkdir -p /data && chown bun:bun /data

USER bun
EXPOSE 8080
CMD ["bun", "src/index.ts"]
