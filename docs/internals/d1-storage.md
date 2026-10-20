# Cloudflare D1 storage adapter (experimental)

D1 is an experimental library target, verified only against local D1
(Miniflare/workerd). It is not a supported backend: the hosted service runs on
PostgreSQL, and hosted D1, a Worker HTTP/MCP service, auth, scheduling, provider
collection and recovery are not implemented or verified for it.

## Why writes are guarded batches

D1 reuses the shared financial planners, store workflows, SQLite schema and
statement builders, but cannot hold an interactive SQL transaction open while
application code reads and plans. A store transaction therefore reads the
connection, including its D1-only `revision`, plans, and passes the unexecuted
statements to the store's `commit` hook: other backends await them inside their
transactions, and D1 sends one atomic `batch()` led by a revision guard. A competing commit changes the revision, so a stale batch fails the revision's
CHECK and rolls back, and the adapter reports `ConflictError`. Every committed
mutation to an existing connection advances its revision, detecting writes
between the initial read and the commit even when later reads straddle another
commit. See [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/).

The planner resolves card and account service IDs before the commit, so the batch
needs no read. `commit` returns typed statement results so evidence insertion can
detect an existing run; comparing that run after the batch is safe because
retained evidence is immutable. Failed application leaves the evidence unapplied;
D1 has no automatic recovery or retry, so callers must reread/retry or call
`applyRun`. D1 binds at most 100 parameters per statement, so the shared insert
builder chunks rows to that budget.

Every write inside a store transaction must go through the `commit` hook; a D1
test fails on statements executed outside a batch other than the single-statement
connection insert. [`d1.ts`](../../src/storage/d1.ts) composes the adapter, sends
the batch and translates conflicts;
[`d1-statements.ts`](../../src/storage/sqlite/d1-statements.ts) owns the revision
read, the guard and the parameter budget. `openD1Database(binding)` returns only
the store; its Drizzle instance stays internal. [`migrations/d1/`](../../migrations/d1/)
holds tested byte copies of the shared SQLite migrations plus the D1-only revision
column, so D1 holds the same financial tables as SQLite.

The opt-in `d1-web` bundle is outside the default targets, and graph checks exclude
D1 from every other target. Workers types are a type-only root development
dependency; Miniflare is pinned in `tests/d1-local/`, so the root install never
fetches workerd, and its pinned `undici` and `sharp` advisories stay outside the
root audit. Only `FONDS_TEST_D1=1` loads Miniflare and the adapter; type, lint and
migration-copy checks run by default. The
[storage runbook](storage-testing.md#local-cloudflare-d1) gives the commands. The
bundled Worker test runs without `nodejs_compat` and compares a synthetic CAL
capture with SQLite. Real Cloudflare D1 remains unverified.

## Limits and assumptions

- **Connection-wide conflicts:** edits, collection and cursor writes can conflict
  even when they affect different rows. Replaying retained evidence also advances
  the revision. There is no retry loop. The shared SQLite collection lease
  is available (its fence joins the guarded batch, where it cannot detect a
  missing claim row), but no D1 target composes collection, and it is exercised
  only by the local D1 suites. Low write activity is the intended workload.
- **Connections are never deleted:** the guard would affect zero rows if its
  connection disappeared. No current operation deletes connections; adding one
  requires revisiting the guard.
- **Reads use the plain binding:** it routes queries to the primary. Separate
  read-only operations are not a snapshot. Sessions/read replication would need
  separate validation and could cause additional conflicts from lagging reads.
- **Full captures stay inline:** D1's 2 MB row/string limit may prevent retaining
  a source response. Real CAL capture sizes have not been measured for this
  adapter. Measure before choosing D1; external body storage would be separate work.
- **Capacity must be measured:** 100 parameters per statement means roughly 500
  write statements for 1,000 new transactions. Account for invocation query
  limits (50 Free / 1,000 Paid), the 30-second query/batch limit, and database
  capacity (500 MB Free / 10 GB Paid). Batch accounting against invocation limits
  remains unverified here. A historical import also needs a retained-data growth
  estimate.
- **No host:** Worker transport/auth, scheduling, provider egress,
  backup/restore and historical migration are not implemented for D1. SQLite
  backups cannot establish D1 recovery.

Platform limits are dated 2026-10-16; check
[Cloudflare's current limits](https://developers.cloudflare.com/d1/platform/limits/)
and [read-replication behavior](https://developers.cloudflare.com/d1/best-practices/read-replication/)
before relying on them. Hosted D1 has not been provisioned for this adapter. D1
remains an experimental library target, outside the SQLite and PostgreSQL parity
rule; this note does not commit to making it a supported backend.
