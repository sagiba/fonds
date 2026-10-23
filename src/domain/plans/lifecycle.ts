import { z } from "zod";

import { ConflictError, NotFoundError } from "../errors.js";
import {
  type AnnotationData,
  annotationSchema,
  detailsSchema,
  isBilledLine,
  paymentContextFields,
  type ReadPaymentContext,
  storedPaymentContext,
  type TransactionDetails,
} from "../model.js";
import {
  canonicalJson,
  retainObservations,
  retainProviderEvidence,
} from "../observations.js";
import { billedLinesByPurchase, inPerspective } from "../read-model.js";
import { nextVersion, type Transaction } from "../records.js";
import { canonicalAnnotation, reviewBasis, reviewState } from "./annotation.js";
import { refreshInstallmentParents } from "./installments.js";
import { FinancialPlan } from "./state.js";

const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const annotationVersionSchema = versionSchema.or(z.literal(0));
const reasonSchema = z.string().trim().min(1);

export const postingSchema = z
  .object({
    pendingId: z.string().min(1),
    postedId: z.string().min(1),
    expectedPendingVersion: versionSchema,
    expectedPostedVersion: versionSchema,
    expectedPendingAnnotationVersion: annotationVersionSchema,
    expectedPostedAnnotationVersion: annotationVersionSchema,
    reason: reasonSchema,
    actor: z.string().trim().min(1).default("user"),
  })
  .strict();

export interface PostingSplit {
  pending: Transaction;
  posted: Transaction;
}

interface AutomaticPosting {
  overlap?: NonNullable<TransactionDetails["postingOverlap"]>;
  policyVersion: string;
  runId: string;
  capturedAt: string;
}

/** A split veto follows native keys even if another financial row is proposed. */
export function postingRejected(
  pending: Pick<Transaction, "sourceKey" | "sourceAliases" | "details">,
  posted: Pick<Transaction, "sourceKey" | "sourceAliases" | "details">,
): boolean {
  return (
    (pending.details.rejectedPostingKeys ?? []).some((key) =>
      [posted.sourceKey, ...posted.sourceAliases].includes(key),
    ) ||
    (posted.details.rejectedPostingKeys ?? []).some((key) =>
      [pending.sourceKey, ...pending.sourceAliases].includes(key),
    )
  );
}

export const removalSchema = z
  .object({
    transactionId: z.string().min(1),
    expectedVersion: versionSchema,
    reason: reasonSchema,
    actor: z.string().trim().min(1).default("user"),
  })
  .strict();

const matchIssue = "possible_pending_posted_match";

const duplicatePlanIssue = "possible_duplicate_plan";

type ReviewState = ReturnType<typeof reviewState>;

/** Records a review transition when the state changed and either side requires review. */
function recordReviewTransition(
  plan: FinancialPlan,
  transactionId: string,
  before: ReviewState,
  after: ReviewState,
  command: { reason: string; actor: string },
  now: string,
): void {
  if (
    canonicalJson(before) === canonicalJson(after) ||
    (!before.required && !after.required)
  ) {
    return;
  }
  plan.event({
    transactionId,
    type: after.required
      ? "transaction.review_required"
      : "transaction.review_resolved",
    createdAt: now,
    actor: command.actor,
    before,
    after: { ...after, reason: command.reason },
  });
}

function withoutMatchIssue(row: Transaction) {
  const resolvedIssues = [matchIssue, "weak_source_identity"];
  const issues = row.details.issues.filter(
    (issue) => !resolvedIssues.includes(issue),
  );
  return {
    details: {
      ...row.details,
      issues,
      ...(row.details.pendingPostingCandidates === undefined
        ? {}
        : { pendingPostingCandidates: [] }),
    },
  };
}

/** Resolve only the confirmed IDs; other candidates and interpretation issues remain actionable. */
function removeCandidateReferences(
  plan: FinancialPlan,
  scope: Transaction,
  resolvedIds: string[],
  command: { reason: string; actor: string },
  now: string,
): void {
  const resolved = new Set(resolvedIds);
  const rows = plan
    .account(scope.sourceScope)
    .filter((row) => row.connectionId === scope.connectionId);
  for (const row of rows) {
    if (
      resolved.has(row.id) ||
      row.supersededById ||
      row.presence === "removed"
    ) {
      continue;
    }
    const previousCandidates = row.details.pendingPostingCandidates ?? [];
    const candidates = previousCandidates.filter((id) => !resolved.has(id));
    if (candidates.length === previousCandidates.length) {
      continue;
    }
    const issues =
      candidates.length > 0
        ? row.details.issues
        : row.details.issues.filter((issue) => issue !== matchIssue);
    const value = {
      details: { ...row.details, issues, pendingPostingCandidates: candidates },
    };
    const annotation = plan.annotation(row.id);
    const before = reviewState(row, annotation?.data);
    const after = reviewState({ ...row, ...value }, annotation?.data);
    plan.updateTransaction(row.id, value);
    recordReviewTransition(plan, row.id, before, after, command, now);
  }
}

