# Isracard adapter

> For Isracard users and operators. Owns setup, coverage, omissions and recovery; [source notes](../../src/providers/isracard/source-notes.md) own source evidence.

Fonds reads Isracard's private web APIs with your own login, and Isracard may change, challenge or block them; see [Your data stays yours](../../README.md#your-data-stays-yours).

The adapter collects through the local CLI, keeps every accepted financial
response exactly and projects provider-independent records. Its parser and
policy versions are in the [adapter](../../src/providers/isracard/adapter.ts) and
on every sync run. The [synthetic fixtures](../../tests/providers/isracard/fixtures/README.md),
[contribution checks](../../CONTRIBUTING.md) and
[storage testing](../internals/storage-testing.md) validate without credentials.

## Setup

Use an existing owner-only directory outside the repository for private data.
These commands are examples, not live-validation receipts:

```sh
npm run build
node dist/cli.js init --db /path/to/private/isracard.sqlite --connection isracard --provider isracard
node dist/cli.js connect --db /path/to/private/isracard.sqlite --connection isracard
node dist/cli.js refresh --db /path/to/private/isracard.sqlite --connection isracard
node dist/cli.js refresh --db /path/to/private/isracard.sqlite --connection isracard \
  --from 2026-09-01 --to 2026-09-30 --credentials-fd 3 3< /private/isracard.json
```

The credential JSON object contains `username` (the login identity number),
`password` and the six-digit `cardSuffix`. `connect` prompts for each with hidden
input, or reads `--credentials-fd`, and stores them encrypted for later `refresh`
runs ([provider credentials table](../database.md#provider-credentials-table)).
The npm/tsx launcher does not preserve descriptor 3; use the built CLI or
`node --import tsx src/cli.ts`. The hosted target accepts the same object when
`FONDS_CONNECTION_PROVIDER=isracard`
([hosted-service guide](../guides/hosted-service.md#adding-providers),
[Neon runbook](../guides/neon-deployment.md)), but hosted collection is
unverified. The stored connection selects the provider, so an Isracard archive is
never collected, ingested or recovered as CAL.

## Personal data

Credentials, login bodies, session headers and the six-digit suffix never become
MCP inputs, command-line values, diagnostics or archived data; a response that
reflects password, suffix or session material is rejected. A login identity
number in a known holder field is archived as `[redacted-identity-number]`, and
anywhere else it rejects the response.

The card list names each card's holders, limits and paying bank account, none of
which Fonds needs, so captures archive an allowlisted projection: per card
`companyCode`, `cardSuffix`, `cardGuid`, `cardName` and a `billingAccount` of a
private provider key and mask. Holder data inside financial responses (names,
card digits, a payment detail's other party) stays exact in the archive and is
never exposed, except a transfer's counterparty name. An older archive with a raw
card list still replays; project it with `projectIsracardCardList`
([capture](../../src/providers/isracard/capture.ts)) **before** ingest so a new
database never receives it. No CLI command applies it.

## What is collected

- **Billing months.** A capture covers one card and billing month: DigitalV3
  rows and, for Isracard (company `11`) cards, the legacy statement they share;
  co-branded (company `77`) cards have DigitalV3 only. A month is complete only
  when each required source answered. Refresh rereads open and recently closed
  periods; history takes at most 12 billing months per invocation. DigitalV3
  reaches back roughly four years, older months come from the legacy route, and
  requests start at least one second apart within a budget of 24 (up to 100).
- **Cards and billing accounts.** A card is identified by company code and final
  four digits and named by its product name when that is safe to show. Cards
  charged to one bank account share a billing account masked to its last four
  characters. Inactive and partner cards are kept without asserting closure or
  ownership, and a card missing from discovery is never deleted.
- **Installment plans.** A proven plan is one purchase, at the stated total, plus
  one billed line per payment, linked by `purchaseId` as for
  [CAL](cal.md#what-is-collected).
- **Payment context.** Online and 3-D Secure use, a named wallet, standing orders
  and a transfer's counterparty become typed fields only from explicit evidence.
  Merchant city and a valid country code are kept; there is no MCC, and card
  presence stays unknown. Wallet, merchant address and phone, and counterparty
  require a voucher-bound optional legacy detail. The CLI defaults to
  `--max-details 0`; opt in with, for example, `--max-details 5` on `refresh`
  (range 0–20 attempts per collection window; a history backfill applies the cap
  to each month). Details share the request budget with statements and have no
  cache, so repeats can fetch them again. Co-branded cards have no supported
  detail route. Optional failures are [reported separately](../api.md#sync-run).
- **Pending approvals.** The discovered next billing period supplies pending
  authorizations, using the original amount and currency. Their kind stays
  unknown. A unique disappearing approval can keep its ID when a compatible
  posted purchase arrives in the same card/month capture through the
  [shared matching policy](../design.md#pending-to-posted-matching). Matching is
  reversible and can misattribute an expired approval to an identical purchase.
  Upcoming-charge summaries stay raw. Collection uses no browser and downloads no PDFs.

## What totals and history omit

- Totals count only same-currency DigitalV3 charges of a mapped kind and proven
  installment plans. Every other row is listed with `amountBasis: unknown` and
  review issues but excluded: cross-currency bills (observed cash withdrawals
  among them), same-currency bills whose original money does not reconcile,
  legacy-only and informational rows, non-plan installments (with a null
  amount), converted plans, negative rows of an outflow code and unmapped codes.
  Transfers are excluded by kind.
- A discount or waived fee shows as original money and is never subtracted
  again. A cash withdrawal's bill includes its cash-advance fee; no fee is
  computed.
- Fonds collects no opening balance, bank repayments, income or complete history
  from Isracard, so totals are not a current debt balance. Parallel-currency
  amounts, discount components, null fee and rate placeholders (null is not
  zero), clearing codes and payment tables remain private evidence, without
  inferred accounting roles.
- A source total that disagrees with its rows adds a value-free warning without
  failing the run; a match does not prove that no row is missing.

## Absence and recovery

Posted Isracard months are never compared for absence. Pending absence is compared
only within the same billing month after a successful next-period snapshot;
billing rollover does not infer disappearance. Matching approval keys retain
positive observations across months. Invalid or colliding approval identities
block snapshot absence inference while other supported rows remain visible.
Missing posted rows and unresolved
continuations need owner action or a later source correction; manual linking
remains available. Older captures never replace newer facts.

Each billing month is archived after its last request, with any failure inside
it. A run that ends inside a month, such as a killed process, archives none of
it; a cancelled run keeps what was fetched and makes no further request. Every
capture of a run carries one `capturedAt`, taken after login and before the card
list, so a later month's responses were fetched minutes after it. Challenges,
password failures and rate limits (`rate_limited`) stop the invocation without
another login, as do three consecutive financial failures and an exhausted
budget (`budget_exhausted`). Failed and unattempted months stay incomplete, a
later success elsewhere does not clear them, and there is no automatic resume,
completion acknowledgement or detail cache. Resolve a challenge or password
change on Isracard's own site, run `connect` again if the credentials changed,
wait out a rate limit, then rerun the refresh or the reported history range.

Unsupported approval shapes leave pending coverage incomplete; inspect the run's
reported failures before retrying. A retry cannot resolve an unsupported shape.

Still unverified: hosted collection and EU-region egress, unattended operation,
session lifetime, reuse of a card's final four digits, partner and co-branded
cards, old cards missing from discovery, pending coverage across rollover and
accounting meaning beyond the rows totals count.
