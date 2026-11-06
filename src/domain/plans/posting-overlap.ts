import {
  isBilledLine,
  type TransactionDetails,
  type TransactionFacts,
} from "../model.js";
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

type Witness = NonNullable<TransactionDetails["postingOverlap"]>;

function withWitness(
  details: TransactionDetails,
  witness: Witness | undefined,
): TransactionDetails {
  const { postingOverlap: held, ...rest } = details;
  if (held?.settlement) {
    const { arrival: _replaced, ...settlement } = held.settlement;
    return {
      ...rest,
      postingOverlap: {
        ...held,
        settlement: { ...settlement, ...(witness ? { arrival: witness } : {}) },
      },
    };
  }
  return witness ? { ...rest, postingOverlap: witness } : rest;
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
 * Remember a unique overlap or same-capture transition, not a similarity suggestion.
 * Absence and classification can arrive in different captures; neither alone proves a link.
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
  const unlinked = (row: LedgerRow) =>
    row.presence !== "removed" && !row.supersededById && !survivors.has(row.id);
  const components = (candidates: LedgerRow[]) =>
    postingComponents(
      candidates.filter((row) => row.status === "pending"),
      candidates.filter((row) => row.status === "posted"),
    );
  const active = rows.filter(unlinked);
  const groups = components(active);
  // A correction cannot erase a competing identity's old key in this capture.
  const blockingGroups = components([...before.filter(unlinked), ...active]);
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
    // A settlement clock may hold an overlap witness; it never replaces one.
    const held = pending.details.postingOverlap;
    let witness = held?.settlement ? held.settlement.arrival : held;
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
        meaningfulAnnotation(plan.annotation(posted.id)?.data) ||
        witness.postedId !== posted.id ||
        witness.pendingFingerprint !== fingerprint(pending) ||
        witness.postedFingerprint !== fingerprint(posted) ||
        (previous?.presence === "not_returned" && observed(pending)))
    ) {
      plan.updateTransaction(pending.id, {
        details: withWitness(plan.full(pending).details, undefined),
      });
      witness = undefined;
    }
    if (!usable || !fresh) {
      continue;
    }
    if (!witness) {
      // Only the posted identity's arrival can establish the witness. An old
      // posting cannot acquire a relationship merely by remaining similar.
      if (
        previous?.presence === "seen" &&
        !old.has(posted.id) &&
        pending.firstSeenAt < posted.firstSeenAt &&
        (observed(pending) || absent(pending)) &&
        observed(posted) &&
        // Observed rows are written, so they are complete. A comparably absent
        // authorization instead retains its prior complete source evidence.
        [posted, ...(observed(pending) ? [pending] : [])].every((row) =>
          plan.full(row).details.sourceRefs.some((ref) => ref.runId === runId),
        )
      ) {
        plan.updateTransaction(pending.id, {
          details: withWitness(plan.full(pending).details, {
            postedId: posted.id,
            runId,
            capturedAt,
            pendingFingerprint: fingerprint(pending),
            postedFingerprint: fingerprint(posted),
          }),
        });
      }
      continue;
    }
    if (
      // A witness is never spent by its own capture: creation stops above, and
      // a run holds one response per account. This keeps that true if either changes.
      witness.runId === runId ||
      !validWitness(witness.runId, witness.capturedAt) ||
      !observed(posted) ||
      !absent(pending)
    ) {
      continue;
    }
    const completePending = plan.full(pending);
    const completePosted = plan.full(posted);
    const decision = automaticPostingPairs(
      [completePending],
      [completePosted],
      new Map([[completePending, completePending]]),
      capability,
    );
    if (decision.pairs.has(completePosted)) {
      pairs.set(completePosted, {
        ...completePending,
        details: { ...completePending.details, postingOverlap: witness },
      });
    }
  }
  return pairs;
}
