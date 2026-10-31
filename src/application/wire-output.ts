import { z } from "zod";

import { type Account, accountSchema } from "../domain/accounts.js";
import { type Card, cardSchema } from "../domain/cards.js";
import { countryCodeSchema } from "../domain/countries.js";
import {
  amountBasisSchema,
  annotationSchema,
  authorizationMethodSchema,
  CANONICAL_TEXT_MAX_LENGTH,
  currencyExchangeSchema,
  currencySchema,
  kindSchema,
  merchantCategoryCodeSchema,
  presenceSchema,
  refreshFailureCodeSchema,
  RESOURCE_ID_MAX_LENGTH,
  sourceAbsenceSchema,
  transactionDateTimeSchema,
  transactionStatusSchema,
  walletSchema,
} from "../domain/model.js";
import { minorToDecimal } from "../domain/money.js";
import { canonicalJson } from "../domain/observations.js";
import type {
  calculateTotals,
  TransactionListView,
  TransactionView,
} from "../domain/read-model.js";
import type {
  Annotation,
  LedgerEvent,
  Transaction,
} from "../domain/records.js";
import { transactionChangedFields } from "../domain/transaction-content.js";
import type { PublicConnection, SyncRun } from "./financial-store.js";
import { listCursorSchema } from "./query-inputs.js";
import {
  FAILURE_REASONS,
  MAX_REFRESH_MONTHS,
  type Refresh,
  REFRESH_STATUSES,
  REFRESH_TRIGGERS,
  type RefreshStartResult,
  SKIP_REASONS,
  WINDOW_STATUSES,
} from "./refreshes.js";

export const OUTPUT_MAX_BYTES = 256 * 1024;

/** Detail lists keep at most this many of their last items and report what they omit. */
const PREVIEW_MAX_ITEMS = 100;

export function outputByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const textSchema = z.string().max(CANONICAL_TEXT_MAX_LENGTH);
const nullableTextSchema = textSchema.nullable();
const idSchema = z.string().min(1).max(RESOURCE_ID_MAX_LENGTH);
const versionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const dateSchema = z.iso.date().nullable();
export const moneyOutputSchema = z
  .object({
    currency: currencySchema,
    amount: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  })
  .strict();

const annotationDocumentShape = annotationSchema.shape;

/** The owner's decision; the stored basis stays internal. */
const annotationReviewOutputSchema = z
  .object({ status: z.enum(["approved", "needs_review"]) })
  .strict()
  .nullable();

export const annotationOutputSchema = z
  .object({
    version: versionSchema,
    notes: annotationDocumentShape.notes,
    category: annotationDocumentShape.category,
    tags: annotationDocumentShape.tags,
    metadata: annotationDocumentShape.metadata,
    review: annotationReviewOutputSchema,
    updatedAt: textSchema,
  })
  .strict();

const annotationPreviewSchema = z
  .object({
    version: versionSchema,
    category: annotationDocumentShape.category,
    tags: annotationDocumentShape.tags,
    hasNotes: z.boolean(),
    metadata: annotationDocumentShape.metadata,
  })
  .strict()
  .nullable();

const reviewSchema = z
  .object({
    required: z.boolean(),
    status: z.enum(["unreviewed", "approved", "needs_review", "stale"]),
    stale: z.boolean(),
  })
  .strict();

const merchantSchema = z
  .object({
    name: nullableTextSchema,
    providerId: nullableTextSchema,
    categoryCode: merchantCategoryCodeSchema.nullable(),
    addressLine: nullableTextSchema,
    city: nullableTextSchema,
    phone: nullableTextSchema,
    countryCode: countryCodeSchema.nullable(),
  })
  .strict();

