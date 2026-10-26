# plane-miro — Plane ↔ Miro service.
# Build context: apps/plane-miro. The service has no runtime dependencies, so nothing is installed.
FROM oven/bun:1.4.2-alpine

WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
# web/ is bundled by Bun.build at start and served by the service itself.
COPY web ./web
COPY scripts ./scripts
# A new named volume copies the owner of this directory from the image; without it SQLite cannot open for writing.
RUN mkdir -p /data && chown bun:bun /data

USER bun
EXPOSE 8080
CMD ["bun", "src/index.ts"]
