import { toBigMinor, toSafeMinor } from "./money.js";
import { compareStrings } from "./observations.js";
import {
  annotationStaleness,
  reviewState,
  type ReviewStatus,
  reviewStatus,
} from "./plans/annotation.js";
import type { Annotation, Transaction } from "./records.js";

interface ReviewView {
  reviewRequired: boolean;
  annotation: Annotation | null;
  reviewStale: boolean;
  reviewStatus: ReviewStatus;
  reviewReasons: string[];
  sourceIssues: string[];
  pendingPostingCandidates: string[];
}

/** Enriched internal read view. Public operations project an explicit wire contract. */
export interface TransactionView extends Transaction, ReviewView {}

/**
 * The transaction facts a list item presents. Source identity, observation
 * history, retained evidence and detail-only prose are not among them.
 */
export const LIST_FACT_FIELDS = [
  "id",
  "connectionId",
  "cardId",
  "status",
  "presence",
  "sourceAbsence",
  "kind",
  "amountBasis",
  "amountMinor",
  "currency",
  "originalAmountMinor",
  "originalCurrency",
  "description",
  "counterpartyName",
  "merchantName",
  "merchantProviderId",
  "merchantCategoryCode",
  "transactionDate",
  "bookingDate",
  "billingDate",
  "cardPresent",
  "authorizationMethod",
  "wallet",
  "threeDSecureUsed",
  "recurring",
  "fxFeeMinor",
  "fxFeeCurrency",
  "providerTransactionCode",
  "installmentCount",
  "installmentNumber",
  "purchaseId",
  "supersededById",
  "version",
] as const satisfies readonly (keyof Transaction)[];

/** A list item's facts; a full transaction also satisfies this shape. */
export type TransactionListFacts = Pick<
  Transaction,
  (typeof LIST_FACT_FIELDS)[number]
> & {
  details: Pick<
    Transaction["details"],
    | "transactionDateTime"
    | "merchant"
    | "currencyExchange"
    | "issues"
    | "pendingPostingCandidates"
  >;
};

export type TransactionListView = TransactionListFacts & ReviewView;

export function presentTransaction<Row extends TransactionListFacts>(
  row: Row,
  annotation: Annotation | null,
): Row & ReviewView {
  const stale = annotationStaleness(row, annotation?.data);
  const review = reviewState(row, annotation?.data);
  return {
    ...row,
    annotation,
    reviewRequired: review.required,
    reviewStale: stale.reviewStale,
    reviewStatus: reviewStatus(row, annotation?.data),
    reviewReasons: review.reasons,
    sourceIssues: [...new Set(row.details.issues)].sort(),
    pendingPostingCandidates: [
      ...new Set(row.details.pendingPostingCandidates ?? []),
    ].sort(),
  };
}

/**
 * Read perspectives. Live child associations are evaluated independently
 * of other request filters.
 * - spending: every row without a purchase link (purchases, single charges,
 *   standalone billed rows, fees, cancellations);
 * - billing: every row except an installment plan's purchase (two or more
 *   payments and no ordinal of its own, or live linked billed lines);
 * - all: every row; never totalled, because it would double-count.
 */
export const PERSPECTIVES = ["spending", "billing", "all"] as const;

export type Perspective = (typeof PERSPECTIVES)[number];

/** Payments from which a purchase counts through its billed lines. */
export const PLAN_MINIMUM_PAYMENTS = 2;

type MembershipFacts = Pick<
  Transaction,
  "purchaseId" | "installmentCount" | "installmentNumber"
>;

/**
 * The membership rule as data, so storage compiles the same predicate into
 * SQL. A plan purchase is one with live billed lines or a multi-payment count,
 * so lines exclude their purchase even when its plan metadata is unknown.
 */
export type PerspectiveRule =
  | { kind: "every_row" }
  | { kind: "without_purchase" }
  | { kind: "without_plan_purchase"; minimumPayments: number };

export function perspectiveRule(perspective: Perspective): PerspectiveRule {
  switch (perspective) {
    case "spending":
      return { kind: "without_purchase" };
    case "billing":
      return {
        kind: "without_plan_purchase",
        minimumPayments: PLAN_MINIMUM_PAYMENTS,
      };
    case "all":
      return { kind: "every_row" };
  }
}

export function inPerspective(
  row: MembershipFacts,
  perspective: Perspective,
  hasBilledLines: boolean,
): boolean {
  const rule = perspectiveRule(perspective);
  switch (rule.kind) {
    case "every_row":
      return true;
    case "without_purchase":
      return row.purchaseId === null;
    case "without_plan_purchase":
      return (
        !hasBilledLines &&
        (row.installmentCount === null ||
          row.installmentCount < rule.minimumPayments ||
          row.installmentNumber !== null)
      );
  }
}

/** The association survives absence, but not removal or retirement. */
export function isLiveBilledLine(
  row: Pick<Transaction, "purchaseId" | "presence" | "supersededById">,
): boolean {
  return (
    row.purchaseId !== null && row.presence !== "removed" && !row.supersededById
  );
}

export function billedLinesByPurchase(
  rows: Iterable<Transaction>,
): Map<string, Transaction[]> {
  return Map.groupBy(
    [...rows].filter(isLiveBilledLine),
    (row) => row.purchaseId!,
  );
}

export type TotalRow = Pick<
  Transaction,
  | "supersededById"
  | "presence"
  | "status"
  | "kind"
  | "amountMinor"
  | "currency"
  | "amountBasis"
  | "identityStrength"
  | "originalCurrency"
  | "fxFeeMinor"
  | "fxFeeCurrency"
