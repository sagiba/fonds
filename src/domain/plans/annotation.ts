import { z } from "zod";

import { ConflictError, NotFoundError } from "../errors.js";
import {
  ANNOTATION_TAGS_MAX,
  annotationCategorySchema,
  type AnnotationData,
  annotationSchema,
  annotationTagSchema,
  jsonValueSchema,
} from "../model.js";
import { canonicalJson } from "../observations.js";
import { type LedgerEvent, nextVersion, type Transaction } from "../records.js";
import { FinancialPlan } from "./state.js";

export { ConflictError } from "../errors.js";

/**
 * Tags are a set. Every annotation write and comparison uses this one canonical
 * order, so reordering is a no-op and equality never depends on input order.
 */
export function canonicalAnnotation(data: AnnotationData): AnnotationData {
  return { ...data, tags: [...new Set(data.tags)].sort() };
}

type ReviewBasisFacts = Pick<
  Transaction,
  "amountMinor" | "currency" | "amountBasis" | "kind"
>;

/** The facts review state reads, so list views can present it. */
type ReviewFacts = ReviewBasisFacts &
  Pick<Transaction, "supersededById" | "presence"> & {
    details: Pick<
      Transaction["details"],
      "issues" | "pendingPostingCandidates"
    >;
  };

export function reviewBasis(row: ReviewBasisFacts) {
  return {
    amountMinor: row.amountMinor,
    currency: row.currency,
    amountBasis: row.amountBasis,
    kind: row.kind,
  };
}

export function annotationStaleness(
  row: ReviewBasisFacts,
  data: AnnotationData | undefined,
) {
  return {
    reviewStale:
      data?.review != null && !sameBasis(data.review.basis, reviewBasis(row)),
  };
}

export type ReviewStatus = "unreviewed" | "approved" | "needs_review" | "stale";

/** User review only: stale basis takes precedence; lifecycle and source issues are independent. */
export function reviewStatus(
  row: ReviewBasisFacts,
  data?: AnnotationData,
): ReviewStatus {
  if (annotationStaleness(row, data).reviewStale) {
    return "stale";
  }
  return data?.review?.status ?? "unreviewed";
}

/** A small, serializable signal for the app; source facts and user review remain separate. */
export function reviewState(row: ReviewFacts, data?: AnnotationData) {
  if (row.supersededById || row.presence === "removed") {
    return {
      required: false,
      reasons: [] as string[],
      candidates: [] as string[],
    };
  }
  const stale = annotationStaleness(row, data);
  const reasons = new Set(row.details.issues);
  // A user instruction is not a parser issue and must survive refreshes unchanged.
  if (data?.review?.status === "needs_review") {
    reasons.add("user_needs_review");
  }
  if (stale.reviewStale) {
    reasons.add("review_stale");
  }
  const candidates = [
    ...new Set(row.details.pendingPostingCandidates ?? []),
  ].sort();
  return {
    required: reasons.size > 0 || candidates.length > 0,
    reasons: [...reasons].sort(),
    candidates,
  };
}

function sameBasis(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return Object.keys(right).every((key) => left[key] === right[key]);
}

const editFields = {
  transactionId: z.string().min(1),
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedTransactionVersion: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  notes: z.string().nullable().optional(),
  category: annotationCategorySchema.nullable().optional(),
  tags: z.array(annotationTagSchema).max(ANNOTATION_TAGS_MAX).optional(),
  metadata: z
    .record(z.string(), jsonValueSchema.nullable())
    .nullable()
    .optional(),
  review: z
    .object({ status: z.enum(["approved", "needs_review"]) })
    .strict()
    .nullable()
    .optional(),
};

export const editShapeSchema = z.object({ ...editFields }).strict();

/** The review decision is bound to the transaction version it was made against. */
export function requireTransactionVersionForReview(
  value: z.output<typeof editShapeSchema>,
  context: z.RefinementCtx,
) {
  if (
    value.review !== undefined &&
    value.expectedTransactionVersion === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["expectedTransactionVersion"],
      message: "expectedTransactionVersion is required when review is present",
    });
  }
}

export const editSchema = z
  .object({ ...editFields, actor: z.string().min(1).default("user") })
  .strict()
  .superRefine(requireTransactionVersionForReview);

function annotationTarget(plan: FinancialPlan, transactionId: string) {
  const row = plan.hydrated(transactionId);
  if (!row) {
    throw new NotFoundError("Transaction not found");
  }
  if (row.supersededById) {
    throw new ConflictError("Transaction has been superseded");
  }
  return row;
}

