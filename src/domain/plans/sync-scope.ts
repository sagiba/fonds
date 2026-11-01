import type { FinancialResponse, Transaction } from "../records.js";
import type { SourceAdapter } from "../source-adapter.js";
import { identityBase } from "./source-identity.js";
import type { LedgerRow, LedgerScope } from "./state.js";
import type { extractRun } from "./sync.js";

/** Days around a capture's request window and observations that it reconciles. */
export const SYNC_SCOPE_DAYS = 40;

/** The widest date distance between a pending row and a posted candidate. */
export const CANDIDATE_DAYS = 7;

const DAY_MILLISECONDS = 86_400_000;

/**
 * Transaction windows compare `transactionDate`, or `bookingDate` when the
 * transaction date is unknown; billing windows compare `billingDate`.
 */
export interface DateWindow {
  sourceScope: string;
  field: "transaction" | "billing";
  from: string;
  to: string;
}

/**
 * The ledger rows one sync application can decide on, before the store
 * closes them over the stored references that join rows into one decision.
 */
export interface SyncScope {
  /** Accounts the run's responses read. */
  accounts: string[];
  /**
   * Statuses every row of those accounts is read in: pending authorizations
   * and whatever the adapter's coverage can declare absent, whatever their dates.
   */
  statuses: Transaction["status"][];
  /** The padded request windows, and every observation's padded date. */
  windows: DateWindow[];
  /**
   * Days around an observed or named date that are read: the configured
   * padding, never less than the candidate distance.
   */
  radius: number;
  /** Source keys, aliases and purchase keys the observations name. */
  keys: string[];
  /** Identity bases the observations declare. */
  bases: string[];
  /** The hull of the padded request windows; observed dates never widen it. */
  requestScope: { from: string; to: string } | undefined;
}

const FIRST_DATE = "0001-01-01";
const LAST_DATE = "9999-12-31";

/**
 * A calendar date `days` away, kept within 0001-01-01 and 9999-12-31: year
 * zero and expanded years are no calendar date PostgreSQL accepts.
 */
function shifted(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MILLISECONDS;
  const result = new Date(time).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    return days < 0 ? FIRST_DATE : LAST_DATE;
  }
  return result < FIRST_DATE ? FIRST_DATE : result;
}

function lastDayOf(month: string): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  // setUTCFullYear, unlike Date.UTC, keeps years 0 to 99 as written.
  const last = new Date(0);
  last.setUTCFullYear(year, number, 0);
  return last.toISOString().slice(0, 10);
}

/**
 * The dates a response requested: its month, else its request bounds, else
 * the day it was captured. A historical response without bounds requested
 * no dates of its own.
 */
function requestedDates(
  response: Pick<FinancialResponse, "capturedAt" | "scope">,
): { from: string; to: string } | undefined {
  const { scope } = response;
  if (scope?.month) {
    return { from: `${scope.month}-01`, to: lastDayOf(scope.month) };
  }
  const captured = response.capturedAt.slice(0, 10);
  const from = scope?.from ?? scope?.windowFrom;
  const to = scope?.to ?? scope?.windowTo;
  if (from !== undefined || to !== undefined) {
    const start = from ?? to!;
    return { from: start, to: to ?? (start > captured ? start : captured) };
  }
  return scope?.kind === "history"
    ? undefined
    : { from: captured, to: captured };
}

/** Overlapping windows of one account and field, merged. */
function merged(windows: DateWindow[]): DateWindow[] {
  const result: DateWindow[] = [];
  for (const group of Map.groupBy(windows, (window) =>
    JSON.stringify([window.sourceScope, window.field]),
  ).values()) {
    const sorted = group.toSorted((a, b) => a.from.localeCompare(b.from));
    let current = sorted[0]!;
    for (const window of sorted.slice(1)) {
      if (window.from <= current.to) {
        if (window.to > current.to) {
          current = { ...current, to: window.to };
        }
      } else {
        result.push(current);
        current = window;
      }
    }
    result.push(current);
  }
  return result;
}

/**
 * Which rows one application reads before closure. Every response counts,
 * including those an implausible-empty check may later reject, so the
 * scope never depends on that decision. A month governs over request bounds
 * (a backfill month follows that month, never the day it ran), and
 * observations are padded by at least the candidate distance, so any row an
 * observation could be suggested with is read.
 */
