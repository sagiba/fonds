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

  it("clears a known-count conflict stored by an unknown-count recapture before provenance", async () => {
    await capture(10, [purchase()]);
    await capture(11, [purchase(5), line(1), line(2)], true);
    const stored = await parent();
    // The earlier policy flagged a later unknown-count capture as a restatement.
    await insertTransactionFixture(
      db,
      [
        {
          ...stored,
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
    await capture(12, [purchase()]);
    expect(await parent()).toMatchObject({
      installmentCount: 5,
      sourceIssues: [],
      reviewRequired: false,
    });
  });

  it("keeps a single-payment restatement stored before provenance until the source restates a plan", async () => {
    await capture(10, [purchase(5), line(1)]);
    const stored = await parent();
    // The earlier policy flagged an explicit single-payment capture this way.
    await insertTransactionFixture(
      db,
      [
        {
          ...stored,
          details: {
            ...stored.details,
            issues: ["conflicting_installment_plan"],
          },
        },
      ],
      "update",
    );
    await capture(11, [{ ...purchase(), amountMinor: -17000 }]);
    const current = await parent();
    expect(current).toMatchObject({ installmentCount: 5, amountMinor: -12500 });
    expect(current.sourceIssues).toContain(
      "conflicting_installment_restatement",
    );
    await capture(12, [{ ...purchase(5), amountMinor: -17000 }]);
    expect(await parent()).toMatchObject({
      amountMinor: -17000,
      sourceIssues: [],
    });
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
    // The restatement keeps the plan's facts, including its unknown count.
    expect((await parent()).installmentCount).toBeNull();
    expect((await parent()).sourceIssues).toContain(
      "conflicting_installment_restatement",
    );
    await capture(12, [purchase(), line(1, 5)]);
    expect((await parent()).installmentCount).toBeNull();
    expect((await parent()).sourceIssues).toContain(
      "conflicting_installment_plan",
    );
    await expectBilling(["line-1"], -2500);
  });

  it("clears the unknown-count issue once explicit lines establish the count", async () => {
    await capture(10, [purchase(), line(1), line(2)]);
    expect(await parent()).toMatchObject({
      installmentCount: 5,
      sourceIssues: [],
      reviewRequired: false,
    });
    const before = await parent();
    const events = await db.listEvents();
    expect(await capture(11, [purchase(), line(1), line(2)])).toMatchObject({
      created: 0,
      updated: 0,
    });
    expect((await parent()).version).toBe(before.version);
    expect(await db.listEvents()).toEqual(events);
  });

  it("flags restated line counts instead of replacing an established count", async () => {
    await capture(10, [purchase(), line(1, 3), line(2, 3)]);
    expect((await parent()).installmentCount).toBe(3);
    await capture(11, [purchase(), line(1, 4), line(2, 4)]);
    const current = await parent();
    expect(current.installmentCount).toBe(3);
    expect(current.sourceIssues).toEqual([
      "conflicting_installment_lines",
      "conflicting_installment_plan",
    ]);
  });

  it("flags a line whose ordinal exceeds the purchase's count when the line states none", async () => {
    await capture(10, [purchase(3), line(4, null)]);
    expect((await parent()).sourceIssues).toEqual([
      "conflicting_installment_lines",
      "conflicting_installment_plan",
    ]);
  });

  it("keeps a source-stated plan billing date across refreshes", async () => {
    const input = [
      { ...purchase(3), billingDate: "2040-07-10" },
      line(1, 3),
      line(2, 3),
    ];
    await capture(10, input);
    const before = await parent();
    expect(before.billingDate).toBe("2040-07-10");
    await capture(11, [{ ...purchase(), billingDate: "2040-07-12" }]);
    expect(await parent()).toMatchObject({
      installmentCount: 3,
      billingDate: "2040-07-10",
    });
    const events = await db.listEvents();
    expect(await capture(12, input)).toMatchObject({ created: 0, updated: 0 });
    expect(await db.listEvents()).toEqual(events);
  });

  it("does not fill a weak purchase identity's count, so identical captures stay matched", async () => {
    const input = [
      { ...purchase(), identityStrength: "weak" as const },
      line(1, 3),
    ];
    await capture(10, input);
    const before = await parent();
    expect(before).toMatchObject({
      installmentCount: null,
      billingDate: "2040-07-10",
    });
    const events = await db.listEvents();
    expect(await capture(11, input)).toMatchObject({ created: 0, updated: 0 });
    expect(await parent()).toMatchObject({
      id: before.id,
      version: before.version,
    });
    expect(await db.listEvents()).toEqual(events);
  });

  it("flags unanimous lines that contradict the purchase's stated count", async () => {
    await capture(10, [purchase(3), line(1, 3), line(2, 3)]);
    await capture(11, [purchase(3), line(1, 4), line(2, 4)]);
    const current = await parent();
    expect(current.installmentCount).toBe(3);
    expect(current.sourceIssues).toEqual([
      "conflicting_installment_lines",
      "conflicting_installment_plan",
    ]);
  });

  it("keeps line-count conflicts stable when a single-payment purchase is captured again", async () => {
    const input = [purchase(1), line(1, 5)];
    await capture(10, input);
    const before = await parent();
    expect(before.sourceIssues).toEqual([
      "conflicting_installment_lines",
      "conflicting_installment_plan",
    ]);
    const events = await db.listEvents();
    expect(await capture(11, input)).toMatchObject({ created: 0, updated: 0 });
    expect(await parent()).toMatchObject({
      version: before.version,
      sourceIssues: before.sourceIssues,
    });
    expect(await db.listEvents()).toEqual(events);
  });

  it("treats a linked purchase recaptured as a refund as a restatement", async () => {
    await capture(10, [purchase(), line(1, null)]);
    await capture(11, [{ ...purchase(), kind: "refund", amountMinor: 12500 }]);
    const current = await parent();
    expect(current).toMatchObject({ kind: "purchase", amountMinor: -12500 });
    expect(current.sourceIssues).toContain(
      "conflicting_installment_restatement",
    );
  });

  it("reevaluates line conflicts from accepted rows of a partly invalid capture", async () => {
    await capture(10, [purchase(5), line(1, 6)]);
    expect((await parent()).sourceIssues).toContain(
      "conflicting_installment_lines",
    );
    await capture(11, [
      line(1, 5),
      { ...row("invalid"), amountMinor: 0.5 } as TransactionInput,
    ]);
    expect((await parent()).sourceIssues).toEqual([]);
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

  it.each([true, false])(
    "clears resolved child-count conflicts on refresh when the purchase is present=%s",
    async (includeParent) => {
      await capture(10, [purchase(5), line(1, 5), line(2, 6)]);
      expect((await parent()).sourceIssues).toContain(
        "conflicting_installment_plan",
      );
      const bad = (await db.listTransactions({ perspective: "all" })).find(
        (item) => item.sourceKey === "line-2",
      )!;
      await db.confirmRemoval({
        transactionId: bad.id,
        expectedVersion: bad.version,
        reason: "Synthetic incorrect child removed",
      });
      const next = includeParent ? [purchase()] : [row("unrelated")];
      await capture(11, next);
      expect((await parent()).installmentCount).toBe(5);
      expect((await parent()).sourceIssues).not.toContain(
        "conflicting_installment_plan",
      );
      const current = await parent();
      const events = await db.listEvents();
      expect(await capture(12, next)).toMatchObject({ created: 0, updated: 0 });
      expect((await parent()).version).toBe(current.version);
      expect(await db.listEvents()).toEqual(events);
    },
  );

  it("clears derived count conflicts after the sole conflicting child is removed while the parent is absent", async () => {
    await capture(10, [purchase(5), line(1, 6)]);
    expect((await parent()).sourceIssues).toContain(
      "conflicting_installment_plan",
    );
    expect((await parent()).sourceIssues).toContain(
      "conflicting_installment_lines",
    );
    const child = (await db.listTransactions({ perspective: "all" })).find(
      (item) => item.sourceKey === "line-1",
    )!;
    await db.confirmRemoval({
      transactionId: child.id,
      expectedVersion: child.version,
      reason: "Synthetic sole incorrect child removed",
    });
    await capture(11, [row("unrelated")]);
    const resolved = await parent();
    expect(resolved).toMatchObject({
      installmentCount: 5,
      amountMinor: -12500,
    });
    expect(resolved.sourceIssues).not.toContain("conflicting_installment_plan");
    expect(resolved.sourceIssues).not.toContain(
      "conflicting_installment_lines",
    );
    const events = await db.listEvents();
    expect(await capture(12, [row("unrelated")])).toMatchObject({
      created: 0,
      updated: 0,
    });
    expect((await parent()).version).toBe(resolved.version);
    expect(await db.listEvents()).toEqual(events);
  });

  it("resolves a derived conflict when the owner removes the conflicting line", async () => {
    await capture(10, [purchase(5), line(1, 6)]);
    const flagged = await parent();
    expect(flagged.reviewRequired).toBe(true);
    const child = (await db.listTransactions({ perspective: "all" })).find(
      (item) => item.sourceKey === "line-1",
    )!;
    await db.confirmRemoval({
      transactionId: child.id,
      expectedVersion: child.version,
      reason: "Synthetic incorrect child removed",
    });
    const resolved = await parent();
    expect(resolved).toMatchObject({
      installmentCount: 5,
      sourceIssues: [],
      reviewRequired: false,
    });
    expect(await db.listEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "transaction.review_resolved",
          transactionId: flagged.id,
        }),
      ]),
    );
  });

  it("drops installment FX from linked purchases even when every count is unknown", async () => {
    const withFx = {
      ...purchase(),
      fxFeeMinor: -100,
      fxFeeCurrency: "ILS",
      details: {
        ...purchase().details,
        currencyExchange: [
          {
            sourceCurrency: "USD",
            targetCurrency: "ILS",
            unitCurrency: "USD",
            exchangeRate: "3.75",
            quotationDate: "2040-07-01",
          },
        ],
      },
    };
    await capture(10, [withFx, line(1, null)]);
    expect(await parent()).toMatchObject({
      installmentCount: null,
      fxFeeMinor: null,
      fxFeeCurrency: null,
    });
    expect((await parent()).details.currencyExchange).toBeUndefined();
    expect((await db.getTotals()).fxFees).toEqual([]);
    const before = await parent();
    const events = await db.listEvents();
    await capture(11, [withFx, line(1, null)]);
    expect((await parent()).version).toBe(before.version);
    expect(await db.listEvents()).toEqual(events);
  });

  it("keeps a linked purchase restated with an unverified basis stable", async () => {
    await capture(10, [purchase(), line(1, null)]);
    const restated: TransactionInput = {
      ...purchase(),
      amountBasis: "unknown",
      fxFeeMinor: -100,
      fxFeeCurrency: "ILS",
    };
    await capture(11, [restated]);
    const before = await parent();
    expect(before).toMatchObject({ fxFeeMinor: null, fxFeeCurrency: null });
    const events = await db.listEvents();
    expect(await capture(12, [restated])).toMatchObject({
      created: 0,
      updated: 0,
    });
    expect(await parent()).toMatchObject({
      id: before.id,
      version: before.version,
    });
    expect(await db.listEvents()).toEqual(events);
  });

  it("keeps FX on a single charge that a line names but cannot attach to", async () => {
    await capture(10, [
      {
        ...row("plan"),
        amountBasis: "booked_entry",
        fxFeeMinor: -100,
        fxFeeCurrency: "ILS",
      },
      line(1, null),
    ]);
    expect(await parent()).toMatchObject({
      fxFeeMinor: -100,
      fxFeeCurrency: "ILS",
    });
  });

  it("keeps FX on purchases that share the key a line names", async () => {
    const withFx = (key: string, aliases: string[] = []) => ({
      ...purchase(),
      sourceKey: key,
      sourceAliases: aliases,
      fxFeeMinor: -100,
      fxFeeCurrency: "ILS",
    });
    await capture(10, [
      withFx("a", ["b"]),
      withFx("b"),
      { ...line(1, null), purchaseKey: "b" },
    ]);
    const rows = await db.listTransactions({ perspective: "all" });
    for (const key of ["a", "b"]) {
      expect(rows.find((item) => item.sourceKey === key)).toMatchObject({
        fxFeeMinor: -100,
        fxFeeCurrency: "ILS",
      });
    }
    expect(
      rows.find((item) => item.sourceKey === "line-1")!.sourceIssues,
    ).toContain("unresolved_purchase");
  });

  it("clears a restatement conflict when the owner removes the purchase's last line", async () => {
    await capture(10, [purchase(5), line(1)]);
    await capture(11, [purchase(1)]);
    expect((await parent()).sourceIssues).toContain(
      "conflicting_installment_restatement",
    );
    const child = (await db.listTransactions({ perspective: "all" })).find(
      (item) => item.sourceKey === "line-1",
    )!;
    await db.confirmRemoval({
      transactionId: child.id,
      expectedVersion: child.version,
      reason: "Synthetic plan lines removed",
    });
    expect((await parent()).sourceIssues).toEqual([]);
  });

  it("refreshes only the purchases an owner operation touches", async () => {
    await capture(10, [purchase(), line(1), row("unrelated")]);
    const other = (await db.listTransactions({ perspective: "all" })).find(
      (item) => item.sourceKey === "unrelated",
    )!;
    const stored = await parent();
    // A purchase written before repair, which only its own refresh may change.
    await insertTransactionFixture(
      db,
      [{ ...stored, installmentCount: null, billingDate: "2040-07-10" }],
      "update",
    );
    await db.confirmRemoval({
      transactionId: other.id,
      expectedVersion: other.version,
      reason: "Synthetic unrelated removal",
    });
    expect((await parent()).installmentCount).toBeNull();
  });

  it("normalizes linked-parent FX immediately even when ambiguous identity prevents count inference", async () => {
    const input: TransactionInput[] = [
      {
        ...purchase(),
        identityStrength: "ambiguous",
        fxFeeMinor: -100,
        fxFeeCurrency: "ILS",
      },
      line(1, null),
    ];
    await capture(10, input);
    const before = await parent();
    expect(before).toMatchObject({
      identityStrength: "ambiguous",
      installmentCount: null,
      fxFeeMinor: null,
      fxFeeCurrency: null,
    });
    const child = (await db.listTransactions({ perspective: "all" })).find(
      (item) => item.sourceKey === "line-1",
    )!;
    expect(child.purchaseId).toBe(before.id);
    const events = await db.listEvents();
    expect(await capture(11, input)).toMatchObject({ created: 0, updated: 0 });
    expect(await parent()).toMatchObject({
      id: before.id,
      version: before.version,
      installmentCount: null,
      fxFeeMinor: null,
      fxFeeCurrency: null,
    });
    expect(await db.listEvents()).toEqual(events);
  });

  it("flags matching unknown-count linked purchases as possible duplicate plans without merging them", async () => {
    const twin = (key: string, fields: Partial<TransactionInput> = {}) => [
      { ...purchase(), sourceKey: key, ...fields },
      {
        ...line(1, null),
        sourceKey: `${key}-line`,
        purchaseKey: key,
        ...fields,
      },
    ];
    await capture(10, [
      ...twin("plan"),
      ...twin("twin"),
      ...twin("different-merchant", {
        merchantName: "Other synthetic merchant",
      }),
      ...twin("different-card", { cardKey: "other-card" }),
    ]);
    const rows = await db.listTransactions({ perspective: "all" });
    for (const key of ["plan", "twin"]) {
      const item = rows.find((entry) => entry.sourceKey === key)!;
      expect(item.installmentCount).toBeNull();
      expect(item.sourceIssues).toContain("possible_duplicate_plan");
      expect(item.supersededById).toBeNull();
    }
    for (const key of ["different-merchant", "different-card"]) {
      expect(
        rows.find((item) => item.sourceKey === key)!.sourceIssues,
      ).not.toContain("possible_duplicate_plan");
    }
    expect(rows).toHaveLength(8);
  });

  it("reports unresolved held billed lines instead of falling back to the unknown-count purchase amount", async () => {
    await capture(10, [
      purchase(),
      line(1, null),
      { ...line(1, null), sourceKey: "duplicate-line", amountMinor: -2400 },
    ]);
    const current = await parent();
    expect(current).toMatchObject({
      installmentCount: null,
      amountMinor: -12500,
    });
    const page = await db.listTransactionPage({ perspective: "billing" });
    expect(page.transactions.map((item) => item.sourceKey).sort()).toEqual([
      "duplicate-line",
      "line-1",
    ]);
    for (const item of page.transactions) {
      expect(item.amountMinor).toBeNull();
      expect(item.sourceIssues).toContain("duplicate_installment_ordinal");
    }
    expect(await db.getTotals({ perspective: "billing" })).toMatchObject({
      totals: [],
      includedCount: 0,
      excluded: { unresolved: 2 },
    });
    expect((await db.getTotals()).totals).toEqual([
      {
        currency: "ILS",
        amountBasis: "purchase_commitment",
        amountMinor: -12500,
      },
    ]);
  });

  it("keeps unknown-count parent dates, versions and events stable across identical captures", async () => {
    const input = [purchase(), line(1, null)];
    await capture(10, input);
    expect(await parent()).toMatchObject({
      installmentCount: null,
      billingDate: "2040-07-10",
    });
    const before = await parent();
    const events = await db.listEvents();
    expect(await capture(11, input)).toMatchObject({ created: 0, updated: 0 });
    expect(await parent()).toMatchObject({
      version: before.version,
      billingDate: "2040-07-10",
    });
    expect(await db.listEvents()).toEqual(events);
  });

  it("holds accepted purchase money after an explicit single-payment contradiction until explicit plan resolution", async () => {
    await capture(10, [purchase(5), line(1)]);
    await capture(11, [{ ...purchase(1), amountMinor: -15000 }]);
    expect((await parent()).amountMinor).toBe(-12500);
    await capture(12, [{ ...purchase(), amountMinor: -17000 }]);
    expect(await parent()).toMatchObject({
      installmentCount: 5,
      amountMinor: -12500,
    });
    expect((await parent()).sourceIssues).toContain(
      "conflicting_installment_plan",
    );
    await capture(13, [{ ...purchase(5), amountMinor: -17000 }]);
    expect((await parent()).amountMinor).toBe(-17000);
    expect((await parent()).sourceIssues).not.toContain(
      "conflicting_installment_plan",
    );
  });
});
