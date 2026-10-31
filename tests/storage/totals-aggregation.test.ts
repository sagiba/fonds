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
import { totalsParts as postgresTotals } from "../../src/storage/postgres/statements.js";
import * as sqliteSchema from "../../src/storage/sqlite/schema.js";
import { totalsParts as sqliteTotals } from "../../src/storage/sqlite/statements.js";
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
