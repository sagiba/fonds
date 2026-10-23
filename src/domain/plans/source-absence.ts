import type { SourceAbsence, TransactionFacts } from "../model.js";
import type { FinancialResponse, Transaction } from "../records.js";
import type { ExtractionResult, SourceAdapter } from "../source-adapter.js";
import {
  snapshotContainsRow,
  sourceCoverage,
  type SourceSnapshotCoverage,
} from "./source-membership.js";

type Status = "posted" | "pending";

/** Accepted coverage reconstructed from retained run metadata. */
export interface CoverageHistory {
  /** Newest capture first. */
  coverages: readonly { runId: string; coverage: SourceSnapshotCoverage }[];
  response(
    runId: string,
    accountKey: string,
  ): Omit<FinancialResponse, "responseText"> | undefined;
}

interface ResponseContext {
  adapter: SourceAdapter;
  response: FinancialResponse;
  history: CoverageHistory;
  /** Read at call time: a capture can bind new cards while it is planned. */
  cardKeys: ReadonlyMap<string, string>;
}

function cardKey(
  cardKeys: ReadonlyMap<string, string>,
  row: Pick<TransactionFacts, "cardId">,
): string | undefined {
  return row.cardId ? cardKeys.get(row.cardId) : undefined;
}

/**
 * Negative evidence for one response: what its own coverage omits, and which
 * retained coverage still binds facts it observes. Membership comes from
 * source-membership; this module owns only the chronology of omissions.
 */
export function responseAbsence({
  adapter,
  response,
  history,
  cardKeys,
  result,
  stale,
}: ResponseContext & {
  result: Pick<ExtractionResult, "partitions" | "historical">;
  stale: (status: Status) => boolean;
}) {
  const containedIn = (
    coverage: SourceSnapshotCoverage,
    input: TransactionFacts,
  ) =>
    snapshotContainsRow(
      adapter,
      coverage,
      input,
      response,
      cardKey(cardKeys, input),
    );
  /** Newest retained coverage at or after this capture that omits these facts. */
  const prior = (
    input: TransactionFacts,
    lastSeenAt?: string,
  ): SourceAbsence | undefined => {
    const witness = history.coverages.find(
      ({ coverage }) =>
        coverage.capturedAt >= response.capturedAt &&
        (lastSeenAt === undefined || coverage.capturedAt > lastSeenAt) &&
        containedIn(coverage, input),
    );
    return (
      witness && {
        runId: witness.runId,
        capturedAt: witness.coverage.capturedAt,
      }
    );
  };
  return {
    /** This response's coverage contains a stored row it may have omitted. */
    covers(previous: Transaction): boolean {
      const partition = result.partitions.find(
        (part) => part.status === previous.status,
      );
      const coverage =
        partition && !result.historical && !stale(previous.status)
          ? sourceCoverage(adapter, response, partition)
          : undefined;
      return (
        coverage !== undefined &&
        previous.lastSeenAt <= response.capturedAt &&
        snapshotContainsRow(
          adapter,
          coverage,
          previous,
          history.response(previous.lastSeenRunId, previous.sourceScope),
          cardKey(cardKeys, previous),
        )
      );
    },
    // A previously accepted complete snapshot also constrains identities first
    // discovered through a later-arriving archive. No raw response is required:
    // an already observed native identity resolves to its existing row.
    prior,
    /** The receipt that governs facts observed for a stored row. */
    reconciled(
      input: TransactionFacts,
      previous: Pick<Transaction, "lastSeenAt" | "sourceAbsence">,
    ): SourceAbsence | undefined {
      const applicable = prior(input, previous.lastSeenAt);
      const retained = previous.sourceAbsence;
      if (!retained || retained.capturedAt < response.capturedAt) {
        return applicable;
      }
      const witnesses = history.coverages.filter(
        ({ runId, coverage }) =>
          runId === retained.runId &&
          coverage.capturedAt === retained.capturedAt &&
          coverage.accountKey === input.sourceScope &&
          coverage.status === input.status,
      );
      // Facts have their own positive clock. A later negative receipt remains
      // binding unless its retained scope disproves applicability to those facts.
      const stillBinding =
        witnesses.length === 0 ||
        witnesses.some(({ coverage }) => containedIn(coverage, input));
      return stillBinding &&
        (!applicable || retained.capturedAt >= applicable.capturedAt)
        ? retained
        : applicable;
    },
  };
}

/** Empty-response safeguards cannot grant coverage the source did not declare. */
export function implausiblyEmpty({
  adapter,
  response,
  history,
  cardKeys,
  result,
  rows,
  stale,
}: ResponseContext & {
  result: Pick<ExtractionResult, "transactions" | "partitions" | "historical">;
  rows: readonly Transaction[];
  stale: (status: Status) => boolean;
}): boolean {
  if (result.historical) {
    return false;
  }
  const whollyEmpty = result.transactions.length === 0;
  return result.partitions.some((partition) => {
    if (
      !(
        (adapter.rejectEmptyRecent && whollyEmpty) ||
        (adapter.rejectEmptyRecentPosted &&
          partition.status === "posted" &&
          !result.transactions.some((row) => row.status === "posted"))
      ) ||
      stale(partition.status)
    ) {
      return false;
    }
    const coverage = sourceCoverage(adapter, response, partition);
    if (!coverage) {
      return false;
    }
    const coveredCurrent = (row: Transaction) =>
      row.presence !== "removed" &&
      row.sourceAbsence === undefined &&
      !row.supersededById &&
      row.lastSeenAt <= response.capturedAt &&
      snapshotContainsRow(
        adapter,
        coverage,
        row,
        history.response(row.lastSeenRunId, row.sourceScope),
        cardKey(cardKeys, row),
      );
    return rows.some((row) => {
      const link = row.details.postingLink;
      return (
        coveredCurrent(row) ||
        (row.presence !== "removed" &&
          !row.supersededById &&
          link !== undefined &&
          !link.split &&
          coveredCurrent(link.pending))
      );
    });
  });
}
