import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TransactionInput } from "../../src/domain/model.js";
import type { CollectionScope } from "../../src/domain/records.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { isracardAdapter } from "../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCardKey,
  serializeIsracardCapture,
} from "../../src/providers/isracard/capture.js";
import {
  authorization,
  postingAdapter,
  postingHarness,
} from "../helpers/posting.js";
import {
  backends,
  type Harness,
  insertTransactionFixture,
  open,
  row,
  synthetic as baseSynthetic,
} from "../helpers/storage-harness.js";

const connectionId = "synthetic-presence";
const synthetic: SourceAdapter = {
  ...baseSynthetic,
  sourceCoverage: {
    kind: "account_window",
    statuses: ["pending", "posted"],
    resources: ["synthetic:presence", "synthetic:cal/recent"],
    dateField: "transactionDate",
    days: 60,
  },
};

describe.each(backends)("%s authoritative source presence", (backend) => {
  let db: Harness;
  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(() => db.close());

  function capture(
    runId: string,
    day: number,
    rows: TransactionInput[],
    adapter: SourceAdapter = synthetic,
    scope?: CollectionScope,
    endpoint = "synthetic:presence",
  ) {
    return db.ingestRun(
      {
        connectionId,
        runId,
        responses: [
          {
            accountKey: "account",
            endpoint,
            capturedAt: `2040-07-${String(day).padStart(2, "0")}T12:00:00Z`,
            responseText: JSON.stringify(rows),
            ...(scope ? { scope } : {}),
          },
        ],
      },
      adapter,
    );
  }

  it.each(["pending", "posted"] as const)(
    "hides an unlinked %s disappearance, retains evidence and annotations, and restores only the native identity",
    async (status) => {
      const input =
        status === "pending"
          ? authorization("native")
          : row("native", { amountMinor: -7300 });
      await capture("baseline", 1, [input]);
      const [original] = await db.listTransactions();
      const annotation = await db.editAnnotation({
        transactionId: original!.id,
        expectedVersion: 0,
        notes: "Owner evidence, not a cancellation or refund",
      });
      const cursor = await db.latestEventId();
      expect(await capture("absent", 2, [])).toMatchObject({
        unlisted: 1,
        created: 0,
      });
      expect(
        (await db.listTransactionPage({ connectionId, limit: 100 }))
          .transactions,
      ).toEqual([]);
      expect(
        (
          await db.listTransactionPage({
            connectionId,
            presence: "all",
            limit: 100,
          })
        ).transactions,
      ).toMatchObject([
        {
          id: original!.id,
          presence: "not_returned",
          status,
          kind: "purchase",
        },
      ]);
      const missing = (await db.getTransaction(original!.id))!;
      expect(missing).toMatchObject({
        presence: "not_returned",
        version: original!.version + 1,
        amountMinor: input.amountMinor,
        annotation,
        supersededById: null,
        sourceAbsence: {
          runId: "absent",
          capturedAt: "2040-07-02T12:00:00.000Z",
        },
      });
      for (const presence of [undefined, "all", "not_returned"] as const) {
        expect(
          await db.getTotals({
            connectionId,
            ...(presence ? { presence } : {}),
          }),
        ).toMatchObject({
          totals: [],
          includedCount: 0,
          excluded: { sourceAbsent: presence === undefined ? 0 : 1 },
        });
      }
      expect(
        await db.getTotals({
          connectionId,
          perspective: "billing",
          presence: "all",
        }),
      ).toMatchObject({
        totals: [],
        includedCount: 0,
        excluded: { sourceAbsent: 1 },
      });
      expect(
        (await db.listEvents({ after: cursor })).map((event) => event.type),
      ).toEqual(["transaction.unlisted"]);
      const absentCursor = await db.latestEventId();
      expect(await capture("still-absent", 3, [])).toMatchObject({
        unlisted: 0,
        created: 0,
      });
      expect(await capture("still-absent", 3, [])).toMatchObject({
        replayed: true,
      });
      expect(await db.latestEventId()).toBe(absentCursor);
      const repeated = (await db.getTransaction(original!.id))!;
      expect(repeated).toMatchObject({
        ...missing,
        sourceAbsence: {
          runId: "still-absent",
          capturedAt: "2040-07-03T12:00:00.000Z",
        },
      });
      await capture("stale-return", 1, [input]);
      expect((await db.getTransaction(original!.id))!.presence).toBe(
        "not_returned",
      );
      await capture("historical-return", 5, [input], synthetic, {
        kind: "history",
      });
      expect((await db.getTransaction(original!.id))!.sourceAbsence).toEqual(
        repeated.sourceAbsence,
      );
      expect(
        (await db.listTransactionPage({ connectionId, limit: 100 }))
          .transactions,
      ).toEqual([]);
      expect(await capture("fresh-return", 6, [input])).toMatchObject({
        created: 0,
        unlisted: 0,
      });
      expect(await db.getTransaction(original!.id)).toMatchObject({
        id: original!.id,
        presence: "seen",
        version: original!.version + 2,
        annotation,
        amountMinor: input.amountMinor,
      });
      expect(
        (await db.getTransaction(original!.id))!.sourceAbsence ?? null,
      ).toBeNull();
      expect(
        (await db.listTransactionPage({ connectionId, limit: 100 }))
          .transactions,
      ).toHaveLength(1);
      expect(
        (await db.listTransactions({ presence: "all" })).map(
          (item) => item.kind,
        ),
      ).toEqual(["purchase"]);
      expect(
        (await db.listEvents({ after: absentCursor })).map(
          (event) => event.type,
        ),
      ).toEqual(["transaction.restored"]);
      expect(await db.getTotals({ connectionId })).toMatchObject({
        includedCount: status === "posted" ? 1 : 0,
        totals:
          status === "posted" ? [{ currency: "ILS", amountMinor: -7300 }] : [],
      });
    },
  );

  it.each([
    ["historical", "before", true],
    ["historical", "after", true],
    ["stale", "before", true],
    ["stale", "after", true],
    ["historical", "before", false],
    ["historical", "after", false],
    ["stale", "before", false],
    ["stale", "after", false],
  ] as const)(
    "reconciles %s import %s complete coverage identically (inside: %s)",
    async (mode, order, inside) => {
      const adapter: SourceAdapter = { ...synthetic, recentComparableDays: 60 };
      const input = row("imported", {
        amountMinor: -4300,
        transactionDate: inside ? "2040-07-01" : "2039-01-01",
      });
      const importRow = () =>
        capture(
          "import",
          1,
          [input],
          adapter,
          mode === "historical" ? { kind: "history" } : undefined,
        );
      const complete = () => capture("complete", 3, [], adapter);
      if (order === "before") {
        await importRow();
        await complete();
      } else {
        await complete();
        await importRow();
      }
      const [imported] = await db.listTransactions({
        connectionId,
        presence: "all",
      });
      expect(imported!.amountMinor).toBe(-4300);
      if (inside) {
        expect(imported).toMatchObject({
          presence: "not_returned",
          sourceAbsence: {
            runId: "complete",
            capturedAt: "2040-07-03T12:00:00.000Z",
          },
        });
      } else {
        expect(imported!.sourceAbsence ?? null).toBeNull();
      }
      expect(
        (await db.listTransactionPage({ connectionId, limit: 100 }))
          .transactions,
      ).toHaveLength(inside ? 0 : 1);
      expect(
        await db.getTotals({ connectionId, presence: "all" }),
      ).toMatchObject({
        totals: inside ? [] : [{ currency: "ILS", amountMinor: -4300 }],
        includedCount: inside ? 0 : 1,
        excluded: { sourceAbsent: inside ? 1 : 0 },
      });
    },
  );

  it.each([
    ["correction-first", "synthetic:other-resource"],
    ["snapshot-first", "synthetic:other-resource"],
    ["correction-first", "synthetic:presence"],
    ["snapshot-first", "synthetic:presence"],
  ] as const)(
    "reconciles native facts leaving retained coverage: %s, %s",
    async (order, endpoint) => {
      const input = row("leaving-window", {
        transactionDate: "2040-07-01",
        amountMinor: -4300,
      });
      await capture("baseline", 1, [input]);
      const [original] = await db.listTransactions();
      const annotation = await db.editAnnotation({
        transactionId: original!.id,
        expectedVersion: 0,
        notes: "Keep independently corrected source facts",
      });
      const correct = () =>
        capture(
          "correction",
          3,
          [{ ...input, transactionDate: "2039-01-01" }],
          synthetic,
          undefined,
          endpoint,
        );
      const complete = () =>
        capture("complete", 5, [
          row("other", {
            transactionDate: "2040-07-04",
            amountMinor: -1100,
          }),
        ]);
      if (order === "correction-first") {
        await correct();
        await complete();
      } else {
        await complete();
        await correct();
      }
      const stored = (await db.getTransaction(original!.id))!;
      expect(stored).toMatchObject({
        id: original!.id,
        transactionDate: "2039-01-01",
        amountMinor: -4300,
        presence: "seen",
        annotation,
        lastSeenAt: "2040-07-03T12:00:00.000Z",
        lastSeenRunId: "correction",
      });
      expect(stored.sourceAbsence).toBeUndefined();
      expect(await db.getTotals({ connectionId })).toMatchObject({
        includedCount: 2,
        totals: [{ currency: "ILS", amountMinor: -5400 }],
      });
      const cursor = await db.latestEventId();
      await correct();
      await complete();
      expect(await db.getTransaction(original!.id)).toEqual(stored);
      expect(await db.latestEventId()).toBe(cursor);
    },
  );

  it.each(["correction-first", "snapshot-first"] as const)(
    "current-over-history correction leaving coverage: %s",
    async (order) => {
      const input = row("history-origin", {
        transactionDate: "2040-07-01",
        amountMinor: -4300,
      });
      await capture("historical", 3, [input], synthetic, { kind: "history" });
      const [original] = await db.listTransactions();
      const annotation = await db.editAnnotation({
        transactionId: original!.id,
        expectedVersion: 0,
        notes: "Historical baseline annotation",
      });
      const correct = () =>
        capture("current", 2, [{ ...input, transactionDate: "2039-01-01" }]);
      const complete = () =>
        capture("complete", 5, [
          row("other", { transactionDate: "2040-07-04", amountMinor: -1100 }),
        ]);
      if (order === "correction-first") {
        await correct();
        await complete();
      } else {
        await complete();
        await correct();
      }
      const stored = (await db.getTransaction(original!.id))!;
      expect(stored).toMatchObject({
        id: original!.id,
        transactionDate: "2039-01-01",
        amountMinor: -4300,
        presence: "seen",
        annotation,
        lastSeenAt: "2040-07-02T12:00:00.000Z",
        lastSeenRunId: "current",
      });
      expect(stored.sourceAbsence).toBeUndefined();
      expect(await db.getTotals({ connectionId })).toMatchObject({
        includedCount: 2,
        totals: [{ currency: "ILS", amountMinor: -5400 }],
      });
      const cursor = await db.latestEventId();
      await correct();
      await complete();
      expect(await db.getTransaction(original!.id)).toEqual(stored);
      expect(await db.latestEventId()).toBe(cursor);
    },
  );

  it.each([3, 5])(
    "accepts newer positive facts without defeating an applicable negative at day %s",
    async (day) => {
      const input = row("native", {
        transactionDate: "2040-07-01",
        amountMinor: -4300,
      });
      await capture("baseline", 1, [input]);
      const [original] = await db.listTransactions();
      await capture("absent", 5, []);
      await capture("correct", day, [
        { ...input, transactionDate: "2040-07-02", amountMinor: -4700 },
      ]);
      expect(await db.getTransaction(original!.id)).toMatchObject({
        transactionDate: "2040-07-02",
        amountMinor: -4700,
        presence: "not_returned",
        lastSeenRunId: "correct",
        sourceAbsence: { runId: "absent" },
      });
      await capture("older", 2, [
        { ...input, transactionDate: "2039-01-01", amountMinor: -9900 },
      ]);
      expect(await db.getTransaction(original!.id)).toMatchObject({
        transactionDate: "2040-07-02",
        amountMinor: -4700,
        lastSeenRunId: "correct",
        sourceAbsence: { runId: "absent" },
      });
      expect(await db.getTotals({ connectionId })).toMatchObject({
        includedCount: 0,
        totals: [],
      });
    },
  );

  it("keeps actually observed newer facts when an older correction leaves coverage", async () => {
    const input = row("native", {
      transactionDate: "2040-07-01",
      amountMinor: -4300,
    });
    await capture("baseline", 1, [input]);
    const [original] = await db.listTransactions();
    await capture("observed", 5, [input]);
    await capture("older", 3, [{ ...input, transactionDate: "2039-01-01" }]);
    expect(await db.getTransaction(original!.id)).toMatchObject({
      transactionDate: "2040-07-01",
      lastSeenRunId: "observed",
      presence: "seen",
    });
    expect(
      (await db.getTransaction(original!.id))!.sourceAbsence,
    ).toBeUndefined();
  });

  it("reapplies retained coverage after corrected facts leave and reenter its window", async () => {
    const input = row("native", {
      transactionDate: "2040-07-01",
      amountMinor: -4300,
    });
    await capture("baseline", 1, [input]);
    const [original] = await db.listTransactions();
    await capture("absent", 5, []);
    await capture("outside", 3, [{ ...input, transactionDate: "2039-01-01" }]);
    expect(await db.getTotals({ connectionId })).toMatchObject({
      includedCount: 1,
    });
    await capture("inside", 4, [input]);
    const settled = await db.getTransaction(original!.id);
    expect(settled).toMatchObject({
      presence: "not_returned",
      sourceAbsence: { runId: "absent" },
      lastSeenRunId: "inside",
    });
    const cursor = await db.latestEventId();
    await capture("outside", 3, [{ ...input, transactionDate: "2039-01-01" }]);
    await capture("inside", 4, [input]);
    expect(await db.getTransaction(original!.id)).toEqual(settled);
    expect(await db.latestEventId()).toBe(cursor);
    expect(await db.getTotals({ connectionId })).toMatchObject({
      includedCount: 0,
    });
  });

  it("retains another applicable omission when a narrower receipt becomes inapplicable", async () => {
    const input = row("native", {
      transactionDate: "2040-07-01",
      amountMinor: -4300,
    });
    await capture("baseline", 1, [input]);
    const [original] = await db.listTransactions();
    await capture("wide", 4, []);
    await capture("narrow", 5, [], synthetic, {
      kind: "recent",
      from: "2040-06-20",
      to: "2040-07-05",
    });
    expect(
      (await db.getTransaction(original!.id))!.sourceAbsence,
    ).toMatchObject({ runId: "narrow" });
    await capture("correction", 3, [
      { ...input, transactionDate: "2040-06-15" },
    ]);
    expect(await db.getTransaction(original!.id)).toMatchObject({
      transactionDate: "2040-06-15",
      presence: "not_returned",
      sourceAbsence: { runId: "wide" },
    });
    expect(await db.getTotals({ connectionId })).toMatchObject({
      includedCount: 0,
    });
  });

  it("does not erase a negative receipt whose coverage cannot be reconstructed", async () => {
    const input = row("native", {
      transactionDate: "2040-07-01",
      amountMinor: -4300,
    });
    await capture("baseline", 1, [input]);
    const [original] = await db.listTransactions();
    await insertTransactionFixture(
      db,
      [
        {
          ...original!,
          presence: "not_returned",
          sourceAbsence: {
            runId: "unavailable-coverage",
            capturedAt: "2040-07-05T12:00:00.000Z",
          },
        },
      ],
      "update",
    );
    await capture("correction", 3, [
      { ...input, transactionDate: "2039-01-01" },
    ]);
    expect(await db.getTransaction(original!.id)).toMatchObject({
      transactionDate: "2039-01-01",
      lastSeenRunId: "correction",
      presence: "not_returned",
      sourceAbsence: { runId: "unavailable-coverage" },
    });
    expect(await db.getTotals({ connectionId })).toMatchObject({
      includedCount: 0,
    });
    await capture("fresh", 6, [input]);
    expect(
      (await db.getTransaction(original!.id))!.sourceAbsence,
    ).toBeUndefined();
  });

  it.each([
    ["correction-first", 3, true],
    ["snapshot-first", 3, true],
    ["correction-first", 5, true],
    ["snapshot-first", 5, true],
    ["correction-first", 6, false],
    ["snapshot-first", 6, false],
  ] as const)(
    "reconciles native facts entering retained coverage: %s, correction day %s, absent %s",
    async (order, correctionDay, absent) => {
      const input = row("native", {
        transactionDate: "2039-01-01",
        amountMinor: -4300,
      });
      await capture("baseline", 1, [input]);
      const [original] = await db.listTransactions();
      const annotation = await db.editAnnotation({
        transactionId: original!.id,
        expectedVersion: 0,
        notes: "Keep the corrected purchase and its evidence",
      });
      const cursor = await db.latestEventId();
      const correct = () =>
        capture(
          "correction",
          correctionDay,
          [{ ...input, transactionDate: "2040-07-01" }],
          synthetic,
          undefined,
          "synthetic:other-resource",
        );
      const complete = () => capture("complete", 5, []);
      if (order === "correction-first") {
        await correct();
        await complete();
      } else {
        await complete();
        await correct();
      }
      const stored = (await db.getTransaction(original!.id))!;
      expect(stored).toMatchObject({
        id: original!.id,
        sourceKey: "native",
        transactionDate: "2040-07-01",
        amountMinor: -4300,
        kind: "purchase",
        status: "posted",
        presence: absent ? "not_returned" : "seen",
        annotation,
        firstSeenAt: "2040-07-01T12:00:00.000Z",
        lastSeenAt: `2040-07-0${correctionDay}T12:00:00.000Z`,
        lastSeenRunId: "correction",
      });
      expect(stored.sourceAbsence ?? null).toEqual(
        absent
          ? {
              runId: "complete",
              capturedAt: "2040-07-05T12:00:00.000Z",
            }
          : null,
      );
      expect(await db.listTransactions({ presence: "all" })).toHaveLength(1);
      expect(
        (await db.listTransactionPage({ connectionId, limit: 100 }))
          .transactions,
      ).toHaveLength(absent ? 0 : 1);
      for (const presence of [undefined, "all"] as const) {
        expect(
          await db.getTotals({
            connectionId,
            ...(presence ? { presence } : {}),
          }),
        ).toMatchObject({
          includedCount: absent ? 0 : 1,
          totals: absent ? [] : [{ currency: "ILS", amountMinor: -4300 }],
          excluded: { sourceAbsent: absent && presence === "all" ? 1 : 0 },
        });
      }
      expect(
        (await db.listEvents({ after: cursor })).map((event) => event.type),
      ).toEqual(
        absent
          ? ["transaction.updated", "transaction.unlisted"]
          : ["transaction.updated"],
      );
      const settledCursor = await db.latestEventId();
      expect(await correct()).toMatchObject({ replayed: true });
      expect(await complete()).toMatchObject({ replayed: true });
      expect(await db.getTransaction(original!.id)).toEqual(stored);
      expect(await db.latestEventId()).toBe(settledCursor);
    },
  );

  it.each([3, 5])(
    "does not infer omission when the retained snapshot observed the native row outside its window (correction day %s)",
    async (correctionDay) => {
      const input = row("native", { transactionDate: "2039-01-01" });
      await capture("baseline", 1, [input]);
      const [original] = await db.listTransactions();
      await capture("complete-with-positive", 5, [input]);
      const cursor = await db.latestEventId();
      await capture(
        "correction",
        correctionDay,
        [{ ...input, transactionDate: "2040-07-01" }],
        synthetic,
        undefined,
        "synthetic:other-resource",
      );
      const stored = (await db.getTransaction(original!.id))!;
      expect(stored).toMatchObject({
        presence: "seen",
        transactionDate: correctionDay === 3 ? "2039-01-01" : "2040-07-01",
        lastSeenAt: "2040-07-05T12:00:00.000Z",
        lastSeenRunId:
          correctionDay === 3 ? "complete-with-positive" : "correction",
      });
      expect(stored.sourceAbsence ?? null).toBeNull();
      expect(await db.getTotals({ connectionId })).toMatchObject({
        includedCount: 1,
        totals: [{ currency: "ILS", amountMinor: -100 }],
      });
      expect(
        (await db.listEvents({ after: cursor })).map((event) => event.type),
      ).toEqual(correctionDay === 3 ? [] : ["transaction.updated"]);
    },
  );

  it("does not infer a receipt from equal-time positive and coverage when a correction enters the window", async () => {
    const input = row("native", { transactionDate: "2039-01-01" });
    await capture("positive", 5, [input]);
    const [original] = await db.listTransactions();
    await capture("complete", 5, []);
    await capture(
      "correction",
      5,
      [{ ...input, transactionDate: "2040-07-01" }],
      synthetic,
      undefined,
      "synthetic:other-resource",
    );
    const stored = (await db.getTransaction(original!.id))!;
    expect(stored).toMatchObject({
      presence: "seen",
      transactionDate: "2040-07-01",
      lastSeenAt: "2040-07-05T12:00:00.000Z",
      lastSeenRunId: "correction",
    });
    expect(stored.sourceAbsence ?? null).toBeNull();
    expect(await db.getTotals({ connectionId })).toMatchObject({
      includedCount: 1,
      totals: [{ currency: "ILS", amountMinor: -100 }],
    });
  });

  it.each([
    [
      "stale outside coverage",
      1,
      "2039-01-01",
      "not_returned",
      "transaction.imported",
    ],
    [
      "current outside coverage",
      4,
      "2039-01-01",
      "seen",
      "transaction.created",
    ],
    ["current inside coverage", 4, "2040-07-01", "seen", "transaction.created"],
  ] as const)(
    "classifies %s discovery without inventing absence",
    async (_label, day, transactionDate, presence, eventType) => {
      await capture("complete", 3, []);
      const cursor = await db.latestEventId();
      await capture("discovery", day, [
        row("native", { transactionDate, amountMinor: -4300 }),
      ]);
      const [stored] = await db.listTransactions({ presence: "all" });
      expect(stored).toMatchObject({
        presence,
        amountMinor: -4300,
        transactionDate,
      });
      expect(stored!.sourceAbsence ?? null).toBeNull();
      expect(await db.getTotals({ connectionId })).toMatchObject({
        includedCount: 1,
        totals: [{ currency: "ILS", amountMinor: -4300 }],
      });
      expect(
        (await db.listEvents({ after: cursor })).map((event) => event.type),
      ).toEqual([eventType]);
    },
  );

  it.each([
    ["older", 2, false],
    ["newer omission", 4, true],
    ["equal-time", 3, false],
  ] as const)(
    "keeps %s positive evidence from another resource behind the absence high-water",
    async (_label, positiveDay, repeatAbsence) => {
      const input = row("native", { amountMinor: -7300 });
      await capture("positive-one", 1, [input]);
      const [original] = await db.listTransactions();
      const annotation = await db.editAnnotation({
        transactionId: original!.id,
        expectedVersion: 0,
        notes: "Preserve despite delayed arrivals",
      });
      await capture("absent-three", 3, []);
      const cursor = await db.latestEventId();
      const version = (await db.getTransaction(original!.id))!.version;
      if (repeatAbsence) {
        expect(await capture("absent-five", 5, [])).toMatchObject({
          unlisted: 0,
          updated: 0,
        });
        expect(await db.latestEventId()).toBe(cursor);
        expect((await db.getTransaction(original!.id))!.version).toBe(version);
      }
      await capture(
        "delayed-positive",
        positiveDay,
        [input],
        synthetic,
        undefined,
        "synthetic:other-resource",
      );
      expect(await db.getTransaction(original!.id)).toMatchObject({
        presence: "not_returned",
        version,
        annotation,
        sourceAbsence: {
          runId: repeatAbsence ? "absent-five" : "absent-three",
          capturedAt: repeatAbsence
            ? "2040-07-05T12:00:00.000Z"
            : "2040-07-03T12:00:00.000Z",
        },
      });
      expect(
        (await db.listTransactionPage({ connectionId, limit: 100 }))
          .transactions,
      ).toEqual([]);
      expect(
        await db.getTotals({ connectionId, presence: "all" }),
      ).toMatchObject({
        totals: [],
        includedCount: 0,
        excluded: { sourceAbsent: 1 },
      });
      expect(await db.latestEventId()).toBe(cursor);
      await capture(
        "strictly-new-positive",
        6,
        [input],
        synthetic,
        undefined,
        "synthetic:other-resource",
      );
      expect(await db.getTransaction(original!.id)).toMatchObject({
        presence: "seen",
        version: version + 1,
        annotation,
      });
      expect(
        (await db.getTransaction(original!.id))!.sourceAbsence ?? null,
      ).toBeNull();
      expect(await db.getTotals({ connectionId })).toMatchObject({
        includedCount: 1,
        totals: [{ amountMinor: -7300 }],
      });
    },
  );

  it.each(["positive-first", "absence-first"] as const)(
    "lets equal-time omission win independent of arrival order: %s",
    async (order) => {
      const input = row("native");
      await capture("baseline", 1, [input]);
      const positive = () =>
        capture(
          "positive-tie",
          3,
          [input],
          synthetic,
          undefined,
          "synthetic:other-resource",
        );
      const absent = () => capture("absence-tie", 3, []);
      if (order === "positive-first") {
        await positive();
        await absent();
      } else {
        await absent();
        await positive();
      }
      const [stored] = await db.listTransactions({ presence: "all" });
      expect(stored).toMatchObject({
        presence: "not_returned",
        sourceAbsence: {
          runId: "absence-tie",
          capturedAt: "2040-07-03T12:00:00.000Z",
        },
      });
      expect(
        (await db.listTransactionPage({ connectionId, limit: 100 }))
          .transactions,
      ).toEqual([]);
      expect(await db.getTotals({ connectionId })).toMatchObject({
        totals: [],
        includedCount: 0,
      });
    },
  );

  it("requires new evidence to confirm a legacy not_returned row, and versions that evidence only once", async () => {
    await capture("legacy-baseline", 1, [row("legacy")]);
    const [original] = await db.listTransactions();
    await insertTransactionFixture(
      db,
      [{ ...original!, presence: "not_returned", sourceAbsence: undefined }],
      "update",
    );
    const annotation = await db.editAnnotation({
      transactionId: original!.id,
      expectedVersion: 0,
      notes: "Legacy owner note",
    });
    expect(
      (await db.listTransactionPage({ connectionId, limit: 100 })).transactions,
    ).toMatchObject([{ id: original!.id }]);
    expect(await db.getTotals({ connectionId })).toMatchObject({
      includedCount: 1,
      totals: [{ amountMinor: -100 }],
    });
    const cursor = await db.latestEventId();
    expect(await capture("confirmed-absent", 2, [])).toMatchObject({
      unlisted: 1,
      created: 0,
    });
    const absent = (await db.getTransaction(original!.id))!;
    expect(absent).toMatchObject({
      presence: "not_returned",
      version: original!.version + 1,
      annotation,
      sourceAbsence: {
        runId: "confirmed-absent",
        capturedAt: "2040-07-02T12:00:00.000Z",
      },
    });
    expect(
      (await db.listEvents({ after: cursor })).map((event) => event.type),
    ).toEqual(["transaction.unlisted"]);
    expect(
      (await db.listTransactionPage({ connectionId, limit: 100 })).transactions,
    ).toEqual([]);
    expect(await db.getTotals({ connectionId, presence: "all" })).toMatchObject(
      { includedCount: 0, totals: [], excluded: { sourceAbsent: 1 } },
    );
    const absenceCursor = await db.latestEventId();
    expect(await capture("confirmed-again", 3, [])).toMatchObject({
      unlisted: 0,
    });
    expect(await db.getTransaction(original!.id)).toMatchObject({
      ...absent,
      sourceAbsence: {
        runId: "confirmed-again",
        capturedAt: "2040-07-03T12:00:00.000Z",
      },
    });
    expect(await db.latestEventId()).toBe(absenceCursor);
    await capture("legacy-restored", 4, [row("legacy")]);
    expect(await db.getTransaction(original!.id)).toMatchObject({
      presence: "seen",
      annotation,
      version: original!.version + 2,
    });
    expect(
      (await db.getTransaction(original!.id))!.sourceAbsence ?? null,
    ).toBeNull();
    expect(await db.getTotals({ connectionId })).toMatchObject({
      includedCount: 1,
      totals: [{ amountMinor: -100 }],
    });
  });

  it.each([
    "stale",
    "history",
    "failed partition",
    "noncomparable partition",
    "other resource",
    "filtered scope",
  ] as const)(
    "does not turn %s omission into absence or remove current spending",
    async (mode) => {
      await capture("baseline", 3, [row("posted"), authorization("pending")]);
      const before = await db.listTransactions();
      const totals = await db.getTotals({ connectionId });
      const adapter: SourceAdapter = {
        ...synthetic,
        extract(text, context) {
          const result = synthetic.extract(text, context);
          if (mode === "history") {
            result.historical = true;
          }
          if (
            mode === "failed partition" ||
            mode === "noncomparable partition"
          ) {
            result.partitions = result.partitions.map((part) => ({
              ...part,
              success: mode !== "failed partition",
              comparable: false,
            }));
          }
          return result;
        },
      };
      await capture(
        "omission",
        mode === "stale" ? 2 : 4,
        [],
        adapter,
        mode === "history"
          ? { kind: "history" }
          : mode === "filtered scope"
            ? { kind: "recent", cardKey: "other-card" }
            : undefined,
        mode === "other resource" ? "synthetic:other" : "synthetic:presence",
      );
      expect(await db.listTransactions()).toEqual(before);
      expect(
        (await db.listTransactionPage({ connectionId, limit: 100 }))
          .transactions,
      ).toHaveLength(2);
      expect(await db.getTotals({ connectionId })).toEqual(totals);
    },
  );

  it("changes only the successful comparable partition during partial extraction", async () => {
    await capture("baseline", 1, [row("posted"), authorization("pending")]);
    const partial: SourceAdapter = {
      ...synthetic,
      extract(text, context) {
        const result = synthetic.extract(text, context);
        result.partitions = result.partitions.map((part) =>
          part.status === "posted"
            ? { ...part, success: false, comparable: false }
            : part,
        );
        return result;
      },
    };
    expect(await capture("partial", 2, [], partial)).toMatchObject({
      status: "partial",
      unlisted: 1,
    });
    expect(
      (await db.listTransactionPage({ connectionId, limit: 100 })).transactions,
    ).toMatchObject([{ status: "posted", presence: "seen" }]);
    expect(await db.getTotals({ connectionId, presence: "all" })).toMatchObject(
      {
        includedCount: 1,
        totals: [{ amountMinor: -100 }],
        excluded: { sourceAbsent: 1, pending: 0 },
      },
    );
  });

  it("does not let a linked pending alias keep an omitted posted survivor current", async () => {
    const harness = postingHarness(db);
    await db.ensureConnection({ id: harness.connectionId, provider: "cal" });
    const pending = authorization("pending");
    const posted = row("posted");
    const sentinel = row("sentinel", {
      amountMinor: -900,
      merchantName: "Unrelated purchase",
    });
    await harness.capture(1, [pending, sentinel]);
    const original = await harness.byKey("pending");
    const annotation = await db.editAnnotation({
      transactionId: original.id,
      expectedVersion: 0,
      notes: "Preserve after posting and disappearance",
    });
    await harness.capture(2, [posted, sentinel]);
    const survivor = await harness.byKey("posted");
    expect(survivor.id).toBe(original.id);
    expect(survivor.details.postingLink!.pending.sourceAbsence).toEqual({
      runId: "posting-2",
      capturedAt: "2040-07-02T12:00:00.000Z",
    });
    await harness.capture(3, [pending, sentinel]);
    expect(await db.getTransaction(survivor.id)).toMatchObject({
      status: "posted",
      presence: "not_returned",
      sourceAbsence: {
        runId: "posting-3",
        capturedAt: "2040-07-03T12:00:00.000Z",
      },
      annotation,
    });
    expect(
      (
        await db.listTransactionPage({
          connectionId: harness.connectionId,
          limit: 100,
        })
      ).transactions,
    ).toMatchObject([{ id: (await harness.byKey("sentinel")).id }]);
    expect(
      await db.getTotals({
        connectionId: harness.connectionId,
        presence: "all",
      }),
    ).toMatchObject({
      totals: [{ amountMinor: -900 }],
      includedCount: 1,
      excluded: { sourceAbsent: 1 },
    });
    await harness.capture(4, [posted, sentinel], postingAdapter);
    expect(await db.getTransaction(survivor.id)).toMatchObject({
      presence: "seen",
      annotation,
    });
    expect(
      await db.getTotals({ connectionId: harness.connectionId }),
    ).toMatchObject({ totals: [{ amountMinor: -1000 }], includedCount: 2 });
    expect(
      (await db.getTransaction(survivor.id))!.sourceAbsence ?? null,
    ).toBeNull();
    const split = await db.unlinkPendingTransaction(
      await harness.command(
        survivor.id,
        survivor.details.postingLink!.postedId,
      ),
    );
    expect(split.pending).toMatchObject({
      presence: "not_returned",
      sourceAbsence: {
        runId: "posting-4",
        capturedAt: "2040-07-04T12:00:00.000Z",
      },
    });
    expect(split.posted).toMatchObject({ presence: "seen" });
    expect(split.posted.sourceAbsence ?? null).toBeNull();
    expect(
      (
        await db.listTransactionPage({
          connectionId: harness.connectionId,
          limit: 100,
        })
      ).transactions
        .map((item) => item.id)
        .sort(),
    ).toEqual([split.posted.id, (await harness.byKey("sentinel")).id].sort());
    expect(
      await db.getTotals({
        connectionId: harness.connectionId,
        presence: "all",
      }),
    ).toMatchObject({
      totals: [{ amountMinor: -1000 }],
      includedCount: 2,
      excluded: { sourceAbsent: 1 },
    });
  });

  it("does not leak absence evidence across manual linking or splitting independently seen components", async () => {
    const harness = postingHarness(db);
    await db.ensureConnection({ id: harness.connectionId, provider: "cal" });
    const pending = authorization("pending");
    const posted = row("posted");
    const sentinel = row("sentinel", {
      amountMinor: -900,
      merchantName: "Unrelated purchase",
    });
    await harness.capture(1, [pending, sentinel], synthetic);
    const original = await harness.byKey("pending");
    const annotation = await db.editAnnotation({
      transactionId: original.id,
      expectedVersion: 0,
      notes: "Keep component history distinct",
    });
    await harness.capture(2, [posted, sentinel], synthetic);
    const absentPending = await harness.byKey("pending");
    expect(absentPending.sourceAbsence).toEqual({
      runId: "posting-2",
      capturedAt: "2040-07-02T12:00:00.000Z",
    });
    const postedBefore = await harness.byKey("posted");
    const survivor = await db.linkPendingTransaction(
      await harness.command(original.id, postedBefore.id),
    );
    expect(await db.getTransaction(survivor.id)).toMatchObject({
      presence: "seen",
      status: "posted",
      annotation,
    });
    expect(survivor.sourceAbsence ?? null).toBeNull();
    expect(survivor.details.postingLink!.pending.sourceAbsence).toEqual(
      absentPending.sourceAbsence,
    );
    expect(
      await db.getTotals({ connectionId: harness.connectionId }),
    ).toMatchObject({ includedCount: 2, totals: [{ amountMinor: -1000 }] });
    await harness.capture(3, [pending, sentinel], synthetic);
    const missingPosted = (await db.getTransaction(survivor.id))!;
    expect(missingPosted.sourceAbsence).toEqual({
      runId: "posting-3",
      capturedAt: "2040-07-03T12:00:00.000Z",
    });
    expect(missingPosted.details.postingLink!.pending.presence).toBe("seen");
    expect(
      missingPosted.details.postingLink!.pending.sourceAbsence ?? null,
    ).toBeNull();
    const split = await db.unlinkPendingTransaction(
      await harness.command(survivor.id, postedBefore.id),
    );
    expect(await db.getTransaction(split.pending.id)).toMatchObject({
      presence: "seen",
      status: "pending",
      annotation,
    });
    expect(split.pending.sourceAbsence ?? null).toBeNull();
    expect(split.posted).toMatchObject({
      presence: "not_returned",
      sourceAbsence: missingPosted.sourceAbsence,
    });
    expect(
      (
        await db.listTransactionPage({
          connectionId: harness.connectionId,
          limit: 100,
        })
      ).transactions
        .map((item) => item.id)
        .sort(),
    ).toEqual([split.pending.id, (await harness.byKey("sentinel")).id].sort());
    expect(
      await db.getTotals({
        connectionId: harness.connectionId,
        presence: "all",
      }),
    ).toMatchObject({
      includedCount: 1,
      totals: [{ amountMinor: -900 }],
      excluded: { pending: 1, sourceAbsent: 1 },
    });
  });

  it("does not auto-link a delayed narrow posting contradicted by a newer complete posted snapshot", async () => {
    const adapter: SourceAdapter = {
      ...postingAdapter,
      sourceCoverage: synthetic.sourceCoverage!,
    };
    const pending = authorization("pending");
    await capture("pending-one", 1, [pending], adapter);
    const [original] = await db.listTransactions();
    const annotation = await db.editAnnotation({
      transactionId: original!.id,
      expectedVersion: 0,
      notes: "Do not transfer to contradicted posting",
    });
    const postedOnly: SourceAdapter = {
      ...adapter,
      extract(text, context) {
        const result = adapter.extract(text, context);
        result.partitions = result.partitions.map((partition) =>
          partition.status === "pending"
            ? { ...partition, success: false, comparable: false }
            : partition,
        );
        return result;
      },
    };
    expect(
      await capture("posted-complete-five", 5, [], postedOnly),
    ).toMatchObject({ status: "partial", unlisted: 0 });
    expect(await db.getTransaction(original!.id)).toMatchObject({
      presence: "seen",
      status: "pending",
      annotation,
    });
    const delayed = () =>
      capture("delayed-three", 3, [row("posted")], adapter, {
        kind: "recent",
        cardKey: "card",
      });
    await delayed();
    const rows = await db.listTransactions({ presence: "all" });
    expect(rows).toHaveLength(2);
    const posted = rows.find((item) => item.sourceKey === "posted")!;
    expect(posted).toMatchObject({
      status: "posted",
      presence: "not_returned",
      supersededById: null,
      sourceAbsence: {
        runId: "posted-complete-five",
        capturedAt: "2040-07-05T12:00:00.000Z",
      },
    });
    expect(await db.getTransaction(original!.id)).toMatchObject({
      status: "pending",
      annotation,
      supersededById: null,
    });
    expect(
      (await db.listEvents()).filter(
        (event) => event.type === "transaction.linked",
      ),
    ).toEqual([]);
    expect(await db.getTotals({ connectionId, presence: "all" })).toMatchObject(
      { totals: [], includedCount: 0 },
    );
    const current = await db.listTransactionPage({ connectionId, limit: 100 });
    expect(current.transactions.some((item) => item.id === posted.id)).toBe(
      false,
    );
    const events = await db.listEvents();
    expect(await delayed()).toMatchObject({ replayed: true });
    expect(await db.listTransactions({ presence: "all" })).toEqual(rows);
    expect(await db.listEvents()).toEqual(events);
  });

  it("keeps Isracard posted omissions current because its posted windows are not comparable", async () => {
    const source = JSON.parse(
      readFileSync(
        new URL(
          "../providers/isracard/fixtures/card-month.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as IsracardCapture;
    const accountKey = isracardCardKey(source.card);
    const id = "synthetic-isracard-presence";
    await db.ensureConnection({ id, provider: "isracard" });
    const ingest = (day: number) =>
      db.ingestRun(
        {
          connectionId: id,
          runId: `isracard-${day}`,
          responses: [
            {
              accountKey,
              endpoint: "synthetic:isracard/card-month",
              capturedAt: `2040-07-0${day}T12:00:00Z`,
              responseText: serializeIsracardCapture(source),
              scope: {
                kind: "recent",
                month: source.billingMonth,
                cardKey: accountKey,
              },
            },
          ],
        },
        isracardAdapter,
      );
    await ingest(1);
    const before = await db.listTransactions({ connectionId: id });
    expect(before.length).toBeGreaterThan(0);
    const totals = await db.getTotals({ connectionId: id });
    const digital = JSON.parse(source.responses.digital!);
    digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList = [];
    source.responses.digital = JSON.stringify(digital);
    const legacy = JSON.parse(source.responses.legacy!);
    legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0].txnIsrael =
      [];
    source.responses.legacy = JSON.stringify(legacy);
    source.responses.details = [];
    const extracted = isracardAdapter.extract(
      serializeIsracardCapture(source),
      {
        accountKey,
        runId: "inspect",
        scope: {
          kind: "recent",
          month: source.billingMonth,
          cardKey: accountKey,
        },
      },
    );
    expect(extracted.transactions).toEqual([]);
    expect(
      extracted.partitions.find((part) => part.status === "posted"),
    ).toMatchObject({ success: true, comparable: false });
    expect(await ingest(2)).toMatchObject({ unlisted: 0 });
    expect(await db.listTransactions({ connectionId: id })).toEqual(before);
    expect(await db.getTotals({ connectionId: id })).toEqual(totals);
  });
});
