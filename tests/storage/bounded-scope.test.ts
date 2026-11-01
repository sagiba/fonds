import "../helpers/application-loading-differential.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSyncDiagnosticReport,
  type SyncDiagnostic,
} from "../../src/application/sync-diagnostics.js";
import { emptyDetails, type TransactionInput } from "../../src/domain/model.js";
import type { CollectionScope } from "../../src/domain/records.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { isracardAdapter } from "../../src/providers/isracard/adapter.js";
import { configureHydration } from "../../src/storage/store.js";
import {
  allowStaleReview,
  expectScopedOutcome,
  latestPlannedApplication,
  loadingComparisons,
} from "../helpers/application-loading-differential.js";
import { SEED_RUN, seedRun, storedRow } from "../helpers/ledger-rows.js";
import { authorization, postingAdapter } from "../helpers/posting.js";
import {
  backends,
  type Harness,
  insertTransactionFixture,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

const connectionId = "bounded";
const latest = () => loadingComparisons.at(-1)!;

/**
 * Pending-only coverage without a recent cutoff, as Isracard declares, so a
 * capture reads posted rows only within its scope. Its partitions and
 * automatic posting are the synthetic CAL-like adapter's.
 */
const {
  recentComparableDays: _cutoff,
  rejectEmptyRecentPosted: _rejection,
  ...uncut
} = postingAdapter;
const pendingOnly: SourceAdapter = {
  ...uncut,
  sourceCoverage: { kind: "same_origin", statuses: ["pending"] },
};

/** Pending-only coverage for inputs that declare their own identity bases. */
const declaring: SourceAdapter = {
  ...synthetic,
  sourceCoverage: { kind: "same_origin", statuses: ["pending"] },
};

/** Pending coverage over the 60 days before capture, as CAL declares. */
const windowed: SourceAdapter = {
  ...pendingOnly,
  recentComparableDays: 60,
  rejectEmptyRecent: true,
  sourceCoverage: {
    kind: "account_window",
    statuses: ["pending"],
    resources: ["synthetic:cal/recent"],
    dateField: "transactionDate",
    days: 60,
    requireOriginMatch: true,
  },
};

const purchase = (fields: Partial<TransactionInput> = {}) =>
  row("plan", {
    amountMinor: -36000,
    installmentCount: 36,
    transactionDate: "2038-07-15",
    merchantName: "Plan shop",
    ...fields,
  });

const line = (
  key: string,
  ordinal: number,
  billingDate: string,
  fields: Partial<TransactionInput> = {},
) =>
  row(key, {
    amountBasis: "booked_entry",
    amountMinor: -1000,
    installmentCount: 36,
    installmentNumber: ordinal,
    purchaseKey: "plan",
    transactionDate: "2038-07-15",
    billingDate,
    merchantName: "Plan shop",
    ...fields,
  });

describe.each(backends)("%s bounded sync scope", (backend) => {
  let db: Harness;
  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(async () => {
    configureHydration();
    allowStaleReview(false);
    await db.close();
  });

  const capture = (
    runId: string,
    capturedAt: string,
    rows: TransactionInput[],
    options: {
      adapter?: SourceAdapter;
      scope?: CollectionScope;
      endpoint?: string;
    } = {},
  ) =>
    db.ingestRun(
      {
        connectionId,
        runId,
        responses: [
          {
            accountKey: "account",
            endpoint: options.endpoint ?? "synthetic:cal/recent",
            capturedAt,
            responseText: JSON.stringify(rows),
            ...(options.scope ? { scope: options.scope } : {}),
          },
        ],
      },
      options.adapter ?? pendingOnly,
    );

  async function idOf(sourceKey: string) {
    const stored = await db.raw(
      "SELECT id FROM transactions WHERE connection_id = ? AND source_key = ? AND superseded_by_id IS NULL",
      [connectionId, sourceKey],
    );
    expect(stored, sourceKey).toHaveLength(1);
    return stored[0]!.id as string;
  }

  const loadedIds = () => latest().narrowRows.map(({ id }) => id);

  async function rowCount() {
    return (
      await db.raw("SELECT id FROM transactions WHERE connection_id = ?", [
        connectionId,
      ])
    ).length;
  }

  it("links an authorization dated long before the window when its posting arrives", async () => {
    await capture("old-1", "2040-07-01T12:00:00Z", [
      authorization("pending", { transactionDate: "2040-03-20" }),
      row("far", { transactionDate: "2039-01-01", merchantName: "Far shop" }),
    ]);
    const pending = await idOf("pending");
    const far = await idOf("far");
    const result = await capture("old-2", "2040-07-02T12:00:00Z", [
      row("posted", { transactionDate: "2040-03-20" }),
    ]);
    expect(result).toMatchObject({ created: 0, status: "completed" });
    expect(await idOf("posted")).toBe(pending);
    expect(await db.getTransaction(pending)).toMatchObject({
      status: "posted",
      sourceAliases: ["pending"],
    });
    expect(latest()).toMatchObject({ bounded: true, fallback: false });
    expect(loadedIds()).toContain(pending);
    expect(loadedIds()).not.toContain(far);
  });

  it("matches an observation dated before the window to its stored row, and a corrected date by key", async () => {
    await capture("twin-1", "2040-07-01T12:00:00Z", [
      row("twin", { transactionDate: "2040-05-20" }),
      row("moved", { transactionDate: "2039-12-01", merchantName: "Moved" }),
      row("far", { transactionDate: "2039-01-01", merchantName: "Far shop" }),
    ]);
    const twin = await idOf("twin");
    const moved = await idOf("moved");
    const far = await idOf("far");
    const result = await capture("twin-2", "2040-07-10T12:00:00Z", [
      row("twin", { transactionDate: "2040-05-20" }),
      row("moved", { transactionDate: "2040-07-05", merchantName: "Moved" }),
    ]);
    expect(result.created).toBe(0);
    expect(await rowCount()).toBe(3);
    expect(await db.getTransaction(moved)).toMatchObject({
      transactionDate: "2040-07-05",
      lastSeenRunId: "twin-2",
    });
    expect(await db.getTransaction(twin)).toMatchObject({
      lastSeenRunId: "twin-2",
    });
    expect(loadedIds()).toEqual(expect.arrayContaining([twin, moved]));
    expect(loadedIds()).not.toContain(far);
  });

  it("decides a line billed now against a purchase and lines from years before", async () => {
    await capture("plan-1", "2038-08-12T12:00:00Z", [
      purchase(),
      line("line-1", 1, "2038-08-10"),
    ]);
    await capture("plan-2", "2038-09-12T12:00:00Z", [
      line("line-2", 2, "2038-09-10"),
    ]);
    const plan = await idOf("plan");
    const first = await idOf("line-1");
    const result = await capture("plan-3", "2040-07-12T12:00:00Z", [
      line("line-24", 24, "2040-07-10"),
      // Another identity stating the first ordinal holds both lines.
      line("line-1b", 1, "2040-07-10"),
    ]);
    expect(result.created).toBe(2);
    expect(
      await db.raw(
        "SELECT id FROM transactions WHERE connection_id = ? AND source_key = 'plan'",
        [connectionId],
      ),
    ).toHaveLength(1);
    expect(loadedIds()).toEqual(
      expect.arrayContaining([plan, first, await idOf("line-2")]),
    );
    for (const key of ["line-1", "line-1b"]) {
      expect(await db.getTransaction(await idOf(key)), key).toMatchObject({
        amountMinor: null,
        purchaseId: plan,
        details: {
          issues: expect.arrayContaining(["duplicate_installment_ordinal"]),
        },
      });
    }
    expect(await db.getTransaction(await idOf("line-24"))).toMatchObject({
      amountMinor: -1000,
      purchaseId: plan,
    });
    // A restated count still contradicts the count the old lines state.
    await capture("plan-4", "2040-07-13T12:00:00Z", [
      purchase({ installmentCount: 12 }),
    ]);
    expect((await db.getTransaction(plan))!.details.issues).toEqual(
      expect.arrayContaining([
        "conflicting_installment_lines",
        "conflicting_installment_plan",
      ]),
    );
  });

  it("declares a pending row absent at the edge of a 60-day window, and not one day beyond", async () => {
    await capture(
      "edge-1",
      "2040-07-01T12:00:00Z",
      [
        authorization("edge", { transactionDate: "2040-05-11" }),
        authorization("beyond", {
          transactionDate: "2040-05-10",
          merchantName: "Beyond",
        }),
        row("kept", { transactionDate: "2040-06-30" }),
      ],
      { adapter: windowed },
    );
    await capture(
      "edge-2",
      "2040-07-10T12:00:00Z",
      [row("kept", { transactionDate: "2040-06-30" })],
      { adapter: windowed },
    );
    expect(await db.getTransaction(await idOf("edge"))).toMatchObject({
      presence: "not_returned",
    });
    expect(await db.getTransaction(await idOf("beyond"))).toMatchObject({
      presence: "seen",
    });
  });

  it("declares a same-origin pending row absent whatever its date", async () => {
    await capture("origin-1", "2040-07-01T12:00:00Z", [
      authorization("old", { transactionDate: "2039-12-01" }),
      row("kept", { transactionDate: "2040-06-30" }),
    ]);
    await capture("origin-2", "2040-07-10T12:00:00Z", [
      row("kept", { transactionDate: "2040-06-30" }),
    ]);
    expect(await db.getTransaction(await idOf("old"))).toMatchObject({
      presence: "not_returned",
    });
  });

  it("rejects an empty windowed capture while an old covered authorization is current", async () => {
    await capture(
      "empty-1",
      "2040-07-01T12:00:00Z",
      [authorization("open", { transactionDate: "2040-05-15" })],
      { adapter: windowed },
    );
    const result = await capture("empty-2", "2040-07-10T12:00:00Z", [], {
      adapter: windowed,
    });
    expect(result).toMatchObject({
      status: "failed",
      failureCode: "implausible_empty",
    });
    expect(await db.getTransaction(await idOf("open"))).toMatchObject({
      presence: "seen",
    });
  });

  it("accepts an empty capture from an adapter without empty rejection", async () => {
    await capture("accept-1", "2040-07-01T12:00:00Z", [
      authorization("open", { transactionDate: "2039-10-15" }),
    ]);
    const result = await capture("accept-2", "2040-07-10T12:00:00Z", []);
    expect(result.status).toBe("completed");
    expect(await db.getTransaction(await idOf("open"))).toMatchObject({
      presence: "not_returned",
    });
  });

  it("reads a backfill month around that month, never around the day it ran", async () => {
    await capture("month-1", "2040-07-01T12:00:00Z", [
      row("recent", { transactionDate: "2040-06-30" }),
    ]);
    const recent = await idOf("recent");
    const before = await db.getTransaction(recent);
    await capture(
      "month-2",
      "2040-07-02T12:00:00Z",
      [
        row("march", {
          transactionDate: "2024-03-15",
          merchantName: "Archive",
        }),
      ],
      { scope: { kind: "history", month: "2024-03" } },
    );
    expect(loadedIds()).not.toContain(recent);
    expect(await db.getTransaction(recent)).toStrictEqual(before);
    expect(await db.getTransaction(await idOf("march"))).toMatchObject({
      presence: "not_returned",
      lastSeenRunId: "month-2",
    });
  });

  it("knows an account whose only rows lie outside the scope", async () => {
    await capture(
      "known-1",
      "2040-07-01T12:00:00Z",
      [row("archived", { transactionDate: "2030-01-15" })],
      { scope: { kind: "history", month: "2030-01" } },
    );
    const archived = await idOf("archived");
    await capture("known-2", "2040-07-10T12:00:00Z", [
      row("fresh", { transactionDate: "2040-07-09" }),
    ]);
    expect(loadedIds()).not.toContain(archived);
    const events = await db.listEvents({ connectionId, limit: 100 });
    expect(
      events.filter((event) => event.type === "sync.baseline"),
    ).toHaveLength(1);
    expect(
      events.find(
        (event) =>
          event.type === "transaction.created" && event.runId === "known-2",
      ),
    ).toMatchObject({ transactionId: await idOf("fresh") });
  });

  it("rereads a stored candidate whose pending row moved away from it", async () => {
    await capture("pair-1", "2040-07-01T12:00:00Z", [
      authorization("p", { transactionDate: "2040-03-01" }),
      row("q", { transactionDate: "2040-03-02" }),
    ]);
    const p = await idOf("p");
    const q = await idOf("q");
    expect((await db.getTransaction(q))!.details).toMatchObject({
      pendingPostingCandidates: [p],
    });
    // The pending row's corrected date lies far from the posted row, which
    // no window of this capture reaches.
    await capture("pair-2", "2040-07-10T12:00:00Z", [
      authorization("p", { transactionDate: "2040-07-08" }),
    ]);
    expect(loadedIds()).toContain(q);
    for (const id of [p, q]) {
      const { details } = (await db.getTransaction(id))!;
      expect(details.pendingPostingCandidates, id).toEqual([]);
      expect(details.issues, id).not.toContain("possible_pending_posted_match");
    }
  });

  it("reads a posted row whose stored candidate names an authorization that does not name it", async () => {
    await capture("pair-1", "2040-07-01T12:00:00Z", [
      authorization("p", { transactionDate: "2040-03-01" }),
      row("q", { transactionDate: "2040-03-02" }),
    ]);
    const p = await idOf("p");
    const q = await idOf("q");
    // Only the posted row still names the pair, as a foreign writer could leave it.
    await db.raw(
      "UPDATE transaction_reconciliation SET pending_posting_candidates_json = '[]' WHERE transaction_id = ?",
      [p],
    );
    await db.raw(
      "UPDATE transactions SET source_issues_json = '[]' WHERE id = ?",
      [p],
    );
    await capture("pair-2", "2040-07-10T12:00:00Z", [
      row("fresh", { transactionDate: "2040-07-09", merchantName: "Fresh" }),
    ]);
    // Neither a window nor the authorization's date group reaches the
    // posted row; its stored list does.
    expect(loadedIds()).toContain(q);
    expect((await db.getTransaction(p))!.details).toMatchObject({
      pendingPostingCandidates: [q],
      issues: ["possible_pending_posted_match"],
    });
  });

  it("suggests a posted row near the stored date of an authorization marked seen", async () => {
    await capture("near-1", "2040-07-05T12:00:00Z", [
      authorization("p", { transactionDate: "2040-03-01" }),
    ]);
    const p = await idOf("p");
    const [card] = await db.raw(
      "SELECT id FROM cards WHERE connection_id = ?",
      [connectionId],
    );
    await insertTransactionFixture(db, [
      storedRow(connectionId, "q", {
        cardId: card!.id as string,
        merchantName: "Merchant",
        amountMinor: -100,
        transactionDate: "2040-03-02",
        lastSeenRunId: "near-1",
        lastSeenAt: "2040-07-05T12:00:00.000Z",
        details: { ...storedRow(connectionId, "q").details, provider: {} },
      }),
    ]);
    // Another origin's older capture restates the authorization with another
    // date: newer facts stand, so it is only marked seen, at its stored date.
    await capture(
      "near-2",
      "2040-07-03T12:00:00Z",
      [authorization("p", { transactionDate: "2040-06-20" })],
      { endpoint: "synthetic:cal/other" },
    );
    expect(loadedIds()).toContain("q");
    expect(await db.getTransaction(p)).toMatchObject({
      transactionDate: "2040-03-01",
      details: { pendingPostingCandidates: ["q"] },
    });
    expect((await db.getTransaction("q"))!.details).toMatchObject({
      pendingPostingCandidates: [p],
    });
  });

  it("suggests a posted row near an authorization a legacy identity marks seen", async () => {
    // Inputs keep their declared identity, and candidates are suggested.
    const adapter: SourceAdapter = {
      ...declaring,
      pendingPostingCandidates: true,
    };
    await capture(
      "legacy-1",
      "2040-07-05T12:00:00Z",
      [authorization("legacy-p", { transactionDate: "2040-03-01" })],
      { adapter },
    );
    const p = await idOf("legacy-p");
    // The identity survives only in the provider document, which the narrow
    // read cannot see, so no narrow fact names the row.
    await db.raw("UPDATE transactions SET provider_json = ? WHERE id = ?", [
      '{"cal":{"identity":{"baseKey":"legacy-base"}}}',
      p,
    ]);
    const [card] = await db.raw(
      "SELECT id FROM cards WHERE connection_id = ?",
      [connectionId],
    );
    await insertTransactionFixture(db, [
      storedRow(connectionId, "q", {
        cardId: card!.id as string,
        merchantName: "Merchant",
        amountMinor: -100,
        transactionDate: "2040-03-02",
        lastSeenRunId: "legacy-1",
        lastSeenAt: "2040-07-05T12:00:00.000Z",
        details: { ...storedRow(connectionId, "q").details, provider: {} },
      }),
    ]);
    // Another origin's older capture states a new source key with the same
    // legacy base: the newer stored row stands and is only marked seen.
    await capture(
      "legacy-2",
      "2040-07-03T12:00:00Z",
      [
        authorization("other-key", {
          transactionDate: "2040-06-20",
          details: {
            ...emptyDetails(),
            provider: { cal: { identity: { baseKey: "legacy-base" } } },
          },
        }),
      ],
      { adapter, endpoint: "synthetic:cal/other" },
    );
    expect(latest().doubtful).toContain(p);
    expect(loadedIds()).toContain("q");
    expect(await db.getTransaction(p)).toMatchObject({
      transactionDate: "2040-03-01",
      details: { pendingPostingCandidates: ["q"] },
    });
    expect((await db.getTransaction("q"))!.details).toMatchObject({
      pendingPostingCandidates: [p],
    });
    expect(await rowCount()).toBe(2);
  });

  it("clears a duplicate-plan flag when its lookalike moves to another date", async () => {
    const lookalike = (key: string, transactionDate = "2038-01-10") =>
      row(key, {
        installmentCount: 3,
        amountMinor: -3000,
        transactionDate,
        merchantName: "Twin shop",
      });
    await capture("move-1", "2040-07-01T12:00:00Z", [
      lookalike("plan-a"),
      lookalike("plan-b"),
    ]);
    const b = await idOf("plan-b");
    expect((await db.getTransaction(b))!.details.issues).toContain(
      "possible_duplicate_plan",
    );
    await capture("move-2", "2040-07-10T12:00:00Z", [
      lookalike("plan-a", "2040-07-05"),
    ]);
    expect(loadedIds()).toContain(b);
    for (const key of ["plan-a", "plan-b"]) {
      expect(
        (await db.getTransaction(await idOf(key)))!.details.issues,
        key,
      ).not.toContain("possible_duplicate_plan");
    }
  });

  it("falls back to every row when a missed purchase has an unseen conflicting line", async () => {
    await capture("miss-1", "2040-06-12T12:00:00Z", [
      purchase(),
      line("line-1", 1, "2038-08-10", { installmentCount: 40 }),
      line("line-2", 2, "2040-07-10"),
      row("unrelated", { transactionDate: "2040-07-11", merchantName: "Shop" }),
    ]);
    const plan = await idOf("plan");
    const conflict = "conflicting_installment_lines";
    expect((await db.getTransaction(plan))!.details.issues).toContain(conflict);
    // Without closure the stored line in the window names a purchase the
    // load does not hold; its conflicting sibling is outside every window.
    configureHydration({ closure: false });
    await capture("miss-2", "2040-07-12T12:00:00Z", [
      row("unrelated", { transactionDate: "2040-07-11", merchantName: "Shop" }),
    ]);
    expect(latest()).toMatchObject({ bounded: false, fallback: true });
    expect(latest().rounds).toBeGreaterThan(1);
    expect((await db.getTransaction(plan))!.details.issues).toContain(conflict);
    // With closure the same capture holds the purchase and both lines.
    configureHydration();
    await capture("miss-3", "2040-07-13T12:00:00Z", [
      row("unrelated", { transactionDate: "2040-07-11", merchantName: "Shop" }),
    ]);
    expect(latest()).toMatchObject({ bounded: true, fallback: false });
    expect(loadedIds()).toEqual(
      expect.arrayContaining([plan, await idOf("line-1")]),
    );
  });

  it("interleaves hydration demands with a scope miss and replans from every row", async () => {
    await capture("mixed-1", "2040-06-12T12:00:00Z", [
      purchase(),
      line("line-2", 2, "2040-07-10"),
      row("unrelated", { transactionDate: "2040-07-11", merchantName: "Shop" }),
    ]);
    const unrelated = await idOf("unrelated");
    configureHydration({ closure: false, predict: false });
    await capture("mixed-2", "2040-07-12T12:00:00Z", [
      row("unrelated", { transactionDate: "2040-07-11", merchantName: "Shop" }),
    ]);
    const loaded = latest();
    expect(loaded).toMatchObject({ bounded: false, fallback: true });
    expect(loaded.rounds).toBeGreaterThanOrEqual(2);
    expect(loaded.hydrated).toContain(unrelated);
    // Every row is held after the fallback, so every run they name loads.
    expect(loaded.narrowRows).toHaveLength(await rowCount());
    expect(loaded.loadedRuns).toBeGreaterThanOrEqual(1);
  });

  it("treats a supersession into another connection as missing, as a complete load does", async () => {
    await db.ensureConnection({ id: "elsewhere", provider: "cal" });
    await seedRun(db, "elsewhere");
    await insertTransactionFixture(db, [storedRow("elsewhere", "foreign")]);
    await capture("dangling-1", "2040-07-01T12:00:00Z", [
      row("kept", { transactionDate: "2040-06-30" }),
    ]);
    await insertTransactionFixture(db, [
      storedRow(connectionId, "retired-plan", {
        sourceKey: "plan",
        installmentCount: 36,
        transactionDate: "2030-01-01",
        lastSeenRunId: SEED_RUN,
        supersededById: "foreign",
      }),
    ]);
    await capture("dangling-2", "2040-07-12T12:00:00Z", [
      line("line-24", 24, "2040-07-10"),
    ]);
    expect(latest()).toMatchObject({ bounded: true, fallback: false });
    expect(await db.getTransaction(await idOf("line-24"))).toMatchObject({
      purchaseId: null,
      details: { issues: expect.arrayContaining(["unresolved_purchase"]) },
    });
  });

  it("leaves a stale duplicate-plan flag on a purchase whose date group it did not read", async () => {
    await capture("stale-1", "2040-07-01T12:00:00Z", [
      row("kept", { transactionDate: "2040-06-30" }),
    ]);
    const [card] = await db.raw(
      "SELECT id FROM cards WHERE connection_id = ?",
      [connectionId],
    );
    const lookalike = {
      details: { ...storedRow(connectionId, "shape").details, provider: {} },
      cardId: card!.id as string,
      merchantName: "Twin shop",
      installmentCount: 3,
      amountMinor: -3000,
      transactionDate: "2038-01-10",
      lastSeenRunId: "stale-1",
      lastSeenAt: "2040-07-01T12:00:00.000Z",
    };
    // Lookalike plans stored without their review flag, as before a policy
    // change: only a load holding both decides it.
    await insertTransactionFixture(db, [
      storedRow(connectionId, "plan-a", lookalike),
      storedRow(connectionId, "plan-b", lookalike),
      storedRow(connectionId, "line-a1", {
        ...lookalike,
        amountBasis: "booked_entry",
        amountMinor: -1000,
        installmentNumber: 1,
        purchaseId: "plan-a",
        billingDate: "2040-07-10",
      }),
    ]);
    const unrelated = [
      row("unrelated", { transactionDate: "2040-07-11", merchantName: "Shop" }),
    ];
    // The line in the billing window pulls in its purchase, but not the
    // purchase's date group: the complete plan flags both purchases.
    await expect(
      capture("stale-2", "2040-07-12T12:00:00Z", unrelated),
    ).rejects.toThrow();
    allowStaleReview(true);
    await capture("stale-2", "2040-07-12T12:00:00Z", unrelated);
    expect(latest().undecided).toContain("plan-a");
    // The allowance admits the flag, its version and its events, and
    // nothing beside them.
    const { dependent, complete, comparison } = latestPlannedApplication();
    const flagged = complete.transactionWrites.find(([id]) => id === "plan-a");
    expect(flagged?.[1]).toMatchObject({
      version: 2,
      details: { issues: ["possible_duplicate_plan"] },
    });
    expect(
      complete.events
        .filter((event) => event.transactionId === "plan-a")
        .map(({ type }) => type),
    ).toEqual(["transaction.review_required", "transaction.updated"]);
    expect(complete.result.updated - dependent.result.updated).toBe(2);
    expect(() =>
      expectScopedOutcome(dependent, complete, comparison),
    ).not.toThrow();
    const bumped = structuredClone(complete);
    bumped.transactionWrites.find(([id]) => id === "plan-a")![1].version = 3;
    expect(() => expectScopedOutcome(dependent, bumped, comparison)).toThrow();
    const unrelatedUpdate = structuredClone(complete);
    const flagEvent = unrelatedUpdate.events.find(
      (event) =>
        event.transactionId === "plan-a" &&
        event.type === "transaction.updated",
    )!;
    unrelatedUpdate.events.push({
      ...flagEvent,
      before: { amount: { amountMinor: -3000, currency: "ILS" } },
      after: { amount: { amountMinor: -1, currency: "ILS" } },
    });
    expect(() =>
      expectScopedOutcome(dependent, unrelatedUpdate, comparison),
    ).toThrow();
    const widened = structuredClone(complete);
    (
      widened.events.find(
        (event) =>
          event.transactionId === "plan-a" &&
          event.type === "transaction.updated",
      )!.after as Record<string, unknown>
    ).merchantName = "Other";
    expect(() => expectScopedOutcome(dependent, widened, comparison)).toThrow();
    // Each permitted event must be present exactly once, on its own row.
    const flagEvents = (plan: typeof complete, type: string) =>
      plan.events.filter(
        (event) => event.transactionId === "plan-a" && event.type === type,
      );
    for (const type of ["transaction.updated", "transaction.review_required"]) {
      const missing = structuredClone(complete);
      missing.events = missing.events.filter(
        (event) =>
          !flagEvents(complete, type).some(
            (flag) => JSON.stringify(flag) === JSON.stringify(event),
          ),
      );
      expect(
        () => expectScopedOutcome(dependent, missing, comparison),
        `missing ${type}`,
      ).toThrow();
      const duplicated = structuredClone(complete);
      duplicated.events.push(structuredClone(flagEvents(complete, type)[0]!));
      expect(
        () => expectScopedOutcome(dependent, duplicated, comparison),
        `duplicated ${type}`,
      ).toThrow();
      const misattributed = structuredClone(complete);
      for (const event of flagEvents(misattributed, type)) {
        event.transactionId = "line-a1";
      }
      expect(
        () => expectScopedOutcome(dependent, misattributed, comparison),
        `misattributed ${type}`,
      ).toThrow();
    }
    const bothMissing = structuredClone(complete);
    bothMissing.events = bothMissing.events.filter(
      (event) => event.transactionId !== "plan-a",
    );
    expect(() =>
      expectScopedOutcome(dependent, bothMissing, comparison),
    ).toThrow();
    expect(loadedIds()).toContain("plan-a");
    expect(loadedIds()).not.toContain("plan-b");
    for (const id of ["plan-a", "plan-b"]) {
      expect((await db.getTransaction(id))!.details.issues, id).not.toContain(
        "possible_duplicate_plan",
      );
    }
  });

  /** Replaces a stored row's aliases with raw text, as a re-keying parser left them. */
  async function writeAliases(key: string, text: string) {
    await db.raw(
      "UPDATE transactions SET source_aliases_json = ? WHERE id = ?",
      [text, await idOf(key)],
    );
  }

  it("matches an observation to an old row whose alias is its key", async () => {
    await capture("alias-1", "2040-07-01T12:00:00Z", [
      row("rekeyed", { transactionDate: "2030-01-01", merchantName: "Old" }),
    ]);
    await writeAliases("rekeyed", '["current-key"]');
    const rekeyed = await idOf("rekeyed");
    // The observation's own date is far from the stored row's.
    const result = await capture("alias-2", "2040-07-10T12:00:00Z", [
      row("current-key", {
        transactionDate: "2040-07-09",
        merchantName: "Old",
      }),
    ]);
    expect(result.created).toBe(0);
    expect(await rowCount()).toBe(1);
    expect(loadedIds()).toEqual([rekeyed]);
    expect(await db.getTransaction(rekeyed)).toMatchObject({
      lastSeenRunId: "alias-2",
      transactionDate: "2040-07-09",
    });
  });

  it("leaves out an old row whose alias no observation names", async () => {
    await capture("unnamed-1", "2040-07-01T12:00:00Z", [
      row("rekeyed", { transactionDate: "2030-01-01", merchantName: "Old" }),
    ]);
    await writeAliases("rekeyed", '["earlier-key"]');
    const result = await capture("unnamed-2", "2040-07-10T12:00:00Z", [
      row("fresh", { transactionDate: "2040-07-09", merchantName: "Fresh" }),
    ]);
    expect(result.created).toBe(1);
    expect(loadedIds()).toEqual([]);
    expect(await db.getTransaction(await idOf("rekeyed"))).toMatchObject({
      lastSeenRunId: "unnamed-1",
    });
  });

  it("reads every old row whose alias text holds a backslash, named or not", async () => {
    await capture("escaped-alias-1", "2040-07-01T12:00:00Z", [
      row("named", { transactionDate: "2030-01-01", merchantName: "Named" }),
      row("unnamed", { transactionDate: "2030-01-02", merchantName: "Other" }),
    ]);
    // The same keys a search for the input's JSON text could not find.
    await writeAliases("named", '["p\\/q"]');
    await writeAliases("unnamed", '["r\\/s"]');
    const named = await idOf("named");
    const unnamed = await idOf("unnamed");
    const result = await capture("escaped-alias-2", "2040-07-10T12:00:00Z", [
      row("p/q", { transactionDate: "2040-07-09", merchantName: "Named" }),
    ]);
    expect(result.created).toBe(0);
    expect(loadedIds().sort()).toEqual([named, unnamed].sort());
    expect(await db.getTransaction(named)).toMatchObject({
      lastSeenRunId: "escaped-alias-2",
    });
    expect(await db.getTransaction(unnamed)).toMatchObject({
      lastSeenRunId: "escaped-alias-1",
    });
  });

  it("reads only the rows near a one-row capture of a ledger whose every row carries an old key", async () => {
    // Thirty posted rows, a week apart from 2039-01-01, then two in the
    // capture's window; every one keeps the key it had before re-keying.
    const dates = [
      ...Array.from({ length: 30 }, (_, index) =>
        new Date(Date.UTC(2039, 0, 1) + index * 7 * 86_400_000)
          .toISOString()
          .slice(0, 10),
      ),
      "2040-07-01",
      "2040-07-02",
    ];
    await capture(
      "rekeyed-1",
      "2040-07-03T12:00:00Z",
      dates.map((transactionDate, index) =>
        row(`row-${index}`, { transactionDate, merchantName: `Shop ${index}` }),
      ),
    );
    await db.raw(
      "UPDATE transactions SET source_aliases_json = '[\"old-' || source_key || '\"]' WHERE connection_id = ?",
      [connectionId],
    );
    const report = createSyncDiagnosticReport();
    await db.ingestRun(
      {
        connectionId,
        runId: "rekeyed-2",
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:cal/recent",
            capturedAt: "2040-07-10T12:00:00Z",
            responseText: JSON.stringify([
              row("fresh", {
                transactionDate: "2040-07-09",
                merchantName: "New",
              }),
            ]),
          },
        ],
      },
      pendingOnly,
      report.log,
    );
    expect(
      report
        .report()
        .entries.find(
          (entry: SyncDiagnostic) =>
            entry.stage === "reconciliation" && entry.outcome === "completed",
        )?.counts,
    ).toMatchObject({ scopeRows: 2, ledgerRows: 2 });
    expect(loadedIds().sort()).toEqual(
      [await idOf("row-30"), await idOf("row-31")].sort(),
    );
  });

  it("splits the scope of a capture naming a thousand keys into readable statements", async () => {
    await capture("many-1", "2040-07-01T12:00:00Z", [
      ...["k-0", "k-1", "k-2"].map((key) =>
        row(key, { transactionDate: "2030-01-01", merchantName: "Old" }),
      ),
      // Beyond the 40 days padded around the named rows' stored date.
      row("far", { transactionDate: "2031-06-01", merchantName: "Far" }),
    ]);
    // Each key is also its own identity base, and each names an alias:
    // a thousand key, alias and base disjuncts each.
    const report = createSyncDiagnosticReport();
    const result = await db.ingestRun(
      {
        connectionId,
        runId: "many-2",
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:cal/recent",
            capturedAt: "2040-07-10T12:00:00Z",
            responseText: JSON.stringify(
              Array.from({ length: 1000 }, (_, index) =>
                row(`k-${index}`, {
                  transactionDate: "2040-07-09",
                  merchantName: `Shop ${index}`,
                }),
              ),
            ),
          },
        ],
      },
      pendingOnly,
      report.log,
    );
    expect(result).toMatchObject({ created: 997, status: "completed" });
    expect(await rowCount()).toBe(1001);
    // Only the three old rows the capture names are read.
    expect(
      report
        .report()
        .entries.find(
          (entry: SyncDiagnostic) =>
            entry.stage === "reconciliation" && entry.outcome === "completed",
        )?.counts,
    ).toMatchObject({ scopeRows: 3, ledgerRows: 3 });
    expect(await db.getTransaction(await idOf("far"))).toMatchObject({
      lastSeenRunId: "many-1",
    });
  });

  it("finds identities a substring search cannot see in their stored text", async () => {
    await capture("text-1", "2040-07-01T12:00:00Z", [
      row("legacy", { transactionDate: "2030-01-01", merchantName: "Legacy" }),
      row("escaped", { transactionDate: "2030-01-02", merchantName: "Esc" }),
      row("aliased", { transactionDate: "2030-01-03", merchantName: "Alias" }),
    ]);
    const write = async (key: string, column: string, text: string) => {
      const [table, name] = column.split(".");
      await db.raw(
        `UPDATE ${table} SET ${name} = ? WHERE ${table === "transactions" ? "id" : "transaction_id"} = ?`,
        [text, await idOf(key)],
      );
    };
    // An identity left in the provider document, a base spelled with an
    // escaped solidus, and an alias spelled the same way.
    await write(
      "legacy",
      "transactions.provider_json",
      '{"cal":{"identity":{"baseKey":"legacy-base"}}}',
    );
    await write(
      "escaped",
      "transaction_reconciliation.provider_identity_json",
      '{"cal":{"baseKey":"a\\/b"}}',
    );
    await write("aliased", "transactions.source_aliases_json", '["x\\/y"]');
    const based = (key: string, baseKey: string) =>
      row(key, {
        transactionDate: "2040-07-09",
        details: {
          ...row(key).details,
          provider: { cal: { identity: { baseKey } } },
        },
      });
    const history = await capture(
      "text-2",
      "2040-07-10T12:00:00Z",
      [based("legacy-new", "legacy-base"), based("escaped-new", "a/b")],
      { scope: { kind: "history" }, adapter: declaring },
    );
    // Both are known identities, so the historical rows are deferred, never
    // stored as second transactions.
    expect(history.created).toBe(0);
    expect(loadedIds()).toEqual(
      expect.arrayContaining([await idOf("legacy"), await idOf("escaped")]),
    );
    const aliased = await idOf("aliased");
    const recent = await capture("text-3", "2040-07-11T12:00:00Z", [
      row("x/y", { transactionDate: "2040-07-09", merchantName: "Alias" }),
    ]);
    expect(recent.created).toBe(0);
    expect(await db.getTransaction(aliased)).toMatchObject({
      lastSeenRunId: "text-3",
      transactionDate: "2040-07-09",
    });
  });

  it("clears an annotated overlap witness during an unrelated historical capture", async () => {
    // Without stored candidates, only the pending row's date group reads
    // the posted row.
    const { pendingPostingCandidates: _candidates, ...adapter } = pendingOnly;
    await capture("witness-2", "2040-07-02T12:00:00Z", [authorization()], {
      adapter,
    });
    await capture(
      "witness-3",
      "2040-07-03T12:00:00Z",
      [authorization(), row("posted")],
      { adapter },
    );
    const pending = await idOf("pending");
    const posted = await idOf("posted");
    expect((await db.getTransaction(pending))!.details.postingOverlap).toEqual(
      expect.objectContaining({ postedId: posted }),
    );
    await db.editAnnotation({
      transactionId: posted,
      expectedVersion: 0,
      notes: "Owner note",
    });
    await capture(
      "witness-4",
      "2040-07-04T12:00:00Z",
      [row("archive", { transactionDate: "2030-01-01", merchantName: "Old" })],
      { scope: { kind: "history" }, adapter },
    );
    expect(loadedIds()).toContain(posted);
    expect(
      (await db.getTransaction(pending))!.details.postingOverlap,
    ).toBeUndefined();
  });

  it("rewrites a legacy Isracard survivor outside every window as a complete load does", async () => {
    const legacy = "isracard-legacy";
    await db.ensureConnection({ id: legacy, provider: "isracard" });
    // Isracard's own retention and projection, with synthetic rows.
    const {
      financialAuthority: _authority,
      automaticPosting: _posting,
      validateScope: _validate,
      normalizeScope: _normalize,
      ...evidence
    } = isracardAdapter;
    const isracard: SourceAdapter = {
      ...evidence,
      parserVersion: "synthetic-isracard-v1",
      extract: synthetic.extract,
    };
    const ingest = (
      runId: string,
      capturedAt: string,
      rows: TransactionInput[],
      scope?: CollectionScope,
    ) =>
      db.ingestRun(
        {
          connectionId: legacy,
          runId,
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:isracard/card-month",
              capturedAt,
              responseText: JSON.stringify(rows),
              ...(scope ? { scope } : {}),
            },
          ],
        },
        isracard,
      );
    await ingest("isracard-1", "2040-07-01T12:00:00Z", [
      authorization("auth", { transactionDate: "2039-11-01" }),
      row("settled", { transactionDate: "2039-11-01" }),
    ]);
    const idIn = async (key: string) =>
      (
        await db.raw(
          "SELECT id FROM transactions WHERE connection_id = ? AND source_key = ?",
          [legacy, key],
        )
      )[0]!.id as string;
    const auth = await idIn("auth");
    const settled = await idIn("settled");
    const [pendingRow, postedRow] = await Promise.all([
      db.getTransaction(auth),
      db.getTransaction(settled),
    ]);
    await db.linkPendingTransaction({
      pendingId: auth,
      postedId: settled,
      expectedPendingVersion: pendingRow!.version,
      expectedPostedVersion: postedRow!.version,
      expectedPendingAnnotationVersion: 0,
      expectedPostedAnnotationVersion: 0,
      actor: "owner",
      reason: "Owner verified the posting",
    });
    const linkedVersion = (await db.getTransaction(auth))!.version;
    // An older record: a digital row copied into its observation, whose
    // only field is the original amount.
    await db.raw("UPDATE transactions SET provider_json = ? WHERE id = ?", [
      JSON.stringify({
        isracard: {
          rows: [{ originalAmount: 5 }],
          observations: [
            {
              generation: "digital",
              path: "rows[0]",
              row: { originalAmount: 5 },
            },
          ],
        },
      }),
      auth,
    ]);
    await ingest(
      "isracard-2",
      "2040-07-10T12:00:00Z",
      [row("archive", { transactionDate: "2030-01-01", merchantName: "Old" })],
      { kind: "history" },
    );
    expect(loadedIds()).toContain(auth);
    expect(latest().hydrated).toContain(auth);
    // Projection drops the copied row, so the retained digital amount can no
    // longer be told from a legacy row and stops counting as evidence.
    expect((await db.getTransaction(auth))!.details.provider).toEqual({
      isracard: {
        observations: [{ generation: "digital", path: "rows[0]" }],
        rows: [{ originalAmount: 5 }],
      },
    });
    expect((await db.getTransaction(auth))!.version).toBe(linkedVersion + 1);
    const updates = (
      await db.listEvents({ connectionId: legacy, limit: 100 })
    ).filter(
      (event) => event.transactionId === auth && event.runId === "isracard-2",
    );
    expect(updates.map(({ type }) => type)).toEqual(["transaction.updated"]);
    expect(Object.keys(updates[0]!.after as object)).toEqual([
      "providerEvidence",
    ]);
  });
});

