import { drizzle as libsqlDrizzle } from "drizzle-orm/libsql";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createApplication,
  inProcessInvoker,
} from "../../src/application/operations.js";
import { filtersSchema } from "../../src/application/query-inputs.js";
import { emptyDetails, unknownLedgerFacts } from "../../src/domain/model.js";
import type { Transaction } from "../../src/domain/records.js";
import * as postgresSchema from "../../src/storage/postgres/schema.js";
import { transactionListQuery as postgresListQuery } from "../../src/storage/postgres/statements.js";
import * as sqliteSchema from "../../src/storage/sqlite/schema.js";
import { transactionListQuery as sqliteListQuery } from "../../src/storage/sqlite/statements.js";
import { authorization, postingHarness } from "../helpers/posting.js";
import {
  backends,
  type Harness,
  insertTransactionFixture,
  open,
  row,
} from "../helpers/storage-harness.js";

/** Columns no list item presents; list reads must not transfer them. */
const unlistedColumns = [
  "provider_json",
  "additional_information_json",
  "source_refs_json",
  "source_evidence_json",
  "payment_context_conflicts_json",
  "rejected_posting_keys_json",
  "posting_overlap_json",
  "provider_identity_json",
  "provider_observations_json",
  "provider_monetary_evidence_json",
  "provider_billing_month_json",
  "provider_currency_mapping_json",
  "posting_link_json",
  "transaction_observations",
  "transaction_posting_links",
];

describe("transaction list statement", () => {
  const input = {
    ...filtersSchema.parse({ perspective: "billing", presence: "all" }),
    limit: 51,
  };
  it.each([
    [
      "postgres",
      () =>
        postgresListQuery(
          postgresDrizzle.mock({ schema: postgresSchema }),
          input,
        ).toSQL().sql,
    ],
    [
      "sqlite",
      () =>
        sqliteListQuery(
          libsqlDrizzle.mock({ schema: sqliteSchema }),
          input,
        ).toSQL().sql,
    ],
  ])("%s selects no retained evidence column", (_dialect, statement) => {
    const text = statement();
    expect(text).toContain("pending_posting_candidates_json");
    expect(text).toContain("data_json");
    for (const column of unlistedColumns) {
      expect(text).not.toContain(column);
    }
  });
});

