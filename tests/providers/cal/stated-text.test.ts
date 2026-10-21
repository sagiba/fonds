import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { transactionInputSchema } from "../../../src/domain/model.js";
import { extractCal } from "../../../src/providers/cal/extract.js";

type Row = Record<string, unknown>;

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/recent-01.json", import.meta.url), "utf8"),
);
const regular: Row = fixture.result.transactions.find(
  (row: Row) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
);

function extract(...differences: Row[]) {
  const result = extractCal(
    JSON.stringify({
      statusCode: 1,
      result: {
        transactions: differences.map((difference) => ({
          ...regular,
          ...difference,
        })),
        clearanceRequests: [],
      },
    }),
    { accountKey: "SYNTHETIC-STATED-ACCOUNT", runId: "synthetic-stated-run" },
  );
  for (const transaction of result.transactions) {
    expect(transactionInputSchema.safeParse(transaction).success).toBe(true);
  }
  return result.transactions;
}

const detail = (count: number) => `עסקה ב-‎${count}‏ תשלומים`;
const ongoing = (count: number) => `עסקה ב - ${count} תשלומים`;

/** An installment purchase as the recent endpoint states it: no structured count or ordinal. */
function summary(fields: Row = {}): Row {
  return {
    trnIntId: "SYNTHETIC-TXN-SUMMARY",
    transactionTypeCode: 8,
    trnType: "תשלומים",
    numOfPayments: null,
    curPaymentNum: null,
    trnAmt: 400,
    amountForDisplay: 400,
    amtBeforeConvAndIndex: 100,
    transTypeCommentDetails: [detail(4)],
    onGoingTransactionsComment: ongoing(4),
    ...fields,
  };
}

