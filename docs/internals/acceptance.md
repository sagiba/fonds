# Acceptance scenarios

This index maps [design](../design.md), [API](../api.md) and
[database](../database.md) obligations to suites and manual gates. Test titles own
exact cases. Fixtures are invented
([CAL](../../tests/providers/cal/fixtures/README.md),
[Isracard](../../tests/providers/isracard/fixtures/README.md),
[generic](../../tests/fixtures/generic/)); databases are disposable. Passing tests
does not establish hosted acceptance.

## Executable obligations

| Obligation                                                                                                                                                               | Suites                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidence retention, replay without duplicates, run-ID collisions, parser compatibility, repeated observations                                                            | `tests/storage/collection.test.ts`, `tests/storage/service.test.ts`, `tests/storage/database.test.ts`, `tests/providers/isracard/repeated-refresh.test.ts`                                                                                                                                                                                      |
| Exact money, precision/range, currency-separated totals, money roles/perspectives; incomplete versus contradictory support                                               | `tests/domain/money.test.ts`, `tests/domain/read-model.test.ts`, `tests/storage/perspectives.test.ts`, `tests/storage/query-review.test.ts`, `tests/storage/counterparty-observations.test.ts`, `tests/storage/financial-authority.test.ts`, `tests/providers/isracard/financial-authority.test.ts`                                             |
| The common model for card and [synthetic bank](../../tests/fixtures/generic/bank-transactions.json) rows; nothing fabricated for a missing fact                          | `tests/domain/model.test.ts`, `tests/storage/service.test.ts`                                                                                                                                                                                                                                                                                   |
| Lists, filters, cursors and wire projection                                                                                                                              | `tests/application/wire-output.test.ts`, `tests/storage/financial-filters.test.ts`, `tests/transport/http.test.ts`, `tests/transport/mcp.test.ts`                                                                                                                                                                                               |
| Annotations: partial update, version conflicts, survival across resync, undo, review staleness                                                                           | `tests/domain/model.test.ts`, `tests/storage/query-review.test.ts`, `tests/storage/service.test.ts`                                                                                                                                                                                                                                             |
| Installment plans, billed lines, conflicts, duplicate ordinals/plans, cancellations; count/ordinal independence                                                          | `tests/storage/billed-lines.test.ts`, `tests/storage/capture-stability.test.ts`, `tests/storage/reconciliation-index.test.ts`, provider extraction and installment suites, `tests/storage/service.test.ts`, `tests/providers/cal/installment-role.test.ts`, `tests/storage/installment-role.test.ts`                                            |
| Provider interpretation: amount roles, signs, currencies, payment context, comment templates, FX publication, history labels, cards and personal-data allowlists         | `tests/providers/cal/`, `tests/providers/isracard/`, `tests/providers/source-information.test.ts`                                                                                                                                                                                                                                               |
| Identity: scoped native keys, legitimate duplicates, weak pending keys, reviewable ambiguity; upgrade progress, held facts and quiet replay                       | `tests/storage/reconciliation-scenarios.test.ts`, `tests/storage/financial-corrections.test.ts`, `tests/storage/reconciliation-output.test.ts` (golden snapshot), `tests/storage/source-identity.test.ts`                                                                                                                                       |
| Absence, removal/restoration, implausible empty captures, historical precedence, health recovery; event order; explicit negative authority and correction-order symmetry | `tests/storage/lifecycle.test.ts`, `tests/storage/lifecycle-sync.test.ts`, `tests/storage/historical-sync.test.ts`, `tests/storage/reconciliation-scenarios.test.ts`, `tests/domain/source-membership.test.ts`, `tests/storage/source-presence.test.ts`, `tests/storage/cal-coverage.test.ts`, `tests/storage/negative-coverage-guards.test.ts` |
| Pending-to-posted matching, candidates, link/unlink, split vetoes, annotation transfer, overlap, current components and collision evidence; billed lines never matched   | `tests/domain/auto-posting.test.ts`, `tests/storage/auto-posting.test.ts`, `tests/storage/posting-annotations.test.ts`, `tests/providers/cal/posting-evidence.test.ts`, `tests/storage/lifecycle.test.ts`, `tests/storage/posting-overlap.test.ts`, `tests/storage/linked-component-current.test.ts`                                            |
| Accounts and cards: discovery, references, private keys, connection ownership of filters                                                                                 | `tests/domain/cards.test.ts`, `tests/providers/isracard/collection.test.ts`, `tests/transport/http.test.ts`                                                                                                                                                                                                                                     |
| Events: every emitted kind has a public type, baselines per account, review and health transitions, resumable cursors                                                    | `tests/storage/event-transitions.test.ts`, `tests/storage/lifecycle-sync.test.ts`, `tests/application/events.test.ts`, `tests/application/import-consumer.test.ts`                                                                                                                                                                              |
| Atomic commits and rollback with evidence kept for retry; PostgreSQL connection-row lock and event allocation                                                            | `tests/storage/database.test.ts`, `tests/storage/drivers.test.ts`, `tests/storage/backends.test.ts`, `tests/storage/lifecycle.test.ts`                                                                                                                                                                                                          |
| Local delivery: ordered consumption outside transactions, per-success acknowledgement, retry by delivery key, independent consumers, checkpoints restored with backups   | `tests/storage/notifications.test.ts`, `tests/storage/delivery-concurrency.test.ts`, `tests/application/import-consumer.test.ts`, `tests/runtime/cli.test.ts`                                                                                                                                                                                   |
| Collection: provider-owned windows and paging, month and leap boundaries, bounded transport and failure budgets, persistence before the next request, second adapter     | `tests/providers/cal/collection.test.ts`, `tests/providers/cal/transport.test.ts`, `tests/providers/isracard/`, `tests/storage/collection.test.ts`                                                                                                                                                                                              |
| Refreshes: one per connection across processes, lease fencing, resume, cooldown, attention block, schedule occurrences                                                   | `tests/storage/operations-parity.test.ts`, `tests/storage/collection-lease.test.ts`, `tests/runtime/refresh-service.test.ts`, `tests/runtime/collection-schedule.test.ts`                                                                                                                                                                       |
| Credentials: private input, encryption, never in output                                                                                                                  | `tests/runtime/credentials.test.ts`, `tests/runtime/credential-vault.test.ts`, `tests/runtime/connect.test.ts`, `tests/runtime/onboarding.test.ts`, `tests/storage/credentials.test.ts`                                                                                                                                                         |
| Local backup and restore with the state directory and binding                                                                                                            | `tests/storage/database.test.ts`, `tests/runtime/cli.test.ts`, `tests/runtime/state.test.ts`                                                                                                                                                                                                                                                    |
| HTTP and MCP authorization, scopes, safe errors, Events protocol                                                                                                         | `tests/transport/`, `tests/runtime/auth/`                                                                                                                                                                                                                                                                                                       |
| Storage adapters: same results on every backend, ordering, Unicode and NUL fidelity, libSQL HTTP, [migrations](../database.md#migrations)                                | `tests/storage/backends.test.ts`, `tests/storage/migrations.test.ts`, `tests/storage/d1.test.ts`, `tests/storage/contract.test.ts`; [actual-driver runbook](storage-testing.md)                                                                                                                                                                 |
| Targets: isolated installs, dependency graphs, module boundaries                                                                                                         | `tests/tooling/build-targets.test.mjs`, `tests/tooling/module-boundaries.test.mjs`, `npm run check:targets`, `npm run check:npm`                                                                                                                                                                                                                |

## Manual release gates

These need a real deployment or explicitly authorized live access; the suites
cover only their synthetic parts:

- Hosted backup and restore, including coordinating restored history with
  consumer cursors and external recipients.
- Production host eligibility: real payload size, secrets, transactions and the
  chosen trigger, with refreshes working while the owner's computer is off.
- Signed-webhook delivery to the real host's receiver on each deployment; grants,
  cursors, retries and signing are synthetic in `tests/application/events.test.ts`,
  `tests/runtime/webhook.test.ts` and `tests/storage/operations-parity.test.ts`.
- For changes to the OAuth login form, headers or redirects, a real login
  through an OAuth client, as
  [CONTRIBUTING.md](../../CONTRIBUTING.md#additional-verification-by-change)
  requires.
- With authorized live access only: compare fetched shapes with the observed
  schema and fixtures, quantify unsupported rows, add invented regression
  examples, and reconcile any authoritative bill under a stated amount and date
  basis, never calling purchase totals a card balance. A comparison of annual
  and smaller-window searches checks whether returned dates obey the requested
  filters, bounds retries and smaller-window probes by the collection failure
  budget, and reports unresolved gaps rather than calling them empty.

## Boundaries

Standalone candidate dismissal, resolution of ambiguous duplicate identities and
refund-to-original links are not implemented. Refresh has no separate live
opt-in flag: `refresh` rejects `--live` (`tests/runtime/cli.test.ts`). Historical facts are not immutable
because of their age, and a recent overlap window is not a completeness
guarantee. Email and other delivery channels, bank
collection, statement or PDF collection, distributed coordination beyond the
collection lease, chunk formats, arbitrary-precision money and general merge or
workflow engines are outside the current implementation. A future bank collector
must tell bank-side card repayments from card purchases to avoid double-counting
transfers.
