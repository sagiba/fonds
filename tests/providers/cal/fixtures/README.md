# Synthetic CAL fixtures

All records here are **invented from scratch** using the shapes in the
[observed schema](../schemas/cal-observed.schema.json); none is an anonymized
copy of a real transaction. Identifiers use `SYNTHETIC-`, dates use 2040, names and
notes say synthetic or example, contact data is fictitious and links use
`example.invalid`. Field names, currency, type and channel codes, generic labels,
booleans and zeros are schema facts, and common numeric values can coincide by
chance. The fixtures demonstrate behavior; the evidence for CAL's semantics is in
the [source notes](../../../../src/providers/cal/source-notes.md).

| File                             | Construction | Purpose                                                                                                                                  |
| -------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `recent-01.json`                 | Generated    | Full posted rows and both pending variants: currencies, installments, refund, cancellation, waived fee, channels, comments, duplicates   |
| `recent-02.json`                 | Generated    | A later capture: extended payment history, changed dates and flags, a pending-to-posted candidate, a hypothetical correction, new rows   |
| `recent-03.json`                 | Generated    | Reappearance of a previously unlisted row                                                                                                |
| `legacy-history.json`            | Generated    | The older accumulated shape with installment rows and same-date cancellation components                                                  |
| `future-field.json`              | Generated    | An unknown field that raw storage must preserve                                                                                          |
| `malformed-pending.json`         | Generated    | A deliberately invalid pending partition                                                                                                 |
| `scenarios.json`                 | Generated    | Source assertions, collection context, golden baseline projections and later-change expectations; hypothetical cases are labeled         |
| `search-empty.json`              | By hand      | The search no-data envelope                                                                                                              |
| `search-window-consistency.json` | By hand      | An empty yearly search whose smaller windows contain data                                                                                |
| `card-discovery.json`            | By hand      | Initialization fields the adapter keeps, beside invented holder fields it must discard                                                   |
| `installment-plans.json`         | By hand      | Three plans: rounding, a converted plan and a two-component cancellation, for [billed-line tests](../../../storage/billed-lines.test.ts) |
| `comment-templates.json`         | By hand      | One search row per comment-template case, for [enrichment tests](../enrichment.test.ts)                                                  |
| `detail-rich.json`               | By hand      | Nonempty rate, cash-account, discount, POS and explanatory fields, for [extraction tests](../extraction.test.ts)                         |

Transport and history cases are constructed directly in the
[collector](../collection.test.ts),
[historical ingestion](../../../storage/historical-sync.test.ts) and
[application collection](../../../storage/collection.test.ts) tests from
invented values and the files above. Record a new real-source pattern in the
source notes first, then reproduce it here with invented values.
The [CAL audit](../scripts/audit-cal-db.ts) is a read-only, value-free
structural audit an operator runs explicitly against an archived CAL database;
collection never runs it, and [its tests](../audit-cal-db.test.ts)
use invented values.

## Reproduce and check

```sh
npm run check:cal-fixtures
```

`npm run check` includes this. The generator rebuilds the seven generated files
from the observed schema alone and, with `--check`, compares them byte for byte;
`npx tsx tests/providers/cal/scripts/generate-cal-fixtures.ts` regenerates them.
The checker validates each against the schema, the deliberately invalid one
included, plus their structural and financial edge cases. Neither covers the
hand-authored files, which their linked tests exercise, and neither uses private
input, credentials, network access or a bank login.
