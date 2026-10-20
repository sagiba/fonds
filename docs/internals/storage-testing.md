# Reproduce storage acceptance tests

Use disposable synthetic databases only. The isolated Turso child-process smoke test also requires `openssl` to generate a temporary local TLS certificate; it uses a trusted local HTTPS proxy without disabling certificate verification. The normal suite runs SQLite and local libSQL without external services. PostgreSQL and actual libSQL HTTP tests opt in through environment variables; the large-capture case has a separate HTTP server profile. These are development test services, not a production operating model. The [workflow files](../../.github/workflows/) define what CI runs; this page reproduces it.

## PostgreSQL

The implementation was exercised against PostgreSQL 18.6 using a disposable Docker container. A local PostgreSQL installation is also suitable. Create an isolated test container, for example:

```sh
docker run --rm -d --name fonds-storage-postgres-test \
  -e POSTGRES_PASSWORD=synthetic-test-only \
  -p 127.0.0.1::5432 postgres:18.6
docker port fonds-storage-postgres-test 5432
```

Set `FONDS_TEST_POSTGRES_URL` to that synthetic database’s published address. In a Docker-backed devcontainer, the published host may be `host.docker.internal`; outside it, use `127.0.0.1`. The password above is an invented test value, never a production credential. Fonds owns every schema of its database, so the PostgreSQL storage tests and the isolated deployment verifier create and drop a unique database per case; the test role needs `CREATEDB`, and the migration tests install an event trigger, which needs a superuser. The deployment verifier rejects nonlocal database hosts. The PostgreSQL superuser in this disposable container meets both requirements; a production role should not inherit these test privileges.

`FONDS_TEST_REQUIRE_POSTGRES=1` enables `tests/storage/postgres-required.test.ts`: an absent/blank `FONDS_TEST_POSTGRES_URL` or a host other than `localhost`, `127.0.0.1`, `[::1]` or `host.docker.internal` fails, and a real `SELECT 1` must succeed with a three-second connection timeout. Without the require flag, this guard skips and local `npm run check` retains its optional PostgreSQL behavior. Setting a URL still enables the existing real-driver tests, which create and drop schemas and databases on it; the host check fails the run but does not stop other suites, so only ever export a disposable URL. The flag does not supply a default database.

The `Check` workflow's `postgres` job runs the storage suites against a health-checked `postgres:18.6` service container with an invented password, a loopback test URL and only committed synthetic fixtures, and the `package` job runs the installed npm package's PostgreSQL modes (`npm run check:npm`). To reproduce its storage run after setting the disposable test URL:

```sh
export FONDS_TEST_REQUIRE_POSTGRES=1
npm test -- tests/storage --no-file-parallelism \
  --reporter=default --reporter=json \
  --outputFile=/tmp/fonds-postgres-results.json
node scripts/check-postgres-tests.mjs /tmp/fonds-postgres-results.json
unset FONDS_TEST_REQUIRE_POSTGRES
```

The report verifier ([`check-postgres-tests.mjs`](../../scripts/check-postgres-tests.mjs), using [`storage-coverage.mjs`](../../scripts/storage-coverage.mjs)) lists the required PostgreSQL groups and their minimum case counts. It rejects a missing group, any skipped or failed PostgreSQL case and other unexpected skips; in this run only the libSQL HTTP groups and the local D1 group may skip. New passing cases need no update; intentional coverage removals require reviewing its floors. File serialization keeps this run aligned with the full matrix below; individual tests still exercise independent sessions and concurrent writers.

## libSQL HTTP

The `Experimental targets` workflow's `libsql` job starts two disposable servers from the official image (`ghcr.io/tursodatabase/libsql-server`, pinned by version and digest in `scripts/libsql-test-servers.sh`) with the profiles below, runs `tests/storage` serially and verifies the report with [`check-libsql-tests.mjs`](../../scripts/check-libsql-tests.mjs), which requires every listed libSQL HTTP group to run and pass and allows only PostgreSQL-only and local D1 groups to skip. It then runs the Turso launcher from an isolated install (`npm run check:targets -- turso --runtime`). Each `libsql-http` case starts from an empty server database. To reproduce it, start the same servers with Docker. On a host with Docker, the published ports are on `127.0.0.1` (the default). Inside a Docker-backed devcontainer, set `FONDS_LIBSQL_HOST=host.docker.internal` instead:

```sh
eval "$(scripts/libsql-test-servers.sh start)"
npm test -- tests/storage --no-file-parallelism \
  --reporter=default --reporter=json --outputFile=/tmp/fonds-libsql-results.json
node scripts/check-libsql-tests.mjs /tmp/fonds-libsql-results.json
scripts/libsql-test-servers.sh stop
```

### A downloaded server

