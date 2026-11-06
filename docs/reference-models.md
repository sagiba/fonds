# Reference models

The service is read by two kinds of client: LLM assistants over MCP and
application developers who already know Stripe and Plaid. Its names and API
shape follow modern developer APIs. Bank-reporting standards decide what a field
means, not what it is called. This page records which model each part of the
contract follows, why, and where the service deliberately departs from it. The
[API reference](api.md) owns the fields, shapes and rules themselves.

## Models by concern

| Concern                                           | Model                                                                                                     | Note                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conventions: ids, lists, errors, events, metadata | Stripe, Airwallex                                                                                         | Lists add Stripe's `hasMore`.                                                                                                                       |
| Account roles                                     | Plaid Accounts (credit versus depository)                                                                 | Only accounts a provider evidences. Balances are not modeled.                                                                                       |
| Card payment context, merchant, categories        | Stripe Issuing (`authorization_method`, `card_presence`, `wallet`, `merchant_data`, MCC-based categories) | Issuer-side card data, the same perspective as the CAL and Isracard sources.                                                                        |
| Pending to posted                                 | Fonds policy: an inferred, reversible match keeps the pending ID, so owner annotations stay put           | See [posting policy](#pending-to-posted-policy).                                                                                                    |
| Foreign exchange                                  | Berlin Group NextGenPSD2 1.3.16 `currencyExchange[]`                                                      | `fxFee` is defined by this service, because Berlin Group `markupFee` means any transaction fee.                                                     |
| Money roles and date roles                        | Berlin Group and ISO semantics with Fonds names                                                           | Prevents confusing commitment, booking and original money.                                                                                          |
| Installments and billing                          | Fonds design, checked against Consumer Data Right (CDR) instalment plans and Open Finance Brasil 2.4.0    | See [purchases and billed lines](api.md#purchases-and-billed-lines).                                                                                |
| Pulling new data from a provider                  | Stripe Financial Connections transaction refresh; Plaid `/transactions/refresh`                           | A recorded, asynchronous [refresh](api.md#refreshes). "Sync" already names sync runs and the event feed; "collection" is the internal capture step. |

Berlin Group and ISO 20022 are semantic checks. Fonds does not claim certified
Berlin Group or ISO 20022 message conformance and is not an Open Banking, OFX or
SimpleFIN endpoint. The vocabulary comes from
[Berlin Group NextGenPSD2 1.3.16](https://berlin-group.org/wp-content/uploads/2026/09/Berlin-Group-NextGenPSD2-Implementation-Guidelines-1.3.16-2025-12-02.pdf)
and its [OpenAPI](https://gitlab.com/the-berlin-group/nextgenpsd2/-/raw/main/Core%20PSD2%20Compliancy/psd2-api_v1.3.16-2025-11-27.openapi.yaml).

## Naming

Field names are camelCase and enum values snake_case. `id` is a resource's own
service-issued identifier; references to other resources are `<resource>Id`, such
as `cardId` and `billingAccountId`. Service timestamps (`createdAt`, `lastSeenAt`)
are ISO 8601 UTC.

## Pending-to-posted policy

The supported sources demonstrate no shared authorization/posting identifier. Fonds therefore infers the [match](api.md#pending-to-posted-matching)
while retaining source components and an unlink path. Keeping the pending ID
preserves owner annotations; it does not turn a heuristic into provider proof.

Membership, identity and notification are separate concerns. An authorization
leaving a covered current source does not prove cancellation or identify a
posting. Retained history allows later continuity without displaying the old
observation as another current charge. [Design](design.md#pending-to-posted-matching)
owns these invariants; the API owns public behavior.

External precedents inform the design, not issuer-specific matching predicates:

- [Plaid](https://plaid.com/docs/transactions/transactions-data/) replaces a pending
  record with a posted record and supplies `pending_transaction_id` when matched;
  it explicitly documents unmatched cases.
- [MX](https://docs.mx.com/api-reference/atrium/reference/transactions/overview/)
  documents both status updates and replacement with a different identifier.
- Stripe keeps a separate Authorization referenced by Transactions; Airwallex
  exposes `matched_authorizations[]`. Up and Monzo usually keep one ID but do not
  guarantee it.
- [Actual Budget](https://github.com/actualbudget/actual/blob/master/packages/loot-core/src/server/accounts/sync.ts)
  uses ID-first import reconciliation with amount/date fallback.
  [Sure](https://github.com/we-promise/sure/blob/main/app/models/account/provider_import_adapter.rb)
  implements pending reconciliation. Neither generic import reconciliation nor
  string similarity supplies missing purchase identity. Repeated purchases,
  changed descriptors and late postings still need explicit policy.

A wrong link is an attribution error, not necessarily erased source data.
Unlink restores components but does not infer how to redistribute annotation
edits made while linked. Notification consumers should distinguish a newly
observed record from new spending; see the [assistant guide](guides/using-with-an-assistant.md#refresh-and-notifications).

## Merchant categories

Fonds keeps the source's merchant category code (MCC) as `merchant.categoryCode`
and does not derive a category from it. The owner's `annotation.category` is a
separate, free-form value that no source writes.

## Foreign exchange policy

Only rates the source states are kept or used, as the
[FX fields](api.md#foreign-exchange) define. When a row's fee does not reconcile,
`fxFee` is `null` but `currencyExchange` is still kept, because the stated rates
are facts.

## Deliberate deviations

| Deviation                                                              | Reason                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money is a `{currency, amount}` object with a decimal string.          | Stripe uses integer minor units, Airwallex numbers and Plaid floats with the opposite sign. One shape for every money field has no unit or float ambiguity and is never half present. |
| Money precision is the currency's ISO precision.                       | Storage keeps exact integer minor units. Amounts finer than ISO precision (Open Finance Brasil allows four decimals) would need a precision change.                                   |
| `annotation.metadata` accepts arbitrary JSON values.                   | Stripe metadata is a string map; owner metadata here can hold numbers, booleans and nested values.                                                                                    |
| Event payloads are thin.                                               | Consumers refetch the current resource. There is no immutable object snapshot, unlike Stripe events.                                                                                  |
| `list_events` always returns a resumable `nextCursor`.                 | The event feed is the synchronization mechanism, so even an empty page must say where to resume.                                                                                      |
| Billing accounts, not credit accounts, are the first account resource. | A card provider evidences the bank account that pays a card bill, not a card credit account. `credit` is reserved.                                                                    |
