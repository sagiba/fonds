import { isLosslessNumber } from "lossless-json";

import type { CurrencyExchange, TransactionInput } from "../../domain/model.js";
import { decimalToMinor } from "../../domain/money.js";

type SourceRow = Record<string, unknown>;

/**
 * CAL comment templates (`comments[].key`), matched exactly and anchored.
 * Unknown templates fall through to `additionalInformation`.
 */
const CONTACTLESS = "עסקה שבוצעה באמצעות Contact less";
const SECURE_PURCHASE =
  "עסקה זו בוצעה באינטרנט ואושרה על ידך באמצעות שירות קניה בטוחה";
const ILS_CONVERSION =
  /^בתאריך (\d{2}\/\d{2}\/\d{4}) בוצעה המרה ל-₪ בשער יציג (\d+\.\d{2,4})$/;
// The double space before "הבינלאומית" is part of the issuer's template.
const USD_CONVERSION =
  /^בתאריך (\d{2}\/\d{2}\/\d{4}) העסקה הומרה ל- (-?\d+(?:\.\d{1,2})?)\$ בשער (\d+\.\d{5,6})\. ההמרה ל- \$ בוצעה לפי שער חליפין מכירה של {2}הבינלאומית\.$/;
const FX_FEE = 'עמלת עסקת מט"ח';
const FX_FEE_DISCOUNT_MARKER = 'עסקה עם הנחה בעמלת מט"ח';
const FX_FEE_DISCOUNT = 'סכום הנחה בעמלת עסקאות מט"ח';
const AMOUNT = /^-?\d+(?:\.\d{1,2})?$/;

type ParsedComment =
  | { template: "contactless" }
  | { template: "secure_purchase" }
  | { template: "fx_fee_discount_marker" }
  | {
      template: "ils_conversion";
      quotationDate: string | null;
      exchangeRate: string;
    }
  | {
      template: "usd_conversion";
      quotationDate: string | null;
      usdAmount: string;
      exchangeRate: string;
    }
  | { template: "fx_fee"; amount: string }
  | { template: "fx_fee_discount"; amount: string };

/**
 * One `comments[]` entry, parsed once. Payment context and FX mark it
 * `published` when a typed field states its fact; the rest stays as text.
 */
export interface CalComment {
  parsed: ParsedComment | null;
  /** The entry as `additionalInformation` states it: key and nonempty value. */
  text: string;
  published: boolean;
}

function object(value: unknown): value is SourceRow {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isLosslessNumber(value)
  );
}

function token(value: unknown): string | null {
  const lexical = isLosslessNumber(value)
    ? value.value
    : typeof value === "string"
      ? value
      : null;
  return lexical === null || lexical.length === 0 ? null : lexical;
}

function emptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Israeli day-first order; an impossible date is unknown, not an error. */
function quotationDate(value: string): string | null {
  const [day, month, year] = value.split("/");
  const iso = `${year}-${month}-${day}`;
  return year !== "0000" &&
    Number.isFinite(Date.parse(`${iso}T00:00:00Z`)) &&
    new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso
    ? iso
    : null;
}

function parseComment(comment: SourceRow): ParsedComment | null {
  const { key, value } = comment;
  if (typeof key !== "string") {
    return null;
  }
  if (emptyValue(value)) {
    if (key === CONTACTLESS) {
      return { template: "contactless" };
    }
    if (key === SECURE_PURCHASE) {
      return { template: "secure_purchase" };
    }
    if (key === FX_FEE_DISCOUNT_MARKER) {
      return { template: "fx_fee_discount_marker" };
    }
    const ils = ILS_CONVERSION.exec(key);
    if (ils) {
      return {
        template: "ils_conversion",
        quotationDate: quotationDate(ils[1]!),
        exchangeRate: ils[2]!,
      };
    }
    const usd = USD_CONVERSION.exec(key);
    if (usd) {
      return {
        template: "usd_conversion",
        quotationDate: quotationDate(usd[1]!),
        usdAmount: usd[2]!,
        exchangeRate: usd[3]!,
      };
    }
    return null;
  }
  const amount = typeof value === "string" ? value : null;
  if (amount === null || !AMOUNT.test(amount)) {
    return null;
  }
  if (key === FX_FEE) {
    return { template: "fx_fee", amount };
  }
  if (key === FX_FEE_DISCOUNT) {
    return { template: "fx_fee_discount", amount };
  }
  return null;
}

