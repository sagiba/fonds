import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TransactionFilters } from "../../src/application/query-inputs.js";
import {
  backends,
  type Harness,
  open,
  row,
  sourceKeysOf,
  synthetic,
} from "../helpers/storage-harness.js";

for (const backend of backends) {
  describe(`financial read scopes: ${backend}`, () => {
    let db: Harness;
    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
      await db.recordCardDiscovery("synthetic", {
        observedAt: "2040-08-01T00:00:00Z",
        cards: [
          {
            cardKey: "card",
            last4: null,
            billingAccount: { providerKey: "a" },
          },
          {
            cardKey: "other",
            last4: null,
            billingAccount: { providerKey: "a" },
          },
          {
            cardKey: "other-account-card",
            last4: null,
            billingAccount: { providerKey: "b" },
          },
        ],
      });
      const selected = row("selected", {
        transactionDate: "2040-07-01",
        bookingDate: "2040-07-03",
        billingDate: "2040-08-01",
      });
      await db.ingestRun(
        {
          connectionId: "synthetic",
          runId: "baseline",
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:scopes",
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: JSON.stringify([
                selected,
                {
                  ...selected,
                  sourceKey: "other-account",
                  cardKey: "other-account-card",
                },
                { ...selected, sourceKey: "other-card", cardKey: "other" },
                { ...selected, sourceKey: "other-currency", currency: "USD" },
                {
                  ...selected,
                  sourceKey: "other-role",
                  amountBasis: "booked_entry",
                },
                {
                  ...selected,
                  sourceKey: "other-kind",
                  kind: "refund",
                  amountMinor: 100,
                },
                {
                  ...selected,
                  sourceKey: "other-name",
                  merchantName: "Other",
                },
                {
                  ...selected,
                  sourceKey: "other-date",
                  bookingDate: "2040-07-02",
                },
                { ...selected, sourceKey: "unknown-date", bookingDate: null },
                {
                  ...selected,
                  sourceKey: "pending",
                  status: "pending",
                  amountBasis: "authorization",
                },
              ]),
            },
          ],
        },
        synthetic,
      );
    });
    afterEach(async () => db?.close());

    it("applies the identical declared account, card, money, lifecycle and date scope to lists and totals", async () => {
      const cards = (await db.listCards({ connectionId: "synthetic" })).cards;
      const card = cards.find((entry) => entry.providerKey === "card")!;
      const filters: TransactionFilters = {
        connectionId: "synthetic",
        billingAccountId: card.billingAccountId!,
        cardId: card.id,
        currency: "ILS",
        amountBasis: "purchase_commitment",
        kind: "purchase",
        merchantName: "Merchant",
        status: "posted",
        presence: "seen",
        dateRole: "booking",
        from: "2040-07-03",
        to: "2040-07-04",
      };
      expect(
        await sourceKeysOf(
          db,
          (await db.listTransactionPage(filters)).transactions,
        ),
      ).toEqual(["selected"]);
      const { cardId: _cardId, ...accountScope } = filters;
      expect(
        (
          await sourceKeysOf(
            db,
            (await db.listTransactionPage(accountScope)).transactions,
          )
        ).sort(),
      ).toEqual(["other-card", "selected"]);
      expect(await db.getTotals(filters)).toMatchObject({
        totals: [
          {
            currency: "ILS",
            amountBasis: "purchase_commitment",
            amountMinor: -100,
          },
        ],
        includedCount: 1,
        excludedCount: 0,
      });
    });

    it("uses the selected financial date role and inclusive endpoints without filling unknown dates", async () => {
      const filters = {
        connectionId: "synthetic",
        from: "2040-08-01",
        to: "2040-08-01",
      };
      expect(
        (
          await db.listTransactionPage({
            ...filters,
            dateRole: "transaction",
          })
        ).transactions,
      ).toEqual([]);
      expect(
        (await db.listTransactionPage({ ...filters, dateRole: "billing" }))
          .transactions,
      ).toHaveLength(10);
      expect(
        (await db.getTotals({ ...filters, dateRole: "billing" })).includedCount,
      ).toBe(9);
      expect(
        (await db.getTotals({ ...filters, dateRole: "booking" })).includedCount,
      ).toBe(0);
      expect(
        (
          await db.listTransactionPage({
            connectionId: "synthetic",
            dateRole: "booking",
            from: "2040-07-02",
            to: "2040-07-03",
          })
        ).transactions,
      ).toHaveLength(9);
    });

    it("filters on merchant category and payment context in lists and totals, with the connection optional", async () => {
      await db.ensureConnection({ id: "context", provider: "cal" });
      const base = row("base", { merchantCategoryCode: "5411" });
      const rows = [
        base,
        {
          ...base,
          sourceKey: "tap",
          merchantCategoryCode: "5812",
          cardPresent: true,
          authorizationMethod: "contactless",
          wallet: "apple_pay",
          threeDSecureUsed: false,
          recurring: false,
        },
        {
          ...base,
          sourceKey: "online",
          cardPresent: false,
          authorizationMethod: "online",
          wallet: "google_pay",
          threeDSecureUsed: true,
          recurring: true,
        },
      ] as const;
      await db.ingestRun(
        {
          connectionId: "context",
          runId: "context-run",
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:context",
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: JSON.stringify(rows),
            },
          ],
        },
        synthetic,
      );
      const keys = async (filters: TransactionFilters) =>
        (
          await sourceKeysOf(
            db,
            (
              await db.listTransactionPage({
                connectionId: "context",
                ...filters,
              })
            ).transactions,
          )
        ).sort();
      expect(await keys({})).toEqual(["base", "online", "tap"]);
      expect(await keys({ merchantCategoryCode: "5812" })).toEqual(["tap"]);
      expect(await keys({ merchantCategoryCode: "5411" })).toEqual([
        "base",
        "online",
      ]);
      expect(await keys({ cardPresent: true })).toEqual(["tap"]);
      expect(await keys({ cardPresent: false })).toEqual(["online"]);
      expect(await keys({ authorizationMethod: "contactless" })).toEqual([
        "tap",
      ]);
      expect(await keys({ wallet: "google_pay" })).toEqual(["online"]);
      expect(await keys({ threeDSecureUsed: true })).toEqual(["online"]);
      expect(await keys({ threeDSecureUsed: false })).toEqual(["tap"]);
      expect(await keys({ recurring: true })).toEqual(["online"]);
      expect(await keys({ recurring: false })).toEqual(["tap"]);
      expect(await keys({ wallet: "apple_pay", recurring: true })).toEqual([]);
      expect(
        (
          await db.getTotals({
            connectionId: "context",
            wallet: "apple_pay",
          })
        ).includedCount,
      ).toBe(1);
      expect(
        (
          await db.getTotals({
            connectionId: "context",
            merchantCategoryCode: "5411",
          })
        ).includedCount,
      ).toBe(2);
      // Without a connection the filter spans every connection.
      const everywhere = await db.listTransactionPage({ wallet: "apple_pay" });
      expect(everywhere.transactions).toHaveLength(1);
      expect(
        (await db.listTransactionPage({ merchantCategoryCode: "5411" }))
          .transactions,
      ).toHaveLength(2);
      const own = await db.getTotals({
        connectionId: "synthetic",
        currency: "ILS",
      });
      expect((await db.getTotals({ currency: "ILS" })).includedCount).toBe(
        own.includedCount + 3,
      );
    });

    it("enforces safe revisions and nonnegative installment ordinals in the database", async () => {
      for (const [column, value] of [
        ["version", "9007199254740992"],
        ["version", 0],
        ["installment_count", "9007199254740992"],
      ] as const) {
        await expect(
          db.raw(`UPDATE transactions SET ${column} = ? WHERE source_key = ?`, [
            value,
            "selected",
          ]),
        ).rejects.toThrow();
      }
      expect(
        (await db.listTransactions()).find(
          (transaction) => transaction.sourceKey === "selected",
        ),
      ).toMatchObject({
        version: 1,
        installmentCount: null,
      });
    });

    it("counts exclusions within the same filtered population, including retired records only when requested", async () => {
      const rows = await db.listTransactions({ connectionId: "synthetic" });
      const pending = rows.find(
        (transaction) => transaction.sourceKey === "pending",
      )!;
      const posted = rows.find(
        (transaction) => transaction.sourceKey === "selected",
      )!;
      await db.linkPendingTransaction({
        pendingId: pending.id,
        postedId: posted.id,
        expectedPendingVersion: pending.version,
        expectedPostedVersion: posted.version,
        expectedPendingAnnotationVersion: 0,
        expectedPostedAnnotationVersion: 0,
        reason: "Synthetic owner-confirmed continuation",
      });
      const active = await db.getTotals({ connectionId: "synthetic" });
      const all = await db.getTotals({
        connectionId: "synthetic",
        includeSuperseded: true,
      });
      expect(active.excluded.retiredOrRemoved).toBe(0);
      expect(all.excluded.retiredOrRemoved).toBe(1);
      expect(all.excludedCount).toBe(active.excludedCount + 1);
      expect(all.includedCount).toBe(active.includedCount);
      expect(all.totals).toEqual(active.totals);
      expect(
        (await db.listTransactions({ connectionId: "synthetic" })).length,
      ).toBe(active.includedCount + active.excludedCount);
      expect(
        (
          await db.listTransactions({
            connectionId: "synthetic",
            includeSuperseded: true,
          })
        ).length,
      ).toBe(all.includedCount + all.excludedCount);
    });
  });
}