export const transactionOutputSchema = z
  .object({
    id: idSchema,
    connectionId: idSchema,
    cardId: idSchema.nullable(),
    status: transactionStatusSchema.describe(
      "Source report status; posted does not establish an account booking.",
    ),
    presence: presenceSchema,
    sourceAbsence: sourceAbsenceSchema.nullable(),
    kind: kindSchema,
    amountBasis: amountBasisSchema,
    amount: moneyOutputSchema
      .nullable()
      .describe(
        "Primary money in its stated amountBasis; does not imply an account booking or billed amount.",
      ),
    originalAmount: moneyOutputSchema.nullable(),
    description: nullableTextSchema,
    // Unknown party role stays explicitly unknown; never infer creditor/debtor.
    counterpartyName: nullableTextSchema,
    merchant: merchantSchema,
    transactionDate: dateSchema,
    transactionDateTime: transactionDateTimeSchema.nullable(),
    bookingDate: dateSchema,
    billingDate: dateSchema,
    cardPresent: z.boolean().nullable(),
    authorizationMethod: authorizationMethodSchema.nullable(),
    wallet: walletSchema.nullable(),
    threeDSecureUsed: z.boolean().nullable(),
    recurring: z.boolean().nullable(),
    currencyExchange: z
      .array(currencyExchangeSchema)
      .max(8)
      .nullable()
      .describe(
        "Stated conversion steps in order, with exact rate text; null when none was stated.",
      ),
    fxFee: moneyOutputSchema
      .nullable()
      .describe(
        "Net conversion fee already included in amount; null when unsupported or unreconciled.",
      ),
    providerTransactionCode: nullableTextSchema,
    installmentCount: versionSchema.nullable(),
    installmentNumber: versionSchema.positive().nullable(),
    purchaseId: idSchema
      .nullable()
      .describe("On billed lines: the purchase they belong to."),
    supersededById: idSchema.nullable(),
    version: versionSchema,
    review: reviewSchema,
    annotation: annotationPreviewSchema,
    detailsTruncated: z
      .literal(true)
      .optional()
      .describe("Present when source text was clipped for output."),
  })
  .strict();

const postingMatchSchema = z
  .object({
    supersededTransactionId: idSchema,
    automatic: z.boolean(),
    policyVersion: textSchema,
    evidence: z
      .object({ runId: idSchema, capturedAt: textSchema })
      .strict()
      .nullable(),
    unlinked: z.boolean(),
  })
  .strict();

export const transactionDetailOutputSchema = transactionOutputSchema.extend({
  additionalInformation: z.array(textSchema).max(PREVIEW_MAX_ITEMS),
  additionalInformationCount: versionSchema.optional(),
  review: reviewSchema.extend({
    reasons: z.array(textSchema).max(PREVIEW_MAX_ITEMS),
    sourceIssues: z.array(textSchema).max(PREVIEW_MAX_ITEMS),
    pendingPostingCandidateIds: z.array(idSchema).max(PREVIEW_MAX_ITEMS),
    truncated: z.boolean(),
    counts: z
      .object({
        reasons: versionSchema,
        sourceIssues: versionSchema,
        pendingPostingCandidateIds: versionSchema,
      })
      .strict(),
  }),
  source: z
    .object({
      identityStrength: z.enum(["native", "weak", "ambiguous"]),
      firstSeenAt: textSchema,
      lastSeenAt: textSchema,
      lastSyncRunId: idSchema,
    })
    .strict(),
  annotation: annotationOutputSchema.nullable(),
  postingMatch: postingMatchSchema.nullable(),
  diagnosticsTruncated: z.boolean().optional(),
  diagnosticCounts: z
    .object({
      evidence: versionSchema,
    })
    .strict()
    .optional(),
  evidence: z
    .array(z.object({ runId: idSchema, path: textSchema }).strict())
    .max(PREVIEW_MAX_ITEMS)
    .optional(),
});

type TransactionDetailOutput = z.infer<typeof transactionDetailOutputSchema>;

export function presentMoney(
  amountMinor: number | null,
  currency: string | null,
) {
  if (amountMinor === null || currency === null) {
    return null;
  }
  return { currency, amount: minorToDecimal(amountMinor, currency) };
}