/** Applies the annotation PATCH rules to the previous document. */
function patchedDocument(
  previous: AnnotationData | undefined,
  edit: z.output<typeof editSchema>,
  row: Transaction,
): AnnotationData {
  const base = previous ?? annotationSchema.parse({});
  let metadata = base.metadata;
  if (edit.metadata === null) {
    metadata = {};
  } else if (edit.metadata !== undefined) {
    const merged = { ...metadata };
    for (const [key, value] of Object.entries(edit.metadata)) {
      if (value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
    metadata = merged;
  }
  let review = base.review;
  if (edit.review === null) {
    review = null;
  } else if (edit.review !== undefined) {
    review = {
      status: edit.review.status,
      financialVersion: row.version,
      basis: reviewBasis(row),
    };
  }
  return annotationSchema.parse({
    schemaVersion: 1,
    notes: edit.notes === undefined ? base.notes : edit.notes,
    category: edit.category === undefined ? base.category : edit.category,
    tags: edit.tags === undefined ? base.tags : [...new Set(edit.tags)],
    metadata,
    review,
  });
}

function commitAnnotation(
  plan: FinancialPlan,
  row: Transaction,
  previous: ReturnType<FinancialPlan["annotation"]>,
  data: AnnotationData,
  actor: string,
  now: string,
) {
  data = canonicalAnnotation(data);
  if (
    previous &&
    canonicalJson(canonicalAnnotation(previous.data)) === canonicalJson(data)
  ) {
    return previous;
  }
  const value = {
    transactionId: row.id,
    version: nextVersion(previous?.version ?? 0),
    data,
    updatedAt: now,
  };
  plan.setAnnotation(value);
  plan.event({
    transactionId: row.id,
    type: "annotation.updated",
    createdAt: value.updatedAt,
    actor,
    before: previous
      ? { version: previous.version, data: previous.data }
      : null,
    after: { version: value.version, data: value.data },
  });
  const beforeReview = reviewState(row, previous?.data);
  const afterReview = reviewState(row, value.data);
  if (
    JSON.stringify(beforeReview) === JSON.stringify(afterReview) ||
    (!beforeReview.required && !afterReview.required)
  ) {
    return value;
  }
  plan.event({
    transactionId: row.id,
    type: afterReview.required
      ? "transaction.review_required"
      : "transaction.review_resolved",
    createdAt: value.updatedAt,
    actor,
    before: beforeReview,
    after: afterReview,
  });
  return value;
}

export function planAnnotation(
  plan: FinancialPlan,
  input: z.input<typeof editSchema>,
  now: string,
) {
  const edit = editSchema.parse(input);
  const row = annotationTarget(plan, edit.transactionId);
  const previous = plan.annotation(row.id);
  if ((previous?.version ?? 0) !== edit.expectedVersion) {
    throw new ConflictError("Annotation version conflict");
  }
  if (
    edit.review !== undefined &&
    edit.expectedTransactionVersion !== row.version
  ) {
    throw new ConflictError("Transaction version conflict");
  }
  return commitAnnotation(
    plan,
    row,
    previous,
    patchedDocument(previous?.data, edit, row),
    edit.actor,
    now,
  );
}

const appliedAnnotationSchema = z.object({
  version: z.number(),
  data: annotationSchema,
});

/** Undo restores the exact previous document, including its historical review basis. */
export function planUndoAnnotation(
  plan: FinancialPlan,
  event: LedgerEvent | undefined,
  input: { eventId: number; expectedVersion: number },
  now: string,
) {
  if (!event || event.type !== "annotation.updated" || !event.transactionId) {
    throw new NotFoundError("Annotation event not found");
  }
  const appliedEdit = appliedAnnotationSchema.parse(event.after);
  if (appliedEdit.version !== input.expectedVersion) {
    throw new ConflictError("Only the current annotation edit can be undone");
  }
  const prior = appliedAnnotationSchema.nullable().parse(event.before);
  const row = annotationTarget(plan, event.transactionId);
  const previous = plan.annotation(row.id);
  if ((previous?.version ?? 0) !== input.expectedVersion) {
    throw new ConflictError("Annotation version conflict");
  }
  return commitAnnotation(
    plan,
    row,
    previous,
    prior?.data ?? annotationSchema.parse({}),
    "user:undo",
    now,
  );
}
