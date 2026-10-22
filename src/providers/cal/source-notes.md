# CAL source notes

> For CAL adapter maintainers. Owns source evidence, interpretation rationale and uncertainty; the adapter code owns the mappings and the linked tests own expected outcomes.

CAL's private transaction endpoints have no public contract. Observations are
maintainer attestations from owner-authorized exports and a value-free
[structural audit](../../../tests/providers/cal/scripts/audit-cal-db.ts), not publicly
reproducible validation. [Fixtures](../../../tests/providers/cal/fixtures/README.md) are invented; the
[observed schema](../../../tests/providers/cal/schemas/cal-observed.schema.json) checks
structure. Neither certifies every account or future shape.

[Declared retention](evidence.ts) keeps source identity, money, dates, merchant and
payment facts, explanations and unresolved financial roles described below. It
excludes unknown fields and nested noise. Interpretation state and capture context
are separate; exact responses require optional raw archives. Overlapping payments
keep distinct components; a fresh component replaces its earlier evidence.

Source-origin/nature and card-type codes, wallet classifications, merchant category
labels, named financial-status flags and pending amount/authorization slots remain
evidence even where their normalized meaning is unresolved. Null, false and zero
are source assertions, not evidence of refresh noise. `walletTokenInd` classifies
the payment credential; token identity digits stay excluded. Source sequence and
redundant comment-presence metadata remain excluded. `isMargaritaInd` has no
established transaction role and remains unretained, not classified as proven noise.

## cal.envelope: response shapes

- **Observed:** recent responses carry `result.transactions`,
  `result.clearanceRequests` and `result.daysRange`; search carries
  `result.transArr`; the billing-month route carries `result.bankAccounts`. Posted
  and pending rows are different schemas, not one object with a changed status.
  Recent posted rows have 73 keys; older accumulated rows have 71 because
  `paymentsMade` and `paymentsMadeComment` can be absent. Pending has 19 keys in
  two variants, the earlier without `transactionID` and `isAbroadApproval`.
  `statusTitle` was only ever null. Initialization names the account
  `bankAccountUniqueId`; the recent request expects `bankAccountUniqueID`.
- **Negative findings:** `statusCode: 1` marks application success, not
  completeness. Search reports no data with a status-93 envelope, which proves
  nothing about history. No supported search cursor was found, and the search
  wallet and cash controls have no established contract; neither is used.
- **Billing month:** each card response has one `bankAccounts[]` entry with
  `bankName` and `bankAccountNum` (branch and account), and rows under both
  `debitDates[].transactions` and `immidiateDebits.debitDays[].transactions`. The
  layout follows a public reference implementation's description of it and was
  compared with observed JSON structure. Its amount roles are not established, so it stays diagnostic.
- **Checks:** [extraction] "never asserts success…"; [collection] "archives the
  synthetic search93…", "archives unsupported search pagination…".

## cal.window: recent window and search coverage

- **Observed:** the recent response asserts `daysRange: 90`, but its boundaries,
  governing timezone and completeness are unvalidated; approximate 30-day
  stability is only a hypothesis. A row missing from a later capture is not proved
  removed. A successful empty yearly search can omit records that its quarterly
  or monthly subdivisions return. The web frontend's 540-day selection limit is
  not a server retention guarantee.
- **Policy:** recent absence uses a 60-day horizon as a safety margin inside the
  asserted window. CAL rows have a purchase date and no booking date, and billed
  lines are not compared for absence because search selects by purchase date.
  Search windows are padded by one UTC day because the boundaries are unknown.
- **Checks:** [collection] "CAL monthly search coverage regression", "pads UTC
  calendar dates…".

## cal.init: card discovery and personal data

- **Observed:** initialization lists each card with `cardUniqueId`,
  `last4Digits`, `cardDescription` and `bankAccountUniqueId`, an opaque key shared
  by cards charged to the same bank account. The same response carries the
  cardholder's first, last and full name, email, mobile phone and national ID.
  `tokenNumberPart4` is a wallet-token suffix, not the card's last four digits.
- **Rationale:** the owner is identified by OAuth and cards by provider keys, so
  holder identity would add risk to the database and backups for no benefit.
  Redacting a stored copy would break exact archives; an allowlisted projection
  keeps both rules. Card state is current state, reread at every login.
  Discovery does not establish card status or financial coverage.
- **Checks:** [collection] "stores allowlisted init card facts privately…",
  "leaves invalid, missing, numeric and wallet-token digits unknown…".

## cal.payment-context: channel fields

