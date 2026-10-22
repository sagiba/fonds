# Isracard source notes

> For Isracard adapter maintainers. Owns source evidence, interpretation rationale and uncertainty; the adapter code owns the mappings and the linked tests own expected outcomes.

Isracard's private endpoints have no public contract. Observations are maintainer
attestations from owner-authorized collection, a value-free
[archive profiler](../../../tests/providers/isracard/scripts/audit-isracard-db.ts) and
cited public implementations, not reproducible validation. [Fixtures](../../../tests/providers/isracard/fixtures/README.md)
are invented. Neither certifies every account or future shape. Accounting meanings
need evidence, never a review-bypass option.

[Declared retention](evidence.ts) keeps source identity, money, dates, merchant and
payment facts, explanations and bound financial detail, including unresolved roles
described below. It excludes unknown fields and nested noise. Interpretations,
session GUIDs and billing-month context are separate; exact responses require
optional raw archives. Overlapping observations keep distinct vouchers and source
generations; a fresh component replaces its earlier evidence.

## isracard.login: login, TLS and session

- **Observed:** login posts to the legacy `digital.isracard.co.il` host and sets
  parent-domain session cookies that the DigitalV3 `web.isracard.co.il` routes
  accept; no session hand-off or browser transactions page is needed. The login
  POST is accepted only with browser-compatible TLS and HTTP/2 behavior,
  including the pseudo-header order `:method`, `:authority`, `:scheme`, `:path`:
  Node's default order is blocked on that POST while GETs are admitted, and
  ordinary Node fetch or HTTP/2 SETTINGS changes alone did not reproduce the
  accepted request. No mobile API was demonstrated.
- **Policy:** certificate verification stays enabled, only the fixed origins are
  reachable and redirects are not followed. Challenges, password failures and
  rate limits stop the invocation, so a password is never retried.
- **Unknown:** this is observed edge compatibility, not a provider guarantee.
  Runtime changes, account state, cloud and EU-region egress, session lifetime
  and unattended operation need separate validation.
- **Checks:** [transport] "uses the proven login content type…", "never retries
  a password…", "hard-stops explicit provider login redirects…"; [node http]
  "routes digital through HTTP2 with certificate validation…".

## isracard.envelope: response shapes and acceptance

- **Observed:** DigitalV3 marks success with `isSuccess`; the legacy statement
  and details with `Header.Status` `1`. DigitalV3 data holds
  `israelAbroadVouchers` (the statement list, its `totalForStatement` and the
  `outOfStatementChargeDateVouchers` immediate-charge groups), `approvals` and
  `currentTransactionsList`. Empty posted responses were observed with all
  sections null, a recognized approval-list object beside null
  voucher/current-transactions sections, or a pending summary beside null
  approvals/vouchers. Malformed approval containers remain unsupported.
  Legacy groups under `CardsTransactionsListBean.Index<n>.CurrentCardTransactions[]`
  carry one partition each (`txnIsrael`, `txnAbroad` or `txnInfo`), null when
  empty. The detail route answers in `PirteyIska_204Bean`.
- **Approvals:** authorized collection established the
  `approvals.approvedTransactions` row list; the public frontend also reads its
  container's `totalEstimatedAmount`. The frontend treats root `errorCode` `1`
  and `13` as approval-section failures, independently of `isSuccess`. With no
  section error, explicit null approvals render no approval section, as an empty
  array does. Its optional chaining also tolerates missing fields; Fonds does not
  treat that as evidence for absent or malformed containers.
- **Public frontend provenance:** inspected on 2026-10-20:
  [transactions][issuer-transactions], SHA-256
  `236f9f87e7ec470b4a8b8f63d48831dab74e02efd1b8478718c183034a435a64`, and
  [approval details][issuer-approval-details], SHA-256
  `679ba9a285027b6367ee9ed05629b9c67c503bf714995ba6daa4c81680838eee`.
  These public implementations establish client behavior, not server guarantees.
