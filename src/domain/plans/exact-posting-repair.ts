import { z } from "zod";

import { ConflictError } from "../errors.js";
import { isBilledLine, RESOURCE_ID_MAX_LENGTH } from "../model.js";
import { canonicalJson, compareStrings } from "../observations.js";
import { canonicalAnnotation } from "./annotation.js";
import { exactMerchantPostingGroups } from "./auto-posting.js";
import {
  meaningfulAnnotation,
  planPosting,
  postingRejected,
} from "./lifecycle.js";
import {
  type FinancialPlan,
  type LedgerRow,
  retiredFromMatching,
} from "./state.js";

export const REPAIR_MAX_ACCOUNT_ROWS = 6000;
export const REPAIR_MAX_D1_ACCOUNT_ROWS = 1000;
export const REPAIR_MAX_PAIRS = 20;
const id = z.string().min(1).max(RESOURCE_ID_MAX_LENGTH);
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
export const repairPairSchema = z
  .object({
    pendingId: id,
    postedId: id,
    pendingVersion: version.positive(),
    postedVersion: version.positive(),
    pendingAnnotationVersion: version,
    postedAnnotationVersion: version,
  })
  .strict();
const scopeShape = {
  transactionId: id,
  from: z.iso.date(),
  to: z.iso.date(),
  reason: z.string().trim().min(1).max(500),
};

function checkDates(
  input: { from: string; to: string },
  context: z.RefinementCtx,
) {
  if (input.from > input.to) {
    context.addIssue({
      code: "custom",
      path: ["to"],
      message: "End precedes start",
    });
  }
}

export const previewExactPostingRepairSchema = z
  .object(scopeShape)
  .strict()
  .superRefine(checkDates);
export const applyExactPostingRepairSchema = z
  .object({
    ...scopeShape,
    expected: z.array(repairPairSchema).max(REPAIR_MAX_PAIRS),
  })
  .strict()
  .superRefine(checkDates);
export const exactPostingRepairSchema = z
  .object({
    transactionId: id,
    from: z.iso.date(),
    to: z.iso.date(),
    mode: z.enum(["preview", "apply"]),
    reason: z.string().trim().min(1).max(500),
    expected: z.array(repairPairSchema).max(REPAIR_MAX_PAIRS).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.from > input.to) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "End precedes start",
      });
    }
    if ((input.mode === "apply") !== (input.expected !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["expected"],
        message: "Apply requires the complete preview; preview must omit it",
      });
    }
  });

export type ExactPostingRepair = z.input<typeof exactPostingRepairSchema>;

export type RepairPair = z.output<typeof repairPairSchema>;

