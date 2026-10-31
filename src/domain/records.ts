import { ConflictError } from "./errors.js";
import type {
  AnnotationData,
  CollectionFailureCode,
  JsonObject,
  RefreshFailureCode,
  SourceAbsence,
  SourceEvidence,
  StoredTransactionFacts,
} from "./model.js";
import type { RefreshTrigger } from "./refreshes.js";

/** Requested collection boundaries, not evidence of complete source coverage. */
export interface CollectionScope {
  kind: "recent" | "history";
  from?: string | undefined;
  to?: string | undefined;
  /** Nominal window, when actual request bounds include deliberate overlap. */
  windowFrom?: string | undefined;
  windowTo?: string | undefined;
  month?: string | undefined;
  cardKey?: string | undefined;
  cardKeys?: string[] | undefined;
  /** Provider namespaces, validated by their adapter and retained as safe JSON. */
  filters?: JsonObject | undefined;
}

export interface CollectionFailure {
  accountKey: string | null;
  endpoint: string;
  scope?: CollectionScope | undefined;
  /** Explicitly failed optional enrichment; omitted failures affect financial coverage. */
  affectsCoverage?: false | undefined;
  code: CollectionFailureCode;
}

export interface FinancialResponse {
  accountKey: string;
  endpoint: string;
  capturedAt: string;
  responseText: string;
  httpStatus?: number | undefined;
  scope?: CollectionScope | undefined;
}

export interface Partition {
  accountKey: string;
  resource: string;
  status: "posted" | "pending";
  success: boolean;
  comparable: boolean;
  scope?: CollectionScope | undefined;
}

export interface ConnectionConfig {
  schemaVersion: 1;
  changeCursors?: Record<string, number> | undefined;
  [key: string]: unknown;
}

export interface Connection {
  id: string;
  provider: string;
  displayName: string;
  config: ConnectionConfig;
  createdAt: string;
}

export type Transaction = StoredTransactionFacts & {
  id: string;
  connectionId: string;
  presence: "seen" | "not_returned" | "removed";
  sourceAbsence?: SourceAbsence | undefined;
  sourceEvidence?: SourceEvidence | undefined;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSeenRunId: string;
  version: number;
  supersededById: string | null;
};

/**
 * The version after `version`, for every write that changes a transaction or
 * annotation version. Versions are exact JSON numbers, so a record at the
 * largest safe integer cannot change again.
 */
export function nextVersion(version: number): number {
  if (version >= Number.MAX_SAFE_INTEGER) {
    throw new ConflictError("Version limit reached");
  }
  return version + 1;
}

export interface Annotation {
  transactionId: string;
  version: number;
  data: AnnotationData;
  updatedAt: string;
}

export interface Run {
  id: string;
  connectionId: string;
  startedAt: string;
  completedAt: string | null;
  status: "started" | "completed" | "partial" | "failed";
  collectorVersion: string;
  parserVersion: string;
  snapshot: {
    schemaVersion: 1;
    responses: FinancialResponse[];
    failures?: CollectionFailure[];
  };
  coverage: Partition[];
  warnings: string[];
  appliedAt: string | null;
  /** The refresh that archived this run; null for offline ingestion. */
  refreshId: string | null;
  /** Immutable input identity remains verifiable after a staged body is released. */
  evidenceDigest: string;
  bodyAvailable: boolean;
  bodyRetention: "staged" | "debug" | null;
  bodyExpiresAt: string | null;
}

/** Every ledger event type, dotted resource.action names. Stored types stay extensible text. */
export const EVENT_TYPES = [
  "sync.baseline",
  "sync.partial",
  "sync.failed",
  "sync.recovered",
  "transaction.imported",
  "transaction.created",
  "transaction.updated",
  "transaction.posted",
  "transaction.linked",
  "transaction.unlinked",
  "transaction.removed",
  "transaction.unlisted",
  "transaction.restored",
  "transaction.review_required",
  "transaction.review_resolved",
  "annotation.updated",
  "refresh.failed",
  "refresh.attention_required",
  "refresh.recovered",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * A refresh health event's stored `after` (the finished refresh) and `before`
 * (the connection's previous finished refresh, or null). The feed publishes
 * only `refreshId`; readers refetch the refresh itself.
 */
export interface RefreshHealthDocument {
  refreshId: string;
  trigger: RefreshTrigger;
  status: "completed" | "partial" | "failed";
  failureCodes: RefreshFailureCode[];
  requiresAttention: boolean;
}

export interface LedgerEvent {
  id: number;
  connectionId: string;
  transactionId: string | null;
  runId: string | null;
  type: string;
  createdAt: string;
  actor: string;
  before: unknown;
  after: unknown;
}

/** The plan stamps its connection on every event. */
export type LedgerEventInput = Pick<LedgerEvent, "createdAt" | "actor"> & {
  type: EventType;
} & Partial<
    Omit<LedgerEvent, "id" | "type" | "createdAt" | "actor" | "connectionId">
  >;

export type LedgerEventWrite = LedgerEventInput &
  Pick<LedgerEvent, "connectionId">;
