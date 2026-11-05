import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  parsedLedgerFacts,
  storedPaymentContext,
} from "../../../src/domain/model.js";
import { RECONCILIATION_POLICY_VERSION } from "../../../src/domain/plans/sync.js";
import { isracardAdapter } from "../../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCardKey,
  serializeIsracardCapture,
} from "../../../src/providers/isracard/capture.js";
import {
  compatibleIsracardSettledPair,
  settledIsracardMerchant,
} from "../../../src/providers/isracard/posting-evidence.js";
import { openDatabase } from "../../../src/storage/sqlite/database.js";

const settledAdapter = isracardAdapter;

function capture(pending = true, posted = true) {
  const source = JSON.parse(
    readFileSync(
      new URL("./fixtures/card-month-approvals.json", import.meta.url),
      "utf8",
    ),
  ) as IsracardCapture;
  const digital = JSON.parse(source.responses.digital!);
  const approval = digital.data.approvals.approvedTransactions[0];
  approval.businessName = "PAYPAL *EX RIVER STORE";
  approval.purchaseDate = "12/06/2040";
  approval.originalAmount = 12.5;
  approval.ilsBillingAmount = 12.5;
  approval.currencyIso = "ILS";
  digital.data.approvals = pending
    ? { approvedTransactions: [approval], totalEstimatedAmount: 12.5 }
    : null;
  digital.data.israelAbroadVouchers = null;
  digital.data.currentTransactionsList = null;
  source.responses.digital = JSON.stringify(digital);
  const legacy = JSON.parse(source.responses.legacy!);
  legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions = [
    {
      txnIsrael: posted
        ? [
            {
              fullPurchaseDate: "12/06/2040",
              fullPaymentDate: "10/07/2040",
              fullSupplierNameHeb: "PAYPAL EX RIVER STORE",
              voucherNumberRatz: "SETTLEMENT-EXAMPLE",
              voucherNumber: "EXAMPLE-DEAL",
              dealSum: "12.50",
              paymentSum: "12.50",
              currencyId: "ILS",
              currentPaymentCurrency: "ILS",
            },
          ]
        : [],
      txnAbroad: [],
      txnInfo: [],
    },
  ];
  source.responses.legacy = JSON.stringify(legacy);
  delete source.responses.details;
  return source;
}

function facts(source = capture()) {
  const accountKey = isracardCardKey(source.card);
  const result = isracardAdapter.extract(serializeIsracardCapture(source), {
    accountKey,
    runId: "synthetic",
    scope: { kind: "recent", month: source.billingMonth, cardKey: accountKey },
  });

  return result.transactions.map((row) => ({
    ...row,
    counterpartyName: row.counterpartyName ?? null,
    ...parsedLedgerFacts(row),
    ...storedPaymentContext(row, undefined),
    cardId: "synthetic",
    purchaseId: null,
  }));
}

