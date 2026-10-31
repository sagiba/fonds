import { drizzle as libsqlDrizzle } from "drizzle-orm/libsql";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createApplication,
  inProcessInvoker,
} from "../../src/application/operations.js";
import { filtersSchema } from "../../src/application/query-inputs.js";
import * as postgresSchema from "../../src/storage/postgres/schema.js";
import { transactionSummaryPage as postgresSummaryPage } from "../../src/storage/postgres/statements.js";
import * as sqliteSchema from "../../src/storage/sqlite/schema.js";
import { transactionSummaryPage as sqliteSummaryPage } from "../../src/storage/sqlite/statements.js";
import { seedRun, storedRow } from "../helpers/ledger-rows.js";
import {
  backends,
  type Harness,
  insertTransactionFixture,
  open,
} from "../helpers/storage-harness.js";

/** Columns a summary item never presents; its read must not transfer them. */
const heavyColumns = [
  "description",
  "source_key",
  "source_aliases_json",
  "provider_json",
  "additional_information_json",
  "currency_exchange_json",
  "source_issues_json",
  "merchant_address_line",
  "transaction_reconciliation",
  "transaction_observations",
  "transaction_posting_links",
  "pending_posting_candidates_json",
  "source_evidence_json",
];

describe("transaction summary statement", () => {
  const input = {
    ...filtersSchema.parse({ merchantContains: "shop" }),
    limit: 51,
  };
  it.each([
    [
      "postgres",
      () =>
        postgresSummaryPage(
          postgresDrizzle.mock({ schema: postgresSchema }),
          input,
        ).toSQL().sql,
    ],
    [
      "sqlite",
      () =>
        sqliteSummaryPage(
          libsqlDrizzle.mock({ schema: sqliteSchema }),
          input,
        ).toSQL().sql,
    ],
  ])("%s projects only summary columns and the category", (_dialect, text) => {
    const statement = text();
    expect(statement).toContain("category");
    for (const column of heavyColumns) {
      expect(statement).not.toContain(column);
    }
    // The annotation document is addressed, never selected whole.
    expect(statement).not.toMatch(/"data_json"\s*(,|from)/i);
  });
});

