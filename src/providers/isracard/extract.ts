import { isLosslessNumber, parse } from "lossless-json";

import { isCountryCode } from "../../domain/countries.js";
import {
  emptyDetails,
  type JsonValue,
  transactionDateTimeSchema,
  type TransactionInput,
} from "../../domain/model.js";
import { decimalToMinor, sumMinor } from "../../domain/money.js";
import type {
  ExtractionContext,
  ExtractionResult,
} from "../../domain/source-adapter.js";
import {
  hasLegacyStatement,
  type IsracardCapture,
  isracardCaptureSchema,
  isracardCardKey,
} from "./capture.js";
import { isIsracardDigitalSuccess } from "./transport.js";

type SourceRow = Record<string, unknown>;

/** Legacy abroad zero-voucher label of a withdrawal's fee line. */
const CASH_ADVANCE_FEE_LABEL = "CASH ADVANCE FEE";

/** Legacy abroad zero-voucher label of a billing date's total line. */
const TOTAL_FOR_DATE_LABEL = "TOTAL FOR DATE";

const CURRENCY_CODE = /^[A-Z]{3}$/;

type Observation = {
  row: SourceRow;
  path: string;
  generation: "digital" | "legacy";
  voucher: string | null;
  purchaseDate: string | null;
  billingDate: string | null;
  informational: boolean;
  foreign: boolean;
};

function object(value: unknown): value is SourceRow {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isLosslessNumber(value)
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\u0000")
    ? value
    : null;
}

function token(value: unknown): string | null {
  return isLosslessNumber(value) ? value.value : text(value);
}

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

function sourceDate(value: unknown): string | null {
  const match = text(value)?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match || match[3] === "0000") {
    return null;
  }
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  return Number.isFinite(Date.parse(`${iso}T00:00:00Z`)) &&
    new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso
    ? iso
    : null;
}

function integer(value: unknown): number | null {
  const lexical = token(value);
  if (lexical === null || !/^\d+$/.test(lexical)) {
    return null;
  }
  const result = Number(lexical);
  return Number.isSafeInteger(result) ? result : null;
}

function voucher(value: unknown): string | null {
  const candidate = token(value);
  return candidate && !/^0+$/.test(candidate) ? candidate : null;
}

function minor(value: unknown, currency: string | null): number | null {
  const lexical = token(value);
  if (!lexical || !currency) {
    return null;
  }
  try {
    return decimalToMinor(lexical, currency);
  } catch {
    return null;
  }
}

/** Only an explicit wallet name establishes a wallet. */
function walletFromName(value: unknown): TransactionInput["wallet"] {
  const name = text(value)?.trim().replace(/\s+/g, " ").toLowerCase();
  return name === "apple pay"
    ? "apple_pay"
    : name === "google pay"
      ? "google_pay"
      : name === "samsung pay"
        ? "samsung_pay"
        : null;
}

/** The sign of a decimal source amount, number or numeric string; null otherwise. */
function sourceSign(value: unknown): -1 | 0 | 1 | null {
  const lexical = token(value);
  if (!lexical || !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(lexical)) {
    return null;
  }
  if (/^-?0+(?:\.0+)?(?:[eE][+-]?\d+)?$/.test(lexical)) {
    return 0;
  }
  return lexical.startsWith("-") ? -1 : 1;
}

/** DigitalV3 `businessName` labels of a Bit money transfer ("transfer by BIT"). */
const BIT_TRANSFER_LABELS = new Set(["העברה בBIT", 'העברה ב BIT בנה"פ']);

/**
 * Kind from a DigitalV3 `transactionCode`, whose row labels it in
 * `transactionDescription` (see the source notes). Card fees (10, 12) map at
 * any sign. Purchases (1, 3, 7), ATM cash withdrawal (8) and person-to-person
 * transfers (20, 23, and code 1 Bit transfers) map only for a positive source
 * `billingAmount`, an outflow before the canonical negation: a negative row has
 * no source refund marker.
 */
function digitalKind(row: SourceRow): TransactionInput["kind"] {
  const code = token(row.transactionCode);
  if (code === "10" || code === "12") {
    return "fee";
  }
  if (sourceSign(row.billingAmount) !== 1) {
    return "unknown";
  }
  // Code 1 also carries Bit transfers, which the provider names by this label.
  if (
    code === "1" &&
    BIT_TRANSFER_LABELS.has(text(row.businessName)?.trim() ?? "")
  ) {
    return "transfer";
  }
  return code === "1" || code === "3" || code === "7"
    ? "purchase"
    : code === "8"
      ? "cash_withdrawal"
      : code === "20" || code === "23"
        ? "transfer"
        : "unknown";
}

/** A source flag counts only when it is explicitly true. */
function flagged(value: unknown): boolean {
  return value === true || (typeof value === "string" && /^true$/i.test(value));
}

function decode(responseText: string | undefined): unknown {
  try {
    return responseText === undefined ? null : parse(responseText);
  } catch {
    return null;
  }
}

function digitalData(value: unknown): SourceRow | null {
  return object(value) && isIsracardDigitalSuccess(value) && object(value.data)
    ? value.data
    : null;
}

function legacyData(value: unknown, bean: string): SourceRow | null {
  return object(value) &&
    object(value.Header) &&
    token(value.Header.Status) === "1" &&
    object(value[bean])
    ? value[bean]
    : null;
}

/** Observed DigitalV3 billing currency codes (`billingAmountCurrency`). */
function digitalCurrency(code: unknown): string | null {
  const value = token(code);
  return value === "0"
    ? "ILS"
    : value === "19"
      ? "USD"
      : value === "100"
        ? "EUR"
        : null;
}

/**
 * Exact sums per currency, or null when any item's currency or amount is
 * unreadable, so a source total is never compared against a partial sum.
 */
function sumsByCurrency(
  items: { currency: string | null; amount: unknown }[],
): Map<string, number> | null {
  const amounts = new Map<string, number[]>();
  for (const { currency, amount } of items) {
    const value = minor(amount, currency);
    if (currency === null || value === null) {
      return null;
    }
    amounts.set(currency, [...(amounts.get(currency) ?? []), value]);
  }
  try {
    return new Map(
      [...amounts].map(([currency, values]) => [currency, sumMinor(values)]),
    );
  } catch {
    return null;
  }
}

/** Whether every currency's stated total equals its rows' sum (absent is zero). */
function totalsMatch(
  stated: Map<string, number> | null,
  rows: Map<string, number> | null,
): boolean {
  return (
    stated !== null &&
    rows !== null &&
    [...new Set([...stated.keys(), ...rows.keys()])].every(
      (currency) => (stated.get(currency) ?? 0) === (rows.get(currency) ?? 0),
    )
  );
}

/**
 * Source-total consistency (value-free): the DigitalV3 statement totals and
 * each immediate-charge group's total and count against their rows. A
 * mismatch is a warning, never a failure or proof of absence.
 */
