import { isBilledLine } from "../model.js";
import { canonicalJson } from "../observations.js";
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

/** Purchases this old have closed statements; older pairs are for owner repair. */
export const SETTLEMENT_HORIZON_DAYS = 40;
export const SETTLEMENT_MAX_ROWS = 2000;
export const SETTLEMENT_EVIDENCE_BYTES = 65536;

const SETTLEMENT_COMPARISON = "merchant-variant-v1";

export const SETTLED_POSTING_MODES = ["off", "on"] as const;

export type SettledPostingMode = (typeof SETTLED_POSTING_MODES)[number];

export type SettlementContender = Pick<
  Transaction,
  | "id"
  | "cardId"
  | "transactionDate"
  | "merchantName"
  | "amountMinor"
  | "currency"
  | "originalAmountMinor"
  | "originalCurrency"
  | "supersededById"
  | "purchaseId"
  | "installmentNumber"
> & { hydrationSafe: boolean };

/** Present only when the deployment enabled the policy and the capture was scanned. */
export interface SettlementSnapshot {
  accounts: ReadonlyMap<string, readonly SettlementContender[]>;
}

const daysBefore = (capturedAt: string, days: number) =>
  new Date(Date.parse(capturedAt) - days * DAY).toISOString().slice(0, 10);

/** First date a settlement scan must read: the horizon and its competitors. */
export const settlementScanStart = (capturedAt: string) =>
  daysBefore(capturedAt, SETTLEMENT_HORIZON_DAYS + CANDIDATE_DAYS);

type Policy = NonNullable<AutomaticPostingCapability["settledHeuristic"]>;