- `transCardPresentInd` is on every row and means "at a terminal": in-store Apple
  Pay is true, and false means remote, not necessarily online.
- `trnExacWay`: `21` contactless wallet (exactly the rows with the contactless
  comment), `9` standing order, `12` general online, `15` and `35`
  online with it. `0,1,3,4,5,7,10,13,14,16,17,18,20` are unverified.
- `walletProviderCode` with `walletProviderDesc`: `3` with `Apple Pay`, `0` none;
  `32`, `2`, `14`, `22` and `85` carry the Hebrew word for internet and look like
  merchant tokens. These internet-labelled codes support online use; `32` works
  alone too. Named Apple Pay explicitly marked remote
  is online wallet use, not a terminal tap.
- **Negative finding:** `posEntryMod` is unusable: in-store Apple Pay rows can
  carry `02`, contradicting ISO 8583.
- **Policy:** each typed fact needs explicit evidence, and contradicting evidence
  leaves it unknown with a source issue. Unknown/general execution codes do not
  negate explicit contactless or secure-online text. Secure-online text establishes
  online use and 3-D Secure; contactless evidence conflicts. Other security codes
  remain uninterpreted.
- **Checks:** [enrichment] "CAL comment templates and payment context", "CAL
  payment context through ingestion"; [source patterns] "makes payment context a
  conflict when a plan's rows disagree…".

## cal.type: transaction types

- **Observed:** posted `transactionTypeCode` (number) with label `trnType`: `5`
  regular, `6` refund, `7` cash withdrawal, `8` installments, `9` standing order,
  `25` sale reversal, `26` credit reversal, `67` membership fee, `71` service
  refund, `72` services, `76` debit or credit, `86` installment cancellation.
  Pending rows carry a string `trnTypeCode`. `refundInd` is on every posted row.
- **Rationale:** "services" does not establish a fee, and sign alone never
  classifies a row, so `72`, `26` and `76` stay unknown.
- **Checks:** [source patterns] "CAL patterns evidenced by the live shape audit";
  [extraction] "matches every golden posted baseline projection…".

## cal.money: amount roles and signs

- **Observed:** `amountForDisplay` is the signed native billed amount, and
  `currencyForDisplay` agrees with the billed symbol. `trnAmt` is an original
  amount candidate, positive on refunds and nonzero on waived fees.
  `amtBeforeConvAndIndex` is the billed component. `debCrdCurrencyCode` and
  `transOriginalCurrencyCode` use provider codes (`1` USD, `3` ILS, `7` EUR);
  `trnCurrencyIsoCode` is an ISO numeric string; `srcCurrencyCode` restates it,
  empty exactly when it is null, and `crmIccCurrencyDesc` names the billing
  currency's ISO alpha code. `transOriginalSumCurrency` is nonnumeric despite its
  name. `forcedDebRate` was always empty or `0`: rates and
  fees appear only in comments. Charges are positive, refunds negative and waived
  rows zero, but that sign agreement is not a universal guarantee.
- **Negative findings:** a USD merchant charge can be billed in ILS, so a billed
  amount is never converted again; direct USD or EUR billing is its own native
  amount. Symbols and the abroad flag do not establish a conversion. Cash-account
  and rate-like fields never replace purchase or original money. On a
  discounted row `amountForDisplay` is not reduced, but `amtBeforeConvAndIndex`
  is reduced by `discountAmount`; a discount is never subtracted again.
- **Policy:** posted money is a full-purchase commitment, pending money an
  authorization. A currency restatement that disagrees is a conflict.
- **Checks:** [currencies] "CAL original-currency roles"; [extraction] "retains
  opaque numeric cash-account metadata…".

## cal.currency-marker: original-currency symbols

- **Observed:** `trnCurrencySymbol` maps one-to-one to `trnCurrencyIsoCode`: `₪`
  ILS/376, `€` EUR/978, `$` USD/840, `£` GBP/826, any other currency its ISO
  alpha code.
- **Hypothesis:** pending `trnAmt` is in the currency `trnCurrencySymbol` names.
  `$` to USD was verified on a pending and posted pair; other pending mappings are
  inferred from posted evidence. A symbol alone never fills missing posted
  original money.
- **Scales:** the [SIX ISO 4217 list][six-current] and [historic list][six-historic]
  under [Amendment 174][six-174]: JPY, KRW and VND use zero decimals, JOD three,
  and historical HRK stays supported.
- **Checks:** [currencies] "CAL pending original-currency symbols".

## cal.installments: plans, billed lines and cancellations

