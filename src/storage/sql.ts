import {
  and,
  type AnyColumn,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
  type Table,
} from "drizzle-orm";

import type { BackfillOutcome } from "../application/financial-store.js";
import {
  amountBoundMinor,
  type EventQuery,
  type TransactionQuery,
} from "../application/query-inputs.js";
import {
  LIST_FACT_FIELDS,
  type Perspective,
  perspectiveRule,
  type TotalsBucket,
} from "../domain/read-model.js";
import type { Connection, Transaction } from "../domain/records.js";

export type PlanScope = { transactionId: string } | { accountOf: string };

type Columns<T> = { [Key in keyof T]-?: AnyColumn };

type TransactionColumns = Columns<
  Omit<
    Transaction,
    "details" | "lastSeenAt" | "lastSeenRunId" | "sourceEvidence"
  >
>;

const dateColumns = {
  transaction: "transactionDate",
  booking: "bookingDate",
  billing: "billingDate",
} as const;

/** A live billed line of the outer row, matching `isLiveBilledLine`. */
const line = sql.identifier("billed_line");

function lineColumn(column: AnyColumn) {
  return sql`${line}.${sql.identifier(column.name)}`;
}

/** The domain's perspective membership rule, compiled to SQL. */
function perspectiveFilter(
  table: TransactionColumns,
  perspective: Perspective,
) {
  const rule = perspectiveRule(perspective);
  switch (rule.kind) {
    case "every_row":
      return undefined;
    case "without_purchase":
      return isNull(table.purchaseId);
    case "without_plan_purchase":
      // Associations are global to the perspective, not narrowed by page/date filters.
      return and(
        or(
          isNull(table.installmentCount),
          lt(table.installmentCount, rule.minimumPayments),
          isNotNull(table.installmentNumber),
        ),
        sql`not exists (
          select 1 from ${table.id.table} as ${line}
          where ${lineColumn(table.connectionId)} = ${table.connectionId}
            and ${lineColumn(table.purchaseId)} = ${table.id}
            and ${lineColumn(table.presence)} <> 'removed'
            and ${lineColumn(table.supersededById)} is null
        )`,
      );
  }
}

/** Transactions page in `transactionDate` descending (nulls last), then `id`. */
export function transactionOrder(table: TransactionColumns) {
  return [sql`${table.transactionDate} desc nulls last`, sql`${table.id} asc`];
}

/** Rows after a keyset position in `transactionOrder`. */
export function transactionSeek(
  table: TransactionColumns,
  after: TransactionQuery["after"],
) {
  if (after === undefined) {
    return undefined;
  }
  if (after.transactionDate === null) {
    return and(isNull(table.transactionDate), gt(table.id, after.id));
  }
  return or(
    lt(table.transactionDate, after.transactionDate),
    and(
      eq(table.transactionDate, after.transactionDate),
      gt(table.id, after.id),
    ),
    isNull(table.transactionDate),
  );
}

/** Rows after a keyset position ordered by (time, id), both ascending or both descending. */
export function keysetSeek(
  time: AnyColumn,
  id: AnyColumn,
  after: { time: string; id: string } | undefined,
  direction: "asc" | "desc",
) {
  if (after === undefined) {
    return undefined;
  }
  const beyond = direction === "asc" ? gt : lt;
  return or(
    beyond(time, after.time),
    and(eq(time, after.time), beyond(id, after.id)),
  );
}

/**
 * `billingAccountId` matches through the card: cards are the only link between
 * transactions and billing accounts.
 */
