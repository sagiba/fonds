# Two images from one build. Each final stage installs only its target's
# deploy manifest, so an image carries a single database driver.
#   docker build --target postgres -t fonds:postgres .   hosted service
#   docker build -t fonds .                               SQLite (default, last stage)

FROM node:24.22.0-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /src
COPY package.json package-lock.json LICENSE NOTICE ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY deploy/sqlite ./deploy/sqlite
COPY deploy/postgres ./deploy/postgres
COPY tests/providers/cal/fixtures/recent-01.json tests/providers/cal/fixtures/recent-02.json ./tests/providers/cal/fixtures/
RUN node scripts/build-targets.mjs sqlite postgres

# The hosted service: OAuth issuer, API/MCP, scheduled collection and Events.
FROM node:24.22.0-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS postgres
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 FONDS_STATE_DIR=/data
WORKDIR /app
COPY --from=build /src/dist/targets/postgres/ ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force \
  && install -d -m 0700 -o node -g node /data
USER node
VOLUME /data
EXPOSE 8787
# No subcommand serves (`--transport stdio` serves MCP over stdio); every
# operator command (docs/guides/local-development.md#operator-commands) and
# operation command runs against the same database and state directory.
ENTRYPOINT ["node", "/app/server.js"]

# Local-first SQLite: the owner CLI, `serve` (stdio or loopback HTTP). The
# default ledger and its state (fonds.env) live in the /data volume.
FROM node:24.22.0-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS sqlite
ENV NODE_ENV=production FONDS_HOME=/data
WORKDIR /app
COPY --from=build /src/dist/targets/sqlite/ ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force \
  && ln -s /app/fonds.mjs /usr/local/bin/fonds \
  && install -d -m 0700 -o node -g node /data
USER node
WORKDIR /data
VOLUME /data
ENTRYPOINT ["fonds"]
CMD ["--help"]
