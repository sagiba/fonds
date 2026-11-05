import { isBilledLine } from "../model.js";
import { canonicalJson } from "../observations.js";
import { currentSourceRows } from "../provider-evidence.js";
import type { Transaction } from "../records.js";
import type { AutomaticPostingCapability } from "../source-adapter.js";
import { meaningfulAnnotation } from "./lifecycle.js";
import {
  type FinancialPlan,
  isNarrow,
  type LedgerRow,
  retiredFromMatching,
} from "./state.js";
import { CANDIDATE_DAYS } from "./sync-scope.js";

export const SETTLED_POSTING_POLICY = "settled-similarity-v1";
const DAY = 86_400_000;

export const SETTLEMENT_MAX_ROWS = 1000;
export const SETTLEMENT_MAX_ACCOUNTS = 4;
export const SETTLEMENT_FIELD_BYTES = 256;
export const SETTLEMENT_EVIDENCE_BYTES = 65536;

export type SettlementContender = Pick<
  Transaction,
  | "id"
  | "cardId"
  | "transactionDate"
  | "amountMinor"
  | "currency"
  | "originalAmountMinor"
  | "originalCurrency"
  | "supersededById"
  | "purchaseId"
  | "installmentNumber"
> & { hydrationSafe: boolean };

export interface SettlementSnapshot {
  epoch: string | null;
  accounts: ReadonlyMap<string, readonly SettlementContender[]>;
}

/** Absence requires a fresh epoch; malformed state disables only this optional policy. */
export function settlementEpoch(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
    ? value
    : null;
}

/** Conservative serialized-size ceiling without first building an unbounded JSON string. */
export function settlementEvidenceFits(value: unknown): boolean {
  let budget = SETTLEMENT_EVIDENCE_BYTES;
  let nodes = 4096;

  function visit(item: unknown, depth: number): boolean {
    if (--nodes < 0 || depth > 32 || (budget -= 8) < 0) {
      return false;
    }
    if (typeof item === "string") {
      return (budget -= item.length * 6) >= 0;
    }
    if (item === null || item === undefined || typeof item === "boolean") {
      return true;
    }
    if (typeof item === "number") {
      return Number.isFinite(item) && (budget -= 32) >= 0;
    }
    if (Array.isArray(item)) {
      if (item.length > nodes) {
        return false;
      }
      for (const child of item) {
        if (!visit(child, depth + 1)) {
          return false;
        }
      }
      return true;
    }
    if (typeof item !== "object") {
      return false;
    }
    for (const key in item) {
      if (!Object.hasOwn(item, key)) {
        continue;
      }
      if (
        (budget -= key.length * 6 + 4) < 0 ||
        !visit((item as Record<string, unknown>)[key], depth + 1)
      ) {
        return false;
      }
    }
    return true;
  }

  return visit(value, 0);
}

type Policy = NonNullable<AutomaticPostingCapability["settledHeuristic"]>;

/** A heuristic comparison, never evidence of issuer identity or financial role. */
export function settledMerchantMatch(
  left: string | null,
  right: string | null,
  repeatedTerminalToken = false,
): boolean {
  const normalize = (name: string | null) =>
    name
      ?.normalize("NFC")
      .replace(/\p{White_Space}+/gu, " ")
      .trim()
      .toUpperCase();
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b || !/[\p{L}\p{N}]/u.test(a) || !/[\p{L}\p{N}]/u.test(b)) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (!repeatedTerminalToken) {
    return false;
  }
  // An explicit, default-off risk policy, not a claim that a suffix is redundant.
  const shortened = (name: string) => {
    const tokens = name.split(" ");
    const last = tokens.pop()!;
    return tokens.length >= 4 &&
      new Set(tokens).size >= 4 &&
      /^[\p{L}\p{N}]{2,4}$/u.test(last) &&
      tokens.includes(last)
      ? tokens.join(" ")
      : undefined;
  };
  return shortened(a) === b || shortened(b) === a;
}

