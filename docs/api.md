# API reference

This guide owns HTTP routes, MCP tools, inputs and the JSON records they return,
including money roles and installment perspectives. The
[database reference](database.md) owns persistence,
[local setup](guides/local-setup.md) running and connecting a
service, and [reference models](reference-models.md) the choices behind names and
shapes. HTTP and MCP call the same application operations, defined in
[operations.ts](../src/application/operations.ts),
[query-inputs.ts](../src/application/query-inputs.ts) and
[wire-output.ts](../src/application/wire-output.ts).

## Operations

Each operation name is also its MCP tool name. **Read** operations require the
`financial:read` scope; **write** operations require `financial:write`. A write
grant does not imply read access. Optional operations appear only when the runtime
supplies their capability; the [storage guide](guides/storage-backends.md) lists
which runtimes offer refreshes.

| Operation / MCP tool                                     | HTTP method and path                                                                 | Access | Notes                                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_connections`, `get_connection`                     | `GET /v1/connections`, `GET /v1/connections/:id`                                     | Read   | `list_connections` takes no input. A connection carries its [latest refresh](#connection).                                                          |
| `refresh_connection` (optional)                          | `POST /v1/connections/:id/refreshes`, `POST /v1/refreshes`                           | Write  | Body `{}` or `{from, to}`; without a connection, every connection. See [refreshes](#refreshes).                                                     |
| `get_refresh`, `list_refreshes`                          | `GET /v1/refreshes/:id`, `GET /v1/connections/:id/refreshes`                         | Read   | [Refreshes](#refreshes), newest first.                                                                                                              |
| `list_sync_runs`                                         | `GET /v1/connections/:id/sync-runs`                                                  | Read   | [Sync runs](#sync-run).                                                                                                                             |
| `list_accounts`, `get_account`                           | `GET /v1/accounts`, `GET /v1/accounts/:id`                                           | Read   | `list_accounts` requires `connectionId`. [Accounts](#account).                                                                                      |
| `list_cards`, `get_card`                                 | `GET /v1/cards`, `GET /v1/cards/:id`                                                 | Read   | `list_cards` requires `connectionId`. [Cards](#card).                                                                                               |
| `list_transactions`, `get_transaction`                   | `GET /v1/transactions`, `GET /v1/transactions/:id`                                   | Read   | [Filters](#transaction-filters) and [records](#transaction). `get_transaction` takes `detail` (default true) and `includeEvidence` (default false). |
| `get_transaction_totals`                                 | `GET /v1/transactions/totals`                                                        | Read   | Same filters as the list, without paging. [Totals](#totals).                                                                                        |
| `list_events`                                            | `GET /v1/events`                                                                     | Read   | Requires `connectionId`. [Event feed](#events).                                                                                                     |
| `update_annotation`                                      | `PATCH /v1/transactions/:id/annotation`                                              | Write  | [Partial update](#annotations), guarded by `expectedVersion`.                                                                                       |
| `undo_annotation`                                        | `POST /v1/annotations/undo`                                                          | Write  | Inputs `eventId` and `expectedVersion`.                                                                                                             |
| `link_pending_transaction`, `unlink_pending_transaction` | `POST /v1/transactions/:id/link-pending`, `POST /v1/transactions/:id/unlink-pending` | Write  | `:id` is the pending transaction, which survives. See [matching](#pending-to-posted-matching).                                                      |
| `confirm_removal`                                        | `POST /v1/transactions/:id/removal`                                                  | Write  | Needs a `reason` and `expectedTransactionVersion`. Absence from a capture is never enough.                                                          |

`GET /health` is an authenticated, HTTP-only read, not an MCP tool. It returns
`{service: "fonds", status: "ok", storage, scope}`. `storage` is
`"sqlite"`, `"turso"`, `"postgres"` or `"d1"`; `scope` is `"local-single-owner"` or
`"hosted-single-owner"`. It reports process liveness, not provider freshness.
`/mcp` is the MCP transport endpoint; the SDK owns its HTTP methods, discovery and
initialization. There are no public operations to create connections or export
raw source responses; a backfill is a [refresh](#refreshes) with `{from, to}`.

The [command-line client](guides/local-setup.md#use-the-command-line) runs
the same operations as kebab-case commands and flags and prints each operation's
JSON output, embedded on a local database or against this API with `--remote`.

## Requests and authentication

HTTP GET arguments are query parameters. MCP arguments are one JSON object with the
same names. An ID that appears in an HTTP path must not also appear in the query or
body; MCP names it `connectionId`, `accountId`, `cardId`, `transactionId` or
`refreshId`. Successful calls return HTTP 200, except a refresh start that is
still running, which returns 202.

HTTP write bodies are JSON objects sent with `Content-Type: application/json`, at
most 64 KiB. Query keys may occur only once. `limit` is an unsigned decimal integer
without leading zeros, and booleans are exactly `true` or `false`; MCP supplies JSON
numbers and booleans instead. Unknown fields are rejected. No operation accepts
provider credentials or a caller-supplied actor; the service assigns the actor for
every mutation.

Local HTTP, including `/health` and `/mcp`, requires the private bearer token and
enforces loopback Host and Origin checks. Trusted local stdio inherits access from
its parent process. Hosted requests need the owner, client, resource and scope the
[security model](security-model.md#admission) admits. Financial HTTP responses
send `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

## Lists and cursors

Every list returns `{data: [...], hasMore, nextCursor}`. Cursors are opaque and
carry the last row's sort position; do not parse or construct them, and send a
cursor only to the list that issued it.

- **Browsing lists** (transactions, cards, accounts, sync runs): `nextCursor` is
  `null` exactly when `hasMore` is false; pass it back as `cursor` for the next
  page. A page can hold fewer items than `limit` when the 256 KiB response budget
  is reached, so follow `nextCursor` while `hasMore` is true. `list_connections`
  returns every connection in one page.
