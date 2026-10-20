import { sumMinor } from "./money.js";
import {
  annotationStaleness,
  reviewState,
  type ReviewStatus,
  reviewStatus,
} from "./plans/annotation.js";
import type { Annotation, Transaction } from "./records.js";

/** Enriched internal read view. Public operations project an explicit wire contract. */
export interface TransactionView extends Transaction {
  reviewRequired: boolean;
  annotation: Annotation | null;
  reviewStale: boolean;
  reviewStatus: ReviewStatus;
  reviewReasons: string[];
  sourceIssues: string[];
  pendingPostingCandidates: string[];
}

export function presentTransaction(
  row: Transaction,
  annotation: Annotation | null,
): TransactionView {
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
 * Read perspectives. Membership depends only on a row's own facts,
 * never on whether children exist or on other request filters.
 * - spending: every row without a purchase link (purchases, single charges,
 *   standalone billed rows, fees, cancellations);
 * - billing: every row except an installment plan's purchase (two or more
 *   payments and no ordinal of its own), which counts through its lines;
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
 * SQL. `billing` is the null-safe form of NOT (count >= 2 AND number IS NULL):
 * a row with both facts null is a member.
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
): boolean {
  const rule = perspectiveRule(perspective);
  switch (rule.kind) {
    case "every_row":
      return true;
    case "without_purchase":
      return row.purchaseId === null;
    case "without_plan_purchase":
      return (
        row.installmentCount === null ||
        row.installmentCount < rule.minimumPayments ||
        row.installmentNumber !== null
      );
  }
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
>;

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

/**
 * Exact totals over one perspective's selected rows. `spending` groups by
 * currency and amount basis; `billing` has one group per currency. Groups
 * are never added together. FX fees follow the same eligibility.
 */
export function calculateTotals(
  rows: readonly TotalRow[],
  perspective: Exclude<Perspective, "all"> = "spending",
) {
  const groups = new Map<
    string,
    { currency: string; amountBasis: string | null; amounts: number[] }
  >();
  const fxFees = new Map<string, number[]>();
  let fxFeeUnknownCount = 0;
  const excluded = {
    pending: 0,
    authorization: 0,
    transferOrIncome: 0,
    retiredOrRemoved: 0,
    unresolved: 0,
  };
  let includedCount = 0;
  for (const row of rows) {
    if (row.supersededById || row.presence === "removed") {
      excluded.retiredOrRemoved++;
      continue;
    }
    if (row.status === "pending") {
      excluded.pending++;
      continue;
    }
    if (row.kind === "transfer" || row.kind === "income") {
      excluded.transferOrIncome++;
      continue;
    }
    if (row.amountBasis === "authorization") {
      excluded.authorization++;
      continue;
    }
    if (
      row.amountMinor === null ||
      row.currency === null ||
      (row.amountBasis !== "booked_entry" &&
        row.amountBasis !== "purchase_commitment") ||
      row.kind === "unknown" ||
      row.identityStrength === "ambiguous"
    ) {
      excluded.unresolved++;
      continue;
    }
    const amountBasis = perspective === "billing" ? null : row.amountBasis;
    const key = `${amountBasis ?? ""}:${row.currency}`;
    const group = groups.get(key) ?? {
      currency: row.currency,
      amountBasis,
      amounts: [],
    };
    group.amounts.push(row.amountMinor);
    groups.set(key, group);
    includedCount++;
    if (row.fxFeeMinor !== null && row.fxFeeCurrency !== null) {
      const fees = fxFees.get(row.fxFeeCurrency) ?? [];
      fees.push(row.fxFeeMinor);
      fxFees.set(row.fxFeeCurrency, fees);
    } else if (converted(row)) {
      // An unpublished fee is unknown, never zero.
      fxFeeUnknownCount++;
    }
  }
  const order = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;
  return {
    totals: [...groups.values()]
      .map(({ amounts, ...group }) => ({
        ...group,
        amountMinor: sumMinor(amounts),
      }))
      .sort((left, right) =>
        order(
          `${left.amountBasis ?? ""}:${left.currency}`,
          `${right.amountBasis ?? ""}:${right.currency}`,
        ),
      ),
    fxFees: [...fxFees]
      .map(([currency, amounts]) => ({
        currency,
        amountMinor: sumMinor(amounts),
      }))
      .sort((left, right) => order(left.currency, right.currency)),
    fxFeeUnknownCount,
    includedCount,
    excludedCount: Object.values(excluded).reduce(
      (sum, count) => sum + count,
      0,
    ),
    excluded,
  };
}