/** Case and spacing never distinguish a merchant; `null` when nothing identifies one. */
export function merchantPresentation(name: string | null): string | null {
  const value = name
    ?.normalize("NFC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim()
    .toUpperCase();
  return value && /[\p{L}\p{N}]/u.test(value) ? value : null;
}

export function settlementEligible(row: LedgerRow): boolean {
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

type Competitor = Omit<SettlementContender, "hydrationSafe">;

/**
 * Unknown fields cannot place a row outside the candidate's neighborhood. A row
 * in another currency, or reversing this money, matters only under the same name.
 */
export function settlementCompetitor(
  row: Competitor,
  pending: LedgerRow,
  posted: LedgerRow,
  sameMerchant: (name: string | null) => boolean,
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
  if (
    row.amountMinor === null ||
    row.currency === null ||
    (row.originalAmountMinor === null) !== (row.originalCurrency === null)
  ) {
    return true;
  }
  if (
    (row.currency === pending.currency &&
      row.amountMinor === pending.amountMinor) ||
    (row.originalCurrency === pending.currency &&
      row.originalAmountMinor === pending.amountMinor)
  ) {
    return true;
  }
  // A visible reversal of this money means the authorization may have ended there.
  const reversal =
    row.currency === pending.currency &&
    row.amountMinor === -pending.amountMinor!;
  const foreign =
    reversal ||
    row.currency !== pending.currency ||
    (row.originalCurrency !== null &&
      row.originalCurrency !== pending.currency);
  return (
    foreign && (row.merchantName === null || sameMerchant(row.merchantName))
  );
}

interface Options {
  plan: FinancialPlan;
  before: LedgerRow[];
  accountKey: string;
  policy: Policy;
  runId: string;
  capturedAt: string;
  absent(row: LedgerRow): boolean;
}

/**
 * Runs only on a fresh, complete capture of this account. Every check is
 * re-derived here from retained rows, so a failed, partial or posted-only run
 * between two such captures is neutral: nothing it missed can be lost, because
 * retained rows keep any competitor visible and `lastSeenAt` any reappearance.
 * This proves observed-ledger uniqueness, never provider-population completeness.
 */
export function postingSettlementPairs(
  options: Options,
): Map<Transaction, Transaction> {
  const { plan, before, accountKey, policy, runId, capturedAt, absent } =
    options;
  const snapshot = plan.snapshot.settlement;
  const scanned = snapshot?.accounts.get(accountKey);
  const pairs = new Map<Transaction, Transaction>();
  if (!snapshot || !scanned) {
    return pairs;
  }
  const safety = new Map(scanned.map((row) => [row.id, row.hydrationSafe]));
  const rows = plan.account(accountKey);
  const old = new Set(before.map((row) => row.id));
  const safe = (row: LedgerRow) =>
    old.has(row.id) ? safety.get(row.id) === true : !isNarrow(row);
  // Names are rechecked on every run: enrichment may legitimately re-present one.
  const fingerprint = (row: LedgerRow) =>
    canonicalJson([
      row.cardId,
      row.transactionDate,
      row.amountMinor,
      row.currency,
    ]);
  const horizon = daysBefore(capturedAt, SETTLEMENT_HORIZON_DAYS);
  const postedRows = rows.filter(
    (row) => row.status === "posted" && !row.supersededById,
  );
  for (const pending of rows) {
    const held = pending.details.postingOverlap;
    const clock = held?.settlement ? held : undefined;
    if (
      pending.status !== "pending" ||
      pending.transactionDate === null ||
      pending.transactionDate < horizon ||
      clock?.settlement?.invalidatedAt
    ) {
      continue;
    }
    const gone =
      absent(pending) ||
      (pending.presence === "not_returned" &&
        pending.sourceAbsence !== undefined &&
        pending.lastSeenAt < capturedAt);
    if (!clock && !gone) {
      continue;
    }
    const candidates = postedRows.filter(
      (posted) =>
        pending.cardId !== null &&
        pending.cardId === posted.cardId &&
        posted.transactionDate !== null &&
        Math.abs(
          Date.parse(pending.transactionDate!) -
            Date.parse(posted.transactionDate),
        ) <= DAY &&
        pending.amountMinor !== null &&
        pending.amountMinor === posted.amountMinor &&
        pending.currency !== null &&
        pending.currency === posted.currency &&
        safe(pending) &&
        safe(posted) &&
        policy.sameMerchant(pending.merchantName, posted.merchantName),
    );
    const posted = candidates.length === 1 ? candidates[0] : undefined;
    const usable =
      posted !== undefined &&
      settlementEligible(pending) &&
      settlementEligible(posted) &&
      pending.amountBasis === "authorization" &&
      (posted.amountBasis === "unknown" ||
        posted.amountBasis === "purchase_commitment") &&
      posted.presence === "seen" &&
      posted.sourceAbsence === undefined &&
      !meaningfulAnnotation(plan.annotation(posted.id)?.data) &&
      ![...scanned, ...before, ...rows].some((row) =>
        settlementCompetitor(row, pending, posted, (name) =>
          policy.sameMerchant(pending.merchantName, name),
        ),
      ) &&
      policy.compatiblePair(plan.full(pending), plan.full(posted));
    if (
      clock &&
      (!gone ||
        !usable ||
        clock.postedId !== posted.id ||
        clock.pendingFingerprint !== fingerprint(pending) ||
        clock.postedFingerprint !== fingerprint(posted) ||
        pending.lastSeenAt > clock.capturedAt)
    ) {
      plan.updateTransaction(pending.id, {
        details: {
          ...plan.full(pending).details,
          postingOverlap: {
            ...clock,
            settlement: { ...clock.settlement!, invalidatedAt: capturedAt },
          },
        },
      });
      continue;
    }
    if (!usable) {
      continue;
    }
    if (!clock) {
      // The posting must have arrived after the authorization: similarity to
      // a row that was already there says nothing about continuation.
      if (posted.firstSeenAt <= pending.firstSeenAt) {
        continue;
      }
      plan.updateTransaction(pending.id, {
        details: {
          ...plan.full(pending).details,
          postingOverlap: {
            postedId: posted.id,
            runId,
            capturedAt,
            pendingFingerprint: fingerprint(pending),
            postedFingerprint: fingerprint(posted),
            settlement: {
              policyVersion: SETTLED_POSTING_POLICY,
              comparison: SETTLEMENT_COMPARISON,
              ...(held ? { arrival: held } : {}),
            },
          },
        },
      });
      continue;
    }
    if (Date.parse(capturedAt) - Date.parse(clock.capturedAt) >= DAY) {
      pairs.set(plan.full(posted), plan.full(pending));
    }
  }
  return pairs;
}
