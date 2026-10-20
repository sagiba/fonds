import { isBilledLine, type TransactionFacts } from "../model.js";
import { canonicalJson } from "../observations.js";
import type { Transaction } from "../records.js";
import type {
  AutomaticPostingCapability,
  PostingMatchEvidence,
} from "../source-adapter.js";

/** Purchase-currency money for linking; billing is only a same-currency fallback. */
export function postingMoney(row: TransactionFacts) {
  return row.status === "posted" &&
    row.originalAmountMinor !== null &&
    row.originalCurrency !== null
    ? { amountMinor: row.originalAmountMinor, currency: row.originalCurrency }
    : { amountMinor: row.amountMinor, currency: row.currency };
}

/** Relaxed equality: unsupported interpretations must still block attribution. */
function postingKey(row: TransactionFacts): string | undefined {
  const { amountMinor, currency } = postingMoney(row);
  if (
    row.cardId === null ||
    row.transactionDate === null ||
    amountMinor === null ||
    currency === null
  ) {
    return undefined;
  }
  return canonicalJson([
    row.sourceScope,
    row.cardId,
    row.transactionDate,
    amountMinor,
    currency,
  ]);
}

function eligiblePosting(
  row: TransactionFacts,
  capability: AutomaticPostingCapability,
): boolean {
  const { amountMinor } = postingMoney(row);
  return (
    row.identityStrength === "native" &&
    (row.kind === "purchase" || row.kind === "refund") &&
    row.currency !== null &&
    row.amountMinor !== null &&
    amountMinor !== null &&
    (row.kind === "refund"
      ? row.amountMinor > 0 && amountMinor > 0
      : row.amountMinor < 0 && amountMinor < 0) &&
    row.installmentCount === null &&
    !isBilledLine(row) &&
    row.details.issues.every(
      (issue) => issue === "possible_pending_posted_match",
    ) &&
    // Defensive: linked survivors are also excluded when preparing active rows.
    !row.details.postingLink &&
    !row.details.rejectedPostingKeys?.length &&
    row.amountBasis ===
      (row.status === "pending"
        ? capability.pendingAmountBasis
        : capability.postedAmountBasis)
  );
}

/** NFC only: preserve case, punctuation, quotes and compatibility distinctions. */
function normalizedEvidence(evidence: PostingMatchEvidence | null) {
  if (
    evidence === null ||
    evidence.merchantName === null ||
    evidence.categoryCode === null ||
    evidence.sourceTypeCode === null ||
    evidence.cardPresent === null ||
    evidence.tokenCode === null ||
    evidence.paymentCount === null
  ) {
    return null;
  }
  const merchantName = evidence.merchantName
    .normalize("NFC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(merchantName)) {
    return null;
  }
  return { ...evidence, merchantName };
}

function compatibleEvidence(
  pending: PostingMatchEvidence,
  posted: PostingMatchEvidence,
): boolean {
  const pendingName = pending.merchantName!;
  const postedName = posted.merchantName!;
  const compatibleName =
    pendingName === postedName ||
    (pendingName.startsWith(postedName + " ") &&
      postedName.split(" ").filter((token) => /[\p{L}\p{N}]/u.test(token))
        .length >= 2);
  return (
    compatibleName &&
    pending.categoryCode === posted.categoryCode &&
    pending.sourceTypeCode === posted.sourceTypeCode &&
    pending.cardPresent === posted.cardPresent &&
    pending.tokenCode === posted.tokenCode &&
    pending.paymentCount === posted.paymentCount &&
    (["abroad", "merchantProviderId"] as const).every(
      (field) =>
        pending[field] === null ||
        posted[field] === null ||
        pending[field] === posted[field],
    )
  );
}

/** Homogeneity includes optional presence and normalized names, before any pairing. */
function homogeneousEvidence(
  rows: TransactionFacts[],
  capability: AutomaticPostingCapability,
) {
  const evidence = rows.map((row) =>
    normalizedEvidence(capability.evidence(row)),
  );
  const representative = evidence[0];
  return representative &&
    evidence.every(
      (item) =>
        item !== null && canonicalJson(item) === canonicalJson(representative),
    )
    ? representative
    : null;
}

interface PostingComponent<Row extends TransactionFacts> {
  pending: Row[];
  posted: Row[];
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Group all plausible rows before applying eligibility; each key is a complete component. */
export function postingComponents<Row extends TransactionFacts>(
  pending: Row[],
  posted: Row[],
): PostingComponent<Row>[] {
  const groups = new Map<string, PostingComponent<Row>>();

  function groupFor(row: Row) {
    const key = postingKey(row);
    if (key === undefined) {
      return undefined;
    }
    const group = groups.get(key) ?? { pending: [], posted: [] };
    groups.set(key, group);
    return group;
  }

  // Role guard: billed lines are never matched, not even as blockers.
  for (const row of pending) {
    if (!isBilledLine(row)) {
      groupFor(row)?.pending.push(row);
    }
  }
  for (const row of posted) {
    if (!isBilledLine(row)) {
      groupFor(row)?.posted.push(row);
    }
  }

  return [...groups.values()];
}

export function automaticPostingPairs(
  pending: TransactionFacts[],
  posted: TransactionFacts[],
  disappearing: ReadonlyMap<TransactionFacts, Transaction>,
  capability: AutomaticPostingCapability,
  newPosted = new Set(posted),
) {
  const pairs = new Map<TransactionFacts, Transaction>();
  for (const group of postingComponents(pending, posted)) {
    if (
      group.pending.length === 0 ||
      !group.posted.some((row) => newPosted.has(row))
    ) {
      continue;
    }
    if (
      group.pending.length !== group.posted.length ||
      !group.pending.every(
        (row) => disappearing.has(row) && eligiblePosting(row, capability),
      ) ||
      !group.posted.every(
        (row) => newPosted.has(row) && eligiblePosting(row, capability),
      )
    ) {
      continue;
    }
    const pendingEvidence = homogeneousEvidence(group.pending, capability);
    const postedEvidence = homogeneousEvidence(group.posted, capability);
    if (
      !pendingEvidence ||
      !postedEvidence ||
      !compatibleEvidence(pendingEvidence, postedEvidence)
    ) {
      continue;
    }
    // Owner accepts arbitrary attribution among indistinguishable twins.
    const disappearingPending = group.pending.map((row) =>
      disappearing.get(row)!,
    );
    disappearingPending.sort(
      (left, right) =>
        compareKeys(left.firstSeenAt, right.firstSeenAt) ||
        compareKeys(left.sourceKey, right.sourceKey),
    );
    group.posted.sort((left, right) =>
      compareKeys(left.sourceKey, right.sourceKey),
    );
    group.posted.forEach((posted, index) =>
      pairs.set(posted, disappearingPending[index]!),
    );
  }
  return { pairs };
}