/** The row's `comments[]` objects, in source order; other shapes stay raw only. */
export function calComments(row: SourceRow): CalComment[] {
  if (!Array.isArray(row.comments)) {
    return [];
  }
  return row.comments.filter(object).map((comment) => ({
    parsed: parseComment(comment),
    text: (["key", "value"] as const)
      .flatMap((slot) => {
        const value = comment[slot];
        return typeof value === "string" && value.trim().length > 0
          ? [value]
          : [];
      })
      .join(": "),
    published: false,
  }));
}

type TemplateComment<Template extends ParsedComment["template"]> =
  CalComment & { parsed: Extract<ParsedComment, { template: Template }> };

function ofTemplate<Template extends ParsedComment["template"]>(
  comments: CalComment[],
  template: Template,
): TemplateComment<Template>[] {
  return comments.filter(
    (comment): comment is TemplateComment<Template> =>
      comment.parsed?.template === template,
  );
}

function publish(comments: CalComment[]): void {
  comments.forEach((comment) => {
    comment.published = true;
  });
}

export type CalPaymentContext = Pick<
  TransactionInput,
  | "cardPresent"
  | "authorizationMethod"
  | "wallet"
  | "threeDSecureUsed"
  | "recurring"
>;

/** A value is evidence, `null` is conflicting evidence, `undefined` is no evidence. */
type PaymentEvidence = {
  [Field in keyof CalPaymentContext]-?: CalPaymentContext[Field];
};

interface RowPaymentContext {
  payment: PaymentEvidence;
  issues: string[];
  /** Comments whose fact a typed field states; published unless the group conflicts. */
  evidence: CalComment[];
}

/** Payment context for one source row; conflicts stay null with an issue. */
function rowPaymentContext(
  row: SourceRow,
  comments: CalComment[],
  status: "posted" | "pending",
): RowPaymentContext {
  const contactlessComments = ofTemplate(comments, "contactless");
  const secureComments = ofTemplate(comments, "secure_purchase");
  const way = token(row.trnExacWay);
  const typeCode = token(
    status === "posted" ? row.transactionTypeCode : row.trnTypeCode,
  );
  const walletCode = token(row.walletProviderCode);
  const walletDescription = row.walletProviderDesc;
  const issues: string[] = [];
  const evidence: CalComment[] = [];

  const contactless = way === "21" || contactlessComments.length > 0;
  const online =
    way === "12" ||
    way === "15" ||
    way === "35" ||
    // Wallet code 32 (internet) alone evidences an online authorization.
    walletCode === "32";
  let authorizationMethod: CalPaymentContext["authorizationMethod"];
  if (
    (contactlessComments.length > 0 && way !== null && way !== "21") ||
    (contactless && online)
  ) {
    authorizationMethod = null;
    issues.push("conflicting_payment_context");
  } else if (contactless) {
    authorizationMethod = "contactless";
    evidence.push(...contactlessComments);
  } else if (online) {
    authorizationMethod = "online";
  }

  const secureWay = way === "15" || way === "35";
  let threeDSecureUsed: true | null | undefined;
  if (secureComments.length > 0 && way !== null && !secureWay) {
    threeDSecureUsed = null;
    issues.push("conflicting_payment_context");
  } else if (secureComments.length > 0 || secureWay) {
    threeDSecureUsed = true;
    evidence.push(...secureComments);
  }

  return {
    payment: {
      cardPresent:
        typeof row.transCardPresentInd === "boolean"
          ? row.transCardPresentInd
          : undefined,
      authorizationMethod,
      // Only the reviewed code/label pair establishes a wallet.
      wallet:
        walletCode === "3" && walletDescription === "Apple Pay"
          ? "apple_pay"
          : undefined,
      threeDSecureUsed,
      // A standing order is evidenced by its execution method or its type.
      recurring: way === "9" || typeCode === "9" ? true : undefined,
    },
    issues: [...new Set(issues)],
    evidence,
  };
}