for (const backend of backends) {
  describe(`transaction summary and filters: ${backend}`, () => {
    let db: Harness;
    let invoke: (name: string, input: unknown) => Promise<unknown>;
    const connectionId = "summary";
    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({ id: connectionId, provider: "cal" });
      await seedRun(db, connectionId);
      await insertTransactionFixture(db, [
        storedRow(connectionId, "coffee", {
          transactionDate: "2040-06-05",
          bookingDate: "2040-06-06",
          billingDate: "2040-07-02",
          merchantName: "Coffee SHOP Testburg",
          merchantCategoryCode: "5814",
          amountMinor: -1250,
        }),
        storedRow(connectionId, "transfer", {
          transactionDate: "2040-06-04",
          merchantName: null,
          counterpartyName: "Synthetic Shopkeeper",
          kind: "transfer",
          amountBasis: "booked_entry",
          amountMinor: -50000,
        }),
        storedRow(connectionId, "percent", {
          transactionDate: "2040-06-03",
          merchantName: "100% Deals_Store",
          amountMinor: -9999,
        }),
        storedRow(connectionId, "euro", {
          transactionDate: "2040-06-02",
          merchantName: "Shop abroad",
          currency: "EUR",
          amountMinor: -2000,
        }),
        storedRow(connectionId, "refund", {
          transactionDate: "2040-06-01",
          merchantName: "Coffee Shop Testburg",
          kind: "refund",
          amountMinor: 500,
        }),
      ]);
      await db.editAnnotation({
        transactionId: "coffee",
        expectedVersion: 0,
        notes: "Private synthetic note",
        category: "eating out",
      });
      await db.editAnnotation({
        transactionId: "refund",
        expectedVersion: 0,
        tags: ["synthetic"],
      });
      invoke = inProcessInvoker(createApplication(db)).invoke;
    });
    afterEach(() => db?.close());

    const ids = (page: unknown) =>
      (page as { data: { id: string }[] }).data.map((item) => item.id);

    it("returns lean summary items with the owner's category", async () => {
      const page = (await invoke("list_transactions", {
        connectionId,
        view: "summary",
        limit: 2,
      })) as { data: unknown[]; hasMore: boolean; nextCursor: string };
      expect(page.data).toEqual([
        {
          id: "coffee",
          transactionDate: "2040-06-05",
          bookingDate: "2040-06-06",
          billingDate: "2040-07-02",
          merchantName: "Coffee SHOP Testburg",
          counterpartyName: null,
          merchantCategoryCode: "5814",
          amount: { currency: "ILS", amount: "-12.50" },
          amountBasis: "purchase_commitment",
          kind: "purchase",
          status: "posted",
          presence: "seen",
          category: "eating out",
        },
        {
          id: "transfer",
          transactionDate: "2040-06-04",
          bookingDate: null,
          billingDate: null,
          merchantName: null,
          counterpartyName: "Synthetic Shopkeeper",
          merchantCategoryCode: null,
          amount: { currency: "ILS", amount: "-500.00" },
          amountBasis: "booked_entry",
          kind: "transfer",
          status: "posted",
          presence: "seen",
          category: null,
        },
      ]);
      expect(page.hasMore).toBe(true);
      // The cursor continues in either view.
      const next = await invoke("list_transactions", {
        connectionId,
        cursor: page.nextCursor,
      });
      expect(ids(next)).toEqual(["percent", "euro", "refund"]);
      const refund = (await invoke("list_transactions", {
        connectionId,
        view: "summary",
        merchantContains: "coffee",
        kind: "refund",
      })) as { data: { category: string | null }[] };
      // An annotation without a category has none.
      expect(refund.data).toEqual([
        expect.objectContaining({ id: "refund", category: null }),
      ]);
    });

    it("matches merchant and counterparty substrings literally and without ASCII case", async () => {
      expect(
        ids(await invoke("list_transactions", { merchantContains: "SHOP" })),
      ).toEqual(["coffee", "transfer", "euro", "refund"]);
      expect(
        ids(await invoke("list_transactions", { merchantContains: "0% d" })),
      ).toEqual(["percent"]);
      // % and _ are text, not wildcards.
      expect(
        ids(await invoke("list_transactions", { merchantContains: "%" })),
      ).toEqual(["percent"]);
      expect(
        ids(await invoke("list_transactions", { merchantContains: "s_o" })),
      ).toEqual([]);
      expect(
        ids(await invoke("list_transactions", { merchantContains: "s_s" })),
      ).toEqual(["percent"]);
    });

    it("bounds signed amounts exactly in the filter currency", async () => {
      expect(
        ids(
          await invoke("list_transactions", {
            currency: "ILS",
            amountMin: "-99.99",
            amountMax: "-12.5",
          }),
        ),
      ).toEqual(["coffee", "percent"]);
      expect(
        ids(
          await invoke("list_transactions", {
            currency: "EUR",
            amountMax: "-20.00",
          }),
        ),
      ).toEqual(["euro"]);
      expect(
        ids(
          await invoke("list_transactions", {
            currency: "ILS",
            amountMin: "0",
          }),
        ),
      ).toEqual(["refund"]);
      for (const invalid of [
        { amountMin: "-10.00" },
        { currency: "ILS", amountMin: "-10.001" },
        { currency: "ILS", amountMin: "-1.00", amountMax: "-2.00" },
        { currency: "ILS", amountMin: "1e3" },
      ]) {
        await expect(invoke("list_transactions", invalid)).rejects.toThrow();
      }
      // Totals share the filters.
      expect(
        await invoke("get_transaction_totals", {
          currency: "ILS",
          merchantContains: "coffee",
          amountMax: "-1.00",
        }),
      ).toMatchObject({
        totals: [
          {
            currency: "ILS",
            amountBasis: "purchase_commitment",
            amount: "-12.50",
          },
        ],
        includedCount: 1,
      });
    });

    it("echoes the filters each page applied, defaults included", async () => {
      expect(
        await invoke("list_transactions", {
          connectionId,
          dateRole: "booking",
          from: "2040-06-01",
          merchantContains: "coffee",
          view: "summary",
        }),
      ).toMatchObject({
        filters: {
          connectionId,
          dateRole: "booking",
          from: "2040-06-01",
          merchantContains: "coffee",
          presence: "current",
          includeSuperseded: false,
          perspective: "spending",
        },
      });
      const page = (await invoke("list_transactions", {})) as {
        filters: object;
      };
      expect(page.filters).toEqual({
        presence: "current",
        includeSuperseded: false,
        perspective: "spending",
      });
    });
  });
}