- **Policy:** collection archives only transport-accepted responses. Top-level
  application failures and nonzero DigitalV3 root error codes become typed
  failures with bodies discarded; collection does not distinguish section
  failures. That DigitalV3 month is unavailable even if another section could
  supply rows. Imported responses remain archived, but failed DigitalV3 evidence
  supplies no ledger facts. Unsupported partitions stay raw; recognized
  successful siblings remain usable with incomplete coverage.
- **Checks:** [extraction] "accepts the observed all-null DigitalV3 month…",
  "accepts the observed approvals-only response…", "keeps unverified
  approval-bearing null-voucher shapes partial…", "rejects imported failed
  DigitalV3 facts…", "retains imported approval archives verbatim…", "reads the
  observed one-partition legacy groups…"; [transport] "rejects successful
  DigitalV3 envelopes carrying root errorCode…", "never retries a password…".

## isracard.window: billing months, history and pending summary

- **Observed:** DigitalV3 answers one card/month per request, with roughly four
  years available; legacy answers one month/all cards and alone supplies older history.
  Combined multi-year collection succeeded; monthly retry recovered a transient legacy
  failure. Co-branded cards have no demonstrated legacy/detail route; no
  legacy-only fallback exists. Details cover some transactions.
- **Request selection:** the public frontend sets `isNextBillingDate` from the
  selected card/month's discovered billing `period` `Next`, rather than calendar
  comparison. It searches cached next before last, so next wins a same-month tie.
  An authorized paired probe manually selected the next calendar month: null
  `approvals` with false, an approval list with true. Lossless structural
  comparison found identical `israelAbroadVouchers` in those paired responses;
  this does not establish preservation for other accounts or months.
- **Pending list limits:** the frontend maps and renders the entire returned
  approval array without a five-row limit in that path. This establishes neither
  server completeness nor a server row limit.
- **Pending summary:** `currentTransactionsList` groups unbilled transactions by
  upcoming `currentBillingMonth` (`DD/MM/YYYY`) and currency, stating
  `transactionsTotal`, `transactionsCurrency`, `transactionsSymbol` and
  `transactionsCount`. These transactions are absent from statement/immediate
  lists; merchant and date are unstated.
- **Policy:** collection follows discovered periods within its existing month
  range. A bound, successful response requested with the archived next-period
  flag supplies the current pending snapshot when its approval array or explicit
  null matches a recognized envelope. Pending absence is comparable only inside
  that billing month's scope; rollover does not prove disappearance. Posted
  partitions remain noncomparable: a billing month is neither a purchase-date
  window nor calendar cutoff. The summary stays raw without reducing posted
  coverage. A card absent from discovery has no proven session GUID, so its rows
  are never assigned by suffix.
- **Unknown:** complete source history, every old card, server pending limits
  and completeness, coverage across rollover, lifetime identity stability, and
  posted preservation beyond the paired check. Snapshot completeness is an
  adopted policy supported by the full-list UI, not a server guarantee.
  Application success alone does not prove completeness; an empty
  month proves neither inactivity nor history depth. Combined monthly responses
  are not an atomic provider snapshot.
- **Checks:** [extraction] "marks history explicitly and never permits
  disappearance…", "keeps the pending summary raw…", "reports a non-null
  current-transactions partition beside vouchers as partial…"; [pending]
  "recognizes explicit empty Next authorization coverage…"; [collection]
  "collects open and just-closed periods…", "bounds history before login…";
  [scope].

## isracard.cards: discovery, billing accounts and holder data

- **Observed:** the DigitalV3 card list gives each card `companyCode`, a
  four-digit `cardSuffix`, a session `cardGuid` and a product `cardName`, beside
  holder names, `limitData`, activity flags, charge dates and the paying
  account's `bank`, `branch` and `accountNumber` strings, which Fonds keeps only
  as `billingAccount`'s `providerKey` and `mask`. `cardGuid` changes at
  every login. `bank` is a numeric code, not an institution name.
