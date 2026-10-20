import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  type JsonObject,
  type StoredTransactionFacts,
  type TransactionFacts,
  unknownLedgerFacts,
} from "../../../src/domain/model.js";
import { automaticPostingPairs } from "../../../src/domain/plans/auto-posting.js";
import type { Transaction } from "../../../src/domain/records.js";
import { calAdapter } from "../../../src/providers/cal/adapter.js";

const capability = calAdapter.automaticPosting!;
const context = { accountKey: "synthetic", runId: "synthetic" };

function source(status: "pending" | "posted"): JsonObject {
  return status === "pending"
    ? {
        cardUniqueID: "SYNTHETIC-CARD",
        merchantName: "FIXTURE MEDIA",
        internationalBranchID: "5411",
        trnTypeCode: "5",
        transCardPresentInd: false,
        walletTranInd: 0,
        numberOfPayments: 0,
        isAbroadApproval: false,
      }
    : {
        cardUniqueId: "SYNTHETIC-CARD",
        merchantName: "FIXTURE MEDIA",
        internationalBranchID: 5411,
        transactionTypeCode: 5,
        transCardPresentInd: false,
        tokenInd: "0",
        numOfPayments: "0",
        isAbroadTransaction: false,
      };
}

function retained(
  status: "pending" | "posted",
  rows: unknown[] = [source(status)],
): TransactionFacts {
  const fixture = readFileSync(
    new URL("./fixtures/recent-01.json", import.meta.url),
    "utf8",
  );
  const row = calAdapter
    .extract(fixture, context)
    .transactions.find((row) => row.status === status)!;
  const { cardKey: _cardKey, ...facts } = row;
  facts.details.provider.cal = { rows: rows as JsonObject[] };
  return { ...facts, ...unknownLedgerFacts("synthetic-card-id") };
}

