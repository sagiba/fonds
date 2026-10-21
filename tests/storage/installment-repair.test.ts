import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyDetails, type TransactionInput } from "../../src/domain/model.js";
import { inPerspective } from "../../src/domain/read-model.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import {
  backends,
  type Harness,
  insertTransactionFixture,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

const connectionId = "synthetic-installment-repair";
const adapter: SourceAdapter = {
  ...synthetic,
  extract(text, context) {
    return {
      ...synthetic.extract(text, context),
      historical: context.scope?.kind === "history",
    };
  },
};

function purchase(count: number | null = null): TransactionInput {
  return row("plan", {
    amountMinor: -12500,
    installmentCount: count,
    billingDate: count === null ? "2040-07-10" : null,
    details: {
      ...emptyDetails(),
      issues: count === null ? ["unknown_installment_count"] : [],
    },
  });
}

function line(ordinal: number, count: number | null = 5): TransactionInput {
  return row(`line-${ordinal}`, {
    amountBasis: "booked_entry",
    amountMinor: -2500,
    installmentCount: count,
    installmentNumber: ordinal,
    purchaseKey: "plan",
    billingDate: `2040-${String(ordinal + 6).padStart(2, "0")}-10`,
  });
}

describe.each(backends)("%s installment repair", (backend) => {
  let db: Harness;
  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(() => db.close());

  function capture(day: number, rows: TransactionInput[], historical = false) {
    return db.ingestRun(
      {
        connectionId,
        runId: `repair-${day}`,
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:installments",
            capturedAt: `2040-07-${String(day).padStart(2, "0")}T12:00:00Z`,
            responseText: JSON.stringify(rows),
            scope: { kind: historical ? "history" : "recent" },
          },
        ],
      },
      adapter,
    );
  }

  async function parent() {
    const rows = await db.listTransactions({
      connectionId,
      perspective: "all",
    });
    const parents = rows.filter((item) => item.sourceKey === "plan");
    expect(parents).toHaveLength(1);
    return parents[0]!;
  }

  async function expectBilling(keys: string[], amountMinor: number) {
    const every = await db.listTransactions({
      connectionId,
      perspective: "all",
    });
    const page = await db.listTransactionPage({
      connectionId,
      perspective: "billing",
      limit: 200,
    });
    expect(page.transactions.map((item) => item.sourceKey).sort()).toEqual(
      keys,
    );
    expect(
      every
        .filter((item) =>
          inPerspective(
            item,
            "billing",
            every.some(
              (child) =>
                child.purchaseId === item.id &&
                child.presence !== "removed" &&
                !child.supersededById,
            ),
          ),
        )
        .map((item) => item.sourceKey)
        .sort(),
    ).toEqual(keys);
    expect(
      (await db.getTotals({ connectionId, perspective: "billing" })).totals,
    ).toEqual([{ currency: "ILS", amountBasis: null, amountMinor }]);
    expect((await db.getTotals({ connectionId })).totals).toEqual([
      {
        currency: "ILS",
        amountBasis: "purchase_commitment",
        amountMinor: -12500,
      },
    ]);
  }

  it("repairs recent unknown-count purchases from historical explicit lines without replacing newer money", async () => {
    await capture(10, [purchase()]);
    const before = await parent();
    await capture(
      11,
      [
        {
          ...purchase(5),
          amountMinor: -10000,
          description: "Older synthetic description",
        },
        ...[1, 2, 3, 4, 5].map((ordinal) => line(ordinal)),
      ],
      true,
    );
    await capture(12, [purchase()]);
    expect(await parent()).toMatchObject({
      id: before.id,
      installmentCount: 5,
      billingDate: null,
      amountMinor: -12500,
      description: "Synthetic",
    });
    expect((await parent()).sourceIssues).not.toContain(
      "conflicting_installment_plan",
    );
    await expectBilling(
      ["line-1", "line-2", "line-3", "line-4", "line-5"],
      -12500,
    );
  });

  it("repairs already-stored null-count conflicts on an unchanged refresh and preserves annotations and identities", async () => {
    await capture(10, [purchase()]);
    await capture(11, [purchase(5), line(1), line(2)], true);
    const stored = await parent();
    // Reproduce a ledger written before repair, independently of ingestion behavior.
    await insertTransactionFixture(
      db,
      [
        {
          ...stored,
          installmentCount: null,
          billingDate: "2040-07-10",
          details: {
            ...stored.details,
            issues: [
              "unknown_installment_count",
              "conflicting_installment_plan",
            ],
          },
        },
      ],
      "update",
    );
    await expectBilling(["line-1", "line-2"], -5000);
    const annotation = await db.editAnnotation({
      transactionId: stored.id,
      expectedVersion: 0,
      notes: "Keep this synthetic owner note",
      category: "Synthetic category",
    });
    const identities = (await db.listTransactions({ perspective: "all" }))
      .map((item) => [item.sourceKey, item.id, item.purchaseId])
      .sort();
    const priorEvents = (await db.listEvents()).length;
    await capture(12, [purchase()]);
    const repaired = await parent();
    expect(repaired).toMatchObject({
      id: stored.id,
      installmentCount: 5,
      billingDate: null,
      version: stored.version + 1,
      annotation,
    });
    expect(repaired.sourceIssues).not.toContain("conflicting_installment_plan");
    expect((await db.listEvents()).slice(priorEvents)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "transaction.updated",
          transactionId: stored.id,
        }),
      ]),
    );
    expect(
      (await db.listTransactions({ perspective: "all" }))
        .map((item) => [item.sourceKey, item.id, item.purchaseId])
        .sort(),
    ).toEqual(identities);
    await expectBilling(["line-1", "line-2"], -5000);

    const events = await db.listEvents();
    const versions = (await db.listTransactions({ perspective: "all" }))
      .map((item) => [item.id, item.version])
      .sort();
    expect(await capture(13, [purchase()])).toMatchObject({
      created: 0,
      updated: 0,
    });
    expect(await capture(14, [purchase()])).toMatchObject({
      created: 0,
      updated: 0,
    });
    expect(await db.listEvents()).toEqual(events);
    expect(
      (await db.listTransactions({ perspective: "all" }))
        .map((item) => [item.id, item.version])
        .sort(),
    ).toEqual(versions);
    expect((await parent()).annotation).toEqual(annotation);
  });

  it("keeps the same purchase and billing members when history arrives first", async () => {
    await capture(10, [purchase(5), line(1), line(2)], true);
    const before = await parent();
    await capture(11, [purchase()]);
    expect(await parent()).toMatchObject({
      id: before.id,
      installmentCount: 5,
      billingDate: null,
    });
    await expectBilling(["line-1", "line-2"], -5000);
  });

  it("retains the known plan count while accepting newer unknown-count purchase money and description", async () => {
    await capture(10, [purchase(5), line(1), line(2)], true);
    const before = await parent();
    await capture(11, [
      {
        ...purchase(),
        amountMinor: -13000,
        description: "Corrected synthetic purchase",
      },
    ]);
    const current = await parent();
    expect(current).toMatchObject({
      id: before.id,
      installmentCount: 5,
      billingDate: null,
      amountMinor: -13000,
      description: "Corrected synthetic purchase",
    });
    expect(current.sourceIssues).not.toContain("conflicting_installment_plan");
    expect((await db.getTotals()).totals).toEqual([
      {
        currency: "ILS",
        amountBasis: "purchase_commitment",
        amountMinor: -13000,
      },
    ]);
    expect((await db.getTotals({ perspective: "billing" })).totals).toEqual([
      { currency: "ILS", amountBasis: null, amountMinor: -5000 },
    ]);
  });

  it("uses an explicit count from a partial child window, not the number of observed lines", async () => {
    await capture(10, [purchase()]);
    await capture(11, [purchase(5), line(3)], true);
    await capture(12, [purchase()]);
    expect(await parent()).toMatchObject({
      installmentCount: 5,
      billingDate: null,
    });
    expect(await db.listTransactions({ perspective: "all" })).toHaveLength(2);
    await expectBilling(["line-3"], -2500);
  });

  it("does not guess a count when linked lines disagree and never bills the parent twice", async () => {
    await capture(10, [purchase()]);
    await capture(11, [purchase(), line(1, 5), line(2, 6)], true);
    await capture(12, [purchase()]);
    const unresolved = await parent();
    expect(unresolved.installmentCount).toBeNull();
    expect(unresolved.sourceIssues).toContain("conflicting_installment_plan");
    await expectBilling(["line-1", "line-2"], -5000);
  });

  it("does not erase an explicit single-payment conflict when previously unknown child counts become known", async () => {
    await capture(10, [purchase(), line(1, null)]);
    expect((await parent()).installmentCount).toBeNull();
    expect((await parent()).sourceIssues).not.toContain(
      "conflicting_installment_plan",
    );
    await capture(11, [purchase(1), line(1, null)]);
    expect((await parent()).installmentCount).toBe(1);
    expect((await parent()).sourceIssues).toContain(
      "conflicting_installment_plan",
    );
    await capture(12, [purchase(), line(1, 5)]);
    expect((await parent()).installmentCount).toBe(1);
    expect((await parent()).sourceIssues).toContain(
      "conflicting_installment_plan",
    );
    await expectBilling(["line-1"], -2500);
  });

  it("does not infer a count from the highest ordinal when every child count is unknown", async () => {
    await capture(10, [purchase()]);
    await capture(11, [purchase(), line(3, null)], true);
    await capture(12, [purchase()]);
    expect((await parent()).installmentCount).toBeNull();
    await expectBilling(["line-3"], -2500);
  });

  it("keeps a linked purchase out of billing even when all its lines are outside the requested date window", async () => {
    await capture(10, [purchase(), line(3, null)]);
    const stored = await parent();
    await insertTransactionFixture(
      db,
      [{ ...stored, billingDate: "2040-07-10" }],
      "update",
    );
    const filters = {
      connectionId,
      perspective: "billing" as const,
      dateRole: "billing" as const,
      from: "2040-07-01",
      to: "2040-07-31",
    };
    expect((await db.listTransactionPage(filters)).transactions).toEqual([]);
    expect((await db.getTotals(filters)).totals).toEqual([]);
  });

  it("preserves a known plan and flags an explicit single-payment restatement", async () => {
    await capture(10, [purchase(5), line(1)]);
    await capture(11, [{ ...purchase(1), billingDate: "2040-07-10" }]);
    const current = await parent();
    expect(current.installmentCount).toBe(5);
    expect(current.sourceIssues).toContain("conflicting_installment_plan");
    await expectBilling(["line-1"], -2500);
    await capture(12, [purchase()]);
    expect((await parent()).sourceIssues).toContain(
      "conflicting_installment_plan",
    );
    expect((await parent()).installmentCount).toBe(5);
    await capture(13, [purchase(5)]);
    expect((await parent()).sourceIssues).not.toContain(
      "conflicting_installment_plan",
    );
    await expectBilling(["line-1"], -2500);
  });

  it.each(["removed", "superseded"] as const)(
    "does not suppress a standalone purchase because of a %s child",
    async (state) => {
      await capture(10, [purchase(), line(1, null)]);
      const rows = await db.listTransactions({ perspective: "all" });
      const stored = await parent();
      const child = rows.find((item) => item.sourceKey === "line-1")!;
      await expectBilling(["line-1"], -2500);
      if (state === "removed") {
        await db.confirmRemoval({
          transactionId: child.id,
          expectedVersion: child.version,
          reason: "Synthetic removal",
        });
      } else {
        const replacement = {
          ...child,
          id: "synthetic-replacement",
          sourceKey: "replacement",
          purchaseId: null,
          installmentNumber: null,
        };
        await insertTransactionFixture(db, [replacement]);
        await insertTransactionFixture(
          db,
          [{ ...child, supersededById: replacement.id }],
          "update",
        );
      }
      expect((await parent()).installmentCount).toBeNull();
      expect(
        (
          await db.listTransactionPage({ perspective: "billing" })
        ).transactions.map((item) => item.id),
      ).toContain(stored.id);
      expect((await db.getTotals({ perspective: "billing" })).totals).toEqual([
        {
          currency: "ILS",
          amountBasis: null,
          amountMinor: state === "removed" ? -12500 : -15000,
        },
      ]);
    },
  );
});