export function syncScope(
  extraction: Pick<ReturnType<typeof extractRun>, "extracted">,
  adapter: Pick<SourceAdapter, "provider" | "sourceCoverage">,
  days: number,
): SyncScope {
  const accounts = new Set<string>();
  const windows: DateWindow[] = [];
  const keys = new Set<string>();
  const bases = new Set<string>();
  let requestScope: SyncScope["requestScope"];
  const radius = Math.max(days, CANDIDATE_DAYS);
  for (const { response, result } of extraction.extracted) {
    accounts.add(response.accountKey);
    const requested = requestedDates(response);
    if (requested) {
      const from = shifted(requested.from, -days);
      const to = shifted(requested.to, days);
      for (const field of ["transaction", "billing"] as const) {
        windows.push({ sourceScope: response.accountKey, field, from, to });
      }
      requestScope = {
        from:
          requestScope && requestScope.from < from ? requestScope.from : from,
        to: requestScope && requestScope.to > to ? requestScope.to : to,
      };
    }
    for (const input of result.transactions) {
      for (const key of [
        input.sourceKey,
        ...input.sourceAliases,
        ...(input.purchaseKey ? [input.purchaseKey] : []),
      ]) {
        keys.add(key);
      }
      bases.add(identityBase(input, adapter.provider));
      const date = input.transactionDate ?? input.bookingDate;
      if (date) {
        windows.push({
          sourceScope: input.sourceScope,
          field: "transaction",
          from: shifted(date, -radius),
          to: shifted(date, radius),
        });
      }
    }
  }
  return {
    accounts: [...accounts],
    statuses: [
      ...new Set<Transaction["status"]>([
        "pending",
        ...(adapter.sourceCoverage?.statuses ?? []),
      ]),
    ],
    windows: merged(windows),
    radius,
    keys: [...keys],
    bases: [...bases],
    requestScope,
  };
}

/**
 * Whether an observation names a row by source key, alias or identity base.
 * A named row can be matched or marked seen, so its stored date can become a
 * candidate's date and its date group can change.
 */
export function scopeNames(
  scope: Pick<SyncScope, "keys" | "bases">,
  provider: string,
): (row: LedgerRow) => boolean {
  const keys = new Set(scope.keys);
  const bases = new Set(scope.bases);
  return (row) =>
    [row.sourceKey, ...row.sourceAliases].some((key) => keys.has(key)) ||
    bases.has(row.sourceKey) ||
    bases.has(identityBase(row, provider));
}

/**
 * Windows of `radius` days around each row's transaction (or booking) date,
 * as `syncScope` pads an observation's date.
 */
export function namedWindows(
  rows: readonly LedgerRow[],
  radius: number,
): DateWindow[] {
  return merged(
    rows.flatMap((row) => {
      const date = row.transactionDate ?? row.bookingDate;
      return date
        ? [
            {
              sourceScope: row.sourceScope,
              field: "transaction" as const,
              from: shifted(date, -radius),
              to: shifted(date, radius),
            },
          ]
        : [];
    }),
  );
}

/** Whether a transaction window holds every row of this account and date. */
export function windowHolds(
  windows: readonly DateWindow[],
  sourceScope: string,
  transactionDate: string,
): boolean {
  return windows.some(
    (window) =>
      window.field === "transaction" &&
      window.sourceScope === sourceScope &&
      window.from <= transactionDate &&
      transactionDate <= window.to,
  );
}

/**
 * The bounds of a load: transaction windows it read whole, the exact-date
 * groups it completed and the IDs it found absent.
 */
export function ledgerScope(
  windows: readonly DateWindow[],
  groups: Iterable<readonly [string, string]>,
  missing: ReadonlySet<string>,
): LedgerScope {
  const complete = new Set(
    [...groups].map(([sourceScope, date]) =>
      JSON.stringify([sourceScope, date]),
    ),
  );
  return {
    completeDate: (sourceScope, transactionDate) =>
      complete.has(JSON.stringify([sourceScope, transactionDate])) ||
      windowHolds(windows, sourceScope, transactionDate),
    missing,
  };
}
