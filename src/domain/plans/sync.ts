import { z } from "zod";

import {
  collectionFailureCodeSchema,
  isBilledLine,
  jsonObjectSchema,
  paymentContextConflicts,
  type ReconciliationFailureCode,
  reconciliationFailureCodeSchema,
  type RefreshFailureCode,
  RESOURCE_ID_MAX_LENGTH,
  storedPaymentContext,
  type TransactionDetails,
  type TransactionFacts,
  transactionInputSchema,
} from "../model.js";
import {
  canonicalJson,
  retainObservations,
  retainProviderEvidence,
} from "../observations.js";
import {
  currentSourceRowIndices,
  currentSourceRows,
  sortedEvidence,
} from "../provider-evidence.js";
import {
  billedLinesByPurchase,
  inPerspective,
  isLiveBilledLine,
} from "../read-model.js";
import {
  type CollectionFailure,
  type CollectionScope,
  type EventType,
  type FinancialResponse,
  nextVersion,
  type Run,
  type Transaction,
} from "../records.js";
import type { ExtractionResult, SourceAdapter } from "../source-adapter.js";
import {
  changedTransactionContent,
  retainedTransactionEvidence,
  storedProviderEvidence,
  transactionContent,
} from "../transaction-content.js";
import { reviewState } from "./annotation.js";
import { automaticPostingPairs, postingComponents } from "./auto-posting.js";
import { purchaseResolver, resolveTransaction } from "./catalog.js";
import {
  DUPLICATE_ORDINAL,
  INSTALLMENT_CONFLICT,
  refreshInstallmentParents,
  RESTATEMENT_CONFLICT,
  withoutInstallmentFx,
} from "./installments.js";
import {
  planPosting,
  postingRejected,
  refreshDuplicatePlans,
} from "./lifecycle.js";
import { type DeferredCandidate, FinancialPlan } from "./state.js";

const scopeSchema = z
  .object({
    kind: z.enum(["recent", "history"]),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    windowFrom: z.iso.date().optional(),
    windowTo: z.iso.date().optional(),
    month: z
      .string()
      .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/)
      .optional(),
    cardKey: z.string().min(1).optional(),
    cardKeys: z.array(z.string().min(1)).min(1).optional(),
    filters: jsonObjectSchema.optional(),
  })
  .strict()
  .refine(
    (scope) => !scope.from || !scope.to || scope.from <= scope.to,
    "Invalid collection date range",
  )
  .refine(
    (scope) =>
      (scope.windowFrom === undefined) === (scope.windowTo === undefined),
    "Nominal window boundaries must be supplied together",
  )
  .refine(
    (scope) =>
      !scope.windowFrom ||
      !scope.windowTo ||
      scope.windowFrom <= scope.windowTo,
    "Invalid nominal collection window",
  )
  .refine(
    (scope) =>
      !scope.windowFrom ||
      !scope.windowTo ||
      Boolean(
        scope.from &&
        scope.to &&
        scope.from <= scope.windowFrom &&
        scope.to >= scope.windowTo,
      ),
    "The nominal window must be contained in actual request bounds",
  );