- **Holder data in financial responses:** legacy `holderName`,
  `displayProperties`, `selectedCardInfo`, `card6Digits` (six digits of the
  selected card) and `cardNumberTail` (every card's last four); a detail's `info`
  and `motavName` (the other party, a person for a person-to-person payment).
  The login identity number can reappear in legacy `userId`, `holderId`,
  `currentId` or a key `id<number>`.
- **Rationale:** the owner is identified by OAuth and cards by provider keys, so
  holder data adds risk for no benefit. Financial responses stay exact, so only
  the card list, which the extractor needs just to bind each capture's card, is
  stored as an allowlisted projection. The identity number is replaced only at
  the recognized holder locations and the result rechecked; anywhere else,
  including an unquoted, padded or coincidental voucher value, it rejects the
  response rather than altering evidence. The billing account's private key is
  the raw `bank|branch|accountNumber`: the number is semi-public, and a keyed
  hash whose key sits in the same database would be brute-forced in seconds.
- **Unknown:** later reuse of a card's final four digits, partner-card
  ownership, and whether the card's collection scope is its funding account.
- **Checks:** [collection] "projects the evidenced product cardName…",
  "omits invalid cardName…", "archives the login identity number as a marker…",
  "rejects a numeric identity reflection that redaction would make invalid",
  "never archives reflected secrets…", "discovers each card's billing account…",
  "leaves the mask null when the account number does not end in four digits",
  "archives only the allowlisted card list…", "projects an old raw card list for
  replay…"; [extraction] "rejects suffix-only identity…".

## isracard.identity: vouchers and generation joins

- **Observed:** DigitalV3 `seqVoucherNumber` equals legacy `voucherNumberRatz`
  (abroad `voucherNumberRatzOutbound`) in the observed uniquely compatible joins.
  DigitalV3 `voucherNumber` is the deal or plan voucher, shared by a plan's
  payments and padded to seven digits in legacy. Fee rows reuse one-digit
  vouchers, and an unrelated row can share a plan's voucher. Legacy card indices
  correspond to cards through the string `cardNumberList` entries.
- **Approval identity evidence:** the public frontend uses `confirmationNumber`
  for its display key. Authorized schema analysis found colon-composite display
  keys and opaque digit/separator `confirmationTimeStamp` strings. Approval detail
  addressing requires
  `confirmationLocation`, `seqConfirmationNumber` and `confirmationTimeStamp`,
  together with `last4digits`, `companyCode` and `isPartner`. Owner-authorized
  comparisons retained the tuple for unchanged uniquely described source rows
  within a session and after a fresh login. This supports practical stability,
  not lifetime uniqueness or correspondence to a posted voucher.
- **Policy:** card, voucher and purchase date are identity evidence, not proof
  of global uniqueness. Per-row vouchers stay strings with their leading zeros,
  and numeric-equivalent lexemes across generations are reviewed, never
  normalized; the plan voucher is the one padded value compared without leading
  zeros. DigitalV3 is preferred, and legacy fills what it omits, notably standing
  orders (`isHoraatKeva`). Approvals use the card-qualified full detail tuple as
  native identity; missing or colliding tuples never become trusted unique rows.
- **Continuation policy:** there is no demonstrated shared approval/voucher ID.
  The adapter narrows the [shared heuristic][matching-design] to a unique
  approval and verified posted purchase with exact merchant equality and known
  original money. Pending kind remains unknown; posted evidence supplies the
  purchase classification. Opaque codes add no invented meaning. Cancellation
  followed by an unrelated identical purchase remains a possible false link.
- **Checks:** [extraction] "prefers DigitalV3, joins unique voucher evidence…",
  "joins equal numeric voucher lexemes and flags numeric-equivalent mismatches…",
  "preserves all duplicate voucher occurrences…", "keeps card and transaction
  identity when a later login issues a new session cardGuid", "matches reordered
  duplicate rows by source facts…"; [pending] "uses the full opaque detail-address
  tuple…", "automatically continues a same-month singleton on the pending ID…";
  [refresh].

## isracard.money: signs and currency codes

- **Sign:** the signed convention is source-derived from upstream PR
  [#1159][upstream-1159], inspected at head
  `41021421497a531493d8c569c453f29db0cd0997` on 2026-10-20:
  `base-isracard/base-isracard-utils.ts` negates DigitalV3 `billingAmount` and
  `originalAmount`, including approvals, and the legacy scraper negates `paymentSum` or
  `paymentSumOutbound`. It is not an issuer codebook or live validation of every
  type, so every row keeps a review issue for it. A literal `"-"` legacy
  `paymentSumSign` accompanies an already negative `paymentSum`.
- **Currency codes:** DigitalV3 billing codes `0`, `19` and `100` were observed
  as ILS, USD and EUR; unlike that PR, Fonds does not default a missing code to
  ILS. Legacy `currencyId` carries the shekel texts `₪`, `ש"ח` and `ש״ח`, the
  dollar text `דולר` or an ISO code. The `NIS` shekel alias follows upstream at
  commit `5170a65ffaf8df2d22f32b0fa1656350a8337590`:
  [`src/constants.ts`][upstream-constants] (`ALT_SHEKEL_CURRENCY`) and the legacy
  `convertCurrency` in [`src/scrapers/base-isracard-amex.ts`][upstream-amex].
  Other markers stay unresolved.
- **Approval money:** the public detail UI displays `originalAmount` with
  `originalCurrencySimbol`, labels the original currency using `currencyIso`, and
  displays `ilsBillingAmount` separately in ILS. The list's `originalCurrency`
  is a visual sorting code, not ISO numeric currency. Fonds uses the stated ISO
  original money as an authorization and retains unknown kind; neither a sign
  nor an opaque transaction code establishes purchase or refund classification.
- **Checks:** [extraction] "uses the observed USD currency code…", "maps billing
  currency code 100 to EUR and the legacy dollar text to USD", "maps the legacy
  shekel texts %s to ILS", "maps the source-derived legacy NIS alias to ILS…",
  "leaves unknown
  currencies and unsupported money precision unresolved", "retains legacy sign
  %s without applying it again…".

## isracard.amount-basis: what a DigitalV3 bill states

- **Observed:** in every same-currency DigitalV3 row, `originalAmount` equals
  `billingAmount` plus `discountAmount` (or zero). A waived card fee bills 0 with
  its list fee as the original amount. A legacy-only waived card fee states
  `moreInfo` "הנחה <amount> ש"ח" ("discount <amount> ILS") with `paymentSum` 0
  and a positive `dealSum`.
- **Policy:** a reconciled same-currency bill of a mapped kind is a purchase
  commitment, as for CAL's posted rows; a posted row does not establish an
  account booking. A same-currency row that does not reconcile keeps its
  original money unknown.
- **Unknown:** the billed side of a cross-currency row (for example whether a
  waived conversion commission is inside the bill), so no rate is computed;
  `txnInfo` rows' source role; parallel `ilsAmount` and `usdAmount`; discount
  components; null fee, rate and interest placeholders, where null does not mean
  zero or fee-free.
- **Checks:** [amount basis] "names a same-currency charge's bill as a purchase
  commitment…", "keeps a same-currency row whose original money does not
  reconcile unverified", "keeps cross-currency bills at an unknown basis…",
  "maps a waived card fee to amount 0…", "maps a legacy-only domestic waived
  fee…"; [extraction] "preserves legacy-only txnInfo standing-order evidence…",
  "keeps independent foreign source amounts…".

## isracard.type: transaction codes

Each DigitalV3 row labels its own `transactionCode` in `transactionDescription`,
and every code had one label. That label is the evidence for a kind:

| Code | Source label                                 | Gloss                                 |
| ---- | -------------------------------------------- | ------------------------------------- |
| `1`  | עסקאות רגילות                                | Regular transactions                  |
| `3`  | עסקאות בתשלומים                              | Installment transactions              |
| `7`  | תיירות יוצאת קניות                           | Outbound tourism purchases            |
| `8`  | `תיירות יוצאת משיכת  מזומן ATM` (two spaces) | Outbound tourism, ATM cash withdrawal |
| `10` | דמי כרטיס                                    | Card fees, company 77 cards           |
| `12` | עמלת דמי כרטיס - בנקים                       | Card fees, bank (company 11) cards    |
| `20` | P2P BIT                                      | Person-to-person, Bit                 |
| `23` | P2P כל היתר                                  | Person-to-person, all others          |

- **Observed:** code `7` means a foreign acquirer (`isIsraelDeal` false),
  including online merchants that bill ILS, not travel. Code `1` also carries Bit
  transfers, whose `businessName` is the provider label `העברה ב BIT בנה"פ` or
  `העברה בBIT` ("transfer by BIT"); a detail's `sector` names them too.
- **Rationale:** no row carries a refund marker, so a zero or negative row of an
  outflow code is not classified as a refund. Legacy rows have no code and stay
  unknown, even with the Bit label.
- **Checks:** [extraction] "maps DigitalV3 transactionCode %j…", "maps card fees
  at any sign…", "maps positive code 1 Bit transfers by their exact provider
  label…", "leaves unmapped, padded and malformed transaction codes unknown",
  "leaves legacy-only rows unknown…".

## isracard.atm-fee: cash withdrawal and its fee line

- **Observed:** a code `8` withdrawal's DigitalV3 bill includes its cash-advance
  fee. The legacy statement lists the withdrawal without the fee and the fee as
  a separate zero-voucher `CASH ADVANCE FEE` abroad line in the same card-month,
  so the fee is not missing.
- **Policy:** the DigitalV3 bill is source-stated only when it equals the joined
  legacy withdrawal plus exactly one fee line of the same capture and currency
  that fits no other withdrawal; otherwise the generations conflict. The fee line
  never becomes a row, and no fee is computed. Withdrawals bill across
  currencies, so their basis stays unknown.
- **Checks:** [amount basis] "cash withdrawals"; [extraction] "keeps a code 8
  cash withdrawal's fee-inclusive DigitalV3 bill…".

## isracard.payment-context: channel, wallet and counterparty

- **Observed:** DigitalV3 `tranzacCodeType` takes `U` internet, `V` secure
  internet, `R` regular, `T` phone and `H` signed. `presentCard` true means a
  physical card was presented, and false means nothing: in-store wallet payments
  are false. `isTransactionSecure` means strong cardholder verification (chip,
  wallet or 3-D Secure), not 3-D Secure alone, and `isWalletTransaction` a
  tokenized card, card-on-file subscriptions included, not a mobile wallet. A
  detail's `transactionType` or `walletPayName` can name a wallet. Standing
  orders are legacy `isHoraatKeva` and DigitalV3 `isdirectDebit`. Collected data
  has no verified MCC mapping. Foreign rows state merchant number `0`, and their
  city slot can hold contact information. A bound detail's `clearingData` explicitly
  says presented or not presented. Named Apple Pay occurs in both modes; `R`
  does not prove terminal use. Bound detail `dealCode` restates DigitalV3's
  channel code where both are present and uses that codebook.
- **Approvals use different encodings:** wallet/security/channel descriptors,
  merchant facts and credit/recurrence indicators remain scalar evidence. Numeric
  flags are not posted booleans; category codes are not established MCCs.
  `APPLE MC` names Apple Pay; internet descriptions establish online use without
  treating security code `V` as posted 3-D Secure. Detail method, recurrence,
  reason and website slots remain evidence even when null. Request/UI/holder
  metadata and unknown descendants stay excluded; `sumOfCompensation` is an
  excluded system-code label, not money.
- **Policy:** channel, wallet and presentation evidence are independent. Explicit
  online/telephone evidence establishes remote use; a bound presentation label
  supplies presence directly. The negative DigitalV3 flag alone states nothing.
  Named remote wallet use is online, while a wallet name alone implies no channel.
  Conflicting known statements leave the affected facts unknown. Retained bound
  details remain evidence through sparse refreshes, so omitting them cannot clear
  their conflicts. Valid same-row
  city and ISO alpha-3 country fields are used on pending and posted rows; phone-only
  cities and explicit web/email addresses are rejected. A transfer's bound
  `motavName` carries no further party role. An absent optional detail preserves an unambiguously matched
  native transfer's prior counterparty name; a valid bound detail with an empty
  counterparty clears it.
- **Checks:** [payment context] covers independent payment facts and conflicts;
  [pending] covers approval enrichment; [extraction] covers bound-detail and
  merchant projection.

## isracard.detail: optional transaction details

- **Observed:** a detail carries its own `voucherNumberRatz`, the merchant
  address and phone, wallet labels, a raw payment table (`Table1`, numbered rows
  beside a null-ordinal row and a total row) and null commission, fee,
  conversion, rate and interest placeholders. Its money fields: `dealSum` is the
  original amount (a plan's total) with a leading minus; `chargeSum` the amount
  billed for that voucher, with a trailing minus ("N.NN-") and possible spaces;
  `linking` the original-currency symbol; and `sumBeforeDiscount`, despite its
  name, the discount, equal to DigitalV3 `discountAmount`. `moedChiuvFull` is
  the voucher's charge date, `clearingData` whether the card was presented and
  `solek` the acquirer. `isError` has no established meaning.
- **Policy:** a detail supplies facts only when exactly one detail's own voucher
  matches the transaction's; any other detail stays in the archive alone. Its
  money fields and payment table stay raw and never create a schedule or total.
- **Public lead:** the issuer's [modern detail client][issuer-posted-details]
  and [public content][issuer-detail-content], inspected on 2026-10-20, name
  explicit conversion-rate/date fields and fee amounts such as `netFee`.
  Their SHA-256 hashes are
  `1bed198c385487b5d1c734003d4f076abca5dc0fab8e257f8e2f244929da77bd` and
  `2f130aa2a44a8629e45f54603c5b9ccaf1abc28f8041d9cd73e9326f3bcfa238`.
  `GetTransactionDetails` uses the posted sequence and card context; no accepted
  local response establishes its binding, types or financial extraction. This
  route is not collected, and existing FX uncertainty remains.
- **Checks:** [extraction] "projects no address, phone, wallet or detail copy
  from a detail bound to another voucher", "keeps independent foreign source
  amounts, payment tables and null fee placeholders…".

## isracard.dates: purchase and billing dates

- **Observed:** dates are `DD/MM/YYYY`. DigitalV3 `purchaseTime` has second
  precision or is null; optional detail time has minute precision or is null.
  No route states a booking date.
- **Policy:** a time joins its own row's purchase date only; a voucher-only
  detail match cannot establish that date, so detail time stays raw. A requested
  billing month never supplies a billing date; a bound detail's `moedChiuvFull`
  does. Conflicting known dates yield none and `conflicting_billing_date`.
- **Checks:** [extraction] "leaves malformed or missing purchase time unknown…",
  "does not promote ambiguous, invalid-date or installment source times…",
  "extracts out-of-statement billing dates…".

## isracard.installments: plans and payments

- **Observed:** a plan payment is a DigitalV3 code `3` row with
  `currentInstallmentNum`, `numberOfInstallment`, `isLastInstallment` and
  `moreInfo` " תשלום N מ M " ("payment N of M"); its legacy companion states
  `moreInfo` "תשלום N מתוך M" ("payment N out of M"), the total in `dealSum` and
  the payment in `paymentSum`; a bound detail states `paymentNumber`,
  `numberOfPayments` and `dealType` "עסקה בתשלומים". Each payment has its own
  voucher, and payments share the plan voucher and purchase date. Payments can
  be uneven, typically the first. Archives can start mid-plan.
- **Not observed:** converted plans, early repayment and plan cancellation. A
  null count does not prove a single payment.
- **Policy:** the purchase states the source total and is never computed from
  payments, and plan rows carry no purchase time or original money. Every source
  that states an ordinal or count must agree, and other DigitalV3 prose naming a
  payment is not an ordinal source.
- **Checks:** [installments], including "takes a mid-plan purchase total as
  stated…", "joins a padded legacy plan voucher…", "keeps foreign, converted,
  non-plan-code and non-positive payments unresolved", "leaves a plan total
  unknown when its payments or generations state different totals", "keeps
  money on ordinary DigitalV3 rows whose prose names a payment"; [extraction]
  "fails closed on malformed nonnull installment indicators".

## isracard.totals: source totals and statement artifacts

- **Observed:** DigitalV3 states `totalForStatement` per billing currency and,
  per immediate-charge group, `totalImmediateVouchers` and
  `countImmediateVouchers`. The legacy domestic list carries total rows
  (`dealSumType` `1` for ILS, `T` for USD) and zero-voucher summaries; the abroad
  list carries `TOTAL FOR DATE` rows whose sums include the `CASH ADVANCE FEE`
  lines.
- **Policy:** Domestic `T` totals stay raw regardless of voucher, alongside
  `1` rows and all-zero-voucher lines. A disagreeing
  total is a warning, never a failure, and an agreeing one does not prove no row
  is missing; equal card totals never justify skipping transactions.
- **Checks:** [amount basis] "source totals"; [extraction] "keeps known legacy
  statement summaries raw-only…".

[amount basis]: ../../../tests/providers/isracard/amount-basis.test.ts
[payment context]: ../../../tests/providers/isracard/payment-context.test.ts
[collection]: ../../../tests/providers/isracard/collection.test.ts
[extraction]: ../../../tests/providers/isracard/extraction.test.ts
[refresh]: ../../../tests/providers/isracard/repeated-refresh.test.ts
[installments]: ../../../tests/providers/isracard/installments.test.ts
[matching-design]: ../../../docs/design.md#pending-to-posted-matching
[node http]: ../../../tests/providers/isracard/node-http.test.ts
[pending]: ../../../tests/providers/isracard/pending.test.ts
[scope]: ../../../tests/providers/isracard/scope.test.ts
[transport]: ../../../tests/providers/isracard/transport.test.ts
[upstream-1159]: https://github.com/eshaham/israeli-bank-scrapers/pull/1159
[issuer-transactions]: https://web.isracard.co.il/ocp/transactions/DigitalV3.Transactions/DigitalV3.Transactions.Frontend/prod/assets/index-Dt-M-_KF.js
[issuer-approval-details]: https://web.isracard.co.il/DigitalV3.ApprovalDetails/DigitalV3.ApprovalDetails.Frontend/prod/assets/index-udjkD_jr.js
[issuer-posted-details]: https://web.isracard.co.il/ocp/transactiondetails/DigitalV3.TransactionDetails/DigitalV3.TransactionDetails.Frontend/prod/assets/index-CpuNtMGa.js
[issuer-detail-content]: https://web.isracard.co.il/ocp/transactiondetails/DigitalV3.TransactionDetails/GetContent
[upstream-constants]: https://github.com/eshaham/israeli-bank-scrapers/blob/5170a65ffaf8df2d22f32b0fa1656350a8337590/src/constants.ts
[upstream-amex]: https://github.com/eshaham/israeli-bank-scrapers/blob/5170a65ffaf8df2d22f32b0fa1656350a8337590/src/scrapers/base-isracard-amex.ts
