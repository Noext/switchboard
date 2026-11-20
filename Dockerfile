# syntax=docker/dockerfile:1
FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

FROM node:26-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public && npm run build

FROM node:26-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    SWITCHBOARD_DATA_DIR=/data \
    SWITCHBOARD_PORT=3000 \
    HOSTNAME=0.0.0.0

# Tools needed to launch stdio MCP servers (npx / uvx / git).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git ca-certificates curl unzip \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && ln -sf /usr/local/bin/uv /usr/local/bin/uvx \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Non-root user; /data is a bind mount (chown at start with a tiny entrypoint).
RUN groupadd -g 1001 switchboard && useradd -u 1001 -g switchboard -m -s /bin/sh switchboard \
    && mkdir -p /data && chown -R switchboard:switchboard /data /app

COPY --from=build --chown=switchboard:switchboard /app/.next ./.next
COPY --from=build --chown=switchboard:switchboard /app/node_modules ./node_modules
COPY --from=build --chown=switchboard:switchboard /app/dist ./dist
# public/ may be empty (no static assets yet); create it so the COPY never fails.
RUN mkdir -p /app/public
COPY --from=build --chown=switchboard:switchboard /app/public ./public
COPY --from=build --chown=switchboard:switchboard /app/package.json ./package.json
COPY --from=build --chown=switchboard:switchboard /app/next.config.ts ./next.config.ts

USER switchboard
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
