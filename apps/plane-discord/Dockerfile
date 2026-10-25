# plane-discord — Plane ↔ Discord bridge.
# Build context: apps/plane-discord. The service has no runtime dependencies, so nothing is installed.
FROM oven/bun:1.4.2-alpine

WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
# scripts/ stays: runbooks run register-commands.ts and list-channels.ts through docker exec.
COPY scripts ./scripts
# A new named volume copies the owner of this directory from the image; without it SQLite cannot open for writing.
RUN mkdir -p /data && chown bun:bun /data

USER bun
EXPOSE 8080
CMD ["bun", "src/index.ts"]
