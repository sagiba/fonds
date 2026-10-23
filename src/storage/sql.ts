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
  sql,
  type Table,
} from "drizzle-orm";

import type {
  EventQuery,
  TransactionQuery,
} from "../application/query-inputs.js";
import { type Perspective, perspectiveRule } from "../domain/read-model.js";
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
    filters.merchantCategoryCode === undefined
      ? undefined
      : eq(table.merchantCategoryCode, filters.merchantCategoryCode),
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

export function totalsColumns<T extends TransactionColumns>(
  table: T,
): Pick<
  T,
  | "supersededById"
  | "presence"
  | "sourceAbsence"
  | "status"
  | "kind"
  | "amountMinor"
  | "currency"
  | "amountBasis"
  | "identityStrength"
  | "originalCurrency"
  | "fxFeeMinor"
  | "fxFeeCurrency"
> {
  return {
    supersededById: table.supersededById,
    presence: table.presence,
    sourceAbsence: table.sourceAbsence,
    status: table.status,
    kind: table.kind,
    amountMinor: table.amountMinor,
    currency: table.currency,
    amountBasis: table.amountBasis,
    identityStrength: table.identityStrength,
    originalCurrency: table.originalCurrency,
    fxFeeMinor: table.fxFeeMinor,
    fxFeeCurrency: table.fxFeeCurrency,
  };
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