/**
 * One group's payment context. Rows without evidence for a fact do not vote;
 * rows that disagree, or a row's own conflict, make the fact a conflict (null).
 * Evidence comments are published only when no fact conflicts.
 */
export function calPaymentContext(
  rows: SourceRow[],
  comments: CalComment[][],
  status: "posted" | "pending",
  issues: string[],
): PaymentEvidence {
  const results = rows.map((row, index) =>
    rowPaymentContext(row, comments[index]!, status),
  );
  const payment = {} as Record<string, unknown>;
  let conflicted = false;
  for (const field of Object.keys(
    results[0]!.payment,
  ) as (keyof PaymentEvidence)[]) {
    const values = results
      .map((result) => result.payment[field])
      .filter((value) => value !== undefined);
    if (values.length === 0) {
      payment[field] = undefined;
    } else if (values.every((value) => value === values[0])) {
      payment[field] = values[0];
    } else {
      payment[field] = null;
      conflicted = true;
      issues.push("conflicting_payment_context");
    }
  }
  for (const result of results) {
    issues.push(...result.issues);
    if (!conflicted) {
      publish(result.evidence);
    }
  }
  return payment as PaymentEvidence;
}

/** Issuer type code as supplied: posted `transactionTypeCode`, pending `trnTypeCode`. */
export function calProviderTransactionCode(
  row: SourceRow,
  status: "posted" | "pending",
): string | null {
  return token(status === "posted" ? row.transactionTypeCode : row.trnTypeCode);
}

type Decimal = { units: bigint; scale: number };

/**
 * Exact magnitude of a plain decimal token, with trailing fraction zeros
 * removed so `200.3600` and `200.36` are the same value at the same scale.
 */
