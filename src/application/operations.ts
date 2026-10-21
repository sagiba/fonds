import { z } from "zod";

import { resourceKeySchema } from "../domain/accounts.js";
import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
} from "../domain/errors.js";
import { RESOURCE_ID_MAX_LENGTH } from "../domain/model.js";
import {
  editShapeSchema,
  requireTransactionVersionForReview,
} from "../domain/plans/annotation.js";
import { postingSchema, removalSchema } from "../domain/plans/lifecycle.js";
import type { CollectionRange } from "../domain/source-adapter.js";
import {
  type FinancialStore,
  isPathAddressable,
  PATH_ADDRESSABLE_MESSAGE,
} from "./financial-store.js";
import {
  catalogListSchema,
  decodeCursor,
  decodeKeyset,
  encodeCursor,
  encodeKeyset,
  listCursorSchema,
  totalsSchema,
  transactionListSchema,
} from "./query-inputs.js";
import {
  isActive,
  type Refresh,
  RefreshNotStartedError,
  type RefreshStartResult,
  validateRefreshRange,
} from "./refreshes.js";
import {
  accountListOutputSchema,
  accountReadOutputSchema,
  annotationWriteOutputSchema,
  cardListOutputSchema,
  cardReadOutputSchema,
  connectionListOutputSchema,
  connectionReadOutputSchema,
  eventListOutputSchema,
  OUTPUT_MAX_BYTES,
  outputByteLength,
  presentAccount,
  presentAnnotationReceipt,
  presentCard,
  presentConnection,
  presentRefresh,
  presentRefreshDetail,
  presentRefreshStart,
  presentSyncRun,
  presentTransactionReceipt,
  presentWireEvent,
  presentWireTotals,
  presentWireTransaction,
  refreshListOutputSchema,
  refreshReadOutputSchema,
  refreshStartOutputSchema,
  syncRunListOutputSchema,
  totalsOutputSchema,
  transactionListOutputSchema,
  transactionReadOutputSchema,
  transactionWriteOutputSchema,
  unlinkOutputSchema,
} from "./wire-output.js";

class OutputLimitError extends Error {}

function exceedsOutputLimit(issues: readonly z.core.$ZodIssue[]): boolean {
  return issues.some(
    (issue) =>
      issue.code === "too_big" ||
      (issue.code === "invalid_union" && issue.errors.some(exceedsOutputLimit)),
  );
}

const outputSchemas: Record<string, z.ZodObject> = {
  list_connections: connectionListOutputSchema,
  list_cards: cardListOutputSchema,
  get_connection: connectionReadOutputSchema,
  get_card: cardReadOutputSchema,
  list_accounts: accountListOutputSchema,
  get_account: accountReadOutputSchema,
  list_transactions: transactionListOutputSchema,
  get_transaction: transactionReadOutputSchema,
  get_transaction_totals: totalsOutputSchema,
  list_events: eventListOutputSchema,
  list_sync_runs: syncRunListOutputSchema,
  update_annotation: annotationWriteOutputSchema,
  undo_annotation: annotationWriteOutputSchema,
  link_pending_transaction: transactionWriteOutputSchema,
  unlink_pending_transaction: unlinkOutputSchema,
  confirm_removal: transactionWriteOutputSchema,
  refresh_connection: refreshStartOutputSchema,
  get_refresh: refreshReadOutputSchema,
  list_refreshes: refreshListOutputSchema,
};

export class ApplicationError extends Error {
  constructor(readonly code: "not_found") {
    super(code);
  }
}