for (const backend of backends) {
  describe(`transaction list projection: ${backend}`, () => {
    let db: Harness;
    let harness: ReturnType<typeof postingHarness>;
    beforeEach(async () => {
      db = await open(backend);
      harness = postingHarness(db);
      await db.ensureConnection({ id: harness.connectionId, provider: "cal" });
    });
    afterEach(() => db?.close());

    function stored(
      id: string,
      overrides: Partial<Transaction> = {},
    ): Transaction {
      return {
        id,
        connectionId: harness.connectionId,
        sourceScope: "account",
        sourceKey: id,
        sourceAliases: [],
        identityStrength: "native",
        status: "posted",
        presence: "seen",
        description: null,
        counterpartyName: null,
        kind: "purchase",
        merchantName: "Synthetic merchant",
        merchantProviderId: null,
        merchantCategoryCode: null,
        transactionDate: "2040-06-01",
        bookingDate: null,
        billingDate: null,
        amountMinor: -1000,
        currency: "ILS",
        amountBasis: "purchase_commitment",
        originalAmountMinor: null,
        originalCurrency: null,
        installmentCount: null,
        ...unknownLedgerFacts(null),
        details: {
          ...emptyDetails(),
          sourceRefs: [{ runId: "posting-2", path: `/${id}` }],
          provider: { synthetic: { retained: "r".repeat(2048) } },
        },
        firstSeenAt: "2040-07-02T12:00:00Z",
        lastSeenAt: "2040-07-02T12:00:00Z",
        lastSeenRunId: "posting-2",
        version: 1,
        supersededById: null,
        ...overrides,
      };
    }

    async function ledger() {
      // A pending authorization continued by its posted row, which supersedes
      // the separately created posted record.
      await harness.capture(2, [
        authorization("pending", { merchantName: "Shop B Testburg NLD" }),
      ]);
      const pending = await harness.byKey("pending");
      await db.editAnnotation({
        transactionId: pending.id,
        expectedVersion: 0,
        notes: "Shop A",
      });
      await harness.capture(3, [row("posted", { merchantName: "Shop B" })]);
      const rich = stored("rich", {
        transactionDate: "2040-06-05",
        originalAmountMinor: -900,
        originalCurrency: "EUR",
        fxFeeMinor: 30,
        fxFeeCurrency: "ILS",
        details: {
          ...stored("rich").details,
          transactionDateTime: "2040-06-05T10:11:12",
          merchant: {
            address: "1 Synthetic Way",
            phone: "000-0000",
            city: "Testburg",
            countryCode: "NLD",
          },
          currencyExchange: [
            {
              sourceCurrency: "EUR",
              targetCurrency: "ILS",
              unitCurrency: "EUR",
              exchangeRate: "3.9",
              quotationDate: "2040-06-05",
            },
          ],
          additionalInformation: ["Detail-only synthetic prose"],
        },
      });
      await insertTransactionFixture(db, [
        rich,
        stored("retired", { supersededById: "rich" }),
        stored("issue", {
          details: { ...stored("issue").details, issues: ["synthetic_issue"] },
        }),
        stored("candidate", {
          status: "pending",
          amountBasis: "authorization",
          details: {
            ...stored("candidate").details,
            pendingPostingCandidates: ["rich", "rich"],
          },
        }),
        stored("stale"),
        stored("absent", {
          presence: "not_returned",
          sourceAbsence: {
            runId: "posting-2",
            capturedAt: "2040-07-02T12:00:00Z",
          },
        }),
        stored("plan", { transactionDate: "2040-05-01", installmentCount: 3 }),
        stored("plan-1", {
          transactionDate: "2040-05-01",
          installmentCount: 3,
          installmentNumber: 1,
          purchaseId: "plan",
          amountMinor: -334,
          amountBasis: "booked_entry",
        }),
      ]);
      await db.editAnnotation({
        transactionId: "rich",
        expectedVersion: 0,
        notes: "Private synthetic note",
        category: "groceries",
        tags: ["b", "a"],
        metadata: { source: "synthetic" },
      });
      await db.editAnnotation({
        transactionId: "issue",
        expectedVersion: 0,
        expectedTransactionVersion: 1,
        review: { status: "needs_review" },
      });
      await db.editAnnotation({
        transactionId: "stale",
        expectedVersion: 0,
        expectedTransactionVersion: 1,
        review: { status: "approved" },
      });
      // The reviewed basis changes after approval.
      await insertTransactionFixture(
        db,
        [stored("stale", { amountMinor: -2000, version: 2 })],
        "update",
      );
      return { pending };
    }

    it("presents every list item exactly as the full read presents it", async () => {
      const { pending } = await ledger();
      const keys = new Map(
        (
          await db.listTransactions({
            connectionId: harness.connectionId,
            includeSuperseded: true,
          })
        ).map((transaction) => [transaction.id, transaction.sourceKey]),
      );
      const operations = inProcessInvoker(createApplication(db));
      const page = (await operations.invoke("list_transactions", {
        connectionId: harness.connectionId,
        perspective: "all",
        presence: "all",
        includeSuperseded: true,
        limit: 200,
      })) as {
        data: { id: string; supersededById: string | null }[];
        hasMore: boolean;
      };
      expect(page.hasMore).toBe(false);
      // Both posting records keep the posted source key.
      expect(page.data.map((item) => keys.get(item.id)).sort()).toEqual([
        "absent",
        "candidate",
        "issue",
        "plan",
        "plan-1",
        "posted",
        "posted",
        "retired",
        "rich",
        "stale",
      ]);
      const listed = new Map(page.data.map((item) => [item.id, item]));
      for (const item of page.data) {
        const full = (await operations.invoke("get_transaction", {
          transactionId: item.id,
          detail: false,
        })) as { transaction: unknown };
        expect(item).toEqual(full.transaction);
      }
      const unreviewed = {
        required: false,
        status: "unreviewed",
        stale: false,
      };
      expect(listed.get("rich")).toMatchObject({
        amount: { currency: "ILS", amount: "-10.00" },
        originalAmount: { currency: "EUR", amount: "-9.00" },
        fxFee: { currency: "ILS", amount: "0.30" },
        merchant: {
          name: "Synthetic merchant",
          addressLine: "1 Synthetic Way",
          city: "Testburg",
          phone: "000-0000",
          countryCode: "NLD",
        },
        transactionDateTime: "2040-06-05T10:11:12",
        currencyExchange: [
          {
            sourceCurrency: "EUR",
            targetCurrency: "ILS",
            unitCurrency: "EUR",
            exchangeRate: "3.9",
            quotationDate: "2040-06-05",
          },
        ],
        review: unreviewed,
        annotation: {
          version: 1,
          category: "groceries",
          tags: ["a", "b"],
          hasNotes: true,
          metadata: { source: "synthetic" },
        },
      });
      expect(listed.get("rich")).not.toHaveProperty("additionalInformation");
      expect(listed.get("retired")).toMatchObject({
        supersededById: "rich",
        review: unreviewed,
      });
      expect(listed.get("issue")).toMatchObject({
        review: { required: true, status: "needs_review", stale: false },
        annotation: { version: 1, hasNotes: false },
      });
      expect(listed.get("candidate")).toMatchObject({
        status: "pending",
        review: { required: true, status: "unreviewed", stale: false },
        annotation: null,
      });
      expect(listed.get("stale")).toMatchObject({
        amount: { currency: "ILS", amount: "-20.00" },
        review: { required: true, status: "stale", stale: true },
      });
      expect(listed.get("absent")).toMatchObject({
        presence: "not_returned",
        sourceAbsence: {
          runId: "posting-2",
          capturedAt: "2040-07-02T12:00:00Z",
        },
      });
      expect(listed.get("plan")).toMatchObject({
        installmentCount: 3,
        installmentNumber: null,
        purchaseId: null,
      });
      expect(listed.get("plan-1")).toMatchObject({
        installmentCount: 3,
        installmentNumber: 1,
        purchaseId: "plan",
        amountBasis: "booked_entry",
      });
      // The surviving record keeps the pending row's identity and annotation;
      // the separately created posted record is retired into it.
      const survivor = page.data.find((item) => item.id === pending.id);
      expect(survivor).toMatchObject({
        status: "posted",
        supersededById: null,
        annotation: { hasNotes: true },
      });
      expect(
        page.data.filter((item) => item.supersededById === pending.id),
      ).toHaveLength(1);
    });

    it("returns list rows without evidence the list never presents", async () => {
      await ledger();
      const { transactions } = await db.listTransactionPage({
        connectionId: harness.connectionId,
        perspective: "all",
        presence: "all",
        includeSuperseded: true,
        limit: 200,
      });
      const rich = transactions.find((item) => item.id === "rich")!;
      for (const omitted of ["lastSeenAt", "lastSeenRunId", "sourceEvidence"]) {
        expect(rich).not.toHaveProperty(omitted);
      }
      expect(Object.keys(rich.details).sort()).toEqual([
        "currencyExchange",
        "issues",
        "merchant",
        "transactionDateTime",
      ]);
      expect(
        transactions.find((item) => item.id === "candidate"),
      ).toMatchObject({
        details: { pendingPostingCandidates: ["rich", "rich"] },
        pendingPostingCandidates: ["rich"],
        reviewRequired: true,
      });
    });
  });
}