function eligible(row: LedgerRow): boolean {
  return (
    row.identityStrength === "native" &&
    !retiredFromMatching(row) &&
    row.presence !== "removed" &&
    !row.supersededById &&
    !row.details.postingLink &&
    !row.details.rejectedPostingKeys?.length &&
    !isBilledLine(row) &&
    row.purchaseId === null &&
    row.installmentCount === null &&
    row.installmentNumber === null &&
    (row.kind === "unknown" || row.kind === "purchase") &&
    row.amountMinor !== null &&
    row.amountMinor < 0 &&
    row.currency !== null &&
    ((row.originalAmountMinor === null && row.originalCurrency === null) ||
      (row.originalAmountMinor === row.amountMinor &&
        row.originalCurrency === row.currency))
  );
}

function fingerprint(row: Transaction, scope: string): string {
  return canonicalJson([
    scope,
    row.sourceKey,
    row.sourceAliases,
    row.sourceScope,
    row.cardId,
    row.transactionDate,
    row.merchantName,
    row.amountMinor,
    row.currency,
    row.originalAmountMinor,
    row.originalCurrency,
    row.kind,
    row.amountBasis,
    row.identityStrength,
    row.installmentCount,
    row.installmentNumber,
    row.purchaseId,
    row.details.issues
      .filter((issue) => issue !== "possible_pending_posted_match")
      .toSorted(),
    Object.fromEntries(
      Object.entries(row.details.provider).map(([provider, namespace]) => [
        provider,
        currentSourceRows(namespace),
      ]),
    ),
  ]);
}

/** Unknown contender fields cannot establish that it is safely outside the candidate's neighborhood. */
export function settlementCompetitor(
  row: Pick<
    SettlementContender,
    | "id"
    | "cardId"
    | "transactionDate"
    | "amountMinor"
    | "currency"
    | "originalAmountMinor"
    | "originalCurrency"
    | "supersededById"
    | "purchaseId"
    | "installmentNumber"
  >,
  pending: LedgerRow,
  posted: LedgerRow,
): boolean {
  if (
    row.id === pending.id ||
    row.id === posted.id ||
    row.supersededById ||
    isBilledLine(row)
  ) {
    return false;
  }
  if (row.cardId !== null && row.cardId !== pending.cardId) {
    return false;
  }
  if (
    row.transactionDate !== null &&
    Math.abs(
      Date.parse(row.transactionDate) - Date.parse(pending.transactionDate!),
    ) >
      CANDIDATE_DAYS * DAY
  ) {
    return false;
  }
  return (
    row.amountMinor === null ||
    row.currency === null ||
    row.currency !== pending.currency ||
    row.amountMinor === pending.amountMinor ||
    (row.originalAmountMinor === null) !== (row.originalCurrency === null) ||
    row.originalAmountMinor === pending.amountMinor ||
    (row.originalCurrency !== null && row.originalCurrency !== pending.currency)
  );
}

interface Options {
  plan: FinancialPlan;
  before: LedgerRow[];
  accountKey: string;
  policy: Policy;
  runId: string;
  capturedAt: string;
  scope: string;
  fresh: boolean;
  validWitness(runId: string, capturedAt: string): boolean;
  observed(row: LedgerRow): boolean;
  absent(row: LedgerRow): boolean;
}

/**
 * Only fresh captures can start/finish a window. A bounded, complete SQL scalar
 * scan supplies stored competitors; current plan rows include new observations.
 * This proves observed-ledger uniqueness, never provider-population completeness.
 */