/**
 * A changed native ID makes a different purchase, so a plan
 * restated under another ID would count twice. Posted plan purchases of one
 * collection scope that share card, merchant name, installment count, whole
 * amount, currency and transaction date get `possible_duplicate_plan` for
 * review; neither is merged, retired or excluded. Returns each row whose
 * issue changed, as it was before.
 */
export function refreshDuplicatePlans(plan: FinancialPlan): Transaction[] {
  const rows = plan.orderedRows();
  const children = billedLinesByPurchase(rows);
  const lookalikeKey = (row: Transaction) =>
    row.status === "posted" &&
    row.presence !== "removed" &&
    !row.supersededById &&
    !inPerspective(row, "billing", children.has(row.id)) &&
    row.cardId !== null &&
    row.merchantName !== null &&
    row.amountMinor !== null &&
    row.transactionDate !== null
      ? JSON.stringify([
          row.sourceScope,
          row.cardId,
          row.merchantName,
          row.installmentCount,
          row.amountMinor,
          row.currency,
          row.transactionDate,
        ])
      : null;
  const duplicates = new Set(
    [...Map.groupBy(rows, lookalikeKey)].flatMap(([key, group]) =>
      key !== null && group.length > 1 ? group.map((row) => row.id) : [],
    ),
  );
  const changed: Transaction[] = [];
  for (const row of rows) {
    const duplicate = duplicates.has(row.id);
    if (row.details.issues.includes(duplicatePlanIssue) === duplicate) {
      continue;
    }
    changed.push(row);
    const issues = row.details.issues.filter(
      (issue) => issue !== duplicatePlanIssue,
    );
    plan.updateTransaction(row.id, {
      details: {
        ...row.details,
        issues: duplicate ? [...issues, duplicatePlanIssue] : issues,
      },
    });
  }
  return changed;
}

/**
 * Owner operations reevaluate installment conflicts and lookalike plans, and
 * emit their review transitions.
 */
function refreshPlanReview(
  plan: FinancialPlan,
  command: { actor: string; reason: string },
  now: string,
): void {
  // Only the purchases of rows this command wrote, before and after it.
  const original = new Map(plan.snapshot.rows.map((row) => [row.id, row]));
  const parents = new Set(
    [...plan.transactionWrites.keys()].flatMap((id) => [
      id,
      ...[
        original.get(id)?.purchaseId,
        plan.transaction(id)?.purchaseId,
      ].filter((purchaseId): purchaseId is string => purchaseId != null),
    ]),
  );
  const changed = new Map<string, Transaction>();
  for (const before of [
    ...refreshInstallmentParents(plan, parents),
    ...refreshDuplicatePlans(plan),
  ]) {
    if (!changed.has(before.id)) {
      changed.set(before.id, before);
    }
  }
  for (const before of changed.values()) {
    const annotation = plan.annotation(before.id)?.data;
    const beforeReview = reviewState(before, annotation);
    const afterReview = reviewState(plan.transaction(before.id)!, annotation);
    recordReviewTransition(
      plan,
      before.id,
      beforeReview,
      afterReview,
      command,
      now,
    );
  }
}

function financialState(row: Transaction) {
  return {
    version: row.version,
    status: row.status,
    presence: row.presence,
    sourceAbsence: row.sourceAbsence ?? null,
    amountMinor: row.amountMinor,
    currency: row.currency,
    amountBasis: row.amountBasis,
    originalAmountMinor: row.originalAmountMinor,
    originalCurrency: row.originalCurrency,
    kind: row.kind,
    transactionDate: row.transactionDate,
    bookingDate: row.bookingDate,
    billingDate: row.billingDate,
    installmentCount: row.installmentCount,
    installmentNumber: row.installmentNumber,
    purchaseId: row.purchaseId,
    merchantCategoryCode: row.merchantCategoryCode,
    merchantName: row.merchantName,
    merchantProviderId: row.merchantProviderId,
    description: row.description,
    counterpartyName: row.counterpartyName,
    sourceKey: row.sourceKey,
    sourceAliases: row.sourceAliases,
    sourceRefs: row.details.sourceRefs,
  };
}

