import type { CardDiscovery } from "./cards.js";
import type { CredentialInput, ProviderCredentials } from "./credentials.js";
import type { TransactionFacts, TransactionInput } from "./model.js";
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

/**
 * Provider-neutral continuation evidence. Null means unknown, never false/zero.
 * All fields except abroad/merchantProviderId are required for automatic eligibility.
 * Optional fields compare only when both are known; twins also require equal presence.
 * Codes are opaque provider values, not payment-channel or category semantics.
 */
export interface PostingMatchEvidence {
  merchantName: string | null;
  categoryCode: string | null;
  sourceTypeCode: string | null;
  cardPresent: boolean | null;
  tokenCode: string | null;
  paymentCount: number | null;
  abroad: boolean | null;
  merchantProviderId: string | null;
}

/** Amount roles whose normalized purchase money supports automatic continuation. */
export interface AutomaticPostingCapability {
  pendingAmountBasis: TransactionInput["amountBasis"];
  postedAmountBasis: TransactionInput["amountBasis"];
  /** Pure decoding from retained source evidence; missing/malformed/conflicting => null. */
  evidence(row: TransactionFacts): PostingMatchEvidence | null;
}

/** Collection owns provider paging; adapters project one archived capture at a time. */
export interface SourceAdapter {
  provider: string;
  parserVersion: string;
  /** Exact documented aliases only; raw endpoint context remains in the archive. */
  resourceKey?(endpoint: string): string;
  /** Validate criteria; an optional parsed result preserves provider archive normalization. */
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
  /**
   * The response's source content without per-request noise such as request IDs.
   * Equal values let collection skip archiving an identical repeat capture;
   * omit it to archive every capture.
   */
  contentFingerprint?(responseText: string): string;
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
