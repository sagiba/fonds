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
 * plan from complete rows and every applied run, with the same clock and
 * IDs. The committed plan, which read only its scope, must decide exactly
 * as that complete plan (`expectScopedOutcome`), and every narrow row it
 * loaded must state exactly what that row's complete decode states.
 */
export const loadingComparisons: Omit<
  ApplicationLoadingComparison,
  "dependent" | "complete"
>[] = [];

/**
 * Review issues a complete plan may re-derive on rows a bounded load left
 * out, once stored review state is stale for current rules (a policy
 * change). Ordinal holds are financial and never among them.
 */
const STALE_REVIEW_ISSUES = [
  "possible_pending_posted_match",
  "possible_duplicate_plan",
  "conflicting_installment_lines",
  "conflicting_installment_plan",
  "conflicting_installment_restatement",
];

let staleReview = false;

/**
 * Admits, until reset, the one difference a policy change makes: review
 * issues and candidates the complete plan re-derives on rows outside scope.
 */
export function allowStaleReview(enabled: boolean): void {
  staleReview = enabled;
}

type Planned = ApplicationLoadingComparison["dependent"];

interface PlannedPair {
  dependent: Planned;
  complete: Planned;
  comparison: Omit<ApplicationLoadingComparison, "dependent" | "complete">;
}

let latestPair: PlannedPair | undefined;

/** Both plans of the latest application, for checking the verifier itself. */
export function latestPlannedApplication(): PlannedPair {
  return structuredClone(latestPair!);
}

const MATCH_ISSUE = "possible_pending_posted_match";

const sortedIssues = (row: Transaction) =>
  [...new Set(row.details.issues)].sort();

type PlannedEvent = Planned["events"][number];

interface ReviewState {
  required: boolean;
  reasons: string[];
  candidates: string[];
}

/** What a permitted difference changed on one row. */
interface ReviewDelta {
  id: string;
  /** The issues the allowance permits to differ. */
  issues: readonly string[];
  stored: Transaction;
  ours: Transaction;
  theirs: Transaction;
  issuesChanged: boolean;
  candidatesChanged: boolean;
  /** Whether the run imported the row's account as a baseline, which signals no review. */
  baseline: boolean;
}

const REVIEW_EVENTS = new Set([
  "transaction.review_required",
  "transaction.review_resolved",
]);

const sortedCandidates = (row: Transaction) =>
  [...new Set(row.details.pendingPostingCandidates ?? [])].sort();

/** An update event with its source-issue lists in sorted order. */
function issuesSorted(event: PlannedEvent): PlannedEvent {
  const sort = (state: unknown) => {
    const copy = { ...(state as Record<string, unknown>) };
    if (Array.isArray(copy.sourceIssues)) {
      copy.sourceIssues = [...(copy.sourceIssues as string[])].sort();
    }
    return copy;
  };
  return { ...event, before: sort(event.before), after: sort(event.after) };
}

/**
 * The complete plan's events with each permitted difference taken back out.
 * The events a permitted difference causes are derived from the row's own
 * delta: exactly one update recording exactly the permitted source-issue
 * change (merged into the committed plan's update of that row, if it made
 * one), and the one review transition that change makes. Each must be in the
 * complete plan exactly as derived; it is then replaced by the committed
 * plan's event or removed, and whatever else differs remains for the exact
 * comparison.
 */