export function meaningfulAnnotation(
  data: AnnotationData | undefined,
): boolean {
  return (
    data !== undefined &&
    Boolean(
      data.notes ||
      data.category ||
      data.tags.length ||
      data.review ||
      Object.keys(data.metadata).length,
    )
  );
}

/** Explicit confirmation may carry a matching authorization approval into posted state. */
function postingAnnotation(
  data: AnnotationData,
  origin: Transaction,
  survivor: Transaction,
): AnnotationData {
  const value = annotationSchema.parse(data);
  if (
    value.review &&
    (origin.status === "pending" ||
      value.review.financialVersion === origin.version) &&
    canonicalJson(value.review.basis) === canonicalJson(reviewBasis(origin)) &&
    origin.amountMinor === survivor.amountMinor &&
    origin.currency === survivor.currency &&
    origin.kind === survivor.kind
  ) {
    value.review = {
      ...value.review,
      basis: reviewBasis(survivor),
      financialVersion: survivor.version,
    };
  }
  return canonicalAnnotation(annotationSchema.parse(value));
}

/**
 * Moves the billed lines of a purchase whose ID stopped surviving to the ID
 * that now holds its facts: on link, from the retired posted row to the
 * pending survivor; on unlink, back to the revived posted row. Each move is
 * versioned and recorded, in the same plan as the link.
 */
function retargetLines(
  plan: FinancialPlan,
  fromId: string,
  target: Transaction,
  command: { reason: string; actor: string },
  now: string,
  runId?: string,
): void {
  for (const line of plan.account(target.sourceScope)) {
    if (
      line.connectionId !== target.connectionId ||
      line.purchaseId !== fromId
    ) {
      continue;
    }
    const version = nextVersion(line.version);
    plan.updateTransaction(line.id, { purchaseId: target.id, version });
    plan.event({
      transactionId: line.id,
      type: "transaction.updated",
      ...(runId ? { runId } : {}),
      createdAt: now,
      actor: command.actor,
      before: { purchaseId: fromId, version: line.version },
      after: { purchaseId: target.id, version, reason: command.reason },
    });
  }
}