The exercised server was the official [libSQL server v0.24.32 release](https://github.com/tursodatabase/libsql/releases/tag/libsql-server-v0.24.32). Download the archive for the machine architecture and verify its published checksum before extracting it outside the repository. The tested Linux AArch64 archive SHA-256 was `37f9eee45b388a30192907ecf4565b93df945c079331657073b5b3caf8bb1cd0`. Set `FONDS_SQLD` to the extracted `sqld` binary. Start two servers in fresh scratch directories, with unused loopback ports. This example uses ports 18080–18083:

```sh
FONDS_TEST_ROOT=$(mktemp -d /tmp/fonds-storage-test.XXXXXX)
"$FONDS_SQLD" --db-path "$FONDS_TEST_ROOT/default" \
  --http-listen-addr 127.0.0.1:18080 \
  --admin-listen-addr 127.0.0.1:18081 \
  > "$FONDS_TEST_ROOT/default.log" 2>&1 &
FONDS_SQLD_DEFAULT_PID=$!
"$FONDS_SQLD" --db-path "$FONDS_TEST_ROOT/large" \
  --http-listen-addr 127.0.0.1:18082 \
  --admin-listen-addr 127.0.0.1:18083 \
  --max-response-size 256MB --max-total-response-size 256MB \
  > "$FONDS_TEST_ROOT/large.log" 2>&1 &
FONDS_SQLD_LARGE_PID=$!
```

Wait for both servers to be ready. **Only on the fresh disposable large-test server above**, replace its empty default namespace with the explicit large-test profile:

```sh
curl --fail --request DELETE http://127.0.0.1:18083/v1/namespaces/default
curl --fail --request POST \
  --header 'Content-Type: application/json' \
  --data '{"max_row_size":134217728,"txn_timeout_s":60}' \
  http://127.0.0.1:18083/v1/namespaces/default/create
export FONDS_TEST_LIBSQL_HTTP_URL=http://127.0.0.1:18080
export FONDS_TEST_LIBSQL_LARGE_HTTP_URL=http://127.0.0.1:18082
```

Do not run that namespace deletion against an existing database or reuse a private runtime directory. The ordinary profile retains the server’s default row-size and transaction limits; its contested transaction-expiry test relies on the default five-second deadline. The larger profile permits a 128 MiB row and a 60-second transaction, enough for its test to apply a 64 MiB synthetic response (10,000 invented transactions padded with valid JSON whitespace) in one atomic run. The default server rejected the approximately 10 MB unpadded 10,000-row capture at retention with `ARGS_INVALID`, under its default 5 MB row limit. The configured profile’s success does not establish managed Turso quotas or allow splitting an atomic run into independent commits. A production host/database must be checked for the actual response, row, message and transaction limits it permits.

## Local Cloudflare D1

The experimental D1 adapter runs against local D1 in workerd through Miniflare; no account, network service or Wrangler login is involved. The `Experimental targets` workflow's `d1` job runs the commands below and the `d1-web` [target check](#run-the-matrix-and-isolated-builds); real Cloudflare D1 remains unverified. It is off by default. Miniflare is pinned in its own `tests/d1-local/` package, so the root `npm ci` does not install it. Install it once, then set `FONDS_TEST_D1=1` to add the `d1-local` backend to the shared storage suites and run the D1-specific tests:

```sh
npm ci --prefix tests/d1-local
FONDS_TEST_D1=1 npx vitest run tests/storage/d1.test.ts tests/tooling/d1-worker.test.mjs
FONDS_TEST_D1=1 npx vitest run tests/storage/backends.test.ts tests/storage/contract.test.ts tests/storage/statement-counts.test.ts -t d1-local
```

Each case creates a fresh in-memory D1 database and applies `migrations/d1/` in order. See [the D1 storage note](d1-storage.md) for what this does and does not verify.

## Run the matrix and isolated builds

The [layout guide](repository-layout.md) maps the test suites. With all three test URL variables set, run:

```sh
npm run typecheck
npm test -- --no-file-parallelism
npm run build
npm run format:check
npm run check:targets -- --runtime
```

File serialization avoids unrelated test files competing with the intentionally expired libSQL transaction or transient rollback triggers. Individual tests still exercise concurrent writers, separate pools and expected-version/cursor races. Synthetic runtime files stay under `/tmp`. `npm run check:npm` installs the npm package away from the repository and exercises its SQLite and PostgreSQL launchers; the isolated build verifier does the same for each experimental target's recipe, emitting declarations and checking the compiled module graph and installed production dependencies. `turso-web` is a bundled storage/application module and is checked for importability and absence of Node/native execution dependencies; it is not a deployed HTTP server. The experimental `d1-web` bundle gets the same checks, but only when named: `npm run check:targets -- d1-web`.

## Synthetic performance checks

Run reconciliation timing against invented data on the selected disposable driver (PostgreSQL uses the `FONDS_TEST_POSTGRES_URL` above):

```sh
npm run benchmark:reconciliation -- --backend sqlite
npm run benchmark:reconciliation -- --backend libsql
npm run benchmark:reconciliation -- --backend postgres
```

Each command measures three unchanged refreshes for 1,000/10,000 rows and 1/500 prior runs. Historical captures duplicate body-free receipts and normalized timestamps without copying source bodies. Setup and cleanup are outside timing; cleanup runs on failure too. libSQL here uses the local file driver; actual HTTP behavior, contention and 64 MiB captures have separate acceptance tests. Compare the same script and fixtures on both revisions. Query budgets and these local timings do not certify managed-service latency or quotas.

## Clean up

Stop only the synthetic services you started when testing is complete:

```sh
kill "$FONDS_SQLD_DEFAULT_PID" "$FONDS_SQLD_LARGE_PID"
docker stop fonds-storage-postgres-test
```

The scratch directory contains only synthetic test databases and logs and can then be removed. Hosted backup/restore, live collection and active-ledger migration are outside this acceptance run.
