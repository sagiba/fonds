# Repository layout and maintenance

Fonds is one TypeScript ESM application. The directory structure expresses code
ownership and dependency direction. The root package owns development, testing and
compilation; `deploy/<target>/` manifests describe installations with a selected
database driver, and `deploy/neon/` holds the Neon host recipe. These are
deployment recipes for the same source, not separately versioned packages. Start
with the [contribution guide](../../CONTRIBUTING.md) and [AGENTS.md](../../AGENTS.md);
this page owns the layer map, structural conventions and generated-artifact
maintenance.

## Source layout

```text
src/
  domain/                 Financial model, records, money, projections and provider contracts
    plans/                Pure reconciliation, annotation and lifecycle decisions
  application/            Operations, collection/delivery orchestration and storage contract
  providers/
    cal/                  CAL transport, collection, scope normalization and extraction
    isracard/             Isracard protocol, billing-month captures and conservative extraction
  storage/
    sqlite/               Local SQLite driver, shared statements, schema and file recovery
    postgres/             PostgreSQL store, schema, migration and declaration validation
    turso.ts              Interactive libSQL adapter
    d1.ts                 Experimental Cloudflare D1 adapter (guarded write batches)
  transport/              HTTP/MCP handling and trusted authentication contract
  runtime/                Node startup, credential input, provider composition, HTTP I/O, shared polling, webhooks
                          and the host-neutral hosted service
    auth/                 Hosted Better Auth and login/consent pages
  targets/                PostgreSQL/Turso launchers and web-library entry points
  cli.ts                  SQLite command-line entry point
  server.ts               SQLite HTTP/MCP and stdio entry point
```

The two root executables keep their source and compiled paths, `dist/cli.js` and
`dist/server.js`, and their repository-root calculation for private-file checks.
Top-level `src/` is reserved for executable entry points. Use descriptive
kebab-case filenames, add a provider under `providers/<name>/`, and put a helper
with its owner rather than in a catch-all `utils`, `common` or `types` directory.

## Module ownership and imports

| Area                                        | Owns                                                                                                                       | Dependencies within this service                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `domain/`                                   | Validated financial model, retained record types, source contracts, exact arithmetic, public projections and pure planners | Its own modules                                          |
| `application/`                              | Public operations, collection and change delivery, query inputs, `financial-store.ts` contract                             | Domain and its own modules                               |
| `providers/`                                | Provider-specific requests and extraction; full source capture                                                             | Domain and its own modules                               |
| `storage/`                                  | Consistent reads, SQL execution, transactions and persistence codecs                                                       | Domain, application contracts and its own implementation |
| `transport/`                                | HTTP/MCP serialization, trusted identity contract and request validation                                                   | Application and domain                                   |
| `runtime/`, root executables and `targets/` | Credential input, startup and wiring concrete implementations together                                                     | The modules required by the selected executable          |

`application/operations.ts` defines each operation once; HTTP routes, MCP tools
and CLI commands derive from it. `domain/source-adapter.ts` owns the provider
contracts, and each provider exports its `ProviderDefinition` from
`providers/<name>/provider.ts`, selected through the static registry in
`runtime/providers.ts`. Files named `node-*.ts` are the only provider modules
allowed Node built-ins; portable provider code never imports them, and the runtime
injects them. Host recipes live outside `src/`, so the application build never
contains them, and lint keeps `@neon/*`, `@neondatabase/*` and `deploy/` paths out
of `src/`.

ESLint checks static import boundaries, including type-only imports and
re-exports. Portable domain, application and provider modules may use local
contracts, Zod and `lossless-json`; any other external dependency needs a boundary
review, and Node globals are rejected there. `tests/tooling/module-boundaries.test.mjs`
verifies rejected and permitted dependencies, and target graph checks inspect the
compiled graph; web bundles reject concrete provider imports. The static rule does
not detect dynamically constructed imports. Use direct module imports,
`import type` and `.js` relative specifiers: NodeNext models the emitted ESM paths,
so no path aliases or runtime barrels are needed.

### Storage workflows and SQL files

`storage/store.ts` implements every backend's workflows against `Statements<Db>`,
a domain-shaped contract for unexecuted Drizzle statements, and builds the
lease-fenced store a collection uses under the
[collection lock](../../src/application/collection-lock.ts). Only
`storage/sqlite/statements.ts`, `storage/sqlite/d1-statements.ts` and
`storage/postgres/statements.ts` construct Drizzle queries, because Drizzle's table
and builder types are dialect-specific; lint rejects builder calls elsewhere.
Local SQLite and Turso share the libSQL builders, schema and `sqlite/client.ts`;
D1 adds only its revision-aware reads and write guard. The SQLite schema,
migration and manifest modules stay free of the native driver: only the local
opener imports `@libsql/client/sqlite3`, and Turso cannot import it. Shared storage
modules never import concrete drivers or runtime modules.

## Tests and development utilities

Tests live apart from production code and follow the boundary or behavior they
exercise; integration tests may cross source boundaries. Shared fixture
construction and driver setup belong in `tests/helpers/`, never production
behavior.