export function transactionFilter(
  table: TransactionColumns,
  filters: TransactionQuery,
  cards: { id: AnyColumn; billingAccountId: AnyColumn } & Table,
) {
  const date = table[dateColumns[filters.dateRole ?? "transaction"]];
  return and(
    filters.connectionId === undefined
      ? undefined
      : eq(table.connectionId, filters.connectionId),
    filters.billingAccountId === undefined
      ? undefined
      : inArray(
          table.cardId,
          sql`(select ${cards.id} from ${cards} where ${cards.billingAccountId} = ${filters.billingAccountId})`,
        ),
    filters.cardId === undefined ? undefined : eq(table.cardId, filters.cardId),
    filters.from === undefined ? undefined : gte(date, filters.from),
    filters.to === undefined ? undefined : lte(date, filters.to),
    filters.currency === undefined
      ? undefined
      : eq(table.currency, filters.currency),
    filters.amountBasis === undefined
      ? undefined
      : eq(table.amountBasis, filters.amountBasis),
    filters.kind === undefined ? undefined : eq(table.kind, filters.kind),
    filters.status === undefined ? undefined : eq(table.status, filters.status),
    filters.presence === "all"
      ? undefined
      : filters.presence === "current"
        ? and(isNull(table.sourceAbsence), ne(table.presence, "removed"))
        : eq(table.presence, filters.presence),
    filters.merchantName === undefined
      ? undefined
      : eq(table.merchantName, filters.merchantName),
    filters.merchantContains === undefined
      ? undefined
      : or(
          containsText(table.merchantName, filters.merchantContains),
          containsText(table.counterpartyName, filters.merchantContains),
        ),
    filters.merchantCategoryCode === undefined
      ? undefined
      : eq(table.merchantCategoryCode, filters.merchantCategoryCode),
    // Validation requires the currency with either bound.
    filters.amountMin === undefined
      ? undefined
      : gte(
          table.amountMinor,
          amountBoundMinor(filters.amountMin, filters.currency!),
        ),
    filters.amountMax === undefined
      ? undefined
      : lte(
          table.amountMinor,
          amountBoundMinor(filters.amountMax, filters.currency!),
        ),
    filters.cardPresent === undefined
      ? undefined
      : eq(table.cardPresent, filters.cardPresent),
    filters.authorizationMethod === undefined
      ? undefined
      : eq(table.authorizationMethod, filters.authorizationMethod),
    filters.wallet === undefined ? undefined : eq(table.wallet, filters.wallet),
    filters.threeDSecureUsed === undefined
      ? undefined
      : eq(table.threeDSecureUsed, filters.threeDSecureUsed),
    filters.recurring === undefined
      ? undefined
      : eq(table.recurring, filters.recurring),
    filters.includeSuperseded ? undefined : isNull(table.supersededById),
    filters.purchaseId === undefined
      ? undefined
      : eq(table.purchaseId, filters.purchaseId),
    perspectiveFilter(table, filters.perspective),
  );
}

/**
 * A literal substring, compared after the database lowercases both sides:
 * ASCII letters always fold, other scripts as the database's lower() does.
 */