/** Fixed public errors: never expose SQL, archived payloads or validator input. */
export function publicError(error: unknown) {
  if (error instanceof OutputLimitError) {
    return {
      code: "output_too_large",
      message:
        "Requested output exceeds the response limit. Narrow the request.",
      status: 413 as const,
    };
  }
  if (error instanceof z.ZodError || error instanceof InvalidInputError) {
    return {
      code: "invalid_input",
      message: "Invalid operation input.",
      status: 400 as const,
    };
  }
  if (error instanceof ApplicationError || error instanceof NotFoundError) {
    return {
      code: "not_found",
      message: "Requested record was not found.",
      status: 404 as const,
    };
  }
  if (error instanceof RefreshNotStartedError) {
    return error.reason === "busy"
      ? {
          code: "refresh_in_progress",
          message:
            "A refresh of this connection is already running. Read it with list_refreshes.",
          status: 409 as const,
        }
      : {
          code: "requires_attention",
          message:
            "The provider needs the owner's attention. Refreshes resume after an operator retry.",
          status: 409 as const,
        };
  }
  if (error instanceof ConflictError) {
    return {
      code: "conflict",
      message:
        "State changed or the action conflicts with current state. Read it again before retrying.",
      status: 409 as const,
    };
  }
  return {
    code: "internal_error",
    message: "Operation failed.",
    status: 500 as const,
  };
}

/** Store-independent contract of one operation; HTTP, MCP and the CLI derive from it. */
export interface OperationDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  /** The scope it needs: `read` requires `financial:read`, `write` `financial:write`. */
  access: "read" | "write";
  /** Whether it never changes state; a read that can continue collection is not. */
  readOnly: boolean;
  openWorld: boolean;
}

export interface Operation extends OperationDefinition {
  execute(input: unknown): Promise<unknown>;
}

export interface ApplicationCapabilities {
  /** Starts refreshes and returns their state within a bounded wait. */
  refreshes?: {
    start(
      connectionId: string,
      range?: CollectionRange,
    ): Promise<RefreshStartResult>;
    startAll(range?: CollectionRange): Promise<RefreshStartResult[]>;
    /** Continues an active refresh a read meets, in case its process died. */
    recover?(refresh: Refresh): void;
  };
  /**
   * Told when an owner write has committed, so its events can be delivered; a
   * refresh delivers through its own service instead. It returns at once and
   * runs any work in the background; its failure never changes the write's
   * result.
   */
  afterWrite?(): void;
}

export interface Application {
  readonly backend: FinancialStore["backend"];
  operations: readonly Operation[];
}

/** Calls an operation by name: in process here, remotely in transport/rest-client.ts. */
export interface OperationInvoker {
  invoke(name: string, input: unknown): Promise<unknown>;
}

/** The operation exists in the contract but not on this backend, e.g. refresh. */
export class OperationUnavailableError extends Error {}

export function inProcessInvoker(application: Application): OperationInvoker {
  return {
    async invoke(name, input) {
      const operation = application.operations.find(
        (entry) => entry.name === name,
      );
      if (!operation) {
        throw new OperationUnavailableError(
          "This operation is not available on this backend.",
        );
      }
      return operation.execute(input);
    },
  };
}

const idSchema = z.string().min(1).max(RESOURCE_ID_MAX_LENGTH);
const versionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const connectionScopeSchema = z.object({ connectionId: idSchema }).strict();

const annotationUpdateInputSchema = editShapeSchema.superRefine(
  requireTransactionVersionForReview,
);
/** transactionId is the pending, surviving transaction; postedId is retired by a link. */
const postingInputSchema = postingSchema
  .omit({
    actor: true,
    pendingId: true,
    expectedPendingVersion: true,
    expectedPostedVersion: true,
  })
  .extend({
    transactionId: postingSchema.shape.pendingId,
    expectedPendingTransactionVersion:
      postingSchema.shape.expectedPendingVersion,
    expectedPostedTransactionVersion: postingSchema.shape.expectedPostedVersion,
  });
const removalInputSchema = removalSchema
  .omit({ actor: true, expectedVersion: true })
  .extend({ expectedTransactionVersion: removalSchema.shape.expectedVersion });

