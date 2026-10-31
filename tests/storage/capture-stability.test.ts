import "../helpers/run-history-differential.js";

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import { syncRunBodies, syncRuns } from "../../src/storage/sqlite/schema.js";

type SourceRow = Record<string, unknown>;

const fixture = JSON.parse(
  readFileSync(
    new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
    "utf8",
  ),
);
const installment: SourceRow = fixture.result.transactions.find(
  (row: SourceRow) => row.trnIntId === "SYNTHETIC-TXN-INSTALLMENTS",
);
const regular: SourceRow = fixture.result.transactions.find(
  (row: SourceRow) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
);

describe("bounded canonical state and capture-independent installment purchases", () => {
  let db: Database;
  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.ensureConnection({ id: "synthetic-cal", provider: "cal" });
  });
  afterEach(() => db.close());

  async function capture(
    runId: string,
    rows: SourceRow[],
    day: number,
    adapter: SourceAdapter = calAdapter,
    debugArchiveDays?: number,
  ) {
    return db.ingestRun(
      {
        connectionId: "synthetic-cal",
        runId,
        ...(debugArchiveDays !== undefined && { debugArchiveDays }),
        responses: [
          {
            accountKey: "synthetic-account",
            endpoint: "synthetic:cal/recent",
            capturedAt: `2040-06-${String(day).padStart(2, "0")}T00:00:00Z`,
            responseText: JSON.stringify({
              statusCode: 1,
              result: { transactions: rows, clearanceRequests: [] },
            }),
          },
        ],
      },
      adapter,
    );
  }

  it("versions newly retained component evidence once without changing commitment money or stale annotations", async () => {
    const first = {
      ...installment,
      curPaymentNum: 1,
      debCrdDate: "2040-06-10T00:00:00",
    };
    const second = {
      ...installment,
      curPaymentNum: 2,
      debCrdDate: "2040-07-10T00:00:00",
    };
    await capture("one", [first], 1);
    const before = (await db.listTransactions()).find(
      (row) => row.amountBasis === "purchase_commitment",
    )!;
    await db.editAnnotation({
      transactionId: before.id,
      expectedVersion: 0,
      expectedTransactionVersion: 1,
      review: { status: "approved" },
    });
    const original = (await db.getTransaction(before.id))!;
    const changes = await db.listEvents();
    const totals = await db.getTotals();
    await capture("many", [first, second], 2);
    await capture("one-again", [second], 3);
    await capture("first-again", [first], 4);
    const after = (await db.getTransaction(before.id))!;
    // Purchases carry no billed-line ordinal.
    expect(after.installmentNumber).toBeNull();
    expect(after).toMatchObject({
      version: 2,
      amountMinor: before.amountMinor,
      billingDate: null,
      installmentCount: 12,
      reviewStale: false,
      annotation: original.annotation,
    });
    expect(after.details.sourceRefs.map((ref) => ref.runId)).toEqual([
      "first-again",
    ]);
    // Each payment is its own billed line; a line missing from a recent window
    // is non-comparable, so it stays seen.
    const lines = (await db.listTransactions()).filter(
      (row) => row.purchaseId === before.id,
    );
    expect(
      lines
        .map((row) => [row.installmentNumber, row.billingDate, row.presence])
        .sort(),
    ).toEqual([
      [1, "2040-06-10", "seen"],
      [2, "2040-07-10", "seen"],
    ]);
    const secondLine = lines.find((row) => row.installmentNumber === 2)!;
    expect(
      (await db.listEvents())
        .slice(changes.length)
        .map((event) => [event.type, event.transactionId]),
    ).toEqual([
      ["transaction.created", secondLine.id],
      ["transaction.updated", before.id],
    ]);
    const commitments = (result: Awaited<ReturnType<typeof db.getTotals>>) =>
      result.totals.filter(
        (group) => group.amountBasis === "purchase_commitment",
      );
    expect(commitments(await db.getTotals())).toEqual(commitments(totals));

    await capture(
      "corrected",
      [{ ...second, amountForDisplay: 1300, trnAmt: 1300, numOfPayments: 13 }],
      5,
    );
    expect(await db.getTransaction(before.id)).toMatchObject({
      version: 3,
      amountMinor: -130000,
      installmentCount: 13,
      reviewStale: true,
    });
    expect(
      (await db.listEvents()).some(
        (change) => change.type === "transaction.updated",
      ),
    ).toBe(true);
  });

  it("rejects oversized canonical source fields through partial collection while retaining exact raw evidence", async () => {
    await capture("valid", [regular], 1);
    const before = (await db.listTransactions())[0]!;
    const oversized = "x".repeat(4097);
    const result = await capture(
      "oversized",
      [{ ...regular, merchantName: oversized }],
      2,
      calAdapter,
      2,
    );
    expect(result.status).toBe("partial");
    expect(await db.getTransaction(before.id)).toMatchObject({
      version: 1,
      presence: "seen",
      merchantName: before.merchantName,
    });
    const runs = await db.orm.select().from(syncRuns).all();
    expect(runs.find((run) => run.id === "oversized")!.warnings).toContain(
      "invalid_extracted_posted_row",
    );
    expect(
      (await db.orm.select().from(syncRunBodies).all()).find(
        (run) => run.runId === "oversized",
      )!.snapshot.responses[0]!.responseText,
    ).toContain(oversized);
  });

  it("quarantines an adapter's empty canonical card identifier and preserves its captured source", async () => {
    const adapter: SourceAdapter = {
      ...calAdapter,
      extract: (...args) => {
        const result = calAdapter.extract(...args);
        return {
          ...result,
          transactions: result.transactions.map((row) => ({
            ...row,
            cardKey: "",
          })),
        };
      },
    };
    expect(await capture("empty-card", [regular], 1, adapter, 2)).toMatchObject(
      {
        status: "partial",
        created: 0,
      },
    );
    expect(await db.listTransactions()).toEqual([]);
    const run = (await db.orm.select().from(syncRuns).all())[0]!;
    expect(run.warnings).toContain("invalid_extracted_posted_row");
    expect(
      JSON.parse(
        (await db.orm.select().from(syncRunBodies).get())!.snapshot
          .responses[0]!.responseText,
      ).result.transactions,
    ).toEqual([regular]);
  });

  it("rejects oversized run identifiers before archiving or changing financial state", async () => {
    await expect(capture("r".repeat(1025), [regular], 1)).rejects.toThrow();
    expect(await db.orm.select().from(syncRuns).all()).toEqual([]);
    expect(await db.listTransactions()).toEqual([]);
    expect(await db.listEvents()).toEqual([]);
  });

  it("versions genuine noninstallment purchase billing-date corrections", async () => {
    await capture("before", [regular], 1);
    const original = (await db.listTransactions())[0]!;
    await capture(
      "after",
      [{ ...regular, debCrdDate: "2040-07-10T00:00:00" }],
      2,
    );
    expect(await db.getTransaction(original.id)).toMatchObject({
      version: 2,
      billingDate: "2040-07-10",
    });
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.updated",
      ),
    ).toMatchObject([
      {
        transactionId: original.id,
        before: { billingDate: original.billingDate },
        after: { billingDate: "2040-07-10" },
      },
    ]);
  });

  it("rejects unreadable annotation edits atomically and retains existing annotation/feed versions", async () => {
    await capture("valid", [regular], 1);
    const row = (await db.listTransactions())[0]!;
    const annotation = await db.editAnnotation({
      transactionId: row.id,
      expectedVersion: 0,
      notes: "Retain this note",
      tags: ["kept"],
    });
    const changes = await db.listEvents();
    for (const patch of [
      { tags: Array.from({ length: 51 }, (_, index) => `tag-${index}`) },
      { category: "x".repeat(101) },
      { category: "   " },
      { tags: ["x".repeat(101)] },
      { tags: [" "] },
      { metadata: { content: "x".repeat(65536) } },
    ]) {
      await expect(
        db.editAnnotation({
          transactionId: row.id,
          expectedVersion: 1,
          ...patch,
        }),
      ).rejects.toThrow();
      expect((await db.getTransaction(row.id))!.annotation).toEqual(annotation);
      expect(await db.listEvents()).toEqual(changes);
    }
  });
});