describe("CAL automatic posting evidence", () => {
  it.each(["pending", "posted"] as const)(
    "decodes %s aliases with numeric-string tolerance and opaque zero token",
    (status) => {
      expect(capability.evidence(retained(status))).toEqual({
        merchantName: "FIXTURE MEDIA",
        categoryCode: "5411",
        sourceTypeCode: "5",
        cardPresent: false,
        tokenCode: "0",
        paymentCount: 0,
        abroad: false,
        merchantProviderId: null,
      });
    },
  );

  it("accepts agreeing aliases and multiple observations without selecting an arbitrary row", () => {
    const raw = { ...source("pending"), ...source("posted") };
    expect(
      capability.evidence(
        retained("pending", [raw, { ...raw, walletTranInd: "0" }]),
      ),
    ).not.toBeNull();
    expect(
      capability.evidence(
        retained("pending", [raw, { ...raw, transCardPresentInd: true }]),
      ),
    ).toBeNull();
    expect(
      capability.evidence(
        retained("pending", [raw, { ...raw, merchantId: "known" }]),
      ),
    ).toBeNull();
  });

  it.each([
    "merchantName",
    "internationalBranchID",
    "trnTypeCode",
    "transCardPresentInd",
    "walletTranInd",
    "numberOfPayments",
    "cardUniqueID",
  ])("rejects missing/null required raw %s", (field) => {
    const raw = source("pending");
    raw[field] = null;
    expect(capability.evidence(retained("pending", [raw]))).toBeNull();
    delete raw[field];
    expect(capability.evidence(retained("pending", [raw]))).toBeNull();
  });

  it.each([
    { merchantName: 10 },
    { merchantName: " " },
    { internationalBranchID: {} },
    { trnTypeCode: "5x" },
    { transCardPresentInd: 0 },
    { transCardPresentInd: "false" },
    { walletTranInd: true },
    { numberOfPayments: -1 },
    { numberOfPayments: "" },
    { numberOfPayments: 0.5 },
    { numberOfPayments: "9007199254740992" },
    { isAbroadApproval: "false" },
    { merchantId: [] },
    { cardUniqueId: "OTHER" },
    { transactionTypeCode: 9 },
    { tokenInd: 3 },
    { numOfPayments: null },
    { isAbroadTransaction: true },
    { transactionTypeCode: 8 },
    { numberOfPayments: 2 },
  ])("rejects malformed/conflicting evidence %j without throwing", (fields) => {
    expect(
      capability.evidence(
        retained("pending", [{ ...source("pending"), ...fields }]),
      ),
    ).toBeNull();
  });

  it("rejects retained observations of different cards", () => {
    const row = retained("pending", [
      source("pending"),
      { ...source("pending"), cardUniqueID: "OTHER-CARD" },
    ]);
    expect(capability.evidence(row)).toBeNull();
    expect(
      capability.evidence(
        retained("pending", [source("pending"), source("pending")]),
      ),
    ).not.toBeNull();
  });

  it("excludes installment type even with raw zero payments", () => {
    expect(
      capability.evidence(
        retained("pending", [{ ...source("pending"), trnTypeCode: 8 }]),
      ),
    ).toBeNull();
    expect(
      capability.evidence(
        retained("posted", [{ ...source("posted"), transactionTypeCode: "8" }]),
      ),
    ).toBeNull();
  });

  it("preserves optional absence, false and merchant ID zero", () => {
    const raw = source("pending");
    delete raw.isAbroadApproval;
    expect(capability.evidence(retained("pending", [raw]))).toMatchObject({
      abroad: null,
      merchantProviderId: null,
    });
    raw.isAbroadApproval = null;
    raw.merchantId = 0;
    expect(capability.evidence(retained("pending", [raw]))).toMatchObject({
      abroad: null,
      merchantProviderId: "0",
    });
  });

  it.each([[], [null], [42], [{}]].map((rows) => ({ rows })))(
    "rejects malformed retained observations $rows",
    ({ rows }) => {
      expect(capability.evidence(retained("pending", rows))).toBeNull();
    },
  );

  it("does not use sticky card-presence, merchant, MCC or count enrichment", () => {
    const raw = source("pending");
    delete raw.transCardPresentInd;
    const row = retained("pending", [raw]);
    row.cardPresent = false;
    row.wallet = "apple_pay";
    row.merchantName = "FIXTURE MEDIA";
    row.merchantCategoryCode = "5411";
    row.installmentCount = null;
    expect(capability.evidence(row)).toBeNull();
    row.details.provider = {};
    expect(capability.evidence(row)).toBeNull();
  });

  it.each([5, 9, 6])(
    "narrows refund automation by raw type equality: posted code %i",
    (postedCode) => {
      // Construct invented real extraction shapes; timestamps and incidental fields differ.
      const pendingSource = {
        ...source("pending"),
        transactionID: "AUTH",
        trnTypeCode: "6",
        trnAmt: -23.47,
        trnCurrencySymbol: "$",
        trnPurchaseDate: "2040-07-01T13:14:15",
      };
      const postedSource = {
        ...source("posted"),
        trnIntId: "TXN",
        transactionTypeCode: postedCode,
        refundInd: true,
        amountForDisplay: -23.47,
        debCrdCurrencyCode: 1,
        currencyForDisplay: "$",
        trnAmt: 23.47,
        trnCurrencyIsoCode: "840",
        transOriginalCurrencyCode: 1,
        trnPurchaseDate: "2040-07-01T00:00:00",
        cashAccountTrnAmt: 999,
        walletProviderDesc: "Different description",
      };
      const result = calAdapter.extract(
        JSON.stringify({
          statusCode: 1,
          result: {
            clearanceRequests: [pendingSource],
            transactions: [postedSource],
          },
        }),
        context,
      );
      // Both rows name the same card; the planner resolves it to one service ID.
      const [pendingInput, posted] = (["pending", "posted"] as const).map(
        (status) => {
          const { cardKey, ...facts } = result.transactions.find(
            (row) => row.status === status,
          )!;
          return { ...facts, ...unknownLedgerFacts(cardKey) };
        },
      ) as [StoredTransactionFacts, StoredTransactionFacts];
      expect(pendingInput.kind).toBe("refund");
      expect(posted.kind).toBe("refund");
      const pending: Transaction = {
        ...pendingInput,
        id: "pending",
        connectionId: "synthetic",
        presence: "seen",
        firstSeenAt: "2040-07-02T00:00:00Z",
        lastSeenAt: "2040-07-02T00:00:00Z",
        lastSeenRunId: "first",
        version: 1,
        supersededById: null,
      };
      expect(
        automaticPostingPairs(
          [pending],
          [posted],
          new Map([[pending, pending]]),
          capability,
        ).pairs.size,
      ).toBe(postedCode === 6 ? 1 : 0);
    },
  );
});