function postingCommand(input: z.output<typeof postingInputSchema>) {
  const {
    transactionId,
    expectedPendingTransactionVersion,
    expectedPostedTransactionVersion,
    ...command
  } = input;
  return {
    ...command,
    pendingId: transactionId,
    expectedPendingVersion: expectedPendingTransactionVersion,
    expectedPostedVersion: expectedPostedTransactionVersion,
    actor: "owner",
  };
}

function listPage<Item>(
  data: Item[],
  nextCursor: string | null,
): { data: Item[]; hasMore: boolean; nextCursor: string | null } {
  return { data, hasMore: nextCursor !== null, nextCursor };
}

/**
 * Pages may hold fewer rows than fetched to respect the response byte limit.
 * `nextCursor` is always the keyset position of the last emitted row.
 */
function fitPage<Row, Item>(
  rows: readonly Row[],
  hasMore: boolean,
  present: (row: Row) => Item,
  cursorOf: (row: Row) => string,
) {
  const data: Item[] = [];
  for (const [index, row] of rows.entries()) {
    data.push(present(row));
    const more = index < rows.length - 1 || hasMore;
    if (
      outputByteLength(listPage(data, more ? cursorOf(row) : null)) >
      OUTPUT_MAX_BYTES
    ) {
      data.pop();
      if (data.length === 0) {
        throw new OutputLimitError();
      }
      return listPage(data, cursorOf(rows[index - 1]!));
    }
  }
  const last = rows.at(-1);
  return listPage(data, hasMore && last ? cursorOf(last) : null);
}

function catalogAfter(kind: "cards" | "accounts", cursor: string | undefined) {
  if (cursor === undefined) {
    return undefined;
  }
  const [createdAt, id] = decodeKeyset(kind, cursor);
  return { createdAt, id };
}

function transactionAfter(cursor: string | undefined) {
  if (cursor === undefined) {
    return undefined;
  }
  const [transactionDate, id] = decodeKeyset("transactions", cursor);
  return { transactionDate, id };
}

function syncRunAfter(cursor: string | undefined) {
  if (cursor === undefined) {
    return undefined;
  }
  const [startedAt, id] = decodeKeyset("sync_runs", cursor);
  return { startedAt, id };
}

const transactionsDescription = [
  "Browse a bounded live page of compact transactions, newest transactionDate first (unknown dates last).",
  "perspective selects rows using plan facts and live billed-line associations: spending (default) is every row without purchaseId, including fees and cancellations; billing excludes installment-plan purchases and purchases with live billed lines, including unknown-count plans; held or unknown billed amounts remain excluded, never replaced by the purchase commitment; all is every row and counts a plan's money twice. A billed line has purchaseId (its purchase) and installmentNumber; filtering by purchaseId requires billing or all.",
  "Money is exact decimal strings; keep each amount with its currency and amount basis.",
  "Pages may hold fewer rows to respect the response byte limit; follow nextCursor while hasMore is true. Reads are live: concurrent changes can shift later pages.",
  "cardId and billingAccountId must belong to connectionId when both are given; otherwise the input is invalid.",
].join(" ");

const totalsDescription = [
  "Get exact totals of posted active rows for one perspective, with exclusion counts; filters are those of list_transactions.",
  "spending (default) groups by currency and amountBasis and counts each purchase commitment once, never its billed lines; commitments are not booked cash flow.",
  "billing has one group per currency over billed money: installment purchases count through their billed lines, single charges as themselves.",
  "all is rejected because it would double-count.",
  "Never add groups together across currencies, bases or perspectives. fxFees sums published FX fees per currency; fxFeeUnknownCount counts included converted rows whose fee is unknown, which is never zero.",
  "Pending, authorization, removed, superseded, unknown, ambiguous, income and transfer rows are excluded. No balances or exchange rates are inferred.",
].join(" ");

