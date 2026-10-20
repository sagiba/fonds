# Repository layout and maintenance

Fonds is one TypeScript ESM application whose directories express code ownership
and dependency direction. The root package owns development, testing and
compilation; `deploy/` holds deployment recipes for the same source and
version; the SQLite recipe is also the npm package (`scripts/npm-package.mjs`).
Start with the [contribution guide](../../CONTRIBUTING.md) and
[AGENTS.md](../../AGENTS.md); this page owns the layer map, structural
conventions and generated-artifact maintenance.

## Source layout

```text
src/
  domain/                 Validated financial model, retained records, exact money, public projections, source contracts
    plans/                Pure reconciliation, annotation and lifecycle decisions
  application/            Public operations, query inputs, collection/delivery orchestration, financial-store.ts contract
  providers/              Provider-specific requests, extraction and full source capture
    cal/                  CAL transport, collection, scope normalization and extraction
    isracard/             Isracard protocol, billing-month captures and conservative extraction
  storage/                Consistent reads, SQL execution, transactions and persistence codecs
    sqlite/               Local SQLite driver, shared statements, schema and file recovery
    postgres/             PostgreSQL store, schema, migration and declaration validation
    turso.ts              Interactive libSQL adapter
    d1.ts                 Experimental Cloudflare D1 adapter (guarded write batches)
  transport/              HTTP/MCP serialization, request validation and trusted authentication contract
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
kebab-case filenames. Add a provider under `providers/<name>/`, exporting its
`ProviderDefinition` from `provider.ts` for the static registry in
`runtime/providers.ts`. Put a helper with its owner rather than in a catch-all
`utils`, `common` or `types` directory.

## Module ownership and imports

| Area                                        | Dependencies within this service                         |
| ------------------------------------------- | -------------------------------------------------------- |
| `domain/`                                   | Its own modules                                          |
| `application/`, `providers/`                | Domain and its own modules                               |
| `storage/`                                  | Domain, application contracts and its own implementation |
| `transport/`                                | Application and domain                                   |
| `runtime/`, root executables and `targets/` | The modules required by the selected executable          |

`runtime/`, the root executables and `targets/` own credential input, startup
and wiring concrete implementations together. Each operation is defined once in
`application/operations.ts`; HTTP routes, MCP tools and CLI commands derive from
it. Within those dependencies, the
[ESLint configuration](../../eslint.config.mjs) enforces import boundaries in
every form, including type-only imports, re-exports and `import()`, and
`tests/tooling/module-boundaries.test.mjs` verifies them:

- Portable domain, application and provider modules may use local contracts, Zod
  and `lossless-json`, and no Node globals; any other external dependency needs
  a boundary review.
- Only provider files named `node-*.ts` may use Node built-ins; portable provider
  code never imports them, and the runtime injects them.
- Host recipes live outside `src/`, so the application build never contains them;
  `src/` never imports `@neon/*`, `@neondatabase/*` or `deploy/` paths.
- Only the dialect `statements.ts` modules under `storage/sqlite/` and
  `storage/postgres/` (including `d1-statements.ts`) construct Drizzle queries,
  because Drizzle's table and builder types are dialect-specific. Shared storage
  modules never import concrete adapters, drivers or runtime modules.

The SQLite schema, migration and manifest modules stay free of the native driver:
only the local opener imports `@libsql/client/sqlite3`, and Turso cannot import it.

Target graph checks inspect the compiled graph, and web bundles reject concrete
provider imports. Dynamic imports need string-literal specifiers.
Use direct module imports, `import type` and `.js` relative specifiers: NodeNext
models the emitted ESM paths, so no path aliases or runtime barrels are needed.

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
test and the opt-in synthetic benchmark (`npm run benchmark:reconciliation`).
Scripts and `deploy/neon/` are linted, their TypeScript files are typechecked, and none ships in the
production build. `npm run build` cleans `dist/` first so removed modules cannot
survive as stale output.

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

[AGENTS.md](../../AGENTS.md#architecture-and-style) states the style rules; the
Prettier and ESLint configurations enforce them. Run `npm run lint:fix`, then
`npm run check`. Name values by role (`plan` for financial planning, `tx` for a
database transaction, `schema` for a Drizzle namespace); conventional short names
are fine when unambiguous. A lint suppression needs a local explanation. Style
work preserves exported APIs, provider field names, SQL identifiers, stored JSON
keys, error text and codes and test titles, stays separate from behavior changes,
and never rewrites migration strings, schema manifests, fixtures or golden
snapshots.

ESLint parses syntax only, through Babel, and TypeScript remains the type, build
and unused-code authority (the [ESLint configuration](../../eslint.config.mjs)
says why). Reassess parser support when upgrading these tools rather than forcing
an incompatible peer install.

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

Before first release, update `0001` in `migrations/` and
`migrations/postgres/`; after release, append the next numbered migration.
Run `node --import tsx scripts/generate-storage-schema.ts` against disposable
PostgreSQL 18 `FONDS_TEST_POSTGRES_URL` (the role needs `CREATEDB`). It embeds the files, writes the D1 copies, and records the
declarations of fresh SQLite and PostgreSQL databases migrated to the latest
version; `--check` verifies every artifact without writing files. SQLite
migrations run in a transaction with foreign keys on, which SQLite cannot switch
off there, so a migration that rebuilds a referenced table needs the runner
changed first.

```sh
npm test -- tests/storage/backends.test.ts tests/storage/domain-contract.test.ts
npm run check:targets
```

The hosted `identity` schema shares neither the financial migrations nor the
model; Neon setup migrates it ([auth storage](auth-storage.md)). The
[storage test runbook](storage-testing.md) describes optional actual-driver
services and their limits.
