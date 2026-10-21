# plane-hooks — Grafana/Vercel/backend-deploy CI → Plane webhook receiver.
FROM oven/bun:1.4.2-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

USER bun
EXPOSE 8080
CMD ["bun", "src/index.ts"]