- **Observed:** a plan appears as one row per billed payment, each with its own
  `debCrdDate`. Every row states the whole purchase (`amountForDisplay` equals
  `trnAmt`), and `amtBeforeConvAndIndex` is the payment. In every fully observed
  plan the payments summed exactly to the total, sometimes with a first payment
  absorbing rounding. A plan's rows share `trnIntId`, `trnIntId` plus
  `curPaymentNum` was unique, and those identities never changed across
  overlapping captures: a candidate key, not a correction guarantee.
  `numOfPayments` is the planned count and `curPaymentNum` an observed ordinal;
  other types state count and ordinal 0. Every installment row also states the
  count as `עסקה ב-‎N‏ תשלומים` in `transTypeCommentDetails[]` and
  `עסקה ב - N תשלומים` in `onGoingTransactionsComment`, equal wherever both
  appear. The recent route can leave `numOfPayments` and `curPaymentNum` null.
- **Policy:** these texts supply the planned count when `numOfPayments` is null;
  any disagreement leaves it unknown with `conflicting_installment_facts`. An
  ordinal is never derived.
- **Cancellations (type 86)** have their own `trnIntId`, share none with a plan
  and carry `refundInd: true`. Their `numOfPayments` describes the original plan,
  which is not linked, and components may have ordinal 0.
- **Not established:** foreign-currency plans, per-payment original money (`trnAmt`
  describes the whole plan) and a cancellation's plan. Early repayment and
  refunds can end a plan before its size.
- **Payment history:** in `paymentsMade[]` (`date`, `num`, `amount`,
  `currency`), `num` is a localized label with directional marks and digit
  groups, not an ordinal. In nonempty examples the parent counts are null and the
  nested amounts do not sum to the parent; the array can grow and reorder between
  captures. It stays retained evidence, never a schedule or matched by position.
- **Checks:** [extraction] "creates one purchase and one billed line per
  payment…", "preserves nested history labels…"; [source patterns] "sums explicit
  cancellation components…", "leaves a plan's original money unknown when its
  rows state different original amounts"; [billed lines].

## cal.comments: comment templates

`comments[]` entries are `{key, value}`, with an empty value when the key states
the fact. Dates are `DD/MM/YYYY`; below, `9` marks a digit whose count varies. The
parsed templates are the constants in [enrichment](enrichment.ts): contactless,
3-D Secure, an ILS conversion at the representative rate (1 to 4 rate decimals), a
USD conversion at the issuer's selling rate (a double space before "הבינלאומית", a
USD amount that can be negative, 3 to 6 rate decimals, a trailing period), the FX
fee (possibly negative, trailing zeros dropped), and the FX-fee discount marker
and amount. These templates stay text:

| `comments[].key`                                                                   | Gloss                                  | `value`  |
| ---------------------------------------------------------------------------------- | -------------------------------------- | -------- |
| `עמלת מ.מזומן חו"ל`                                                                | Foreign cash-withdrawal fee            | `99.99`  |
| `עמלת משיכת מזומן בסך 99 ₪ הומרה לאירו/דולר לפי שער יציג של יום קליטת התנועה`      | Cash fee converted at the posting rate | empty    |
| `מע"מ`                                                                             | VAT                                    | `₪-9.99` |
| `המע"מ נגבה בגין העמלה ו/או הריבית בעסקה זו`                                       | VAT notice                             | empty    |
| `החודש עמדת ביעד המחזור לפטור מלא מעמלת דמי כרטיס ולכן לא חויבת`                   | Card-fee waiver                        | empty    |
| `בפנייה לבית העסק לבירורים בנוגע לעסקה יש למסור את 9 הספרות של מזהה הכרטיס בארנק.` | Wallet-token reminder                  | empty    |
| `עסקה עם הנחה`                                                                     | Discount marker                        | empty    |
| `העברת כספים לתשלום לקבוצה`                                                        | Group transfer                         | empty    |

Other prose slots are `linkedComments[]` (such as the card-fee waiver eligibility
link), `immediateComments[]` (the immediate-charge notice), string
`transTypeCommentDetails[]` (original amount with U+200F and U+200E marks,
installment counts, cash-withdrawal amounts) and `onGoingTransactionsComment`.
They can explain transfers, waived fees or discounts, but Fonds infers no
counterparty roles or adjustments from prose and never follows their links. An
installment-count or original-amount text leaves `additionalInformation` only
when a typed field states the same fact; a contradicting one leaves the original
money unknown.

- **Checks:** [enrichment] "matches templates exactly…", "keeps unparsed
  templates and unknown text in additionalInformation…"; [source information];
  [stated text] "CAL stated text".

