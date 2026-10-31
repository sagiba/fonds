import type { Account } from "../accounts.js";
import type { Card } from "../cards.js";
import type { JsonValue, TransactionDetails } from "../model.js";
import type {
  Annotation,
  Connection,
  LedgerEvent,
  LedgerEventInput,
  LedgerEventWrite,
  Run,
  Transaction,
} from "../records.js";
import type { PriorRun, RunHistorySummary } from "./run-history.js";

export type {
  Annotation,
  Connection,
  LedgerEvent,
  LedgerEventInput,
  Run,
} from "../records.js";

/**
 * The columns every sync decision may read of a row it neither writes nor
 * compares in depth. Anything else is read only through `FinancialPlan.full`.
 */
export type LedgerFactField =
  | "id"
  | "connectionId"
  | "sourceScope"
  | "cardId"
  | "sourceKey"
  | "sourceAliases"
  | "identityStrength"
  | "status"
  | "presence"
  | "sourceAbsence"
  | "kind"
  | "merchantName"
  | "transactionDate"
  | "bookingDate"
  | "billingDate"
  | "amountMinor"
  | "currency"
  | "amountBasis"
  | "originalAmountMinor"
  | "originalCurrency"
  | "installmentCount"
  | "purchaseId"
  | "installmentNumber"
  | "firstSeenAt"
  | "lastSeenAt"
  | "lastSeenRunId"
  | "version"
  | "supersededById";

/**
 * A stored row loaded without its evidence. It deliberately has no
 * `sourceEvidence`, provider namespace, source references, merchant details
 * or posting-link contents, so code that needs them cannot compile against it.
 */
export type NarrowRow = Pick<Transaction, LedgerFactField> & {
  readonly hydration: "narrow";
  /** `sourceEvidence.identity.retiredFromMatching`, read only through `retiredFromMatching`. */
  readonly retired: boolean;
  /** Each provider's operational identity, read only through `providerIdentity`. */
  readonly providerIdentity: Readonly<Record<string, JsonValue>>;
  details: Pick<
    TransactionDetails,
    | "issues"
    | "pendingPostingCandidates"
    | "rejectedPostingKeys"
    | "postingOverlap"
  > & {
    /** Presence only: a link's contents need the hydrated row. */
    postingLink?: { readonly present: true };
  };
};

/** A complete stored transaction or its narrow projection. */
export type LedgerRow = Transaction | NarrowRow;

export function isNarrow(row: LedgerRow): row is NarrowRow {
  return "hydration" in row;
}

/** Whether a replaced generation can no longer win source matching. */
export function retiredFromMatching(row: LedgerRow): boolean {
  return isNarrow(row)
    ? row.retired
    : row.sourceEvidence?.identity?.retiredFromMatching === true;
}

/** A provider's operational identity of a stored row or an adapter input. */
export function providerIdentity(
  row: LedgerRow | Pick<Transaction, "details">,
  provider: string,
): JsonValue | undefined {
  return "hydration" in row
    ? row.providerIdentity[provider]
    : row.details.provider[provider]?.identity;
}

/**
 * Speculative facts for a narrow row whose hydration a planning round
 * demanded. Such a round is always discarded, so these values only let it
 * continue far enough to name the other rows it needs.
 */
function standIn(row: NarrowRow): Transaction {
  const {
    hydration: _hydration,
    retired,
    providerIdentity: identities,
    details,
    ...facts
  } = row;
  return {
    ...facts,
    description: null,
    counterpartyName: null,
    merchantProviderId: null,
    merchantCategoryCode: null,
    cardPresent: null,
    authorizationMethod: null,
    wallet: null,
    threeDSecureUsed: null,
    recurring: null,
    providerTransactionCode: null,
    fxFeeMinor: null,
    fxFeeCurrency: null,
    ...(retired
      ? { sourceEvidence: { identity: { retiredFromMatching: true } } }
      : {}),
    details: {
      schemaVersion: 1,
      merchant: { address: null, phone: null },
      sourceRefs: [],
      issues: [...details.issues],
      provider: Object.fromEntries(
        Object.entries(identities).map(([provider, identity]) => [
          provider,
          { identity },
        ]),
      ),
      ...(details.pendingPostingCandidates
        ? { pendingPostingCandidates: [...details.pendingPostingCandidates] }
        : {}),
      ...(details.rejectedPostingKeys
        ? { rejectedPostingKeys: [...details.rejectedPostingKeys] }
        : {}),
      ...(details.postingOverlap
        ? { postingOverlap: details.postingOverlap }
        : {}),
    },
  };
}

