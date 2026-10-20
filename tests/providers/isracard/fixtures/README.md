# Synthetic Isracard captures

All financial records here are **invented**, including identifiers, merchants,
dates and amounts. Dates fall in 2039 and 2040; no credentials, login responses,
cookies, private captures or real rows are included. Recognized provider code
values retain their source meanings. Version 1 per-card/month envelopes retain
financial responses as verbatim strings, including numeric
lexemes, whitespace and unknown fields. Fixtures demonstrate behavior; the
[source notes](../../../../src/providers/isracard/source-notes.md) own evidence and
uncertainty about issuer semantics.
The approval-bearing examples explicitly record `isNextBillingDate: true`; other
fixtures omit that request context.

| File                              | Purpose                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `card-month.json`                 | The small join fixture: DigitalV3, legacy companion and a bound detail for one card and month                                            |
| `card-month-numeric.json`         | Nine-digit numeric string vouchers, including numeric-equivalent lexemes across generations                                              |
| `card-month-pending-summary.json` | `card-month.json` plus a pending summary: one upcoming month with an ILS and a USD count and total                                      |
| `card-month-approvals.json`       | Full approval-list evidence beside posted records: opaque and sequence confirmations, similar authorizations and independent response amounts |
| `card-month-installments.json`    | One month of plans: payment 1 of 3 in both generations with an uneven first payment and a padded legacy voucher, a same-voucher decoy, and payment 4 of a legacy-only ten-payment plan |
| `card-month-rich.json`            | Broad posted, approval-list and legacy field/type coverage, including discounts, recurrence, foreign bills and installment evidence |
| `card-discovery.json`             | Product, period and holder field shapes for discovery projection |
| `card-list-accounts.json`         | Raw archival card-list shapes with periods, limit fields and shared billing accounts |

`card-month-rich.json` uses a field/type/presence profile of an authorized
collection, never private rows or values; the unpublished profile is an authoring
statement, not a reproducible completeness check. Integer and decimal JSON numbers
share one type. Discovery periods, approval fields and fields from this profile
use observed or public names and types. Focused fixtures also exercise synthetic
structural and numeric variants, not captured issuer schemas. These approval
examples invent confirmation strings and uninterpreted numeric codes; neither
uniqueness nor a code mapping is asserted. The rich fixture's legacy statement
total deliberately disagrees with its rows.

Malformed, ambiguous and cross-generation cases are built inline from these files
with invented values in the [extraction](../extraction.test.ts),
[amount-basis](../amount-basis.test.ts),
[installment](../installments.test.ts) and
[collection](../collection.test.ts) tests. Record a new
real-source pattern in the source notes first, then reproduce it here.

## Check and profile

The fixtures are hand-authored and have no generator; `npm test`, part of
`npm run check`, exercises them. An operator can profile their own archive's
structure, without its values, before changing a fixture or mapping:

```sh
TSX_DISABLE_CACHE=1 node --no-warnings --import tsx tests/providers/isracard/scripts/audit-isracard-db.ts \
  --out /private/profiles/new.json [--replay [--keep-replay /tmp/new-replay]] \
  /private/archives/isracard.sqlite...
```

The [profiler](../scripts/audit-isracard-db.ts) states its read-only copy,
destination and output rules; it refuses to run without both leading settings.
Keep the profile outside the repository: it is derived from real financial data.
[Its tests](../audit-isracard-db.test.ts) use invented values.