function withoutPermittedEvents(
  dependent: Planned,
  complete: Planned,
  deltas: readonly ReviewDelta[],
): PlannedEvent[] {
  const events = [...complete.events];
  const replace = (theirs: PlannedEvent, ours: PlannedEvent | undefined) => {
    const index = events.indexOf(theirs);
    if (ours) {
      events[index] = ours;
    } else {
      events.splice(index, 1);
    }
  };
  for (const delta of deltas) {
    const { id } = delta;
    const ofRow = (list: PlannedEvent[], kind: (type: string) => boolean) =>
      list.filter((event) => event.transactionId === id && kind(event.type));
    const isUpdate = (type: string) => type === "transaction.updated";
    const isReview = (type: string) => REVIEW_EVENTS.has(type);
    const ourUpdates = ofRow(dependent.events, isUpdate);
    expect(ourUpdates.length, `${id} updates`).toBeLessThanOrEqual(1);
    if (delta.issuesChanged) {
      const theirUpdates = ofRow(events, isUpdate);
      expect(theirUpdates, `${id} updates`).toHaveLength(1);
      const [ours] = ourUpdates;
      const theirs = theirUpdates[0]!;
      expect(issuesSorted(theirs), `${id} update`).toStrictEqual(
        issuesSorted({
          ...(ours ?? theirs),
          transactionId: id,
          type: "transaction.updated",
          before: {
            ...(ours?.before as object | undefined),
            sourceIssues: sortedIssues(delta.stored),
          },
          after: {
            ...(ours?.after as object | undefined),
            sourceIssues: sortedIssues(delta.theirs),
          },
        }),
      );
      replace(theirs, ours);
    }
    if (!delta.issuesChanged && !delta.candidatesChanged) {
      continue;
    }
    const ourReviews = ofRow(dependent.events, isReview);
    const theirReviews = ofRow(events, isReview);
    expect(ourReviews.length, `${id} reviews`).toBeLessThanOrEqual(1);
    expect(theirReviews.length, `${id} reviews`).toBeLessThanOrEqual(1);
    if (delta.baseline) {
      expect([...ourReviews, ...theirReviews], `${id} reviews`).toEqual([]);
      continue;
    }
    const [ours] = ourReviews;
    const [theirs] = theirReviews;
    // A changed issue or candidate always changes the review signal, so
    // one of the plans recorded the state before it.
    const known = ours ?? theirs;
    expect(known, `${id} review`).toBeDefined();
    const start = known!.before as ReviewState;
    const base = (ours?.after ?? start) as ReviewState;
    const reasons = [
      ...new Set([
        ...base.reasons.filter((reason) => !delta.issues.includes(reason)),
        ...sortedIssues(delta.theirs).filter((issue) =>
          delta.issues.includes(issue),
        ),
      ]),
    ].sort();
    const candidates = delta.issues.includes(MATCH_ISSUE)
      ? sortedCandidates(delta.theirs)
      : base.candidates;
    const after: ReviewState = {
      required: reasons.length > 0 || candidates.length > 0,
      reasons,
      candidates,
    };
    const changed =
      JSON.stringify([start.reasons, start.candidates]) !==
      JSON.stringify([after.reasons, after.candidates]);
    const type = !changed
      ? undefined
      : after.required
        ? "transaction.review_required"
        : start.required
          ? "transaction.review_resolved"
          : undefined;
    if (type === undefined) {
      expect(theirs, `${id} review`).toBeUndefined();
      continue;
    }
    expect(theirs, `${id} review`).toStrictEqual({
      ...(ours ?? theirs!),
      type,
      before: start,
      after,
    });
    replace(theirs!, ours);
  }
  return events;
}

/**
 * The committed plan equals the complete plan in its result, ordered
 * events, run update, run history, deferred evidence and every catalog,
 * annotation, transaction and observation write, with two allowances only:
 *
 * - a loaded row whose exact-date group the bounded load left incomplete
 *   (`undecided`) may differ in its `possible_duplicate_plan` flag;
 * - with `allowStaleReview`, the complete plan may re-derive the review
 *   issues and candidates of a row the bounded load left out.
 *
 * Each allowance admits only that difference and what follows from it: the
 * complete plan's row must be the committed row (or the stored row) with
 * the permitted issues and candidates applied, versioned once if its source
 * issues changed and the committed plan did not already version it; its
 * extra events must be exactly those that change causes
 * (`withoutPermittedEvents`); and `updated` must differ by exactly the rows
 * it versioned. Otherwise the complete plan
 * writes no row the bounded load left out.
 */
