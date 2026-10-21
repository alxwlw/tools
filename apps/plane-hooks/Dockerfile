# plane-hooks — Grafana/Vercel/backend-deploy CI → Plane webhook receiver.
# Build context: apps/plane-hooks. The service has no runtime dependencies, so nothing is installed.
FROM oven/bun:1.4.2-alpine

WORKDIR /app
COPY tsconfig.json ./
COPY src ./src

USER bun
EXPOSE 8080
CMD ["bun", "src/index.ts"]
