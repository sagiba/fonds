import { isLosslessNumber, parse } from "lossless-json";

import {
  emptyDetails,
  type JsonValue,
  merchantCategoryCodeSchema,
  transactionDateTimeSchema,
  type TransactionInput,
} from "../../domain/model.js";
import { decimalToMinor, sumMinor } from "../../domain/money.js";
import type {
  ExtractionContext,
  ExtractionResult,
} from "../../domain/source-adapter.js";
import {
  type CalComment,
  calComments,
  calForeignExchange,
  calPaymentContext,
  calProviderTransactionCode,
  type CalStatedText,
  calStatedText,
} from "./enrichment.js";
import { calRowEvidence, retainCalEvidence } from "./evidence.js";
import { calHasUnsupportedPagination } from "./pagination.js";
import { CAL_EMPTY_SEARCH_DESCRIPTION } from "./search.js";
import { CAL_ENDPOINTS } from "./transport.js";

export type { ExtractionResult } from "../../domain/source-adapter.js";

type SourceRow = Record<string, unknown>;

type Observation = { row: SourceRow; path: string };

type Status = "posted" | "pending";

const billingCurrencies: Record<string, string> = {
  "1": "USD",
  "3": "ILS",
  "7": "EUR",
};
const originalCurrencies: Record<string, string> = {
  "376": "ILS",
  "840": "USD",
  "978": "EUR",
  "191": "HRK",
  "949": "TRY",
  "977": "BAM",
  "826": "GBP",
  "348": "HUF",
  "203": "CZK",
  "704": "VND",
  "344": "HKD",
  "484": "MXN",
  "764": "THB",
  "392": "JPY",
  "410": "KRW",
  "756": "CHF",
  "980": "UAH",
  "400": "JOD",
  "124": "CAD",
};
// CAL provider codes observed in original-money roles, not additional billing codes.
const providerOriginalCurrencies: Record<string, string> = {
  ...billingCurrencies,
  "66": "HRK",
  "134": "TRY",
  "119": "BAM",
  "2": "GBP",
  "97": "HUF",
  "69": "CZK",
  "118": "VND",
  "96": "HKD",
  "33": "MXN",
  "81": "THB",
  "40": "JPY",
  "58": "KRW",
  "5": "CHF",
  "71": "UAH",
  "46": "JOD",
  "57": "CAD",
};
const displaySymbols: Record<string, string> = {
  "₪": "ILS",
  "€": "EUR",
  $: "USD",
};
const originalSymbols: Record<string, string> = {
  ...displaySymbols,
  "£": "GBP",
};
const kinds: Record<string, TransactionInput["kind"]> = {
  "5": "purchase",
  "8": "purchase",
  "9": "purchase",
  "6": "refund",
  "86": "refund",
  "25": "refund",
  "67": "fee",
  "7": "cash_withdrawal",
};

function lookup<T>(
  mapping: Readonly<Record<string, T>>,
  key: string | null,
): T | null {
  return key !== null && Object.hasOwn(mapping, key)
    ? (mapping[key] ?? null)
    : null;
}

function object(value: unknown): value is SourceRow {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isLosslessNumber(value)
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function token(value: unknown): string | null {
  return isLosslessNumber(value)
    ? value.value
    : typeof value === "string"
      ? value
      : null;
}

function identifier(value: unknown): string | null {
  return isLosslessNumber(value) ? value.value : text(value);
}

/** Foreign rows state merchant number `0`, which names no merchant. */
function merchantNumber(value: unknown): string | null {
  const number = identifier(value);
  return number !== null && /^0+$/.test(number) ? null : number;
}

/** Reviewed CAL classification mapping; shape alone does not verify an ISO registry entry. */
function merchantCategoryCode(value: unknown, issues: string[]): string | null {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return null;
  }
  const code = token(value);
  if (code !== null && merchantCategoryCodeSchema.safeParse(code).success) {
    return code;
  }
  issues.push("invalid_merchant_category_code");
  return null;
}

function integerToken(value: unknown): string | null {
  const lexical = token(value);
  if (lexical === null) {
    return null;
  }
  try {
    return String(decimalToMinor(lexical, "JPY"));
  } catch {
    return null;
  }
}

/** Keep source numeric lexemes exact when building retained JSON evidence. */
function json(value: unknown): JsonValue {
  if (isLosslessNumber(value)) {
    return value.value;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(json);
  }
  if (object(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, json(item)]),
    );
  }
  return null;
}

