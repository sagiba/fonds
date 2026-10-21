# One image: the npm package's `fonds` command. SQLite by default; with a
# postgresql:// FONDS_DATABASE_URL, the PostgreSQL commands, local servers and
# (`fonds serve --hosted`) the hosted service. The ledger and installation
# state live in the /data volume.
#   docker build -t fonds .
# The `package` stage packs the npm tarball from source; a build that already
# has a tested tarball supplies it instead, so the image installs those bytes:
#   docker build --build-context package=<directory with fonds.tgz> -t fonds .

FROM node:24.22.0-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS pack
WORKDIR /src
COPY package.json package-lock.json LICENSE NOTICE ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY deploy/npm ./deploy/npm
COPY tests/providers/cal/fixtures/recent-01.json tests/providers/cal/fixtures/recent-02.json ./tests/providers/cal/fixtures/
RUN node scripts/npm-package.mjs && mkdir /package \
  && cp dist/npm/fonds-finance-*.tgz /package/fonds.tgz

FROM scratch AS package
COPY --from=pack /package/fonds.tgz /fonds.tgz

FROM node:24.22.0-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
# HOST applies only to the hosted service; local servers bind loopback.
ENV NODE_ENV=production FONDS_HOME=/data FONDS_STATE_DIR=/data HOST=0.0.0.0 PORT=8787
RUN --mount=type=bind,from=package,target=/package \
  npm install --global --ignore-scripts --no-audit --no-fund /package/fonds.tgz \
  && npm cache clean --force \
  && install -d -m 0700 -o node -g node /data
USER node
WORKDIR /data
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["fonds"]
CMD ["--help"]
