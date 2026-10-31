import type { TransactionFacts } from "../model.js";
import { canonicalJson } from "../observations.js";
import type { Transaction } from "../records.js";
import type { SourceAdapter } from "../source-adapter.js";
import {
  financialState,
  identitySourceRows,
  type SourceIdentityFacts,
} from "./source-identity.js";
import type { LedgerRow } from "./state.js";

// Groups stored before captured identity comparisons existed. Once every stored
// uncertain group carries a comparison, this module has nothing left to decide.

export const UNVERIFIED_LEGACY_IDENTITY = "unverified_legacy_identity";

/** Captured facts of current inputs whose financial facts were asserted, not projected. */
export type PristineInputs = ReadonlyMap<
  TransactionFacts,
  ReturnType<typeof financialState>
>;

/** A migration comparison is proved only where accepted facts were not projected. */
function legacyIdentityProof(
  row: TransactionFacts,
  financial: ReturnType<typeof financialState>,
  adapter: SourceAdapter,
): string | undefined {
  const identityIssues = new Set([
    "ambiguous_identity",
    "ambiguous_source_identity",
    "weak_source_identity",
    UNVERIFIED_LEGACY_IDENTITY,
  ]);
  if (
    row.cardId === null ||
    row.purchaseId !== null ||
    row.installmentNumber !== null ||
    (row.installmentCount !== null && row.installmentCount !== 1) ||
    row.amountMinor === null ||
    row.currency === null ||
    row.kind === "unknown" ||
    row.amountBasis === "unknown" ||
    row.details.postingLink ||
    row.details.issues.some((issue) => !identityIssues.has(issue))
  ) {
    return undefined;
  }
  const source = identitySourceRows(row, adapter);
  if (
    source.length === 0 ||
    source.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).length === 0,
    )
  ) {
    return undefined;
  }
  return canonicalJson({
    sourceScope: row.sourceScope,
    cardId: row.cardId,
    financial,
    source,
  });
}

/** Unknown old comparisons are initialized from proved current evidence, never old money. */
function legacyIdentityComparisons(
  oldGroup: Transaction[],
  newGroup: SourceIdentityFacts[],
  pristineInputs: PristineInputs,
  adapter: SourceAdapter,
): SourceIdentityFacts[] | undefined {
  if (oldGroup.length > newGroup.length) {
    return undefined;
  }
  const previousByProof = new Map<string, Transaction>();
  for (const previous of oldGroup) {
    const proof = legacyIdentityProof(
      previous,
      financialState(previous),
      adapter,
    );
    if (proof === undefined || previousByProof.has(proof)) {
      return undefined;
    }
    previousByProof.set(proof, previous);
  }
  const comparisons = new Map<string, SourceIdentityFacts>();
  for (const input of newGroup) {
    const pristine = pristineInputs.get(input);
    const proof = pristine && legacyIdentityProof(input, pristine, adapter);
    if (proof === undefined) {
      return undefined;
    }
    const previous = previousByProof.get(proof);
    if (!previous) {
      continue;
    }
    if (comparisons.has(previous.id)) {
      return undefined;
    }
    const captured = previous.sourceEvidence?.identity?.financialFingerprint;
    if (
      captured !== undefined &&
      captured !== input.sourceEvidence?.identity?.financialFingerprint
    ) {
      return undefined;
    }
    comparisons.set(previous.id, {
      ...previous,
      sourceEvidence: {
        ...previous.sourceEvidence,
        identity: input.sourceEvidence?.identity,
      },
    });
  }
  // Extra observations are new only after every legacy member has exactly one
  // pristine counterpart. A different source key or amount alone proves neither.
  return comparisons.size === oldGroup.length
    ? oldGroup.map((row) => comparisons.get(row.id)!)
    : undefined;
}

/**
 * Old comparisons are proved, or the whole group stays protected: missing
 * migration metadata is evidence neither of a new transaction nor of absence.
 * Only an uncertain group's comparison group is returned; `full` supplies the
 * complete rows its captured comparisons need.
 */
export function legacyGroupComparison<Row extends LedgerRow>(
  oldGroup: Row[],
  knownGroup: readonly Row[],
  newGroup: SourceIdentityFacts[],
  uncertain: boolean,
  pristineInputs: PristineInputs,
  adapter: SourceAdapter,
  full: (row: Row) => Transaction,
) {
  const unknownMembership = knownGroup.filter(
    (row) =>
      row.presence === "not_returned" &&
      !row.sourceAbsence &&
      !row.supersededById &&
      row.identityStrength !== "native" &&
      full(row).sourceEvidence?.identity?.financialFingerprint === undefined,
  );
  const missingComparison =
    uncertain &&
    oldGroup.some(
      (row) =>
        full(row).sourceEvidence?.identity?.financialFingerprint === undefined,
    );
  const comparisonGroup: SourceIdentityFacts[] | undefined = missingComparison
    ? legacyIdentityComparisons(
        oldGroup.map(full),
        newGroup,
        pristineInputs,
        adapter,
      )
    : uncertain
      ? oldGroup.map(full)
      : [];
  return {
    missingComparison,
    comparisonGroup,
    unverified: comparisonGroup === undefined || unknownMembership.length > 0,
    protectedGroup: [...oldGroup, ...unknownMembership],
  };
}