/** Source text is bounded for output; clipping is reported as `detailsTruncated`. */
function sourceTextPreview() {
  const preview = {
    clipped: false,
    text(value: string | null | undefined): string | null {
      if (value === null || value === undefined) {
        return null;
      }
      if (value.length <= CANONICAL_TEXT_MAX_LENGTH) {
        return value;
      }
      preview.clipped = true;
      // Do not split a UTF-16 surrogate pair at the display boundary.
      const end = /[\uD800-\uDBFF]/.test(value[CANONICAL_TEXT_MAX_LENGTH - 1]!)
        ? CANONICAL_TEXT_MAX_LENGTH - 1
        : CANONICAL_TEXT_MAX_LENGTH;
      return value.slice(0, end);
    },
  };
  return preview;
}

type CompactTransaction = z.input<typeof transactionOutputSchema>;

type DetailedTransaction = z.input<typeof transactionDetailOutputSchema>;

/**
 * Financial wire fields are deliberate; retained provider JSON never crosses
 * this boundary. Compact unless `detail`; list pages are always compact.
 */
export function presentWireTransaction(
  row: TransactionListView,
): CompactTransaction;
export function presentWireTransaction(
  row: TransactionView,
  detail: boolean,
  includeEvidence?: boolean,
): CompactTransaction | DetailedTransaction;

export function presentWireTransaction(
  ...args:
    | [row: TransactionListView]
    | [
        row: TransactionView,
        detail: boolean,
        includeEvidence?: boolean | undefined,
      ]
): CompactTransaction | DetailedTransaction {
  const [row] = args;
  const source = sourceTextPreview();
  const transaction = {
    id: row.id,
    connectionId: row.connectionId,
    cardId: row.cardId,
    status: row.status,
    presence: row.presence,
    sourceAbsence: row.sourceAbsence ?? null,
    kind: row.kind,
    amountBasis: row.amountBasis,
    amount: presentMoney(row.amountMinor, row.currency),
    originalAmount: presentMoney(row.originalAmountMinor, row.originalCurrency),
    description: row.description,
    counterpartyName: row.counterpartyName,
    merchant: {
      name: row.merchantName,
      providerId: row.merchantProviderId,
      categoryCode: row.merchantCategoryCode,
      addressLine: source.text(row.details.merchant.address),
      city: source.text(row.details.merchant.city),
      phone: source.text(row.details.merchant.phone),
      countryCode: row.details.merchant.countryCode ?? null,
    },
    transactionDate: row.transactionDate,
    transactionDateTime: row.details.transactionDateTime ?? null,
    bookingDate: row.bookingDate,
    billingDate: row.billingDate,
    cardPresent: row.cardPresent,
    authorizationMethod: row.authorizationMethod,
    wallet: row.wallet,
    threeDSecureUsed: row.threeDSecureUsed,
    recurring: row.recurring,
    currencyExchange: row.details.currencyExchange ?? null,
    fxFee: presentMoney(row.fxFeeMinor, row.fxFeeCurrency),
    providerTransactionCode: row.providerTransactionCode,
    installmentCount: row.installmentCount,
    installmentNumber: row.installmentNumber,
    purchaseId: row.purchaseId,
    supersededById: row.supersededById,
    version: row.version,
    review: {
      required: row.reviewRequired,
      status: row.reviewStatus,
      stale: row.reviewStale,
    },
  };
  if (args.length === 1 || !args[1]) {
    return {
      ...transaction,
      annotation:
        row.annotation === null
          ? null
          : {
              version: row.annotation.version,
              category: row.annotation.data.category,
              tags: row.annotation.data.tags,
              hasNotes: row.annotation.data.notes !== null,
              metadata: row.annotation.data.metadata,
            },
      ...(source.clipped ? { detailsTruncated: true as const } : {}),
    };
  }
  const [full, , includeEvidence = false] = args;
  // Explanatory prose is detail-only, keeping list pages lean.
  const information = full.details.additionalInformation ?? [];
  const additionalInformation = information
    .slice(-PREVIEW_MAX_ITEMS)
    .map((item) => source.text(item)!);
  const candidates = reviewPreview(full.pendingPostingCandidates, idSchema);
  const reasons = reviewPreview(full.reviewReasons, textSchema);
  const issues = reviewPreview(full.sourceIssues, textSchema);
  const link = full.details.postingLink;
  const operational: TransactionDetailOutput = {
    ...transaction,
    additionalInformation,
    ...(information.length > PREVIEW_MAX_ITEMS
      ? { additionalInformationCount: information.length }
      : {}),
    review: {
      ...transaction.review,
      reasons: reasons.items,
      sourceIssues: issues.items,
      pendingPostingCandidateIds: candidates.items,
      truncated: candidates.truncated || reasons.truncated || issues.truncated,
      counts: {
        reasons: full.reviewReasons.length,
        sourceIssues: full.sourceIssues.length,
        pendingPostingCandidateIds: full.pendingPostingCandidates.length,
      },
    },
    source: {
      identityStrength: full.identityStrength,
      firstSeenAt: full.firstSeenAt,
      lastSeenAt: full.lastSeenAt,
      lastSyncRunId: full.lastSeenRunId,
    },
    annotation:
      full.annotation === null ? null : presentAnnotation(full.annotation),
    postingMatch: link
      ? {
          supersededTransactionId: link.postedId,
          automatic: link.automatic,
          policyVersion: link.policyVersion,
          evidence: link.evidence,
          unlinked: link.split !== undefined,
        }
      : null,
    ...(source.clipped || information.length > PREVIEW_MAX_ITEMS
      ? { detailsTruncated: true as const }
      : {}),
  };
  fitSourceFacts(operational, information.length);
  fitReviewContext(operational);
  if (!includeEvidence) {
    return operational;
  }
  return presentDiagnostics(full, operational);
}