- **The event feed** always returns a `nextCursor`, even on an empty or final page.
  It is a resumable checkpoint. See [events](#events).

Browsing is a live read: each page sees current data, and concurrent writes can
change later pages. Use the event feed to synchronize transaction content;
observation freshness and card-to-account links update without an event.

| List            | Order                                                | `limit` (default) |
| --------------- | ---------------------------------------------------- | ----------------- |
| Transactions    | `transactionDate` descending (nulls last), then `id` | 1 to 200 (50)     |
| Cards, accounts | `createdAt`, then `id`                               | 1 to 200 (50)     |
| Connections     | `createdAt`, then `id`                               | none (one page)   |
| Sync runs       | `startedAt` descending, then `id` descending         | 1 to 100 (20)     |
| Events          | `id` ascending                                       | 1 to 200 (100)    |

## Transaction filters

`list_transactions` and `get_transaction_totals` share these filters. An omitted
filter imposes no restriction, except the stated `includeSuperseded` and
`perspective` defaults. IDs are nonempty strings of at most 1,024 characters and
match exactly.

| Input                                          | Value                                               | Behavior                                                                                                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectionId`                                 | ID                                                  | Restricts the read to one connection. Optional.                                                                                                                                                         |
| `billingAccountId`                             | ID                                                  | Transactions whose card's **current** `billingAccountId` equals it. If a card is later linked to another account, its history moves with it, and the change emits no event; re-read cards and accounts. |
| `cardId`                                       | ID                                                  | Transactions on one card.                                                                                                                                                                               |
| `status`                                       | `pending` or `posted`                               | The source's report status.                                                                                                                                                                             |
| `presence`                                     | `seen`, `not_returned` or `removed`                 |                                                                                                                                                                                                         |
| `kind`                                         | [Kind](#fields)                                     |                                                                                                                                                                                                         |
| `amountBasis`                                  | [Basis](#money-and-amount-basis)                    |                                                                                                                                                                                                         |
| `currency`                                     | Uppercase ISO 4217 code                             | Matches the primary money's currency, not the original currency.                                                                                                                                        |
| `merchantName`                                 | String, at most 4,096 characters                    | Exact match, not substring search.                                                                                                                                                                      |
| `merchantCategoryCode`                         | Four digits                                         | Exact match. The shape does not certify registry membership.                                                                                                                                            |
| `dateRole`, `from`, `to`                       | `transaction`, `booking` or `billing`; `YYYY-MM-DD` | `dateRole` is required when a bound is given. Bounds are inclusive dates from year 0001; a row with no date for the role matches neither.                                                               |
| `cardPresent`, `threeDSecureUsed`, `recurring` | Boolean                                             | Match the stated [payment context](#payment-context).                                                                                                                                                   |
| `authorizationMethod`, `wallet`                | [Enum](#fields)                                     |                                                                                                                                                                                                         |
| `purchaseId`                                   | ID                                                  | Billed lines of one purchase. Requires `perspective` of `billing` or `all`.                                                                                                                             |
| `includeSuperseded`                            | Boolean, default false                              | Includes rows retired by a pending-to-posted match. They stay ineligible for totals and appear only in the `retiredOrRemoved` exclusion count.                                                          |
| `perspective`                                  | `spending` (default), `billing` or `all`            | See [perspectives](#perspectives).                                                                                                                                                                      |

An unknown `cardId` or `billingAccountId` fails with `invalid_input`, as does one
outside a given `connectionId`, or a card and an account given together from
different connections.

`get_transaction` takes the transaction ID, `detail` and `includeEvidence`.
Evidence expansion requires detail: `detail: false` with `includeEvidence: true`
is invalid. Transaction reads never start a refresh.

## Connection

`{id, provider, displayName, createdAt, latestRefresh}`: provider access and
refresh configuration, which may expose several cards and accounts.
Credentials and internal configuration are never included. `latestRefresh` is the
newest [refresh](#refreshes) or recorded scheduled occurrence, without its
windows, or `null` before any.

## Refreshes

A refresh records one connection's manual or scheduled provider update.

| Field                                  | Meaning                                                                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `connectionId`                   | The refresh and its connection.                                                                                                                                             |
| `trigger`                              | `manual` or `scheduled`.                                                                                                                                                    |
| `status`                               | `pending`, `running`, then `completed`, `partial` (some requested work failed) or `failed`; `skipped` for a scheduled occurrence that did not run.                          |
| `skipReason`                           | For `skipped`: `busy`, `cooldown`, `requires_attention` or `missed`; otherwise `null`.                                                                                      |
| `range`                                | A backfill's inclusive `{from, to}`, or `null` for the recent window.                                                                                                       |
| `scheduledAt`                          | A scheduled refresh's occurrence time, otherwise `null`.                                                                                                                    |
| `createdAt`, `startedAt`, `finishedAt` | Acceptance, first execution and finish; the last two `null` until then.                                                                                                     |
| `requiresAttention`                    | Refreshing needs operator attention.                                                                                                                                        |
| `counts`                               | Cumulative observation and change counts, including retries.                                                                                                                |
| `failureCodes`                         | Sorted failure causes: `authentication_challenge`, `authentication_failed`, `budget_exhausted`, `implausible_empty`, `invalid_response`, `network_error` or `rate_limited`. |
| `failureReason`                        | `expired` when it was still unfinished a day after `createdAt`; otherwise `null`.                                                                                           |
| `missed`                               | A `missed` skip's gap `{through, count}`, from `scheduledAt` through `through`; otherwise `null`.                                                                           |
| `windows`                              | `get_refresh` and starts only: a backfill's months, newest first, each `{from, to, status}`.                                                                                |

`counts` distinguishes applied financial `captures` (including recovery), successful `unchanged` captures
without content changes, and accepted `observed` transaction identities counted once
per capture (overlaps repeat). `unchangedTransactions` counts unchanged observations;
`created`, `updated`, `unlisted` count creations, content updates and absence marks.
Counts need not partition observations. `failures` is positive when failed.

`refresh_connection` takes `connectionId` and optional `from` and `to` (both or
neither, at most 120 months). A start records the refresh, runs it in the same
process and waits about 10 seconds: `200 {refresh}` when it finished, otherwise
`202 {refresh}` while it continues; read it later with `get_refresh`. A pending
or running refresh answers `409 refresh_in_progress`, a connection needing operator attention
`409 requires_attention`, and within 60 seconds of a finished refresh a start
returns that one without calling the provider. Without `connectionId` (HTTP
`POST /v1/refreshes`), every connection with stored credentials, under the same
rules: `{refreshes: [{connectionId, reason, refresh}]}`, `reason` `null` or the
rule met; HTTP answers 202 while any runs.

A backfill requests and checkpoints each month: an interrupted refresh resumes,
redoing only unfinished months, and an authentication, rate-limit or budget
failure stops it. Its months share one provider login, renewed at most once when
the provider rejects the session; a resumed refresh logs in again. A held lease
or failed execution is retried for about a minute; an active refresh then
resumes on the next scheduler tick, start or `get_refresh`, and expires a day
after creation. `completed` means the requested work succeeded, not that history
is complete; see [refresh behavior](guides/hosted-service.md#refresh-and-scheduling).
No change event announces completion.

## Sync run

Collection receipt:
`{id, connectionId, status, startedAt, finishedAt, appliedAt, collectorVersion, parserVersion, refreshId}`.
`status` is `started`, `completed`, `partial` or `failed`; nullable `finishedAt` and `appliedAt`
distinguish collection from application. `refreshId` names its
refresh, or `null` for offline ingestion. Unchanged reads still create receipts.
`list_sync_runs` excludes bodies and coverage and never starts a refresh.

Optional enrichment failures remain visible in status and failure counts without
marking transaction coverage incomplete; authentication can still require owner
attention.

## Account

`{id, connectionId, type, institutionName, mask, displayName, createdAt, lastSeenAt}`:
a bank account that a provider evidences as the payer of card bills. The
provider's key for it (which can be a full account number) is private and never
appears in output.

- `type` is `depository`. `credit` is reserved for a provider that evidences a card
  credit account.
- `institutionName`, `mask` (the last four digits, keeping leading zeros) and
  `displayName` are nullable. No current provider supplies an institution name;
  the provider guides say which other fields a source supplies.
- Accounts belong to one connection, come only from card discovery and are never
  merged by name or mask.

## Card

`{id, connectionId, billingAccountId, last4, displayName, createdAt, lastSeenAt}`.

- `id` is the service-issued card ID and matches `cardId` on transactions.
- `billingAccountId` references the [account](#account) that pays the card's bills,
  or is `null` when unknown.
- `last4` is four ASCII digits, preserving leading zeros, or `null`. It comes only
  from source card suffixes, never from login credentials or wallet-token digits.
- `displayName` is a nullable source label of at most 128 characters, selected by the
  adapter. Cardholder and contact fields, controls and PAN-like digit runs are
  excluded.
- `createdAt` is when the service first recorded the card. `lastSeenAt` is the last
  successful discovery, or `null` for a card known only from transactions.

A card that a transaction references always exists, even when its metadata is
unknown. Omission from discovery never closes a card. Cards are connection-scoped
and are never merged by their last four digits.

## Transaction

Lists and `get_transaction` with `detail: false` return compact records, and the
default single read returns the [detailed record](#detailed-read);
`get_transaction` wraps either as `{transaction: {...}}`. A transaction has one
primary `amount`, interpreted through its `amountBasis` and `status`; an evidenced
`originalAmount` is a second money object. Provider facts and owner annotations
stay separate.

### Fields

| Field                     | Type                                                                                          | Meaning                                                                                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                      | string                                                                                        | Service-issued ID.                                                                                                                                                                                                                                                                                     |
| `connectionId`            | string                                                                                        | Owning connection.                                                                                                                                                                                                                                                                                     |
| `cardId`                  | string or null                                                                                | The [card](#card), or null for a record with no card.                                                                                                                                                                                                                                                  |
| `status`                  | `pending` or `posted`                                                                         | The source's report status. `posted` does not establish a booking.                                                                                                                                                                                                                                     |
| `presence`                | `seen`, `not_returned` or `removed`                                                           | `not_returned` means a comparable response omitted the row. It never implies cancellation.                                                                                                                                                                                                             |
| `kind`                    | `purchase`, `refund`, `income`, `transfer`, `fee`, `interest`, `cash_withdrawal` or `unknown` | Coarse classification, assigned only with explicit evidence. Sign alone never classifies.                                                                                                                                                                                                              |
| `amountBasis`             | `booked_entry`, `authorization`, `purchase_commitment` or `unknown`                           | What `amount` is. Independent of `kind`. See [money](#money-and-amount-basis).                                                                                                                                                                                                                         |
| `amount`                  | [Money](#money-and-amount-basis) or null                                                      | Primary money in its basis.                                                                                                                                                                                                                                                                            |
| `originalAmount`          | Money or null                                                                                 | Money in the original (merchant) currency. It is not an earlier value of `amount`.                                                                                                                                                                                                                     |
| `description`             | string or null                                                                                | Source descriptive text.                                                                                                                                                                                                                                                                               |
| `counterpartyName`        | string or null                                                                                | A named party whose role is unknown. Not interchangeable with the merchant.                                                                                                                                                                                                                            |
| `merchant`                | object                                                                                        | `name`, `providerId` (provider-scoped merchant number), `categoryCode` (four-digit MCC), `addressLine`, `city`, `countryCode` and `phone`, each nullable. `addressLine` and `phone` are unstructured source text; `countryCode` is ISO 3166-1 alpha-3, set only when the source supplies a valid code. |
| `transactionDate`         | date or null                                                                                  | Purchase date.                                                                                                                                                                                                                                                                                         |
| `transactionDateTime`     | string or null                                                                                | Source-local purchase time, with the source's precision and offset. No offset means unknown, and its calendar date matches `transactionDate`.                                                                                                                                                          |
| `bookingDate`             | date or null                                                                                  | Account booking date. Card adapters do not establish it.                                                                                                                                                                                                                                               |
| `billingDate`             | date or null                                                                                  | The date the charge is billed to the card account.                                                                                                                                                                                                                                                     |
| `cardPresent`             | boolean or null                                                                               | The source's card-presence flag, which means "at a terminal". In-store wallet payments are present.                                                                                                                                                                                                    |
| `authorizationMethod`     | `chip`, `contactless`, `keyed_in`, `online`, `swipe` or null                                  | How the payment was authorized.                                                                                                                                                                                                                                                                        |
| `wallet`                  | `apple_pay`, `google_pay`, `samsung_pay` or null                                              | Mobile wallet used.                                                                                                                                                                                                                                                                                    |
| `threeDSecureUsed`        | boolean or null                                                                               | 3-D Secure was used. It is not an outcome.                                                                                                                                                                                                                                                             |
| `recurring`               | boolean or null                                                                               | Evidenced recurrence, such as a standing-order execution. It is not a schedule.                                                                                                                                                                                                                        |
| `currencyExchange`        | array or null                                                                                 | Conversions the source states. See [foreign exchange](#foreign-exchange).                                                                                                                                                                                                                              |
| `fxFee`                   | Money or null                                                                                 | Net conversion fee in the billing currency, included in `amount`.                                                                                                                                                                                                                                      |
| `installmentCount`        | integer or null                                                                               | Plan size, on purchases and billed lines.                                                                                                                                                                                                                                                              |
| `installmentNumber`       | integer or null                                                                               | Ordinal of a billed line, 1 or more.                                                                                                                                                                                                                                                                   |
| `purchaseId`              | string or null                                                                                | On a billed line, the purchase it belongs to. Null for purchases and standalone rows.                                                                                                                                                                                                                  |
| `supersededById`          | string or null                                                                                | Set on a posted row retired by a [pending-to-posted match](#pending-to-posted-matching).                                                                                                                                                                                                               |
| `providerTransactionCode` | string or null                                                                                | The issuer's type code as supplied. Opaque.                                                                                                                                                                                                                                                            |
| `version`                 | integer                                                                                       | Increments when a [versioned field](#versioned-fields) changes.                                                                                                                                                                                                                                        |
| `review`                  | `{required, status, stale}`                                                                   | Computed. `status` is `unreviewed`, `approved`, `needs_review` (the owner asked for review) or `stale`. `required` can be true even when the owner approved.                                                                                                                                           |
| `annotation`              | `{version, category, tags, hasNotes, metadata}` or null                                       | Owner [annotation](#annotations) summary. Null when none exists.                                                                                                                                                                                                                                       |
| `detailsTruncated`        | `true`, optional                                                                              | Present when source text was clipped for output (each string holds at most 4,096 characters, and the detailed read bounds `additionalInformation`).                                                                                                                                                    |

`null` means the value is unavailable or not established; it is never an empty
string, zero or a guess. `false` appears only when the source says so. Dates carry
no timezone.

### Payment context

A payment-context field (`cardPresent`, `authorizationMethod`, `wallet`,
`threeDSecureUsed`, `recurring`) is set only from explicit source evidence. When
two source facts disagree, the typed field is `null` and the record carries
`conflicting_payment_context`. A stored fact persists through later reads that do
not mention it, and a history import never changes payment context;
[sync.ts](../src/domain/plans/sync.ts) owns the merge and conflict-clearing rules.

### Source issues and review reasons

`review.required` is true when the record has any review reason or a
pending-posting candidate; a removed or superseded row has no review requirement.
The detailed record lists `review.reasons` (source issues plus the service's
`user_needs_review`, when the owner's annotation asks for review, and
`review_stale`) and `review.sourceIssues` (only the source interpretation's
codes). Codes are strings, extensible and sorted. The provider extractors and
[sync.ts](../src/domain/plans/sync.ts) decide when each is raised; its consequence
for a client is:

| Code                                                                                                                                                                                                                                                                                                                                                                                       | Consequence                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `conflicting_payment_context`                                                                                                                                                                                                                                                                                                                                                              | A typed [payment-context](#payment-context) field is null.                                                                          |
| `fx_unreconciled`, `conflicting_fx_comments`, `unverified_converted_installments`                                                                                                                                                                                                                                                                                                          | FX facts are withheld; see [foreign exchange](#foreign-exchange).                                                                   |
| `conflicting_installment_total`, `conflicting_installment_facts`                                                                                                                                                                                                                                                                                                                           | The rows of one plan in one capture disagree on the total or a plan-level fact.                                                     |
| `conflicting_installment_plan`, `conflicting_installment_restatement`, `conflicting_installment_lines`                                                                                                                                                                                                                                                                                     | Plan facts disagree. Restatements await source resolution; line conflicts are reevaluated against live lines.                       |
| `unresolved_purchase`                                                                                                                                                                                                                                                                                                                                                                      | A billed line's purchase cannot be resolved, so its `purchaseId` is null.                                                           |
| `duplicate_installment_ordinal`                                                                                                                                                                                                                                                                                                                                                            | Another live billed line of the purchase states this ordinal; the amount is null until the owner removes one of them.               |
| `invalid_installment_ordinal`, `unknown_installment_count`, `unverified_installment_amount_basis`, `invalid_installment_plan_voucher`                                                                                                                                                                                                                                                      | An installment ordinal, count, voucher or money role is missing, malformed, inconsistent or unproven; no plan or amount is guessed. |
| `possible_duplicate_plan`                                                                                                                                                                                                                                                                                                                                                                  | Another posted plan purchase has the same card, merchant, installment count, amount, currency and date. Both stay counted.          |
| `isracard_unverified_semantics`, `unverified_amount_basis`, `unsupported_transaction_type`, `source_derived_amount_direction`                                                                                                                                                                                                                                                              | Accounting semantics are unverified, so basis or kind stays `unknown`; the [Isracard guide](providers/isracard.md) says which.      |
| `ambiguous_source_identity`, `weak_source_identity`, `incomplete_source_identity`, `ambiguous_identity`                                                                                                                                                                                                                                                                                    | The row's identity is not unique, or is missing parts. It is excluded from totals when ambiguous.                                   |
| `possible_pending_posted_match`                                                                                                                                                                                                                                                                                                                                                            | A pending-to-posted candidate exists; see `pendingPostingCandidateIds`.                                                             |
| `unresolved_amount`, `unresolved_billing_amount`, `unresolved_companion_billing_amount`, `unresolved_installment_component`, `unresolved_original_amount`, `conflicting_generation_billing_amount`, `conflicting_original_amount`, `conflicting_billing_currency`, `conflicting_original_currency`, `unsupported_original_currency`, `unsupported_amount_direction`, `amount_out_of_range` | Money or currency could not be established or was contradictory; the affected amount is null.                                       |
| `invalid_source_date`, `invalid_source_time`, `invalid_merchant_category_code`, `invalid_payment_history`, `invalid_transaction_detail`, `ambiguous_transaction_detail`, `informational_statement_row`, `unverified_legacy_source_role`                                                                                                                                                    | A source field was invalid, ambiguous or of an unverified role, and was not promoted.                                               |

### Versioned fields

Retained content, including enrichment, `review.sourceIssues` and private provider
evidence, is versioned. Changes increment `version` and emit
`transaction.updated`. `changedFields` names fields; `evidence` signals private
evidence changes without exposing values. Refetch even with visible fields unchanged. Observation freshness and references stay quiet; owner annotations are
independently versioned.

### Detailed read

`get_transaction` returns the detailed record by default. It replaces the annotation
summary with the full annotation and adds:

| Member                  | Meaning                                                                                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `additionalInformation` | Provider explanatory text that has no typed home, as an array of strings. Treat markup as plain text. At most 100 entries, with `additionalInformationCount` when more existed. Detail only: list records omit it to keep pages lean.                           |
| `review`                | Adds `reasons[]`, `sourceIssues[]`, `pendingPostingCandidateIds[]`, `truncated` and `counts`. Candidates are suggestions, not proof of a match.                                                                                                                 |
| `source`                | `{identityStrength, firstSeenAt, lastSeenAt, lastSyncRunId}`. `identityStrength` is `native`, `weak` or `ambiguous`.                                                                                                                                            |
| `annotation`            | The full [annotation](#annotations), or null.                                                                                                                                                                                                                   |
| `postingMatch`          | `{supersededTransactionId, automatic, policyVersion, evidence, unlinked}` or null. See [matching](#pending-to-posted-matching).                                                                                                                                 |
| `evidence`              | With `includeEvidence: true`: `[{runId, path}]` references to collection receipts and paths (at most 100), with `diagnosticCounts.evidence` and `diagnosticsTruncated`. Latest capture per account, resource and scope; optional raw bodies are never returned. |

Previews are bounded. Review arrays hold at most 100 entries. When the aggregate
response would exceed 256 KiB, optional content is shortened first and a truncation
flag is set (`review.truncated`, `detailsTruncated`, `diagnosticsTruncated`). Full
annotations are never trimmed. A detailed read that still cannot fit fails with
`output_too_large`; compact reads remain available.

## Money and amount basis

A non-null money object always has both fields:

| Field      | Type                    | Meaning                                                                                                 |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `currency` | Uppercase ISO 4217 code | The currency and scale of this object's amount. Original money has its own currency.                    |
| `amount`   | Signed decimal string   | Exact major-unit amount at the currency's precision. Negative is outflow; positive is inflow or refund. |

ILS `"-370.00"` is -37,000 minor units; JPY `"-100"` has no decimals; KWD
`"-100.000"` has three. Never parse these strings as binary floating point. Missing
money is the whole object `null`, never a half-present pair. Inputs with more
decimals than the currency allows are rejected, not rounded. Unknown codes and
overflow are rejected. Precision comes from a pinned ISO 4217 table, plus historical HRK, in
[money.ts](../src/domain/money.ts), with its official SIX source and hash;
nothing is fetched at runtime.

`originalAmount: null` means no original money is established. It does not assert
that the purchase was in one currency. An original amount can also be in the same
currency as `amount`. It is still one purchase, not additional spending.

| `amountBasis`         | Meaning                                                                   | Totals treatment                                 |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| `booked_entry`        | An evidenced account entry, such as a line billed to the card account.    | Its own group.                                   |
| `authorization`       | Authorized or held money.                                                 | Excluded, even if the source status says posted. |
| `purchase_commitment` | The whole purchase obligation, including an installment purchase's total. | Its own group; not monthly cash flow.            |
| `unknown`             | Money is known but its role is unresolved.                                | Excluded from totals.                            |

The basis, not the sign, is the financial role: a signed authorization,
commitment or original amount does not imply a booked balance movement. The
primary `amount` deliberately carries commitments and authorizations as well as
booked entries, so a strict card report needs account-side money. A negative debit
amount is compatible with Berlin Group's `debitAccounting: false`.

## Foreign exchange

`currencyExchange` lists each conversion the source states, in order. Every entry
has `sourceCurrency`, `targetCurrency`, `unitCurrency`, `exchangeRate` (the source's
exact decimal text) and `quotationDate` (nullable). A two-step conversion has two
entries. The service never derives a rate from amounts.

`fxFee` is the net currency-conversion fee in the billing currency, negative as an
outflow, and already included in `amount`. It is published only when the row's
stated rates and fee reconcile with the billed amount, and is `null` otherwise,
with `fx_unreconciled` when rates were stated. A row that repeats a conversion or
fee template with different text publishes no FX facts and carries
`conflicting_fx_comments`. Rows derived from installment plans carry no FX facts in
this release; foreign-currency plans carry `unverified_converted_installments`.
Each provider owns its reconciliation arithmetic and evidence, such as the
[CAL source notes](../src/providers/cal/source-notes.md#calfx-conversion-and-fee);
see the [FX policy](reference-models.md#foreign-exchange-policy).

## Purchases and billed lines

An installment plan is one purchase row plus one billed line per payment, joined by
`purchaseId`. A provider that cannot prove a plan emits one row per source item with
null installment fields instead. All rows live in the same resource, so a billed
line has its own version, events, presence and annotation, with nothing inherited.

| Row            | `amountBasis`         | Key fields                                                                                                                |
| -------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Purchase       | `purchase_commitment` | Whole `amount`, `installmentCount`, `transactionDate`. `purchaseId` is null.                                              |
| Billed line    | `booked_entry`        | `purchaseId`, `installmentCount`, `installmentNumber` (1 or more), its own `billingDate`, the amount billed.              |
| Single charge  | `purchase_commitment` | One row, `installmentCount` null or 1, with a `billingDate`.                                                              |
| Standalone row | any                   | `purchaseId` null. A row with no proven plan, or a billed line whose purchase cannot be resolved (`unresolved_purchase`). |

The link means "associated with", not "settles". No schedule is generated, and a
purchase total is never computed by multiplying a payment. A card-bill payment from a
bank is a `transfer`, never a component. Fewer observed lines than the plan size
never means the plan is incomplete or cancelled. Billed lines are not marked
`not_returned` when a recent window omits them, because search windows are by
purchase date and say nothing about billing dates.

## Perspectives

`list_transactions` and `get_transaction_totals` take `perspective`. It selects
which rows represent a plan, so that a purchase is counted once. A purchase with
live billed lines is a plan purchase even when its count is unknown. Membership
never depends on the other filters, which then apply within the perspective. The
rule is `perspectiveRule` in [read-model.ts](../src/domain/read-model.ts).

| `perspective`        | Members                                                                                                               | Totals                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `spending` (default) | Every row with `purchaseId` null: purchases, single charges, standalone billed rows, fees and cancellations.          | Grouped by currency and `amountBasis`.                |
| `billing`            | Every row except purchases with live billed lines or with `installmentCount` of 2 or more and no `installmentNumber`. | One group per currency.                               |
| `all`                | Every row.                                                                                                            | Rejected with `invalid_input`: it would double-count. |

Standalone rows appear in both `spending` and `billing` without double-counting,
because they have no purchase. A refresh or line removal can fill an unknown
count from the lines' explicit counts; purchase money is unchanged. Held lines
stay unresolved; the purchase commitment is never substituted.

Worked example, one currency: a −300.00 purchase in three installments of −100.00,
with two billed lines observed so far, plus a −50.00 single charge (outflows are
negative).

- `spending`: the plan purchase (−300.00) and the single charge (−50.00), both
  `purchase_commitment`, total −350.00. The billed lines are not members.
- `billing`: the two billed lines (−200.00, `booked_entry`) and the single charge
  (−50.00) total −250.00 in one group. The plan purchase is not a member.

`billing` mixes bases by design to approximate what the card bills; it is not a
reconciled statement or the amount that leaves a bank account.

## Totals

`get_transaction_totals` returns exact sums over the selected rows:
`{totals, fxFees, fxFeeUnknownCount, includedCount, excludedCount, excluded}`,
where `excluded` is
`{pending, transferOrIncome, retiredOrRemoved, unresolved, authorization}`.

- `totals` is a list of [money](#money-and-amount-basis) groups: one per currency
  and `amountBasis` (`spending`) or one per currency (`billing`, where
  `amountBasis` is omitted). Never add groups together.
- `fxFees` lists money objects that sum published `fxFee` values per currency
  over the same eligible rows. `fxFeeUnknownCount` counts eligible converted rows
  (original currency differs from the billing currency) whose fee was not
  published. Unknown is never zero.
- `includedCount` counts eligible matching rows. `excludedCount` is the sum of the
  `excluded` buckets. In every perspective, each excluded row enters the first
  applicable bucket, in the order: retired (superseded) or removed, pending,
  income or transfer, `authorization` basis, then unresolved, such as unknown
  basis or kind, or ambiguous identity.
- `not_returned` alone does not remove a row from totals. An empty list of groups is
  not proof that a refresh was complete.

## Pending-to-posted matching

When a provider supports it, a pending authorization and its later posted row are
matched conservatively and reversibly. The pending transaction keeps its ID and
takes the posted facts, and the posted row is retired with `supersededById`. The
match is one-to-one. Only providers that opt in take part (each provider guide
says whether it does), and billed lines are never matched or linked. Shared
safeguards govern every match; provider evidence can only narrow eligibility.
An unclassified pending row may take a known posted purchase's classification
without claiming that the authorization stated its kind. The
[design](design.md#pending-to-posted-matching) describes the guarantees, and
[reference models](reference-models.md#pending-to-posted-policy) the policy choice.

`postingMatch` on the detailed record describes a match:

| Field                     | Meaning                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `supersededTransactionId` | The retired posted row.                                               |
| `automatic`               | Matched by the service rather than confirmed by the owner.            |
| `policyVersion`           | The policy that decided it.                                           |
| `evidence`                | `{runId, capturedAt}` of the deciding capture, or null.               |
| `unlinked`                | The owner split the pair, so it is never matched automatically again. |

Owner decisions use the pending transaction's ID in the path and take:

| Input                                                                   | Meaning                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `postedId`                                                              | The posted row to link, or the retained row to restore.   |
| `expectedPendingTransactionVersion`, `expectedPostedTransactionVersion` | Current transaction versions, positive integers.          |
| `expectedPendingAnnotationVersion`, `expectedPostedAnnotationVersion`   | Current annotation versions; 0 when no annotation exists. |
| `reason`                                                                | Required, trimmed and nonempty.                           |

`unlink_pending_transaction` restores the pending facts on the original ID and the
corrected posted facts on the retained ID and keeps annotations where they are.
Read both records before either action, because a truncated candidate list does
not prove a unique pairing. When a match changes, billed lines that point at the
retired purchase move to the surviving one in the same write.

## Annotations

An annotation is the owner's independent document. Refreshes never write it.
Compact records carry `{version, category, tags, hasNotes, metadata}` or null; the
detailed read returns the full annotation:

| Field       | Type           | Meaning                                                                                                                                                                              |
| ----------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`   | integer        | Annotation revision, independent of the transaction `version`.                                                                                                                       |
| `notes`     | string or null | Owner notes.                                                                                                                                                                         |
| `category`  | string or null | At most 100 characters; a blank string is rejected, use `null` to clear.                                                                                                             |
| `tags`      | string array   | A set: at most 50 entries, each trimmed, nonempty and at most 100 characters. Duplicates collapse, every write stores tags sorted, and tag order never makes two annotations differ. |
| `metadata`  | JSON object    | Arbitrary owner JSON values.                                                                                                                                                         |
| `review`    | object or null | The owner's decision: `{status}`, `approved` or `needs_review`. The server stamps the reviewed basis (money, currency, basis and kind) internally.                                   |
| `updatedAt` | string         | Last committed edit.                                                                                                                                                                 |

The whole serialized document must fit 64 KiB.

### Update

`update_annotation` is a partial update. Omitted fields are unchanged.

| Input               | Behavior                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `expectedVersion`   | Required guard: the current annotation version, 0 when no annotation exists.                                                              |
| `notes`, `category` | A string sets the value; `null` clears it.                                                                                                |
| `tags`              | Replaced as a whole set; `[]` clears. The same tags in another order are a no-op.                                                         |
| `metadata`          | Merged key by key. A key set to `null` is deleted. `metadata: null` clears all keys.                                                      |
| `review`            | `{status}` records the owner decision, and the server stamps the current basis. `null` removes it. Requires `expectedTransactionVersion`. |

The review guard exists because the decision applies to the transaction's current
money: a review goes stale when the reviewed amount, currency, basis or kind
changes, and never from a change to another field.

`undo_annotation` takes the `annotation.updated` event's `eventId` and
`expectedVersion` (the current annotation version). It restores the exact
previous document, including its historical review basis. Only the annotation's
latest edit can be undone.

### Receipts

Writes return committed receipts, not formatted records. This avoids a re-read that
could fail after a successful write.

| Operation                                     | Receipt                                           |
| --------------------------------------------- | ------------------------------------------------- |
| `update_annotation`, `undo_annotation`        | `{annotation: {transactionId, version}}`          |
| `link_pending_transaction`, `confirm_removal` | `{transaction: {id, version}}`                    |
| `unlink_pending_transaction`                  | `{pending: {id, version}, posted: {id, version}}` |

A lost response leaves the outcome uncertain: reread before retrying. Stored
request-result replay is not implemented.

## Events

Each [event feed](#lists-and-cursors) entry is:

`{id, type, connectionId, transactionId, syncRunId, createdAt, actor, changedFields?, summary?}`

`transactionId` and `syncRunId` are nullable. `changedFields` names the changed
[versioned fields](#versioned-fields) of a `transaction.updated` event, never their
values. `summary` appears on `sync.baseline` events as `{transactionCount, historical}`.
Event IDs are integers, ordered ascending.

| Type                                                               | Meaning                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `sync.baseline`                                                    | First successful capture of an account or resource, with a count summary.       |
| `sync.partial`, `sync.failed`, `sync.recovered`                    | Sync run health.                                                                |
| `transaction.imported`                                             | A record discovered by an initial or historical import. It is not new spending. |
| `transaction.created`                                              | A record discovered by a later recent-window refresh.                           |
| `transaction.updated`                                              | A versioned field changed.                                                      |
| `transaction.posted`, `transaction.linked`, `transaction.unlinked` | Pending-to-posted transitions.                                                  |
| `transaction.removed`                                              | The owner confirmed removal.                                                    |
| `transaction.unlisted`, `transaction.restored`                     | A comparable response omitted or returned the row (presence).                   |
| `transaction.review_required`, `transaction.review_resolved`       | Review state changed.                                                           |
| `annotation.updated`                                               | The owner changed an annotation, or undid a change.                             |

Events are thin. They identify records to refetch in their current state, and carry
no object snapshot. Neither `created` nor `imported` proves when spending occurred.
Observation freshness and references update quietly; the feed signals retained
content changes, including enrichment and private evidence.

The feed's `nextCursor` is **always** a resumable checkpoint: the position after the
last event returned, or the request's own cursor when the page is empty. Start
without a cursor, page while `hasMore` is true, and store `nextCursor` only after
processing the page. Reading does not acknowledge processing.

## Errors

HTTP application errors return `{error: {code, message}}`. Messages are fixed and
exclude SQL, credentials and financial data. Success never adds a `success` flag.

| HTTP status | Code                  | Meaning                                                                                               |
| ----------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| 400         | `invalid_input`       | Invalid query or body, unknown argument, enum, date or cursor, or an inconsistent filter combination. |
| 401         | `unauthorized`        | Missing or invalid authentication, or a mismatched owner or resource.                                 |
| 403         | `forbidden`           | Untrusted Host or Origin, or insufficient scope.                                                      |
| 404         | `not_found`           | Missing record, connection or route. Optional capabilities may have no route.                         |
| 409         | `conflict`            | Stale version, invalid lifecycle state or conflicting decision. Reread before retrying.               |
| 409         | `refresh_in_progress` | A refresh of the connection is already pending or running; read it with `list_refreshes`.             |
| 409         | `requires_attention`  | The provider needs the owner; ordinary refreshes wait for an operator retry.                          |
| 413         | `too_large`           | HTTP request body over 64 KiB.                                                                        |
| 413         | `output_too_large`    | The result exceeds an output bound or the 256 KiB response budget.                                    |
| 500         | `internal_error`      | Unexpected operation or output validation failure.                                                    |

Branch on `code`; malformed HTTP messages and invalid operation messages can differ.
MCP application failures use the same `{error: {code, message}}` as structured and
text tool content with `isError: true`. SDK-level protocol failures follow
JSON-RPC.

## MCP and Events

MCP advertises the same input and output schemas and returns each result in both
`structuredContent` and JSON text in `content`. Tool descriptions state the
perspective semantics and that totals groups are never added together. Tools
carry the MCP behavior hints set in [mcp.ts](../src/transport/mcp.ts); refresh
and `get_refresh` declare external-world access, and `get_refresh` is not
read-only. These hints do not replace authorization. See
[local setup](guides/local-setup.md#connect-an-mcp-client-locally)
for configuration.

When the runtime supplies Events (HTTP on the SQLite server, the PostgreSQL
launchers and the hosted service), `/mcp` also supports the draft MCP Events
methods `events/list`, `events/subscribe` and `events/unsubscribe`, through the
official SDK's validated custom methods. They are a protocol capability, not
tools, and the [hosted guide](guides/hosted-service.md#mcp-events-and-webhook-delivery)
covers delivery troubleshooting.

- **Discovery and subscription.** `events/list` takes `{}`. `events/subscribe`
  takes `name:"changes.available"`, `arguments:{connectionId}`,
  `delivery:{mode:"webhook",url,secret}` and optional `ttlMs`, and returns the
  subscription `id`, `refreshBefore`, `cursor:null` and `truncated:false`.
  `events/unsubscribe` takes the same name, arguments and callback, without the
  secret. A compatible host must actually subscribe and provide its callback;
  installing a plugin alone proves no subscription or delivery.
- **Identity and lifetime.** A subscription is identified by owner, client,
  callback, event name and arguments. No replay cursor other than null is
  supported. Renewing an unexpired active or failed subscription, or a revoked one
  with a new valid grant, keeps its pending checkpoint; new, expired and stopped
  subscriptions start at the current change cursor. Subscriptions default to one
  day, the requested TTL is clamped to one minute to seven days, and they must be
  renewed before `refreshBefore`. The grant a subscriber needs, and when delivery
  stops, are in the [security model](security-model.md#revocation).
- **Callbacks.** The URL and its `whsec_` Standard Webhooks secret (24 to 64
  decoded bytes) come from the host's protocol integration, never from chat or
  owner text. Fonds first sends a signed `{type:"verification",challenge:...}`,
  and the receiver verifies the signature and returns JSON echoing the
  challenge. Verification is cached for five minutes; changing the secret
  re-verifies and signs with the old and new keys for a five-minute rotation
  window. Callbacks need public unicast DNS addresses; resolution is pinned for
  each request, redirects are not followed, and sizes and timeouts are bounded.
  Deliveries carry `webhook-id`, `webhook-timestamp`, `webhook-signature` and
  `X-MCP-Subscription-Id`; the receiver verifies the exact body bytes and
  deduplicates the event ID.
- **Wake-ups.** The `changes.available` payload is
  `{connectionId, after, highWaterMark}`: opaque `list_events` cursors for the
  position before and after the batch, and no financial rows, merchants, amounts
  or source bodies. One wake-up covers every change committed through its
  boundary, including baselines, imports, corrections and annotations, so it is
  not a new-purchase alert. Pass `after` as `cursor` to `list_events`, read from
  the consumer's own durable checkpoint and advance it only after processing. The
  boundary is persisted before sending, so retries keep identical event IDs and
  bodies, and later changes get a later wake-up. Delivery is at least once, and a
  consumer must catch up by polling without a webhook too.

## Limits

- Output identifiers are at most 1,024 characters and source text at most 4,096.
- Every operation is schema-validated and capped at 256 KiB of serialized JSON.
- Money amounts are exact decimal strings; SQL stores signed safe-integer minor
  units (at most 9,007,199,254,740,991).
- Structured addresses, verified international phone fields, settlement
  relationships, structured remittance and standard exporters are not provided. They
  need source evidence and an actual use before they are added.