## cal.fx: conversion and fee

- **Observed:** an ILS-converted row reconciles when the billed amount equals the
  base amount times the representative rate, plus the fee, minus the fee
  discount. Two-step conversions (USD first, then ILS) occur, and the USD step
  `|trnAmt| × rate = USD amount` held in most rows. Some ILS-step and USD-step
  cases do not reconcile.
- **Policy:** stated rates are facts either way, but the fee is published only
  when the row reconciles; reconciliation supports the fee's role without proving
  it. Installment-derived and pending rows carry no FX facts, since plan
  conversion is unverified and the observed pending shape has no comments.
  The reconciliation tolerance of one minor unit (0.01) is a Fonds choice, not
  a source statement.
- **Checks:** [enrichment] "CAL FX", including "gives pending rows no FX
  facts…", and "CAL FX exact decimals".

## cal.mcc: merchant category and merchant

- **Observed:** `internationalBranchID` is the merchant category code, on every
  row. The billing-month route's Hebrew `branchCodeDesc` labels group it
  deterministically: every MCC mapped to exactly one label over the joined rows.
  Several MCC values were shared by many merchants, so an MCC cannot establish
  merchant identity. Merchant IDs are opaque and provider-scoped; foreign rows
  state `0`, which names no merchant and is not published. Address and phone
  are unstructured.
- **Policy:** short numeric codes are not zero-padded without evidence. A
  merchant, MCC, card-present flag or email candidate never proves business use.
- **Checks:** [extraction] merchant-category cases.

## cal.identity: keys, dates and sequences

- **Observed:** posted rows use `cardUniqueId` and `trnIntId`; pending rows use
  `cardUniqueID` and, in the later shape only, `transactionID`, which does not
  prove a link to `trnIntId`. A posted group can repeat a native ID across
  installment payments or cancellation components sharing a debit date.
  `trnNumaretor` changes within groups and across captures and is no ordinal, and `earlyPaymentInd`
  changed without monetary changes. `debCrdDate`, on every posted row, is a debit
  or billing date, not a posting date; a future value does not mean pending.
  Recent dates are timezone-free `YYYY-MM-DDTHH:mm:ss`, and midnight does not
  prove the provider knew the time.
- **Checks:** [extraction] "retains every native collision…", "does not expose
  installment component time…".

## cal.pending-posted: continuation evidence

- **Observed:** a read-only comparison of continuation pairs (a pending row
  unlisted in the run that created a posted row on the same card with equal
  money) found no shared identifier. Purchase timestamps carry a time of day but
  do not reliably match, and a posted merchant name can drop trailing whole
  words. Equal and non-null in every pair: pending `trnAmt` with posted `trnAmt`,
  `amountForDisplay` and `amtBeforeConvAndIndex`; `trnCurrencySymbol` with posted
  `trnCurrencySymbol`, `currencyForDisplay` and `debCrdCurrencySymbol`;
  `cardUniqueID`/`cardUniqueId`; `internationalBranchID`;
  `trnTypeCode`/`transactionTypeCode`; `transCardPresentInd`;
  `numberOfPayments`/`numOfPayments`; `walletTranInd`/`tokenInd`;
  `isAbroadApproval`/`isAbroadTransaction`; `firstPaymentAmount`/`cashAccountTrnAmt`.
- **Policy:** [posting evidence](posting-evidence.ts) turns some of these into
  conservative gates. Merchant IDs are optional because pending rows lack them;
  timestamps, wallet descriptions, billing dates, posted-only IDs and the
  first-payment equality are not gates. The equalities are observations, not
  issuer invariants.
- **Checks:** [posting evidence tests]; [auto posting].

[auto posting]: ../../../tests/storage/auto-posting.test.ts
[billed lines]: ../../../tests/storage/billed-lines.test.ts
[collection]: ../../../tests/providers/cal/collection.test.ts
[currencies]: ../../../tests/providers/cal/currencies.test.ts
[enrichment]: ../../../tests/providers/cal/enrichment.test.ts
[extraction]: ../../../tests/providers/cal/extraction.test.ts
[posting evidence tests]: ../../../tests/providers/cal/posting-evidence.test.ts
[source information]: ../../../tests/providers/source-information.test.ts
[source patterns]: ../../../tests/providers/cal/source-patterns.test.ts
[stated text]: ../../../tests/providers/cal/stated-text.test.ts
[six-current]: https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
[six-historic]: https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-three.xml
[six-174]: https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/amendments/dl-currency-iso-amendment-174.pdf