/** Exact actionable IDs/codes remain bounded and explicitly incomplete when omitted. */
function reviewPreview(items: string[], schema: z.ZodType<string>) {
  const valid = items.filter((item) => schema.safeParse(item).success);
  return {
    items: valid.slice(-PREVIEW_MAX_ITEMS),
    truncated:
      valid.length !== items.length || valid.length > PREVIEW_MAX_ITEMS,
  };
}

function trimLargestPreview(arrays: unknown[][]): boolean {
  const remaining = arrays
    .filter((items) => items.length > 0)
    .map((items) => ({ items, bytes: outputByteLength(items) }));
  remaining.sort((left, right) => right.bytes - left.bytes);
  const largest = remaining[0]?.items;
  if (!largest) {
    return false;
  }
  largest.splice(0, Math.ceil(largest.length / 2));
  return true;
}

function fitReviewContext(preview: TransactionDetailOutput): void {
  const arrays = [
    preview.review.pendingPostingCandidateIds,
    preview.review.reasons,
    preview.review.sourceIssues,
  ];
  while (
    outputByteLength({ transaction: preview }) > OUTPUT_MAX_BYTES &&
    trimLargestPreview(arrays)
  ) {
    preview.review.truncated = true;
  }
}

function fitSourceFacts(
  preview: TransactionDetailOutput,
  informationCount: number,
): void {
  while (outputByteLength({ transaction: preview }) > OUTPUT_MAX_BYTES) {
    preview.detailsTruncated = true;
    if (trimLargestPreview([preview.additionalInformation])) {
      preview.additionalInformationCount = informationCount;
      continue;
    }
    preview.merchant = {
      ...preview.merchant,
      addressLine: null,
      city: null,
      phone: null,
    };
    break;
  }
}

/** Diagnostic previews can shrink; source facts retain their own truncation signal. */
function presentDiagnostics(
  row: TransactionView,
  operational: TransactionDetailOutput,
) {
  let truncated = false;

  function tailPreview<T>(
    items: T[],
    representable: (item: T) => boolean = () => true,
  ): T[] {
    const valid = items.filter(representable);
    if (valid.length !== items.length || valid.length > PREVIEW_MAX_ITEMS) {
      truncated = true;
    }
    return valid.slice(-PREVIEW_MAX_ITEMS);
  }

  const preview: TransactionDetailOutput = {
    ...operational,
    diagnosticsTruncated: false,
    diagnosticCounts: {
      evidence: row.details.sourceRefs.length,
    },
    // IDs and paths remain exact. An unrepresentable reference is omitted, never shortened.
    evidence: tailPreview(
      row.details.sourceRefs,
      (reference) =>
        idSchema.safeParse(reference.runId).success &&
        textSchema.safeParse(reference.path).success,
    ),
  };
  preview.diagnosticsTruncated = truncated;
  const arrays: unknown[][] = [preview.evidence!];
  while (outputByteLength({ transaction: preview }) > OUTPUT_MAX_BYTES) {
    preview.diagnosticsTruncated = true;
    if (!trimLargestPreview(arrays)) {
      break;
    }
  }
  fitSourceFacts(preview, row.details.additionalInformation?.length ?? 0);
  fitReviewContext(preview);
  return preview;
}