function exactMerchantName(value: string | null): string | undefined {
  const name = value
    ?.normalize("NFC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
  return name && /[\p{L}\p{N}]/u.test(name) ? name : undefined;
}

/** A conservative component includes unsupported contenders before eligibility is considered. */
export function repairCandidates(
  plan: FinancialPlan,
  from: string,
  to: string,
): RepairPair[] {
  const active = [...plan.rows.values()].filter(
    (row) => row.presence !== "removed" && !row.supersededById,
  );
  const merchantNames = new Map(
    active.map((row) => [row.id, exactMerchantName(row.merchantName)]),
  );
  const rows = active.filter(
    (row) =>
      row.cardId !== null &&
      row.transactionDate !== null &&
      row.transactionDate >= from &&
      row.transactionDate <= to &&
      merchantNames.get(row.id) !== undefined &&
      row.amountMinor !== null &&
      row.currency !== null,
  );
  const groups = new Map<
    string,
    { pending: LedgerRow[]; posted: LedgerRow[] }
  >();
  for (const row of rows) {
    const key = canonicalJson([
      row.connectionId,
      row.sourceScope,
      row.cardId,
      row.transactionDate,
      merchantNames.get(row.id),
      row.amountMinor,
      row.currency,
    ]);
    const group = groups.get(key) ?? { pending: [], posted: [] };
    group[row.status].push(row);
    groups.set(key, group);
  }
  const survivorIds = new Set(
    [...plan.rows.values()].flatMap((row) =>
      row.supersededById ? [row.supersededById] : [],
    ),
  );
  const pairs: RepairPair[] = [];
  for (const group of groups.values()) {
    if (group.pending.length !== 1 || group.posted.length !== 1) {
      continue;
    }
    const pending = group.pending[0]!;
    const posted = group.posted[0]!;
    if (
      [pending, posted].some(
        (row) =>
          row.identityStrength !== "native" ||
          retiredFromMatching(row) ||
          isBilledLine(row) ||
          row.installmentCount !== null ||
          row.details.postingLink ||
          survivorIds.has(row.id) ||
          row.amountMinor === null ||
          row.amountMinor >= 0 ||
          (row.originalAmountMinor !== null &&
            row.originalAmountMinor !== row.amountMinor) ||
          (row.originalCurrency !== null &&
            row.originalCurrency !== row.currency) ||
          (row.originalAmountMinor === null) !==
            (row.originalCurrency === null),
      )
    ) {
      continue;
    }
    const absenceAt =
      pending.sourceAbsence && Date.parse(pending.sourceAbsence.capturedAt);
    const lastSeenAt = Date.parse(pending.lastSeenAt);
    if (
      pending.presence !== "not_returned" ||
      !pending.sourceAbsence ||
      !timestamp.safeParse(pending.sourceAbsence.capturedAt).success ||
      !timestamp.safeParse(pending.lastSeenAt).success ||
      absenceAt === undefined ||
      !Number.isFinite(absenceAt) ||
      !Number.isFinite(lastSeenAt) ||
      absenceAt < lastSeenAt ||
      posted.presence !== "seen" ||
      posted.sourceAbsence !== undefined ||
      pending.amountBasis !== "authorization" ||
      posted.amountBasis !== "purchase_commitment" ||
      !(pending.kind === "purchase" || pending.kind === "unknown") ||
      posted.kind !== "purchase" ||
      pending.installmentNumber !== null ||
      posted.installmentNumber !== null ||
      [pending, posted].some((row) =>
        row.details.issues.some(
          (issue) =>
            issue !== "possible_pending_posted_match" &&
            issue !== "source_derived_amount_direction",
        ),
      ) ||
      postingRejected(pending, posted)
    ) {
      continue;
    }
    const a = plan.annotation(pending.id);
    const b = plan.annotation(posted.id);
    if (
      meaningfulAnnotation(a?.data) &&
      meaningfulAnnotation(b?.data) &&
      canonicalJson(canonicalAnnotation(a!.data)) !==
        canonicalJson(canonicalAnnotation(b!.data))
    ) {
      continue;
    }
    // Missing fields cannot disprove a competing identity. The complete account
    // is loaded so these uncertain contenders remain visible even without a date.
    const possible = (candidate: (typeof active)[number]) =>
      candidate.connectionId === pending.connectionId &&
      candidate.sourceScope === pending.sourceScope &&
      (candidate.cardId === null || candidate.cardId === pending.cardId) &&
      (candidate.transactionDate === null ||
        candidate.transactionDate === pending.transactionDate) &&
      (((candidate.amountMinor === null ||
        candidate.amountMinor === pending.amountMinor) &&
        (candidate.currency === null ||
          candidate.currency === pending.currency)) ||
        ((candidate.originalAmountMinor !== null ||
          candidate.originalCurrency !== null) &&
          (candidate.originalAmountMinor === null ||
            candidate.originalAmountMinor === pending.amountMinor) &&
          (candidate.originalCurrency === null ||
            candidate.originalCurrency === pending.currency))) &&
      (merchantNames.get(candidate.id) === undefined ||
        merchantNames.get(candidate.id) === merchantNames.get(pending.id));
    if (
      active.some(
        (candidate) =>
          candidate.id !== pending.id &&
          candidate.id !== posted.id &&
          possible(candidate),
      )
    ) {
      continue;
    }
    const completePending = plan.full(pending);
    const completePosted = plan.full(posted);
    if (!exactMerchantPostingGroups([completePending], [completePosted])) {
      continue;
    }
    pairs.push({
      pendingId: pending.id,
      postedId: posted.id,
      pendingVersion: pending.version,
      postedVersion: posted.version,
      pendingAnnotationVersion: a?.version ?? 0,
      postedAnnotationVersion: b?.version ?? 0,
    });
    if (pairs.length > REPAIR_MAX_PAIRS) {
      throw new ConflictError(
        "Repair has too many pairs; narrow the date range",
      );
    }
  }
  pairs.sort(
    (a, b) =>
      compareStrings(a.pendingId, b.pendingId) ||
      compareStrings(a.postedId, b.postedId),
  );
  return pairs;
}

export function applyRepair(
  plan: FinancialPlan,
  input: z.output<typeof exactPostingRepairSchema>,
  now: string,
): RepairPair[] {
  const pairs = repairCandidates(plan, input.from, input.to);
  if (input.mode === "apply") {
    if (canonicalJson(input.expected) !== canonicalJson(pairs)) {
      throw new ConflictError("Repair preview changed; preview again");
    }
    for (const pair of pairs) {
      planPosting(
        plan,
        {
          pendingId: pair.pendingId,
          postedId: pair.postedId,
          expectedPendingVersion: pair.pendingVersion,
          expectedPostedVersion: pair.postedVersion,
          expectedPendingAnnotationVersion: pair.pendingAnnotationVersion,
          expectedPostedAnnotationVersion: pair.postedAnnotationVersion,
          reason: `Exact posting repair: ${input.reason}`,
          actor: "owner",
        },
        now,
        undefined,
        "owner-exact-repair-v1",
      );
    }
  }
  return pairs;
}
