import { isBilledLine, type TransactionFacts } from "../model.js";
import { sortedEvidence } from "../provider-evidence.js";
import { billedLinesByPurchase, inPerspective } from "../read-model.js";
import type { Transaction } from "../records.js";
import { FinancialPlan, type LedgerRow } from "./state.js";

/**
 * A billed line held because another identity states its purchase's ordinal:
 * the two could bill one payment twice, so neither amount counts.
 */
export const DUPLICATE_ORDINAL = "duplicate_installment_ordinal";
export const INSTALLMENT_CONFLICT = "conflicting_installment_plan";
export const RESTATEMENT_CONFLICT = "conflicting_installment_restatement";
export const LINE_CONFLICT = "conflicting_installment_lines";
const UNKNOWN_COUNT = "unknown_installment_count";
const PLAN_CONFLICTS = [
  INSTALLMENT_CONFLICT,
  RESTATEMENT_CONFLICT,
  LINE_CONFLICT,
];

/**
 * Installment-derived rows (plan purchases and billed lines) carry no FX
 * facts, whatever an adapter or a restatement supplies.
 */
export function withoutInstallmentFx(row: TransactionFacts): TransactionFacts {
  if (!isBilledLine(row) && inPerspective(row, "billing", false)) {
    return row;
  }
  const { currencyExchange: _dropped, ...details } = row.details;
  return { ...row, fxFeeMinor: null, fxFeeCurrency: null, details };
}

/**
 * A source restatement awaiting source resolution. A plan conflict without a
 * restatement or line code is one too, unless its capture stated no count,
 * which never contradicts a plan.
 */
export function awaitsRestatement(row: {
  details: Pick<Transaction["details"], "issues">;
}): boolean {
  const { issues } = row.details;
  return (
    issues.includes(RESTATEMENT_CONFLICT) ||
    (issues.includes(INSTALLMENT_CONFLICT) &&
      !issues.includes(LINE_CONFLICT) &&
      !issues.includes(UNKNOWN_COUNT))
  );
}

/**
 * Whether a plan purchase's live lines contradict it: they or the purchase
 * state different counts, or an ordinal lies outside a stated count.
 */
function linesConflict(parent: LedgerRow, lines: LedgerRow[]): boolean {
  const counts = new Set(
    [parent, ...lines].flatMap((row) =>
      row.installmentCount === null ? [] : [row.installmentCount],
    ),
  );
  return (
    counts.size > 1 ||
    lines.some(
      ({ installmentNumber: ordinal }) =>
        ordinal !== null &&
        [...counts].some((count) => ordinal < 1 || ordinal > count),
    )
  );
}

/** A purchase's plan conflicts, reevaluated against its live lines. */
function conflictIssues(
  parent: LedgerRow,
  lines: LedgerRow[],
  restated: boolean,
): string[] {
  // Only a plan purchase's lines can contradict it; other parents keep just
  // their restatement conflicts.
  const conflicting =
    parent.amountBasis === "purchase_commitment" &&
    parent.kind === "purchase" &&
    parent.identityStrength !== "ambiguous" &&
    linesConflict(parent, lines);
  const issues = parent.details.issues.filter(
    (issue) => !PLAN_CONFLICTS.includes(issue),
  );
  if (conflicting) {
    issues.push(LINE_CONFLICT);
  }
  if (restated) {
    issues.push(RESTATEMENT_CONFLICT);
  }
  if (conflicting || restated) {
    issues.push(INSTALLMENT_CONFLICT);
  }
  return sortedEvidence(issues);
}

/**
 * Line conflicts follow the live lines, including for purchases the source no
 * longer returns. Only review issues change: facts that identify a purchase
 * stay as its captures state them. Only `parents`, when given, are refreshed.
 * Returns each row it changed, as it was before.
 */
export function refreshInstallmentParents(
  plan: FinancialPlan,
  parents?: ReadonlySet<string>,
): Transaction[] {
  const children = billedLinesByPurchase(plan.rows.values());
  // Removing the final line resolves a line conflict without another
  // observation of the purchase; keep that purchase in the refresh set.
  for (const row of plan.rows.values()) {
    if (
      !children.has(row.id) &&
      row.details.issues.some((issue) => PLAN_CONFLICTS.includes(issue))
    ) {
      children.set(row.id, []);
    }
  }
  const changed: Transaction[] = [];
  for (const [id, lines] of children) {
    const parent = plan.transaction(id);
    if (
      !parent ||
      (parents && !parents.has(id)) ||
      parent.presence === "removed" ||
      parent.supersededById ||
      parent.purchaseId !== null
    ) {
      continue;
    }
    const issues = conflictIssues(parent, lines, awaitsRestatement(parent));
    if (
      JSON.stringify(issues) !==
      JSON.stringify(sortedEvidence(parent.details.issues))
    ) {
      const full = plan.full(parent);
      changed.push(full);
      plan.updateTransaction(id, { details: { ...full.details, issues } });
    }
  }
  return changed;
}