/** A refresh without its windows, as lists and connections show it. */
export const refreshSummaryOutputSchema = z
  .object({
    id: idSchema,
    connectionId: idSchema,
    trigger: z.enum(REFRESH_TRIGGERS),
    status: z.enum(REFRESH_STATUSES),
    skipReason: z.enum(SKIP_REASONS).nullable(),
    range: z
      .object({ from: z.iso.date(), to: z.iso.date() })
      .strict()
      .nullable(),
    scheduledAt: nullableTextSchema,
    createdAt: textSchema,
    startedAt: nullableTextSchema,
    finishedAt: nullableTextSchema,
    requiresAttention: z.boolean(),
    counts: z
      .object({
        captures: versionSchema,
        observed: versionSchema,
        unchangedTransactions: versionSchema,
        unlisted: versionSchema,
        unchanged: versionSchema,
        failures: versionSchema,
        created: versionSchema,
        updated: versionSchema,
      })
      .strict(),
    failureCodes: z
      .array(refreshFailureCodeSchema)
      .max(refreshFailureCodeSchema.options.length),
    failureReason: z.enum(FAILURE_REASONS).nullable(),
    missed: z
      .object({ through: textSchema, count: versionSchema })
      .strict()
      .nullable(),
  })
  .strict();
export const refreshOutputSchema = refreshSummaryOutputSchema
  .extend({
    windows: z
      .array(
        z
          .object({
            from: z.iso.date(),
            to: z.iso.date(),
            status: z.enum(WINDOW_STATUSES),
          })
          .strict(),
      )
      .max(MAX_REFRESH_MONTHS),
  })
  .strict();
export const refreshReadOutputSchema = z
  .object({ refresh: refreshOutputSchema })
  .strict();
export const refreshListOutputSchema = listOutputSchema(
  refreshSummaryOutputSchema,
  100,
);
/** One connection's start, or every connection's when none was named. */
export const refreshStartOutputSchema = z
  .object({
    refresh: refreshOutputSchema.optional(),
    refreshes: z
      .array(
        z
          .object({
            connectionId: idSchema,
            reason: z.enum(SKIP_REASONS).nullable(),
            refresh: refreshSummaryOutputSchema.nullable(),
          })
          .strict(),
      )
      .max(1000)
      .optional(),
  })
  .strict()
  .refine(
    (output) =>
      (output.refresh === undefined) !== (output.refreshes === undefined),
  );

export const connectionOutputSchema = z
  .object({
    id: idSchema,
    provider: textSchema,
    displayName: textSchema,
    createdAt: textSchema,
    latestRefresh: refreshSummaryOutputSchema.nullable(),
  })
  .strict();

export function presentConnection(connection: PublicConnection) {
  return {
    ...connection,
    latestRefresh:
      connection.latestRefresh && presentRefresh(connection.latestRefresh),
  };
}

export const connectionReadOutputSchema = z
  .object({ connection: connectionOutputSchema })
  .strict();

/** Browsing lists: nextCursor is null exactly when hasMore is false. */
function listOutputSchema<Item extends z.ZodType>(item: Item, max: number) {
  return z
    .object({
      data: z.array(item).max(max),
      hasMore: z.boolean(),
      nextCursor: listCursorSchema.nullable(),
    })
    .strict()
    .refine((page) => page.hasMore === (page.nextCursor !== null));
}