function checkDigitalTotals(base: SourceRow, warnings: string[]): void {
  const vouchers = object(base.vouchers) ? base.vouchers : null;
  if (
    vouchers &&
    object(vouchers.totalForStatement) &&
    Array.isArray(vouchers.israelAbroadVouchersList)
  ) {
    const totals = vouchers.totalForStatement;
    const stated = sumsByCurrency(
      (
        [
          ["ILS", totals.totalIlsBillingDate],
          ["USD", totals.totalUsdBillingDate],
          ["EUR", totals.totalEurBillingDate],
        ] as const
      ).flatMap(([currency, amount]) =>
        present(amount) ? [{ currency, amount }] : [],
      ),
    );
    const rows = sumsByCurrency(
      vouchers.israelAbroadVouchersList.map((row) =>
        object(row)
          ? {
              currency: digitalCurrency(row.billingAmountCurrency),
              amount: row.billingAmount,
            }
          : { currency: null, amount: null },
      ),
    );
    if (!totalsMatch(stated, rows)) {
      warnings.push("digital_statement_total_mismatch");
    }
  }
  if (Array.isArray(base.outOfStatementChargeDateVouchers)) {
    for (const group of base.outOfStatementChargeDateVouchers) {
      if (!object(group) || !object(group.totalVouchersCurrencyDate)) {
        continue;
      }
      const summary = group.totalVouchersCurrencyDate;
      const currency = digitalCurrency(summary.currencyImmediateVouchers);
      const items = Array.isArray(group.immediateVouchersCurrencyDate)
        ? group.immediateVouchersCurrencyDate
        : [];
      const rows = sumsByCurrency(
        items.map((row) =>
          object(row) && digitalCurrency(row.billingAmountCurrency) === currency
            ? { currency, amount: row.billingAmount }
            : { currency: null, amount: null },
        ),
      );
      if (
        integer(summary.countImmediateVouchers) !== items.length ||
        !totalsMatch(
          sumsByCurrency([
            { currency, amount: summary.totalImmediateVouchers },
          ]),
          rows,
        )
      ) {
        warnings.push("digital_immediate_total_mismatch");
      }
    }
  }
}

function exactKeys(value: unknown, keys: string): value is SourceRow {
  return object(value) && Object.keys(value).sort().join() === keys;
}

function isracardApprovals(value: unknown): boolean {
  return (
    exactKeys(value, "approvedTransactions,totalEstimatedAmount") &&
    Array.isArray(value.approvedTransactions) &&
    value.approvedTransactions.every(object) &&
    isLosslessNumber(value.totalEstimatedAmount)
  );
}

/**
 * Whether DigitalV3 `currentTransactionsList` has the observed summary shape:
 * per upcoming billing month, a count and total per currency of transactions
 * not yet billed. It carries no merchant or date, so it never becomes rows.
 */
export function isracardPendingSummary(value: unknown): boolean {
  return (
    exactKeys(value, "currentTransactionsBillingMonth") &&
    Array.isArray(value.currentTransactionsBillingMonth) &&
    value.currentTransactionsBillingMonth.every(
      (month) =>
        exactKeys(month, "currentBillingMonth,totalTransactionsCurrency") &&
        sourceDate(month.currentBillingMonth) !== null &&
        Array.isArray(month.totalTransactionsCurrency) &&
        month.totalTransactionsCurrency.every(
          (total) =>
            exactKeys(
              total,
              "transactionsCount,transactionsCurrency,transactionsSymbol,transactionsTotal",
            ) &&
            isLosslessNumber(total.transactionsTotal) &&
            isLosslessNumber(total.transactionsCurrency) &&
            typeof total.transactionsSymbol === "string" &&
            integer(total.transactionsCount) !== null,
        ),
    )
  );
}

function collectDigital(
  data: SourceRow,
  warnings: string[],
): { rows: Observation[]; success: boolean } {
  const rows: Observation[] = [];
  let success = true;

  function append(
    value: unknown,
    path: string,
    informational = false,
    billingDate: string | null = null,
  ): void {
    if (!Array.isArray(value)) {
      warnings.push("invalid_digital_row_partition");
      success = false;
      return;
    }
    value.forEach((row, index) => {
      if (!object(row)) {
        warnings.push("invalid_digital_row");
        success = false;
        return;
      }
      rows.push({
        row,
        path: `${path}[${index}]`,
        generation: "digital",
        voucher: voucher(row.seqVoucherNumber),
        purchaseDate: sourceDate(row.purchaseDate),
        billingDate,
        informational,
        foreign: row.isIsraelDeal === false,
      });
    });
  }

  // The pending summary stays raw: posted vouchers are unaffected, and it
  // states no merchant or date for a pending row.
  const pendingSummary = isracardPendingSummary(data.currentTransactionsList);
  if (pendingSummary) {
    warnings.push("unsupported_pending_summary");
  }
  if (data.israelAbroadVouchers === null) {
    // The provider's shape for card-months without charges, possibly beside a
    // pending summary. Any other null-voucher shape remains unsupported.
    if (
      exactKeys(
        data,
        "approvals,currentTransactionsList,israelAbroadVouchers",
      ) &&
      ((data.approvals === null &&
        (data.currentTransactionsList === null || pendingSummary)) ||
        (isracardApprovals(data.approvals) &&
          data.currentTransactionsList === null))
    ) {
      return { rows, success: true };
    }
    warnings.push("unsupported_digital_empty_shape");
    return { rows, success: false };
  }
  if (!object(data.israelAbroadVouchers)) {
    return { rows, success: false };
  }
  // Any other non-null current-transactions shape is unsupported: it stays
  // raw evidence and the posted coverage is partial.
  if (
    data.currentTransactionsList !== null &&
    data.currentTransactionsList !== undefined &&
    !pendingSummary
  ) {
    warnings.push("unsupported_current_transactions_preserved_raw");
    success = false;
  }
  const base = data.israelAbroadVouchers;
  checkDigitalTotals(base, warnings);
  const path = "$.responses.digital.data.israelAbroadVouchers";
  if (object(base.vouchers)) {
    append(
      base.vouchers.israelAbroadVouchersList,
      `${path}.vouchers.israelAbroadVouchersList`,
    );
    if (base.vouchers.informativeOnlyVouchers !== undefined) {
      append(
        base.vouchers.informativeOnlyVouchers,
        `${path}.vouchers.informativeOnlyVouchers`,
        true,
      );
    }
  } else {
    success = false;
  }
  if (Array.isArray(base.outOfStatementChargeDateVouchers)) {
    base.outOfStatementChargeDateVouchers.forEach((group, index) => {
      if (!object(group)) {
        success = false;
        return;
      }
      const billingDate = object(group.totalVouchersCurrencyDate)
        ? sourceDate(group.totalVouchersCurrencyDate.dateImmediateVouchers)
        : null;
      append(
        group.immediateVouchersCurrencyDate,
        `${path}.outOfStatementChargeDateVouchers[${index}].immediateVouchersCurrencyDate`,
        false,
        billingDate,
      );
    });
  } else {
    success = false;
  }
  return { rows, success };
}

/** A legacy abroad fee line, billed with its withdrawal in DigitalV3. */
type CashAdvanceFee = { currency: string | null; minor: number | null };

/** The trimmed abroad supplier name of a legacy zero-voucher line. */
function abroadLabel(row: SourceRow): string | null {
  return text(row.fullSupplierNameOutbound)?.trim() ?? null;
}

/**
 * Legacy statement totals against their rows, per container and currency:
 * the domestic "total charge" rows (`dealSumType` `1` ILS, `T` USD) and the
 * abroad `TOTAL FOR DATE` rows, whose sums include the `CASH ADVANCE FEE`
 * lines. Value-free; a mismatch is a warning.
 */