export interface FinancialSnapshot {
  connection: Connection;
  /**
   * Insertion order, before source-key sorting; adapters must preserve tie
   * identity. A narrow row stands for a stored row whose complete document
   * was not loaded.
   */
  rows: LedgerRow[];
  annotations: Annotation[];
  /**
   * Applied timestamp ascending, insertion order for ties. Without
   * `runHistory` this is every applied run; with it, at least the latest
   * applied run and every run the snapshot's rows name or whose coverage can
   * bind the capture being applied.
   */
  priorRuns: PriorRun[];
  /** Folds over every applied run, in the order `priorRuns` documents. */
  runHistory?: RunHistorySummary;
  /** Latest audit ID first, so each transaction's first match is authoritative. */
  removals: Pick<LedgerEvent, "transactionId" | "createdAt">[];
  /**
   * The connection's card and account catalog, preloaded by operations that
   * resolve provider keys to service IDs (collection and discovery).
   */
  catalog?: { cards: Card[]; accounts: Account[] };
}

export interface DeferredCandidate {
  sourceScope: string;
  sourceKey: string;
  reason: string;
  content: Record<string, unknown>;
}

/** Finite financial write plan; the adapter supplies a consistent operation-scoped snapshot. */
export class FinancialPlan {
  readonly rows: Map<string, LedgerRow>;
  readonly annotations: Map<string, Annotation>;
  readonly transactionWrites = new Map<string, Transaction>();
  /** Fresh observations commit independently of unchanged transaction content. */
  readonly observationWrites = new Map<string, Transaction>();
  readonly deferredCandidates: DeferredCandidate[] = [];
  readonly annotationWrites = new Map<string, Annotation>();
  readonly events: LedgerEventWrite[] = [];
  /** Catalog writes; applied before transactions, accounts first. */
  readonly accountWrites = new Map<string, Account>();
  readonly cardWrites = new Map<string, Card>();
  runUpdate: Partial<Run> | undefined;
  readonly #cards = new Map<string, Card>();
  readonly #accounts = new Map<string, Account>();
  /** Cards minted for transaction references; written only once referenced. */
  readonly #cardReferences = new Map<string, Card>();
  readonly #demands = new Set<string>();
  #originals: Map<string, LedgerRow> | undefined;

  constructor(readonly snapshot: FinancialSnapshot) {
    this.rows = new Map(
      snapshot.rows.map((row) => [row.id, structuredClone(row)]),
    );
    this.annotations = new Map(
      snapshot.annotations.map((row) => [
        row.transactionId,
        structuredClone(row),
      ]),
    );
    for (const card of snapshot.catalog?.cards ?? []) {
      this.#cards.set(card.providerKey, structuredClone(card));
    }
    for (const account of snapshot.catalog?.accounts ?? []) {
      this.#accounts.set(account.providerKey, structuredClone(account));
    }
  }

