import { isBilledLine, type TransactionFacts } from "../model.js";
import { canonicalJson } from "../observations.js";
import type { Transaction } from "../records.js";
import type { AutomaticPostingCapability } from "../source-adapter.js";
import {
  automaticPostingPairs,
  postingComponents,
  type PostingFacts,
  postingMoney,
} from "./auto-posting.js";
import { meaningfulAnnotation } from "./lifecycle.js";
import type { FinancialPlan, LedgerRow } from "./state.js";

/** Classification may strengthen later; attribution facts may not change beneath a witness. */
function fingerprint(
  row: PostingFacts & Pick<TransactionFacts, "sourceKey" | "merchantName">,
): string {
  return canonicalJson([
    row.sourceKey,
    row.sourceScope,
    row.cardId,
    row.transactionDate,
    postingMoney(row),
    row.merchantName,
  ]);
}

interface OverlapOptions {
  plan: FinancialPlan;
  before: LedgerRow[];
  accountKey: string;
  capability: AutomaticPostingCapability;
  runId: string;
  capturedAt: string;
  fresh: boolean;
  validWitness: (runId: string, capturedAt: string) => boolean;
  observed: (row: LedgerRow) => boolean;
  absent: (row: LedgerRow) => boolean;
}

/**
 * Remember an observed unique overlap, not a similarity suggestion. Absence and
 * classification can arrive in different captures; neither alone proves a link.
 * The caller supplies only fresh, complete, comparable recent captures.
 */
export function postingOverlapPairs({
  plan,
  before,
  accountKey,
  capability,
  runId,
  capturedAt,
  fresh,
  validWitness,
  observed,
  absent,
}: OverlapOptions): Map<Transaction, Transaction> {
  const rows = plan.account(accountKey);
  const old = new Map(before.map((row) => [row.id, row]));
  const survivors = new Set(
    rows.flatMap((row) => (row.supersededById ? [row.supersededById] : [])),
  );
  const active = rows.filter(
    (row) =>
      row.presence !== "removed" &&
      !row.supersededById &&
      !survivors.has(row.id),
  );
  const groups = postingComponents(
    active.filter((row) => row.status === "pending"),
    active.filter((row) => row.status === "posted"),
  );
  // A correction cannot erase a competing identity's old key in this capture.
  const priorAndCurrent = [
    ...before.filter(
      (row) =>
        row.presence !== "removed" &&
        !row.supersededById &&
        !survivors.has(row.id),
    ),
    ...active,
  ];
  const blockingGroups = postingComponents(
    priorAndCurrent.filter((row) => row.status === "pending"),
    priorAndCurrent.filter((row) => row.status === "posted"),
  );
  const singleton = new Map(
    groups.flatMap((group) => {
      if (group.pending.length !== 1 || group.posted.length !== 1) {
        return [];
      }
      const pending = group.pending[0]!;
      const posted = group.posted[0]!;
      const unambiguous = blockingGroups
        .filter((candidate) =>
          candidate.pending.some((row) => row.id === pending.id),
        )
        .every(
          (candidate) =>
            candidate.pending.every((row) => row.id === pending.id) &&
            candidate.posted.length > 0 &&
            candidate.posted.every((row) => row.id === posted.id),
        );
      return unambiguous ? [[pending.id, posted] as const] : [];
    }),
  );
  const pairs = new Map<Transaction, Transaction>();
  for (const pending of rows.filter((row) => row.status === "pending")) {
    const posted = singleton.get(pending.id);
    const previous = old.get(pending.id);
    let witness = pending.details.postingOverlap;
    const usable =
      posted !== undefined &&
      [pending, posted].every(
        (row) =>
          row.identityStrength === "native" &&
          !isBilledLine(row) &&
          row.installmentCount === null &&
          (row.kind === "unknown" ||
            row.kind === "purchase" ||
            row.kind === "refund") &&
          (row.amountBasis === "unknown" ||
            row.amountBasis ===
              (row.status === "pending"
                ? capability.pendingAmountBasis
                : capability.postedAmountBasis)) &&
          !row.details.postingLink &&
          !row.details.rejectedPostingKeys?.length,
      );
    if (
      witness &&
      (!usable ||
        meaningfulAnnotation(plan.annotation(posted!.id)?.data) ||
        witness.postedId !== posted!.id ||
        witness.pendingFingerprint !== fingerprint(pending) ||
        witness.postedFingerprint !== fingerprint(posted!) ||
        (previous?.presence === "not_returned" && observed(pending)))
    ) {
      const { postingOverlap: _discarded, ...details } =
        plan.full(pending).details;
      plan.updateTransaction(pending.id, { details });
      witness = undefined;
    }
    if (!usable) {
      continue;
    }
    // Only the posted identity's arrival can establish the witness. An old
    // posting cannot acquire a relationship merely by remaining similar.
    if (
      fresh &&
      !witness &&
      previous?.presence === "seen" &&
      !old.has(posted!.id) &&
      pending.firstSeenAt < posted!.firstSeenAt &&
      observed(pending) &&
      observed(posted!) &&
      // Observed rows are written, so they are complete.
      [pending, posted!].every((row) =>
        plan.full(row).details.sourceRefs.some((ref) => ref.runId === runId),
      )
    ) {
      witness = {
        postedId: posted!.id,
        runId,
        capturedAt,
        pendingFingerprint: fingerprint(pending),
        postedFingerprint: fingerprint(posted!),
      };
      plan.updateTransaction(pending.id, {
        details: { ...plan.full(pending).details, postingOverlap: witness },
      });
    }
    if (
      !fresh ||
      !witness ||
      !validWitness(witness.runId, witness.capturedAt) ||
      !observed(posted!) ||
      !absent(pending) ||
      meaningfulAnnotation(plan.annotation(posted!.id)?.data)
    ) {
      continue;
    }
    const completePending = plan.full(pending);
    const completePosted = plan.full(posted!);
    const decision = automaticPostingPairs(
      [completePending],
      [completePosted],
      new Map([[completePending, completePending]]),
      capability,
    );
    if (decision.pairs.has(completePosted)) {
      pairs.set(completePosted, completePending);
    }
  }
  return pairs;
}