function checkLegacyTotals(
  lines: { row: SourceRow; foreign: boolean; artifact: boolean }[],
  warnings: string[],
): void {
  for (const foreign of [false, true]) {
    const container = lines.filter((line) => line.foreign === foreign);
    const totals = container.filter(({ row, artifact }) =>
      foreign
        ? artifact && abroadLabel(row) === TOTAL_FOR_DATE_LABEL
        : ["1", "T"].includes(token(row.dealSumType) ?? ""),
    );
    if (totals.length === 0) {
      continue;
    }
    const amount = (row: SourceRow) =>
      foreign ? row.paymentSumOutbound : row.paymentSum;
    const stated = sumsByCurrency(
      totals.map(({ row }) => ({
        currency: foreign
          ? legacyCurrency(row.currencyId)
          : token(row.dealSumType) === "1"
            ? "ILS"
            : "USD",
        amount: amount(row),
      })),
    );
    const rows = sumsByCurrency(
      container
        .filter(
          ({ row, artifact }) =>
            !artifact ||
            (foreign && abroadLabel(row) === CASH_ADVANCE_FEE_LABEL),
        )
        .map(({ row }) => ({
          currency: legacyCurrency(row.currencyId),
          amount: amount(row),
        })),
    );
    if (!totalsMatch(stated, rows)) {
      warnings.push("legacy_total_mismatch");
    }
  }
}

/** The row partitions of a legacy statement group: domestic, abroad, informational. */
const LEGACY_PARTITIONS: readonly string[] = [
  "txnIsrael",
  "txnAbroad",
  "txnInfo",
];

function collectLegacy(
  data: SourceRow,
  capture: IsracardCapture,
  warnings: string[],
): {
  rows: Observation[];
  success: boolean;
  cashAdvanceFees: CashAdvanceFee[];
} {
  const rows: Observation[] = [];
  const cashAdvanceFees: CashAdvanceFee[] = [];
  const lines: { row: SourceRow; foreign: boolean; artifact: boolean }[] = [];
  if (capture.legacyCardIndex === undefined) {
    warnings.push("legacy_card_binding_missing");
    return { rows, success: false, cashAdvanceFees };
  }
  const indexKey = `Index${capture.legacyCardIndex}`;
  const entry = data[indexKey];
  if (!object(entry) || !Array.isArray(entry.CurrentCardTransactions)) {
    warnings.push("invalid_legacy_card_partition");
    return { rows, success: false, cashAdvanceFees };
  }
  let success = true;
  entry.CurrentCardTransactions.forEach((group, groupIndex) => {
    if (!object(group)) {
      success = false;
      return;
    }
    // Live groups carry only `@cardTransactions` and known partitions. Anything else
    // may hold unsupported rows: report partial coverage but keep known siblings.
    if (
      !LEGACY_PARTITIONS.some((field) => group[field] !== undefined) ||
      Object.keys(group).some(
        (key) =>
          key !== "@cardTransactions" && !LEGACY_PARTITIONS.includes(key),
      )
    ) {
      success = false;
    }
    for (const field of LEGACY_PARTITIONS) {
      // Statements send one partition per group, null when empty.
      if (group[field] === undefined || group[field] === null) {
        continue;
      }
      if (!Array.isArray(group[field])) {
        success = false;
        continue;
      }
      group[field].forEach((row, index) => {
        if (!object(row)) {
          success = false;
          return;
        }
        const foreign = field === "txnAbroad";
        const rawVoucher = foreign
          ? row.voucherNumberRatzOutbound
          : row.voucherNumberRatz;
        const artifact =
          token(row.dealSumType) === "1" ||
          (field === "txnIsrael" && token(row.dealSumType) === "T") ||
          /^0+$/.test(token(rawVoucher) ?? "");
        if (field !== "txnInfo") {
          lines.push({ row, foreign, artifact });
        }
        if (artifact) {
          warnings.push("legacy_statement_artifacts_preserved_raw");
          if (foreign && abroadLabel(row) === CASH_ADVANCE_FEE_LABEL) {
            const currency = legacyCurrency(row.currencyId);
            cashAdvanceFees.push({
              currency,
              minor: minor(row.paymentSumOutbound, currency),
            });
          }
          return;
        }
        rows.push({
          row,
          generation: "legacy",
          path: `$.responses.legacy.CardsTransactionsListBean.${indexKey}.CurrentCardTransactions[${groupIndex}].${field}[${index}]`,
          voucher: voucher(rawVoucher),
          purchaseDate: sourceDate(
            foreign ? row.fullPurchaseDateOutbound : row.fullPurchaseDate,
          ),
          billingDate: sourceDate(row.fullPaymentDate),
          informational: field === "txnInfo",
          foreign,
        });
      });
    }
  });
  checkLegacyTotals(lines, warnings);
  return { rows, success, cashAdvanceFees };
}

function bindingValid(capture: IsracardCapture, cardList: SourceRow): boolean {
  if (!Array.isArray(cardList.cardsList)) {
    return false;
  }
  const matching = cardList.cardsList.filter(
    (card) =>
      object(card) &&
      token(card.companyCode) === capture.card.companyCode &&
      token(card.cardSuffix) === capture.card.cardSuffix,
  );
  return (
    matching.length === 1 &&
    object(matching[0]) &&
    token(matching[0].cardGuid) === capture.card.cardGuid
  );
}

function legacyBindingValid(
  data: SourceRow,
  capture: IsracardCapture,
): boolean {
  if (
    capture.legacyCardIndex === undefined ||
    !Array.isArray(data.cardNumberList)
  ) {
    return false;
  }
  const names = (value: unknown) =>
    typeof value === "string" &&
    value.match(/(\d{4})\s*$/)?.[1] === capture.card.cardSuffix;
  const entry = data.cardNumberList[Number(capture.legacyCardIndex)];
  return (
    hasLegacyStatement(capture.card) &&
    names(entry) &&
    data.cardNumberList.filter(names).length === 1
  );
}

function billingCurrency(observation: Observation): string | null {
  if (observation.generation === "digital") {
    return digitalCurrency(observation.row.billingAmountCurrency);
  }
  return legacyCurrency(observation.row.currencyId);
}

function legacyCurrency(marker: unknown): string | null {
  const value = token(marker);
  // Upstream constants.ts/convertCurrency explicitly identify NIS as a shekel alias.
  return value === "NIS" || value === "₪" || value === 'ש"ח' || value === "ש״ח"
    ? "ILS"
    : value === "דולר"
      ? "USD"
      : value && CURRENCY_CODE.test(value)
        ? value
        : null;
}

/**
 * The currency of a plan total: DigitalV3 `originalCurrencyIso`, or the legacy
 * domestic `kodMatbeaMekori`, whose `dealSum` states the total.
 */
function planTotalCurrency(observation: Observation): string | null {
  if (observation.generation === "digital") {
    const iso = text(observation.row.originalCurrencyIso);
    return iso !== null && CURRENCY_CODE.test(iso) ? iso : null;
  }
  return legacyCurrency(observation.row.kodMatbeaMekori);
}

/**
 * The one optional detail bound to an observation: unambiguous, requested by
 * its voucher and carrying that same `voucherNumberRatz`. Anything else stays
 * in the archive alone, with an issue.
 */
function bindDetail(
  capture: IsracardCapture,
  observation: Observation,
  ambiguous: boolean,
): { detail: SourceRow; index: number } | { issue: string } | null {
  const matches =
    capture.responses.details?.filter(
      (item) => item.voucherNumber === observation.voucher,
    ) ?? [];
  if (!ambiguous && matches.length === 1) {
    const detail = legacyData(
      decode(matches[0]!.responseText),
      "PirteyIska_204Bean",
    );
    return detail && token(detail.voucherNumberRatz) === observation.voucher
      ? { detail, index: capture.responses.details!.indexOf(matches[0]!) }
      : { issue: "invalid_transaction_detail" };
  }
  return matches.length > 0 ? { issue: "ambiguous_transaction_detail" } : null;
}