  #requireCatalog() {
    if (!this.snapshot.catalog) {
      throw new Error("Plan was loaded without its card catalog");
    }
  }

  cardByProviderKey(providerKey: string): Card | undefined {
    this.#requireCatalog();
    return this.#cards.get(providerKey);
  }

  accountByProviderKey(providerKey: string): Account | undefined {
    this.#requireCatalog();
    return this.#accounts.get(providerKey);
  }

  setCard(card: Card) {
    this.#requireCatalog();
    this.#cards.set(card.providerKey, card);
    this.#cardReferences.delete(card.id);
    this.cardWrites.set(card.id, card);
  }

  setAccount(account: Account) {
    this.#requireCatalog();
    this.#accounts.set(account.providerKey, account);
    this.accountWrites.set(account.id, account);
  }

  /**
   * Resolve a provider card key to its service ID. An unknown card gets a new
   * ID with null metadata; it is written only if a written row references it.
   */
  referenceCard(
    connectionId: string,
    providerKey: string,
    createdAt: string,
    newId: () => string,
  ): string {
    this.#requireCatalog();
    const known = this.#cards.get(providerKey);
    if (known) {
      return known.id;
    }
    const card: Card = {
      id: newId(),
      connectionId,
      providerKey,
      billingAccountId: null,
      last4: null,
      displayName: null,
      attributes: null,
      createdAt,
      lastSeenAt: null,
    };
    this.#cards.set(providerKey, card);
    this.#cardReferences.set(card.id, card);
    return card.id;
  }

  #writeReferencedCard(row: LedgerRow) {
    const card = row.cardId && this.#cardReferences.get(row.cardId);
    if (card) {
      this.#cardReferences.delete(card.id);
      this.cardWrites.set(card.id, card);
    }
  }

  transaction(id: string): LedgerRow | undefined {
    return this.rows.get(id);
  }

  /**
   * The complete document of this row object, never a later version of it.
   * A narrow row records a hydration demand: the plan must then be discarded
   * and replanned with that row hydrated.
   */
  full(row: LedgerRow): Transaction {
    if (!isNarrow(row)) {
      return row;
    }
    this.#demands.add(row.id);
    return standIn(row);
  }

  /** The current complete document of a row that is about to be decided on or written. */
  hydrated(id: string): Transaction | undefined {
    const row = this.rows.get(id);
    return row && this.full(row);
  }

  /** The row as the snapshot loaded it, complete. */
  original(id: string): Transaction | undefined {
    this.#originals ??= new Map(this.snapshot.rows.map((row) => [row.id, row]));
    const row = this.#originals.get(id);
    return row && this.full(row);
  }

  /** Narrow rows this plan needed complete; a plan with any is speculative. */
  get demands(): ReadonlySet<string> {
    return this.#demands;
  }

  annotation(id: string) {
    return this.annotations.get(id);
  }

  /** Source-index encounter order, with insertion order retained for identical keys. */
  orderedRows(sourceScope?: string) {
    const encodedStrings = new Map<string, Uint8Array>();
    const encoder = new TextEncoder();
    const utf8Bytes = (value: string) => {
      let result = encodedStrings.get(value);
      if (!result) {
        result = encoder.encode(value);
        encodedStrings.set(value, result);
      }
      return result;
    };
    const compareUtf8 = (left: string, right: string) => {
      if (left === right) {
        return 0;
      }
      const leftBytes = utf8Bytes(left);
      const rightBytes = utf8Bytes(right);
      for (
        let index = 0;
        index < Math.min(leftBytes.length, rightBytes.length);
        index++
      ) {
        if (leftBytes[index] !== rightBytes[index]) {
          return leftBytes[index]! - rightBytes[index]!;
        }
      }
      return leftBytes.length - rightBytes.length;
    };
    return [...this.rows.values()]
      .filter(
        (row) => sourceScope === undefined || row.sourceScope === sourceScope,
      )
      .sort(
        (left, right) =>
          compareUtf8(left.sourceScope, right.sourceScope) ||
          compareUtf8(left.sourceKey, right.sourceKey),
      );
  }

  account(sourceScope: string) {
    return this.orderedRows(sourceScope);
  }

  updateTransaction(id: string, value: Partial<Transaction>) {
    const stored = this.rows.get(id);
    if (!stored) {
      throw new Error("Transaction not found");
    }
    const row = { ...this.full(stored), ...value };
    this.rows.set(id, row);
    this.transactionWrites.set(id, row);
    this.#writeReferencedCard(row);
  }

  insertTransaction(row: Transaction) {
    if (this.rows.has(row.id)) {
      throw new Error("Duplicate transaction identity");
    }
    this.rows.set(row.id, row);
    this.transactionWrites.set(row.id, row);
    this.#writeReferencedCard(row);
  }

  /**
   * Transaction writes in foreign-key order: purchases and other unlinked rows
   * first, then billed lines (new, corrected or retargeted) that reference them.
   */
  orderedTransactionWrites(): Transaction[] {
    const writes = [...this.transactionWrites.values()];
    return [
      ...writes.filter((row) => row.purchaseId === null),
      ...writes.filter((row) => row.purchaseId !== null),
    ];
  }

  setAnnotation(row: Annotation) {
    this.annotations.set(row.transactionId, row);
    this.annotationWrites.set(row.transactionId, row);
  }

  event(value: LedgerEventInput) {
    this.events.push({ ...value, connectionId: this.snapshot.connection.id });
  }
}
