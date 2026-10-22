import { isBilledLine, type TransactionFacts } from "../model.js";
import { canonicalJson } from "../observations.js";
import type {
  CollectionScope,
  FinancialResponse,
  Partition,
} from "../records.js";
import type { SourceAdapter, SourceCoveragePolicy } from "../source-adapter.js";

const DAY_MILLISECONDS = 86_400_000;

type ResponseMetadata = Omit<FinancialResponse, "responseText">;

type CoveragePartition = Pick<
  Partition,
  "accountKey" | "status" | "success" | "comparable"
> &
  Partial<Pick<Partition, "resource" | "scope">>;

type MembershipFacts = Pick<
  TransactionFacts,
  | "sourceScope"
  | "status"
  | "transactionDate"
  | "bookingDate"
  | "billingDate"
  | "purchaseId"
  | "installmentNumber"
>;

type WindowPolicy = Extract<SourceCoveragePolicy, { kind: "account_window" }>;

interface SnapshotCoverageBase {
  accountKey: string;
  status: "posted" | "pending";
  capturedAt: string;
  resource: string;
  scopeKey: string;
}

/** Reconstructible from retained capture metadata, without a raw response body. */
export type SourceSnapshotCoverage = SnapshotCoverageBase &
  (
    | { kind: "same_origin"; recentCutoff?: string }
    | {
        kind: "account_window";
        dateField: WindowPolicy["dateField"];
        from: string;
        to: string;
        cardKeys?: readonly string[];
        requireOriginMatch?: boolean;
      }
  );

export function resourceKey(adapter: SourceAdapter, endpoint: string): string {
  return adapter.resourceKey?.(endpoint) ?? endpoint;
}

export function scopeKey(
  adapter: SourceAdapter,
  scope?: CollectionScope,
): string {
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

function validDate(value: string): boolean {
  const time = Date.parse(value);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
  );
}

function cutoffDate(capturedAt: string, days: number): string | undefined {
  if (!Number.isSafeInteger(days) || days < 0) {
    return undefined;
  }
  const cutoff = Date.parse(capturedAt) - days * DAY_MILLISECONDS;
  return Number.isFinite(cutoff) && Math.abs(cutoff) <= 8.64e15
    ? new Date(cutoff).toISOString().slice(0, 10)
    : undefined;
}

/** Completeness gates are separate from the source's declared membership domain. */
export function sourceCoverage(
  adapter: SourceAdapter,
  response: ResponseMetadata,
  partition: CoveragePartition,
): SourceSnapshotCoverage | undefined {
  if (
    !partition.success ||
    !partition.comparable ||
    partition.accountKey !== response.accountKey ||
    response.scope?.kind === "history" ||
    !Number.isFinite(Date.parse(response.capturedAt)) ||
    (response.httpStatus !== undefined &&
      (response.httpStatus < 200 || response.httpStatus > 299))
  ) {
    return undefined;
  }
  const resource = resourceKey(adapter, response.endpoint);
  const normalizedScopeKey = scopeKey(adapter, response.scope);
  if (
    (partition.resource !== undefined &&
      resourceKey(adapter, partition.resource) !== resource) ||
    (partition.scope !== undefined &&
      scopeKey(adapter, partition.scope) !== normalizedScopeKey)
  ) {
    return undefined;
  }
  const base: SnapshotCoverageBase = {
    accountKey: response.accountKey,
    status: partition.status,
    capturedAt: response.capturedAt,
    resource,
    scopeKey: normalizedScopeKey,
  };
  const policy = adapter.sourceCoverage;
  if (policy?.statuses && !policy.statuses.includes(partition.status)) {
    return undefined;
  }
  if (!policy || policy.kind === "same_origin") {
    const recentCutoff =
      adapter.recentComparableDays === undefined
        ? undefined
        : cutoffDate(response.capturedAt, adapter.recentComparableDays);
    if (
      adapter.recentComparableDays !== undefined &&
      recentCutoff === undefined
    ) {
      return undefined;
    }
    return {
      ...base,
      kind: "same_origin",
      ...(recentCutoff === undefined ? {} : { recentCutoff }),
    };
  }
  if (!policy.resources.includes(resource)) {
    return undefined;
  }
  let scope = response.scope;
  if (scope) {
    // Retained metadata may predate today's adapter validation. Unknown criteria
    // cannot be promoted into an account-wide absence assertion.
    try {
      scope = adapter.validateScope?.(scope) ?? scope;
      scope = adapter.normalizeScope?.(scope) ?? scope;
    } catch {
      return undefined;
    }
  }
  if (scope?.filters !== undefined || scope?.month !== undefined) {
    return undefined;
  }
  const cutoff = cutoffDate(response.capturedAt, policy.days);
  if (!cutoff) {
    return undefined;
  }
  const captureDate = new Date(response.capturedAt).toISOString().slice(0, 10);
  // Actual request bounds constrain membership; nominal overlap bounds only
  // identify equivalent collection units for health and same-origin matching.
  const { from: requestedFrom, to: requestedTo } = response.scope ?? {};
  if (
    (requestedFrom !== undefined && !validDate(requestedFrom)) ||
    (requestedTo !== undefined && !validDate(requestedTo))
  ) {
    return undefined;
  }
  const from = requestedFrom && requestedFrom > cutoff ? requestedFrom : cutoff;
  const to =
    requestedTo && requestedTo < captureDate ? requestedTo : captureDate;
  if (from > to) {
    return undefined;
  }
  const cardKeys = scope?.cardKey
    ? scope.cardKeys && !scope.cardKeys.includes(scope.cardKey)
      ? []
      : [scope.cardKey]
    : scope?.cardKeys && [...new Set(scope.cardKeys)].sort();
  return {
    ...base,
    kind: "account_window",
    dateField: policy.dateField,
    from,
    to,
    ...(cardKeys === undefined ? {} : { cardKeys }),
    ...(policy.requireOriginMatch ? { requireOriginMatch: true } : {}),
  };
}

/** Membership only: the caller owns chronology, observation and lifecycle state. */
export function snapshotContainsRow(
  adapter: SourceAdapter,
  coverage: SourceSnapshotCoverage,
  row: MembershipFacts,
  lastResponse?: ResponseMetadata,
  providerCardKey?: string | null,
): boolean {
  if (
    row.sourceScope !== coverage.accountKey ||
    row.status !== coverage.status ||
    isBilledLine(row)
  ) {
    return false;
  }
  if (
    (coverage.kind === "same_origin" || coverage.requireOriginMatch) &&
    (!lastResponse ||
      lastResponse.accountKey !== coverage.accountKey ||
      resourceKey(adapter, lastResponse.endpoint) !== coverage.resource ||
      scopeKey(adapter, lastResponse.scope) !== coverage.scopeKey)
  ) {
    return false;
  }
  if (coverage.kind === "account_window") {
    const date = row[coverage.dateField];
    return (
      date !== null &&
      validDate(date) &&
      date >= coverage.from &&
      date <= coverage.to &&
      (coverage.cardKeys === undefined ||
        (providerCardKey != null &&
          coverage.cardKeys.includes(providerCardKey)))
    );
  }
  const date = row.transactionDate ?? row.bookingDate;
  return (
    coverage.recentCutoff === undefined ||
    (date !== null && validDate(date) && date >= coverage.recentCutoff)
  );
}
