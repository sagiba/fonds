# CAL adapter

> For CAL users and operators. Owns setup, coverage, omissions and recovery; [source notes](../../src/providers/cal/source-notes.md) own source evidence.

Fonds reads CAL's private web APIs with your own login, and CAL may change or block them; see [Your data stays yours](../../README.md#your-data-stays-yours).

The adapter keeps every financial response exactly and projects
provider-independent records. Its parser and policy versions are defined in the
[adapter](../../src/providers/cal/adapter.ts) and recorded on every sync run.
The [observed schema](../../tests/providers/cal/schemas/cal-observed.schema.json) and
[synthetic fixtures](../../tests/providers/cal/fixtures/README.md) describe the source shapes,
the [matching design](../design.md#pending-to-posted-matching) owns the
pending-to-posted guarantees, and [Neon operations](../guides/neon-deployment.md) owns
hosted setup, scheduling and network evidence.

## Setup

Supply credentials through private runtime configuration or the CLI credential
interface. The credential JSON object contains `username` and `password`; the CLI
also accepts a private `username:password` descriptor. `connect` stores them
encrypted for later `refresh` runs; see the
[provider credentials table](../database.md#provider-credentials-table). Hosted
refresh uses the provider-neutral configuration in the
[hosted-service guide](../guides/hosted-service.md). No proxy is required. The
fixed endpoints and headers are in [transport](../../src/providers/cal/transport.ts).

## Personal data

CAL's initialization response describes each card, and it also contains the
cardholder's name, email, mobile phone and national ID number. Fonds never needs
them, so that response is **not archived**. The adapter keeps only card identity
(the card key, last four digits, card description and billing-account key) and a
short [allowlist](../../src/providers/cal/collect.ts) of card-state facts such as
status, card type, issuer and debit day. Card facts are stored privately and are
not exposed. Card state is read again at every login, so nothing historical is
lost, and a new field is captured only after it joins the allowlist. Login and
initialization bodies and session material are never archived; financial
responses stay exact.

## What is collected

- **Recent refresh** rereads CAL's recent account endpoint every time. CAL states a
  90-day window that cannot be narrowed; overlapping reads correct existing
  records, and its exact boundaries and completeness are unknown.
- **History** uses CAL's transaction search over explicit dates, in one-month
  windows by default. Explicit 3, 6 and 12-month windows are diagnostic options:
  an empty broad search can hide records that smaller windows return. An empty
  answer never proves there was no history, unfamiliar paging marks coverage
  partial, and CAL's 540-day web limit is not a retention guarantee.
- **Cards and billing accounts.** Cards charged to the same bank account share
  one billing account, whose name and mask stay null. Cards missing from a later
  login stay retained, and transactions on an undiscovered card create a
  reference-only card.
- **Not collected.** The billing-month route is an unsupported diagnostic whose
  amounts are not projected. Collection downloads no PDFs and uses no browser.

Posted purchases are full-purchase commitments, pending rows are authorizations,
and a posted status does not establish a booked debit. An installment plan is one
purchase plus one billed line per payment, linked by `purchaseId`; an installment
cancellation is a single refund. Payment context (card presence, contactless,
online, Apple Pay, 3-D Secure, standing orders), stated conversion rates and a
reconciled foreign-exchange fee become typed fields only from explicit source
evidence; anything else stays in `additionalInformation`. Merchant name, address
and phone stay source text, and the MCC comes from CAL's category field. CAL takes part
in conservative automatic pending-to-posted matching; pairs it cannot settle
become review candidates.

## What totals and history omit

- CAL provides no opening balance, bank-side card repayments, complete income or
  transfers, or complete account history, so purchase totals are not a current
  debt balance.
- Uninterpreted financial fields such as discounts, cash-account amounts and
  rates stay private provider evidence. Card limits and next-debit metadata are
  omitted; whole-response retention requires optional raw archives.
- Types without an established meaning, such as services or charge/credit
  adjustments, stay `unknown` with unresolved money for review. Rows whose sign
  and refund flag disagree, and unknown currency markers, also stay unresolved.
- Foreign-currency installment plans are flagged unverified and carry no
  exchange facts. Zero-amount rows stay stored but can be left out of spending.

## Absence and recovery

Posted omissions change neither observation state nor totals. Pending omissions
establish absence only within declared coverage. Wholly empty responses with
covered pending rows fail `implausible_empty`; quiet cards can retain stale pending
rows indefinitely. Successful captures no longer covering the pending date prove
no absence. Verify against CAL before using [`confirm_removal`](../api.md#operations): history and
annotations remain, but removal is an owner decision, not provider-proven
cancellation.
See [coverage rationale](../../src/providers/cal/source-notes.md#calwindow-recent-window-and-search-coverage).

Authentication challenges, invalid credentials and rate limits stop the refresh,
and repeated network or invalid-response failures stop after a bounded budget
and report the gap. Resolve a challenge or password change on CAL's own site,
run `connect` again if the credentials changed, wait out a rate limit, then rerun
the refresh or the reported history range.
