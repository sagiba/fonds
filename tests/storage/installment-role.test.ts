import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { calAdapter } from "../../src/providers/cal/adapter.js";
import { backends, type Harness, open } from "../helpers/storage-harness.js";

type SourceRow = Record<string, unknown>;

// This absent-count combination is invented, not an observed provider shape.
function payment(): SourceRow {
  const rows = JSON.parse(
    readFileSync(
      new URL(
        "../providers/cal/fixtures/installment-plans.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).result.transactions as SourceRow[];
  return {
    ...rows.find(
      (row) =>
        row.trnIntId === "SYNTHETIC-TXN-PLAN-ROUNDING" &&
        row.curPaymentNum === 2,
    )!,
    numOfPayments: null,
    transTypeCommentDetails: [],
    onGoingTransactionsComment: "",
  };
}

const connectionId = "synthetic-installment-role";

describe.each(backends)("%s installment role without count", (backend) => {
  let db: Harness;
  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(() => db.close());

  function capture(source: SourceRow, day: number) {
    return db.ingestRun(
      {
        connectionId,
        runId: `installment-role-${day}`,
        responses: [
          {
            accountKey: "synthetic-account",
            endpoint: "synthetic:cal/recent",
            capturedAt: `2040-07-${String(day).padStart(2, "0")}T00:00:00Z`,
            responseText: JSON.stringify({
              statusCode: 1,
              result: { transactions: [source], clearanceRequests: [] },
            }),
          },
        ],
      },
      calAdapter,
    );
  }

  it("counts the purchase once for spending and only the observed payment for billing across replay", async () => {
    const source = payment();
    expect(await capture(source, 1)).toMatchObject({
      observed: 2,
      created: 2,
      updated: 0,
      replayed: false,
    });
    const rows = await db.listTransactions({ perspective: "all" });
    expect(rows).toHaveLength(2);
    const purchase = rows.find((row) => row.purchaseId === null)!;
    const line = rows.find((row) => row.purchaseId !== null)!;
    expect(purchase).toMatchObject({
      amountMinor: -10000,
      amountBasis: "purchase_commitment",
      installmentCount: null,
      installmentNumber: null,
      billingDate: null,
      version: 1,
    });
    expect(line).toMatchObject({
      purchaseId: purchase.id,
      amountMinor: -3333,
      amountBasis: "booked_entry",
      installmentCount: null,
      installmentNumber: 2,
      billingDate: "2040-07-10",
      version: 1,
    });
    const events = await db.listEvents();
    const spending = await db.getTotals({ perspective: "spending" });
    expect(spending).toMatchObject({
      totals: [
        {
          currency: "ILS",
          amountBasis: "purchase_commitment",
          amountMinor: -10000,
        },
      ],
      includedCount: 1,
      excludedCount: 0,
    });
    const billing = await db.getTotals({ perspective: "billing" });
    expect(billing).toMatchObject({
      totals: [{ currency: "ILS", amountBasis: null, amountMinor: -3333 }],
      includedCount: 1,
      excludedCount: 0,
    });
    expect(
      (
        await db.listTransactionPage({ perspective: "billing", limit: 200 })
      ).transactions.map((row) => row.id),
    ).toEqual([line.id]);
    expect(await capture(source, 1)).toMatchObject({ replayed: true });
    expect(await capture(source, 2)).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 2,
    });
    expect(await db.listTransactions({ perspective: "all" })).toMatchObject(
      rows.map(({ id, version, purchaseId, installmentCount }) => ({
        id,
        version,
        purchaseId,
        installmentCount,
      })),
    );
    expect(await db.listEvents()).toEqual(events);
    expect(await db.getTotals({ perspective: "spending" })).toEqual(spending);
    expect(await db.getTotals({ perspective: "billing" })).toEqual(billing);
  });

  it("holds an unsupported summary outside both totals without inventing a count or payment", async () => {
    const summary = { ...payment(), curPaymentNum: null };
    await capture(summary, 1);
    const rows = await db.listTransactions({ perspective: "all" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      identityStrength: "native",
      amountMinor: -10000,
      currency: "ILS",
      amountBasis: "unknown",
      installmentCount: null,
      installmentNumber: null,
      purchaseId: null,
      billingDate: null,
      reviewRequired: true,
    });
    expect(rows[0]!.sourceIssues).toContain("unresolved_installment_role");
    const events = await db.listEvents();
    expect(await capture(summary, 1)).toMatchObject({ replayed: true });
    expect(await capture(summary, 2)).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 1,
    });
    expect(await db.listEvents()).toEqual(events);
    for (const perspective of ["spending", "billing"] as const) {
      expect(await db.getTotals({ perspective })).toMatchObject({
        totals: [],
        includedCount: 0,
        excludedCount: 1,
        excluded: { unresolved: 1 },
      });
    }
    await capture(payment(), 3);
    const resolved = await db.getTransaction(rows[0]!.id);
    expect(resolved).toMatchObject({
      amountMinor: -10000,
      amountBasis: "purchase_commitment",
      installmentCount: null,
    });
    expect(resolved!.sourceIssues).not.toContain("unresolved_installment_role");
    expect((await db.getTotals()).totals).toEqual([
      {
        currency: "ILS",
        amountBasis: "purchase_commitment",
        amountMinor: -10000,
      },
    ]);
    expect((await db.getTotals({ perspective: "billing" })).totals).toEqual([
      { currency: "ILS", amountBasis: null, amountMinor: -3333 },
    ]);
  });

  it.each([null, 3])(
    "retains an accepted plan and its observed line when a summary omits count %s and ordinal",
    async (installmentCount) => {
      const source = { ...payment(), numOfPayments: installmentCount };
      await capture(source, 1);
      const before = await db.listTransactions({ perspective: "all" });
      const purchase = before.find((row) => row.purchaseId === null)!;
      const line = before.find((row) => row.purchaseId === purchase.id)!;
      const spending = await db.getTotals({ perspective: "spending" });
      const billing = await db.getTotals({ perspective: "billing" });
      const summary = { ...payment(), curPaymentNum: null };
      await capture(summary, 2);
      const held = await db.getTransaction(purchase.id);
      expect(held).toMatchObject({
        amountMinor: -10000,
        amountBasis: "purchase_commitment",
        installmentCount,
        reviewRequired: true,
      });
      expect(held!.sourceIssues).toContain("unresolved_installment_role");
      expect(held!.sourceIssues).not.toContain(
        "conflicting_installment_restatement",
      );
      expect(await db.getTransaction(line.id)).toMatchObject({
        purchaseId: purchase.id,
        amountMinor: -3333,
        amountBasis: "booked_entry",
        installmentNumber: 2,
        installmentCount,
        version: line.version,
      });
      const events = await db.listEvents();
      expect(await capture(summary, 3)).toMatchObject({
        created: 0,
        updated: 0,
      });
      expect(await db.listEvents()).toEqual(events);
      expect(await db.getTotals({ perspective: "spending" })).toEqual(spending);
      expect(await db.getTotals({ perspective: "billing" })).toEqual(billing);
      expect(await db.listTransactions({ perspective: "all" })).toHaveLength(2);
      await capture(source, 4);
      const resolved = await db.getTransaction(purchase.id);
      expect(resolved!.sourceIssues).not.toContain(
        "unresolved_installment_role",
      );
      expect(resolved!.sourceIssues).not.toContain(
        "conflicting_installment_restatement",
      );
      expect(await db.getTotals({ perspective: "spending" })).toEqual(spending);
      expect(await db.getTotals({ perspective: "billing" })).toEqual(billing);
    },
  );
});
