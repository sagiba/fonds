import type { TransactionFacts } from "../../src/domain/model.js";

/** Invented exact-merchant policy, independent of either real provider. */
export function compatiblePostingGroups(
  pending: readonly TransactionFacts[],
  posted: readonly TransactionFacts[],
): boolean {
  const rows = [...pending, ...posted];
  const merchant = rows[0]?.merchantName;
  return (
    pending.length > 0 &&
    posted.length > 0 &&
    !!merchant &&
    rows.every(
      (row) =>
        row.merchantName === merchant &&
        (row.kind === "purchase" || row.kind === "refund") &&
        row.details.issues.every(
          (issue) => issue === "possible_pending_posted_match",
        ),
    )
  );
}