/** The Hebrew word for "payment" that installment texts name. */
const PAYMENT_WORD = "תשלום";
/** DigitalV3 `moreInfo` " תשלום N מ M " ("payment N of M"). */
const DIGITAL_ORDINAL_TEXT = /^\s*תשלום\s+(\d+)\s+מ\s+(\d+)\s*$/;
/** Legacy `moreInfo` "תשלום N מתוך M" ("payment N out of M"). */
const LEGACY_ORDINAL_TEXT = /^\s*תשלום\s+(\d+)\s+מתוך\s+(\d+)\s*$/;

/** One payment of a proven installment plan, which becomes a billed line. */
type PlanPayment = {
  purchaseKey: string;
  installmentNumber: number;
  installmentCount: number;
};

/**
 * What an installment states about the plan it names, whether or not it is a
 * proven payment: every observation's total, as `[currency, minor]` (null
 * when unreadable), and every planned count its sources state.
 */
type PlanWitness = {
  purchaseKey: string;
  totals: ([currency: string, minor: number] | null)[];
  counts: number[];
};

type InstallmentAssessment = {
  installment: boolean;
  issues: string[];
} & (
  | { plan: null; witness: PlanWitness | null }
  | { plan: PlanPayment; witness: PlanWitness }
);

function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * Whether a payment group is an installment, and whether it is a payment of a
 * proven plan. Every ordinal source must agree: the DigitalV3 numbers and
 * `moreInfo` text, the legacy `moreInfo` text and a bound detail's numbers.
 * A plan also needs one digit plan voucher (leading zeros removed), domestic
 * observations whose billing and total currencies are known and equal, and
 * positive payments. Anything short of that keeps the payment unresolved, but
 * an installment that names a plan still witnesses that plan's total and count.
 */
function assessInstallment(
  observations: Observation[],
  detail: SourceRow | null,
  accountKey: string,
): InstallmentAssessment {
  const issues: string[] = [];
  const digitalRows = observations.flatMap((item) =>
    item.generation === "digital" ? [item.row] : [],
  );
  const malformed = digitalRows.some((row) =>
    ["currentInstallmentNum", "numberOfInstallment"].some(
      (field) => present(row[field]) && integer(row[field]) === null,
    ),
  );
  const above = (value: unknown) => (integer(value) ?? 0) > 1;
  const inconsistent = digitalRows.some((row) => {
    const number = integer(row.currentInstallmentNum);
    const count = integer(row.numberOfInstallment);
    return number !== null && count !== null && number > count;
  });
  const installment =
    malformed ||
    inconsistent ||
    digitalRows.some(
      (row) =>
        above(row.numberOfInstallment) || above(row.currentInstallmentNum),
    ) ||
    // Legacy text that names a payment marks an installment. DigitalV3 prose
    // does only in the exact template, so an ordinary note keeps its money.
    observations.some(({ generation, row }) => {
      if (typeof row.moreInfo !== "string") {
        return false;
      }
      if (generation === "legacy") {
        return row.moreInfo.includes(PAYMENT_WORD);
      }
      const match = row.moreInfo.match(DIGITAL_ORDINAL_TEXT);
      return match !== null && (above(match[1]) || above(match[2]));
    }) ||
    (detail !== null &&
      (above(detail.numberOfPayments) || above(detail.paymentNumber)));
  if (!installment) {
    return { installment, issues, plan: null, witness: null };
  }
  // Each source states an ordinal and a count, or is malformed (null).
  const statements: ({ number: number; count: number } | null)[] = [];
  // Every readable planned count, even beside a malformed ordinal.
  const counts = new Set<number>();
  const pair = (number: unknown, count: unknown) => {
    if (!present(number) && !present(count)) {
      return;
    }
    const ordinal = integer(number);
    const size = integer(count);
    if (size !== null) {
      counts.add(size);
    }
    statements.push(
      ordinal === null || size === null
        ? null
        : { number: ordinal, count: size },
    );
  };
  for (const { generation, row } of observations) {
    if (generation === "digital") {
      pair(row.currentInstallmentNum, row.numberOfInstallment);
    }
    if (typeof row.moreInfo !== "string") {
      continue;
    }
    const match = row.moreInfo.match(
      generation === "digital" ? DIGITAL_ORDINAL_TEXT : LEGACY_ORDINAL_TEXT,
    );
    if (match) {
      pair(match[1], match[2]);
    } else if (
      row.moreInfo.includes(PAYMENT_WORD) &&
      (generation === "legacy" || token(row.transactionCode) === "3")
    ) {
      // A plan row's text that names a payment outside the template.
      statements.push(null);
    }
  }
  if (detail !== null) {
    pair(detail.paymentNumber, detail.numberOfPayments);
  }
  const head = observations[0]!;
  // The shared plan voucher: DigitalV3 states a number, legacy pads it.
  const planVouchers = observations.map(({ row }) => {
    const value = token(row.voucherNumber);
    return value !== null && /^\d+$/.test(value)
      ? value.replace(/^0+/, "")
      : "";
  });
  const planVoucher =
    planVouchers.every((value) => value !== "") &&
    new Set(planVouchers).size === 1
      ? planVouchers[0]!
      : null;
  const witness: PlanWitness | null =
    planVoucher !== null && head.purchaseDate !== null
      ? {
          purchaseKey: `isracard:posted:purchase:${JSON.stringify([accountKey, planVoucher, head.purchaseDate])}`,
          totals: observations.map((item): [string, number] | null => {
            const currency = planTotalCurrency(item);
            const total =
              currency === null
                ? null
                : minor(
                    item.generation === "digital"
                      ? item.row.originalAmount
                      : item.row.dealSum,
                    currency,
                  );
            return currency === null || total === null
              ? null
              : [currency, total];
          }),
          counts: [...counts],
        }
      : null;
  const unresolved = { installment, issues, plan: null, witness };
  const first = statements[0];
  const agreed =
    first !== null &&
    first !== undefined &&
    statements.every(
      (item) =>
        item !== null &&
        item.number === first.number &&
        item.count === first.count,
    ) &&
    first.number >= 1 &&
    first.number <= first.count &&
    // The DigitalV3 final-payment flag corroborates the ordinal.
    digitalRows.every(
      (row) =>
        typeof row.isLastInstallment !== "boolean" ||
        row.isLastInstallment === (first.number === first.count),
    );
  if (!agreed) {
    issues.push("invalid_installment_ordinal");
    return unresolved;
  }
  if (
    first.count < 2 ||
    !head.voucher ||
    !head.purchaseDate ||
    observations.some((item) => item.informational || item.foreign) ||
    digitalRows.some((row) => token(row.transactionCode) !== "3")
  ) {
    return unresolved;
  }
  if (witness === null) {
    issues.push("invalid_installment_plan_voucher");
    return unresolved;
  }
  const currencies = observations.flatMap((item) => [
    billingCurrency(item),
    planTotalCurrency(item),
  ]);
  if (
    currencies.some((item) => item === null) ||
    new Set(currencies).size !== 1
  ) {
    if (currencies.every((item) => item !== null)) {
      issues.push("unverified_converted_installments");
    }
    return unresolved;
  }
  if (
    observations.some(
      ({ generation, row }) =>
        sourceSign(
          generation === "digital" ? row.billingAmount : row.paymentSum,
        ) !== 1,
    )
  ) {
    issues.push("unsupported_amount_direction");
    return unresolved;
  }
  return {
    installment,
    issues,
    plan: {
      purchaseKey: witness.purchaseKey,
      installmentNumber: first.number,
      installmentCount: first.count,
    },
    witness,
  };
}