> & { sourceAbsence?: Transaction["sourceAbsence"] | null };

/**
 * A converted row bills in a currency other than its original money. Storage
 * holds no other conversion evidence in columns, so a billed line of a
 * converted plan (no original money) is not counted as converted.
 */
function converted(row: TotalRow): boolean {
  return (
    row.originalCurrency !== null &&
    row.currency !== null &&
    row.originalCurrency !== row.currency
  );
}

/** Where a selected row lands in totals: one exclusion bucket, or included. */
export const TOTALS_BUCKETS = [
  "retiredOrRemoved",
  "sourceAbsent",
  "pending",
  "transferOrIncome",
  "authorization",
  "unresolved",
  "included",
] as const;

export type TotalsBucket = (typeof TOTALS_BUCKETS)[number];

/**
 * The first applicable bucket, in `TOTALS_BUCKETS` order. Storage compiles the
 * same precedence into SQL (`totalsBucket` in storage/sql.ts).
 */
export function totalsBucket(row: TotalRow): TotalsBucket {
  if (row.supersededById || row.presence === "removed") {
    return "retiredOrRemoved";
  }
  if (row.sourceAbsence != null) {
    return "sourceAbsent";
  }
  if (row.status === "pending") {
    return "pending";
  }
  if (row.kind === "transfer" || row.kind === "income") {
    return "transferOrIncome";
  }
  if (row.amountBasis === "authorization") {
    return "authorization";
  }
  if (
    row.amountMinor === null ||
    row.currency === null ||
    (row.amountBasis !== "booked_entry" &&
      row.amountBasis !== "purchase_commitment") ||
    row.kind === "unknown" ||
    row.identityStrength === "ambiguous"
  ) {
    return "unresolved";
  }
  return "included";
}

/**
 * Partial totals of rows sharing a bucket and, for included rows, a money
 * group and FX fee currency. Sums are exact integers of any size.
 */
export interface TotalsPart {
  bucket: TotalsBucket;
  /** Null unless included. */
  currency: string | null;
  /** Null unless included in `spending`. */
  amountBasis: Transaction["amountBasis"] | null;
  /** The published fee currency of included rows, otherwise null. */
  fxFeeCurrency: string | null;
  count: number;
  amountMinor: bigint;
  fxFeeMinor: bigint;
  fxFeeUnknownCount: number;
}

/** Totals from partial sums; the same result `calculateTotals` gives the rows. */
export function totalsFromParts(parts: readonly TotalsPart[]) {
  const groups = new Map<
    string,
    {
      currency: string;
      amountBasis: Transaction["amountBasis"] | null;
      amountMinor: bigint;
    }
  >();
  const fxFees = new Map<string, bigint>();
  let fxFeeUnknownCount = 0;
  const excluded = {
    pending: 0,
    authorization: 0,
    transferOrIncome: 0,
    retiredOrRemoved: 0,
    sourceAbsent: 0,
    unresolved: 0,
  };
  let includedCount = 0;
  for (const part of parts) {
    if (part.bucket !== "included") {
      excluded[part.bucket] += part.count;
      continue;
    }
    includedCount += part.count;
    const key = `${part.amountBasis ?? ""}:${part.currency}`;
    const group = groups.get(key) ?? {
      currency: part.currency!,
      amountBasis: part.amountBasis,
      amountMinor: 0n,
    };
    group.amountMinor += part.amountMinor;
    groups.set(key, group);
    if (part.fxFeeCurrency !== null) {
      fxFees.set(
        part.fxFeeCurrency,
        (fxFees.get(part.fxFeeCurrency) ?? 0n) + part.fxFeeMinor,
      );
    }
    fxFeeUnknownCount += part.fxFeeUnknownCount;
  }
  return {
    totals: [...groups.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([, group]) => ({
        currency: group.currency,
        amountBasis: group.amountBasis,
        amountMinor: toSafeMinor(group.amountMinor),
      })),
    fxFees: [...fxFees]
      .map(([currency, total]) => ({
        currency,
        amountMinor: toSafeMinor(total),
      }))
      .sort((left, right) => compareStrings(left.currency, right.currency)),
    fxFeeUnknownCount,
    includedCount,
    excludedCount: Object.values(excluded).reduce(
      (sum, count) => sum + count,
      0,
    ),
    excluded,
  };
}

/**
 * Exact totals over one perspective's selected rows. `spending` groups by
 * currency and amount basis; `billing` has one group per currency. Groups
 * are never added together. FX fees follow the same eligibility.
 */
export function calculateTotals(
  rows: readonly TotalRow[],
  perspective: Exclude<Perspective, "all"> = "spending",
) {
  return totalsFromParts(
    rows.map((row) => {
      const bucket = totalsBucket(row);
      const included = bucket === "included";
      const published =
        included && row.fxFeeMinor !== null && row.fxFeeCurrency !== null;
      return {
        bucket,
        currency: included ? row.currency : null,
        amountBasis:
          included && perspective === "spending" ? row.amountBasis : null,
        fxFeeCurrency: published ? row.fxFeeCurrency : null,
        count: 1,
        amountMinor: included ? toBigMinor(row.amountMinor!) : 0n,
        fxFeeMinor: published ? toBigMinor(row.fxFeeMinor!) : 0n,
        // An unpublished fee is unknown, never zero.
        fxFeeUnknownCount: included && !published && converted(row) ? 1 : 0,
      };
    }),
  );
}