function ordinal(value: unknown, allowZero = false): number | null {
  const lexical = token(value);
  if (lexical === null) {
    return null;
  }
  try {
    const number = decimalToMinor(lexical, "JPY");
    return number > 0 || (allowZero && number === 0) ? number : null;
  } catch {
    return null;
  }
}

function date(value: unknown, issues: string[]): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = transactionDateTimeSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data.slice(0, 10);
  }
  issues.push("invalid_source_date");
  return null;
}

function money(
  value: unknown,
  currency: string | null,
  issues: string[],
  issue = "unresolved_amount",
): number | null {
  const lexical = token(value);
  if (!currency || lexical === null) {
    issues.push(issue);
    return null;
  }
  try {
    return decimalToMinor(lexical, currency);
  } catch {
    issues.push(issue);
    return null;
  }
}

/**
 * Known source prose slots, after payment context and FX have published what
 * they state. Exact text, markup included; a label stays joined to its value.
 * Transfer-purpose and discount prose are not interpreted as typed facts.
 */
function additionalInformation(
  rows: SourceRow[],
  comments: CalComment[][],
  typed: Pick<
    TransactionInput,
    "installmentCount" | "originalAmountMinor" | "originalCurrency"
  >,
): string[] {
  const restated = new Set(
    stated(rows).flatMap(({ text, parsed }) =>
      restatesTyped(parsed, typed) ? [text] : [],
    ),
  );
  const prose = (value: unknown): string[] =>
    typeof value === "string" && value.trim().length > 0 ? [value] : [];
  const slot = (items: unknown, field?: string): string[] =>
    Array.isArray(items)
      ? items.flatMap((item) =>
          prose(field === undefined ? item : object(item) ? item[field] : null),
        )
      : [];
  return unique(
    rows.flatMap((row, index) => [
      ...comments[index]!.flatMap((comment) =>
        comment.published ? [] : prose(comment.text),
      ),
      ...slot(row.linkedComments, "text"),
      ...slot(row.immediateComments, "comment"),
      ...slot(row.transTypeCommentDetails),
      ...prose(row.onGoingTransactionsComment),
    ]),
  ).filter((text) => !restated.has(text));
}

/** The string-slot texts of the rows, each parsed by exact template. */
function stated(rows: SourceRow[]) {
  return rows
    .flatMap((row) => [
      ...(Array.isArray(row.transTypeCommentDetails)
        ? row.transTypeCommentDetails
        : []),
      row.onGoingTransactionsComment,
    ])
    .flatMap((value) =>
      typeof value === "string"
        ? [{ text: value, parsed: calStatedText(value) }]
        : [],
    );
}

/** The unsigned original money an original-amount text states, when its marker resolves. */
function statedOriginal(
  parsed: CalStatedText | null,
): { currency: string; amountMinor: number | null } | null {
  const currency =
    parsed?.template === "original_amount"
      ? resolveOriginalSymbol(parsed.marker)
      : null;
  if (parsed?.template !== "original_amount" || currency === null) {
    return null;
  }
  try {
    return { currency, amountMinor: decimalToMinor(parsed.amount, currency) };
  } catch {
    return { currency, amountMinor: null };
  }
}