const responseSchema = z
  .object({
    accountKey: z.string().min(1),
    endpoint: z.string().min(1),
    capturedAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
    responseText: z.string(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    scope: scopeSchema.optional(),
  })
  .strict();
const failureSchema = z
  .object({
    accountKey: z.string().min(1).nullable(),
    endpoint: z.string().min(1),
    scope: scopeSchema.optional(),
    affectsCoverage: z.literal(false).optional(),
    code: collectionFailureCodeSchema,
  })
  .strict();

export const runSchema = z
  .object({
    runId: z.string().min(1).max(RESOURCE_ID_MAX_LENGTH),
    connectionId: z.string().min(1),
    startedAt: z.iso.datetime({ offset: true }).optional(),
    collectorVersion: z.string().min(1).optional(),
    refreshId: z.string().min(1).max(RESOURCE_ID_MAX_LENGTH).optional(),
    debugArchiveDays: z.number().int().min(1).max(30).optional(),
    responses: z.array(responseSchema),
    failures: z.array(failureSchema).default([]),
  })
  .strict()
  .refine(
    (run) =>
      new Set(run.responses.map((response) => response.accountKey)).size ===
      run.responses.length,
    "A run may contain only one response per account",
  )
  .refine(
    (run) => run.responses.length + run.failures.length > 0,
    "A run needs a response or an explicit collection failure",
  )
  .refine(
    (run) =>
      !run.failures.some(
        (failure) =>
          failure.affectsCoverage !== false &&
          failure.accountKey !== null &&
          run.responses.some(
            (response) => response.accountKey === failure.accountKey,
          ),
      ),
    "An account cannot have both a response and a collection failure in the same run",
  );

export type RunInput = z.input<typeof runSchema>;

export type { SourceAdapter } from "../source-adapter.js";

export interface SyncResult {
  runId: string;
  replayed: boolean;
  /** Transaction identities observed by this run, independently of content writes. */
  observed?: number;
  /** Observed transactions whose retained content did not change. */
  unchanged?: number;
  created: number;
  updated: number;
  unlisted: number;
  status: "completed" | "partial" | "failed";
  failureCode?: ReconciliationFailureCode;
}

/** Bump when shared reconciliation rules change, independently of archived parser versions. */
export const RECONCILIATION_POLICY_VERSION = "auto-posting-v11";

export function reconciliationFailure(warnings: readonly string[]) {
  const failureCode = reconciliationFailureCodeSchema.options.find((code) =>
    warnings.includes(code),
  );
  return failureCode ? { failureCode } : {};
}

/**
 * Why an applied run counts as a failure of its refresh. A capture its
 * extraction rejected has no provider failure, so it is an invalid response.
 */
export function refreshFailureCodes(
  result: Pick<SyncResult, "status" | "failureCode">,
  failures: readonly CollectionFailure[],
  extracted: readonly { result: Pick<ExtractionResult, "partitions"> }[],
): RefreshFailureCode[] {
  if (result.status === "completed") {
    return [];
  }
  const rejected = extracted.some(({ result }) =>
    result.partitions.some((partition) => !partition.success),
  );
  const codes = [
    ...(result.failureCode ? [result.failureCode] : []),
    ...failures.map((failure) => failure.code),
    ...(rejected ? (["invalid_response"] as const) : []),
  ];
  return codes.length ? codes : ["invalid_response"];
}

const financialFields = [
  "amountMinor",
  "currency",
  "amountBasis",
  "originalAmountMinor",
  "originalCurrency",
  "kind",
  "status",
  "transactionDate",
  "bookingDate",
  "billingDate",
  "installmentCount",
  "installmentNumber",
  "purchaseId",
  "merchantCategoryCode",
  "merchantName",
  "merchantProviderId",
  "description",
  "counterpartyName",
  "fxFeeMinor",
  "fxFeeCurrency",
] as const;

type FinancialFacts = Pick<TransactionFacts, (typeof financialFields)[number]>;

function financialFacts(row: TransactionFacts): FinancialFacts {
  return Object.fromEntries(
    financialFields.map((field) => [field, row[field]]),
  ) as FinancialFacts;
}

function financialState(row: TransactionFacts) {
  return {
    ...financialFacts(row),
    currencyExchange: row.details.currencyExchange ?? null,
  };
}

function declaredIdentityBase(
  row: TransactionFacts,
  provider: string,
): string | undefined {
  const identity = row.details.provider[provider]?.identity;
  if (
    identity &&
    typeof identity === "object" &&
    !Array.isArray(identity) &&
    typeof identity.baseKey === "string"
  ) {
    return identity.baseKey;
  }
  return undefined;
}

function identityBase(row: TransactionFacts, provider: string): string {
  return declaredIdentityBase(row, provider) ?? row.sourceKey;
}

function identityFingerprint(
  row: TransactionFacts,
  includeSource: boolean,
  adapter: SourceAdapter,
): string {
  const namespace = row.details.provider[adapter.provider] ?? {};
  const source = includeSource
    ? currentSourceRows({
        ...retainedTransactionEvidence(row, adapter),
        ...(namespace.identity === undefined
          ? {}
          : { identity: namespace.identity }),
      })
    : undefined;
  return canonicalJson({ financial: financialState(row), source });
}

function groupSignature(
  rows: TransactionFacts[],
  includeSource: boolean,
  adapter: SourceAdapter,
): string {
  return JSON.stringify(
    rows.map((row) => identityFingerprint(row, includeSource, adapter)).sort(),
  );
}

/**
 * A row restated with another row's accepted financial state, including the
 * FX facts held in details.
 */
function withFinancialState(
  row: TransactionFacts,
  accepted: TransactionFacts,
): TransactionFacts {
  const { currencyExchange: _rejected, ...details } = row.details;
  const { currencyExchange } = accepted.details;
  return {
    ...row,
    ...financialFacts(accepted),
    details: currencyExchange ? { ...details, currencyExchange } : details,
  };
}

const POSTING_MATCH_ISSUE = "possible_pending_posted_match";

const DAY_MILLISECONDS = 86_400_000;

function withIssue(issues: readonly string[], issue: string): string[] {
  return [...new Set([...issues, issue])];
}

/** History reads cover the posted partition only. */
function scopeStatuses(scope: CollectionScope | undefined) {
  return scope?.kind === "history"
    ? (["posted"] as const)
    : (["posted", "pending"] as const);
}

function hasComparablePartition(
  result: ExtractionResult,
  status: "posted" | "pending",
): boolean {
  return result.partitions.some(
    (partition) =>
      partition.status === status && partition.success && partition.comparable,
  );
}

function heldLine<T extends TransactionFacts>(row: T): T {
  return {
    ...row,
    amountMinor: null,
    currency: null,
    details: {
      ...row.details,
      issues: withIssue(row.details.issues, DUPLICATE_ORDINAL),
    },
  };
}

/** A live billed line's purchase and ordinal, or null. */
function ordinalSlot(
  row: Pick<
    Transaction,
    "purchaseId" | "installmentNumber" | "presence" | "supersededById"
  >,
): string | null {
  return isLiveBilledLine(row) && row.installmentNumber !== null
    ? JSON.stringify([row.purchaseId, row.installmentNumber])
    : null;
}

/** Only explicitly named enrichment is sticky; source-owned financial facts are not. */
function retainedEnrichment(
  preferred: TransactionDetails,
  fallback: TransactionDetails,
): Pick<TransactionDetails, "merchant"> {
  function retainFields<T extends object>(
    current: T,
    earlier: T,
    fields: readonly (keyof T)[],
  ): T {
    const result = { ...current };
    for (const field of fields) {
      if (result[field] == null && earlier[field] != null) {
        result[field] = earlier[field];
      }
    }
    return result;
  }

  return {
    merchant: retainFields(preferred.merchant, fallback.merchant, [
      "address",
      "phone",
      "city",
      "countryCode",
    ]),
  };
}

function retainEvidence(
  previous: Transaction,
  input: TransactionFacts,
  adapter: SourceAdapter,
): void {
  input.sourceAliases = [
    ...new Set([
      ...previous.sourceAliases,
      ...input.sourceAliases,
      ...(previous.sourceKey === input.sourceKey ? [] : [previous.sourceKey]),
    ]),
  ].filter((key) => key !== input.sourceKey);
  const earlier = previous.details;
  if (earlier.postingLink) {
    input.details.postingLink = structuredClone(earlier.postingLink);
  }
  if (earlier.rejectedPostingKeys) {
    input.details.rejectedPostingKeys = [...earlier.rejectedPostingKeys];
  }
  Object.assign(input.details, retainedEnrichment(input.details, earlier));
  input.details.sourceRefs = retainObservations(
    earlier.sourceRefs,
    input.details.sourceRefs,
  );
  input.details.provider = retainProviderEvidence(
    input.details.provider,
    earlier.provider,
    input.details.provider,
  );
  if (adapter.mergeProviderEvidence) {
    const state =
      adapter.projectProviderState?.(
        input.details.provider[adapter.provider] ?? {},
      ) ?? {};
    const incoming =
      adapter.retainProviderEvidence?.(
        input.details.provider[adapter.provider] ?? {},
      ) ?? {};
    const merged = adapter.mergeProviderEvidence(
      earlier.provider[adapter.provider] ?? {},
      input.details.provider[adapter.provider] ?? {},
    );
    const identity =
      state.identity &&
      typeof state.identity === "object" &&
      !Array.isArray(state.identity)
        ? state.identity
        : {};
    input.details.provider = {
      [adapter.provider]: {
        ...state,
        ...merged,
        identity: {
          ...identity,
          currentRows: currentSourceRowIndices(
            Array.isArray(merged.rows) ? merged.rows : [],
            Array.isArray(incoming.rows) ? incoming.rows : [],
          ),
        },
      },
    };
  }
  if (earlier.pendingPostingCandidates) {
    input.details.pendingPostingCandidates = [
      ...earlier.pendingPostingCandidates,
    ];
  }
  const persistentIssues = earlier.issues.filter(
    (issue) => issue === "ambiguous_identity" || issue === POSTING_MATCH_ISSUE,
  );
  input.details.issues = [
    ...new Set([...input.details.issues, ...persistentIssues]),
  ];
  recordPaymentContextConflicts(input, earlier);
}

/**
 * Record which payment-context fields stay unknown by conflict. The source
 * issue stays while any recorded field is unresolved; a field's conflict
 * clears only when a read states that field.
 */
function recordPaymentContextConflicts(
  input: TransactionFacts,
  earlier: TransactionDetails | undefined,
): void {
  const { paymentContextConflicts: _earlier, ...details } = input.details;
  const conflicts = paymentContextConflicts(
    input,
    earlier?.paymentContextConflicts,
  );
  input.details =
    conflicts.length === 0
      ? details
      : {
          ...details,
          paymentContextConflicts: conflicts,
          issues: withIssue(details.issues, "conflicting_payment_context"),
        };
}

/** Recovery is scoped: success for account A cannot clear a still-failed account B. */
export interface PriorRun {
  id: string;
  status: Run["status"];
  startedAt: string;
  coverage: Run["coverage"];
  snapshot: {
    responses: Omit<FinancialResponse, "responseText">[];
    failures?: CollectionFailure[];
  };
}

function trackCollectionHealth(adapter: SourceAdapter) {
  const failed = new Map<string, number>();
  const successful = new Map<string, number>();
  const fail = (key: string, time: number) => {
    // Import order cannot let an older failure replace newer successful evidence.
    if (time < (successful.get(key) ?? -Infinity)) {
      return;
    }
    failed.set(key, Math.max(failed.get(key) ?? -Infinity, time));
  };
  const recover = (key: string, time: number) => {
    successful.set(key, Math.max(successful.get(key) ?? -Infinity, time));
    const failureTime = failed.get(key);
    if (failureTime !== undefined && time >= failureTime) {
      failed.delete(key);
    }
  };
  const accept = (
    run: Pick<PriorRun, "coverage" | "snapshot" | "startedAt">,
  ) => {
    // The archive's collection time survives replay; application completion does not.
    const started = Date.parse(run.startedAt);
    const attemptTime = Number.isFinite(started) ? started : Infinity;
    for (const part of run.coverage) {
      // An unscoped legacy archive cannot establish recovery of a live collection.
      if (part.success && !part.comparable && !part.scope) {
        continue;
      }
      const response = run.snapshot.responses.find(
        (response) =>
          response.accountKey === part.accountKey &&
          resourceKey(adapter, response.endpoint) ===
            resourceKey(adapter, part.resource) &&
          scopeKey(adapter, response.scope) === scopeKey(adapter, part.scope),
      );
      const evidenceTime = response
        ? Date.parse(response.capturedAt)
        : attemptTime;
      if (part.success && response) {
        recover(`collection:${scopeKey(adapter, part.scope)}`, evidenceTime);
      }
      const key = JSON.stringify([
        part.accountKey,
        resourceKey(adapter, part.resource),
        part.status,
        scopeKey(adapter, part.scope),
      ]);
      if (part.success && response) {
        recover(key, evidenceTime);
      } else if (!part.success) {
        fail(key, evidenceTime);
      }
    }
    for (const failure of run.snapshot.failures ?? []) {
      if (failure.affectsCoverage !== false && failure.accountKey === null) {
        fail(`collection:${scopeKey(adapter, failure.scope)}`, attemptTime);
      }
    }
  };
  return { accept, failedScopes: () => new Set(failed.keys()) };
}

function resourceKey(adapter: SourceAdapter, endpoint: string): string {
  return adapter.resourceKey?.(endpoint) ?? endpoint;
}

function scopeKey(adapter: SourceAdapter, scope?: CollectionScope): string {
  // Deliberate edge overlap changes request bounds, not the planned health unit.
  if (scope?.windowFrom && scope.windowTo) {
    scope = {
      ...scope,
      from: scope.windowFrom,
      to: scope.windowTo,
      windowFrom: undefined,
      windowTo: undefined,
    };
  }
  if (scope) {
    scope = adapter.normalizeScope?.(scope) ?? scope;
  }
  // The requested month/card is the collection unit; caller ranges can narrow on retry.
  if (scope?.kind === "history" && scope.month) {
    return canonicalJson({
      kind: "history",
      month: scope.month,
      ...(scope.cardKey ? { cardKey: scope.cardKey } : {}),
      ...(scope.cardKeys
        ? { cardKeys: [...new Set(scope.cardKeys)].sort() }
        : {}),
      ...(scope.filters ? { filters: scope.filters } : {}),
    });
  }
  if (scope?.cardKeys) {
    return canonicalJson({
      ...scope,
      cardKeys: [...new Set(scope.cardKeys)].sort(),
    });
  }
  return canonicalJson(scope ?? { kind: "recent" });
}

function partitionKey(
  adapter: SourceAdapter,
  accountKey: string,
  endpoint: string,
  scope: CollectionScope | undefined,
  status: "posted" | "pending",
): string {
  return JSON.stringify([
    accountKey,
    resourceKey(adapter, endpoint),
    scopeKey(adapter, scope),
    status,
  ]);
}

function insideRecentHorizon(
  row: Transaction,
  cutoff: string | undefined,
): boolean {
  if (cutoff === undefined) {
    return true;
  }
  const date = row.transactionDate ?? row.bookingDate;
  return date !== null && date >= cutoff;
}

/** Index retained metadata once; raw financial bodies stay in the database. */
function indexRunHistory(runs: PriorRun[], adapter: SourceAdapter) {
  const responsesByRun = new Map(
    runs.map((run) => [
      run.id,
      new Map(
        run.snapshot.responses.map((response) => [
          response.accountKey,
          response,
        ]),
      ),
    ]),
  );
  const knownAccounts = new Set<string>();
  const latestComparable = new Map<string, string>();
  const latestSuccessful = new Map<string, string>();
  const historicalPartitions = new Map<string, Set<string>>();
  for (const run of runs) {
    const historical = new Set<string>();
    historicalPartitions.set(run.id, historical);
    for (const part of run.coverage) {
      if (part.success && !part.comparable) {
        historical.add(JSON.stringify([part.accountKey, part.status]));
      }
      if (!part.success) {
        continue;
      }
      const response = responsesByRun.get(run.id)?.get(part.accountKey);
      if (!response) {
        continue;
      }
      const key = partitionKey(
        adapter,
        part.accountKey,
        part.resource,
        response.scope,
        part.status,
      );
      if (
        response.scope?.kind !== "history" &&
        response.capturedAt > (latestSuccessful.get(key) ?? "")
      ) {
        latestSuccessful.set(key, response.capturedAt);
      }
      if (!part.comparable) {
        continue;
      }
      knownAccounts.add(part.accountKey);
      if (response.capturedAt > (latestComparable.get(key) ?? "")) {
        latestComparable.set(key, response.capturedAt);
      }
    }
  }
  return {
    knownAccounts,
    latestComparable,
    latestSuccessful,
    response(runId: string, accountKey: string) {
      return responsesByRun.get(runId)?.get(accountKey);
    },
    historical(row: Transaction) {
      const scope = responsesByRun
        .get(row.lastSeenRunId)
        ?.get(row.sourceScope)?.scope;
      if (scope) {
        return scope.kind === "history";
      }
      // An unscoped archive has no recent/history context; its run's historical
      // partitions decide.
      return (
        historicalPartitions
          .get(row.lastSeenRunId)
          ?.has(JSON.stringify([row.sourceScope, row.status])) === true
      );
    },
  };
}

/** Snapshot indexes deliberately exclude writes made during this response. */
function indexAccountRows(
  current: Transaction[],
  inputs: TransactionFacts[],
  adapter: SourceAdapter,
  capturedAt: string,
  history: ReturnType<typeof indexRunHistory>,
) {
  const provider = adapter.provider;
  const baseKey = (row: TransactionFacts) => identityBase(row, provider);
  const knownGroups = Map.groupBy(current, baseKey);
  const oldGroups = Map.groupBy(
    current.filter((row) => row.presence === "seen" && !row.supersededById),
    baseKey,
  );
  const newGroups = Map.groupBy(inputs, baseKey);
  const sourceMatches = new Map<
    string,
    { active: Set<Transaction>; inactive: Set<Transaction> }
  >();
  const rowsById = new Map(current.map((row) => [row.id, row]));
  const linkedPostedAliases = new Map<string, Transaction>();
  for (const row of current) {
    if (row.supersededById) {
      continue;
    }
    // A row can own a key both directly and through an alias: count it once.
    for (const key of new Set([row.sourceKey, ...row.sourceAliases])) {
      const bucket = sourceMatches.get(key) ?? {
        active: new Set<Transaction>(),
        inactive: new Set<Transaction>(),
      };
      (row.presence === "seen" ? bucket.active : bucket.inactive).add(row);
      sourceMatches.set(key, bucket);
    }
    if (row.status === "posted") {
      for (const alias of row.sourceAliases) {
        if (!linkedPostedAliases.has(alias)) {
          linkedPostedAliases.set(alias, row);
        }
      }
    }
  }
  const groups = new Map(
    [...newGroups].map(([base, newGroup]) => {
      const oldGroup = oldGroups.get(base) ?? [];
      const knownGroup = knownGroups.get(base) ?? [];
      const oldUncertain = oldGroup.some(
        (row) => row.identityStrength !== "native",
      );
      const uncertain =
        oldUncertain ||
        newGroup.some((row) => row.identityStrength !== "native");
      const includeSource =
        oldGroup.length > 1 ||
        newGroup.length > 1 ||
        [...oldGroup, ...newGroup].some(
          (row) => row.identityStrength === "ambiguous",
        );
      const fingerprints = new Map(
        [
          ...Map.groupBy(uncertain ? oldGroup : [], (row) =>
            identityFingerprint(row, includeSource, adapter),
          ),
        ].map(([key, rows]) => [key, { rows, next: 0 }]),
      );
      return [
        base,
        {
          oldGroup,
          newGroup,
          knownGroup,
          includeSource,
          fingerprints,
          oldUncertain,
          nativeSourceKeys: new Set(
            knownGroup
              .filter(
                (row) =>
                  row.presence !== "removed" &&
                  !row.supersededById &&
                  row.identityStrength === "native" &&
                  declaredIdentityBase(row, provider) === base,
              )
              .map((row) => row.sourceKey),
          ),
          changedFacts:
            uncertain &&
            oldGroup.length > 0 &&
            (oldGroup.length !== newGroup.length ||
              groupSignature(oldGroup, includeSource, adapter) !==
                groupSignature(newGroup, includeSource, adapter)),
          hasNewerCurrent: knownGroup.some(
            (row) => !history.historical(row) && row.lastSeenAt > capturedAt,
          ),
        },
      ] as const;
    }),
  );
  return {
    groups,
    linkedPostedAliases,
    baseKey,
    matches(sourceKey: string) {
      const bucket = sourceMatches.get(sourceKey);
      const available = bucket?.active.size ? bucket.active : bucket?.inactive;
      return {
        count: available?.size ?? 0,
        first: available?.values().next().value,
      };
    },
    consume(id: string) {
      const row = rowsById.get(id);
      if (!row) {
        return;
      }
      for (const key of new Set([row.sourceKey, ...row.sourceAliases])) {
        const bucket = sourceMatches.get(key);
        bucket?.active.delete(row);
        bucket?.inactive.delete(row);
      }
    },
  };
}

interface PostingContinuationOptions {
  current: Transaction[];
  inputs: TransactionFacts[];
  adapter: SourceAdapter;
  result: ExtractionResult;
  response: FinancialResponse;
  history: ReturnType<typeof indexRunHistory>;
  index: ReturnType<typeof indexAccountRows>;
  comparableAbsence: (row: Transaction) => boolean;
  baseline: boolean;
}

function planPostingContinuations({
  current,
  inputs,
  adapter,
  result,
  response,
  history,
  index,
  comparableAbsence,
  baseline,
}: PostingContinuationOptions) {
  const empty = new Map<TransactionFacts, Transaction>();
  if (!adapter.automaticPosting || result.historical || baseline) {
    return empty;
  }
  const freshPartitions = (["posted", "pending"] as const).every((status) => {
    const latest = (
      status === "pending" ? history.latestComparable : history.latestSuccessful
    ).get(
      partitionKey(
        adapter,
        response.accountKey,
        response.endpoint,
        response.scope,
        status,
      ),
    );
    return (
      (!latest || latest < response.capturedAt) &&
      result.partitions.some(
        (partition) =>
          partition.status === status &&
          partition.success &&
          (status === "posted" || partition.comparable),
      )
    );
  });
  if (!freshPartitions) {
    return empty;
  }
  const linkedIds = new Set(
    current.flatMap((row) => (row.supersededById ? [row.supersededById] : [])),
  );
  const active = current.filter(
    (row) =>
      row.presence !== "removed" &&
      !row.supersededById &&
      !linkedIds.has(row.id),
  );
  const nativeKeys = new Set(
    current.flatMap((row) => [row.sourceKey, ...row.sourceAliases]),
  );
  const inputKeys = new Set(
    inputs.flatMap((row) => [row.sourceKey, ...row.sourceAliases]),
  );
  const unknownToConnection = (row: TransactionFacts) =>
    !nativeKeys.has(row.sourceKey) &&
    !row.sourceAliases.some((key) => nativeKeys.has(key));
  const disappearing = new Map(
    active
      .filter(
        (row) =>
          row.status === "pending" &&
          !history.historical(row) &&
          row.presence === "seen" &&
          row.lastSeenAt < response.capturedAt &&
          comparableAbsence(row) &&
          ![row.sourceKey, ...row.sourceAliases].some((key) =>
            inputKeys.has(key),
          ),
      )
      .map((row) => [row, row] as const),
  );
  const newPosted = new Set(
    inputs.filter((input) => {
      if (
        input.status !== "posted" ||
        !unknownToConnection(input) ||
        index.matches(input.sourceKey).count !== 0
      ) {
        return false;
      }
      const group = index.groups.get(index.baseKey(input))!;
      return group.newGroup.length === 1 && group.knownGroup.length === 0;
    }),
  );
  if (newPosted.size === 0) {
    return empty;
  }
  const unlinkedKeys = new Set(
    current
      .filter((row) => !row.supersededById && !linkedIds.has(row.id))
      .flatMap((row) => [row.sourceKey, ...row.sourceAliases]),
  );
  // Current unlinked evidence also blocks after removal: fresh reappearance may
  // restore that identity later in this plan. A listed pending input cannot disappear,
  // and an existing posted input cannot be new, so repeated blockers cannot admit a pair.
  const blockers = inputs.filter(
    (input) =>
      unknownToConnection(input) ||
      [input.sourceKey, ...input.sourceAliases].some((key) =>
        unlinkedKeys.has(key),
      ),
  );
  const { pairs } = automaticPostingPairs(
    [
      ...active.filter((row) => row.status === "pending"),
      ...blockers.filter((row) => row.status === "pending"),
    ],
    [
      ...active.filter((row) => row.status === "posted"),
      ...blockers.filter((row) => row.status === "posted"),
    ],
    disappearing,
    adapter.automaticPosting,
    newPosted,
  );
  return pairs;
}

/** Same card, date and kind, with same-sign amounts in different currencies. */
function crossCurrencyCandidate(
  pending: Transaction,
  posted: Transaction,
): boolean {
  return (
    pending.cardId !== null &&
    pending.cardId === posted.cardId &&
    pending.transactionDate !== null &&
    pending.transactionDate === posted.transactionDate &&
    (pending.kind === "purchase" || pending.kind === "refund") &&
    pending.kind === posted.kind &&
    pending.amountMinor !== null &&
    posted.amountMinor !== null &&
    Math.sign(pending.amountMinor) !== 0 &&
    Math.sign(pending.amountMinor) === Math.sign(posted.amountMinor) &&
    pending.currency !== null &&
    posted.currency !== null &&
    pending.currency !== posted.currency
  );
}

function refreshPendingCandidates(
  plan: FinancialPlan,
  accountRows: Transaction[],
  seenIds: Set<string>,
  postingReview: boolean,
  recentCutoff: string | undefined,
): void {
  const candidates = new Map<string, Set<string>>();

  function addCandidate(pending: Transaction, posted: Transaction) {
    if (postingRejected(pending, posted)) {
      return;
    }
    for (const [id, other] of [
      [pending.id, posted.id],
      [posted.id, pending.id],
    ] as const) {
      const ids = candidates.get(id) ?? new Set<string>();
      ids.add(other);
      candidates.set(id, ids);
    }
  }

  const linkedSurvivors = new Set(
    accountRows.flatMap((row) =>
      row.supersededById ? [row.supersededById] : [],
    ),
  );
  // Role guard: billed lines are never suggested as posting candidates.
  const eligible = accountRows.filter(
    (row) =>
      !row.supersededById && row.presence !== "removed" && !isBilledLine(row),
  );
  const candidateKey = (row: Transaction, day: number) =>
    JSON.stringify([
      row.cardId,
      row.merchantName,
      row.amountMinor,
      row.currency,
      day,
    ]);
  const pendingBuckets = new Map<string, Transaction[]>();
  for (const row of eligible) {
    if (
      row.status !== "pending" ||
      !row.merchantName ||
      row.amountMinor === null ||
      !row.transactionDate
    ) {
      continue;
    }
    const key = candidateKey(
      row,
      Date.parse(row.transactionDate) / DAY_MILLISECONDS,
    );
    const bucket = pendingBuckets.get(key) ?? [];
    bucket.push(row);
    pendingBuckets.set(key, bucket);
  }
  for (const posted of eligible.filter(
    (row) => row.status === "posted" && !linkedSurvivors.has(row.id),
  )) {
    if (
      !posted.transactionDate ||
      !posted.merchantName ||
      posted.amountMinor === null
    ) {
      continue;
    }
    const day = Date.parse(posted.transactionDate) / DAY_MILLISECONDS;
    for (let offset = -7; offset <= 7; offset++) {
      for (const pending of pendingBuckets.get(
        candidateKey(posted, day + offset),
      ) ?? []) {
        if (postingRejected(pending, posted)) {
          continue;
        }
        const previouslyMatched =
          posted.details.pendingPostingCandidates?.includes(pending.id) ||
          pending.details.pendingPostingCandidates?.includes(posted.id);
        if (
          !previouslyMatched &&
          !seenIds.has(posted.id) &&
          !seenIds.has(pending.id)
        ) {
          continue;
        }
        addCandidate(pending, posted);
      }
    }
  }
  if (postingReview) {
    const active = eligible.filter(
      (row) =>
        !linkedSurvivors.has(row.id) && insideRecentHorizon(row, recentCutoff),
    );
    const pendingRows = active.filter((row) => row.status === "pending");
    const postedRows = active.filter((row) => row.status === "posted");
    const groups = postingComponents(pendingRows, postedRows);
    for (const group of groups) {
      for (const pending of group.pending) {
        for (const posted of group.posted) {
          addCandidate(pending, posted);
        }
      }
    }
    // Missing purchase money is review evidence, never a cross-currency amount comparison.
    for (const posted of postedRows) {
      if (
        posted.originalAmountMinor !== null &&
        posted.originalCurrency !== null
      ) {
        continue;
      }
      for (const pending of pendingRows) {
        if (crossCurrencyCandidate(pending, posted)) {
          addCandidate(pending, posted);
        }
      }
    }
  }
  for (const row of accountRows) {
    const ids = [...(candidates.get(row.id) ?? [])].sort();
    const previousIds = row.details.pendingPostingCandidates ?? [];
    const hadIssue = row.details.issues.includes(POSTING_MATCH_ISSUE);
    if (
      canonicalJson(ids) === canonicalJson(previousIds) &&
      hadIssue === ids.length > 0
    ) {
      continue;
    }
    const issues = row.details.issues.filter(
      (issue) => issue !== POSTING_MATCH_ISSUE,
    );
    if (ids.length > 0) {
      issues.push(POSTING_MATCH_ISSUE);
    }
    plan.updateTransaction(row.id, {
      details: { ...row.details, pendingPostingCandidates: ids, issues },
    });
  }
}

function unexpectedHttpStatus(response: FinancialResponse): boolean {
  return (
    response.httpStatus !== undefined &&
    (response.httpStatus < 200 || response.httpStatus > 299)
  );
}

function runStatus(
  successCount: number,
  partitionCount: number,
  failureCount: number,
  hasAcceptedRows: boolean,
): SyncResult["status"] {
  if (successCount === 0) {
    return hasAcceptedRows ? "partial" : "failed";
  }
  return successCount === partitionCount && failureCount === 0
    ? "completed"
    : "partial";
}

/** Extract staged evidence before entering the atomic compare/write. */
export function extractRun(run: Run, adapter: SourceAdapter) {
  const runId = run.id;
  const deferred: DeferredCandidate[] = [];
  const extracted = run.snapshot.responses.map((response) => {
    const result: ExtractionResult = unexpectedHttpStatus(response)
      ? {
          transactions: [],
          partitions: scopeStatuses(response.scope).map((status) => ({
            accountKey: response.accountKey,
            status,
            success: false,
            comparable: false,
          })),
          warnings: ["unexpected_http_status"],
          historical: response.scope?.kind === "history",
        }
      : adapter.extract(response.responseText, {
          accountKey: response.accountKey,
          runId,
          endpoint: response.endpoint,
          ...(response.scope ? { scope: response.scope } : {}),
        });
    if (response.scope?.kind === "history") {
      result.historical = true;
      for (const partition of result.partitions) {
        partition.comparable = false;
      }
    }
    // Validate before taking a write transaction, isolating unsupported rows by partition.
    result.transactions = result.transactions.flatMap((input) => {
      const parsed = transactionInputSchema.safeParse(input);
      if (parsed.success) {
        return [parsed.data];
      }
      const providerEvidence =
        adapter.retainProviderEvidence?.(
          input.details?.provider?.[adapter.provider] ?? {},
        ) ?? {};
      if (Object.keys(providerEvidence).length > 0) {
        deferred.push({
          sourceScope: response.accountKey.includes("\u0000")
            ? ""
            : response.accountKey,
          sourceKey:
            typeof input.sourceKey === "string" &&
            !input.sourceKey.includes("\u0000")
              ? input.sourceKey
              : "",
          reason: "invalid_extracted_row",
          content: { providerEvidence },
        });
      }
      result.warnings.push(`invalid_extracted_${input.status}_row`);
      for (const partition of result.partitions) {
        if (partition.status === input.status) {
          partition.success = false;
          partition.comparable = false;
        }
      }
      return [];
    });
    const recentCutoff =
      adapter.recentComparableDays === undefined
        ? undefined
        : new Date(
            Date.parse(response.capturedAt) -
              adapter.recentComparableDays * DAY_MILLISECONDS,
          )
            .toISOString()
            .slice(0, 10);
    return { response, result, recentCutoff };
  });
  const coverage = extracted.flatMap(({ response, result }) =>
    result.partitions.map((partition) => ({
      ...partition,
      resource: resourceKey(adapter, response.endpoint),
      ...(response.scope ? { scope: response.scope } : {}),
    })),
  );
  const failures = run.snapshot.failures ?? [];
  for (const failure of failures) {
    if (failure.affectsCoverage === false || failure.accountKey === null) {
      continue;
    }
    for (const status of scopeStatuses(failure.scope)) {
      coverage.push({
        accountKey: failure.accountKey,
        status,
        success: false,
        comparable: false,
        resource: resourceKey(adapter, failure.endpoint),
        ...(failure.scope ? { scope: failure.scope } : {}),
      });
    }
  }
  const warnings = [
    ...extracted.flatMap(({ result }) => result.warnings),
    ...failures.map((failure) => failure.code),
  ];
  const successCount = coverage.filter((partition) => partition.success).length;
  const hasAcceptedRows = extracted.some(
    ({ result }) => result.transactions.length > 0,
  );
  const status = runStatus(
    successCount,
    coverage.length,
    failures.length,
    hasAcceptedRows,
  );
  return { extracted, coverage, warnings, status, deferred };
}

type ExtractedResponse = ReturnType<typeof extractRun>["extracted"][number];

/**
 * A comparable recent posted read that returned no posted rows while the
 * account still has live posted rows inside the recent horizon.
 */
function implausiblyEmptyPosted(
  { response, result, recentCutoff }: ExtractedResponse,
  rows: Transaction[],
): boolean {
  return (
    !result.historical &&
    hasComparablePartition(result, "posted") &&
    !result.transactions.some((row) => row.status === "posted") &&
    rows.some(
      (row) =>
        row.sourceScope === response.accountKey &&
        row.status === "posted" &&
        row.presence === "seen" &&
        !row.supersededById &&
        // Billed lines are never comparable for absence.
        !isBilledLine(row) &&
        insideRecentHorizon(row, recentCutoff),
    )
  );
}

/** Every financial operation uses the same content rule, including indirect review changes. */
export function finishTransactionContent(
  plan: FinancialPlan,
  adapter: SourceAdapter | undefined,
  run: Run | undefined,
  now: string,
  observed: Set<string> = new Set(),
  actor = "sync",
): { updated: number; unchanged: number } {
  const runId = run?.id;
  const contentAdapter = adapter ?? {
    provider: plan.snapshot.connection.provider,
    retainProviderEvidence: storedProviderEvidence,
  };
  const runs = new Map<
    string,
    { snapshot: { responses: Omit<FinancialResponse, "responseText">[] } }
  >([
    ...plan.snapshot.priorRuns.map((prior) => [prior.id, prior] as const),
    ...(run ? [[run.id, run] as const] : []),
  ]);
  const references = (row: Transaction) => {
    if (!run || !adapter) {
      return row.details.sourceRefs;
    }
    const latestByOrigin = new Map<string, TransactionDetails["sourceRefs"]>();
    for (const reference of row.details.sourceRefs) {
      const response = runs
        .get(reference.runId)
        ?.snapshot.responses.find(
          (candidate) => candidate.accountKey === row.sourceScope,
        );
      const origin = response
        ? canonicalJson([
            response.accountKey,
            resourceKey(adapter, response.endpoint),
            scopeKey(adapter, response.scope),
          ])
        : reference.runId;
      const prior = latestByOrigin.get(origin);
      if (prior?.[0]?.runId === reference.runId) {
        if (!prior.some((item) => item.path === reference.path)) {
          prior.push(reference);
        }
      } else {
        latestByOrigin.set(origin, [reference]);
      }
    }
    return [...latestByOrigin.values()].flat();
  };
  const originals = new Map(plan.snapshot.rows.map((row) => [row.id, row]));
  const changedIds = new Set<string>();
  for (const [id, current] of plan.transactionWrites) {
    const previous = originals.get(id);
    current.details.sourceRefs = references(current);
    if (current.details.additionalInformation) {
      current.details.additionalInformation = sortedEvidence(
        current.details.additionalInformation,
      );
    }
    current.details.issues = sortedEvidence([
      ...new Set(current.details.issues),
    ]);
    if (adapter) {
      const namespace = current.details.provider[adapter.provider] ?? {};
      const projected = {
        ...adapter.projectProviderState?.(namespace),
        ...adapter.retainProviderEvidence(namespace),
      };
      current.details.provider = Object.keys(projected).length
        ? { [adapter.provider]: projected }
        : {};
      const pending = current.details.postingLink?.pending;
      if (pending) {
        pending.details.sourceRefs = references(pending);
        const pendingEvidence =
          pending.details.provider[adapter.provider] ?? {};
        const projectedPending = {
          ...adapter.projectProviderState?.(pendingEvidence),
          ...adapter.retainProviderEvidence(pendingEvidence),
        };
        pending.details.provider = Object.keys(projectedPending).length
          ? { [adapter.provider]: projectedPending }
          : {};
      }
    }
    if (!previous) {
      continue;
    }
    const changes = changedTransactionContent(
      transactionContent(previous, contentAdapter),
      transactionContent(current, contentAdapter),
    );
    const changed = Object.keys(changes.after).length > 0;
    const lifecycle = plan.events.some(
      (entry) =>
        entry.transactionId === id &&
        [
          "transaction.posted",
          "transaction.linked",
          "transaction.unlinked",
          "transaction.removed",
          "transaction.restored",
          "transaction.unlisted",
        ].includes(entry.type),
    );
    const posting = plan.events.some(
      (entry) =>
        entry.transactionId === id &&
        [
          "transaction.posted",
          "transaction.linked",
          "transaction.unlinked",
        ].includes(entry.type),
    );
    const updateIndex = plan.events.findIndex(
      (entry) =>
        entry.transactionId === id && entry.type === "transaction.updated",
    );
    const priorUpdate = updateIndex < 0 ? undefined : plan.events[updateIndex];
    const priorReason =
      priorUpdate?.after &&
      typeof priorUpdate.after === "object" &&
      "reason" in priorUpdate.after
        ? priorUpdate.after.reason
        : undefined;
    for (let index = plan.events.length - 1; index >= 0; index--) {
      if (
        plan.events[index]!.transactionId === id &&
        plan.events[index]!.type === "transaction.updated"
      ) {
        plan.events.splice(index, 1);
      }
    }
    if (changed) {
      changedIds.add(id);
      current.version = Math.max(
        current.version,
        nextVersion(previous.version),
      );
      if (!posting) {
        plan.event({
          transactionId: id,
          ...(runId ? { runId } : {}),
          type: "transaction.updated",
          actor,
          createdAt: now,
          before: changes.before,
          after: {
            ...changes.after,
            ...(priorReason === undefined ? {} : { reason: priorReason }),
          },
        });
        if (updateIndex >= 0) {
          const event = plan.events.pop()!;
          plan.events.splice(
            Math.min(updateIndex, plan.events.length),
            0,
            event,
          );
        }
      }
    } else {
      if (!lifecycle) {
        current.version = previous.version;
      }
    }
    const state = (row: Transaction) => {
      const {
        lastSeenAt: _seenAt,
        lastSeenRunId: _run,
        details,
        ...facts
      } = row;
      const { sourceRefs: _refs, ...stateDetails } = details;
      return { ...facts, details: stateDetails };
    };
    if (canonicalJson(state(previous)) === canonicalJson(state(current))) {
      plan.transactionWrites.delete(id);
      plan.observationWrites.set(id, current);
    }
  }
  let unchanged = 0;
  for (const id of observed) {
    const previous = originals.get(id);
    const current = plan.transaction(id);
    if (
      previous &&
      current &&
      !changedIds.has(id) &&
      current.presence === previous.presence &&
      current.supersededById === previous.supersededById
    ) {
      unchanged++;
    }
  }
  return { updated: changedIds.size, unchanged };
}

/** Pure reconciliation against a complete consistent connection snapshot. */
export function planRun(
  plan: FinancialPlan,
  run: Run,
  adapter: SourceAdapter,
  extraction: ReturnType<typeof extractRun>,
  now: string,
  newId: () => string,
): SyncResult {
  const runId = run.id;
  if (run.appliedAt) {
    return {
      runId,
      replayed: true,
      created: 0,
      updated: 0,
      unlisted: 0,
      status: run.status as SyncResult["status"],
      ...reconciliationFailure(run.warnings),
    };
  }
  const { extracted, coverage, warnings, status, deferred } =
    structuredClone(extraction);
  const defer = (
    input: TransactionFacts,
    reason: string,
    cardKey: string | null,
    purchaseKey: string | null,
  ) => {
    const {
      cardId: _cardId,
      purchaseId: _purchaseId,
      ...content
    } = transactionContent(input, adapter);
    plan.deferredCandidates.push({
      sourceScope: input.sourceScope,
      sourceKey: input.sourceKey,
      reason,
      content: { ...content, cardKey, purchaseKey },
    });
  };
  let created = 0;
  let updated = 0;
  let unlisted = 0;
  let baselineCreated = 0;
  const baselineDiscoveryAccounts = new Set<string>();
  const observedIds = new Set<string>();
  const contradictedPlans = new Set<string>();
  const countUnstated = new Set<string>();
  const event = (
    type: EventType,
    id: string | null,
    before: unknown,
    after: unknown,
  ) => {
    plan.event({
      transactionId: id,
      runId,
      type,
      createdAt: now,
      actor: "sync",
      before,
      after,
    });
  };
  const priorRuns = plan.snapshot.priorRuns;
  const beforeRows = plan.orderedRows();
  const history = indexRunHistory(priorRuns, adapter);
  // Rejection applies to the whole run; collection and the CLI build one response per run.
  if (
    adapter.rejectEmptyRecentPosted &&
    extracted.some((entry) => implausiblyEmptyPosted(entry, beforeRows))
  ) {
    const failureCode = reconciliationFailureCodeSchema.enum.implausible_empty;
    // Terminal evidence only: no projection, health transition or later recovery event.
    plan.runUpdate = {
      status: "failed",
      completedAt: now,
      appliedAt: now,
      parserVersion: adapter.parserVersion,
      coverage: [],
      warnings: [...warnings, failureCode],
    };
    return {
      runId,
      replayed: false,
      created: 0,
      updated: 0,
      unlisted: 0,
      status: "failed",
      failureCode,
    };
  }
  plan.deferredCandidates.push(...deferred);
  const knownAccounts = new Set([
    ...history.knownAccounts,
    ...beforeRows.map((row) => row.sourceScope),
  ]);
  const baselineAccounts = new Set(
    run.snapshot.responses
      .map((response) => response.accountKey)
      .filter((accountKey) => !knownAccounts.has(accountKey)),
  );
  const annotationData = new Map(
    [...plan.annotations.values()].map((row) => [row.transactionId, row.data]),
  );
  const beforeReview = new Map(
    beforeRows.map((row) => [
      row.id,
      reviewState(row, annotationData.get(row.id)),
    ]),
  );
  for (const { response, result, recentCutoff } of extracted) {
    const stalePartitions = new Set<"posted" | "pending">();
    for (const status of ["posted", "pending"] as const) {
      const latest = history.latestComparable.get(
        partitionKey(
          adapter,
          response.accountKey,
          response.endpoint,
          response.scope,
          status,
        ),
      );
      if (latest && latest > response.capturedAt) {
        stalePartitions.add(status);
      }
    }
    const current = plan.account(response.accountKey);
    // Billed lines name their purchase by source key; it resolves to the
    // current surviving purchase now, and again when the line is planned, so
    // a purchase first seen in this capture is found once it is written.
    const purchases = purchaseResolver(plan, current);
    // Purchases with live billed lines: a capture that restates one as
    // anything but a plan contradicts its lines.
    const planParents = new Set(billedLinesByPurchase(current).keys());
    const incomingPurchases = new Set(
      result.transactions.flatMap((input) =>
        input.purchaseKey
          ? [JSON.stringify([input.sourceScope, input.purchaseKey])]
          : [],
      ),
    );
    // Normalize association-based facts before identity fingerprints as well as
    // after writes; otherwise a repeated ambiguous capture changes its own key.
    const prepared = result.transactions.map((input) => {
      const resolved = resolveTransaction(plan, input, now, newId);
      const purchaseKey = input.purchaseKey ?? null;
      if (purchaseKey !== null) {
        resolved.purchaseId = purchases.resolve(
          resolved.sourceScope,
          purchaseKey,
        );
      }
      return {
        facts: withoutInstallmentFx(
          resolved,
          purchaseKey === null &&
            ([resolved.sourceKey, ...resolved.sourceAliases].some((key) =>
              incomingPurchases.has(
                JSON.stringify([resolved.sourceScope, key]),
              ),
            ) ||
              planParents.has(
                purchases.resolve(resolved.sourceScope, resolved.sourceKey) ??
                  "",
              )),
        ),
        purchaseKey,
        counterpartyAbsent: input.counterpartyName === undefined,
        cardKey: input.cardKey,
      };
    });
    const inputs = prepared.map(({ facts }) => facts);
    const seenIds = new Set<string>();
    const index = indexAccountRows(
      current,
      inputs,
      adapter,
      response.capturedAt,
      history,
    );
    const comparableAbsence = (previous: Transaction) => {
      // Billed lines are non-comparable: search windows are by purchase date,
      // so a recent window never establishes billing-date coverage.
      if (isBilledLine(previous)) {
        return false;
      }
      const partition = result.partitions.find(
        (part) => part.status === previous.status,
      );
      const lastResponse = history.response(
        previous.lastSeenRunId,
        previous.sourceScope,
      );
      return (
        !result.historical &&
        !stalePartitions.has(previous.status) &&
        partition?.success === true &&
        partition.comparable &&
        insideRecentHorizon(previous, recentCutoff) &&
        previous.lastSeenAt <= response.capturedAt &&
        (!lastResponse ||
          (resourceKey(adapter, lastResponse.endpoint) ===
            resourceKey(adapter, response.endpoint) &&
            scopeKey(adapter, lastResponse.scope) ===
              scopeKey(adapter, response.scope)))
      );
    };
    const continuations = planPostingContinuations({
      current,
      inputs,
      adapter,
      result,
      response,
      history,
      index,
      comparableAbsence,
      baseline: baselineAccounts.has(response.accountKey),
    });
    const markSeen = (id: string, observed = true) => {
      seenIds.add(id);
      if (observed) {
        observedIds.add(id);
      }
      index.consume(id);
    };
    const markedGroups = new Set<Transaction[]>();
    const markGroupSeen = (rows: Transaction[]) => {
      if (markedGroups.has(rows)) {
        return;
      }
      markedGroups.add(rows);
      for (const row of rows) {
        markSeen(row.id, false);
      }
    };
    const reviewedGroups = new Set<string>();
    // Purchases are planned before billed lines, so a line resolves to a
    // purchase first seen in this capture whatever the adapter's row order.
    for (const { facts: input, purchaseKey, cardKey, counterpartyAbsent } of [
      ...prepared.filter((entry) => entry.purchaseKey === null),
      ...prepared.filter((entry) => entry.purchaseKey !== null),
    ]) {
      const linked =
        input.status === "pending"
          ? index.linkedPostedAliases.get(input.sourceKey)
          : undefined;
      if (linked) {
        observedIds.add(linked.id);
        // An accepted authorization alias is supporting evidence, never a downgrade to pending.
        const latest = plan.transaction(linked.id)!;
        plan.updateTransaction(linked.id, {
          details: {
            ...latest.details,
            sourceRefs: retainObservations(
              latest.details.sourceRefs,
              input.details.sourceRefs,
            ),
          },
        });
        continue;
      }
      if (purchaseKey !== null) {
        input.purchaseId ??= purchases.resolve(input.sourceScope, purchaseKey);
        if (input.purchaseId === null) {
          // The planner never links a line to a non-purchase or another scope.
          input.details.issues = withIssue(
            input.details.issues,
            "unresolved_purchase",
          );
        }
      }
      // One identity per ordinal of a purchase. A line that shares its
      // ordinal with another live identity stays held, in whichever capture
      // it is restated, until the owner removes one of them.
      if (input.purchaseId !== null && input.installmentNumber !== null) {
        const slot = JSON.stringify([
          input.purchaseId,
          input.installmentNumber,
        ]);
        const base = identityBase(input, adapter.provider);
        const ordinalTaken = plan
          .account(input.sourceScope)
          .some(
            (row) =>
              ordinalSlot(row) === slot &&
              identityBase(row, adapter.provider) !== base,
          );
        if (ordinalTaken) {
          Object.assign(input, heldLine(input));
        }
      }
      const base = index.baseKey(input);
      const {
        oldGroup,
        newGroup,
        knownGroup,
        includeSource,
        hasNewerCurrent,
        oldUncertain,
        nativeSourceKeys,
        changedFacts,
        fingerprints,
      } = index.groups.get(base)!;
      // Check evidence precedence before even changing identity/review flags.
      if (
        (result.historical || stalePartitions.has(input.status)) &&
        knownGroup.length > 0
      ) {
        // Explicit historical windows can add observations to a verified native identity.
        // They never replace current financial facts, presence, freshness, or identity flags.
        // An identity group may contain several transactions, so enrichment also
        // requires the same native source key.
        const known = knownGroup[0]!;
        const enrichesKnownIdentity =
          response.scope?.kind === "history" &&
          input.identityStrength === "native" &&
          newGroup.length === 1 &&
          knownGroup.length === 1 &&
          known.identityStrength === "native" &&
          !known.supersededById &&
          (known.sourceKey === input.sourceKey ||
            known.sourceAliases.includes(input.sourceKey));
        if (enrichesKnownIdentity) {
          observedIds.add(known.id);
          const previous = plan.transaction(known.id)!;
          plan.updateTransaction(previous.id, {
            details: {
              ...previous.details,
              ...retainedEnrichment(previous.details, input.details),
              sourceRefs: retainObservations(
                previous.details.sourceRefs,
                input.details.sourceRefs,
              ),
              provider: retainProviderEvidence(
                previous.details.provider,
                previous.details.provider,
                input.details.provider,
              ),
            },
          });
        } else {
          defer(input, "historical_identity", cardKey, purchaseKey);
        }
        continue;
      }
      if (hasNewerCurrent) {
        markGroupSeen(knownGroup);
        continue;
      }
      const uncertain = input.identityStrength !== "native" || oldUncertain;
      const changedUncertainSet = uncertain && changedFacts;
      const matches = index.matches(input.sourceKey);
      // Within an unchanged uncertain set, match facts, never an array ordinal.
      const sameFacts = fingerprints.get(
        identityFingerprint(input, includeSource, adapter),
      );
      // A cursor consumes occurrences without shifting a large duplicate bucket.
      if (sameFacts) {
        while (
          sameFacts.next < sameFacts.rows.length &&
          seenIds.has(sameFacts.rows[sameFacts.next]!.id)
        ) {
          sameFacts.next++;
        }
      }
      let previous = changedUncertainSet
        ? undefined
        : uncertain && oldGroup.length > 0
          ? sameFacts?.rows[sameFacts.next]
          : matches.count === 1
            ? matches.first
            : undefined;
      if (
        previous &&
        !history.historical(previous) &&
        previous.lastSeenAt > response.capturedAt
      ) {
        markSeen(previous.id);
        continue;
      }
      const comparable = hasComparablePartition(result, input.status);
      if (
        !comparable &&
        input.identityStrength === "native" &&
        declaredIdentityBase(input, adapter.provider) !== undefined &&
        nativeSourceKeys.size > 0 &&
        !nativeSourceKeys.has(input.sourceKey) &&
        matches.count === 0
      ) {
        // A partial capture cannot distinguish a changed generation identity from
        // a second purchase. Preserve declared evidence separately until comparable.
        markGroupSeen(oldGroup);
        defer(input, "partial_native_identity", cardKey, purchaseKey);
        continue;
      }
      if (changedUncertainSet && !comparable) {
        // Partial observations cannot safely replace the existing uncertain set.
        // Preserve declared evidence separately until identity changes are safe.
        markGroupSeen(oldGroup);
        defer(input, "partial_ambiguous_identity", cardKey, purchaseKey);
        continue;
      }
      if (changedUncertainSet && !reviewedGroups.has(base)) {
        reviewedGroups.add(base);
        for (const old of oldGroup) {
          plan.updateTransaction(old.id, {
            identityStrength: "ambiguous",
            details: {
              ...old.details,
              issues: withIssue(old.details.issues, "ambiguous_identity"),
            },
          });
        }
      }
      if (
        changedUncertainSet ||
        (matches.count > 1 && !uncertain) ||
        previous?.identityStrength === "ambiguous"
      ) {
        const alreadyAmbiguous = input.identityStrength === "ambiguous";
        input.identityStrength = "ambiguous";
        if (!alreadyAmbiguous || changedUncertainSet) {
          input.details.issues = withIssue(
            input.details.issues,
            "ambiguous_identity",
          );
        }
      }
      // Historical archives can add evidence but cannot replace current observations.
      if (previous && (result.historical || hasNewerCurrent)) {
        markSeen(previous.id);
        continue;
      }
      if (!previous && result.historical && matches.count > 0) {
        continue;
      }
      if (
        previous?.presence !== "seen" &&
        input.identityStrength !== "native"
      ) {
        // A disappeared authorization's reappearance is not proof of the same purchase.
        previous = undefined;
      }
      if (previous?.presence === "removed") {
        const removal = plan.snapshot.removals.find(
          (row) => row.transactionId === previous.id,
        );
        if (
          response.capturedAt <= previous.lastSeenAt ||
          (removal && response.capturedAt <= removal.createdAt)
        ) {
          markSeen(previous.id);
          continue;
        }
      }
      const continuation = !previous ? continuations.get(input) : undefined;
      if (continuation) {
        // Retain an audit row without allocating a discovery identity or created event.
        recordPaymentContextConflicts(input, continuation.details);
        const postedId = `posted:${continuation.id}:${continuation.version}`;
        plan.insertTransaction({
          ...input,
          // The survivor takes these facts: absent ones keep the pending row's.
          ...storedPaymentContext(input, continuation),
          id: postedId,
          connectionId: run.connectionId,
          presence: "seen",
          firstSeenAt: response.capturedAt,
          lastSeenAt: response.capturedAt,
          lastSeenRunId: runId,
          version: 1,
          supersededById: null,
        });
        planPosting(
          plan,
          {
            pendingId: continuation.id,
            postedId,
            expectedPendingVersion: continuation.version,
            expectedPostedVersion: 1,
            expectedPendingAnnotationVersion:
              plan.annotation(continuation.id)?.version ?? 0,
            expectedPostedAnnotationVersion: 0,
            reason: "Same-capture posting continuation",
            actor: "system",
          },
          now,
          {
            policyVersion: RECONCILIATION_POLICY_VERSION,
            runId,
            capturedAt: response.capturedAt,
          },
        );
        // Lines later in this capture resolve to the survivor.
        purchases.add(plan.transaction(continuation.id)!);
        markSeen(continuation.id);
        markSeen(postedId);
        updated++;
        continue;
      }
      const id = previous?.id ?? newId();
      markSeen(id);
      if (!previous) {
        recordPaymentContextConflicts(input, undefined);
        plan.insertTransaction({
          ...input,
          ...storedPaymentContext(input, undefined),
          id,
          connectionId: run.connectionId,
          presence:
            (result.historical && response.scope?.kind === "history") ||
            stalePartitions.has(input.status)
              ? "not_returned"
              : "seen",
          firstSeenAt: response.capturedAt,
          lastSeenAt: response.capturedAt,
          lastSeenRunId: runId,
          version: 1,
          supersededById: null,
        });
        purchases.add(plan.transaction(id)!);
        created++;
        if (baselineAccounts.has(input.sourceScope) || result.historical) {
          baselineCreated++;
          baselineDiscoveryAccounts.add(input.sourceScope);
          // Discovery remains addressable without presenting imported history as new spending.
          event("transaction.imported", id, null, null);
        } else {
          event("transaction.created", id, null, {
            ...financialState(input),
            sourceRefs: input.details.sourceRefs,
          });
        }
      } else {
        if (
          counterpartyAbsent &&
          input.identityStrength === "native" &&
          previous.identityStrength === "native" &&
          !input.details.issues.includes("ambiguous_identity") &&
          !previous.details.issues.includes("ambiguous_identity") &&
          input.kind === "transfer" &&
          previous.kind === "transfer"
        ) {
          input.counterpartyName = previous.counterpartyName;
        }
        // Missing plan metadata is not a single-payment assertion. Keep the
        // known count while accepting fresh purchase facts; explicit conflicts
        // keep accepted money and remain reviewable until source resolution.
        const restated =
          planParents.has(previous.id) &&
          purchaseKey === null &&
          inPerspective(input, "billing", false);
        const unknownPlan =
          restated &&
          input.installmentCount === null &&
          input.kind === "purchase" &&
          previous.kind === "purchase" &&
          input.amountBasis === "purchase_commitment" &&
          input.installmentNumber === null;
        // Only recorded provenance survives a capture: an earlier policy also
        // flagged unknown-count captures, which this one no longer contradicts.
        const priorRestatement =
          previous.details.issues.includes(RESTATEMENT_CONFLICT);
        const accepted = withoutInstallmentFx(
          unknownPlan && !priorRestatement
            ? {
                ...input,
                installmentCount: previous.installmentCount,
                billingDate:
                  previous.installmentCount !== null &&
                  previous.installmentCount >= 2
                    ? null
                    : input.billingDate,
              }
            : restated
              ? withFinancialState(input, previous)
              : input,
          planParents.has(previous.id),
        );
        if (unknownPlan && !priorRestatement) {
          countUnstated.add(id);
        }
        if (restated && (!unknownPlan || priorRestatement)) {
          contradictedPlans.add(id);
          accepted.details.issues = withIssue(
            withIssue(accepted.details.issues, INSTALLMENT_CONFLICT),
            RESTATEMENT_CONFLICT,
          );
        }
        retainEvidence(plan.transaction(id)!, accepted, adapter);
        const changed =
          JSON.stringify(financialState(previous)) !==
          JSON.stringify(financialState(accepted));
        plan.updateTransaction(id, {
          ...accepted,
          // Missing payment evidence keeps the stored value; a value or conflict
          // replaces it before the shared content comparison.
          ...storedPaymentContext(accepted, plan.transaction(id)),
          presence: "seen",
          lastSeenAt: response.capturedAt,
          lastSeenRunId: runId,
          version:
            changed || previous.presence !== "seen"
              ? nextVersion(previous.version)
              : previous.version,
        });
        if (changed) {
          updated++;
          event("transaction.updated", id, financialState(previous), {
            ...financialState(accepted),
            sourceRefs: accepted.details.sourceRefs,
          });
        }
        if (previous.presence !== "seen") {
          event(
            "transaction.restored",
            id,
            { presence: previous.presence },
            { presence: "seen" },
          );
        }
      }
    }
    // A line first stored alone is held once another identity states its ordinal.
    for (const group of Map.groupBy(
      plan.account(response.accountKey).filter((row) => ordinalSlot(row)),
      (row) => ordinalSlot(row)!,
    ).values()) {
      const identities = new Set(
        group.map((row) => identityBase(row, adapter.provider)),
      );
      if (identities.size < 2) {
        continue;
      }
      for (const previous of group) {
        if (previous.amountMinor === null) {
          if (!previous.details.issues.includes(DUPLICATE_ORDINAL)) {
            plan.updateTransaction(previous.id, {
              details: heldLine(previous).details,
            });
          }
          continue;
        }
        const held = {
          ...heldLine(previous),
          version: nextVersion(previous.version),
        };
        plan.updateTransaction(previous.id, held);
        updated++;
        event("transaction.updated", previous.id, financialState(previous), {
          ...financialState(held),
          sourceRefs: held.details.sourceRefs,
        });
      }
    }
    // Keep authorization presence evidence separate from the posted survivor's presence.
    for (const row of plan.account(response.accountKey)) {
      const link = row.details.postingLink;
      if (!link || link.split || row.supersededById) {
        continue;
      }
      const pending = structuredClone(link.pending);
      const authorization = inputs.find(
        (input) =>
          input.status === "pending" &&
          link.pendingKeys.includes(input.sourceKey),
      );
      if (authorization) {
        pending.details.sourceRefs = retainObservations(
          pending.details.sourceRefs,
          authorization.details.sourceRefs,
        );
        if (
          !result.historical &&
          !stalePartitions.has("pending") &&
          pending.lastSeenAt <= response.capturedAt
        ) {
          pending.presence = "seen";
          pending.lastSeenAt = response.capturedAt;
          pending.lastSeenRunId = runId;
        }
      } else if (comparableAbsence(pending)) {
        pending.presence = "not_returned";
      }
      plan.updateTransaction(row.id, {
        details: { ...row.details, postingLink: { ...link, pending } },
      });
    }
    for (const previous of current) {
      if (
        !comparableAbsence(previous) ||
        seenIds.has(previous.id) ||
        previous.presence !== "seen" ||
        previous.supersededById
      ) {
        continue;
      }
      plan.updateTransaction(previous.id, {
        presence: "not_returned",
        version: nextVersion(previous.version),
      });
      event(
        "transaction.unlisted",
        previous.id,
        { presence: "seen" },
        { presence: "not_returned" },
      );
      unlisted++;
    }
    // Historical imports never reinterpret current identity evidence.
    if (result.historical || !adapter.pendingPostingCandidates) {
      continue;
    }
    // Remaining similarity is review evidence, including ambiguous automatic components.
    const accountRows = plan.account(response.accountKey);
    refreshPendingCandidates(
      plan,
      accountRows,
      seenIds,
      adapter.automaticPosting !== undefined,
      recentCutoff,
    );
  }
  refreshInstallmentParents(plan, {
    scopes: new Set(
      extracted
        .filter(({ result }) =>
          result.partitions.some(
            (part) => part.status === "posted" && part.success,
          ),
        )
        .map(({ response }) => response.accountKey),
    ),
    contradicted: contradictedPlans,
    countUnstated,
  });
  refreshDuplicatePlans(plan);
  const afterRows = plan.orderedRows();
  const reviewRequiredIds: string[] = [];
  for (const row of afterRows) {
    const after = reviewState(row, annotationData.get(row.id));
    if (after.required && baselineAccounts.has(row.sourceScope)) {
      reviewRequiredIds.push(row.id);
    }
    const before = beforeReview.get(row.id) ?? {
      required: false,
      reasons: [],
      candidates: [],
    };
    if (
      baselineAccounts.has(row.sourceScope) ||
      canonicalJson(before) === canonicalJson(after)
    ) {
      continue;
    }
    if (after.required) {
      event("transaction.review_required", row.id, before, after);
    } else if (before.required) {
      event("transaction.review_resolved", row.id, before, after);
    }
  }
  if (baselineCreated > 0) {
    event("sync.baseline", null, null, {
      transactionCount: baselineCreated,
      accountKeys: [...baselineDiscoveryAccounts].sort(),
      reviewRequiredIds: reviewRequiredIds.sort(),
      ...(extracted.every(({ result }) => result.historical)
        ? { historical: true }
        : {}),
    });
  }
  const previousStatus = priorRuns.at(-1)?.status ?? null;
  if (status !== "completed") {
    event(
      status === "partial" ? "sync.partial" : "sync.failed",
      null,
      { status: previousStatus },
      { status, coverage, warnings },
    );
  }
  const health = trackCollectionHealth(adapter);
  for (const prior of priorRuns) {
    health.accept(prior);
  }
  const previouslyFailed = health.failedScopes();
  health.accept({
    coverage,
    snapshot: run.snapshot,
    startedAt: run.startedAt,
  });
  const stillFailed = health.failedScopes();
  const recoveredScopes = [...previouslyFailed]
    .filter((scope) => !stillFailed.has(scope))
    .sort();
  if (recoveredScopes.length > 0) {
    event(
      "sync.recovered",
      null,
      { status: previousStatus, failedScopes: [...previouslyFailed].sort() },
      { status, recoveredScopes, failedScopes: [...stillFailed].sort() },
    );
  }
  plan.runUpdate = {
    status,
    completedAt: now,
    coverage,
    warnings,
    appliedAt: now,
    parserVersion: adapter.parserVersion,
  };
  const content = finishTransactionContent(
    plan,
    adapter,
    run,
    now,
    observedIds,
  );
  updated = content.updated;
  return {
    runId,
    replayed: false,
    observed: observedIds.size,
    unchanged: content.unchanged,
    created,
    updated,
    unlisted,
    status,
  };
}
