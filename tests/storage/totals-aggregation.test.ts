import { getTableColumns } from "drizzle-orm";
import { drizzle as libsqlDrizzle } from "drizzle-orm/libsql";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createApplication,
  inProcessInvoker,
} from "../../src/application/operations.js";
import { filtersSchema } from "../../src/application/query-inputs.js";
import { calculateTotals } from "../../src/domain/read-model.js";
import * as postgresSchema from "../../src/storage/postgres/schema.js";
import {
  groupedTotals as postgresGrouped,
  totalsParts as postgresTotals,
} from "../../src/storage/postgres/statements.js";
import * as sqliteSchema from "../../src/storage/sqlite/schema.js";
import {
  groupedTotals as sqliteGrouped,
  totalsParts as sqliteTotals,
} from "../../src/storage/sqlite/statements.js";
import { seedRun, storedRow } from "../helpers/ledger-rows.js";
import {
  backends,
  type Harness,
  insertTransactionFixture,
  open,
} from "../helpers/storage-harness.js";

/** Row columns an aggregate never needs to return. */
const rowColumns = [
  '"id"',
  "merchant_name",
  "description",
  "provider_json",
  "data_json",
  "source_aliases_json",
];

describe("totals statement", () => {
  it.each([
    [
      "postgres",
      (perspective: "spending" | "billing") =>
        postgresTotals(postgresDrizzle.mock({ schema: postgresSchema }), {
          ...filtersSchema.parse({ perspective }),
          perspective,
        }).toSQL().sql,
    ],
    [
      "sqlite",
      (perspective: "spending" | "billing") =>
        sqliteTotals(libsqlDrizzle.mock({ schema: sqliteSchema }), {
          ...filtersSchema.parse({ perspective }),
          perspective,
        }).toSQL().sql,
    ],
  ])("%s aggregates in SQL instead of returning rows", (_dialect, text) => {
    for (const perspective of ["spending", "billing"] as const) {
      const statement = text(perspective);
      expect(statement).toMatch(/group by/i);
      expect(statement).toContain("sum(");
      const selected = statement.slice(0, statement.search(/ from /i));
      for (const column of rowColumns) {
        expect(selected).not.toContain(column);
      }
    }
  });
});

describe("grouped totals statement", () => {
  const input = {
    ...filtersSchema.parse({}),
    perspective: "spending" as const,
  };
  it.each([
    [
      "postgres",
      () =>
        postgresGrouped(
          postgresDrizzle.mock({ schema: postgresSchema }),
          input,
          "merchant",
          501,
        ).toSQL().sql,
    ],
    [
      "sqlite",
      () =>
        sqliteGrouped(
          libsqlDrizzle.mock({ schema: sqliteSchema }),
          input,
          "merchant",
          501,
        ).toSQL().sql,
    ],
  ])("%s groups and ranks in SQL without row documents", (_dialect, text) => {
    const statement = text();
    expect(statement).toMatch(/group by/i);
    expect(statement).toContain("dense_rank()");
    for (const column of [
      "provider_json",
      "description",
      "data_json",
      "source_aliases_json",
      "additional_information_json",
    ]) {
      expect(statement).not.toContain(column);
    }
  });
});