/** Shared posting transformation; ingestion supplies a validated automatic decision. */
export function planPosting(
  plan: FinancialPlan,
  input: z.input<typeof postingSchema>,
  now: string,
  automatic?: AutomaticPosting,
): Transaction {
  const command = postingSchema.parse(input);
  const pending = plan.transaction(command.pendingId);
  const posted = plan.transaction(command.postedId);
  if (!pending || !posted) {
    throw new NotFoundError("Transaction not found");
  }
  if (isBilledLine(pending) || isBilledLine(posted)) {
    throw new ConflictError("Billed lines are never linked");
  }
  if (
    pending.id === posted.id ||
    pending.status !== "pending" ||
    posted.status !== "posted" ||
    pending.supersededById ||
    posted.supersededById ||
    pending.presence === "removed" ||
    posted.presence === "removed"
  ) {
    throw new ConflictError(
      "Link requires active pending and posted transactions",
    );
  }
  if (
    pending.connectionId !== posted.connectionId ||
    pending.sourceScope !== posted.sourceScope ||
    pending.cardId !== posted.cardId
  ) {
    throw new ConflictError(
      "Transactions must belong to the same connection, account and card",
    );
  }
  if ([...plan.rows.values()].some((row) => row.supersededById === posted.id)) {
    throw new ConflictError(
      "Posted transaction already survives a confirmed link",
    );
  }
  if (
    pending.identityStrength === "ambiguous" ||
    pending.details.issues.includes("ambiguous_identity") ||
    posted.identityStrength !== "native" ||
    posted.details.issues.includes("ambiguous_identity")
  ) {
    throw new ConflictError("Ambiguous transaction identity cannot be linked");
  }
  if (
    pending.version !== command.expectedPendingVersion ||
    posted.version !== command.expectedPostedVersion
  ) {
    throw new ConflictError("Financial version conflict");
  }
  const pendingAnnotation = plan.annotation(pending.id);
  const postedAnnotation = plan.annotation(posted.id);
  if (
    (pendingAnnotation?.version ?? 0) !==
      command.expectedPendingAnnotationVersion ||
    (postedAnnotation?.version ?? 0) !== command.expectedPostedAnnotationVersion
  ) {
    throw new ConflictError("Annotation version conflict");
  }
  const pendingMeaningful = meaningfulAnnotation(pendingAnnotation?.data);
  const postedMeaningful = meaningfulAnnotation(postedAnnotation?.data);
  if (
    pendingMeaningful &&
    postedMeaningful &&
    canonicalJson(canonicalAnnotation(pendingAnnotation!.data)) !==
      canonicalJson(canonicalAnnotation(postedAnnotation!.data))
  ) {
    throw new ConflictError(
      "Conflicting annotations require review before linking",
    );
  }
  const cleanPending = withoutMatchIssue(pending);
  const cleanPosted = withoutMatchIssue(posted);
  const {
    postingLink: _previousLink,
    postingOverlap: _overlap,
    ...pendingDetails
  } = pending.details;
  // The survivor takes the posted row's payment context. A pending conflict
  // stays unless the posted row states that field.
  const { paymentContextConflicts: _postedConflicts, ...postedDetails } =
    cleanPosted.details;
  const postedContext = storedPaymentContext(
    automatic?.overlap
      ? (Object.fromEntries(
          paymentContextFields.map((field) => [
            field,
            posted[field] === null &&
            !posted.details.paymentContextConflicts?.includes(field)
              ? undefined
              : posted[field],
          ]),
        ) as ReadPaymentContext)
      : posted,
    pending,
  );
  const conflicts = paymentContextFields.filter(
    (field) =>
      posted.details.paymentContextConflicts?.includes(field) ||
      (postedContext[field] === null &&
        pending.details.paymentContextConflicts?.includes(field)),
  );
  const survivor: Transaction = {
    ...posted,
    sourceAbsence: posted.sourceAbsence,
    sourceEvidence: posted.sourceEvidence,
    ...postedContext,
    id: pending.id,
    firstSeenAt: pending.firstSeenAt,
    version: nextVersion(pending.version),
    sourceAliases: [
      ...new Set([
        pending.sourceKey,
        ...pending.sourceAliases,
        ...posted.sourceAliases,
      ]),
    ].filter((key) => key !== posted.sourceKey),
    details: detailsSchema.parse({
      ...postedDetails,
      ...(conflicts.length > 0 ? { paymentContextConflicts: conflicts } : {}),
      rejectedPostingKeys: [
        ...new Set([
          ...(pending.details.rejectedPostingKeys ?? []),
          ...(posted.details.rejectedPostingKeys ?? []),
        ]),
      ],
      postingLink: {
        schemaVersion: 1,
        policyVersion: automatic?.policyVersion ?? "owner-confirmation-v1",
        automatic: automatic !== undefined,
        postedId: posted.id,
        pending: { ...pending, details: pendingDetails },
        pendingKeys: [pending.sourceKey, ...pending.sourceAliases],
        postedKeys: [posted.sourceKey, ...posted.sourceAliases],
        evidence: automatic
          ? {
              runId: automatic.runId,
              capturedAt: automatic.capturedAt,
              ...(automatic.overlap?.postedId === posted.id
                ? { overlap: automatic.overlap }
                : {}),
            }
          : null,
      },
      sourceRefs: retainObservations(
        pending.details.sourceRefs,
        posted.details.sourceRefs,
      ),
      provider: retainProviderEvidence(
        cleanPosted.details.provider,
        pending.details.provider,
        posted.details.provider,
      ),
      issues: [
        ...new Set([
          ...[
            ...cleanPending.details.issues,
            ...cleanPosted.details.issues,
          ].filter((issue) => issue !== "conflicting_payment_context"),
          ...(conflicts.length > 0 ? ["conflicting_payment_context"] : []),
        ]),
      ],
    }),
  };
  plan.updateTransaction(pending.id, survivor);
  const retiredVersion = nextVersion(posted.version);
  plan.updateTransaction(posted.id, {
    ...cleanPosted,
    supersededById: survivor.id,
    version: retiredVersion,
  });
  retargetLines(plan, posted.id, survivor, command, now, automatic?.runId);
  const selected = pendingMeaningful
    ? pendingAnnotation
    : postedMeaningful
      ? postedAnnotation
      : undefined;
  let survivorAnnotation = pendingAnnotation?.data;
  if (selected && !automatic) {
    const origin = selected === pendingAnnotation ? pending : posted;
    const data = postingAnnotation(selected.data, origin, survivor);
    survivorAnnotation = data;
    if (
      !pendingAnnotation ||
      canonicalJson(canonicalAnnotation(pendingAnnotation.data)) !==
        canonicalJson(data)
    ) {
      const annotation = {
        transactionId: survivor.id,
        version: nextVersion(pendingAnnotation?.version ?? 0),
        data,
        updatedAt: now,
      };
      plan.setAnnotation(annotation);
      plan.event({
        transactionId: survivor.id,
        type: "annotation.updated",
        createdAt: now,
        actor: command.actor,
        before: pendingAnnotation
          ? {
              version: pendingAnnotation.version,
              data: pendingAnnotation.data,
            }
          : null,
        after: {
          version: annotation.version,
          data: annotation.data,
          reason: command.reason,
          linkedFromId: posted.id,
        },
      });
    }
  }
  plan.event({
    transactionId: survivor.id,
    type: "transaction.posted",
    ...(automatic ? { runId: automatic.runId } : {}),
    createdAt: now,
    actor: command.actor,
    before: financialState(pending),
    after: {
      ...financialState(survivor),
      reason: command.reason,
      retiredId: posted.id,
      automatic: automatic !== undefined,
    },
  });
  plan.event({
    transactionId: posted.id,
    type: "transaction.linked",
    ...(automatic ? { runId: automatic.runId } : {}),
    createdAt: now,
    actor: command.actor,
    before: { supersededById: null, version: posted.version },
    after: {
      supersededById: survivor.id,
      version: retiredVersion,
      reason: command.reason,
      automatic: automatic !== undefined,
    },
  });
  // Ingestion computes review transitions and refreshes lookalike plans once,
  // after all account changes.
  if (automatic) {
    return survivor;
  }
  for (const row of [pending, posted]) {
    const before = reviewState(
      row,
      row.id === pending.id ? pendingAnnotation?.data : postedAnnotation?.data,
    );
    const after =
      row.id === pending.id
        ? reviewState(survivor, survivorAnnotation)
        : reviewState(
            { ...posted, ...cleanPosted, supersededById: survivor.id },
            postedAnnotation?.data,
          );
    recordReviewTransition(plan, row.id, before, after, command, now);
  }
  removeCandidateReferences(
    plan,
    survivor,
    [pending.id, posted.id],
    command,
    now,
  );
  refreshPlanReview(plan, command, now);
  return survivor;
}

