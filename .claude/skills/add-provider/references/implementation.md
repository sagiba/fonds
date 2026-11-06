# Fixtures, mapping and collection

> For the agent implementing a provider. Owns the implementation order and its traps. Exact rules stay in the [design](../../../../docs/design.md), the [`SourceAdapter` contract](../../../../src/domain/source-adapter.ts) and provider code.

## What a provider adds

| Path                                   | Holds                                                          |
| -------------------------------------- | -------------------------------------------------------------- |
| `src/providers/<name>/provider.ts`     | `ProviderDefinition`, registered in `src/runtime/providers.ts` |
| `src/providers/<name>/transport.ts`    | Fixed origins, envelopes, typed failures                       |
| `src/providers/<name>/collect.ts`      | Login, discovery, windows, paging, pacing, budgets             |
| `src/providers/<name>/extract.ts`      | Source rows to provider-neutral facts                          |
| `src/providers/<name>/evidence.ts`     | The retention allowlist and evidence merging                   |
| `src/providers/<name>/adapter.ts`      | `SourceAdapter`: parser version and opt-in capabilities        |
| `src/providers/<name>/source-notes.md` | Evidence, rationale, uncertainty                               |
| `tests/providers/<name>/`              | Tests, invented fixtures and their README                      |
| `docs/providers/<name>.md`             | Setup, coverage, omissions and recovery                        |

Only `node-*.ts` files may use Node built-ins, and shared workflows never inspect a
provider ID; see the [layout rules](../../../../docs/internals/repository-layout.md).
Reuse a provider's structure, not its names: source-specific terms stay in the adapter.

## Fixtures first

Write fixtures from the field, type and presence profile, then tests, then mapping.

- **Invent everything.** Never anonymize a real row. Follow the conventions of the
  existing [fixtures](../../../../tests/providers/cal/fixtures/README.md): far-future
  dates, `SYNTHETIC-` identifiers, `example.invalid` links. Real field names and
  code values are schema facts.
- **Cover the shapes, not just the happy path:** each era's variant, every observed
  empty envelope exactly, failure envelopes, unknown fields, malformed partitions.
- **Give each nullable field a populated example.** A field that is only ever null
  in a fixture hides its live type.
- **Fixtures prove shape, never semantics.** Record a real pattern in source notes
  first, then reproduce it with invented values.
- Scan additions against your private strings through the git-ignored
  `.public-text-patterns` file before pushing.

## Tests that matter

- Write expected values by hand, and prove each guard: delete the safeguard and watch
  a named test fail. A test can enshrine a bug.
- Add the provider to [`shared-contracts.test.ts`](../../../../tests/providers/shared-contracts.test.ts).
- Run sequences through the real collection path: double replay of identical
  captures, omitted optional evidence, reordered and delayed captures, corrections
  before and after a snapshot. Sparse sequences break what single-capture tests pass.
- Keep existing providers' golden snapshots untouched unless the owner accepted a
  semantic change.

## Mapping

The [design invariants](../../../../docs/design.md) govern money, identity and
absence. The traps:

- **Parse losslessly.** Keep identifiers as strings with their leading zeros. Parse
  dates strictly, and never invent a time zone or a day.
- **Never guess.** Unknown code, unknown role, unknown sign: `null` and a review
  issue. Sign alone never classifies a row. A requested billing month is not a
  transaction date.
- **Currencies come from full history.** A recent window shows only a few, and an
  unseen value stays unresolved rather than defaulting to the local currency.
- **Name the amount roles** (original, billed, purchase commitment, installment) from
  evidence. Automatic matching needs verified bases, so an unnamed role never links.
- **Installments:** any row may be the first one seen, because windows land mid-plan.
  A purchase and its lines must never both count, and the first payment can absorb
  rounding, so never multiply or divide to derive one.
- **Never write derived facts onto fields that identity matching compares.** A
  filled-in count causes ID churn on identical captures. Parse the provider's own
  statement instead.
- **When identity is not evidenced, do not invent a key.** A fallback key can both
  split and merge rows. Follow the [identity rules](../../../../docs/design.md#identity-corrections-and-absence):
  preserve distinguishable observations, and retain evidence without a safe identity
  separately.
- **Keep absent, conflicting and cleared distinct** end to end. Absent keeps the
  stored value; missing evidence must not silently erase a conflict.
- **Validate at merge as well as extraction,** or bad values stored by an older
  parser return through retained evidence on every refresh.

Providers supply facts and whole-group vetoes; the shared engine owns linking,
lifecycle and absence. Do not write a provider-specific linker. Start with no
`sourceCoverage`, `automaticPosting` or empty-capture guards, and add each only with
evidence: a coverage claim changes money when it is wrong.

A `parserVersion` bump applies to later captures and does not reprocess applied
history, so decide what must be retained before bodies are released. Profilers that
allowlist parser versions need bumping with it.

## Retention and personal data

- **The allowlist is a data-loss boundary.** Omission deletes silently. One list
  governs storage and change events, so test both directions: a fact survives, and
  refresh noise causes no change.
- Decide login and discovery responses field by field on day one. Transaction
  archives cannot recover dropped card facts, and raw ones hold personal data.
- Filter before persistence; a read-time projection leaves the data stored.
- Run secret guards before redaction, and redact only known field locations. A
  response reflecting a password or session value is refused, not repaired.

## Collection

Follow the [CAL](../../../../src/providers/cal/transport.ts) and
[Isracard](../../../../src/providers/isracard/transport.ts) transports:

- Fixed origins, no followed redirects, certificate verification on, bounded
  timeouts and body sizes.
- Typed failures with bodies discarded, and safe metadata for diagnosis. Classify a
  refused login, challenge and rate limit apart, then stop: a provider's verdict on
  one login can be wrong, and the shared [refresh](../../../../docs/api.md#refreshes)
  policy owns cooldown, retries and attention.
- Measure pacing start to start, compute the budget before setting it, and implement
  `estimateRequests`. A budget stop reports unattempted scope as incomplete.
- Keep optional detail endpoints out of the required path, so that one failing
  cannot cost a statement already fetched.
- Persist each bounded unit before the next request. An interrupted run keeps what
  it fetched.
- Reread an overlapping recent window on every refresh; a stored cursor is not a
  date cutoff. Give each capture truthful requested dates, because applying it reads
  only the ledger rows near them.
- Strip per-request fields before fingerprinting. Skip-if-unchanged is reconciliation
  logic: it must account for scope, ledger revision and parser version, and a skip
  can hide a state transition.
- Do not trust an aggregate "nothing changed" shortcut without a source revision
  signal; equal totals can hide changes.
- Measure calls, stored bytes and ledger rows read as separate costs.
