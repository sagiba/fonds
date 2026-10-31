import "../helpers/application-loading-differential.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "../../src/domain/errors.js";
import { emptyDetails, type TransactionInput } from "../../src/domain/model.js";
import {
  authorization,
  postingAdapter,
  postingHarness,
} from "../helpers/posting.js";
import {
  backends,
  type Harness,
  open,
  row,
} from "../helpers/storage-harness.js";

describe.each(backends)("%s linked current pending component", (backend) => {
  let db: Harness;
  let harness: ReturnType<typeof postingHarness>;
  beforeEach(async () => {
    db = await open(backend);
    harness = postingHarness(db);
    await db.ensureConnection({ id: harness.connectionId, provider: "cal" });
  });
  afterEach(() => db.close());

  async function linked(fields: Partial<TransactionInput> = {}) {
    await harness.capture(1, [authorization("pending", fields)]);
    const pending = await harness.byKey("pending");
    await harness.capture(2, [row("posted")]);
    const survivor = (await db.getTransaction(pending.id))!;
    const postedId = survivor.details.postingLink!.postedId;
    return { survivor, postedId };
  }

  async function component(id: string) {
    return (await db.getTransaction(id))!.details.postingLink!.pending;
  }

  it("retains corrected current facts and independent receipts without rewriting original link history", async () => {
    const { survivor, postedId } = await linked();
    const beforeCommand = await harness.command(survivor.id, postedId);
    const originalEvents = await db.listEvents();
    const cursor = await db.latestEventId();
    const corrected = authorization("pending", {
      amountMinor: -250,
      merchantName: "Corrected merchant",
    });

    expect(await harness.capture(3, [corrected, row("posted")])).toMatchObject({
      created: 0,
      updated: 1,
    });
    const current = (await db.getTransaction(survivor.id))!;
    expect(current).toMatchObject({
      status: "posted",
      amountMinor: -100,
      merchantName: "Merchant",
      version: survivor.version + 1,
      sourceEvidence: {
        identity: { runId: "posting-3" },
      },
    });
    expect(await component(survivor.id)).toMatchObject({
      amountMinor: -250,
      merchantName: "Corrected merchant",
      presence: "seen",
      lastSeenRunId: "posting-3",
      sourceEvidence: {
        identity: { runId: "posting-3" },
        financial: {
          runId: "posting-3",
          capturedAt: "2040-07-03T12:00:00.000Z",
        },
      },
    });
    const updates = (await db.listEvents({ after: cursor })).filter(
      (event) => event.type === "transaction.updated",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.after).toMatchObject({
      pendingSourceEvidence: {
        runId: "posting-3",
        presence: "seen",
        sourceAbsent: false,
      },
    });
    expect(JSON.stringify(updates)).not.toContain("financialFingerprint");
    await expect(db.unlinkPendingTransaction(beforeCommand)).rejects.toThrow(
      ConflictError,
    );

    const quietCursor = await db.latestEventId();
    expect(await harness.capture(4, [corrected, row("posted")])).toMatchObject({
      created: 0,
      updated: 0,
    });
    expect(await db.latestEventId()).toBe(quietCursor);
    expect((await db.getTransaction(survivor.id))!.version).toBe(
      current.version,
    );
    const split = await db.unlinkPendingTransaction(
      await harness.command(survivor.id, postedId),
    );
    expect(split.pending).toMatchObject({
      id: survivor.id,
      status: "pending",
      amountMinor: -250,
      merchantName: "Corrected merchant",
      presence: "seen",
      lastSeenRunId: "posting-4",
      sourceEvidence: {
        identity: { runId: "posting-4" },
        financial: { runId: "posting-4" },
      },
    });
    expect(split.posted).toMatchObject({
      id: postedId,
      status: "posted",
      amountMinor: -100,
      merchantName: "Merchant",
      presence: "seen",
    });
    expect(
      split.pending.sourceEvidence?.identity?.financialFingerprint,
    ).not.toBe(split.posted.sourceEvidence?.identity?.financialFingerprint);
    const originalIds = new Set(originalEvents.map((event) => event.id));
    expect(
      (await db.listEvents()).filter((event) => originalIds.has(event.id)),
    ).toEqual(originalEvents);
  });

  it("preserves both independent annotation records when unlinking corrected components", async () => {
    await harness.capture(1, [authorization(), row("posted")]);
    const pending = await harness.byKey("pending");
    const posted = await harness.byKey("posted");
    for (const transaction of [pending, posted]) {
      await db.editAnnotation({
        transactionId: transaction.id,
        expectedVersion: 0,
        notes: "Original shared note",
      });
    }
    await db.linkPendingTransaction(
      await harness.command(pending.id, posted.id),
    );
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 1,
      notes: "Pending-side owner note",
    });
    const annotations = await Promise.all(
      [pending.id, posted.id].map(
        async (id) => (await db.getTransaction(id))!.annotation,
      ),
    );
    await harness.capture(2, [
      authorization("pending", {
        amountMinor: -250,
        merchantName: "Corrected merchant",
      }),
      row("posted"),
    ]);
    const split = await db.unlinkPendingTransaction(
      await harness.command(pending.id, posted.id),
    );
    expect(split.pending.amountMinor).toBe(-250);
    expect(split.posted.amountMinor).toBe(-100);
    expect(
      await Promise.all(
        [pending.id, posted.id].map(
          async (id) => (await db.getTransaction(id))!.annotation,
        ),
      ),
    ).toEqual(annotations);
  });

  it("reconciles explicit payment conflicts and omissions only on the pending component", async () => {
    const { survivor, postedId } = await linked({
      cardPresent: true,
      wallet: "apple_pay",
    });
    await harness.capture(3, [
      authorization("pending", { cardPresent: null, wallet: null }),
      row("posted", { cardPresent: false, wallet: "google_pay" }),
    ]);
    await harness.capture(4, [
      authorization(),
      row("posted", { cardPresent: false, wallet: "google_pay" }),
    ]);
    expect(await component(survivor.id)).toMatchObject({
      cardPresent: null,
      wallet: null,
      details: {
        paymentContextConflicts: ["cardPresent", "wallet"],
        issues: ["conflicting_payment_context"],
      },
    });
    await harness.capture(5, [
      authorization("pending", { cardPresent: true, wallet: "apple_pay" }),
      row("posted", { cardPresent: false, wallet: "google_pay" }),
    ]);
    const split = await db.unlinkPendingTransaction(
      await harness.command(survivor.id, postedId),
    );
    expect(split.pending).toMatchObject({
      cardPresent: true,
      wallet: "apple_pay",
    });
    expect(split.pending.details.paymentContextConflicts).toBeUndefined();
    expect(split.pending.details.issues).not.toContain(
      "conflicting_payment_context",
    );
    expect(split.posted).toMatchObject({
      cardPresent: false,
      wallet: "google_pay",
    });
    expect(split.posted.details.paymentContextConflicts).toBeUndefined();
  });

  it.each(["stale", "history"] as const)(
    "does not replace current component facts or provenance with %s corrections",
    async (source) => {
      const { survivor } = await linked();
      await harness.capture(4, [
        authorization("pending", {
          amountMinor: -250,
          merchantName: "Current merchant",
        }),
        row("posted"),
      ]);
      const current = await component(survivor.id);
      const cursor = await db.latestEventId();
      await harness.capture(
        source === "history" ? 5 : 3,
        [
          authorization("pending", {
            amountMinor: -900,
            merchantName: "Outdated merchant",
          }),
          row("posted"),
        ],
        postingAdapter,
        { history: source === "history" },
      );
      expect(await component(survivor.id)).toMatchObject({
        amountMinor: -250,
        merchantName: "Current merchant",
        lastSeenAt: current.lastSeenAt,
        lastSeenRunId: current.lastSeenRunId,
        sourceEvidence: current.sourceEvidence,
        presence: "seen",
      });
      expect(await db.latestEventId()).toBe(cursor);
    },
  );

  it.each(["correction-first", "snapshot-first"] as const)(
    "reconciles linked authorization facts leaving negative coverage: %s",
    async (order) => {
      const { survivor, postedId } = await linked();
      const dated = {
        ...postingAdapter,
        sourceCoverage: {
          kind: "account_window" as const,
          statuses: ["pending", "posted"] as ("pending" | "posted")[],
          resources: ["synthetic:cal/recent"],
          dateField: "transactionDate" as const,
          days: 60,
        },
      };
      const corrected = authorization("pending", {
        transactionDate: "2039-01-01",
        amountMinor: -250,
      });
      const correction = () =>
        harness.capture(3, [corrected, row("posted")], dated);
      const omission = () => harness.capture(5, [row("posted")], dated);
      if (order === "correction-first") {
        await correction();
        await omission();
      } else {
        await omission();
        await correction();
      }
      const pending = await component(survivor.id);
      expect(pending).toMatchObject({
        transactionDate: "2039-01-01",
        amountMinor: -250,
        presence: "seen",
        lastSeenRunId: "posting-3",
      });
      expect(pending.sourceAbsence).toBeUndefined();
      expect((await db.getTransaction(survivor.id))!.amountMinor).toBe(-100);
      const cursor = await db.latestEventId();
      await correction();
      await omission();
      expect(await db.latestEventId()).toBe(cursor);
      const split = await db.unlinkPendingTransaction(
        await harness.command(survivor.id, postedId),
      );
      expect(split.pending).toMatchObject({
        transactionDate: "2039-01-01",
        amountMinor: -250,
        presence: "seen",
      });
      expect(split.pending.sourceAbsence).toBeUndefined();
      expect(split.posted.amountMinor).toBe(-100);
    },
  );

  it("makes component absence and restoration semantic but repeated absence watermarks quiet", async () => {
    const { survivor, postedId } = await linked();
    await harness.capture(3, [authorization(), row("posted")]);
    const beforeAbsence = (await db.getTransaction(survivor.id))!;
    await harness.capture(5, [row("posted")]);
    const absent = (await db.getTransaction(survivor.id))!;
    expect(absent.version).toBe(beforeAbsence.version + 1);
    expect(await component(survivor.id)).toMatchObject({
      presence: "not_returned",
      sourceAbsence: { runId: "posting-5" },
    });
    const quietCursor = await db.latestEventId();
    await harness.capture(6, [row("posted")]);
    expect((await db.getTransaction(survivor.id))!.version).toBe(
      absent.version,
    );
    expect(await db.latestEventId()).toBe(quietCursor);
    let factCursor = quietCursor;
    for (const day of [6, 4]) {
      await harness.capture(
        day,
        [authorization("pending", { amountMinor: -900 }), row("posted")],
        postingAdapter,
        { runId: `blocked-positive-${day}` },
      );
      expect(await component(survivor.id)).toMatchObject({
        amountMinor: -900,
        presence: "not_returned",
        lastSeenRunId: "blocked-positive-6",
        sourceAbsence: { runId: "posting-6" },
      });
      if (day === 6) {
        expect(await db.listEvents({ after: quietCursor })).toHaveLength(1);
        factCursor = await db.latestEventId();
      } else {
        expect(await db.latestEventId()).toBe(factCursor);
      }
    }
    const command = await harness.command(survivor.id, postedId);
    await harness.capture(7, [
      authorization("pending", { amountMinor: -250 }),
      row("posted"),
    ]);
    expect(await component(survivor.id)).toMatchObject({
      amountMinor: -250,
      presence: "seen",
      lastSeenRunId: "posting-7",
    });
    expect((await component(survivor.id)).sourceAbsence).toBeUndefined();
    await expect(db.unlinkPendingTransaction(command)).rejects.toThrow(
      ConflictError,
    );
  });

  it.each([false, true])(
    "does not select duplicate alias candidates or fabricate absence (previously absent: %s)",
    async (absent) => {
      const { survivor } = await linked();
      await harness.capture(3, [authorization(), row("posted")]);
      if (absent) {
        await harness.capture(4, [row("posted")]);
      }
      const before = await component(survivor.id);
      const previous = (await db.getTransaction(survivor.id))!;
      const cursor = await db.latestEventId();
      const collision = [
        authorization("pending", { amountMinor: -250 }),
        authorization("pending", { amountMinor: -900 }),
        row("posted"),
      ];
      for (const day of [5, 5, 6]) {
        await harness.capture(day, collision);
        const current = (await db.getTransaction(survivor.id))!;
        expect(await component(survivor.id)).toEqual(before);
        expect(current.amountMinor).toBe(previous.amountMinor);
        expect(current.version).toBe(previous.version);
        expect(current.annotation).toEqual(previous.annotation);
        expect(current.details.sourceRefs).toEqual(
          expect.arrayContaining([
            { runId: `posting-${day}`, path: "rows[0]" },
            { runId: `posting-${day}`, path: "rows[1]" },
            { runId: `posting-${day}`, path: "rows[2]" },
          ]),
        );
        expect(await db.latestEventId()).toBe(cursor);
      }
    },
  );

  it.each([
    { identityStrength: "ambiguous" as const },
    { cardKey: "other-synthetic-card" },
    { details: { ...emptyDetails(), issues: ["ambiguous_identity"] } },
  ])("requires the same unambiguous native attribution: %j", async (fields) => {
    const { survivor } = await linked();
    await harness.capture(3, [authorization(), row("posted")]);
    const before = await component(survivor.id);
    await harness.capture(4, [
      authorization("pending", { amountMinor: -250, ...fields }),
      row("posted"),
    ]);
    expect(await component(survivor.id)).toEqual(before);
  });

  it("never retains an old financial receipt for a fresh unresolved pending snapshot", async () => {
    const { survivor, postedId } = await linked();
    await harness.capture(3, [authorization(), row("posted")]);
    expect(
      (await component(survivor.id)).sourceEvidence?.financial,
    ).toBeDefined();
    await harness.capture(4, [
      authorization("pending", {
        amountMinor: null,
        currency: null,
        amountBasis: "unknown",
      }),
      row("posted"),
    ]);
    const split = await db.unlinkPendingTransaction(
      await harness.command(survivor.id, postedId),
    );
    expect(split.pending).toMatchObject({
      amountMinor: null,
      currency: null,
      amountBasis: "unknown",
      sourceEvidence: { identity: { runId: "posting-4" } },
    });
    expect(split.pending.sourceEvidence?.financial).toBeUndefined();
    expect(split.posted.amountMinor).toBe(-100);
  });

  it("does not let a corrected pending alias bypass owner removal of the posted survivor", async () => {
    const { survivor, postedId } = await linked();
    await db.confirmRemoval({
      transactionId: survivor.id,
      expectedVersion: survivor.version,
      reason: "Owner verified posted duplicate",
    });
    await harness.capture(
      3,
      [authorization("pending", { amountMinor: -250 })],
      { ...postingAdapter, rejectEmptyRecentPosted: false },
    );
    const removed = (await db.getTransaction(survivor.id))!;
    expect(removed).toMatchObject({
      status: "posted",
      amountMinor: -100,
      presence: "removed",
    });
    expect(removed.sourceEvidence).toEqual(survivor.sourceEvidence);
    const split = await db.unlinkPendingTransaction(
      await harness.command(survivor.id, postedId),
    );
    expect(split.pending).toMatchObject({
      status: "pending",
      amountMinor: -250,
      presence: "seen",
    });
    expect(split.posted).toMatchObject({
      status: "posted",
      amountMinor: -100,
      presence: "removed",
    });
  });
});