/** Split current posted facts from the retained authorization; annotations never move. */
export function planUnlinkPosting(
  plan: FinancialPlan,
  input: z.input<typeof postingSchema>,
  now: string,
): PostingSplit {
  const command = postingSchema.parse(input);
  const survivor = plan.transaction(command.pendingId);
  const retired = plan.transaction(command.postedId);
  if (!survivor || !retired) {
    throw new NotFoundError("Transaction not found");
  }
  const link = survivor.details.postingLink;
  if (!link || link.postedId !== retired.id) {
    throw new ConflictError("Link provenance is unavailable");
  }
  const pendingAnnotation = plan.annotation(survivor.id);
  const postedAnnotation = plan.annotation(retired.id);
  if (
    (pendingAnnotation?.version ?? 0) !==
      command.expectedPendingAnnotationVersion ||
    (postedAnnotation?.version ?? 0) !== command.expectedPostedAnnotationVersion
  ) {
    throw new ConflictError("Annotation version conflict");
  }

  if (link.split) {
    const receipt = link.split;
    if (
      retired.supersededById === null &&
      survivor.version === receipt.pendingVersion &&
      retired.version === receipt.postedVersion &&
      Object.entries(command).every(
        ([key, value]) =>
          key === "pendingId" ||
          key === "postedId" ||
          receipt[key as keyof typeof receipt] === value,
      )
    ) {
      return { pending: survivor, posted: retired };
    }
    throw new ConflictError("Posting link has already been split");
  }
  if (
    retired.supersededById !== survivor.id ||
    survivor.supersededById ||
    survivor.status !== "posted" ||
    survivor.connectionId !== retired.connectionId ||
    survivor.version !== command.expectedPendingVersion ||
    retired.version !== command.expectedPostedVersion
  ) {
    throw new ConflictError("Financial version conflict");
  }
  const pendingVersion = nextVersion(survivor.version);
  const postedVersion = nextVersion(retired.version);
  const pendingKeys = new Set(link.pendingKeys);
  const postedKeys = [
    ...new Set([
      ...link.postedKeys,
      survivor.sourceKey,
      ...survivor.sourceAliases.filter((key) => !pendingKeys.has(key)),
    ]),
  ];
  const pending = {
    ...link.pending,
    sourceAbsence: link.pending.sourceAbsence,
    sourceEvidence: link.pending.sourceEvidence,
    version: pendingVersion,
    details: detailsSchema.parse({
      ...link.pending.details,
      rejectedPostingKeys: [
        ...new Set([
          ...(survivor.details.rejectedPostingKeys ?? []),
          ...postedKeys,
        ]),
      ],
      postingLink: {
        ...link,
        split: {
          expectedPendingVersion: command.expectedPendingVersion,
          expectedPostedVersion: command.expectedPostedVersion,
          expectedPendingAnnotationVersion:
            command.expectedPendingAnnotationVersion,
          expectedPostedAnnotationVersion:
            command.expectedPostedAnnotationVersion,
          pendingVersion,
          postedVersion,
          reason: command.reason,
          actor: command.actor,
        },
      },
    }),
  };
  pending.details.pendingPostingCandidates = [];
  pending.details.issues = pending.details.issues.filter(
    (issue) => issue !== matchIssue,
  );
  const { postingLink: _link, ...postedDetails } = survivor.details;
  const pendingRefs = new Set(
    link.pending.details.sourceRefs.map(canonicalJson),
  );
  const posted: Transaction = {
    ...survivor,
    sourceAbsence: survivor.sourceAbsence,
    sourceEvidence: survivor.sourceEvidence,
    id: retired.id,
    firstSeenAt: retired.firstSeenAt,
    supersededById: null,
    version: postedVersion,
    sourceAliases: postedKeys.filter((key) => key !== survivor.sourceKey),
    details: {
      ...postedDetails,
      sourceRefs: survivor.details.sourceRefs.filter(
        (ref) => !pendingRefs.has(canonicalJson(ref)),
      ),
      rejectedPostingKeys: [
        ...new Set([
          ...(retired.details.rejectedPostingKeys ?? []),
          ...link.pendingKeys,
        ]),
      ],
    },
  };
  for (const [before, after] of [
    [survivor, pending],
    [retired, posted],
  ] as const) {
    plan.updateTransaction(after.id, after);
    if (after === posted) {
      retargetLines(plan, survivor.id, posted, command, now);
    }
    plan.event({
      transactionId: after.id,
      type: "transaction.unlinked",
      createdAt: now,
      actor: command.actor,
      before: {
        ...financialState(before),
        supersededById: before.supersededById,
      },
      after: {
        ...financialState(after),
        supersededById: null,
        reason: command.reason,
      },
    });
    const annotation = plan.annotation(after.id);
    const beforeReview = reviewState(before, annotation?.data);
    const afterReview = reviewState(after, annotation?.data);
    recordReviewTransition(
      plan,
      after.id,
      beforeReview,
      afterReview,
      command,
      now,
    );
  }
  refreshPlanReview(plan, command, now);
  return { pending, posted };
}

