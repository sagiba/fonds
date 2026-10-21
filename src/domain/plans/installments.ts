import { isBilledLine, type TransactionFacts } from "../model.js";
import { canonicalJson } from "../observations.js";
import { sortedEvidence } from "../provider-evidence.js";
import { billedLinesByPurchase, inPerspective } from "../read-model.js";
import type { Transaction } from "../records.js";
import { FinancialPlan } from "./state.js";

/**
 * A billed line held because another identity states its purchase's ordinal:
 * the two could bill one payment twice, so neither amount counts.
 */
export const DUPLICATE_ORDINAL = "duplicate_installment_ordinal";
export const INSTALLMENT_CONFLICT = "conflicting_installment_plan";
export const RESTATEMENT_CONFLICT = "conflicting_installment_restatement";
export const LINE_CONFLICT = "conflicting_installment_lines";
const UNKNOWN_COUNT = "unknown_installment_count";
const UNREPAIRABLE_LINE_ISSUES = [
  "conflicting_installment_facts",
  "invalid_installment_ordinal",
  DUPLICATE_ORDINAL,
];

/**
 * Installment-derived rows (plan purchases and billed lines) carry no FX
 * facts, whatever an adapter or a restatement supplies.
 */
export function withoutInstallmentFx(
  row: TransactionFacts,
  hasBilledLines: boolean,
): TransactionFacts {
  if (!isBilledLine(row) && inPerspective(row, "billing", hasBilledLines)) {
    return row;
  }
  const { currencyExchange: _dropped, ...details } = row.details;
  return { ...row, fxFeeMinor: null, fxFeeCurrency: null, details };
}

/**
 * A source restatement awaiting source resolution. Until the purchase is
 * captured again, a conflict stored before provenance was recorded is one when
 * the purchase still states a count.
 */
function awaitsRestatement(
  row: Pick<Transaction, "installmentCount" | "details">,
): boolean {
  const { issues } = row.details;
  return (
    issues.includes(RESTATEMENT_CONFLICT) ||
    (row.installmentCount !== null &&
      issues.includes(INSTALLMENT_CONFLICT) &&
      !issues.includes(LINE_CONFLICT))
  );
}

/** The repairable plan size the lines state, and whether they contradict it. */
function lineEvidence(
  parent: Transaction,
  lines: Transaction[],
  sourceCount: number | null,
) {
  let stated: number | null = null;
  let complete = true;
  let conflicting = false;
  const ordinals = new Set<number>();
  for (const line of lines) {
    const count = line.installmentCount;
    const ordinal = line.installmentNumber;
    if (count !== null) {
      conflicting ||=
        (stated !== null && stated !== count) ||
        (sourceCount !== null && sourceCount !== count) ||
        (ordinal !== null && (ordinal < 1 || ordinal > count));
      stated ??= count;
    }
    complete &&=
      count !== null &&
      count >= 2 &&
      ordinal !== null &&
      ordinal >= 1 &&
      ordinal <= count &&
      !ordinals.has(ordinal) &&
      line.sourceScope === parent.sourceScope &&
      line.identityStrength !== "ambiguous" &&
      !line.details.issues.some((issue) =>
        UNREPAIRABLE_LINE_ISSUES.includes(issue),
      );
    if (ordinal !== null) {
      ordinals.add(ordinal);
    }
  }
  return { count: complete ? stated : null, conflicting };
}

/** A plan purchase's count, date and conflicts, reevaluated against its live lines. */
function withLineEvidence(
  parent: Transaction,
  lines: Transaction[],
  restated: boolean,
  countUnstated: boolean,
): Transaction {
  // A count the latest capture left unstated was filled from lines, so newer
  // unanimous lines may replace it; a stated count is evidence to check them against.
  const sourceCount = countUnstated ? null : parent.installmentCount;
  const evidence = lineEvidence(parent, lines, sourceCount);
  const count =
    evidence.count !== null &&
    !evidence.conflicting &&
    !restated &&
    !parent.details.issues.includes("conflicting_installment_facts")
      ? (sourceCount ?? evidence.count)
      : parent.installmentCount;
  const issues = parent.details.issues.filter(
    (issue) =>
      ![INSTALLMENT_CONFLICT, RESTATEMENT_CONFLICT, LINE_CONFLICT].includes(
        issue,
      ) &&
      (count === null || issue !== UNKNOWN_COUNT),
  );
  if (evidence.conflicting) {
    issues.push(LINE_CONFLICT);
  }
  if (restated) {
    issues.push(RESTATEMENT_CONFLICT);
  }
  if (evidence.conflicting || restated) {
    issues.push(INSTALLMENT_CONFLICT);
  }
  return {
    ...parent,
    installmentCount: count,
    // An unknown plan's observed date stays evidence until a plan is established.
    billingDate: count !== null && count >= 2 ? null : parent.billingDate,
    details: { ...parent.details, issues: sortedEvidence(issues) },
  };
}

/**
 * Billed lines can fill unknown plan metadata without replacing newer purchase
 * money. Their explicit counts, not the number or sum of observed payments,
 * establish the plan size. This also repairs ledgers written by older policies.
 * Without `scopes`, every collection scope is refreshed. Returns each row it
 * changed, as it was before.
 */
export function refreshInstallmentParents(
  plan: FinancialPlan,
  options: {
    scopes?: Set<string>;
    /** Purchases this run restated as a non-plan. */
    contradicted?: Set<string>;
    /** Purchases whose capture in this run stated no installment count. */
    countUnstated?: Set<string>;
  } = {},
): Transaction[] {
  const children = billedLinesByPurchase(plan.rows.values());
  // The final removed line can resolve a derived conflict without another
  // observation of the purchase; keep that purchase in the repair set.
  for (const row of plan.rows.values()) {
    if (row.details.issues.includes(LINE_CONFLICT) && !children.has(row.id)) {
      children.set(row.id, []);
    }
  }
  const changed: Transaction[] = [];
  for (const [id, lines] of children) {
    const parent = plan.transaction(id);
    if (
      !parent ||
      (options.scopes && !options.scopes.has(parent.sourceScope)) ||
      parent.presence === "removed" ||
      parent.supersededById ||
      parent.purchaseId !== null
    ) {
      continue;
    }
    const planPurchase =
      parent.amountBasis === "purchase_commitment" &&
      parent.kind === "purchase" &&
      parent.identityStrength !== "ambiguous";
    const next = withoutInstallmentFx(
      planPurchase
        ? withLineEvidence(
            parent,
            lines,
            options.contradicted?.has(id) === true || awaitsRestatement(parent),
            options.countUnstated?.has(id) === true,
          )
        : parent,
      lines.length > 0,
    );
    const value = {
      installmentCount: next.installmentCount,
      billingDate: next.billingDate,
      fxFeeMinor: next.fxFeeMinor,
      fxFeeCurrency: next.fxFeeCurrency,
      details: next.details,
    };
    if (
      canonicalJson(value) !==
      canonicalJson({
        installmentCount: parent.installmentCount,
        billingDate: parent.billingDate,
        fxFeeMinor: parent.fxFeeMinor,
        fxFeeCurrency: parent.fxFeeCurrency,
        details: parent.details,
      })
    ) {
      changed.push(parent);
      plan.updateTransaction(id, value);
    }
  }
  return changed;
}