/** Legacy fee-waiver text: "הנחה <amount> ש"ח …" ("discount <amount> ILS"). */
const LEGACY_FEE_WAIVER = /^\s*הנחה\s+\d+(?:\.\d+)?\s+ש["״]ח/;

/**
 * A legacy-only domestic waived card fee: the fee-waiver text, a zero
 * payment and a positive list fee in `dealSum`.
 */
function waivedLegacyFee(observations: Observation[]): boolean {
  const [only] = observations;
  return (
    observations.length === 1 &&
    only !== undefined &&
    only.generation === "legacy" &&
    !only.foreign &&
    !only.informational &&
    typeof only.row.moreInfo === "string" &&
    LEGACY_FEE_WAIVER.test(only.row.moreInfo) &&
    sourceSign(only.row.paymentSum) === 0 &&
    sourceSign(only.row.dealSum) === 1
  );
}

function extractGroup(
  observations: Observation[],
  capture: IsracardCapture,
  context: ExtractionContext,
  sourceKey: string,
  ambiguous: boolean,
  baseKey: string,
  occurrenceCount: number,
  binding: ReturnType<typeof bindDetail>,
  assessment: InstallmentAssessment,
  feeExplained: boolean,
): TransactionInput {
  const observation = observations[0]!;
  const { row, generation } = observation;
  const digital = generation === "digital";
  const details = emptyDetails();
  // DigitalV3 prose belongs to this exact source observation; optional voucher-only
  // details do not establish the same binding. Keep markup as uninterpreted text.
  details.additionalInformation = [
    ...new Set(
      observations.flatMap((item) =>
        item.generation === "digital" &&
        typeof item.row.moreInfo === "string" &&
        item.row.moreInfo.trim().length > 0
          ? [item.row.moreInfo]
          : [],
      ),
    ),
  ];
  const issues = details.issues;
  details.sourceRefs = observations.map(({ path }) => ({
    runId: context.runId,
    path,
  }));
  // A payment of a proven plan is a billed line; any other installment
  // payment stays unresolved.
  const { installment, plan } = assessment;
  issues.push(...assessment.issues);
  // Only a time carried by this same, unambiguous purchase observation can be
  // paired with its date. A voucher-only optional detail or billing date cannot.
  const purchaseTime = text(row.purchaseTime);
  const purchaseDateTime =
    digital && observation.purchaseDate !== null && purchaseTime !== null
      ? transactionDateTimeSchema.safeParse(
          `${observation.purchaseDate}T${purchaseTime}`,
        )
      : null;
  details.transactionDateTime =
    !ambiguous && !installment && purchaseDateTime?.success
      ? purchaseDateTime.data
      : null;
  if (purchaseDateTime && !purchaseDateTime.success) {
    issues.push("invalid_source_time");
  }
  let currency = billingCurrency(observation);
  const rawBilling = digital
    ? row.billingAmount
    : observation.foreign
      ? row.paymentSumOutbound
      : row.paymentSum;
  const billedMinor = minor(rawBilling, currency);
  // Source-derived signed convention, not a transaction-code mapping; the
  // source notes (isracard.money) cite its provenance.
  let amountMinor =
    billedMinor === null ? null : billedMinor === 0 ? 0 : -billedMinor;
  if (ambiguous || !observation.voucher || !observation.purchaseDate) {
    amountMinor = null;
  }
  if (observations.length > 1) {
    const companion = observations[1]!;
    const companionCurrency = billingCurrency(companion);
    const companionAmount = minor(
      companion.foreign
        ? companion.row.paymentSumOutbound
        : companion.row.paymentSum,
      companionCurrency,
    );
    // A DigitalV3 cash withdrawal bills its fee; legacy lists the fee as a
    // separate `CASH ADVANCE FEE` line, which stays raw evidence.
    if (
      !feeExplained &&
      companionCurrency !== null &&
      companionAmount !== null &&
      currency !== null &&
      billedMinor !== null &&
      (companionCurrency !== currency || companionAmount !== billedMinor)
    ) {
      amountMinor = null;
      issues.push("conflicting_generation_billing_amount");
    } else if (companionCurrency === null || companionAmount === null) {
      issues.push("unresolved_companion_billing_amount");
    }
  }
  if (amountMinor === null) {
    issues.push("unresolved_billing_amount");
  }
  const unverifiedSourceRole = observations.some(
    (item) => item.generation === "legacy" && item.informational,
  );
  const unresolvedInstallment = installment && plan === null;
  if (
    unresolvedInstallment ||
    observation.informational ||
    unverifiedSourceRole
  ) {
    amountMinor = null;
    if (unresolvedInstallment) {
      issues.push("unverified_installment_amount_basis");
    }
    if (digital && observation.informational) {
      issues.push("informational_statement_row");
    }
    if (unverifiedSourceRole) {
      issues.push("unverified_legacy_source_role");
    }
  }
  if (amountMinor === null) {
    currency = null;
  }
  const digitalRow = observations.find(
    (item) => item.generation === "digital",
  )?.row;
  // A plan's payments are purchases, as CAL's billed lines are; the plan
  // requires positive payments and a code 3 DigitalV3 row when there is one.
  const kind =
    plan !== null
      ? "purchase"
      : digitalRow
        ? digitalKind(digitalRow)
        : waivedLegacyFee(observations)
          ? "fee"
          : "unknown";
  // Original money: DigitalV3 `originalAmount` in `originalCurrencyIso`, for
  // a row that is not an installment. In the billing currency it must equal
  // the bill plus the stated discount.
  let originalAmountMinor: number | null = null;
  let originalCurrency: string | null = null;
  let reconciled = false;
  if (
    digital &&
    !installment &&
    !observation.informational &&
    !ambiguous &&
    observation.voucher &&
    observation.purchaseDate
  ) {
    const iso = text(row.originalCurrencyIso);
    const stated =
      iso !== null && CURRENCY_CODE.test(iso)
        ? minor(row.originalAmount, iso)
        : null;
    if (stated === null) {
      if (present(row.originalAmount)) {
        issues.push("unresolved_original_amount");
      }
    } else if (iso === billingCurrency(observation)) {
      const discount = present(row.discountAmount)
        ? minor(row.discountAmount, iso)
        : 0;
      reconciled =
        billedMinor !== null &&
        discount !== null &&
        billedMinor + discount === stated;
      if (!reconciled) {
        issues.push("conflicting_original_amount");
      }
    }
    if (
      stated !== null &&
      (iso !== billingCurrency(observation) || reconciled)
    ) {
      originalAmountMinor = stated === 0 ? 0 : -stated;
      originalCurrency = iso;
    }
  }
  // A same-currency DigitalV3 charge of a mapped kind states its role: the
  // charged `billingAmount` of a posted purchase commitment, as for CAL.
  // Code 3 bills installment payments, so outside a proven plan its role
  // stays unknown.
  const verified =
    plan !== null ||
    (reconciled &&
      amountMinor !== null &&
      !unverifiedSourceRole &&
      token(row.transactionCode) !== "3" &&
      ["purchase", "fee", "cash_withdrawal", "transfer"].includes(kind));
  issues.push(
    ...(verified ? [] : ["isracard_unverified_semantics"]),
    ...(kind === "unknown" ? ["unsupported_transaction_type"] : []),
    ...(verified ? [] : ["unverified_amount_basis"]),
    "source_derived_amount_direction",
  );
  if (ambiguous) {
    issues.push("ambiguous_source_identity");
  }
  if (!observation.voucher || !observation.purchaseDate) {
    issues.push("incomplete_source_identity");
  }
  if (!observation.purchaseDate) {
    issues.push("invalid_source_date");
  }
  const evidenceCurrency = digital
    ? text(row.originalCurrencyIso)
    : token(row.currentPaymentCurrency);
  const rawOriginal = digital
    ? row.originalAmount
    : observation.foreign
      ? row.dealSumOutbound
      : row.dealSum;
  const originalMinor = minor(rawOriginal, evidenceCurrency);
  details.provider.isracard = {
    identity: { baseKey, occurrenceCount },
    rows: observations.map((item) => json(item.row)),
    observations: observations.map((item) => ({
      generation: item.generation,
      path: item.path,
      row: json(item.row),
    })),
    monetaryEvidence: {
      billingMinor: billedMinor,
      billingCurrency: billingCurrency(observation),
      originalMinor,
      originalCurrency: evidenceCurrency,
      convention:
        plan !== null
          ? "upstream signed billing amounts negated; billed payment of a proven installment plan"
          : verified
            ? "upstream signed billing amounts negated; charged billingAmount of a same-currency posted charge; originalAmount = billingAmount + discountAmount"
            : "upstream signed billing amounts negated; amount basis unverified; kind only from the DigitalV3 transactionCode and source sign",
    },
    billingMonth: capture.billingMonth,
  };
  details.merchant.city = digital ? text(row.cityDescription) : text(row.city);
  const countryCode = digital ? text(row.countryCode) : null;
  details.merchant.countryCode =
    countryCode !== null && isCountryCode(countryCode) ? countryCode : null;
  // Conservative payment context. `presentCard` does not establish
  // card presence; the security and wallet flags stay raw evidence.
  const codeType = digitalRow ? token(digitalRow.tranzacCodeType) : null;
  const wallets: TransactionInput["wallet"][] = [];
  let counterpartyName: string | null = null;
  // A detail projects facts only when its own voucher is the requested one;
  // an unbound detail stays in the archive alone.
  if (binding !== null) {
    if ("detail" in binding) {
      const { detail } = binding;
      details.merchant.address = text(detail.address);
      details.merchant.phone = text(detail.phoneNumber);
      wallets.push(walletFromName(detail.transactionType));
      wallets.push(walletFromName(detail.walletPayName));
      // A transfer's bound detail names its other party.
      if (kind === "transfer") {
        counterpartyName = text(detail.motavName)?.trim() || null;
      }
      details.provider.isracard.detail = json(detail);
      details.sourceRefs.push({
        runId: context.runId,
        path: `$.responses.details[${binding.index}].responseText.PirteyIska_204Bean`,
      });
    } else {
      issues.push(binding.issue);
    }
  }
  const walletNames = [...new Set(wallets.filter((wallet) => wallet !== null))];
  if (walletNames.length > 1) {
    issues.push("conflicting_payment_context");
  }
  const merchantName = text(
    digital
      ? row.businessName
      : observation.foreign
        ? row.fullSupplierNameOutbound
        : row.fullSupplierNameHeb,
  );
  const billingDates = [
    ...new Set(
      observations.flatMap((item) =>
        item.billingDate === null ? [] : [item.billingDate],
      ),
    ),
  ];
  details.issues = [...new Set(issues)];
  return {
    sourceScope: isracardCardKey(capture.card),
    cardKey: isracardCardKey(capture.card),
    sourceKey,
    sourceAliases: [],
    identityStrength:
      ambiguous || !observation.voucher || !observation.purchaseDate
        ? "ambiguous"
        : "native",
    status: "posted",
    description: text(digital ? row.transactionDescription : row.moreInfo),
    counterpartyName,
    kind,
    merchantName,
    merchantProviderId: token(digital ? row.businessNumber : row.supplierId),
    merchantCategoryCode: null,
    transactionDate: observation.purchaseDate,
    bookingDate: null,
    billingDate: unresolvedInstallment
      ? null
      : billingDates.length === 1
        ? billingDates[0]!
        : null,
    amountMinor,
    currency,
    amountBasis:
      plan !== null
        ? "booked_entry"
        : verified
          ? "purchase_commitment"
          : "unknown",
    originalAmountMinor,
    originalCurrency,
    // An unresolved installment carries no installment facts: a count without
    // lines would read as a plan purchase and leave the billing perspective.
    // The source count stays in the raw evidence.
    installmentCount:
      plan !== null
        ? plan.installmentCount
        : installment || !digital
          ? null
          : integer(row.numberOfInstallment),
    ...(plan !== null && {
      purchaseKey: plan.purchaseKey,
      installmentNumber: plan.installmentNumber,
    }),
    // Omitted payment facts have no evidence; null is conflicting evidence.
    authorizationMethod:
      codeType === "U" || codeType === "V" ? "online" : undefined,
    wallet:
      walletNames.length === 1
        ? walletNames[0]!
        : walletNames.length > 1
          ? null
          : undefined,
    threeDSecureUsed: codeType === "V" ? true : undefined,
    recurring: observations.some((item) =>
      flagged(
        item.generation === "digital"
          ? item.row.isdirectDebit
          : item.row.isHoraatKeva,
      ),
    )
      ? true
      : undefined,
    providerTransactionCode: digitalRow
      ? token(digitalRow.transactionCode)
      : null,
    details,
  };
}

/** Everything one capture states about one plan. */
type PlanEvidence = {
  /** Every installment that names the plan; only proven payments have a plan role. */
  groups: {
    observations: Observation[];
    witness: PlanWitness;
    plan: PlanPayment | null;
    line: TransactionInput;
  }[];
  /** One payment voucher's occurrences name different plans. */
  conflictingVoucher: boolean;
};

/**
 * One purchase per plan from any of its payments in the capture, as for CAL.
 * Its total is the one every observation states; different stated totals
 * leave it unknown. A total is never computed from payments: an archive can
 * start mid-plan. Every installment that names the plan counts for that
 * agreement, even one whose payment role is unresolved. Facts every payment
 * restates must agree, or the purchase carries `conflicting_installment_facts`;
 * neither splits the plan. Two payment vouchers stating the same ordinal could
 * bill one payment twice, so both lines lose their amount. A payment whose
 * occurrences name different plans leaves every plan it names without a total.
 */
function extractPlanPurchase(
  purchaseKey: string,
  { groups, conflictingVoucher }: PlanEvidence,
  capture: IsracardCapture,
  context: ExtractionContext,
): TransactionInput {
  const members = groups.flatMap(({ observations, plan, line }) =>
    plan === null ? [] : [{ observations, plan, line }],
  );
  const ordered = members
    .map((member, index) => ({ member, index }))
    .sort(
      (left, right) =>
        left.member.plan.installmentNumber -
          right.member.plan.installmentNumber || left.index - right.index,
    )
    .map(({ member }) => member);
  const observations = ordered.flatMap((member) => member.observations);
  const details = emptyDetails();
  // Plan rows carry no purchase time, as CAL's do not.
  details.transactionDateTime = null;
  const issues = details.issues;
  details.sourceRefs = [
    ...new Set(
      groups.flatMap((item) => item.observations.map(({ path }) => path)),
    ),
  ].map((path) => ({ runId: context.runId, path }));
  const stated = groups.flatMap(({ witness }) => witness.totals);
  let amountMinor: number | null = null;
  let currency: string | null = null;
  if (conflictingVoucher) {
    issues.push("invalid_installment_plan_voucher");
  } else if (!stated.every((total) => total !== null)) {
    issues.push("unresolved_amount");
  } else if (
    stated.some(
      ([totalCurrency, totalMinor]) =>
        totalCurrency !== stated[0]![0] || totalMinor !== stated[0]![1],
    )
  ) {
    issues.push("conflicting_installment_total");
  } else {
    const [statedCurrency, total] = stated[0]!;
    if (total > 0) {
      amountMinor = -total;
      currency = statedCurrency;
    } else {
      issues.push("unsupported_amount_direction");
    }
  }
  let duplicateOrdinal = false;
  for (const same of Map.groupBy(
    ordered,
    ({ plan }) => plan.installmentNumber,
  ).values()) {
    if (
      new Set(same.map((member) => member.observations[0]!.voucher)).size > 1
    ) {
      duplicateOrdinal = true;
      for (const { line } of same) {
        line.amountMinor = null;
        line.currency = null;
        line.details.issues = [
          ...new Set([...line.details.issues, "duplicate_installment_ordinal"]),
        ];
      }
    }
  }
  const differs = (values: unknown[]) =>
    new Set(values.map((value) => JSON.stringify(json(value)))).size > 1;
  const rows = (generation: Observation["generation"]) =>
    observations.flatMap((item) =>
      item.generation === generation ? [item.row] : [],
    );
  const digitalRows = rows("digital");
  const legacyRows = rows("legacy");
  if (
    duplicateOrdinal ||
    new Set(groups.flatMap(({ witness }) => witness.counts)).size > 1 ||
    differs(digitalRows.map((row) => row.businessName)) ||
    differs(digitalRows.map((row) => row.businessNumber)) ||
    differs(legacyRows.map((row) => row.fullSupplierNameHeb)) ||
    differs(legacyRows.map((row) => row.supplierId))
  ) {
    issues.push("conflicting_installment_facts");
  }
  issues.push("source_derived_amount_direction");
  const digitalRow = digitalRows[0];
  const legacyRow = legacyRows[0];
  details.merchant.city = digitalRow ? text(digitalRow.cityDescription) : null;
  const countryCode = digitalRow ? text(digitalRow.countryCode) : null;
  details.merchant.countryCode =
    countryCode !== null && isCountryCode(countryCode) ? countryCode : null;
  details.provider.isracard = {
    identity: { baseKey: purchaseKey, occurrenceCount: 1 },
    rows: observations.map((item) => json(item.row)),
    observations: observations.map((item) => ({
      generation: item.generation,
      path: item.path,
      row: json(item.row),
    })),
    monetaryEvidence: {
      // Unlike the proven-payment rows, totals include unresolved witnesses in capture order.
      statedTotals: stated,
      convention:
        "plan total as every installment naming the plan states it (DigitalV3 originalAmount, legacy dealSum), negated; never computed from payments",
    },
    billingMonth: capture.billingMonth,
  };
  const accountKey = isracardCardKey(capture.card);
  return {
    sourceScope: accountKey,
    cardKey: accountKey,
    sourceKey: purchaseKey,
    sourceAliases: [],
    identityStrength: "native",
    status: "posted",
    description: digitalRow ? text(digitalRow.transactionDescription) : null,
    counterpartyName: null,
    kind: "purchase",
    merchantName: text(
      digitalRow ? digitalRow.businessName : legacyRow?.fullSupplierNameHeb,
    ),
    merchantProviderId: token(
      digitalRow ? digitalRow.businessNumber : legacyRow?.supplierId,
    ),
    merchantCategoryCode: null,
    transactionDate: observations[0]!.purchaseDate,
    bookingDate: null,
    // A purchase keeps no payment date, so its facts stay stable as each
    // billing month observes another payment.
    billingDate: null,
    amountMinor,
    currency,
    amountBasis: "purchase_commitment",
    originalAmountMinor: null,
    originalCurrency: null,
    installmentCount: ordered[0]!.plan.installmentCount,
    providerTransactionCode: digitalRow
      ? token(digitalRow.transactionCode)
      : null,
    details,
  };
}

/**
 * The uniquely joined DigitalV3 code 8 withdrawals whose bill equals their
 * legacy withdrawal plus one `CASH ADVANCE FEE` line of the same capture (one
 * card and billing month) and currency. Each fee line explains at most one
 * withdrawal: a withdrawal is explained only when exactly one fee line fits
 * it and that line fits no other withdrawal, so any ambiguity keeps every
 * conflict.
 */
function explainCashAdvanceFees(
  groups: Map<string, Observation[]>,
  voucherCounts: Map<string, { digital: number; legacy: number }>,
  mismatchedVouchers: Set<string>,
  fees: CashAdvanceFee[],
): Set<string> {
  const candidates = new Map<string, number[]>();
  for (const [key, observations] of groups) {
    const [first, second] = observations;
    const counts = first?.voucher
      ? voucherCounts.get(first.voucher)
      : undefined;
    if (
      observations.length !== 2 ||
      first?.generation !== "digital" ||
      second?.generation !== "legacy" ||
      counts?.digital !== 1 ||
      counts.legacy !== 1 ||
      mismatchedVouchers.has(first.voucher!) ||
      token(first.row.transactionCode) !== "8" ||
      !second.foreign
    ) {
      continue;
    }
    const currency = billingCurrency(first);
    const billed = minor(first.row.billingAmount, currency);
    const withdrawn = minor(
      second.row.paymentSumOutbound,
      billingCurrency(second),
    );
    if (
      currency === null ||
      billingCurrency(second) !== currency ||
      billed === null ||
      withdrawn === null ||
      billed === withdrawn
    ) {
      continue;
    }
    candidates.set(
      key,
      fees.flatMap((fee, index) =>
        fee.minor !== null &&
        fee.currency === currency &&
        withdrawn + fee.minor === billed
          ? [index]
          : [],
      ),
    );
  }
  const claims = new Map<number, number>();
  for (const fits of candidates.values()) {
    for (const index of fits) {
      claims.set(index, (claims.get(index) ?? 0) + 1);
    }
  }
  return new Set(
    [...candidates].flatMap(([key, fits]) =>
      fits.length === 1 && claims.get(fits[0]!) === 1 ? [key] : [],
    ),
  );
}

/** Reconcile only unique voucher joins. Every raw response and unmatched occurrence remains inspectable. */
export function extractIsracard(
  responseText: string,
  context: ExtractionContext,
): ExtractionResult {
  const result: ExtractionResult = {
    transactions: [],
    partitions: [],
    warnings: [],
    historical: context.scope?.kind === "history",
  };
  // An unreadable or unbound capture is one failed posted partition.
  const reject = (warning: string): ExtractionResult => {
    result.warnings.push(warning);
    result.partitions.push({
      accountKey: context.accountKey,
      status: "posted",
      success: false,
      comparable: false,
    });
    return result;
  };
  let capture: IsracardCapture;
  try {
    capture = isracardCaptureSchema.parse(JSON.parse(responseText));
  } catch {
    return reject("invalid_isracard_capture");
  }
  result.historical ||= capture.mode === "history";
  const accountKey = isracardCardKey(capture.card);
  const cardList = digitalData(decode(capture.responses.cardList));
  const scopeMatches =
    context.scope !== undefined &&
    context.scope.kind === capture.mode &&
    context.scope.month === capture.billingMonth &&
    context.scope.cardKey === accountKey;
  if (
    !cardList ||
    !bindingValid(capture, cardList) ||
    accountKey !== context.accountKey ||
    !scopeMatches
  ) {
    return reject("invalid_card_or_scope_binding");
  }
  const digitalResponse = decode(capture.responses.digital);
  const digital = digitalData(digitalResponse);
  const legacy = legacyData(
    decode(capture.responses.legacy),
    "CardsTransactionsListBean",
  );
  const digitalResult = digital
    ? collectDigital(digital, result.warnings)
    : { rows: [], success: false };
  const legacyResult =
    legacy && legacyBindingValid(legacy, capture)
      ? collectLegacy(legacy, capture, result.warnings)
      : { rows: [], success: false, cashAdvanceFees: [] };
  if (legacy && !legacyBindingValid(legacy, capture)) {
    result.warnings.push("legacy_card_binding_missing_or_ambiguous");
  }
  if (capture.responses.digital !== undefined && !digital) {
    result.warnings.push("invalid_digital_response");
  }
  if (capture.responses.legacy !== undefined && !legacy) {
    result.warnings.push("invalid_legacy_response");
  }
  const rawApprovals =
    object(digitalResponse) && object(digitalResponse.data)
      ? digitalResponse.data.approvals
      : undefined;
  if (rawApprovals !== null && rawApprovals !== undefined) {
    result.warnings.push("unsupported_approvals_preserved_raw");
    result.partitions.push({
      accountKey,
      status: "pending",
      success: false,
      comparable: false,
    });
  }
  const groups = new Map<string, Observation[]>();
  const voucherCounts = new Map<string, { digital: number; legacy: number }>();
  const numericVouchers = new Map<
    string,
    { digital: Set<string>; legacy: Set<string> }
  >();
  for (const observation of [...digitalResult.rows, ...legacyResult.rows]) {
    if (!observation.voucher) {
      continue;
    }
    const count = voucherCounts.get(observation.voucher) ?? {
      digital: 0,
      legacy: 0,
    };
    count[observation.generation]++;
    voucherCounts.set(observation.voucher, count);
    if (!/^\d+$/.test(observation.voucher)) {
      continue;
    }
    // This equivalence is diagnostic only: opaque source lexemes never become aliases.
    const numeric = observation.voucher.replace(/^0+/, "") || "0";
    const values = numericVouchers.get(numeric) ?? {
      digital: new Set<string>(),
      legacy: new Set<string>(),
    };
    values[observation.generation].add(observation.voucher);
    numericVouchers.set(numeric, values);
  }
  const mismatchedVouchers = new Set<string>();
  for (const values of numericVouchers.values()) {
    const lexemes = [...values.digital, ...values.legacy];
    if (
      values.digital.size > 0 &&
      values.legacy.size > 0 &&
      new Set(lexemes).size > 1
    ) {
      for (const value of lexemes) {
        mismatchedVouchers.add(value);
      }
    }
  }
  if (mismatchedVouchers.size > 0) {
    result.warnings.push("numeric_equivalent_voucher_mismatch");
  }
  for (const observation of [...digitalResult.rows, ...legacyResult.rows]) {
    const key =
      observation.voucher && observation.purchaseDate
        ? JSON.stringify([
            accountKey,
            observation.purchaseDate,
            observation.voucher,
          ])
        : JSON.stringify([
            accountKey,
            "incomplete",
            observation.voucher,
            observation.purchaseDate,
          ]);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  const plans = new Map<string, PlanEvidence>();
  const plansByVoucher = new Map<string, (string | null)[]>();
  const evidence = (purchaseKey: string) => {
    const plan = plans.get(purchaseKey) ?? {
      groups: [],
      conflictingVoucher: false,
    };
    plans.set(purchaseKey, plan);
    return plan;
  };
  const explainedWithdrawals = explainCashAdvanceFees(
    groups,
    voucherCounts,
    mismatchedVouchers,
    legacyResult.cashAdvanceFees,
  );
  for (const [key, observations] of groups) {
    const digitalRows = observations.filter(
      (item) => item.generation === "digital",
    );
    const legacyRows = observations.filter(
      (item) => item.generation === "legacy",
    );
    const head = observations[0]!;
    const counts = head.voucher ? voucherCounts.get(head.voucher) : undefined;
    const uniqueJoin =
      digitalRows.length === 1 &&
      legacyRows.length === 1 &&
      counts?.digital === 1 &&
      counts.legacy === 1 &&
      !mismatchedVouchers.has(head.voucher!);
    const baseKey = head.voucher
      ? `isracard:posted:voucher:${JSON.stringify([accountKey, head.voucher])}`
      : `isracard:posted:missing-voucher:${JSON.stringify([accountKey, head.purchaseDate])}`;
    const ambiguousVoucher =
      mismatchedVouchers.has(head.voucher ?? "") ||
      (!!counts &&
        (counts.digital > 1 ||
          counts.legacy > 1 ||
          (counts.digital === 1 && counts.legacy === 1 && !uniqueJoin)));
    // Each payment keeps its own per-voucher key; a plan payment also names
    // its plan's purchase, built below from every payment of the plan.
    const emit = (
      members: Observation[],
      sourceKey: string,
      ambiguous: boolean,
      occurrenceCount: number,
    ) => {
      const binding = bindDetail(capture, members[0]!, ambiguous);
      const assessment = assessInstallment(
        members,
        binding !== null && "detail" in binding ? binding.detail : null,
        accountKey,
      );
      const line = extractGroup(
        members,
        capture,
        context,
        sourceKey,
        ambiguous,
        baseKey,
        occurrenceCount,
        binding,
        assessment,
        explainedWithdrawals.has(key),
      );
      if (assessment.witness !== null) {
        evidence(assessment.witness.purchaseKey).groups.push({
          observations: members,
          witness: assessment.witness,
          plan: assessment.plan,
          line,
        });
      }
      result.transactions.push(line);
      if (members[0]!.voucher) {
        const named = plansByVoucher.get(members[0]!.voucher) ?? [];
        named.push(assessment.witness?.purchaseKey ?? null);
        plansByVoucher.set(members[0]!.voucher, named);
      }
    };
    if (uniqueJoin || (observations.length === 1 && !ambiguousVoucher)) {
      emit(observations, `isracard:posted:${key}`, false, 1);
    } else {
      result.warnings.push("ambiguous_posted_identity");
      observations.forEach((observation, index) => {
        emit(
          [observation],
          `isracard:posted:${key}:occurrence:${index + 1}`,
          true,
          observations.length,
        );
      });
    }
  }
  // Observations of one payment voucher, on any purchase date, that disagree
  // about its plan, or about whether it has one, leave no plan they name with
  // a confident total.
  for (const named of plansByVoucher.values()) {
    if (new Set(named).size <= 1) {
      continue;
    }
    for (const purchaseKey of named) {
      if (purchaseKey !== null) {
        evidence(purchaseKey).conflictingVoucher = true;
      }
    }
  }
  for (const [purchaseKey, plan] of plans) {
    // Only a proven payment creates a purchase; other installments only
    // witness its facts.
    if (plan.groups.some((group) => group.plan !== null)) {
      result.transactions.push(
        extractPlanPurchase(purchaseKey, plan, capture, context),
      );
    }
  }
  const success =
    mismatchedVouchers.size === 0 &&
    digitalResult.success &&
    (!hasLegacyStatement(capture.card) || legacyResult.success);
  if (capture.responses.digital === undefined) {
    result.warnings.push("missing_required_digital_response");
  }
  if (
    hasLegacyStatement(capture.card) &&
    capture.responses.legacy === undefined
  ) {
    result.warnings.push("missing_required_legacy_response");
  }
  result.partitions.push({
    accountKey,
    status: "posted",
    success,
    comparable: false,
  });
  if (!success) {
    result.warnings.push("incomplete_posted_partition");
  }
  result.warnings = [...new Set(result.warnings)];
  return result;
}