function containsText(column: AnyColumn, text: string) {
  const pattern = `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return sql`lower(${column}) like lower(${pattern}) escape '\\'`;
}

export function eventFilter(
  events: { id: AnyColumn; connectionId: AnyColumn },
  filters: EventQuery,
) {
  return and(
    gt(events.id, filters.after),
    filters.connectionId === undefined
      ? undefined
      : eq(events.connectionId, filters.connectionId),
  );
}

/**
 * Event columns a public feed item presents. Stored documents travel only for
 * the types whose public summary reads them, as JSON text: both states of a
 * transaction update (for changedFields), and the after state of a baseline
 * or refresh event (for its summary or refresh reference).
 */
export function wireEventColumns<
  T extends Record<
    | "id"
    | "connectionId"
    | "transactionId"
    | "runId"
    | "type"
    | "createdAt"
    | "actor"
    | "before"
    | "after",
    AnyColumn
  >,
>(
  events: T,
): Pick<
  T,
  | "id"
  | "connectionId"
  | "transactionId"
  | "runId"
  | "type"
  | "createdAt"
  | "actor"
> & { before: SQL<string | null>; after: SQL<string | null> } {
  return {
    id: events.id,
    connectionId: events.connectionId,
    transactionId: events.transactionId,
    runId: events.runId,
    type: events.type,
    createdAt: events.createdAt,
    actor: events.actor,
    before: sql<
      string | null
    >`case when ${events.type} = 'transaction.updated' then ${events.before} end`,
    after: sql<
      string | null
    >`case when ${events.type} in ('transaction.updated', 'sync.baseline')
      or ${events.type} like 'refresh.%' then ${events.after} end`,
  };
}

export function connectionColumns<T extends Columns<Connection>>(
  table: T,
): Pick<T, "id" | "provider" | "displayName" | "createdAt" | "config"> {
  return {
    id: table.id,
    provider: table.provider,
    displayName: table.displayName,
    createdAt: table.createdAt,
    config: table.config,
  };
}

/** `totalsBucket` from domain/read-model.ts, compiled to SQL with its precedence. */
export function totalsBucket(table: TransactionColumns) {
  return sql<TotalsBucket>`case
    when ${table.supersededById} is not null or ${table.presence} = 'removed'
      then 'retiredOrRemoved'
    when ${table.sourceAbsence} is not null then 'sourceAbsent'
    when ${table.status} = 'pending' then 'pending'
    when ${table.kind} in ('transfer', 'income') then 'transferOrIncome'
    when ${table.amountBasis} = 'authorization' then 'authorization'
    when ${table.amountMinor} is null or ${table.currency} is null
      or ${table.amountBasis} not in ('booked_entry', 'purchase_commitment')
      or ${table.kind} = 'unknown' or ${table.identityStrength} = 'ambiguous'
      then 'unresolved'
    else 'included' end`;
}

/**
 * The grouping and exact aggregates of `TotalsPart`: one row per bucket and,
 * for included rows, per money group and published fee currency. The caller
 * groups by every key. Sums are `exactSum`s, so no intermediate total
 * overflows and no driver rounds one.
 */
export function totalsPartColumns(
  table: TransactionColumns,
  perspective: Exclude<Perspective, "all">,
) {
  const bucket = totalsBucket(table);
  const included = sql`(${bucket}) = 'included'`;
  const published = sql`${included} and ${table.fxFeeMinor} is not null and ${table.fxFeeCurrency} is not null`;
  const amountBasis =
    perspective === "spending"
      ? sql<
          Transaction["amountBasis"] | null
        >`case when ${included} then ${table.amountBasis} end`
      : undefined;
  const keys = {
    bucket,
    currency: sql<
      string | null
    >`case when ${included} then ${table.currency} end`,
    fxFeeCurrency: sql<
      string | null
    >`case when ${published} then ${table.fxFeeCurrency} end`,
    // PostgreSQL refuses a constant grouping key, so billing omits it.
    ...(amountBasis && { amountBasis }),
  };
  return {
    keys,
    columns: {
      ...keys,
      amountBasis: amountBasis ?? sql<Transaction["amountBasis"] | null>`null`,
      count: sql<number>`count(*)`.mapWith(Number),
      amountMinor: exactSum(
        sql`case when ${included} then ${table.amountMinor} else 0 end`,
      ),
      fxFeeMinor: exactSum(
        sql`case when ${published} then ${table.fxFeeMinor} else 0 end`,
      ),
      fxFeeUnknownCount: sql<number>`sum(case when ${included}
        and not (${published})
        and ${table.originalCurrency} is not null and ${table.currency} is not null
        and ${table.originalCurrency} <> ${table.currency} then 1 else 0 end)`.mapWith(
        Number,
      ),
    },
  };
}

/**
 * Included rows' money aggregates under one group key, for a grouped totals
 * statement that groups by `key`, currency and (in `spending`) basis.
 */
export function groupedMoneyColumns(
  table: TransactionColumns,
  perspective: Exclude<Perspective, "all">,
  key: SQL,
) {
  const amountBasis =
    perspective === "spending" ? sql`${table.amountBasis}` : undefined;
  return {
    where: sql`(${totalsBucket(table)}) = 'included'`,
    groups: [
      key,
      sql`${table.currency}`,
      ...(amountBasis ? [amountBasis] : []),
    ],
    columns: {
      groupKey: sql<string | null>`${key}`.as("group_key"),
      currency: sql<string>`${table.currency}`.as("currency"),
      amountBasis: (amountBasis ?? sql`null`).as("amount_basis") as SQL.Aliased<
        Transaction["amountBasis"] | null
      >,
      count: sql<number>`count(*)`.as("row_count"),
      amountMinor: exactSum(sql`${table.amountMinor}`).as("amount_minor"),
      minMinor: sql<unknown>`cast(min(${table.amountMinor}) as text)`.as(
        "min_minor",
      ),
      maxMinor: sql<unknown>`cast(max(${table.amountMinor}) as text)`.as(
        "max_minor",
      ),
    },
  };
}

/** 2^32: amounts split into this many units and a remainder below it. */
const SPLIT = 4294967296;

/**
 * An exact sum of safe-integer amounts as `high:low` decimal text, where the
 * total is high × 2^32 + low. SQLite sums integers in 64 bits and fails on an
 * intermediate overflow even when later rows cancel it; each part stays far
 * inside 64 bits (|high| ≤ 2^21 and |low| < 2^32 per row), and PostgreSQL
 * computes the same parts. `%` truncates toward zero in both dialects.
 */
export function exactSum(value: SQL) {
  return sql<
    string | null
  >`cast(sum((${value} - ${value} % ${sql.raw(String(SPLIT))}) / ${sql.raw(String(SPLIT))}) as text) || ':' || cast(sum(${value} % ${sql.raw(String(SPLIT))}) as text)`;
}

/** The total an `exactSum` describes; null (no rows) is zero. */
export function exactSumValue(value: unknown): bigint {
  if (value === null) {
    return 0n;
  }
  const parts =
    typeof value === "string" ? /^(-?\d+):(-?\d+)$/.exec(value) : null;
  if (!parts) {
    throw new TypeError("Aggregate is not an exact sum");
  }
  return BigInt(parts[1]!) * BigInt(SPLIT) + BigInt(parts[2]!);
}

/** An exact integer aggregate as a driver returns it: number, bigint or decimal text. */
export function exactInteger(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  if (value === null) {
    return 0n;
  }
  throw new TypeError("Aggregate is not an exact integer");
}

/** Canonical-row columns that hold the details a list item presents. */
const listDetailColumns = [
  "transactionDateTime",
  "merchantAddressLine",
  "merchantPhone",
  "merchantCity",
  "merchantCountryCode",
  "currencyExchange",
  "sourceIssues",
] as const;

export type ListColumn =
  (typeof LIST_FACT_FIELDS)[number] | (typeof listDetailColumns)[number];

/** The canonical-row columns a list page reads, and no others. */
export function listColumns<T extends Record<ListColumn, AnyColumn>>(
  table: T,
): Pick<T, ListColumn> {
  const columns: Partial<Pick<T, ListColumn>> = {};
  for (const key of [...LIST_FACT_FIELDS, ...listDetailColumns]) {
    columns[key] = table[key];
  }
  return columns as Pick<T, ListColumn>;
}

/** Transaction columns a narrow ledger row reads (`NarrowRow`). */
const ledgerColumnNames = [
  "id",
  "sourceScope",
  "cardId",
  "sourceKey",
  "sourceAliases",
  "identityStrength",
  "status",
  "presence",
  "sourceAbsence",
  "kind",
  "merchantName",
  "transactionDate",
  "bookingDate",
  "billingDate",
  "amountMinor",
  "currency",
  "amountBasis",
  "originalAmountMinor",
  "originalCurrency",
  "installmentCount",
  "purchaseId",
  "installmentNumber",
  "firstSeenAt",
  "version",
  "supersededById",
  "sourceIssues",
] as const;

export type LedgerColumn = (typeof ledgerColumnNames)[number];

export function ledgerColumns<T extends Record<LedgerColumn, AnyColumn>>(
  table: T,
): Pick<T, LedgerColumn> {
  const columns: Partial<Pick<T, LedgerColumn>> = {};
  for (const key of ledgerColumnNames) {
    columns[key] = table[key];
  }
  return columns as Pick<T, LedgerColumn>;
}

/** How often `text` occurs in a text column; zero for null. */
function occurrences(column: AnyColumn, text: string) {
  return sql<number>`(length(coalesce(${column}, '')) - length(replace(coalesce(${column}, ''), ${text}, ''))) / ${sql.raw(String(text.length))}`.mapWith(
    Number,
  );
}

/**
 * Facts a narrow ledger row takes from large documents without evaluating
 * them as JSON: PostgreSQL rejects some valid stored text (escaped NUL, lone
 * surrogates) as soon as it parses it, so only text functions run here.
 * These counts only prove facts in canonical cases; `decodeLedgerRow`
 * leaves every other case in doubt, and a row in doubt is hydrated:
 *
 * - A key is absent when its bare name occurs nowhere and the document has no
 *   `\u` escape, which could spell any name.
 * - Inside a JSON string every quote is escaped, so the compact pair
 *   `"retiredFromMatching":true` occurs only as that key with that value;
 *   it decides only as the key's single mention, in a document without escapes.
 * - A link document is absent as SQL null or the text `null`, and present
 *   when it begins with `{`.
 */
export function ledgerFlags(columns: {
  sourceEvidence: AnyColumn;
  postingLink: AnyColumn;
  provider: AnyColumn;
}) {
  const flag = (condition: SQL) =>
    sql<number>`case when ${condition} then 1 else 0 end`.mapWith(Number);
  return {
    retiredMentions: occurrences(columns.sourceEvidence, "retiredFromMatching"),
    retiredTrue: occurrences(
      columns.sourceEvidence,
      '"retiredFromMatching":true',
    ),
    retiredFalse: occurrences(
      columns.sourceEvidence,
      '"retiredFromMatching":false',
    ),
    evidenceEscapes: occurrences(columns.sourceEvidence, "\\u"),
    linkAbsent: flag(
      sql`${columns.postingLink} is null or ${columns.postingLink} = 'null'`,
    ),
    linkObject: flag(sql`substr(${columns.postingLink}, 1, 1) = '{'`),
    // Operational identity lives in its own column; one left in the
    // provider document would change the complete decode.
    providerIdentityMentions: occurrences(columns.provider, "identity"),
    providerEscapes: occurrences(columns.provider, "\\u"),
  };
}

export type LedgerFlags = {
  [Key in keyof ReturnType<typeof ledgerFlags>]: number;
};

/**
 * One disjunct of a bounded ledger read. The store packs disjuncts into
 * statements within the driver's bound-parameter limit.
 *
 * - `accounts`: every row of these accounts in these statuses, every linked
 *   or aliased row, every undated row and every row whose provider text could
 *   state an identity a narrow read cannot see (a legacy identity, or any
 *   backslash, which can respell any key);
 * - `window`: rows of one account dated within inclusive bounds, on
 *   `coalesce(transaction_date, booking_date)` or on `billing_date`;
 * - `keys`: rows with these source keys;
 * - `base`: rows whose operational identity text contains the base as a JSON
 *   string (a row whose text could spell it otherwise is an `accounts` row);
 * - `ids`: these rows;
 * - `dependents`: rows superseded by, or billed lines of, these rows;
 * - `date`: every row of one account and exact transaction date.
 */
export type LedgerClause =
  | { kind: "accounts"; accounts: string[]; statuses: string[] }
  | {
      kind: "window";
      sourceScope: string;
      field: "transaction" | "billing";
      from: string;
      to: string;
    }
  | { kind: "keys"; keys: string[] }
  | { kind: "base"; base: string }
  | { kind: "ids"; ids: string[] }
  | { kind: "dependents"; ids: string[] }
  | { kind: "date"; sourceScope: string; transactionDate: string };

/** Parameters a disjunct binds. */
export function clauseParameters(clause: LedgerClause): number {
  switch (clause.kind) {
    case "accounts":
      return clause.accounts.length + clause.statuses.length + 3;
    case "window":
      return 3;
    case "keys":
      return clause.keys.length;
    case "base":
      return 1;
    case "ids":
      return clause.ids.length;
    case "dependents":
      return 2 * clause.ids.length;
    case "date":
      return 2;
  }
}

/** Whether a text column contains `text`, case-sensitively; false for null. Text functions only, as `ledgerFlags`. */
function holdsText(column: AnyColumn, text: string) {
  return sql`(${column} is not null and replace(${column}, ${text}, '') <> ${column})`;
}

/** The disjunction of `clauses` over a ledger read's joined columns. */
export function ledgerSelection(
  columns: {
    id: AnyColumn;
    sourceScope: AnyColumn;
    status: AnyColumn;
    sourceKey: AnyColumn;
    sourceAliases: AnyColumn;
    transactionDate: AnyColumn;
    bookingDate: AnyColumn;
    billingDate: AnyColumn;
    purchaseId: AnyColumn;
    supersededById: AnyColumn;
    provider: AnyColumn;
    providerIdentity: AnyColumn;
    postingLink: AnyColumn;
  },
  clauses: readonly LedgerClause[],
): SQL {
  const backslash = "\\";
  return or(
    ...clauses.map((clause) => {
      switch (clause.kind) {
        case "accounts":
          return sql`(${inArray(columns.sourceScope, clause.accounts)} and (${or(
            inArray(columns.status, clause.statuses),
            sql`(${columns.postingLink} is not null and ${columns.postingLink} <> 'null')`,
            sql`${columns.sourceAliases} <> '[]'`,
            sql`(${columns.transactionDate} is null and ${columns.bookingDate} is null and ${columns.billingDate} is null)`,
            holdsText(columns.provider, "identity"),
            holdsText(columns.provider, backslash),
            holdsText(columns.providerIdentity, backslash),
          )}))`;
        case "window":
          return sql`(${columns.sourceScope} = ${clause.sourceScope} and ${
            clause.field === "transaction"
              ? sql`coalesce(${columns.transactionDate}, ${columns.bookingDate})`
              : columns.billingDate
          } between ${clause.from} and ${clause.to})`;
        case "keys":
          return inArray(columns.sourceKey, clause.keys);
        case "base":
          return holdsText(
            columns.providerIdentity,
            JSON.stringify(clause.base),
          );
        case "ids":
          return inArray(columns.id, clause.ids);
        case "dependents":
          return or(
            inArray(columns.supersededById, clause.ids),
            inArray(columns.purchaseId, clause.ids),
          );
        case "date":
          return sql`(${columns.sourceScope} = ${clause.sourceScope} and ${columns.transactionDate} = ${clause.transactionDate})`;
      }
    }),
  )!;
}

export function planCondition(
  table: TransactionColumns & Table,
  connectionId: string,
  scope?: PlanScope,
) {
  return and(
    eq(table.connectionId, connectionId),
    scope &&
      ("transactionId" in scope
        ? eq(table.id, scope.transactionId)
        : inArray(
            table.sourceScope,
            sql`(select ${table.sourceScope} from ${table} where ${table.id} = ${scope.accountOf})`,
          )),
  );
}

export function excludedSet(table: Table, omit: string[]) {
  return Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([key]) => !omit.includes(key))
      .map(([key, column]) => [
        key,
        sql`excluded.${sql.identifier(column.name)}`,
      ]),
  );
}

export function* chunks<Row>(rows: readonly Row[], size: number) {
  for (let offset = 0; offset < rows.length; offset += size) {
    yield rows.slice(offset, offset + size);
  }
}

/** Current rows a coverage count includes: every row a current list returns. */
export function currentRows(connectionId: string): TransactionQuery {
  return {
    connectionId,
    presence: "current",
    includeSuperseded: false,
    perspective: "all",
  };
}

/**
 * Backfill window outcomes, worst first; a month takes its best window's. An
 * unfinished window of a refresh that has finished was never retrieved.
 */
export const BACKFILL_OUTCOMES = [
  "failed",
  "in_progress",
  "partial",
  "completed",
] as const satisfies readonly BackfillOutcome[];

/** A window's 1-based position in `BACKFILL_OUTCOMES`. */
export function backfillOutcomeRank(
  window: { status: AnyColumn },
  refresh: { status: AnyColumn },
) {
  return sql<number>`case
    when ${window.status} = 'completed' then 4
    when ${window.status} = 'partial' then 3
    when ${window.status} in ('pending', 'running')
      and ${refresh.status} in ('pending', 'running') then 2
    else 1 end`;
}
