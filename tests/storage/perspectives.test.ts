import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplication } from "../../src/application/operations.js";
import { presentWireEvent } from "../../src/application/wire-output.js";
import { ConflictError } from "../../src/domain/errors.js";
import type { TransactionInput } from "../../src/domain/model.js";
import {
  billedLinesByPurchase,
  inPerspective,
  PERSPECTIVES,
  type TransactionView,
} from "../../src/domain/read-model.js";
import { authorization, postingHarness } from "../helpers/posting.js";
import {
  backends,
  type Harness,
  open,
  row,
  sourceKeysOf,
  synthetic,
} from "../helpers/storage-harness.js";

/** A three-payment plan: its purchase and one billed line per payment. */
function plan(key: string, ordinals: number[], fields = {}) {
  return [
    row(key, { installmentCount: 3, ...fields }),
    ...ordinals.map((ordinal) =>
      row(`${key}:line:${ordinal}`, {
        amountBasis: "booked_entry",
        amountMinor: ordinal === 1 ? -34 : -33,
        installmentCount: 3,
        installmentNumber: ordinal,
        purchaseKey: key,
        billingDate: `2040-0${ordinal + 6}-10`,
      }),
    ),
  ];
}

describe.each(backends)("%s continuation and perspectives", (backend) => {
  let db: Harness;
  let harness: ReturnType<typeof postingHarness>;
  beforeEach(async () => {
    db = await open(backend);
    harness = postingHarness(db);
    await db.ensureConnection({ id: harness.connectionId, provider: "cal" });
  });
  afterEach(() => db.close());

  const operation = (name: string) =>
    createApplication(db).operations.find((value) => value.name === name)!;
  const linesOf = async (purchaseId: string) =>
    (await db.listTransactions())
      .filter((item) => item.purchaseId === purchaseId)
      .map((item) => item.sourceKey)
      .sort();

  it("retargets lines on link, resolves later lines to the survivor and returns them on unlink after a refresh", async () => {
    const pending = authorization("auth", { amountMinor: -100 });
    await harness.capture(1, [pending, ...plan("plan", [1])]);
    const auth = await harness.byKey("auth");
    const posted = await harness.byKey("plan");
    const line = await harness.byKey("plan:line:1");
    expect(line.purchaseId).toBe(posted.id);

    await db.linkPendingTransaction(await harness.command(auth.id, posted.id));
    expect(await linesOf(auth.id)).toEqual(["plan:line:1"]);
    expect(await db.getTransaction(line.id)).toMatchObject({
      purchaseId: auth.id,
      version: line.version + 1,
    });
    const retarget = (await db.listEvents()).filter(
      (event) =>
        event.transactionId === line.id && event.type === "transaction.updated",
    );
    expect(
      retarget.map((event) => presentWireEvent(event).changedFields),
    ).toEqual([["purchaseId"]]);

    // A refresh adds line 2: it resolves to the current survivor.
    await harness.capture(2, [...plan("plan", [1, 2])]);
    expect(await linesOf(auth.id)).toEqual(["plan:line:1", "plan:line:2"]);

    const survivor = (await db.getTransaction(auth.id))!;
    await db.unlinkPendingTransaction(
      await harness.command(survivor.id, posted.id),
    );
    expect(await linesOf(posted.id)).toEqual(["plan:line:1", "plan:line:2"]);
    expect(await linesOf(auth.id)).toEqual([]);
    // The revived posted purchase keeps resolving for later captures.
    await harness.capture(3, [...plan("plan", [1, 2, 3])]);
    expect(await linesOf(posted.id)).toEqual([
      "plan:line:1",
      "plan:line:2",
      "plan:line:3",
    ]);
  });

  it("resolves a line to the survivor when its purchase continues a pending row in the same capture", async () => {
    await harness.capture(2, [authorization("auth")]);
    const auth = await harness.byKey("auth");
    await harness.capture(3, [
      row("posted"),
      row("posted:line:1", {
        amountBasis: "booked_entry",
        installmentNumber: 1,
        purchaseKey: "posted",
      }),
    ]);
    const survivor = await harness.byKey("posted");
    expect(survivor.id).toBe(auth.id);
    const line = await harness.byKey("posted:line:1");
    expect(line.purchaseId).toBe(auth.id);
    expect(line.sourceIssues).not.toContain("unresolved_purchase");
    expect(
      (
        await db.listTransactionPage({
          connectionId: harness.connectionId,
          limit: 200,
        })
      ).transactions.map((item) => item.id),
    ).not.toContain(line.id);
  });

  it("never matches, suggests or links billed lines", async () => {
    // The line has the pending row's card, date, merchant and money.
    await harness.capture(1, [
      authorization("auth", { amountMinor: -34 }),
      ...plan("plan", [1]),
    ]);
    const auth = await harness.byKey("auth");
    const line = await harness.byKey("plan:line:1");
    expect(line.pendingPostingCandidates).toEqual([]);
    expect(auth.pendingPostingCandidates).not.toContain(line.id);
    await expect(
      db.linkPendingTransaction(await harness.command(auth.id, line.id)),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("selects the same members in SQL as the domain rule, including null facts", async () => {
    await db.ingestRun(
      {
        connectionId: harness.connectionId,
        runId: "roles",
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:cal/recent",
            capturedAt: "2040-07-01T00:00:00Z",
            responseText: JSON.stringify([
              row("unknown-count"),
              row("single-payment", { installmentCount: 1 }),
              row("zero-count", { installmentCount: 0 }),
              row("standalone-line", {
                amountBasis: "booked_entry",
                installmentCount: 3,
                installmentNumber: 2,
              }),
              ...plan("plan", [1, 2]),
            ] satisfies TransactionInput[]),
          },
        ],
      },
      synthetic,
    );
    const every = await db.listTransactions({ perspective: "all" });
    expect(every).toHaveLength(7);
    for (const perspective of PERSPECTIVES) {
      const page = await db.listTransactionPage({
        connectionId: harness.connectionId,
        perspective,
        limit: 200,
      });
      expect((await sourceKeysOf(db, page.transactions)).sort()).toEqual(
        every
          .filter((item) =>
            inPerspective(
              item,
              perspective,
              billedLinesByPurchase(every).has(item.id),
            ),
          )
          .map((item) => item.sourceKey)
          .sort(),
      );
    }
    expect(
      (
        await sourceKeysOf(
          db,
          (await db.listTransactionPage({ perspective: "billing", limit: 200 }))
            .transactions,
        )
      ).sort(),
    ).toEqual([
      "plan:line:1",
      "plan:line:2",
      "single-payment",
      "standalone-line",
      "unknown-count",
      "zero-count",
    ]);
  });

  it("keeps list and totals parity and rejects totals over every row", async () => {
    await harness.capture(1, [
      row("single", { amountMinor: -500 }),
      authorization("auth", { merchantName: "Other", amountMinor: -7 }),
      ...plan("plan", [1, 2, 3]),
    ]);
    const list = operation("list_transactions");
    const totals = operation("get_transaction_totals");
    const connectionId = harness.connectionId;
    const sum = (page: { data: { amount: { amount: string } | null }[] }) =>
      page.data.reduce(
        (total, item) =>
          total + Math.round(Number(item.amount?.amount ?? 0) * 100),
        0,
      );
    const spending = (await list.execute({ connectionId })) as {
      data: { amount: { amount: string } | null; status: string }[];
    };
    const billing = (await list.execute({
      connectionId,
      perspective: "billing",
    })) as typeof spending;
    const posted = (page: typeof spending) => ({
      data: page.data.filter((item) => item.status === "posted"),
    });
    expect(await totals.execute({ connectionId })).toMatchObject({
      totals: [
        {
          currency: "ILS",
          amountBasis: "purchase_commitment",
          amount: "-6.00",
        },
      ],
      fxFees: [],
      fxFeeUnknownCount: 0,
      includedCount: 2,
      excludedCount: 1,
    });
    expect(sum(posted(spending))).toBe(-600);
    // Billing: one group per currency, the plan counted through its lines.
    expect(
      await totals.execute({ connectionId, perspective: "billing" }),
    ).toEqual({
      totals: [{ currency: "ILS", amount: "-6.00" }],
      fxFees: [],
      fxFeeUnknownCount: 0,
      includedCount: 4,
      excludedCount: 1,
      excluded: {
        pending: 1,
        authorization: 0,
        transferOrIncome: 0,
        retiredOrRemoved: 0,
        sourceAbsent: 0,
        unresolved: 0,
      },
    });
    expect(sum(posted(billing))).toBe(-600);
    expect(spending.data).toHaveLength(3);
    expect(billing.data).toHaveLength(5);
    await expect(
      totals.execute({ connectionId, perspective: "all" }),
    ).rejects.toThrow();
    await expect(db.getTotals({ perspective: "all" })).rejects.toThrow();
    const purchase = await harness.byKey("plan");
    await expect(
      list.execute({ connectionId, purchaseId: purchase.id }),
    ).rejects.toThrow();
    expect(
      (await list.execute({
        connectionId,
        perspective: "all",
        purchaseId: purchase.id,
      })) as { data: unknown[] },
    ).toMatchObject({ data: { length: 3 } });
  });

  it("pages by keyset across ties and into unknown dates without gaps or repeats", async () => {
    const rows = [
      ...["c", "a", "b"].map((key) =>
        row(`tie-${key}`, { transactionDate: "2040-07-02" }),
      ),
      row("later", { transactionDate: "2040-07-03" }),
      row("earlier", { transactionDate: "2040-07-01" }),
      ...["y", "x"].map((key) =>
        row(`undated-${key}`, { transactionDate: null }),
      ),
    ];
    await harness.capture(1, rows);
    const every = await db.listTransactions();
    const expected = [...every]
      .sort(
        (left, right) =>
          (right.transactionDate ?? "").localeCompare(
            left.transactionDate ?? "",
          ) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )
      .map((item) => item.id);
    expect(every.at(-1)?.transactionDate).toBeNull();
    const list = operation("list_transactions");
    for (const limit of [1, 2, 3]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = (await list.execute({
          connectionId: harness.connectionId,
          limit,
          ...(cursor ? { cursor } : {}),
        })) as {
          data: TransactionView[];
          hasMore: boolean;
          nextCursor: string | null;
        };
        seen.push(...page.data.map((item) => item.id));
        expect(page.hasMore).toBe(page.nextCursor !== null);
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor !== undefined && pages < 20);
      expect(seen).toEqual(expected);
    }
  });
});