/** Explicit evidence removes a row from totals while preserving facts and user metadata. */
export function planRemoval(
  plan: FinancialPlan,
  input: z.input<typeof removalSchema>,
  now: string,
): Transaction {
  const command = removalSchema.parse(input);
  const row = plan.transaction(command.transactionId);
  if (!row) {
    throw new NotFoundError("Transaction not found");
  }
  if (row.supersededById) {
    throw new ConflictError("Transaction has been superseded");
  }
  if (row.version !== command.expectedVersion) {
    throw new ConflictError("Financial version conflict");
  }
  if (row.presence === "removed") {
    return row;
  }
  const removed: Transaction = {
    ...row,
    presence: "removed",
    version: nextVersion(row.version),
  };
  plan.updateTransaction(row.id, {
    presence: removed.presence,
    version: removed.version,
  });
  plan.event({
    transactionId: row.id,
    type: "transaction.removed",
    createdAt: now,
    actor: command.actor,
    before: financialState(row),
    after: { ...financialState(removed), reason: command.reason },
  });
  const annotation = plan.annotation(row.id);
  const beforeReview = reviewState(row, annotation?.data);
  if (beforeReview.required) {
    plan.event({
      transactionId: row.id,
      type: "transaction.review_resolved",
      createdAt: now,
      actor: command.actor,
      before: beforeReview,
      after: {
        ...reviewState(removed, annotation?.data),
        reason: command.reason,
      },
    });
  }
  removeCandidateReferences(plan, removed, [row.id], command, now);
  refreshPlanReview(plan, command, now);
  return removed;
}
