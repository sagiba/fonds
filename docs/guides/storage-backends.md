# Storage backends and deployment targets

Fonds supports two backends, SQLite and PostgreSQL, through the same financial
planners and application operations. Turso/libSQL server, `turso-web` and
Cloudflare D1 are experimental targets that reuse the SQLite-family stores without
a parity commitment. Backend choice is static: there is no runtime registry,
fallback database or cross-database restore. The [hosted service](hosted-service.md)
runs on PostgreSQL on any Node host, such as [Docker](docker.md) or
[Neon](neon-deployment.md), and each new deployment needs its own acceptance.

## What changes when choosing a database

Every backend holds the same seven financial tables and the same
[commit boundaries](../database.md#commit-boundaries); the
[database reference](../database.md) explains them and why the dialects differ.
Selecting a backend adds no copy of the financial rules.

| Choice                      | Where the data lives                                  | How the service uses it                                                                                                            |
| --------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| SQLite                      | A private database file on the Node process's machine | Interactive write transactions on one queued connection; [backups](../database.md#state-directory-and-backup)                      |
| Turso/libSQL (experimental) | A remote libSQL database                              | The web client over an encrypted connection, with interactive write transactions and bounded bulk statements inside one atomic run |
| PostgreSQL                  | A PostgreSQL server                                   | `pg` on a dedicated connection, with the [connection-row lock](../database.md#commit-boundaries)                                   |
| D1 (experimental)           | Cloudflare D1, as a library only                      | One guarded atomic batch per store transaction; see [the D1 note](../internals/d1-storage.md)                                      |

Refreshes (API, CLI and scheduled) and Events delivery behave the
same on SQLite and PostgreSQL: the SQLite server, the PostgreSQL launchers and the
hosted service offer refreshes, and only the `get_refresh` read
[resumes](../api.md#refreshes) interrupted work. Turso and D1 share the SQLite
lease and stores, but no Turso or D1 launcher composes refresh, and the Turso
target has no refresh command. Reuse one store handle per local SQLite file in
a process; closing it drains queued work and rejects new work.

## Build one backend

Use Node 24.11 or newer and the root locked development installation, then build
one target from the table below:

```sh
npm ci
npm run build:targets -- turso # or sqlite, postgres, turso-web, d1-web
```

Each command builds only the named target under `dist/targets/<target>/`. With no
target argument, the script builds all targets except the experimental `d1-web`.
SQLite and PostgreSQL ship as the `fonds` package and image. For an experimental
target, install its directory's manifest and lockfile:

```sh
cd dist/targets/turso
npm ci --omit=dev --omit=optional
node server.js
```

Do not copy the root development `node_modules` into a deployment: development
installs every test driver, while each deployment manifest selects its dependency
closure, which the [isolated build verifier](../internals/storage-testing.md#run-the-matrix-and-isolated-builds)
checks.

| Target      | Database runtime dependency | Entry behavior                                                                                   |
| ----------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| `sqlite`    | `@libsql/client/sqlite3`    | Private-file SQLite HTTP/stdio launcher and CLI                                                  |
| `postgres`  | `pg`                        | Loopback authenticated HTTP/MCP using PostgreSQL                                                 |
| `turso`     | `@libsql/client/web`        | Loopback authenticated HTTP/MCP using remote libSQL                                              |
| `turso-web` | Fully bundled web client    | Storage/application module exports, no Node/native imports; **not a hosted Worker HTTP service** |
| `d1-web`    | Fully bundled D1 driver     | Storage/application exports with `openD1Database`; **not a hosted Worker HTTP service**          |

The web artifacts have no installed production dependencies, and callers supply
provider adapters. The 2 MB web artifact budget is a project regression budget,
not a verified hosting limit. The Neon Function is bundled by `neon deploy` from the root
`neon.ts`, not by `build:targets`; see the [Neon runbook](neon-deployment.md).

## Configure the selected Node process

The SQLite target keeps its launcher arguments and private-file checks
(`fonds serve --db /absolute/private/path/service.sqlite`); see the
[local service guide](local-development.md) for synthetic initialization, token
files and stdio. Runtime files stay outside the source tree and deployed
application directory.

PostgreSQL and Turso launchers read server-side environment configuration:

| Variable                    | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `FONDS_DATABASE_URL`        | PostgreSQL connection string or encrypted remote libSQL URL |
| `FONDS_DATABASE_AUTH_TOKEN` | Turso credential, when required                             |
| `FONDS_API_TOKEN`           | Bearer credential for authenticated HTTP/MCP                |
| `PORT`                      | Loopback port; default 8787                                 |

With a command, the same entry points run the CLI instead of the service:
PostgreSQL the same [operator CLI](local-development.md#operator-commands) as
SQLite, Turso only the embedded
[operation commands](local-development.md#use-the-command-line). With
`--transport stdio`, the PostgreSQL target serves MCP over stdio to a trusted local
client: the operations and refresh, without Events or scheduling. PostgreSQL
launchers and commands take their secrets, the API token and credentials key
included, from `FONDS_STATE_DIR`
([state directory](../database.md#state-directory-and-backup)).

Supply these through the host's secret mechanism, never in tool arguments,
prompts, repository files or logs. The launchers initialize an empty dedicated
database or validate the [current baseline](../database.md#migrations), check
connectivity and serve on `127.0.0.1` with bearer authentication. They create no
provider connection and do not expose themselves publicly; they contact a provider
on startup only to resume an interrupted refresh. PostgreSQL TLS options belong to the driver
configuration and host; a `Pool` passed to `openPostgresDatabase` is ended by the
returned store's `close()`.

## Verification

Shared storage suites exercise SQLite, local libSQL, actual libSQL HTTP and
PostgreSQL with invented fixtures; the application suite and its golden
reconciliation output are the SQLite baseline. For the local baseline, with remote test URL variables unset:

```sh
npm run check
npm run check:npm
```

The [storage test runbook](../internals/storage-testing.md) covers the
actual-driver suites, the runtime target checks and
[performance checks](../internals/storage-testing.md#synthetic-performance-checks).
Target typechecking follows the repository's `skipLibCheck` convention, so it
does not certify every optional declaration third-party packages ship. Use
disposable synthetic databases, never the active ledger. A passing driver suite
does not certify managed-service quotas, hosted backup and restore or a host's
eligibility for financial data.

A hosted D1 service, R2, document stores, Neon HTTP/REST, automatic backend
fallback and arbitrary financial overrides are not supported.
