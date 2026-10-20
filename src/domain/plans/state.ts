import type { Account } from "../accounts.js";
import type { Card } from "../cards.js";
import type {
  Annotation,
  Connection,
  LedgerEvent,
  LedgerEventInput,
  LedgerEventWrite,
  Run,
  Transaction,
} from "../records.js";
import type { PriorRun } from "./sync.js";

export type {
  Annotation,
  Connection,
  LedgerEvent,
  LedgerEventInput,
  Run,
} from "../records.js";

export interface FinancialSnapshot {
  connection: Connection;
  /** Insertion order, before source-key sorting; adapters must preserve tie identity. */
  rows: Transaction[];
  annotations: Annotation[];
  /** Applied timestamp ascending, insertion order for ties. */
  priorRuns: PriorRun[];
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
  readonly rows: Map<string, Transaction>;
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

  #writeReferencedCard(row: Transaction) {
    const card = row.cardId && this.#cardReferences.get(row.cardId);
    if (card) {
      this.#cardReferences.delete(card.id);
      this.cardWrites.set(card.id, card);
    }
  }

  transaction(id: string) {
    return this.rows.get(id);
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
    const before = this.rows.get(id);
    if (!before) {
      throw new Error("Transaction not found");
    }
    const row = { ...before, ...value };
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
