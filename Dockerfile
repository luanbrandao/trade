FROM node:20-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --include=dev


FROM node:20-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -r trade && useradd -r -g trade -d /app -s /usr/sbin/nologin trade

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

RUN mkdir -p /app/data /app/logs \
 && chown -R trade:trade /app

USER trade

ENV NODE_ENV=production \
    DB_PATH=/app/data/trade.db \
    DASHBOARD_HOST=0.0.0.0 \
    DASHBOARD_PORT=8787

EXPOSE 8787

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "node_modules/ts-node/dist/bin.js", "src/cli.ts", "dryrun"]