export function postingSettlementPairs(
  options: Options,
): Map<Transaction, Transaction> {
  const {
    plan,
    before,
    accountKey,
    policy,
    runId,
    capturedAt,
    scope,
    fresh,
    validWitness,
    observed,
    absent,
  } = options;
  const comparisonScope = canonicalJson([
    scope,
    policy.repeatedTerminalToken === true,
  ]);
  const snapshot = plan.snapshot.settlement;
  const scanned = snapshot?.accounts.get(accountKey);
  if (!snapshot || snapshot.epoch === null || !scanned) {
    return new Map();
  }
  const safety = new Map(scanned.map((row) => [row.id, row.hydrationSafe]));
  const rows = plan.account(accountKey);
  const old = new Map(before.map((row) => [row.id, row]));
  const safe = (row: LedgerRow) =>
    old.has(row.id)
      ? safety.get(row.id) === true
      : !isNarrow(row) && settlementEvidenceFits(row);
  const pairs = new Map<Transaction, Transaction>();
  const postedRows = rows.filter(
    (row) => row.status === "posted" && !row.supersededById,
  );
  for (const pending of rows.filter((row) => row.status === "pending")) {
    let witness = pending.details.postingOverlap;
    if (
      witness?.settlement &&
      (witness.settlement.invalidatedAt ||
        witness.settlement.epoch !== snapshot.epoch)
    ) {
      continue;
    }
    const candidates = postedRows.filter(
      (posted) =>
        pending.cardId !== null &&
        pending.cardId === posted.cardId &&
        pending.transactionDate !== null &&
        pending.transactionDate === posted.transactionDate &&
        pending.amountMinor !== null &&
        pending.amountMinor === posted.amountMinor &&
        pending.currency !== null &&
        pending.currency === posted.currency &&
        safe(pending) &&
        safe(posted) &&
        settledMerchantMatch(
          policy.merchantName
            ? policy.merchantName(plan.full(pending))
            : pending.merchantName,
          policy.merchantName
            ? policy.merchantName(plan.full(posted))
            : posted.merchantName,
          policy.repeatedTerminalToken,
        ),
    );
    const posted = candidates.length === 1 ? candidates[0] : undefined;
    const usable =
      posted !== undefined &&
      eligible(pending) &&
      eligible(posted) &&
      pending.amountBasis === "authorization" &&
      (posted.amountBasis === "unknown" ||
        posted.amountBasis === "purchase_commitment") &&
      !meaningfulAnnotation(plan.annotation(posted.id)?.data) &&
      ![...scanned, ...before, ...rows].some((row) =>
        settlementCompetitor(row, pending, posted),
      ) &&
      settlementEvidenceFits(plan.full(pending)) &&
      settlementEvidenceFits(plan.full(posted)) &&
      policy.compatiblePair(plan.full(pending), plan.full(posted));
    if (
      witness?.settlement &&
      (!usable ||
        witness.postedId !== posted?.id ||
        witness.pendingFingerprint !==
          fingerprint(plan.full(pending), comparisonScope) ||
        witness.postedFingerprint !==
          fingerprint(plan.full(posted!), comparisonScope) ||
        observed(pending))
    ) {
      plan.updateTransaction(pending.id, {
        details: {
          ...plan.full(pending).details,
          postingOverlap: {
            ...witness,
            settlement: { ...witness.settlement, invalidatedAt: capturedAt },
          },
        },
      });
      continue;
    }
    if (!usable || !fresh || !observed(posted!) || !absent(pending)) {
      continue;
    }
    if (!witness?.settlement) {
      if (old.has(posted!.id) && !witness && !policy.existingPairRecheck) {
        continue;
      }
      const arrival = witness;
      witness = {
        postedId: posted!.id,
        runId,
        capturedAt,
        pendingFingerprint: fingerprint(plan.full(pending), comparisonScope),
        postedFingerprint: fingerprint(plan.full(posted!), comparisonScope),
        settlement: {
          policyVersion: SETTLED_POSTING_POLICY,
          epoch: snapshot.epoch,
          comparison: policy.repeatedTerminalToken
            ? "repeated-terminal-token-v1"
            : "merchant-presentation-v1",
          origin:
            arrival || !old.has(posted!.id)
              ? "first_arrival"
              : "existing_pair_recheck",
          ...(arrival ? { arrival } : {}),
        },
      };
      plan.updateTransaction(pending.id, {
        details: { ...plan.full(pending).details, postingOverlap: witness },
      });
      continue;
    }
    const currentTime = Date.parse(capturedAt);
    const startedTime = Date.parse(witness.capturedAt);
    if (
      runId === witness.runId ||
      !Number.isFinite(currentTime) ||
      !Number.isFinite(startedTime) ||
      currentTime - startedTime < DAY ||
      !validWitness(witness.runId, witness.capturedAt)
    ) {
      continue;
    }
    pairs.set(plan.full(posted!), plan.full(pending));
  }
  return pairs;
}
