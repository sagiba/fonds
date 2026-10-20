# Synthetic Isracard captures

All records here are **invented**: identifiers, merchants, dates and amounts are
made up, dates fall in 2039 and 2040, and no credentials, login responses,
cookies, private captures or real rows are included. Field names and provider code values are
source shapes. Each capture is a version 1 per-card, per-billing-month envelope
whose financial responses are verbatim strings, so re-extraction keeps numeric
lexemes, whitespace, unknown fields and companion responses. The fixtures
demonstrate behavior; the evidence for Isracard's semantics, including the pinned
upstream sources, is in the [source notes](../../../../src/providers/isracard/source-notes.md).

| File                              | Purpose                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `card-month.json`                 | The small join fixture: DigitalV3, legacy companion and a bound detail for one card and month                                            |
| `card-month-numeric.json`         | Nine-digit numeric string vouchers, including numeric-equivalent lexemes across generations                                              |
| `card-month-pending-summary.json` | `card-month.json` plus a pending summary: one upcoming month with an ILS and a USD count and total                                      |
| `card-month-installments.json`    | One month of plans: payment 1 of 3 in both generations with an uneven first payment and a padded legacy voucher, a same-voucher decoy, and payment 4 of a legacy-only ten-payment plan |
| `card-month-rich.json`            | An invented example of every observed field, nested path and type: discounts, recurring rows, foreign bills, a final installment, negative money, informational and summary rows |
| `card-discovery.json`             | A DigitalV3 card list with one card's product name beside holder names, activity flags and charge dates the adapter discards             |
| `card-list-accounts.json`         | A raw card list, as older archives hold, with holder names, limits and two cards sharing one bank account                                |

`card-month-rich.json` was written from a field, type and presence profile of an
authorized collection: aggregate shapes and provider code values, never private
rows, merchants, identifiers or amounts. Integer and decimal JSON numbers count
as one type, and every nonempty scalar field has an invented nonempty value. It is
field and type coverage, not semantic or temporal completeness. The profile is
not published, so this is an authoring statement rather than a check others can
rerun. Its legacy statement total deliberately disagrees with its rows.

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