describe("Isracard settled unknown identity policy", () => {
  it("admits narrow current legacy provenance while leaving financial facts unknown", () => {
    const rows = facts();
    const pending = rows.find((r) => r.status === "pending")!;
    const posted = rows.find((r) => r.status === "posted")!;
    expect(posted).toMatchObject({
      kind: "unknown",
      amountBasis: "unknown",
      amountMinor: -1250,
    });
    expect(compatibleIsracardSettledPair(pending, posted)).toBe(true);
    expect(
      settledIsracardMerchant(pending.merchantName, posted.merchantName),
    ).toBe(true);
  });
  it.each([
    ["different stated money", { dealSum: "13.00" }],
    ["foreign original currency", { currentPaymentCurrency: "USD" }],
    ["uninterpreted description", { moreInfo: "Synthetic adjustment" }],
    ["foreign component", { paymentSumOutbound: "12.50" }],
    ["conflicting sign", { paymentSumSign: "-" }],
  ])("rejects %s", (_label, fields) => {
    const source = capture();
    const legacy = JSON.parse(source.responses.legacy!);
    Object.assign(
      legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]
        .txnIsrael[0],
      fields,
    );
    source.responses.legacy = JSON.stringify(legacy);
    const rows = facts(source);
    expect(
      compatibleIsracardSettledPair(
        rows.find((r) => r.status === "pending")!,
        rows.find((r) => r.status === "posted")!,
      ),
    ).toBe(false);
  });
  it.each([
    [
      "a domestic row in the Hebrew currency label",
      "txnIsrael",
      {
        currencyId: 'ש"ח',
        currentPaymentCurrency: null,
        kodMatbeaMekori: 'ש"ח',
      },
    ],
    [
      "an abroad-section row in local currency",
      "txnAbroad",
      {
        currencyId: "NIS",
        currentPaymentCurrency: "NIS",
        fullSupplierNameHeb: null,
        fullSupplierNameOutbound: "PAYPAL EX RIVER STORE",
        fullPurchaseDate: null,
        fullPurchaseDateOutbound: "12/06/2040",
        paymentSum: null,
        dealSum: null,
        paymentSumOutbound: "12.50",
        dealSumOutbound: "12.50",
        voucherNumberRatz: null,
        voucherNumberRatzOutbound: "SETTLEMENT-EXAMPLE",
      },
    ],
  ])("admits %s", (_label, section, fields) => {
    const source = capture();
    const legacy = JSON.parse(source.responses.legacy!);
    const group =
      legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0];
    const row = { ...group.txnIsrael[0], ...fields };
    group.txnIsrael = [];
    group[section] = [row];
    source.responses.legacy = JSON.stringify(legacy);
    const rows = facts(source);
    const posted = rows.find((r) => r.status === "posted")!;
    expect(posted).toMatchObject({ kind: "unknown", currency: "ILS" });
    expect(
      compatibleIsracardSettledPair(
        rows.find((r) => r.status === "pending")!,
        posted,
      ),
    ).toBe(true);
  });
  it("rejects an abroad-section row in another currency", () => {
    const source = capture();
    const legacy = JSON.parse(source.responses.legacy!);
    const group =
      legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0];
    group.txnAbroad = [
      {
        ...group.txnIsrael[0],
        currencyId: "USD",
        currentPaymentCurrency: "USD",
        fullSupplierNameHeb: null,
        fullSupplierNameOutbound: "PAYPAL EX RIVER STORE",
        fullPurchaseDate: null,
        fullPurchaseDateOutbound: "12/06/2040",
        paymentSum: null,
        dealSum: null,
        paymentSumOutbound: "12.50",
        dealSumOutbound: "12.50",
      },
    ];
    group.txnIsrael = [];
    source.responses.legacy = JSON.stringify(legacy);
    const rows = facts(source);
    expect(
      compatibleIsracardSettledPair(
        rows.find((r) => r.status === "pending")!,
        rows.find((r) => r.status === "posted")!,
      ),
    ).toBe(false);
  });
  it("preserves the stronger arrival witness when genuine DigitalV3 evidence arrives before settlement", async () => {
    const db = await openDatabase(":memory:", { settledPosting: "on" });
    try {
      await db.ensureConnection({
        id: "stronger-arrival",
        provider: "isracard",
      });

      async function ingest(
        hour: number,
        pending: boolean,
        posted: boolean,
        enrich = false,
      ) {
        const source = capture(pending, posted);
        const digital = JSON.parse(source.responses.digital!);
        if (pending) {
          digital.data.approvals.approvedTransactions[0].businessName =
            "Synthetic exact merchant";
        }
        if (enrich) {
          digital.data.israelAbroadVouchers = {
            vouchers: {
              israelAbroadVouchersList: [
                {
                  purchaseDate: "12/06/2040",
                  businessName: "Synthetic exact merchant",
                  transactionCode: 1,
                  billingAmount: 12.5,
                  billingAmountCurrency: 0,
                  originalAmount: 12.5,
                  originalCurrencyIso: "ILS",
                  numberOfInstallment: null,
                  currentInstallmentNum: null,
                  seqVoucherNumber: "SETTLEMENT-EXAMPLE",
                  voucherNumber: "EXAMPLE-DEAL",
                },
              ],
              informativeOnlyVouchers: [],
            },
            outOfStatementChargeDateVouchers: [],
          };
        }
        source.responses.digital = JSON.stringify(digital);
        const legacy = JSON.parse(source.responses.legacy!);
        if (posted) {
          legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0].txnIsrael[0].fullSupplierNameHeb =
            "Synthetic exact merchant";
        }
        source.responses.legacy = JSON.stringify(legacy);
        const accountKey = isracardCardKey(source.card);
        await db.ingestRun(
          {
            connectionId: "stronger-arrival",
            runId: `stronger-${hour}`,
            responses: [
              {
                accountKey,
                endpoint: "isracard:card-month",
                capturedAt: `2040-07-02T0${hour}:00:00Z`,
                responseText: serializeIsracardCapture(source),
                scope: {
                  kind: "recent",
                  month: source.billingMonth,
                  cardKey: accountKey,
                },
              },
            ],
          },
          settledAdapter,
        );
      }

      await ingest(0, true, false);
      const pending = (await db.listTransactions())[0]!;
      await ingest(1, false, true);
      const witness = (await db.getTransaction(pending.id))!.details
        .postingOverlap!;
      expect(witness.settlement?.arrival).toBeDefined();
      await ingest(2, false, true, true);
      const survivor = (await db.getTransaction(pending.id))!;
      expect(survivor).toMatchObject({
        status: "posted",
        kind: "purchase",
        amountBasis: "purchase_commitment",
        details: {
          postingLink: {
            policyVersion: RECONCILIATION_POLICY_VERSION,
            evidence: { overlap: witness.settlement!.arrival },
          },
        },
      });
    } finally {
      await db.close();
    }
  });
  it.each([false, true])(
    "retains unknown facts through real extraction and unlink (repeated terminal token: %s)",
    async (repeatedTerminalToken) => {
      const db = await openDatabase(":memory:", {
        settledPosting: "on",
      });
      try {
        await db.ensureConnection({
          id: "synthetic-settlement",
          provider: "isracard",
        });

        async function ingest(day: number, source: IsracardCapture) {
          if (repeatedTerminalToken) {
            const digital = JSON.parse(source.responses.digital!);
            if (digital.data.approvals) {
              digital.data.approvals.approvedTransactions[0].businessName +=
                " EX";
            }
            source.responses.digital = JSON.stringify(digital);
          }
          const accountKey = isracardCardKey(source.card);
          return db.ingestRun(
            {
              connectionId: "synthetic-settlement",
              runId: `settlement-${day}`,
              responses: [
                {
                  accountKey,
                  endpoint: "isracard:card-month",
                  capturedAt: `2040-07-${String(day).padStart(2, "0")}T12:00:00Z`,
                  responseText: serializeIsracardCapture(source),
                  scope: {
                    kind: "recent",
                    month: source.billingMonth,
                    cardKey: accountKey,
                  },
                },
              ],
            },
            settledAdapter,
          );
        }

        await ingest(2, capture(true, false));
        const pending = (await db.listTransactions()).find(
          (r) => r.status === "pending",
        )!;
        const annotation = await db.editAnnotation({
          transactionId: pending.id,
          expectedVersion: 0,
          notes: "Synthetic owner note",
        });
        await ingest(3, capture(false, true));
        expect((await db.getTransaction(pending.id))!.status).toBe("pending");
        const posted = (await db.listTransactions()).find(
          (r) => r.status === "posted",
        )!;
        await ingest(4, capture(false, true));
        const survivor = (await db.getTransaction(pending.id))!;
        expect(survivor).toMatchObject({
          status: "posted",
          kind: "unknown",
          amountBasis: "unknown",
          annotation,
          details: {
            postingLink: {
              automatic: true,
              policyVersion: "settled-similarity-v1",
            },
          },
        });
        expect(survivor.details.issues).toEqual(
          expect.arrayContaining([
            "unsupported_transaction_type",
            "unverified_amount_basis",
            "isracard_unverified_semantics",
          ]),
        );
        await db.unlinkPendingTransaction({
          pendingId: pending.id,
          postedId: posted.id,
          expectedPendingVersion: survivor.version,
          expectedPostedVersion: (await db.getTransaction(posted.id))!.version,
          expectedPendingAnnotationVersion: annotation.version,
          expectedPostedAnnotationVersion: 0,
          reason: "Synthetic owner identified distinct purchases",
        });
        await ingest(5, capture(false, true));
        expect((await db.getTransaction(pending.id))!.status).toBe("pending");
      } finally {
        await db.close();
      }
    },
  );
  describe("through the two runs of a real recent refresh", () => {
    // A recent refresh captures the next and last billing months at one instant:
    // only the next month states pending coverage.
    async function setup() {
      const db = await openDatabase(":memory:", { settledPosting: "on" });
      await db.ensureConnection({ id: "refresh", provider: "isracard" });

      async function month(
        id: string,
        capturedAt: string,
        source: IsracardCapture,
      ) {
        const accountKey = isracardCardKey(source.card);
        await db.ingestRun(
          {
            connectionId: "refresh",
            runId: id,
            responses: [
              {
                accountKey,
                endpoint: "isracard:card-month",
                capturedAt,
                responseText: serializeIsracardCapture(source),
                scope: {
                  kind: "recent",
                  month: source.billingMonth,
                  cardKey: accountKey,
                },
              },
            ],
          },
          settledAdapter,
        );
      }

      const lastMonth = () => {
        const source = capture(false, false);
        delete source.isNextBillingDate;
        source.billingMonth = "2040-05";
        return source;
      };

      async function refresh(day: number, next: IsracardCapture, hour = "07") {
        const at = `2040-07-${String(day).padStart(2, "0")}T${hour}:17:00Z`;
        await month(`next-${day}-${hour}`, at, next);
        await month(`last-${day}-${hour}`, at, lastMonth());
      }

      return { db, refresh, lastMonth };
    }

    it("links a heuristic pair across posted-only runs", async () => {
      const { db, refresh, lastMonth } = await setup();
      try {
        const accountKey = isracardCardKey(lastMonth().card);
        expect(
          isracardAdapter.extract(serializeIsracardCapture(lastMonth()), {
            accountKey,
            runId: "synthetic",
            scope: { kind: "recent", month: "2040-05", cardKey: accountKey },
          }).partitions,
        ).toEqual([
          { accountKey, status: "posted", success: true, comparable: false },
        ]);
        await refresh(2, capture(true, false));
        const pending = (await db.listTransactions()).find(
          (r) => r.status === "pending",
        )!;
        await refresh(3, capture(false, true));
        expect(
          (await db.getTransaction(pending.id))!.details.postingOverlap
            ?.settlement,
        ).toBeDefined();
        await refresh(3, capture(false, true), "19");
        expect((await db.getTransaction(pending.id))!.status).toBe("pending");
        await refresh(4, capture(false, true));
        expect((await db.getTransaction(pending.id))!).toMatchObject({
          status: "posted",
          kind: "unknown",
          amountBasis: "unknown",
          details: {
            postingLink: { policyVersion: "settled-similarity-v1" },
          },
        });
      } finally {
        await db.close();
      }
    });
    it("is not stopped by an unusable capture inside the window", async () => {
      const { db, refresh } = await setup();
      try {
        await refresh(2, capture(true, false));
        const pending = (await db.listTransactions()).find(
          (r) => r.status === "pending",
        )!;
        await refresh(3, capture(false, true));
        const broken = capture(false, true);
        broken.responses.digital = "not json";
        await refresh(3, broken, "19");
        await refresh(4, capture(false, true));
        expect((await db.getTransaction(pending.id))!.status).toBe("posted");
      } finally {
        await db.close();
      }
    });
  });
});