| Path                 | Coverage                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `tests/domain/`      | Financial model, exact money and pure financial planners                                                              |
| `tests/application/` | Shared operations against the application storage contract                                                            |
| `tests/providers/`   | Per provider: source shapes, transport and collector behavior, with its fixtures, observed schema and audit scripts   |
| `tests/storage/`     | Driver contracts, SQL integration, reconciliation, lifecycle, annotations, queries, collection, delivery and recovery |
| `tests/transport/`   | HTTP/MCP, shared auth boundary and public hosted route behavior                                                       |
| `tests/runtime/`     | CLI/server startup, credentials, target launchers and hosted Better Auth                                              |
| `tests/tooling/`     | Build graph guards, module boundaries and documentation checks                                                        |
| `tests/deploy/neon/` | Neon recipe: environment contract, `neon.ts` declaration, managed Google bridge, setup, bundle graph and smoke checks |
| `tests/helpers/`     | Shared synthetic storage harness                                                                                      |
| `tests/fixtures/`    | Invented generic financial examples shared across suites                                                              |

The reconciliation golden snapshot is
`tests/storage/__snapshots__/reconciliation-output.test.ts.snap`. When moving
tests, preserve titles and snapshot contents, compare suite and test counts, and
run with `CI=1` so a missing snapshot cannot be silently recreated.

`scripts/` holds target builders, the documentation checks, the Docker smoke
test and the opt-in synthetic benchmark
(`npm run benchmark:reconciliation`). Scripts and `deploy/neon/` are linted, their
TypeScript files are typechecked, and none ships in the production build. `npm run build` cleans
`dist/` first so removed modules cannot survive as stale output.

## Other directories and packages

| Path               | Responsibility                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `deploy/<target>/` | Selected runtime manifests and lockfiles; isolated builds verify that unrelated drivers are absent         |
| `deploy/neon/`     | Neon host recipe: Function entry, managed Google bridge, setup, smoke and restore-fingerprint tooling      |
| `migrations/`      | Numbered migrations per dialect and the D1 copies; see schema-artifact maintenance below                   |
| `tests/d1-local/`  | Opt-in Miniflare manifest and lockfile for the local D1 suites, installed separately from the root package |
| `docs/`            | Top-level design/API/database references, with guides, providers and internals in subdirectories           |

Keep the root lockfile for reproducible development installations and the
deployment lockfiles for selected-driver installations. Add a separate package
only for an independent release or consumer boundary. `node_modules/`, `dist/`,
caches and coverage are generated state; committed synthetic fixtures and golden
snapshots are deliberate source evidence.

## Style and tooling

[AGENTS.md](../../AGENTS.md#architecture-and-style) states the style rules;
`.prettierrc.json` and the ESLint configuration enforce formatting, braces, import
order and declaration spacing. Run `npm run lint:fix`, then `npm run check`. Name
values by role (`plan` for financial planning, `tx` for a database transaction,
`schema` for a Drizzle namespace); conventional short names are fine when
unambiguous. A lint suppression needs a local explanation. Style work preserves
exported APIs, provider field names, SQL identifiers, stored JSON keys, error text
and codes and test titles, stays separate from behavior changes, and never
rewrites migration strings, schema manifests, fixtures or golden snapshots.

TypeScript 7.0.2 is outside `@typescript-eslint/parser`'s supported peer range, so
ESLint uses Babel's TypeScript syntax parser without transformation or type-aware
rules; TypeScript remains the type and build authority, catching unused code with
`noUnusedLocals` and `noUnusedParameters`. Babel 8 requires Node 24.11 or newer for
development, which the root package declares; it does not enter production builds.
Reassess parser support when upgrading these tools rather than forcing an
incompatible peer install.

## SQL, embedded migrations and schema manifests

Numbered SQL under `migrations/` (SQLite and libSQL) and `migrations/postgres/` is
authoritative; `migrations/d1/` holds Wrangler's copies. [The database
reference](../database.md#migrations) states the migration contract;
`storage/migrations.ts` sequences it for every backend. Each adapter's generated
`migration.ts` embeds the exact SQL of every migration for relocatable bundles, and
`schema-manifest.ts` describes the declarations after the latest one. These are
committed runtime inputs: preserve the embedded SQL byte for byte, never derive
expected declarations from a private ledger and never relax validation to accept
unexplained drift.

For a new migration, add the next numbered file to `migrations/` and
`migrations/postgres/`, then run `node --import tsx scripts/generate-storage-schema.ts`
with a disposable local PostgreSQL 18 `FONDS_TEST_POSTGRES_URL` (the role needs
`CREATEDB`). It embeds the files, writes the D1 copies, applies the migrations to a
fresh in-memory SQLite database and a fresh PostgreSQL database and records their
declarations: non-internal `sqlite_master` rows ordered by type and name, and
`schemaInspectionSql` from `src/storage/postgres/schema-check.ts`. `--check`
verifies every artifact without writing files. SQLite migrations run in a
transaction with foreign keys on, which SQLite cannot switch off there, so a
migration that rebuilds a referenced table needs the runner changed first.

```sh
npm test -- tests/storage/backends.test.ts tests/storage/domain-contract.test.ts
npm run check:targets
```

The hosted `identity` schema is migrated separately through Better Auth's API by
`deploy/neon/setup.mjs`, followed by the managed Google bridge tables, and shares
neither the financial migrations nor the model; see the
[Neon runbook](../guides/neon-deployment.md). The
[storage test runbook](storage-testing.md) describes optional actual-driver
services and their limits.