export const connectionListOutputSchema = listOutputSchema(
  connectionOutputSchema,
  1000,
);
/** Public card: the provider key and private attributes never leave storage. */
export const cardOutputSchema = cardSchema.omit({
  providerKey: true,
  attributes: true,
});
export const cardListOutputSchema = listOutputSchema(cardOutputSchema, 200);
export const cardReadOutputSchema = z
  .object({ card: cardOutputSchema })
  .strict();

export function presentCard(card: Card): z.infer<typeof cardOutputSchema> {
  return {
    id: card.id,
    connectionId: card.connectionId,
    billingAccountId: card.billingAccountId,
    last4: card.last4,
    displayName: card.displayName,
    createdAt: card.createdAt,
    lastSeenAt: card.lastSeenAt,
  };
}

/** Public account: the provider key never leaves storage. */
export const accountOutputSchema = accountSchema.omit({ providerKey: true });
export const accountListOutputSchema = listOutputSchema(
  accountOutputSchema,
  200,
);
export const accountReadOutputSchema = z
  .object({ account: accountOutputSchema })
  .strict();

export function presentAccount(
  account: Account,
): z.infer<typeof accountOutputSchema> {
  return {
    id: account.id,
    connectionId: account.connectionId,
    type: account.type,
    institutionName: account.institutionName,
    mask: account.mask,
    displayName: account.displayName,
    createdAt: account.createdAt,
    lastSeenAt: account.lastSeenAt,
  };
}

export const transactionListOutputSchema = listOutputSchema(
  transactionOutputSchema,
  200,
);
export const transactionReadOutputSchema = z
  .object({
    transaction: z.union([
      transactionOutputSchema,
      transactionDetailOutputSchema,
    ]),
  })
  .strict();
const transactionReceiptSchema = z
  .object({ id: idSchema, version: versionSchema })
  .strict();
const annotationReceiptSchema = z
  .object({ transactionId: idSchema, version: versionSchema })
  .strict();

export const annotationWriteOutputSchema = z
  .object({ annotation: annotationReceiptSchema })
  .strict();
export const transactionWriteOutputSchema = z
  .object({ transaction: transactionReceiptSchema })
  .strict();
export const unlinkOutputSchema = z
  .object({
    pending: transactionReceiptSchema,
    posted: transactionReceiptSchema,
  })
  .strict();

export const totalsOutputSchema = z
  .object({
    // spending groups carry amountBasis; billing groups are per currency only.
    totals: z
      .array(
        moneyOutputSchema
          .extend({ amountBasis: amountBasisSchema.optional() })
          .strict(),
      )
      .max(100),
    fxFees: z.array(moneyOutputSchema).max(100),
    fxFeeUnknownCount: versionSchema,
    includedCount: versionSchema,
    excludedCount: versionSchema,
    excluded: z
      .object({
        pending: versionSchema,
        transferOrIncome: versionSchema,
        retiredOrRemoved: versionSchema,
        sourceAbsent: versionSchema,
        unresolved: versionSchema,
        authorization: versionSchema,
      })
      .strict(),
  })
  .strict();

export function presentWireTotals(result: ReturnType<typeof calculateTotals>) {
  return {
    totals: result.totals.map((group) => ({
      ...presentMoney(group.amountMinor, group.currency)!,
      ...(group.amountBasis !== null && { amountBasis: group.amountBasis }),
    })),
    fxFees: result.fxFees.map((fee) =>
      presentMoney(fee.amountMinor, fee.currency)!,
    ),
    fxFeeUnknownCount: result.fxFeeUnknownCount,
    includedCount: result.includedCount,
    excludedCount: result.excludedCount,
    excluded: result.excluded,
  };
}

const changedFieldMap = transactionChangedFields;

const changedFieldNames = [...new Set(Object.values(changedFieldMap))];
const changedFieldSchema = z.enum(changedFieldNames);
const baselineSummarySchema = z.object({
  transactionCount: versionSchema,
  historical: z.boolean().default(false),
});

const refreshReferenceSchema = z.object({ refreshId: idSchema });