/** Whether a parsed text states exactly what a typed field already does. */
function restatesTyped(
  parsed: CalStatedText | null,
  typed: Pick<
    TransactionInput,
    "installmentCount" | "originalAmountMinor" | "originalCurrency"
  >,
): boolean {
  if (parsed?.template === "installment_count") {
    return parsed.count === typed.installmentCount;
  }
  const text = statedOriginal(parsed);
  return (
    text !== null &&
    typed.originalAmountMinor !== null &&
    text.currency === typed.originalCurrency &&
    text.amountMinor === Math.abs(typed.originalAmountMinor)
  );
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** Whether the rows state different values for any of the keys. */
function disagreeOn(rows: SourceRow[], keys: readonly string[]): boolean {
  return keys.some(
    (key) =>
      unique(rows.map((row) => JSON.stringify(json(row[key])))).length !== 1,
  );
}

function cancellation(row: SourceRow): boolean {
  return row.trnType === "ביטול תשלומים" && row.refundInd === true;
}

/** One billed payment of an installment plan (type 8, two or more payments). */
function installmentPayment(row: SourceRow): boolean {
  // Any stated multi-payment plan makes the row a payment; the group then
  // resolves conflicting counts.
  const counts = [
    ordinal(row.numOfPayments),
    ...stated([row]).flatMap((item) =>
      item.parsed?.template === "installment_count" ? [item.parsed.count] : [],
    ),
  ];
  return (
    token(row.transactionTypeCode) === "8" &&
    row.refundInd === false &&
    counts.some((count) => count !== null && count >= 2) &&
    ordinal(row.curPaymentNum) !== null
  );
}

/**
 * Plan facts every payment row restates. A difference within one capture
 * leaves the purchase in review; it never splits the plan. The planned count
 * is reconciled with the installment texts, where a null states nothing.
 */
const planInvariants = [
  "trnPurchaseDate",
  "merchantName",
  "merchantId",
  "internationalBranchID",
  "trnCurrencyIsoCode",
  "transOriginalCurrencyCode",
  "trnCurrencySymbol",
  "trnAmt",
] as const;

/**
 * The extracted role of a group: an installment plan's purchase (from any of
 * its payment rows), one billed line, or a single row or cancellation.
 */
type GroupRole =
  { kind: "single" } | { kind: "plan" } | { kind: "line"; purchaseKey: string };

/** Original-purchase currency markers, mapped to ISO codes. */
function resolveOriginalSymbol(value: unknown): string | null {
  const symbol = text(value);
  const currency = lookup(originalSymbols, symbol);
  if (currency) {
    return currency;
  }
  if (symbol !== null && /^[A-Z]{3}$/.test(symbol)) {
    try {
      decimalToMinor("0", symbol);
      return symbol;
    } catch {
      // Unknown ISO precision stays unresolved, as it does for posted money.
    }
  }
  return null;
}

function resolveOriginalCurrency(
  row: SourceRow,
  issues: string[],
): string | null {
  const iso = lookup(originalCurrencies, token(row.trnCurrencyIsoCode));
  const provider = lookup(
    providerOriginalCurrencies,
    token(row.transOriginalCurrencyCode),
  );
  if (
    (row.trnCurrencyIsoCode != null && !iso) ||
    (row.transOriginalCurrencyCode != null && !provider)
  ) {
    issues.push("unsupported_original_currency");
    return null;
  }
  const currency = iso ?? provider;
  // `srcCurrencyCode` restates the ISO numeric code, empty exactly when it is null.
  const source = identifier(row.srcCurrencyCode);
  const stated = identifier(row.trnCurrencyIsoCode);
  if (
    (source !== null &&
      (stated === null || Number(source) !== Number(stated))) ||
    (iso && provider && iso !== provider) ||
    (currency &&
      row.trnCurrencySymbol != null &&
      resolveOriginalSymbol(row.trnCurrencySymbol) !== currency)
  ) {
    issues.push("conflicting_original_currency");
    return null;
  }
  return currency;
}

/** Facts every row of one groupable posted purchase must state identically. */
const groupInvariants = [
  "trnPurchaseDate",
  "merchantName",
  "merchantId",
  "internationalBranchID",
  "transactionTypeCode",
  "debCrdCurrencyCode",
  "currencyForDisplay",
  "debCrdCurrencySymbol",
  "trnCurrencyIsoCode",
  "transOriginalCurrencyCode",
  "trnCurrencySymbol",
  "numOfPayments",
];

/** A plain non-negative decimal token, optionally in exponent notation. */
function isNonNegativeDecimalToken(value: string | null): boolean {
  return (
    value !== null &&
    /^(?:-?\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?$/.test(value) &&
    (!value.startsWith("-") || !/[1-9]/.test(value.split(/[eE]/)[0]!))
  );
}

function groupable(observations: Observation[]): boolean {
  const rows = observations.map(({ row }) => row);
  const first = rows[0]!;
  const cancel = rows.every(cancellation);
  const ordinary = rows.every(
    (row) =>
      token(row.transactionTypeCode) === "8" &&
      row.trnType === "תשלומים" &&
      row.refundInd === false,
  );
  if (!cancel && !ordinary) {
    return false;
  }
  const ordinals = rows.map((row) => ordinal(row.curPaymentNum, cancel));
  if (
    ordinals.some((number) => number === null) ||
    unique(ordinals).length !== rows.length
  ) {
    return false;
  }
  if (disagreeOn(rows, groupInvariants)) {
    return false;
  }
  if (ordinary && ordinal(first.numOfPayments) === null) {
    return false;
  }
  const currency = lookup(billingCurrencies, token(first.debCrdCurrencyCode));
  if (!currency) {
    return false;
  }
  const amounts = rows.map((row) => money(row.amountForDisplay, currency, []));
  if (amounts.some((amount) => amount === null)) {
    return false;
  }
  if (cancel && !amounts.every((amount) => amount! < 0)) {
    return false;
  }
  if (ordinary && (unique(amounts).length !== 1 || amounts[0]! < 0)) {
    return false;
  }
  const originalCurrency = resolveOriginalCurrency(first, []);
  if (
    rows.every(
      (row) =>
        row.trnCurrencyIsoCode == null && row.transOriginalCurrencyCode == null,
    )
  ) {
    // Consistent original tokens constrain identity even when their currency is absent.
    // No precision/currency is inferred from a display symbol or billing currency.
    const originals = rows.map((row) => token(row.trnAmt));
    return (
      originals.every(isNonNegativeDecimalToken) &&
      unique(originals).length === 1
    );
  }
  if (
    !originalCurrency ||
    rows.some((row) => resolveOriginalCurrency(row, []) !== originalCurrency)
  ) {
    return false;
  }
  const original = rows.map((row) => money(row.trnAmt, originalCurrency, []));
  return (
    original.every((amount) => amount !== null && amount >= 0) &&
    unique(original).length === 1
  );
}

/** Rows that disagree on the billing code, or a display marker naming another currency. */
function conflictingBillingCurrency(
  rows: SourceRow[],
  currency: string | null,
): boolean {
  return (
    unique(rows.map((row) => token(row.debCrdCurrencyCode))).length !== 1 ||
    rows.some(
      (row) =>
        [row.currencyForDisplay, row.debCrdCurrencySymbol].some(
          (marker) =>
            marker !== undefined &&
            marker !== null &&
            lookup(displaySymbols, text(marker)) !== currency,
        ) ||
        // The billing currency's ISO alphabetic code, when stated as one.
        (/^[A-Z]{3}$/.test(text(row.crmIccCurrencyDesc) ?? "") &&
          text(row.crmIccCurrencyDesc) !== currency),
    )
  );
}

function weakKey(
  row: SourceRow,
  status: Status,
  cardKey: string | null,
): string {
  return (
    `cal:${status}:weak:` +
    JSON.stringify([
      cardKey,
      text(row.trnPurchaseDate),
      text(row.merchantName),
      token(status === "posted" ? row.amountForDisplay : row.trnAmt),
      text(
        status === "posted" ? row.currencyForDisplay : row.trnCurrencySymbol,
      ),
      ...(status === "posted" ? [token(row.debCrdCurrencyCode)] : []),
    ])
  );
}

function extractGroup(
  observations: Observation[],
  status: Status,
  sourceKey: string,
  identityStrength: TransactionInput["identityStrength"],
  context: ExtractionContext,
  role: GroupRole = { kind: "single" },
): TransactionInput {
  const rows = observations.map(({ row }) => row);
  const line = role.kind === "line";
  const row = rows[0]!;
  const details = emptyDetails();
  const issues = details.issues;
  if (identityStrength === "ambiguous") {
    issues.push("ambiguous_source_identity");
  }
  if (identityStrength === "weak") {
    issues.push("weak_source_identity");
  }
  details.sourceRefs = observations.map(({ path }) => ({
    runId: context.runId,
    path,
  }));
  details.provider.cal = { rows: rows.map(calRowEvidence) };
  details.merchant = {
    address: text(row.merchantAddress),
    phone: text(row.merchantPhoneNo),
  };
  const comments = rows.map(calComments);
  const payment = calPaymentContext(rows, comments, status, issues);
  // Untyped comment and payment-history evidence, retained across observations.
  const retainedComments: JsonValue[] = [];
  const paymentHistory: JsonValue[] = [];
  for (const item of rows) {
    for (const key of [
      "comments",
      "linkedComments",
      "immediateComments",
      "transTypeCommentDetails",
    ]) {
      if (Array.isArray(item[key])) {
        retainedComments.push(...item[key].map(json));
      }
    }
    if (Array.isArray(item.paymentsMade)) {
      for (const history of item.paymentsMade) {
        if (object(history)) {
          paymentHistory.push(json(history));
        } else {
          issues.push("invalid_payment_history");
        }
      }
    } else if (item.paymentsMade !== undefined && item.paymentsMade !== null) {
      issues.push("invalid_payment_history");
    }
  }
  if (retainedComments.length > 0 || paymentHistory.length > 0) {
    details.provider.cal.retained = {
      comments: retainedComments,
      paymentHistory,
    };
  }
  details.provider.cal = retainCalEvidence(details.provider.cal);
  const code = token(
    status === "posted" ? row.transactionTypeCode : row.trnTypeCode,
  );
  let kind = lookup(kinds, code) ?? "unknown";
  // A service refund (71) is a refund only when the source flags it as one.
  if (
    status === "posted" &&
    code === "71" &&
    rows.every((item) => item.refundInd === true)
  ) {
    kind = "refund";
  }
  if (kind === "unknown") {
    issues.push("unsupported_transaction_type");
  }
  let currency =
    status === "posted"
      ? lookup(billingCurrencies, token(row.debCrdCurrencyCode))
      : resolveOriginalSymbol(row.trnCurrencySymbol);
  if (status === "pending") {
    details.provider.cal.currencyMapping =
      "CAL symbol mapping v2: ₪=ILS, €=EUR, $=USD, £=GBP; known ISO alpha codes";
  }
  if (status === "posted" && conflictingBillingCurrency(rows, currency)) {
    issues.push("conflicting_billing_currency");
    currency = null;
  }
  const cancel = status === "posted" && rows.every(cancellation);
  // A billed line's money is its own payment; a plan states its whole purchase.
  const sourceAmounts = rows.map((item) =>
    line
      ? money(
          item.amtBeforeConvAndIndex,
          currency,
          issues,
          "unresolved_installment_component",
        )
      : money(
          status === "posted" ? item.amountForDisplay : item.trnAmt,
          currency,
          issues,
        ),
  );
  // Reviewed regular/recurring reversals keep the same code as their original charge.
  if (
    status === "posted" &&
    (code === "5" || code === "9") &&
    rows.every((item) => item.refundInd === true) &&
    sourceAmounts.every((amount) => amount !== null && amount < 0)
  ) {
    kind = "refund";
  }
  let amountMinor: number | null = null;
  if (sourceAmounts.every((amount) => amount !== null) && kind !== "unknown") {
    let sourceAmount: number | null = sourceAmounts[0]!;
    if (role.kind === "plan" && unique(sourceAmounts).length !== 1) {
      // Conflicting stated totals in one capture: the total is unknown.
      sourceAmount = null;
      issues.push("conflicting_installment_total");
    }
    if (cancel) {
      try {
        sourceAmount = sumMinor(sourceAmounts as number[]);
      } catch {
        sourceAmount = null;
        issues.push("amount_out_of_range");
      }
    }
    if (sourceAmount !== null) {
      const signValid =
        kind === "refund"
          ? sourceAmount < 0 && (status === "pending" || row.refundInd === true)
          : sourceAmount >= 0 &&
            (status === "pending" || row.refundInd === false);
      // Pending refunds are unobserved; accept only explicit refund codes with
      // the same negative-source / positive-canonical convention as posted refunds.
      if (
        !signValid ||
        (status === "pending" && kind !== "purchase" && kind !== "refund")
      ) {
        issues.push("unsupported_amount_direction");
      } else if (!Number.isSafeInteger(sourceAmount)) {
        issues.push("amount_out_of_range");
      } else {
        amountMinor = sourceAmount === 0 ? 0 : -sourceAmount;
      }
    }
  }
  if (amountMinor === null) {
    currency = null;
  }
  let originalCurrency = resolveOriginalCurrency(row, issues);
  // Every contributing row restates the currency, not only the first.
  if (
    originalCurrency !== null &&
    rows.some((item) => resolveOriginalCurrency(item, []) !== originalCurrency)
  ) {
    issues.push("conflicting_original_currency");
    originalCurrency = null;
  }
  // The original-amount texts restate the structured original money, whether
  // or not it is published; a text naming another currency or amount leaves
  // it, and any conversion from it, unknown.
  let originalConflict = false;
  if (originalCurrency !== null) {
    const structured = rows.map((item) =>
      money(item.trnAmt, originalCurrency!, []),
    );
    const texts = stated(rows).flatMap(({ parsed }) => {
      const text = statedOriginal(parsed);
      return text === null ? [] : [text];
    });
    if (texts.some((text) => text.currency !== originalCurrency)) {
      issues.push("conflicting_original_currency");
      originalConflict = true;
    } else if (
      texts.some((text) =>
        structured.some(
          (amount) => amount !== null && Math.abs(amount) !== text.amountMinor,
        ),
      )
    ) {
      issues.push("conflicting_original_amount");
      originalConflict = true;
    }
    if (originalConflict) {
      originalCurrency = null;
    }
  }
  if (
    role.kind !== "single" &&
    originalCurrency !== null &&
    currency !== null &&
    originalCurrency !== currency
  ) {
    // Converted installment payments are not verified against their plan.
    issues.push("unverified_converted_installments");
  }
  let originalAmountMinor: number | null = null;
  if (
    status === "posted" &&
    amountMinor !== null &&
    amountMinor !== 0 &&
    !cancel &&
    !line &&
    originalCurrency
  ) {
    const originals = rows.map((item) =>
      money(
        item.trnAmt,
        originalCurrency,
        issues,
        "unresolved_original_amount",
      ),
    );
    if (
      originals.every((amount) => amount !== null && amount >= 0) &&
      unique(originals).length === 1
    ) {
      originalAmountMinor =
        originals[0] === 0
          ? 0
          : amountMinor < 0
            ? -originals[0]!
            : originals[0]!;
    } else {
      issues.push("conflicting_original_amount");
    }
  }
  if (originalAmountMinor === null) {
    originalCurrency = null;
  }
  const transactionDate = date(row.trnPurchaseDate, issues);
  const billingDates = rows
    .map((item) => date(item.debCrdDate, issues))
    .filter((item): item is string => item !== null)
    .sort();
  const installments = rows
    .map((item) => ordinal(item.curPaymentNum, cancel))
    .filter((item): item is number => item !== null);
  // Every row states the planned count, structurally or in its installment
  // texts; the recent endpoint can leave the structured count null.
  const statedCounts = unique([
    ...rows.flatMap((item) => {
      const count = ordinal(
        status === "posted" ? item.numOfPayments : item.numberOfPayments,
      );
      return count === null ? [] : [count];
    }),
    ...stated(rows).flatMap((item) =>
      item.parsed?.template === "installment_count" && item.parsed.count > 0
        ? [item.parsed.count]
        : [],
    ),
  ]);
  if (statedCounts.length > 1) {
    issues.push("conflicting_installment_facts");
  }
  const sourceCount = statedCounts.length === 1 ? statedCounts[0]! : null;
  if (
    sourceCount !== null &&
    installments.some((number) => number > sourceCount)
  ) {
    issues.push("invalid_installment_ordinal");
  }
  if (installments.length > 0 && sourceCount === null) {
    issues.push("unknown_installment_count");
  }
  // A cancellation's count describes the original plan, which is not linked.
  const installmentCount = cancel ? null : sourceCount;
  if (role.kind === "plan" && disagreeOn(rows, planInvariants)) {
    issues.push("conflicting_installment_facts");
  }
  // Component dates and ordinals belong to billed lines, not the purchase. An
  // installment row of unknown plan size keeps its payment date off it too.
  const hasInstallmentComponents =
    status === "posted" &&
    (cancel ||
      role.kind !== "single" ||
      (rows.every((item) => token(item.transactionTypeCode) === "8") &&
        installmentCount !== 1));
  const purchaseTimes = unique(rows.map((item) => text(item.trnPurchaseDate)));
  details.transactionDateTime =
    !hasInstallmentComponents &&
    transactionDate !== null &&
    purchaseTimes.length === 1 &&
    transactionDateTimeSchema.safeParse(purchaseTimes[0]).success
      ? purchaseTimes[0]!
      : null;
  // FX facts are extracted only for one ordinary posted row. Installment-derived
  // rows (purchases, billed lines, cancellations) carry no FX facts.
  const fx =
    status === "posted" &&
    role.kind === "single" &&
    rows.length === 1 &&
    !hasInstallmentComponents &&
    code !== "8" &&
    (ordinal(row.numOfPayments) ?? 0) <= 1 &&
    !originalConflict
      ? calForeignExchange(row, comments[0]!, {
          originalCurrency: resolveOriginalCurrency(row, []),
          billingCurrency: currency,
          billedAmount: row.amountForDisplay,
          amountMinor,
        })
      : null;
  if (fx) {
    issues.push(...fx.issues);
    if (fx.currencyExchange) {
      details.currencyExchange = fx.currencyExchange;
    }
  }
  details.additionalInformation = additionalInformation(rows, comments, {
    installmentCount,
    originalAmountMinor,
    originalCurrency,
  });
  const categoryCode = merchantCategoryCode(row.internationalBranchID, issues);
  details.issues = unique(issues);
  return {
    sourceScope: context.accountKey,
    cardKey: identifier(
      status === "posted" ? row.cardUniqueId : row.cardUniqueID,
    ),
    sourceKey,
    sourceAliases: [],
    identityStrength,
    status,
    description: text(row.trnType),
    counterpartyName: null,
    kind,
    merchantName: text(row.merchantName),
    merchantProviderId: merchantNumber(row.merchantId),
    merchantCategoryCode: categoryCode,
    transactionDate,
    bookingDate: null,
    // A purchase keeps no component date, so its projection stays stable as
    // overlapping windows change the captured subset; a line has its own.
    billingDate:
      (line || !hasInstallmentComponents) && unique(billingDates).length === 1
        ? billingDates[0]!
        : null,
    amountMinor,
    currency,
    amountBasis: line
      ? "booked_entry"
      : status === "posted"
        ? "purchase_commitment"
        : "authorization",
    originalAmountMinor,
    originalCurrency,
    installmentCount,
    ...(line && {
      purchaseKey: role.purchaseKey,
      installmentNumber: ordinal(row.curPaymentNum),
    }),
    ...payment,
    providerTransactionCode: calProviderTransactionCode(row, status),
    fxFeeMinor: fx?.fxFeeMinor ?? null,
    fxFeeCurrency: fx?.fxFeeCurrency ?? null,
    details,
  };
}

/**
 * An installment plan's rows in one capture: one purchase from any of them,
 * then one billed line per payment, keyed by plan and ordinal. Duplicate
 * ordinals stay separate ambiguous occurrences.
 */
function extractPlan(
  purchaseKey: string,
  observations: Observation[],
  context: ExtractionContext,
): TransactionInput[] {
  const payment = ({ row }: Observation) => ordinal(row.curPaymentNum)!;
  const ordered = observations
    .map((observation, index) => ({ observation, index }))
    .sort(
      (left, right) =>
        payment(left.observation) - payment(right.observation) ||
        left.index - right.index,
    )
    .map(({ observation }) => observation);
  const purchase = extractGroup(
    ordered,
    "posted",
    purchaseKey,
    "native",
    context,
    { kind: "plan" },
  );
  const lineBase = ({ row }: Observation) =>
    "cal:posted:line:" +
    JSON.stringify([
      identifier(row.cardUniqueId),
      identifier(row.trnIntId),
      ordinal(row.curPaymentNum),
    ]);
  const lines = [...Map.groupBy(ordered, lineBase)].flatMap(
    ([lineKey, payments]) =>
      payments.map((observation, index) => {
        const ambiguous = payments.length > 1;
        const transaction = extractGroup(
          [observation],
          "posted",
          ambiguous ? `${lineKey}:occurrence:${index + 1}` : lineKey,
          ambiguous ? "ambiguous" : "native",
          context,
          { kind: "line", purchaseKey },
        );
        if (ambiguous) {
          transaction.details.provider.cal!.identity = {
            baseKey: lineKey,
            occurrenceCount: payments.length,
          };
        }
        return transaction;
      }),
  );
  return [purchase, ...lines];
}

function isEmptySearchEnvelope(
  envelope: unknown,
  endpoint: string | undefined,
): boolean {
  return (
    object(envelope) &&
    isLosslessNumber(envelope.statusCode) &&
    integerToken(envelope.statusCode) === "93" &&
    envelope.result === null &&
    envelope.statusDescription === CAL_EMPTY_SEARCH_DESCRIPTION &&
    endpoint === CAL_ENDPOINTS.search
  );
}

/** The `result` object of a status-1 envelope, or null for any other envelope. */
function successfulResult(envelope: unknown): SourceRow | null {
  if (
    !object(envelope) ||
    !isLosslessNumber(envelope.statusCode) ||
    integerToken(envelope.statusCode) !== "1" ||
    !object(envelope.result)
  ) {
    return null;
  }
  return envelope.result;
}

function countMonthlyRows(bankAccounts: unknown): number {
  if (!Array.isArray(bankAccounts)) {
    return 0;
  }
  let rawRows = 0;
  for (const account of bankAccounts) {
    if (!object(account)) {
      continue;
    }
    const debitDates = Array.isArray(account.debitDates)
      ? account.debitDates
      : [];
    const immediate =
      object(account.immidiateDebits) &&
      Array.isArray(account.immidiateDebits.debitDays)
        ? account.immidiateDebits.debitDays
        : [];
    for (const day of [...debitDates, ...immediate]) {
      if (object(day) && Array.isArray(day.transactions)) {
        rawRows += day.transactions.length;
      }
    }
  }
  return rawRows;
}

/** Pure extraction: raw archival, reconciliation and pending/posting linking belong to the application. */
export function extractCal(
  responseText: string,
  context: ExtractionContext,
): ExtractionResult {
  const result: ExtractionResult = {
    transactions: [],
    partitions: [],
    warnings: [],
    historical: context.scope?.kind === "history",
  };
  let unsupportedPagination = false;

  function partition(status: Status, success: boolean): void {
    result.partitions.push({
      accountKey: context.accountKey,
      status,
      success: success && !unsupportedPagination,
      comparable: success && !result.historical && !unsupportedPagination,
    });
  }

  let envelope: unknown;
  try {
    envelope = parse(responseText);
  } catch {
    result.warnings.push("invalid_json");
  }
  unsupportedPagination = calHasUnsupportedPagination(envelope);
  if (unsupportedPagination) {
    result.warnings.push("unsupported_pagination");
  }
  if (isEmptySearchEnvelope(envelope, context.endpoint)) {
    // This is the endpoint's observed no-data response shape; it is not archive completeness.
    result.historical = true;
    result.warnings.push("empty_search_result");
    partition("posted", true);
    return result;
  }
  const payload = successfulResult(envelope);
  if (payload === null) {
    result.warnings.push("unsuccessful_or_invalid_envelope");
    partition("posted", false);
    if (!result.historical) {
      partition("pending", false);
    }
    return result;
  }
  if (payload.bankAccounts !== undefined) {
    // The monthly endpoint's nested layout is known only from a public reference.
    // Its amount fields differ from reviewed purchase-commitment exports.
    // Count known raw transaction containers for audit without inventing a mapping.
    result.historical = true;
    result.warnings.push(
      "unsupported_monthly_projection",
      `unsupported_monthly_rows:${countMonthlyRows(payload.bankAccounts)}`,
    );
    partition("posted", false);
    return result;
  }
  const legacy =
    payload.transactions === undefined && payload.transArr !== undefined;
  result.historical ||= legacy;
  for (const status of ["posted", "pending"] as const) {
    const field =
      status === "posted"
        ? legacy
          ? "transArr"
          : "transactions"
        : "clearanceRequests";
    const source = payload[field];
    if (status === "pending" && result.historical && source === undefined) {
      continue;
    }
    if (!Array.isArray(source)) {
      result.warnings.push(`invalid_${status}_partition`);
      partition(status, false);
      continue;
    }
    let success = true;
    const groups = new Map<string, Observation[]>();
    for (const [index, row] of source.entries()) {
      const path = `/result/${field}/${index}`;
      const card = object(row)
        ? identifier(status === "posted" ? row.cardUniqueId : row.cardUniqueID)
        : null;
      if (
        !object(row) ||
        card === null ||
        !isLosslessNumber(
          status === "posted" ? row.amountForDisplay : row.trnAmt,
        ) ||
        typeof row.trnPurchaseDate !== "string" ||
        typeof row.merchantName !== "string"
      ) {
        success = false;
        result.warnings.push(`invalid_${status}_row:${path}`);
        continue;
      }
      if (
        (context.scope?.cardKey && card !== context.scope.cardKey) ||
        (context.scope?.cardKeys && !context.scope.cardKeys.includes(card))
      ) {
        success = false;
        if (!result.warnings.includes("out_of_scope_card")) {
          result.warnings.push("out_of_scope_card");
        }
        continue;
      }
      const native = identifier(
        status === "posted" ? row.trnIntId : row.transactionID,
      );
      // Posted identities are namespaced by role; pending keys are unchanged.
      const key = native
        ? `cal:${status}:${status === "posted" ? "purchase:" : ""}` +
          JSON.stringify([card, native])
        : weakKey(row, status, card);
      const observations = groups.get(key) ?? [];
      observations.push({ row, path });
      groups.set(key, observations);
    }
    for (const [key, observations] of groups) {
      const native = !key.startsWith(`cal:${status}:weak:`);
      if (
        status === "posted" &&
        native &&
        observations.every(({ row }) => installmentPayment(row))
      ) {
        result.transactions.push(...extractPlan(key, observations, context));
        if (
          unique(observations.map(({ row }) => ordinal(row.curPaymentNum)))
            .length !== observations.length
        ) {
          result.warnings.push("ambiguous_posted_identity");
        }
        continue;
      }
      if (
        observations.length === 1 ||
        (status === "posted" && native && groupable(observations))
      ) {
        const transaction = extractGroup(
          observations,
          status,
          key,
          native ? "native" : status === "posted" ? "ambiguous" : "weak",
          context,
        );
        if (!native) {
          transaction.details.provider.cal!.identity = {
            baseKey: key,
            occurrenceCount: 1,
          };
        }
        result.transactions.push(transaction);
      } else {
        observations.forEach((observation, index) => {
          const transaction = extractGroup(
            [observation],
            status,
            `${key}:occurrence:${index + 1}`,
            "ambiguous",
            context,
          );
          transaction.details.provider.cal!.identity = {
            baseKey: key,
            occurrenceCount: observations.length,
          };
          result.transactions.push(transaction);
        });
        result.warnings.push(`ambiguous_${status}_identity`);
      }
    }
    partition(status, success);
  }
  return result;
}
