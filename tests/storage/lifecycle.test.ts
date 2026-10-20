import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "../../src/domain/errors.js";
import { emptyDetails, unknownLedgerFacts } from "../../src/domain/model.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import {
  annotations,
  cards,
  syncRuns,
  type Transaction,
  transactions,
} from "../../src/storage/sqlite/schema.js";
import { retained } from "../helpers/provider-evidence.js";
import {
  insertTransaction,
  readTransactions,
  updateTransaction,
} from "../helpers/sqlite-transactions.js";

describe("owner-confirmed transaction lifecycle", () => {
  let db: Database;
  let pending: Transaction;
  let posted: Transaction;
  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.ensureConnection({ id: "synthetic", provider: "cal" });
    await db.orm
      .insert(syncRuns)
      .values({
        id: "synthetic-run",
        connectionId: "synthetic",
        startedAt: "2040-08-01T00:00:00Z",
        status: "completed",
        collectorVersion: "synthetic",
        parserVersion: "synthetic",
        snapshot: { schemaVersion: 1, responses: [] },
        coverage: [],
        warnings: [],
      })
      .run();
    await db.orm.insert(cards).values({
      id: "card",
      connectionId: "synthetic",
      providerKey: "card",
      createdAt: "2040-08-01T00:00:00Z",
    });
    const fields: Transaction = {
      id: "pending",
      connectionId: "synthetic",
      sourceScope: "account",
      sourceKey: "pending-key",
      sourceAliases: ["old-pending-key"],
      identityStrength: "native",
      status: "pending",
      presence: "not_returned",
      description: "Synthetic authorization",
      counterpartyName: null,
      kind: "purchase",
      merchantName: "Synthetic merchant",
      merchantProviderId: "merchant",
      merchantCategoryCode: "1234",
      transactionDate: "2040-07-01",
      bookingDate: null,
      billingDate: null,
      amountMinor: -12000,
      currency: "ILS",
      amountBasis: "authorization",
      originalAmountMinor: null,
      originalCurrency: null,
      installmentCount: null,
      ...unknownLedgerFacts("card"),
      details: {
        ...emptyDetails(),
        issues: ["possible_pending_posted_match"],
        sourceRefs: [{ runId: "synthetic-run", path: "/pending" }],
        pendingPostingCandidates: ["posted"],
      },
      firstSeenAt: "2040-08-01T00:00:00Z",
      lastSeenAt: "2040-08-01T00:00:00Z",
      lastSeenRunId: "synthetic-run",
      version: 1,
      supersededById: null,
    };
    pending = await insertTransaction(db.orm, fields);
    posted = await insertTransaction(db.orm, {
      ...fields,
      id: "posted",
      sourceKey: "posted-key",
      sourceAliases: ["old-posted-key"],
      status: "posted",
      presence: "seen",
      amountBasis: "purchase_commitment",
      description: "Synthetic purchase",
      bookingDate: "2040-07-02",
      billingDate: "2040-08-10",
      originalAmountMinor: -12000,
      originalCurrency: "ILS",
      installmentCount: 12,
      firstSeenAt: "2040-08-02T00:00:00Z",
      lastSeenAt: "2040-08-02T00:00:00Z",
      details: {
        ...emptyDetails(),
        issues: ["possible_pending_posted_match"],
        sourceRefs: [{ runId: "synthetic-run", path: "/posted" }],
        provider: {
          cal: { retained: { paymentHistory: [{ label: "First" }] } },
        },
        pendingPostingCandidates: ["pending"],
      },
    });
  });
  afterEach(() => db.close());

  async function command() {
    return {
      pendingId: pending.id,
      postedId: posted.id,
      expectedPendingVersion: (await db.getTransaction(pending.id))!.version,
      expectedPostedVersion: (await db.getTransaction(posted.id))!.version,
      expectedPendingAnnotationVersion:
        (await db.getTransaction(pending.id))!.annotation?.version ?? 0,
      expectedPostedAnnotationVersion:
        (await db.getTransaction(posted.id))!.annotation?.version ?? 0,
      reason: "Owner confirmed these represent one purchase",
    };
  }

  async function state() {
    return {
      rows: await readTransactions(db.orm),
      annotations: await db.orm.select().from(annotations).all(),
      changes: await db.listEvents(),
    };
  }

  it("keeps the earlier ID and note, adopts posted facts, preserves evidence, and counts one purchase", async () => {
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "Authorization note",
      category: "Equipment",
    });
    await updateTransaction(db.orm, pending.id, {
      details: {
        ...pending.details,
        provider: {
          cal: {
            retained: {
              paymentHistory: [{ label: "First" }, { label: "Earlier" }],
            },
          },
        },
        issues: [...pending.details.issues, "other_financial_issue"],
      },
    });
    const note = (await db.getTransaction(pending.id))!.annotation;
    const result = await db.linkPendingTransaction(await command());
    expect(result).toMatchObject({
      id: pending.id,
      sourceKey: posted.sourceKey,
      status: "posted",
      presence: "seen",
      version: 2,
      description: "Synthetic purchase",
      originalAmountMinor: -12000,
      installmentCount: 12,
      firstSeenAt: pending.firstSeenAt,
      lastSeenAt: posted.lastSeenAt,
    });
    expect(result.sourceAliases).toEqual([
      "pending-key",
      "old-pending-key",
      "old-posted-key",
    ]);
    expect(result.details.sourceRefs).toEqual([
      ...pending.details.sourceRefs,
      ...posted.details.sourceRefs,
    ]);
    expect(retained(result.details, "paymentHistory")).toEqual([
      { label: "First" },
      { label: "Earlier" },
    ]);
    expect(result.details.issues).toEqual(["other_financial_issue"]);
    expect(result.details.pendingPostingCandidates).toEqual([]);
    expect((await db.getTransaction(pending.id))!.annotation).toEqual(note);
    expect(await db.getTransaction(posted.id)).toMatchObject({
      supersededById: pending.id,
      version: 2,
      details: { issues: [], pendingPostingCandidates: [] },
    });
    expect(await db.listTransactions()).toHaveLength(1);
    expect(await db.getTotals({ includeSuperseded: true })).toMatchObject({
      includedCount: 1,
      excluded: { retiredOrRemoved: 1 },
      totals: [
        {
          amountMinor: -12000,
          currency: "ILS",
          amountBasis: "purchase_commitment",
        },
      ],
    });
    const events = await db.listEvents();
    expect(
      events.filter((event) => event.type === "transaction.posted"),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.type === "transaction.posted"),
    ).toMatchObject({
      transactionId: pending.id,
      before: { status: "pending" },
      after: {
        status: "posted",
        retiredId: posted.id,
        reason: (await command()).reason,
      },
    });
    expect(
      events.find((event) => event.type === "transaction.linked"),
    ).toMatchObject({
      transactionId: posted.id,
      after: { supersededById: pending.id },
    });
    expect(
      events.filter((event) => event.type === "transaction.review_resolved"),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.type === "transaction.review_required"),
    ).toMatchObject({
      transactionId: pending.id,
      after: {
        required: true,
        reasons: ["other_financial_issue"],
        candidates: [],
      },
    });
  });

  it("carries a matching approved review into posted basis with versioned history", async () => {
    const prior = await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      expectedTransactionVersion: 1,
      notes: "Approved purchase",
      review: { status: "approved" },
    });
    await db.linkPendingTransaction(await command());
    const survivor = (await db.getTransaction(pending.id))!;
    expect(survivor).toMatchObject({
      reviewStale: false,
      reviewRequired: false,
      annotation: {
        version: 2,
        data: {
          notes: prior.data.notes,
          review: {
            status: "approved",
            financialVersion: 2,
            basis: { amountBasis: "purchase_commitment" },
          },
        },
      },
    });
    expect(
      (await db.listEvents()).filter(
        (event) => event.type === "annotation.updated",
      ),
    ).toHaveLength(2);
    expect(
      (await db.listEvents())
        .filter((event) => event.type === "annotation.updated")
        .at(-1)!.before,
    ).toEqual({ version: prior.version, data: prior.data });
  });

  it("preserves the approval document unchanged when posted money differs and exposes staleness", async () => {
    const prior = await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      expectedTransactionVersion: 1,
      review: { status: "approved" },
    });
    await db.orm
      .update(transactions)
      .set({ amountMinor: -12500 })
      .where(eq(transactions.id, posted.id))
      .run();
    await db.linkPendingTransaction(await command());
    expect(await db.getTransaction(pending.id)).toMatchObject({
      reviewStale: true,
      reviewRequired: true,
      annotation: prior,
    });
    expect(
      (await db.listEvents()).filter(
        (event) => event.type === "annotation.updated",
      ),
    ).toHaveLength(1);
  });

  it.each([
    "expectedPendingVersion",
    "expectedPostedVersion",
    "expectedPendingAnnotationVersion",
    "expectedPostedAnnotationVersion",
  ] as const)("rejects %s conflicts without writing", async (field) => {
    const before = await state();
    await expect(
      db.linkPendingTransaction({ ...(await command()), [field]: 20 }),
    ).rejects.toThrow(ConflictError);
    expect(await state()).toEqual(before);
  });

  it.each(["sourceScope", "cardId", "connectionId"] as const)(
    "rejects a different %s without writing",
    async (field) => {
      if (field === "connectionId") {
        await db.ensureConnection({ id: "other", provider: "cal" });
      }
      if (field !== "sourceScope") {
        // Card IDs are connection-scoped: another connection needs its own card.
        await db.orm.insert(cards).values({
          id: "other",
          connectionId: field === "connectionId" ? "other" : "synthetic",
          providerKey: "other",
          createdAt: "2040-08-01T00:00:00Z",
        });
      }
      await db.orm
        .update(transactions)
        .set(
          field === "connectionId"
            ? { connectionId: "other", cardId: "other" }
            : { [field]: "other" },
        )
        .where(eq(transactions.id, posted.id))
        .run();
      const before = await state();
      await expect(db.linkPendingTransaction(await command())).rejects.toThrow(
        ConflictError,
      );
      expect(await state()).toEqual(before);
    },
  );

  it("rejects conflicting meaningful annotations atomically", async () => {
    for (const row of [pending, posted]) {
      await db.editAnnotation({
        transactionId: row.id,
        expectedVersion: 0,
        notes: row.id,
      });
    }
    const before = await state();
    await expect(db.linkPendingTransaction(await command())).rejects.toThrow(
      /Conflicting annotations/,
    );
    expect(await state()).toEqual(before);
  });

  it("keeps identical meaningful annotation documents and the retired document unchanged", async () => {
    for (const row of [pending, posted]) {
      await db.editAnnotation({
        transactionId: row.id,
        expectedVersion: 0,
        notes: "Same note",
        metadata: { second: 2, first: 1 },
      });
    }
    const original = await db.orm.select().from(annotations).all();
    await db.linkPendingTransaction(await command());
    expect(await db.orm.select().from(annotations).all()).toEqual(original);
  });

  it.each([false, true])(
    "copies posted-only meaningful annotations over empty survivor document: %s",
    async (emptyExists) => {
      if (emptyExists) {
        await db.editAnnotation({
          transactionId: pending.id,
          expectedVersion: 0,
        });
      }
      const original = await db.editAnnotation({
        transactionId: posted.id,
        expectedVersion: 0,
        expectedTransactionVersion: 1,
        notes: "Posted note",
        review: { status: "approved" },
      });
      await db.linkPendingTransaction(await command());
      expect(await db.getTransaction(pending.id)).toMatchObject({
        reviewStale: false,
        annotation: {
          version: emptyExists ? 2 : 1,
          data: { notes: "Posted note", review: { financialVersion: 2 } },
        },
      });
      expect((await db.getTransaction(posted.id))!.annotation).toEqual(
        original,
      );
      const copied = (await db.listEvents())
        .filter(
          (event) =>
            event.type === "annotation.updated" &&
            event.transactionId === pending.id,
        )
        .at(-1)!;
      expect(copied.after).toMatchObject({
        linkedFromId: posted.id,
        data: { notes: "Posted note" },
      });
    },
  );

  it("allows a weak singleton but refuses unresolved ambiguous identities", async () => {
    await updateTransaction(db.orm, pending.id, {
      identityStrength: "weak",
      details: {
        ...pending.details,
        issues: [...pending.details.issues, "weak_source_identity"],
      },
    });
    expect(await db.linkPendingTransaction(await command())).toMatchObject({
      id: pending.id,
      identityStrength: "native",
      details: { issues: [] },
    });
  });

  it.each(["ambiguous", "weak"] as const)(
    "rejects posted %s identity",
    async (identityStrength) => {
      await db.orm
        .update(transactions)
        .set({ identityStrength })
        .where(eq(transactions.id, posted.id))
        .run();
      const before = await state();
      await expect(db.linkPendingTransaction(await command())).rejects.toThrow(
        ConflictError,
      );
      expect(await state()).toEqual(before);
    },
  );

  it("rejects pending ambiguity, confirmed removal, and already-retired rows", async () => {
    await db.orm
      .update(transactions)
      .set({ identityStrength: "ambiguous" })
      .where(eq(transactions.id, pending.id))
      .run();
    await expect(db.linkPendingTransaction(await command())).rejects.toThrow(
      ConflictError,
    );
    await db.orm
      .update(transactions)
      .set({ identityStrength: "native", presence: "removed" })
      .where(eq(transactions.id, pending.id))
      .run();
    await expect(db.linkPendingTransaction(await command())).rejects.toThrow(
      ConflictError,
    );
    await db.orm
      .update(transactions)
      .set({ presence: "not_returned" })
      .where(eq(transactions.id, pending.id))
      .run();
    await db.linkPendingTransaction(await command());
    await expect(db.linkPendingTransaction(await command())).rejects.toThrow(
      ConflictError,
    );
    await expect(
      db.confirmRemoval({
        transactionId: posted.id,
        expectedVersion: 2,
        reason: "Retired duplicate",
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("rejects linking another pending row to an existing survivor without moving notes or creating a chain", async () => {
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "Stable purchase note",
    });
    const survivor = await db.linkPendingTransaction(await command());
    const laterPending = await insertTransaction(db.orm, {
      ...pending,
      id: "later-pending",
      sourceKey: "later-key",
    });
    const before = await state();
    await expect(
      db.linkPendingTransaction({
        pendingId: laterPending.id,
        postedId: survivor.id,
        expectedPendingVersion: 1,
        expectedPostedVersion: survivor.version,
        expectedPendingAnnotationVersion: 0,
        expectedPostedAnnotationVersion: 1,
        reason: "Another proposed posting link",
      }),
    ).rejects.toThrow(/already survives a confirmed link/);
    expect(await state()).toEqual(before);
    expect((await db.getTransaction(laterPending.id))!.annotation).toBeNull();
    expect(await db.getTransaction(survivor.id)).toMatchObject({
      supersededById: null,
      annotation: { data: { notes: "Stable purchase note" } },
    });
  });

  it("confirms removal with evidence while retaining facts and notes, excludes spending, and repeats quietly", async () => {
    const note = await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: 0,
      notes: "Retained note",
    });
    const result = await db.confirmRemoval({
      transactionId: posted.id,
      expectedVersion: 1,
      reason: "Owner verified duplicate against statement",
      actor: "owner",
    });
    expect(result).toEqual({
      ...posted,
      version: 2,
      presence: "removed",
    });
    expect((await db.getTransaction(posted.id))!.annotation).toEqual(note);
    expect(await db.getTotals()).toMatchObject({
      includedCount: 0,
      totals: [],
      excluded: { retiredOrRemoved: 1, pending: 1 },
    });
    expect(
      (await db.listEvents()).find(
        (event) => event.type === "transaction.removed",
      ),
    ).toMatchObject({
      type: "transaction.removed",
      actor: "owner",
      before: { presence: "seen", amountMinor: -12000 },
      after: {
        presence: "removed",
        reason: "Owner verified duplicate against statement",
      },
    });
    const history = await db.listEvents();
    expect(
      await db.confirmRemoval({
        transactionId: posted.id,
        expectedVersion: 2,
        reason: "Same evidence",
      }),
    ).toEqual(result);
    expect(await db.listEvents()).toEqual(history);
    await expect(
      db.confirmRemoval({
        transactionId: posted.id,
        expectedVersion: 1,
        reason: "Stale request",
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("validates reason and safe versions before writes", async () => {
    const before = await state();
    for (const invalid of [
      { reason: "  " },
      { expectedPendingVersion: 0 },
      { expectedPostedVersion: 1.5 },
      { expectedPendingAnnotationVersion: -1 },
      { expectedPostedAnnotationVersion: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await expect(
        db.linkPendingTransaction({ ...(await command()), ...invalid }),
      ).rejects.toThrow();
    }
    await expect(
      db.confirmRemoval({
        transactionId: posted.id,
        expectedVersion: 1,
        reason: " ",
      }),
    ).rejects.toThrow();
    await expect(
      db.confirmRemoval({
        transactionId: posted.id,
        expectedVersion: 0,
        reason: "Evidence",
      }),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it.each([false, true])(
    "immediately clears other candidates after linking and preserves remaining review issues: %s",
    async (otherIssue) => {
      const candidate = await insertTransaction(db.orm, {
        ...pending,
        id: "other-pending",
        sourceKey: "other-pending-key",
        details: {
          ...pending.details,
          pendingPostingCandidates: [pending.id, posted.id],
          issues: [
            "possible_pending_posted_match",
            ...(otherIssue ? ["other_financial_issue"] : []),
          ],
        },
      });
      const remaining = await insertTransaction(db.orm, {
        ...pending,
        id: "remaining-pending",
        sourceKey: "remaining-key",
        details: {
          ...pending.details,
          pendingPostingCandidates: [posted.id, "another-posted"],
        },
      });
      const unrelated = await insertTransaction(db.orm, {
        ...candidate,
        id: "unrelated-account",
        sourceScope: "other-account",
        sourceKey: "unrelated-key",
      });
      const unrelatedBefore = (await readTransactions(db.orm)).find(
        (row) => row.id === unrelated.id,
      );
      await db.linkPendingTransaction(await command());
      expect(await db.getTransaction(candidate.id)).toMatchObject({
        version: 2,
        reviewRequired: otherIssue,
        details: {
          pendingPostingCandidates: [],
          issues: otherIssue ? ["other_financial_issue"] : [],
        },
      });
      expect(await db.getTransaction(remaining.id)).toMatchObject({
        version: 1,
        reviewRequired: true,
        details: {
          pendingPostingCandidates: ["another-posted"],
          issues: ["possible_pending_posted_match"],
        },
      });
      expect(
        (await readTransactions(db.orm)).find((row) => row.id === unrelated.id),
      ).toEqual(unrelatedBefore);
      const event = (await db.listEvents()).find(
        (change) => change.transactionId === candidate.id,
      )!;
      expect(event).toMatchObject({
        type: otherIssue
          ? "transaction.review_required"
          : "transaction.review_resolved",
        before: { required: true, candidates: [pending.id, posted.id] },
        after: {
          required: otherIssue,
          candidates: [],
          reasons: otherIssue ? ["other_financial_issue"] : [],
          reason: (await command()).reason,
        },
      });
      expect(
        (await db.listEvents()).find(
          (change) => change.transactionId === remaining.id,
        ),
      ).toMatchObject({
        type: "transaction.review_required",
        after: { required: true, candidates: ["another-posted"] },
      });
      expect(
        (await db.listEvents()).some(
          (change) => change.transactionId === unrelated.id,
        ),
      ).toBe(false);
      expect(
        (await db.listEvents()).find(
          (change) =>
            change.transactionId === candidate.id &&
            change.type === "transaction.updated",
        ),
      ).toMatchObject({
        before: {
          sourceIssues: expect.arrayContaining([
            "possible_pending_posted_match",
          ]),
        },
        after: { sourceIssues: otherIssue ? ["other_financial_issue"] : [] },
      });
    },
  );

  async function expectVersionLimit(action: Promise<unknown>) {
    const error = await action.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe("Version limit reached");
  }

  async function setVersion(id: string, version: number) {
    await db.orm
      .update(transactions)
      .set({ version })
      .where(eq(transactions.id, id))
      .run();
  }

  it.each(["pending", "posted", "billed line", "carried approval"] as const)(
    "refuses a link that would advance the %s past the version limit",
    async (target) => {
      const limit = Number.MAX_SAFE_INTEGER;
      if (target === "pending" || target === "posted") {
        await setVersion(target === "pending" ? pending.id : posted.id, limit);
      } else if (target === "billed line") {
        await insertTransaction(db.orm, {
          ...posted,
          id: "line",
          sourceKey: "line-key",
          sourceAliases: [],
          purchaseId: posted.id,
          installmentNumber: 1,
          details: emptyDetails(),
          version: limit,
        });
      } else {
        await db.editAnnotation({
          transactionId: pending.id,
          expectedVersion: 0,
          expectedTransactionVersion: 1,
          notes: "Approved purchase",
          review: { status: "approved" },
        });
        await db.orm
          .update(annotations)
          .set({ version: limit })
          .where(eq(annotations.transactionId, pending.id))
          .run();
      }
      const before = await state();
      await expectVersionLimit(db.linkPendingTransaction(await command()));
      expect(await state()).toEqual(before);
    },
  );

  it.each(["pending", "posted"] as const)(
    "refuses an unlink that would advance the %s row past the version limit",
    async (target) => {
      await db.linkPendingTransaction(await command());
      await setVersion(
        target === "pending" ? pending.id : posted.id,
        Number.MAX_SAFE_INTEGER,
      );
      const before = await state();
      await expectVersionLimit(db.unlinkPendingTransaction(await command()));
      expect(await state()).toEqual(before);
    },
  );

  it("immediately removes confirmed removals from other candidate lists and retains removed evidence", async () => {
    const other = await insertTransaction(db.orm, {
      ...pending,
      id: "other-pending",
      sourceKey: "other-key",
      details: {
        ...pending.details,
        issues: [...pending.details.issues, "weak_source_identity"],
      },
    });
    const result = await db.confirmRemoval({
      transactionId: posted.id,
      expectedVersion: 1,
      reason: "Verified removal",
    });
    expect(result).toMatchObject({
      details: { pendingPostingCandidates: [pending.id] },
    });
    expect(await db.getTransaction(pending.id)).toMatchObject({
      version: 2,
      reviewRequired: false,
      details: { issues: [], pendingPostingCandidates: [] },
    });
    expect(await db.getTransaction(other.id)).toMatchObject({
      version: 2,
      reviewRequired: true,
      details: {
        issues: ["weak_source_identity"],
        pendingPostingCandidates: [],
      },
    });
    expect(
      (await db.listEvents()).find(
        (change) => change.transactionId === pending.id,
      ),
    ).toMatchObject({
      type: "transaction.review_resolved",
      before: { required: true, candidates: [posted.id] },
      after: { required: false, reasons: [], candidates: [] },
    });
    expect(
      (await db.listEvents()).find(
        (change) => change.transactionId === other.id,
      ),
    ).toMatchObject({
      type: "transaction.review_required",
      after: {
        required: true,
        reasons: ["weak_source_identity"],
        candidates: [],
      },
    });
    await db.confirmRemoval({
      transactionId: posted.id,
      expectedVersion: 2,
      reason: "Same evidence",
    });
    expect((await db.getTransaction(posted.id))!.reviewRequired).toBe(false);
  });

  it.each(["link", "removal"])(
    "rolls back %s and candidate cleanup together when cleanup logging fails",
    async (operation) => {
      await insertTransaction(db.orm, {
        ...pending,
        id: "other-pending",
        sourceKey: "other-key",
      });
      await db.client.executeMultiple(
        "CREATE TRIGGER synthetic_cleanup_failure BEFORE INSERT ON events WHEN NEW.transaction_id = 'other-pending' BEGIN SELECT RAISE(ABORT, 'synthetic cleanup failure'); END;",
      );
      const before = await state();
      await expect(async () =>
        operation === "link"
          ? await db.linkPendingTransaction(await command())
          : await db.confirmRemoval({
              transactionId: posted.id,
              expectedVersion: 1,
              reason: "Verified removal",
            }),
      ).rejects.toMatchObject({
        cause: {
          message: expect.stringContaining("synthetic cleanup failure"),
        },
      });
      expect(await state()).toEqual(before);
    },
  );

  it.each(["link", "removal"])(
    "rolls back %s when change logging fails",
    async (operation) => {
      await db.editAnnotation({
        transactionId: posted.id,
        expectedVersion: 0,
        notes: "Would be copied",
      });
      await db.client.executeMultiple(
        "CREATE TRIGGER synthetic_failure BEFORE INSERT ON events WHEN NEW.type IN ('transaction.posted', 'transaction.removed') BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
      );
      const before = await state();
      await expect(async () =>
        operation === "link"
          ? await db.linkPendingTransaction(await command())
          : await db.confirmRemoval({
              transactionId: posted.id,
              expectedVersion: 1,
              reason: "Evidence",
            }),
      ).rejects.toMatchObject({
        cause: { message: expect.stringContaining("synthetic failure") },
      });
      expect(await state()).toEqual(before);
    },
  );
});