export const eventOutputSchema = z
  .object({
    id: versionSchema,
    type: textSchema,
    connectionId: idSchema,
    transactionId: idSchema.nullable(),
    syncRunId: idSchema.nullable(),
    createdAt: textSchema,
    actor: textSchema,
    changedFields: z
      .array(changedFieldSchema)
      .max(changedFieldNames.length)
      .optional(),
    summary: baselineSummarySchema.strict().optional(),
    refreshId: idSchema.optional(),
  })
  .strict();

/** The event feed's nextCursor is always a resumable checkpoint. */
export const eventListOutputSchema = z
  .object({
    data: z.array(eventOutputSchema).max(200),
    hasMore: z.boolean(),
    nextCursor: listCursorSchema,
  })
  .strict();

/** Public names of the fields a transaction update changed, from both stored states. */
function changedWireFields(row: LedgerEvent) {
  const { before, after } = row;
  if (
    row.type !== "transaction.updated" ||
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object"
  ) {
    return [];
  }
  return [
    ...new Set(
      Object.entries(changedFieldMap)
        .filter(
          ([key]) =>
            Object.hasOwn(before, key) &&
            Object.hasOwn(after, key) &&
            canonicalJson(Reflect.get(before, key)) !==
              canonicalJson(Reflect.get(after, key)),
        )
        .map(([, field]) => field),
    ),
  ];
}

export function presentWireEvent(row: LedgerEvent) {
  const changedFields = changedWireFields(row);
  const summary =
    row.type === "sync.baseline"
      ? baselineSummarySchema.safeParse(row.after)
      : undefined;
  // Thin like every event: a refresh event names only the refresh to refetch.
  const refresh = row.type.startsWith("refresh.")
    ? refreshReferenceSchema.safeParse(row.after)
    : undefined;
  return {
    id: row.id,
    type: row.type,
    connectionId: row.connectionId,
    transactionId: row.transactionId,
    syncRunId: row.runId,
    createdAt: row.createdAt,
    actor: row.actor,
    ...(changedFields.length > 0 && { changedFields }),
    ...(summary?.success && { summary: summary.data }),
    ...(refresh?.success && { refreshId: refresh.data.refreshId }),
  };
}

export const syncRunOutputSchema = z
  .object({
    id: idSchema,
    connectionId: idSchema,
    status: z.enum(["started", "completed", "partial", "failed"]),
    startedAt: textSchema,
    finishedAt: nullableTextSchema,
    appliedAt: nullableTextSchema,
    collectorVersion: textSchema,
    parserVersion: textSchema,
    refreshId: idSchema.nullable(),
  })
  .strict();
export const syncRunListOutputSchema = listOutputSchema(
  syncRunOutputSchema,
  100,
);

export function presentSyncRun(run: SyncRun) {
  return {
    id: run.id,
    connectionId: run.connectionId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.completedAt,
    appliedAt: run.appliedAt,
    collectorVersion: run.collectorVersion,
    parserVersion: run.parserVersion,
    refreshId: run.refreshId,
  };
}

export function presentRefresh(refresh: Refresh) {
  const {
    occurrence: _occurrence,
    windows: _windows,
    providerStopReason: _providerStopReason,
    hasAcceptedEvidence: _hasAcceptedEvidence,
    ...summary
  } = refresh;
  return summary;
}

export function presentRefreshDetail(refresh: Refresh) {
  return {
    ...presentRefresh(refresh),
    windows: refresh.windows.map(({ from, to, status }) => ({
      from,
      to,
      status,
    })),
  };
}

export function presentRefreshStart(result: RefreshStartResult) {
  return {
    connectionId: result.connectionId,
    reason: result.reason,
    refresh: result.refresh && presentRefresh(result.refresh),
  };
}

function presentAnnotation(annotation: Annotation) {
  const { notes, category, tags, metadata, review } = annotation.data;
  return {
    version: annotation.version,
    notes,
    category,
    tags,
    metadata,
    review: review === null ? null : { status: review.status },
    updatedAt: annotation.updatedAt,
  };
}

export function presentAnnotationReceipt(annotation: Annotation) {
  return {
    transactionId: annotation.transactionId,
    version: annotation.version,
  };
}

export function presentTransactionReceipt(transaction: Transaction) {
  return { id: transaction.id, version: transaction.version };
}
