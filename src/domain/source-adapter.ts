import type { CardDiscovery } from "./cards.js";
import type { CredentialInput, ProviderCredentials } from "./credentials.js";
import type {
  JsonObject,
  ReadPaymentContext,
  TransactionFacts,
  TransactionInput,
} from "./model.js";
import type {
  CollectionFailure,
  CollectionScope,
  FinancialResponse,
} from "./records.js";

export interface ExtractionContext {
  accountKey: string;
  runId: string;
  endpoint?: string;
  scope?: CollectionScope;
}

export interface ExtractionResult {
  transactions: TransactionInput[];
  partitions: {
    accountKey: string;
    status: "posted" | "pending";
    success: boolean;
    comparable: boolean;
  }[];
  warnings: string[];
  historical: boolean;
}

/** Amount roles whose normalized purchase money supports automatic continuation. */
export interface AutomaticPostingCapability {
  pendingAmountBasis: TransactionInput["amountBasis"];
  postedAmountBasis: TransactionInput["amountBasis"];
  /**
   * Pure source interpretation for a whole plausible component. Reject unknown
   * kinds/issues or insufficient source evidence unless explicitly supported by
   * the provider policy. Rejecting a member vetoes the component, never filters it.
   */
  compatibleGroups(
    pending: readonly TransactionFacts[],
    posted: readonly TransactionFacts[],
  ): boolean;
}

/** Collection owns provider paging; adapters project one captured unit at a time. */
export interface SourceAdapter {
  provider: string;
  parserVersion: string;
  /** Exact documented aliases only; endpoint context remains in the receipt. */
  resourceKey?(endpoint: string): string;
  /** Validate criteria; an optional parsed result preserves provider capture normalization. */
  validateScope?(scope: CollectionScope): CollectionScope | void;
  /** Normalize equivalent request criteria only for health/precedence comparison. */
  normalizeScope?(scope: CollectionScope): CollectionScope;
  /** Similarity can suggest an owner-reviewed posting link. */
  pendingPostingCandidates?: boolean;
  /** Opt in to narrow, reversible same-capture purchase/refund continuation. */
  automaticPosting?: AutomaticPostingCapability;
  /** Compare recent absence only within this many days of capture (UTC dates). */
  recentComparableDays?: number;
  /** Reject a successful empty recent posted partition if comparable posted rows exist. */
  rejectEmptyRecentPosted?: boolean;
  /** Declared source evidence only, projected identically for stored and new rows; return {} to retain none. */
  retainProviderEvidence(evidence: JsonObject): JsonObject;
  /** Adapter-derived reconciliation state, never part of source-content comparison. */
  projectProviderState?(evidence: JsonObject): JsonObject;
  /** Merge declared components from overlapping captures without duplicating observations. */
  mergeProviderEvidence?(
    previous: JsonObject,
    incoming: JsonObject,
  ): JsonObject;
  /** Reinterpret current payment facts with retained optional evidence after component merging. */
  paymentContextFromRetainedEvidence?(input: Readonly<TransactionFacts>):
    | {
        payment: ReadPaymentContext;
        issues: string[];
      }
    | undefined;
  /**
   * Identity groups declare `identity.baseKey`; retained rows preserve their
   * distinguishing source facts. Shared matching uses the current observation.
   */
  extract(responseText: string, context: ExtractionContext): ExtractionResult;
}

export interface CollectionRange {
  from: string;
  to: string;
}

/**
 * Card keys identify one card within a connection, independently of account keys.
 * Adapters must qualify upstream account-scoped IDs before emitting card keys.
 *
 * Card discovery is also account discovery: each card may name the account that
 * pays its bills (`billingAccount`), keyed by a private provider key. Accounts
 * are created only from discovery, never from transactions.
 */
export type CollectionEvent =
  | { type: "card_discovery"; discovery: CardDiscovery }
  | { type: "capture"; capture: FinancialResponse }
  | { type: "failure"; failure: CollectionFailure; fatal: boolean };

/**
 * Provider code owns request windows, pagination, authentication and raw capture.
 * One collector keeps one authenticated provider session across its `collect`
 * calls, logging in again only when the provider rejects or expires it; a new
 * collector starts a new session.
 */
export interface ProviderCollector {
  provider: string;
  collectorVersion: string;
  /**
   * After cancellation, preserve buffered captures and emit an interruption failure
   * whenever requested collection work remains. Work completed before cancellation
   * may drain and finish normally. Make no further provider requests and terminate
   * boundedly; only already-fetched captures and failure metadata may be drained.
   */
  drainsOnAbort?: boolean;
  collect(options: {
    range?: CollectionRange;
    signal?: AbortSignal;
  }): AsyncIterable<CollectionEvent>;
}

export interface ProviderCollectionOptions {
  historyMode?: "monthly" | "search";
  searchWindowMonths?: 1 | 3 | 6 | 12;
  callBudget?: number;
  maxDetails?: number;
  onDiagnostic?: (diagnostic: object) => void;
}

/** Everything the runtime needs from one provider; each provider exports one. */
export interface ProviderDefinition {
  adapter: SourceAdapter;
  credentials: CredentialInput;
  /** Throws ProviderConfigurationError for options this provider does not support. */
  validateCollectionOptions(options: ProviderCollectionOptions): void;
  createCollector(
    credentials: ProviderCredentials,
    options?: ProviderCollectionOptions,
  ): ProviderCollector;
  prepareCapture(
    responseText: string,
    accountKey: string,
  ): Pick<FinancialResponse, "endpoint" | "scope">;
}

/** Safe messages only; callers never surface provider parser errors. */
export class ProviderConfigurationError extends Error {}