const identifierKeys = [
  "connectionId",
  "cardId",
  "accountId",
  "billingAccountId",
  "transactionId",
  "postedId",
  "purchaseId",
  "refreshId",
] as const;

function define<Schema extends z.ZodObject>(
  name: string,
  description: string,
  inputSchema: Schema,
  access: "read" | "write",
  options: { openWorld?: boolean; readOnly?: boolean } = {},
): OperationDefinition & { inputSchema: Schema } {
  const outputSchema = outputSchemas[name];
  if (!outputSchema) {
    throw new Error("Missing operation output schema");
  }
  return {
    name,
    description,
    // Identifiers travel as REST path segments; every transport rejects the same ones.
    inputSchema: inputSchema.superRefine((input, context) => {
      for (const key of identifierKeys) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value === "string" && !isPathAddressable(value)) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: PATH_ADDRESSABLE_MESSAGE,
          });
        }
      }
    }),
    outputSchema,
    access,
    readOnly: options.readOnly ?? access === "read",
    openWorld: options.openWorld ?? false,
  };
}

const definitions = {
  list_connections: define(
    "list_connections",
    "List every configured financial connection in one unpaged page (hasMore is always false), without credentials. latestRefresh is the newest refresh, or null before any; requiresAttention means the provider needs the owner. Does not call the provider.",
    z.object({}).strict(),
    "read",
  ),
  get_connection: define(
    "get_connection",
    "Read one connection with latestRefresh, its newest refresh or recorded scheduled occurrence, or null before any. Does not call the provider.",
    connectionScopeSchema,
    "read",
  ),
  list_cards: define(
    "list_cards",
    "Browse a bounded live page of one connection's cards, oldest first. A card's id matches transaction cardId. Unknown metadata stays null, and omission from discovery does not establish closure. Follow nextCursor while hasMore is true; concurrent changes can shift later pages.",
    catalogListSchema,
    "read",
  ),
  get_card: define(
    "get_card",
    "Read one card by its id. Unknown metadata stays null; no issuance date or lifecycle status is inferred.",
    z.object({ cardId: resourceKeySchema }).strict(),
    "read",
  ),
  list_accounts: define(
    "list_accounts",
    "Browse a bounded live page of one connection's accounts, oldest first: the bank accounts the provider reports as paying card bills. Filter transactions by billingAccountId to see the spending billed to one. Unknown metadata stays null; accounts are never merged by name or mask. Follow nextCursor while hasMore is true.",
    catalogListSchema,
    "read",
  ),
  get_account: define(
    "get_account",
    "Read one account by its id. Balances and holder details are not stored, and the provider's account key (possibly a full account number) is never returned, only mask.",
    z.object({ accountId: resourceKeySchema }).strict(),
    "read",
  ),
  list_transactions: define(
    "list_transactions",
    transactionsDescription,
    transactionListSchema,
    "read",
  ),
  get_transaction: define(
    "get_transaction",
    "Read one transaction with its current version and annotation version (the versions writes expect), annotation, source identity, posting match and review context. Default detail includes bounded review candidates and reasons; review.truncated and review.counts identify incomplete lists. Set detail=false for compact output; includeEvidence=true adds a diagnostic preview with an explicit truncation flag.",
    z
      .object({
        transactionId: idSchema,
        detail: z.boolean().default(true),
        includeEvidence: z.boolean().default(false),
      })
      .strict()
      .refine((input) => input.detail || !input.includeEvidence, {
        message: "Evidence requires transaction detail",
      }),
    "read",
  ),
  get_transaction_totals: define(
    "get_transaction_totals",
    totalsDescription,
    totalsSchema,
    "read",
  ),
  list_events: define(
    "list_events",
    "Read a bounded page of the durable event feed after cursor; omit cursor to start from the beginning. Reading does not acknowledge delivery or start a refresh. Events are thin: refetch the transaction for current state. nextCursor is always a resumable checkpoint, even on an empty page.",
    connectionScopeSchema.extend({
      cursor: listCursorSchema.optional(),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    "read",
  ),
  list_sync_runs: define(
    "list_sync_runs",
    "Browse recent sync run metadata, newest first, without returning raw source snapshots. Does not start a refresh.",
    connectionScopeSchema.extend({
      cursor: listCursorSchema.optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    "read",
  ),
  update_annotation: define(
    "update_annotation",
    "Patch a transaction's owner annotation; expectedVersion is its current annotation version (0 if none). Omitted fields are unchanged. notes and category: a string sets, null clears. tags replaces the whole set; [] clears. metadata merges key by key (values may be any JSON): a key set to null is deleted, and metadata null clears all. review records the owner decision against the current money, currency, amount basis and kind (the server stamps them), or null removes it; it requires expectedTransactionVersion from the current transaction. Source facts are never edited.",
    annotationUpdateInputSchema,
    "write",
  ),
  refresh_connection: define(
    "refresh_connection",
    "Start a refresh from the financial provider: of connectionId, or of every connection with stored credentials when it is omitted. This calls the external provider and updates stored financial observations. Without from/to it rereads the recent window; inclusive from and to (YYYY-MM-DD, given together, at most 120 months) backfill that range month by month. Returns within about 10 seconds with the refresh (one refreshes entry per connection when none was named): completed, partial or failed, or running when it continues in the background; read it later with get_refresh. A connection already refreshing answers refresh_in_progress (in refreshes, reason busy); one whose provider needs the owner, requires_attention; one refreshed within the last minute returns that refresh (reason cooldown).",
    z
      .object({
        connectionId: idSchema.optional(),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
      })
      .strict()
      .superRefine((input, context) => {
        if ((input.from === undefined) !== (input.to === undefined)) {
          context.addIssue({
            code: "custom",
            message: "from and to go together",
          });
          return;
        }
        if (input.from !== undefined) {
          try {
            validateRefreshRange({ from: input.from, to: input.to! });
          } catch {
            context.addIssue({
              code: "custom",
              message: "Invalid refresh range",
            });
          }
        }
      }),
    "write",
    { openWorld: true },
  ),
  get_refresh: define(
    "get_refresh",
    "Read one refresh: its status or skip reason, range, timing, counts, failures and, for a ranged refresh, its month windows newest first. Reading a pending or running refresh whose process stopped continues it, which calls the provider.",
    z.object({ refreshId: idSchema }).strict(),
    "read",
    // Reading an abandoned refresh continues it.
    { openWorld: true, readOnly: false },
  ),
  list_refreshes: define(
    "list_refreshes",
    "Browse one connection's refreshes and recorded scheduled occurrences, newest first, without windows. Does not call the provider.",
    connectionScopeSchema.extend({
      cursor: listCursorSchema.optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    "read",
  ),
  undo_annotation: define(
    "undo_annotation",
    "Undo only the current annotation edit using its annotation.updated event ID and expectedVersion (the current annotation version). The exact previous document is restored, including its review basis.",
    z
      .object({
        eventId: versionSchema.positive(),
        expectedVersion: versionSchema,
      })
      .strict(),
    "write",
  ),
  link_pending_transaction: define(
    "link_pending_transaction",
    "Explicitly confirm that a pending transaction (transactionId, which survives) and a posted transaction (postedId, which is retired) are the same purchase. First get_transaction with detail=true for both and inspect their candidates and review reasons; then pass both transaction versions, both current annotation versions and a reason. Candidates suggest review, not proof of a pairing; review.truncated means the lists are incomplete, so never infer a unique pairing from a truncated list.",
    postingInputSchema,
    "write",
  ),
  unlink_pending_transaction: define(
    "unlink_pending_transaction",
    "Undo a pending-to-posted link on the surviving pending transaction (transactionId) and its retired posted transaction (postedId), keeping annotations on their IDs and current posted corrections. Requires both transaction versions, both annotation versions and a reason; both rows are then excluded from automatic relinking.",
    postingInputSchema,
    "write",
  ),
  confirm_removal: define(
    "confirm_removal",
    "Explicitly mark a transaction removed with expectedTransactionVersion and a reason. An absent source row alone is not deletion evidence.",
    removalInputSchema,
    "write",
  ),
};

/** Every operation in API order; refresh_connection needs a collection capability. */
export const operationDefinitions: readonly OperationDefinition[] =
  Object.values(definitions);

type Executors = {
  [Name in keyof typeof definitions]: (
    input: z.output<(typeof definitions)[Name]["inputSchema"]>,
  ) => unknown;
};

function bindOperation(
  definition: OperationDefinition,
  execute: (input: never) => unknown,
  afterWrite?: () => void,
): Operation {
  return {
    ...definition,
    execute: async (input) => {
      // Executors are typed against their own definition's schema.
      const value = await execute(definition.inputSchema.parse(input) as never);
      try {
        afterWrite?.();
      } catch {
        // The write has committed; its receipt is the result.
      }
      if (outputByteLength(value) > OUTPUT_MAX_BYTES) {
        throw new OutputLimitError();
      }
      const output = definition.outputSchema.safeParse(value);
      if (!output.success) {
        if (exceedsOutputLimit(output.error.issues)) {
          throw new OutputLimitError();
        }
        throw new Error("Operation returned invalid output");
      }
      return output.data;
    },
  };
}

/** One single-owner application surface shared by HTTP, MCP and the CLI. No transport or secrets here. */
export function createApplication(
  store: FinancialStore,
  capabilities: ApplicationCapabilities = {},
): Application {
  async function requireTransaction(transactionId: string) {
    const row = await store.getTransaction(transactionId);
    if (!row) {
      throw new ApplicationError("not_found");
    }
    return row;
  }

  const executors: Executors = {
    list_connections: async () => ({
      data: (await store.listConnections()).map(presentConnection),
      hasMore: false,
      nextCursor: null,
    }),
    get_connection: async ({ connectionId }) => {
      const connection = await store.getConnection(connectionId);
      if (!connection) {
        throw new ApplicationError("not_found");
      }
      return { connection: presentConnection(connection) };
    },
    list_cards: async ({ cursor, ...input }) => {
      const page = await store.listCards({
        ...input,
        after: catalogAfter("cards", cursor),
      });
      return fitPage(page.cards, page.hasMore, presentCard, (card) =>
        encodeKeyset("cards", [card.createdAt, card.id]),
      );
    },
    get_card: async ({ cardId }) => {
      const card = await store.getCard(cardId);
      if (!card) {
        throw new ApplicationError("not_found");
      }
      return { card: presentCard(card) };
    },
    list_accounts: async ({ cursor, ...input }) => {
      const page = await store.listAccounts({
        ...input,
        after: catalogAfter("accounts", cursor),
      });
      return fitPage(page.accounts, page.hasMore, presentAccount, (row) =>
        encodeKeyset("accounts", [row.createdAt, row.id]),
      );
    },
    get_account: async ({ accountId }) => {
      const account = await store.getAccount(accountId);
      if (!account) {
        throw new ApplicationError("not_found");
      }
      return { account: presentAccount(account) };
    },
    list_transactions: async ({ cursor, ...input }) => {
      const page = await store.listTransactionPage({
        ...input,
        after: transactionAfter(cursor),
      });
      return fitPage(
        page.transactions,
        page.hasMore,
        (row) => presentWireTransaction(row),
        (row) => encodeKeyset("transactions", [row.transactionDate, row.id]),
      );
    },
    get_transaction: async ({ transactionId, detail, includeEvidence }) => ({
      transaction: presentWireTransaction(
        await requireTransaction(transactionId),
        detail,
        includeEvidence,
      ),
    }),
    get_transaction_totals: async (input) =>
      presentWireTotals(await store.getTotals(input)),
    list_events: async ({ connectionId, cursor, limit }) => {
      const after = cursor === undefined ? 0 : decodeCursor("event", cursor);
      const rows = await store.listEvents({
        connectionId,
        after,
        limit: limit + 1,
      });
      const data = rows.slice(0, limit);
      return {
        data: data.map(presentWireEvent),
        hasMore: rows.length > limit,
        nextCursor: encodeCursor("event", data.at(-1)?.id ?? after),
      };
    },
    list_sync_runs: async ({ connectionId, cursor, limit }) => {
      const rows = await store.listSyncRuns(connectionId, {
        limit: limit + 1,
        after: syncRunAfter(cursor),
      });
      return fitPage(
        rows.slice(0, limit),
        rows.length > limit,
        presentSyncRun,
        (run) => encodeKeyset("sync_runs", [run.startedAt, run.id]),
      );
    },
    update_annotation: async (input) => ({
      annotation: presentAnnotationReceipt(
        await store.editAnnotation({ ...input, actor: "owner" }),
      ),
    }),
    refresh_connection: async ({ connectionId, from, to }) => {
      const range = from === undefined ? undefined : { from, to: to! };
      if (connectionId === undefined) {
        return {
          refreshes: (await capabilities.refreshes!.startAll(range)).map(
            presentRefreshStart,
          ),
        };
      }
      const result = await capabilities.refreshes!.start(connectionId, range);
      if (result.reason === "busy" || result.reason === "requires_attention") {
        throw new RefreshNotStartedError(
          result.reason,
          result.refresh ?? undefined,
        );
      }
      return { refresh: presentRefreshDetail(result.refresh!) };
    },
    get_refresh: async ({ refreshId }) => {
      const refresh = await store.getRefresh(refreshId);
      if (!refresh) {
        throw new ApplicationError("not_found");
      }
      if (isActive(refresh)) {
        capabilities.refreshes?.recover?.(refresh);
      }
      return { refresh: presentRefreshDetail(refresh) };
    },
    list_refreshes: async ({ connectionId, cursor, limit }) => {
      const after =
        cursor === undefined ? undefined : decodeKeyset("refreshes", cursor);
      const rows = await store.listRefreshes(connectionId, {
        limit: limit + 1,
        after: after && { createdAt: after[0], id: after[1] },
      });
      return fitPage(
        rows.slice(0, limit),
        rows.length > limit,
        presentRefresh,
        (refresh) => encodeKeyset("refreshes", [refresh.createdAt, refresh.id]),
      );
    },
    undo_annotation: async (input) => ({
      annotation: presentAnnotationReceipt(await store.undoAnnotation(input)),
    }),
    link_pending_transaction: async (input) => {
      const row = await store.linkPendingTransaction(postingCommand(input));
      return { transaction: presentTransactionReceipt(row) };
    },
    unlink_pending_transaction: async (input) => {
      const rows = await store.unlinkPendingTransaction(postingCommand(input));
      return {
        pending: presentTransactionReceipt(rows.pending),
        posted: presentTransactionReceipt(rows.posted),
      };
    },
    confirm_removal: async (input) => {
      const { expectedTransactionVersion, ...command } = input;
      const row = await store.confirmRemoval({
        ...command,
        expectedVersion: expectedTransactionVersion,
        actor: "owner",
      });
      return { transaction: presentTransactionReceipt(row) };
    },
  };
  return {
    backend: store.backend,
    operations: operationDefinitions
      .filter(
        (definition) =>
          definition.name !== "refresh_connection" || capabilities.refreshes,
      )
      .map((definition) =>
        bindOperation(
          definition,
          executors[definition.name as keyof Executors],
          definition.access === "write" &&
            definition.name !== "refresh_connection"
            ? capabilities.afterWrite
            : undefined,
        ),
      ),
  };
}