export function expectScopedOutcome(
  dependent: Planned,
  complete: Planned,
  comparison: Pick<
    ApplicationLoadingComparison,
    "narrowRows" | "completeRows" | "undecided"
  >,
): void {
  const loaded = new Set(comparison.narrowRows.map(({ id }) => id));
  const stored = new Map(comparison.completeRows.map((row) => [row.id, row]));
  const undecided = new Set(comparison.undecided);
  const inserted = (id: string) => !stored.has(id);
  const allowance = (id: string): readonly string[] | undefined =>
    undecided.has(id)
      ? ["possible_duplicate_plan"]
      : staleReview && !loaded.has(id) && !inserted(id)
        ? STALE_REVIEW_ISSUES
        : undefined;
  const written = (plan: Planned, id: string) =>
    plan.transactionWrites.find(([key]) => key === id)?.[1] ??
    plan.observationWrites.find(([key]) => key === id)?.[1];
  const ids = new Set(
    [dependent, complete].flatMap((plan) =>
      [...plan.transactionWrites, ...plan.observationWrites].map(([id]) => id),
    ),
  );
  let versioned = 0;
  const deltas: ReviewDelta[] = [];
  const baselineAccounts = new Set(
    complete.events.flatMap((event) =>
      event.type === "sync.baseline"
        ? ((event.after as { accountKeys?: string[] } | null)?.accountKeys ??
          [])
        : [],
    ),
  );
  for (const id of ids) {
    const issues = allowance(id);
    if (issues === undefined) {
      expect(loaded.has(id) || inserted(id), id).toBe(true);
      continue;
    }
    const before = stored.get(id)!;
    const ours = written(dependent, id) ?? before;
    const theirs = written(complete, id) ?? before;
    // The complete plan may differ only in the permitted issues.
    expect(
      sortedIssues(theirs).filter((issue) => !issues.includes(issue)),
      id,
    ).toEqual(sortedIssues(ours).filter((issue) => !issues.includes(issue)));
    const issuesChanged =
      JSON.stringify(sortedIssues(theirs)) !==
      JSON.stringify(sortedIssues(ours));
    const bump = issuesChanged && ours.version === before.version;
    const {
      issues: _issues,
      pendingPostingCandidates: ourCandidates,
      ...details
    } = ours.details;
    const candidates = issues.includes(MATCH_ISSUE)
      ? theirs.details.pendingPostingCandidates
      : ourCandidates;
    expect(theirs, id).toStrictEqual({
      ...ours,
      version: bump ? before.version + 1 : ours.version,
      details: {
        ...details,
        issues: theirs.details.issues,
        ...("pendingPostingCandidates" in
        (issues.includes(MATCH_ISSUE) ? theirs.details : ours.details)
          ? { pendingPostingCandidates: candidates }
          : {}),
      },
    });
    if (issuesChanged) {
      expect(
        complete.transactionWrites.some(([key]) => key === id),
        id,
      ).toBe(true);
    }
    if (bump) {
      versioned++;
    }
    deltas.push({
      id,
      issues,
      stored: before,
      ours,
      theirs,
      issuesChanged,
      candidatesChanged:
        JSON.stringify(sortedCandidates(ours)) !==
        JSON.stringify(sortedCandidates(theirs)),
      baseline: baselineAccounts.has(before.sourceScope),
    });
  }
  const exact = (writes: [string, Transaction][]) =>
    writes.filter(([id]) => allowance(id) === undefined);
  expect(exact(dependent.transactionWrites)).toStrictEqual(
    exact(complete.transactionWrites),
  );
  expect(exact(dependent.observationWrites)).toStrictEqual(
    exact(complete.observationWrites),
  );
  expect(dependent.events).toStrictEqual(
    withoutPermittedEvents(dependent, complete, deltas),
  );
  const { updated: ourUpdated, ...ourResult } = dependent.result;
  const { updated: theirUpdated, ...theirResult } = complete.result;
  expect(ourResult).toStrictEqual(theirResult);
  expect(theirUpdated - ourUpdated).toBe(versioned);
  for (const key of [
    "annotationWrites",
    "accountWrites",
    "cardWrites",
    "deferredCandidates",
    "runUpdate",
    "runHistory",
  ] as const) {
    expect(dependent[key], key).toStrictEqual(complete[key]);
  }
}

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
 * A bounded load holds some of the complete rows, in their order.
 */
export function expectNarrowRowsExact(loaded: LoadedRows): void {
  const ids = new Set(loaded.narrowRows.map(({ id }) => id));
  expect(loaded.narrowRows.map(({ id }) => id)).toEqual(
    loaded.completeRows.map(({ id }) => id).filter((id) => ids.has(id)),
  );
  const complete = new Map(loaded.completeRows.map((row) => [row.id, row]));
  for (const row of loaded.narrowRows) {
    if (!loaded.doubtful.includes(row.id)) {
      expect(row).toStrictEqual(expectedNarrowRow(complete.get(row.id)!));
    }
  }
}

/**
 * The committed plan saw the rows it loaded in the complete load's order,
 * hydrated rows in their own positions: ties between equal source keys
 * follow it.
 */
export function expectPlannedOrder(
  loaded: Pick<
    ApplicationLoadingComparison,
    "plannedRows" | "completeRows" | "hydrated"
  >,
): void {
  const ids = new Set(loaded.plannedRows.map(({ id }) => id));
  expect(loaded.plannedRows.map(({ id }) => id)).toEqual(
    loaded.completeRows.map(({ id }) => id).filter((id) => ids.has(id)),
  );
  for (const { id, narrow } of loaded.plannedRows) {
    expect(narrow).toBe(!loaded.hydrated.includes(id));
  }
}

verifyApplicationLoading(({ dependent, complete, ...comparison }) => {
  loadingComparisons.push(comparison);
  latestPair = { dependent, complete, comparison };
  expectScopedOutcome(dependent, complete, comparison);
  expectNarrowRowsExact(comparison);
  expectPlannedOrder(comparison);
  for (const id of comparison.doubtful) {
    expect(comparison.hydrated).toContain(id);
  }
});
