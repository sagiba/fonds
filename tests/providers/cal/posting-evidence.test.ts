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
import { calPostingEvidence } from "../../../src/providers/cal/posting-evidence.js";

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
  return {
    ...facts,
    counterpartyName: facts.counterpartyName ?? null,
    ...unknownLedgerFacts("synthetic-card-id"),
  };
}

describe("CAL automatic posting evidence", () => {
  function compatible(pendingRows: JsonObject[], postedRows: JsonObject[]) {
    return capability.compatibleGroups(
      pendingRows.map((row) => retained("pending", [row])),
      postedRows.map((row) => retained("posted", [row])),
    );
  }

  it.each([
    ["PAYDEMO *FIXTURE MEDIA Testburg NLD", "PAYDEMO *FIXTURE MEDIA"],
    ["סופר דוגמה ובניו בעמ", "סופר דוגמה ובניו"],
    ['סופר דוגמה בע"מ', 'סופר דוגמה בע"מ'],
    ["Cafe\u0301  FIXTURE\u00a0 Testburg", "Café\tFIXTURE"],
    ["  Café\u2003FIXTURE  ", "Café FIXTURE"],
    ["SYNTHO", "SYNTHO"],
  ])("accepts conservative names %s → %s", (pendingName, postedName) => {
    expect(
      compatible(
        [{ ...source("pending"), merchantName: pendingName }],
        [{ ...source("posted"), merchantName: postedName }],
      ),
    ).toBe(true);
  });

  it.each([
    ["SYNTHOR SHOP", "SYNTHO"],
    ["FIXTURE MEDIAHOUSE CITY", "FIXTURE MEDIA"],
    ["SYNTHO SHOP", "SYNTHO"],
    ["FIXTURE * CITY", "FIXTURE *"],
    ["FIXTURE MEDIA", "FIXTURE MEDIA CITY"],
    ['סופר דוגמה בע"מ', "סופר דוגמה בעמ"],
    ["סופר דוגמה בע״מ", 'סופר דוגמה בע"מ'],
    ["סופר דוגמה בע׳מ", "סופר דוגמה בעמ"],
    ["PAYDEMO *FIXTURE MEDIA", "PAYDEMO FIXTURE MEDIA"],
    ["Fixture MEDIA", "FIXTURE MEDIA"],
    ["ＦＩＸＴＵＲＥ MEDIA", "FIXTURE MEDIA"],
    ["", ""],
    [" \u00a0 ", " "],
    ["***", "***"],
  ])("rejects incompatible names %s → %s", (pendingName, postedName) => {
    expect(
      compatible(
        [{ ...source("pending"), merchantName: pendingName }],
        [{ ...source("posted"), merchantName: postedName }],
      ),
    ).toBe(false);
  });

  it.each([
    ["internationalBranchID", "5999"],
    ["transactionTypeCode", "9"],
    ["transCardPresentInd", true],
    ["tokenInd", "3"],
    ["numOfPayments", 1],
  ] as const)(
    "rejects paired source discriminator mismatch: %s",
    (field, value) => {
      expect(
        compatible(
          [source("pending")],
          [{ ...source("posted"), [field]: value }],
        ),
      ).toBe(false);
    },
  );

  it.each([
    ["isAbroadApproval", "isAbroadTransaction", false, true],
    ["merchantId", "merchantId", "merchant-a", "merchant-b"],
  ] as const)(
    "compares optional %s only when both known",
    (pendingField, postedField, left, right) => {
      const pending = { ...source("pending"), [pendingField]: left };
      const posted = { ...source("posted"), [postedField]: right };
      expect(compatible([pending], [posted])).toBe(false);
      posted[postedField] = null;
      expect(compatible([pending], [posted])).toBe(true);
      pending[pendingField] = null;
      posted[postedField] = right;
      expect(compatible([pending], [posted])).toBe(true);
      pending[pendingField] = left;
      posted[postedField] = left;
      expect(compatible([pending], [posted])).toBe(true);
    },
  );

  it.each(["pending", "posted"] as const)(
    "rejects heterogeneous %s twins, including optional presence",
    (side) => {
      for (const fields of [
        { merchantName: "Different shop" },
        { internationalBranchID: "5999" },
        { trnTypeCode: "9", transactionTypeCode: "9" },
        { transCardPresentInd: true },
        { walletTranInd: "3", tokenInd: "3" },
        { numberOfPayments: 1, numOfPayments: 1 },
        { isAbroadApproval: true, isAbroadTransaction: true },
        { merchantId: "known" },
      ]) {
        const pending = [source("pending"), source("pending")];
        const posted = [source("posted"), source("posted")];
        (side === "pending" ? pending : posted)[1] = {
          ...source(side),
          ...fields,
        };
        expect(compatible(pending, posted), JSON.stringify(fields)).toBe(false);
      }
    },
  );

  it("retains homogeneous twins while rejecting different names sharing a posted prefix", () => {
    const posted = [source("posted"), source("posted")];
    expect(compatible([source("pending"), source("pending")], posted)).toBe(
      true,
    );
    expect(
      compatible(
        [
          { ...source("pending"), merchantName: "FIXTURE MEDIA Testburg" },
          { ...source("pending"), merchantName: "FIXTURE MEDIA NLD" },
        ],
        posted,
      ),
    ).toBe(false);
  });

  it("is invariant under source order for normalized twins and heterogeneous blockers", () => {
    const pending = [
      { ...source("pending"), merchantName: "Cafe\u0301  FIXTURE\u00a0CITY" },
      { ...source("pending"), merchantName: "Café FIXTURE CITY" },
    ];
    const posted = [
      { ...source("posted"), merchantName: "Café\tFIXTURE" },
      { ...source("posted"), merchantName: "  Café FIXTURE " },
    ];
    for (const left of [pending, [...pending].reverse()]) {
      for (const right of [posted, [...posted].reverse()]) {
        expect(compatible(left, right)).toBe(true);
        const blocked = right.map((row, index) => ({
          ...row,
          ...(index === 0 ? { merchantId: "known" } : {}),
        }));
        expect(compatible(left, blocked)).toBe(false);
        expect(compatible(left, [...blocked].reverse())).toBe(false);
      }
    }
  });

  it.each(["pending", "posted"] as const)(
    "rejects unsupported %s kinds and interpretation issues",
    (side) => {
      const pending = retained("pending");
      const posted = retained("posted");
      const changed = side === "pending" ? pending : posted;
      changed.kind = "unknown";
      expect(capability.compatibleGroups([pending], [posted])).toBe(false);
      changed.kind = "purchase";
      changed.details.issues = ["unsupported_direction"];
      expect(capability.compatibleGroups([pending], [posted])).toBe(false);
      changed.details.issues = ["possible_pending_posted_match"];
      expect(capability.compatibleGroups([pending], [posted])).toBe(true);
    },
  );

  it.each(["pending", "posted"] as const)(
    "decodes %s aliases with numeric-string tolerance and opaque zero token",
    (status) => {
      expect(calPostingEvidence(retained(status))).toEqual({
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
      calPostingEvidence(
        retained("pending", [raw, { ...raw, walletTranInd: "0" }]),
      ),
    ).not.toBeNull();
    expect(
      calPostingEvidence(
        retained("pending", [raw, { ...raw, transCardPresentInd: true }]),
      ),
    ).toBeNull();
    expect(
      calPostingEvidence(
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
    expect(calPostingEvidence(retained("pending", [raw]))).toBeNull();
    delete raw[field];
    expect(calPostingEvidence(retained("pending", [raw]))).toBeNull();
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
      calPostingEvidence(
        retained("pending", [{ ...source("pending"), ...fields }]),
      ),
    ).toBeNull();
  });

  it("rejects retained observations of different cards", () => {
    const row = retained("pending", [
      source("pending"),
      { ...source("pending"), cardUniqueID: "OTHER-CARD" },
    ]);
    expect(calPostingEvidence(row)).toBeNull();
    expect(
      calPostingEvidence(
        retained("pending", [source("pending"), source("pending")]),
      ),
    ).not.toBeNull();
  });

  it("excludes installment type even with raw zero payments", () => {
    expect(
      calPostingEvidence(
        retained("pending", [{ ...source("pending"), trnTypeCode: 8 }]),
      ),
    ).toBeNull();
    expect(
      calPostingEvidence(
        retained("posted", [{ ...source("posted"), transactionTypeCode: "8" }]),
      ),
    ).toBeNull();
  });

  it("preserves optional absence, false and merchant ID zero", () => {
    const raw = source("pending");
    delete raw.isAbroadApproval;
    expect(calPostingEvidence(retained("pending", [raw]))).toMatchObject({
      abroad: null,
      merchantProviderId: null,
    });
    raw.isAbroadApproval = null;
    raw.merchantId = 0;
    expect(calPostingEvidence(retained("pending", [raw]))).toMatchObject({
      abroad: null,
      merchantProviderId: "0",
    });
  });

  it.each([[], [null], [42], [{}]].map((rows) => ({ rows })))(
    "rejects malformed retained observations $rows",
    ({ rows }) => {
      expect(calPostingEvidence(retained("pending", rows))).toBeNull();
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
    expect(calPostingEvidence(row)).toBeNull();
    row.details.provider = {};
    expect(calPostingEvidence(row)).toBeNull();
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
