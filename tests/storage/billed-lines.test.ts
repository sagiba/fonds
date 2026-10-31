import "../helpers/run-history-differential.js";

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  presentWireEvent,
  presentWireTransaction,
} from "../../src/application/wire-output.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import { syncRuns } from "../../src/storage/sqlite/schema.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

type SourceRow = Record<string, unknown>;

// Invented plans: a three-payment plan whose first payment absorbs rounding,
// a USD plan billed in ILS, and a two-component installment cancellation.
const plans = (): SourceRow[] =>
  JSON.parse(
    readFileSync(
      new URL(
        "../providers/cal/fixtures/installment-plans.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).result.transactions;
const connectionId = "synthetic-plans";
const card = "SYNTHETIC-CARD-A";
const purchaseKey = (native: string) =>
  `cal:posted:purchase:${JSON.stringify([card, native])}`;
const lineKey = (native: string, ordinal: number) =>
  `cal:posted:line:${JSON.stringify([card, native, ordinal])}`;
const rounding = "SYNTHETIC-TXN-PLAN-ROUNDING";

function payments(native: string, ...ordinals: number[]) {
  return plans().filter(
    (source) =>
      source.trnIntId === native &&
      (ordinals.length === 0 ||
        ordinals.includes(source.curPaymentNum as number)),
  );
}

describe.each(backends)("%s billed lines", (backend) => {
  let db: Harness;
  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(() => db.close());

  function capture(rows: SourceRow[], day: number) {
    return db.ingestRun(
      {
        connectionId,
        runId: `plans-${day}`,
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
      calAdapter,
    );
  }

  async function byKey(sourceKey: string) {
    const rows = (await db.listTransactions()).filter(
      (item) => item.sourceKey === sourceKey,
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it("links each payment to one purchase whose first payment absorbs rounding", async () => {
    await capture(plans(), 1);
    const purchase = await byKey(purchaseKey(rounding));
    expect(purchase).toMatchObject({
      amountBasis: "purchase_commitment",
      amountMinor: -10000,
      installmentCount: 3,
      installmentNumber: null,
      purchaseId: null,
      billingDate: null,
    });
    const lines = await Promise.all(
      [1, 2, 3].map((ordinal) => byKey(lineKey(rounding, ordinal))),
    );
    expect(
      lines.map((line) => ({
        purchaseId: line.purchaseId,
        amountBasis: line.amountBasis,
        status: line.status,
        kind: line.kind,
        amountMinor: line.amountMinor,
        billingDate: line.billingDate,
        transactionDate: line.transactionDate,
        installmentCount: line.installmentCount,
        installmentNumber: line.installmentNumber,
        merchantName: line.merchantName,
        merchantCategoryCode: line.merchantCategoryCode,
        reviewRequired: line.reviewRequired,
      })),
    ).toEqual(
      [
        [-3334, "2040-06-10"],
        [-3333, "2040-07-10"],
        [-3333, "2040-08-10"],
      ].map(([amountMinor, billingDate], index) => ({
        purchaseId: purchase.id,
        amountBasis: "booked_entry",
        status: "posted",
        kind: "purchase",
        amountMinor,
        billingDate,
        transactionDate: purchase.transactionDate,
        installmentCount: 3,
        installmentNumber: index + 1,
        merchantName: purchase.merchantName,
        merchantCategoryCode: purchase.merchantCategoryCode,
        reviewRequired: false,
      })),
    );
    expect(presentWireTransaction(lines[0]!)).toMatchObject({
      purchaseId: purchase.id,
      installmentCount: 3,
      installmentNumber: 1,
      amount: { currency: "ILS", amount: "-33.34" },
    });
    // The payments sum exactly to the stated total; nothing multiplies it.
    expect(lines.reduce((sum, line) => sum + line.amountMinor!, 0)).toBe(
      purchase.amountMinor,
    );
  });

  it("flags converted plans and keeps a cancellation one refund per capture", async () => {
    await capture(plans(), 1);
    const converted = "SYNTHETIC-TXN-PLAN-CONVERTED";
    for (const sourceKey of [purchaseKey(converted), lineKey(converted, 1)]) {
      const item = await byKey(sourceKey);
      expect(item.sourceIssues).toContain("unverified_converted_installments");
      expect(item.reviewRequired).toBe(true);
    }
    expect(await byKey(purchaseKey(converted))).toMatchObject({
      amountMinor: -37000,
      originalAmountMinor: -10000,
      originalCurrency: "USD",
    });
    expect(await byKey(lineKey(converted, 1))).toMatchObject({
      amountMinor: -18500,
      currency: "ILS",
      originalAmountMinor: null,
    });

    const cancellation = "SYNTHETIC-TXN-PLAN-CANCEL";
    const refund = await byKey(purchaseKey(cancellation));
    expect(refund).toMatchObject({
      kind: "refund",
      amountMinor: 10000,
      installmentCount: null,
      installmentNumber: null,
      purchaseId: null,
      billingDate: null,
    });
    expect(
      (await db.listTransactions()).filter(
        (item) => item.purchaseId === refund.id,
      ),
    ).toEqual([]);
    // Components are summed within the current capture only.
    await capture(payments(cancellation, 2), 2);
    expect(await db.getTransaction(refund.id)).toMatchObject({
      amountMinor: 4000,
      version: 2,
    });
  });

  it("versions a corrected line and names the changed fields", async () => {
    await capture(payments(rounding), 1);
    const before = await byKey(lineKey(rounding, 2));
    const corrected = payments(rounding).map((source) =>
      source.curPaymentNum === 2
        ? {
            ...source,
            amtBeforeConvAndIndex: 33.35,
            debCrdDate: "2040-07-12T00:00:00",
          }
        : source,
    );
    expect(await capture(corrected, 2)).toMatchObject({
      created: 0,
      updated: 2,
    });
    expect(await db.getTransaction(before.id)).toMatchObject({
      version: 2,
      amountMinor: -3335,
      billingDate: "2040-07-12",
      purchaseId: before.purchaseId,
    });
    const updates = (await db.listEvents()).filter(
      (event) =>
        event.type === "transaction.updated" &&
        event.transactionId === before.id,
    );
    expect(
      updates.map((event) => presentWireEvent(event).changedFields),
    ).toEqual([["amount", "billingDate", "evidence"]]);
    expect(
      (await db.listEvents())
        .filter(
          (event) =>
            event.type === "transaction.updated" &&
            event.transactionId === before.purchaseId,
        )
        .map(presentWireEvent)
        .map((event) => event.changedFields),
    ).toEqual([["evidence"]]);
  });

  it("keeps duplicate ordinals as ambiguous occurrences outside totals", async () => {
    const [first, second] = payments(rounding, 1, 2);
    await capture(
      [first!, second!, { ...second!, amtBeforeConvAndIndex: 33.32 }],
      1,
    );
    const occurrences = (await db.listTransactions()).filter((item) =>
      item.sourceKey.startsWith(`${lineKey(rounding, 2)}:occurrence:`),
    );
    expect(
      occurrences.map((item) => [item.identityStrength, item.amountMinor]),
    ).toEqual(
      expect.arrayContaining([
        ["ambiguous", -3333],
        ["ambiguous", -3332],
      ]),
    );
    for (const item of occurrences) {
      expect(item.reviewRequired).toBe(true);
      expect(item.sourceIssues).toContain("ambiguous_source_identity");
    }
    expect((await byKey(purchaseKey(rounding))).identityStrength).toBe(
      "native",
    );
    expect((await byKey(lineKey(rounding, 1))).identityStrength).toBe("native");
    expect(
      (await db.getTotals({ perspective: "billing" })).excluded.unresolved,
    ).toBe(2);
  });

  it("builds the purchase from a mid-plan window and adds earlier lines later", async () => {
    await capture(payments(rounding, 2), 1);
    const purchase = await byKey(purchaseKey(rounding));
    expect(purchase).toMatchObject({ amountMinor: -10000, version: 1 });
    await capture(payments(rounding, 1, 3), 2);
    expect(await db.getTransaction(purchase.id)).toMatchObject({
      amountMinor: -10000,
      version: 2,
    });
    expect(await capture(payments(rounding, 2), 3)).toMatchObject({
      created: 0,
      updated: 0,
    });
    expect((await db.getTransaction(purchase.id))!.version).toBe(2);
    const lines = (await db.listTransactions()).filter(
      (item) => item.purchaseId === purchase.id,
    );
    // Line 2 was not returned by the later window but stays seen.
    expect(
      lines.map((line) => [line.installmentNumber, line.presence]).sort(),
    ).toEqual([
      [1, "seen"],
      [2, "seen"],
      [3, "seen"],
    ]);
  });

  it("never counts a plan purchase and its lines together when a capture restates the plan", async () => {
    const totals = async () => ({
      spending: (await db.getTotals()).totals,
      billing: (await db.getTotals({ perspective: "billing" })).totals,
    });
    const once = {
      spending: [
        {
          currency: "ILS",
          amountBasis: "purchase_commitment",
          amountMinor: -10000,
        },
      ],
      billing: [{ currency: "ILS", amountBasis: null, amountMinor: -10000 }],
    };
    await capture(payments(rounding), 1);
    const purchase = await byKey(purchaseKey(rounding));
    expect(await totals()).toEqual(once);

    // Plan -> single: the capture contradicts the live lines.
    const single = payments(rounding, 1).map((source) => ({
      ...source,
      numOfPayments: 1,
      amtBeforeConvAndIndex: 100,
    }));
    await capture(single, 2);
    expect(await totals()).toEqual(once);
    const conflicted = (await db.getTransaction(purchase.id))!;
    expect(conflicted).toMatchObject({
      installmentCount: 3,
      billingDate: null,
      version: 2,
      reviewRequired: true,
    });
    expect(conflicted.sourceIssues).toContain("conflicting_installment_plan");
    // Absence alone never removes lines.
    const lines = (await db.listTransactions()).filter(
      (item) => item.purchaseId === purchase.id,
    );
    expect(lines.map((line) => line.presence)).toEqual([
      "seen",
      "seen",
      "seen",
    ]);

    // The owner resolves it by removing the lines; the single charge applies.
    for (const line of lines) {
      await db.confirmRemoval({
        transactionId: line.id,
        expectedVersion: line.version,
        reason: "Billed once",
      });
    }
    await capture(single, 3);
    const resolved = (await db.getTransaction(purchase.id))!;
    expect(resolved).toMatchObject({
      installmentCount: 1,
      billingDate: "2040-06-10",
      version: 3,
    });
    expect(resolved.sourceIssues).not.toContain("conflicting_installment_plan");
    expect(await totals()).toEqual(once);

    // Single -> plan: the purchase leaves billing as its lines return.
    await capture(payments(rounding), 4);
    expect(await db.getTransaction(purchase.id)).toMatchObject({
      installmentCount: 3,
      billingDate: null,
    });
    expect(await totals()).toEqual(once);
  });

  it("corrects a purchase whose later rows state another total", async () => {
    await capture(payments(rounding), 1);
    const purchase = await byKey(purchaseKey(rounding));
    await capture(
      payments(rounding).map((source) => ({
        ...source,
        amountForDisplay: 100.01,
      })),
      2,
    );
    expect(await db.getTransaction(purchase.id)).toMatchObject({
      amountMinor: -10001,
      version: 2,
    });
  });

  it("resolves a purchase emitted after its lines and crosses statement batches", async () => {
    const purchase = row("plan", { installmentCount: 30 });
    const lines = Array.from({ length: 30 }, (_, index) =>
      row(`plan-line-${index + 1}`, {
        amountBasis: "booked_entry",
        amountMinor: -10,
        installmentCount: 30,
        installmentNumber: index + 1,
        purchaseKey: "plan",
      }),
    );
    await db.ingestRun(
      {
        connectionId,
        runId: "child-first",
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:cal/recent",
            capturedAt: "2040-07-01T00:00:00Z",
            responseText: JSON.stringify([...lines, purchase]),
          },
        ],
      },
      synthetic,
    );
    const rows = await db.listTransactions();
    const parent = rows.find((item) => item.sourceKey === "plan")!;
    expect(rows.filter((item) => item.purchaseId === parent.id)).toHaveLength(
      30,
    );
  });

  it("never links a line to a target that is not a purchase", async () => {
    await db.ingestRun(
      {
        connectionId,
        runId: "wrong-role",
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:cal/recent",
            capturedAt: "2040-07-01T00:00:00Z",
            responseText: JSON.stringify([
              row("entry", { amountBasis: "booked_entry" }),
              row("line", {
                amountBasis: "booked_entry",
                installmentNumber: 1,
                purchaseKey: "entry",
              }),
              row("orphan", {
                amountBasis: "booked_entry",
                installmentNumber: 1,
                purchaseKey: "missing",
              }),
            ]),
          },
        ],
      },
      synthetic,
    );
    for (const sourceKey of ["line", "orphan"]) {
      const line = await byKey(sourceKey);
      expect(line.purchaseId).toBeNull();
      expect(line.sourceIssues).toContain("unresolved_purchase");
    }
  });
});

it("rolls back a purchase and its lines together when a later write fails", async () => {
  const db = await openDatabase(":memory:");
  try {
    await db.ensureConnection({ id: connectionId, provider: "cal" });
    await db.client.executeMultiple(
      "CREATE TRIGGER synthetic_failure BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
    );
    const ingest = () =>
      db.ingestRun(
        {
          connectionId,
          runId: "rollback",
          responses: [
            {
              accountKey: "synthetic-account",
              endpoint: "synthetic:cal/recent",
              capturedAt: "2040-06-01T00:00:00Z",
              responseText: JSON.stringify({
                statusCode: 1,
                result: { transactions: plans(), clearanceRequests: [] },
              }),
            },
          ],
        },
        calAdapter,
      );
    await expect(ingest()).rejects.toMatchObject({
      cause: { message: expect.stringContaining("synthetic failure") },
    });
    expect(await db.listTransactions()).toEqual([]);
    expect((await db.orm.select().from(syncRuns).get())?.appliedAt).toBeNull();
    await db.client.executeMultiple("DROP TRIGGER synthetic_failure");
    expect(await db.applyRun("rollback", calAdapter)).toMatchObject({
      status: "completed",
      created: 7,
    });
  } finally {
    db.close();
  }
});