describe("CAL stated text", () => {
  it("takes a plan's count from its installment texts when the structured count is null", () => {
    const [purchase] = extract(summary());
    expect(purchase).toMatchObject({ installmentCount: 4, billingDate: null });
    expect(purchase!.installmentNumber ?? null).toBeNull();
    expect(purchase!.purchaseKey).toBeUndefined();
    expect(purchase!.details.issues).not.toContain(
      "conflicting_installment_facts",
    );
    expect(purchase!.details.additionalInformation ?? []).not.toContain(
      detail(4),
    );
    expect(purchase!.details.additionalInformation ?? []).not.toContain(
      ongoing(4),
    );
  });

  it.each([
    ["texts disagree", summary({ onGoingTransactionsComment: ongoing(5) })],
    ["text and structured count disagree", summary({ numOfPayments: 3 })],
  ])("leaves the count unknown when the %s", (_case, row) => {
    const [purchase] = extract(row);
    expect(purchase!.installmentCount).toBeNull();
    expect(purchase!.details.issues).toContain("conflicting_installment_facts");
    expect(purchase!.details.additionalInformation).toEqual(
      expect.arrayContaining([detail(4)]),
    );
  });

  it("leaves an unrepresentable stated count unknown and keeps its text", () => {
    const text = "עסקה ב-\u200e9007199254740993\u200f תשלומים";
    const [purchase] = extract(
      summary({
        transTypeCommentDetails: [text],
        onGoingTransactionsComment: "",
      }),
    );
    expect(purchase!.installmentCount).toBeNull();
    expect(purchase!.details.additionalInformation).toContain(text);
  });

  it("checks every row of a plan against the currency it restates", () => {
    const plan = {
      trnIntId: "SYNTHETIC-TXN-PLAN",
      transactionTypeCode: 8,
      trnType: "תשלומים",
      numOfPayments: 4,
      trnAmt: 400,
      amountForDisplay: 400,
      amtBeforeConvAndIndex: 100,
      trnCurrencyIsoCode: "376",
      srcCurrencyCode: "376",
      transTypeCommentDetails: [detail(4)],
      onGoingTransactionsComment: ongoing(4),
    };
    const rows = extract(
      { ...plan, curPaymentNum: 1, debCrdDate: "2040-07-10T00:00:00" },
      {
        ...plan,
        curPaymentNum: 2,
        debCrdDate: "2040-08-10T00:00:00",
        srcCurrencyCode: "840",
      },
    );
    const purchase = rows.find(
      (row) => row.installmentCount === 4 && row.purchaseKey === undefined,
    )!;
    expect(purchase.originalCurrency).toBeNull();
    expect(purchase.details.issues).toContain("conflicting_original_currency");
  });

  it("bills a payment whose plan size only its texts state", () => {
    const rows = extract(summary({ curPaymentNum: 2 }));
    const line = rows.find((row) => row.purchaseKey !== undefined)!;
    expect(line).toMatchObject({ installmentCount: 4, installmentNumber: 2 });
    expect(
      rows.find((row) => row.purchaseKey === undefined)!.installmentCount,
    ).toBe(4);
  });

  it("leaves a plan's count unknown when a later payment states another", () => {
    const rows = extract(
      summary({ curPaymentNum: 1, numOfPayments: 4 }),
      summary({
        curPaymentNum: 2,
        numOfPayments: 5,
        debCrdDate: "2040-08-10T00:00:00",
      }),
    );
    const purchase = rows.find((row) => row.purchaseKey === undefined)!;
    expect(purchase.installmentCount).toBeNull();
    expect(purchase.details.issues).toContain("conflicting_installment_facts");
  });

  it("keeps a structured count that the texts restate", () => {
    const [purchase] = extract(summary({ numOfPayments: 4 }));
    expect(purchase!.installmentCount).toBe(4);
    expect(purchase!.details.issues).not.toContain(
      "conflicting_installment_facts",
    );
  });

  it.each([
    ["0", null],
    ["000", null],
    ["SYNTHETIC-MERCHANT-7", "SYNTHETIC-MERCHANT-7"],
  ])(
    "publishes no merchant number for the foreign sentinel %j",
    (merchantId, expected) => {
      expect(extract({ merchantId })[0]!.merchantProviderId).toBe(expected);
    },
  );

  const converted = {
    trnIntId: "SYNTHETIC-TXN-CONVERTED",
    trnCurrencyIsoCode: "978",
    srcCurrencyCode: "978",
    transOriginalCurrencyCode: 7,
    trnCurrencySymbol: "€",
    trnAmt: 12.34,
  };

  it("drops original-amount text that restates the typed original money", () => {
    const text = "\u200fסכום העסקה - \u200e€12.34\u200f";
    const [row] = extract({ ...converted, transTypeCommentDetails: [text] });
    expect(row).toMatchObject({
      originalAmountMinor: -1234,
      originalCurrency: "EUR",
    });
    expect(row!.details.additionalInformation ?? []).not.toContain(text);
  });

  it.each([
    ["\u200fסכום העסקה - \u200e€12.35\u200f", "conflicting_original_amount"],
    ["\u200fסכום העסקה - \u200e$12.34\u200f", "conflicting_original_currency"],
  ])("leaves original money unknown when its text states %j", (text, issue) => {
    const [row] = extract({ ...converted, transTypeCommentDetails: [text] });
    expect(row).toMatchObject({
      originalAmountMinor: null,
      originalCurrency: null,
    });
    expect(row!.details.issues).toContain(issue);
    expect(row!.details.additionalInformation).toContain(text);
  });

  it("drops a grouped original amount that restates the typed amount", () => {
    const text = "‏סכום העסקה - ‎HUF1,234‏";
    const [row] = extract({
      ...converted,
      trnCurrencyIsoCode: "348",
      srcCurrencyCode: "348",
      transOriginalCurrencyCode: 97,
      trnCurrencySymbol: "HUF",
      trnAmt: 1234,
      transTypeCommentDetails: [text],
    });
    expect(row).toMatchObject({ originalCurrency: "HUF" });
    expect(row!.details.additionalInformation ?? []).not.toContain(text);
  });

  it.each([
    [{ srcCurrencyCode: "840" }],
    [{ trnCurrencyIsoCode: null, transOriginalCurrencyCode: null }],
  ])(
    "flags an original currency that srcCurrencyCode contradicts: %j",
    (difference) => {
      const [row] = extract({ ...converted, ...difference });
      expect(row!.originalCurrency).toBeNull();
      expect(row!.details.issues).toContain("conflicting_original_currency");
    },
  );

  it.each([
    ["ILS", false],
    ["EUR", true],
    ["Synthetic currency description", false],
  ])(
    "checks the billing currency against crmIccCurrencyDesc %j",
    (crmIccCurrencyDesc, conflict) => {
      const [row] = extract({ crmIccCurrencyDesc });
      expect(row!.details.issues.includes("conflicting_billing_currency")).toBe(
        conflict,
      );
    },
  );
});
