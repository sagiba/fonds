import { expect } from "vitest";

import type { NarrowRow } from "../../src/domain/plans/state.js";
import type { Transaction } from "../../src/domain/records.js";
import {
  type ApplicationLoadingComparison,
  verifyApplicationLoading,
} from "../../src/storage/store.js";

type LoadedRows = Pick<
  ApplicationLoadingComparison,
  "narrowRows" | "completeRows" | "doubtful"
>;

/**
 * Importing this module makes every sync application in the test file also
 * plan from complete rows and every applied run. It requires the same plan
 * output, including events, the run update and the run-history summary to
 * be stored, and requires every narrow row the application loaded to state
 * exactly what that row's complete decode states.
 */
export const loadingComparisons: Omit<
  ApplicationLoadingComparison,
  "dependent" | "complete"
>[] = [];

/** What a narrow row must state, picked field by field from a complete row. */
export function expectedNarrowRow(row: Transaction): NarrowRow {
  const identities: Record<
    string,
    NonNullable<NarrowRow["providerIdentity"]>[string]
  > = {};
  for (const [provider, namespace] of Object.entries(row.details.provider)) {
    if (Object.hasOwn(namespace, "identity")) {
      identities[provider] = namespace.identity!;
    }
  }
  const { details } = row;
  return {
    id: row.id,
    connectionId: row.connectionId,
    sourceScope: row.sourceScope,
    cardId: row.cardId,
    sourceKey: row.sourceKey,
    sourceAliases: row.sourceAliases,
    identityStrength: row.identityStrength,
    status: row.status,
    presence: row.presence,
    ...(row.sourceAbsence === undefined
      ? {}
      : { sourceAbsence: row.sourceAbsence }),
    kind: row.kind,
    merchantName: row.merchantName,
    transactionDate: row.transactionDate,
    bookingDate: row.bookingDate,
    billingDate: row.billingDate,
    amountMinor: row.amountMinor,
    currency: row.currency,
    amountBasis: row.amountBasis,
    originalAmountMinor: row.originalAmountMinor,
    originalCurrency: row.originalCurrency,
    installmentCount: row.installmentCount,
    purchaseId: row.purchaseId,
    installmentNumber: row.installmentNumber,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    lastSeenRunId: row.lastSeenRunId,
    version: row.version,
    supersededById: row.supersededById,
    hydration: "narrow",
    retired: row.sourceEvidence?.identity?.retiredFromMatching === true,
    providerIdentity: identities,
    details: {
      issues: details.issues,
      ...(details.pendingPostingCandidates === undefined
        ? {}
        : { pendingPostingCandidates: details.pendingPostingCandidates }),
      ...(details.rejectedPostingKeys === undefined
        ? {}
        : { rejectedPostingKeys: details.rejectedPostingKeys }),
      ...(details.postingOverlap === undefined
        ? {}
        : { postingOverlap: details.postingOverlap }),
      ...(details.postingLink === undefined
        ? {}
        : { postingLink: { present: true } }),
    },
  };
}

/**
 * Every narrow row, hydrated or not, states exactly its complete facts; a
 * row in doubt is exempt because it is always hydrated before planning.
 */
export function expectNarrowRowsExact(loaded: LoadedRows): void {
  expect(loaded.narrowRows.map(({ id }) => id)).toEqual(
    loaded.completeRows.map(({ id }) => id),
  );
  const complete = new Map(loaded.completeRows.map((row) => [row.id, row]));
  for (const row of loaded.narrowRows) {
    if (!loaded.doubtful.includes(row.id)) {
      expect(row).toStrictEqual(expectedNarrowRow(complete.get(row.id)!));
    }
  }
}

/**
 * The committed plan saw every row in the complete load's order, hydrated
 * rows in their own positions: ties between equal source keys follow it.
 */
export function expectPlannedOrder(
  loaded: Pick<
    ApplicationLoadingComparison,
    "plannedRows" | "completeRows" | "hydrated"
  >,
): void {
  expect(loaded.plannedRows.map(({ id }) => id)).toEqual(
    loaded.completeRows.map(({ id }) => id),
  );
  for (const { id, narrow } of loaded.plannedRows) {
    expect(narrow).toBe(!loaded.hydrated.includes(id));
  }
}

verifyApplicationLoading(({ dependent, complete, ...comparison }) => {
  loadingComparisons.push(comparison);
  expect(dependent).toStrictEqual(complete);
  expectNarrowRowsExact(comparison);
  expectPlannedOrder(comparison);
  for (const id of comparison.doubtful) {
    expect(comparison.hydrated).toContain(id);
  }
});