for (const backend of backends) {
  describe(`totals aggregation: ${backend}`, () => {
    let db: Harness;
    let invoke: (name: string, input: unknown) => Promise<unknown>;
    const connectionId = "totals";
    const row = (id: string, overrides: Parameters<typeof storedRow>[2]) =>
      storedRow(connectionId, id, overrides);

    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({ id: connectionId, provider: "cal" });
      await seedRun(db, connectionId);
      await insertTransactionFixture(db, [
        row("plan", {
          merchantName: "Furniture",
          transactionDate: "2040-05-03",
          amountMinor: -30000,
          installmentCount: 3,
        }),
        row("plan-1", {
          merchantName: "Furniture",
          transactionDate: "2040-05-03",
          billingDate: "2040-06-02",
          amountMinor: -10000,
          amountBasis: "booked_entry",
          installmentCount: 3,
          installmentNumber: 1,
          purchaseId: "plan",
        }),
        row("plan-2", {
          merchantName: "Furniture",
          transactionDate: "2040-05-03",
          billingDate: "2040-07-02",
          amountMinor: -10000,
          amountBasis: "booked_entry",
          installmentCount: 3,
          installmentNumber: 2,
          purchaseId: "plan",
        }),
        row("coffee", {
          merchantName: "Coffee",
          transactionDate: "2040-06-05",
          amountMinor: -1250,
        }),
        row("coffee-refund", {
          merchantName: "Coffee",
          transactionDate: "2040-06-07",
          kind: "refund",
          amountMinor: 250,
        }),
        row("abroad", {
          merchantName: "Abroad",
          transactionDate: "2040-06-09",
          amountMinor: -4030,
          originalAmountMinor: -1000,
          originalCurrency: "USD",
          fxFeeMinor: -30,
          fxFeeCurrency: "ILS",
        }),
        row("abroad-unknown-fee", {
          merchantName: "Abroad",
          transactionDate: "2040-06-10",
          amountMinor: -2000,
          originalAmountMinor: -500,
          originalCurrency: "USD",
        }),
        row("dollars", {
          merchantName: "Abroad",
          transactionDate: "2040-06-11",
          currency: "USD",
          amountMinor: -999,
          amountBasis: "booked_entry",
        }),
        row("pending", { status: "pending", amountBasis: "authorization" }),
        row("held", { amountBasis: "authorization" }),
        row("transfer", { kind: "transfer", amountBasis: "booked_entry" }),
        row("unknown-basis", { amountBasis: "unknown" }),
        row("ambiguous", { identityStrength: "ambiguous" }),
        row("removed", { presence: "removed" }),
        row("retired", { supersededById: "coffee" }),
        row("absent", {
          presence: "not_returned",
          sourceAbsence: {
            runId: "seed-run",
            capturedAt: "2040-07-02T12:00:00Z",
          },
        }),
      ]);
      invoke = inProcessInvoker(createApplication(db)).invoke;
    });
    afterEach(() => db?.close());

    const history = { presence: "all", includeSuperseded: true } as const;

    it("sums each currency and basis exactly with every exclusion bucket", async () => {
      expect(await invoke("get_transaction_totals", history)).toEqual({
        totals: [
          {
            currency: "USD",
            amount: "-9.99",
            amountBasis: "booked_entry",
          },
          {
            currency: "ILS",
            amount: "-370.30",
            amountBasis: "purchase_commitment",
          },
        ],
        fxFees: [{ currency: "ILS", amount: "-0.30" }],
        fxFeeUnknownCount: 1,
        includedCount: 6,
        excludedCount: 8,
        excluded: {
          pending: 1,
          transferOrIncome: 1,
          retiredOrRemoved: 2,
          sourceAbsent: 1,
          unresolved: 2,
          authorization: 1,
        },
      });
      expect(
        await invoke("get_transaction_totals", {
          ...history,
          perspective: "billing",
        }),
      ).toEqual({
        totals: [
          { currency: "ILS", amount: "-270.30" },
          { currency: "USD", amount: "-9.99" },
        ],
        fxFees: [{ currency: "ILS", amount: "-0.30" }],
        fxFeeUnknownCount: 1,
        includedCount: 7,
        excludedCount: 8,
        excluded: {
          pending: 1,
          transferOrIncome: 1,
          retiredOrRemoved: 2,
          sourceAbsent: 1,
          unresolved: 2,
          authorization: 1,
        },
      });
    });

    const grouped = (input: object) =>
      invoke("get_transaction_totals", input) as Promise<{
        groups: unknown[];
        truncated: boolean;
      }>;

    it("groups included money by merchant, busiest first", async () => {
      expect(await grouped({ groupBy: "merchant" })).toEqual({
        groupBy: "merchant",
        groups: [
          {
            key: "Abroad",
            includedCount: 3,
            totals: [
              {
                currency: "USD",
                amount: "-9.99",
                amountBasis: "booked_entry",
                count: 1,
                min: "-9.99",
                max: "-9.99",
              },
              {
                currency: "ILS",
                amount: "-60.30",
                amountBasis: "purchase_commitment",
                count: 2,
                min: "-40.30",
                max: "-20.00",
              },
            ],
          },
          {
            key: "Coffee",
            includedCount: 2,
            totals: [
              {
                currency: "ILS",
                amount: "-10.00",
                amountBasis: "purchase_commitment",
                count: 2,
                min: "-12.50",
                max: "2.50",
              },
            ],
          },
          {
            key: "Furniture",
            includedCount: 1,
            totals: [
              {
                currency: "ILS",
                amount: "-300.00",
                amountBasis: "purchase_commitment",
                count: 1,
                min: "-300.00",
                max: "-300.00",
              },
            ],
          },
        ],
        truncated: false,
      });
    });

    it("groups billed money by the month of the chosen date role", async () => {
      expect(
        await grouped({ groupBy: "month", perspective: "billing" }),
      ).toEqual({
        groupBy: "month",
        groups: [
          {
            key: "2040-06",
            includedCount: 5,
            totals: [
              {
                currency: "ILS",
                amount: "-70.30",
                count: 4,
                min: "-40.30",
                max: "2.50",
              },
              {
                currency: "USD",
                amount: "-9.99",
                count: 1,
                min: "-9.99",
                max: "-9.99",
              },
            ],
          },
          {
            key: "2040-05",
            includedCount: 2,
            totals: [
              {
                currency: "ILS",
                amount: "-200.00",
                count: 2,
                min: "-100.00",
                max: "-100.00",
              },
            ],
          },
        ],
        truncated: false,
      });
      const byBilling = (await grouped({
        groupBy: "month",
        perspective: "billing",
        dateRole: "billing",
      })) as { groups: { key: string | null; includedCount: number }[] };
      expect(
        byBilling.groups.map(({ key, includedCount }) => [key, includedCount]),
      ).toEqual([
        [null, 5],
        ["2040-06", 1],
        ["2040-07", 1],
      ]);
    });

    it("groups by category, card, kind, status and year", async () => {
      await db.editAnnotation({
        transactionId: "coffee",
        expectedVersion: 0,
        category: "eating out",
      });
      for (const transactionId of ["abroad", "abroad-unknown-fee"]) {
        await db.editAnnotation({
          transactionId,
          expectedVersion: 0,
          category: "travel",
          notes: "Private synthetic note",
        });
      }
      await db.editAnnotation({
        transactionId: "dollars",
        expectedVersion: 0,
        tags: ["synthetic"],
      });
      const keys = async (groupBy: string) =>
        (
          (await grouped({ groupBy })) as {
            groups: { key: string | null; includedCount: number }[];
          }
        ).groups.map(({ key, includedCount }) => [key, includedCount]);
      expect(await keys("category")).toEqual([
        [null, 3],
        ["travel", 2],
        ["eating out", 1],
      ]);
      expect(await keys("kind")).toEqual([
        ["purchase", 5],
        ["refund", 1],
      ]);
      expect(await keys("status")).toEqual([["posted", 6]]);
      expect(await keys("year")).toEqual([["2040", 6]]);

      await db.recordCardDiscovery(connectionId, {
        observedAt: "2040-07-02T12:00:00Z",
        cards: [
          { cardKey: "card-a", last4: "1111" },
          { cardKey: "card-b", last4: "2222" },
        ],
      });
      const { cards } = await db.listCards({ connectionId });
      const [a, b] = ["1111", "2222"].map(
        (last4) => cards.find((card) => card.last4 === last4)!.id,
      );
      for (const [cardId, ids] of [
        [a, ["coffee", "coffee-refund"]],
        [b, ["abroad"]],
      ] as const) {
        for (const id of ids) {
          await db.raw("UPDATE transactions SET card_id = ? WHERE id = ?", [
            cardId,
            id,
          ]);
        }
      }
      expect(await keys("card")).toEqual([
        [null, 3],
        [a, 2],
        [b, 1],
      ]);
    });

    it("sums exactly when an intermediate total passes 64 bits before rows cancel", async () => {
      await insertTransactionFixture(db, [
        row("template", { merchantName: "Cancelling", presence: "removed" }),
      ]);
      // 1,025 maximal outflows' worth of inflows, then as many outflows,
      // inserted in that order: a 64-bit running sum overflows midway.
      const schema =
        db.driver.kind === "postgres" ? postgresSchema : sqliteSchema;
      const columns = Object.values(getTableColumns(schema.transactions))
        .map((column) => column.name)
        .filter((name) => name !== "ingestion_order");
      const value = (name: string) =>
        ({
          id: "'cancel-' || n.i",
          source_key: "'cancel-' || n.i",
          presence: "'seen'",
          amount_minor: `case when n.i <= 1025 then ${Number.MAX_SAFE_INTEGER} else -${Number.MAX_SAFE_INTEGER} end`,
        })[name] ?? `t."${name}"`;
      await db.raw(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2050)
         INSERT INTO transactions (${columns.map((name) => `"${name}"`).join(", ")})
         SELECT ${columns.map(value).join(", ")}
         FROM transactions t CROSS JOIN n WHERE t.id = 'template'`,
      );
      const filters = { merchantName: "Cancelling" };
      expect(await invoke("get_transaction_totals", filters)).toEqual({
        totals: [
          {
            currency: "ILS",
            amount: "0.00",
            amountBasis: "purchase_commitment",
          },
        ],
        fxFees: [],
        fxFeeUnknownCount: 0,
        includedCount: 2050,
        excludedCount: 0,
        excluded: {
          pending: 0,
          transferOrIncome: 0,
          retiredOrRemoved: 0,
          sourceAbsent: 0,
          unresolved: 0,
          authorization: 0,
        },
      });
      expect(
        await invoke("get_transaction_totals", {
          ...filters,
          groupBy: "merchant",
        }),
      ).toEqual({
        groupBy: "merchant",
        groups: [
          {
            key: "Cancelling",
            includedCount: 2050,
            totals: [
              {
                currency: "ILS",
                amount: "0.00",
                amountBasis: "purchase_commitment",
                count: 2050,
                min: "-90071992547409.91",
                max: "90071992547409.91",
              },
            ],
          },
        ],
        truncated: false,
      });
    });

    it("bounds the groups and reports truncation", async () => {
      const result = await db.getGroupedTotals({}, "merchant", 2);
      expect(result.groups.map((group) => group.key)).toEqual([
        "Abroad",
        "Coffee",
      ]);
      expect(result.truncated).toBe(true);
      expect((await db.getGroupedTotals({}, "merchant", 3)).truncated).toBe(
        false,
      );
    });

    it("agrees with the row-by-row reference for every perspective", async () => {
      const rows = await db.listTransactions(history);
      for (const perspective of ["spending", "billing"] as const) {
        const members = await db.listTransactions({ ...history, perspective });
        expect(await db.getTotals({ ...history, perspective })).toEqual(
          calculateTotals(
            rows.filter((candidate) =>
              members.some((member) => member.id === candidate.id),
            ),
            perspective,
          ),
        );
      }
    });
  });
}