function decimal(text: string): Decimal {
  const unsigned = text.replace(/^-/, "");
  const [whole, rawFraction = ""] = unsigned.split(".");
  const fraction = rawFraction.replace(/0+$/, "");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

/** The value at a scale no smaller than its own; exact. */
function rescale(value: Decimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

/** round2(base × rate + fee − discount), rounding half up; exact. */
function reconciliationTarget(
  base: string,
  rate: string,
  fee: string,
  discount: string,
): Decimal {
  const baseValue = decimal(base);
  const rateValue = decimal(rate);
  const feeValue = decimal(fee);
  const discountValue = decimal(discount);
  const product: Decimal = {
    units: baseValue.units * rateValue.units,
    scale: baseValue.scale + rateValue.scale,
  };
  const scale = Math.max(product.scale, feeValue.scale, discountValue.scale, 2);
  const exact =
    rescale(product, scale) +
    rescale(feeValue, scale) -
    rescale(discountValue, scale);
  const divisor = 10n ** BigInt(scale - 2);
  const magnitude = exact < 0n ? -exact : exact;
  const rounded = (magnitude + divisor / 2n) / divisor;
  return { units: exact < 0n ? -rounded : rounded, scale: 2 };
}

/** Whether two values differ by at most one minor unit (0.01). */
function withinOneMinorUnit(left: Decimal, right: Decimal): boolean {
  const scale = Math.max(left.scale, right.scale, 2);
  const difference = rescale(left, scale) - rescale(right, scale);
  const tolerance = 10n ** BigInt(scale - 2);
  return (difference < 0n ? -difference : difference) <= tolerance;
}

export interface CalForeignExchange {
  currencyExchange: CurrencyExchange[] | null;
  fxFeeMinor: number | null;
  fxFeeCurrency: string | null;
  issues: string[];
}

/**
 * FX facts for one posted source row; it marks the comments whose facts it
 * publishes. `billedAmount` is the row's billed money as the source states it
 * (`amountForDisplay`, or a billed line's own amount); `amountMinor` is the
 * row's signed canonical amount, which sets the fee's direction.
 */
export function calForeignExchange(
  row: SourceRow,
  comments: CalComment[],
  {
    originalCurrency,
    billingCurrency,
    billedAmount,
    amountMinor,
  }: {
    originalCurrency: string | null;
    billingCurrency: string | null;
    billedAmount: unknown;
    amountMinor: number | null;
  },
): CalForeignExchange {
  const result: CalForeignExchange = {
    currencyExchange: null,
    fxFeeMinor: null,
    fxFeeCurrency: null,
    issues: [],
  };
  const usdComments = ofTemplate(comments, "usd_conversion");
  const ilsComments = ofTemplate(comments, "ils_conversion");
  const feeComments = ofTemplate(comments, "fx_fee");
  const discountComments = ofTemplate(comments, "fx_fee_discount");
  if (
    [usdComments, ilsComments, feeComments, discountComments].some(
      (items) => new Set(items.map((item) => item.text)).size > 1,
    )
  ) {
    result.issues.push("conflicting_fx_comments");
    return result;
  }
  const usd = usdComments[0]?.parsed;
  const ils = ilsComments[0]?.parsed;
  // An unresolved original currency produces no conversion; its own issue applies.
  if ((!usd && !ils) || originalCurrency === null) {
    return result;
  }
  const steps: CurrencyExchange[] = [];
  if (usd) {
    steps.push({
      sourceCurrency: originalCurrency,
      targetCurrency: "USD",
      unitCurrency: originalCurrency,
      exchangeRate: usd.exchangeRate,
      quotationDate: usd.quotationDate,
    });
  }
  if (ils) {
    const source = usd ? "USD" : originalCurrency;
    steps.push({
      sourceCurrency: source,
      targetCurrency: "ILS",
      unitCurrency: source,
      exchangeRate: ils.exchangeRate,
      quotationDate: ils.quotationDate,
    });
  }
  result.currencyExchange = steps;
  publish([...usdComments, ...ilsComments]);
  // The fee is Fonds-defined for the ILS step only; USD-billed rows carry none.
  if (!ils || billingCurrency !== "ILS" || amountMinor === null) {
    return result;
  }
  const base = usd ? usd.usdAmount : token(row.trnAmt);
  const billed = token(billedAmount);
  const fee = feeComments[0]?.parsed.amount ?? "0";
  const discount = discountComments[0]?.parsed.amount ?? "0";
  const plain = /^-?\d+(?:\.\d+)?$/;
  let net: number | null = null;
  try {
    net =
      decimalToMinor(fee.replace(/^-/, ""), "ILS") -
      decimalToMinor(discount.replace(/^-/, ""), "ILS");
  } catch {
    net = null;
  }
  if (
    base === null ||
    billed === null ||
    !plain.test(base) ||
    !plain.test(billed) ||
    net === null
  ) {
    result.issues.push("fx_unreconciled");
    return result;
  }
  const target = reconciliationTarget(base, ils.exchangeRate, fee, discount);
  if (!withinOneMinorUnit(target, decimal(billed))) {
    result.issues.push("fx_unreconciled");
    return result;
  }
  // Net fee in the billing currency, with the row's direction (outflow negative).
  result.fxFeeMinor = net === 0 ? 0 : amountMinor < 0 ? -net : net;
  result.fxFeeCurrency = "ILS";
  publish([
    ...feeComments,
    ...discountComments,
    ...ofTemplate(comments, "fx_fee_discount_marker"),
  ]);
  return result;
}