describe.each(backends)("%s configured sync scope", (backend) => {
  const stores: Harness[] = [];
  afterEach(async () => {
    configureHydration();
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  async function opened(syncScopeDays?: number) {
    const db = await open(
      backend,
      syncScopeDays === undefined ? {} : { syncScopeDays },
    );
    stores.push(db);
    await db.ensureConnection({ id: connectionId, provider: "cal" });
    return db;
  }

  const run = (
    runId: string,
    capturedAt: string,
    rows: TransactionInput[],
    scope?: CollectionScope,
  ) => ({
    connectionId,
    runId,
    responses: [
      {
        accountKey: "account",
        endpoint: "synthetic:cal/recent",
        capturedAt,
        responseText: JSON.stringify(rows),
        ...(scope ? { scope } : {}),
      },
    ],
  });

  async function idOf(db: Harness, sourceKey: string) {
    const [stored] = await db.raw(
      "SELECT id FROM transactions WHERE connection_id = ? AND source_key = ?",
      [connectionId, sourceKey],
    );
    return stored!.id as string;
  }

  /** The reconciliation's completed log entry. */
  function reconciliation(
    report: ReturnType<typeof createSyncDiagnosticReport>,
  ) {
    return report
      .report()
      .entries.find(
        (entry: SyncDiagnostic) =>
          entry.stage === "reconciliation" && entry.outcome === "completed",
      )!;
  }

  const ledger = [
    row("near", { transactionDate: "2040-07-10", merchantName: "Near" }),
    row("seen", { transactionDate: "2040-07-20" }),
  ];

  it("reads a row ten days from the window with the default pad, not with one day, and decides alike", async () => {
    const results = [];
    for (const [days, read] of [
      [undefined, true],
      [1, false],
    ] as const) {
      const db = await opened(days);
      await db.ingestRun(
        run("pad-1", "2040-07-01T12:00:00Z", ledger),
        pendingOnly,
      );
      results.push(
        await db.ingestRun(
          run("pad-2", "2040-07-20T12:00:00Z", [ledger[1]!]),
          pendingOnly,
        ),
      );
      const ids = loadingComparisons.at(-1)!.narrowRows.map(({ id }) => id);
      expect(ids.includes(await idOf(db, "near")), String(days)).toBe(read);
    }
    expect(results[1]).toStrictEqual(results[0]);
  });

  it("pads a named row's stored date by the configured days, not only the candidate distance", async () => {
    for (const [days, read] of [
      [undefined, true],
      [1, false],
    ] as const) {
      const db = await opened(days);
      await db.ingestRun(
        run("named-1", "2040-07-05T12:00:00Z", [
          authorization("p", { transactionDate: "2040-03-01" }),
        ]),
        pendingOnly,
      );
      const [card] = await db.raw(
        "SELECT id FROM cards WHERE connection_id = ?",
        [connectionId],
      );
      // A posted neighbour 19 days later: beyond the candidate distance,
      // within the default padding.
      await insertTransactionFixture(db, [
        storedRow(connectionId, "q", {
          cardId: card!.id as string,
          merchantName: "Merchant",
          amountMinor: -100,
          transactionDate: "2040-03-20",
          lastSeenRunId: "named-1",
          lastSeenAt: "2040-07-05T12:00:00.000Z",
          details: { ...storedRow(connectionId, "q").details, provider: {} },
        }),
      ]);
      // Another origin's older capture names the authorization, which keeps
      // its stored date and is only marked seen.
      await db.ingestRun(
        {
          ...run("named-2", "2040-07-03T12:00:00Z", [
            authorization("p", { transactionDate: "2040-06-20" }),
          ]),
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:cal/other",
              capturedAt: "2040-07-03T12:00:00Z",
              responseText: JSON.stringify([
                authorization("p", { transactionDate: "2040-06-20" }),
              ]),
            },
          ],
        },
        pendingOnly,
      );
      const ids = loadingComparisons.at(-1)!.narrowRows.map(({ id }) => id);
      expect(ids.includes("q"), String(days)).toBe(read);
      const p = await idOf(db, "p");
      expect(ids, String(days)).toContain(p);
      // Nineteen days is no candidate distance, whatever was read.
      const stored = (await db.getTransaction(p))!;
      expect(stored.transactionDate, String(days)).toBe("2040-03-01");
      expect(stored.details.pendingPostingCandidates, String(days)).toBe(
        undefined,
      );
    }
  });

  it("honours the configured pad in the store a live refresh locks", async () => {
    const db = await opened(1);
    await db.ingestRun(
      run("lock-1", "2040-07-01T12:00:00Z", ledger),
      pendingOnly,
    );
    const attempt = await db.withCollectionLock(connectionId, (store) =>
      store.ingestRun(
        run("lock-2", "2040-07-20T12:00:00Z", [ledger[1]!]),
        pendingOnly,
      ),
    );
    expect(attempt).toMatchObject({ acquired: true });
    const ids = loadingComparisons.at(-1)!.narrowRows.map(({ id }) => id);
    expect(ids).toContain(await idOf(db, "seen"));
    expect(ids).not.toContain(await idOf(db, "near"));
  });

  it("logs the padded request bounds, the rows its scope selected and no fallback", async () => {
    const db = await opened(1);
    await db.ingestRun(
      run("log-1", "2040-07-01T12:00:00Z", ledger),
      pendingOnly,
    );
    const recent = createSyncDiagnosticReport();
    await db.ingestRun(
      run("log-2", "2040-07-20T12:00:00Z", [ledger[1]!]),
      pendingOnly,
      recent.log,
    );
    // The capture day, one day either side; the observed row's own window
    // never reaches the log.
    expect(reconciliation(recent)).toMatchObject({
      requestScope: { from: "2040-07-19", to: "2040-07-21" },
      scopeFallback: false,
      counts: { scopeRows: 1, ledgerRows: 1 },
    });
    const month = createSyncDiagnosticReport();
    const wide = await opened();
    await wide.ingestRun(
      run("log-3", "2040-07-01T12:00:00Z", ledger),
      pendingOnly,
    );
    await wide.ingestRun(
      run(
        "log-4",
        "2040-07-21T12:00:00Z",
        [row("march", { transactionDate: "2024-03-15", merchantName: "Old" })],
        { kind: "history", month: "2024-03" },
      ),
      pendingOnly,
      month.log,
    );
    expect(reconciliation(month)).toMatchObject({
      requestScope: { from: "2024-01-21", to: "2024-05-10" },
      scopeFallback: false,
      counts: { scopeRows: 0 },
    });
  });

  it("logs a fallback and every row it read", async () => {
    const db = await opened();
    await db.ingestRun(
      run("fallback-1", "2040-06-12T12:00:00Z", [
        purchase(),
        line("line-2", 2, "2040-07-10"),
        row("unrelated", {
          transactionDate: "2030-01-01",
          merchantName: "Old",
        }),
      ]),
      pendingOnly,
    );
    configureHydration({ closure: false });
    const report = createSyncDiagnosticReport();
    await db.ingestRun(
      run("fallback-2", "2040-07-12T12:00:00Z", [
        row("fresh", { transactionDate: "2040-07-11", merchantName: "Fresh" }),
      ]),
      pendingOnly,
      report.log,
    );
    // The line in the billing window is the scope; the fallback then reads
    // all three stored rows.
    expect(reconciliation(report)).toMatchObject({
      scopeFallback: true,
      counts: { scopeRows: 1, ledgerRows: 4 },
    });
  });
});
