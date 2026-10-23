import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { transactionInputSchema } from "../../../src/domain/model.js";
import { extractCal } from "../../../src/providers/cal/extract.js";

type SourceRow = Record<string, unknown>;

// This absent-count combination is invented, not an observed provider shape.
function payment(fields: SourceRow = {}): SourceRow {
  const rows = JSON.parse(
    readFileSync(
      new URL("./fixtures/installment-plans.json", import.meta.url),
      "utf8",
    ),
  ).result.transactions as SourceRow[];
  return {
    ...rows.find(
      (row) =>
        row.trnIntId === "SYNTHETIC-TXN-PLAN-ROUNDING" &&
        row.curPaymentNum === 2,
    )!,
    numOfPayments: null,
    transTypeCommentDetails: [],
    onGoingTransactionsComment: "",
    ...fields,
  };
}

function extract(...rows: SourceRow[]) {
  const result = extractCal(
    JSON.stringify({
      statusCode: 1,
      result: { transactions: rows, clearanceRequests: [] },
    }),
    { accountKey: "SYNTHETIC-ACCOUNT", runId: "synthetic-installment-role" },
  );
  for (const transaction of result.transactions) {
    expect(transactionInputSchema.safeParse(transaction).success).toBe(true);
  }
  return result.transactions;
}

describe("CAL installment role without a planned count", () => {
  it("extracts an observed payment independently of its unknown plan size", () => {
    const rows = extract(payment());
    expect(rows).toHaveLength(2);
    const [purchase, line] = rows;
    expect(purchase).toMatchObject({
      sourceKey:
        'cal:posted:purchase:["SYNTHETIC-CARD-A","SYNTHETIC-TXN-PLAN-ROUNDING"]',
      amountBasis: "purchase_commitment",
      amountMinor: -10000,
      currency: "ILS",
      installmentCount: null,
      billingDate: null,
    });
    expect(purchase!.installmentNumber ?? null).toBeNull();
    expect(purchase!.purchaseKey).toBeUndefined();
    expect(line).toMatchObject({
      sourceKey:
        'cal:posted:line:["SYNTHETIC-CARD-A","SYNTHETIC-TXN-PLAN-ROUNDING",2]',
      purchaseKey: purchase!.sourceKey,
      amountBasis: "booked_entry",
      amountMinor: -3333,
      currency: "ILS",
      originalAmountMinor: null,
      originalCurrency: null,
      installmentCount: null,
      installmentNumber: 2,
      billingDate: "2040-07-10",
    });
    for (const row of rows) {
      expect(row.details.issues).toContain("unknown_installment_count");
      expect(row.details.provider.cal!.rows).toMatchObject([
        { transactionTypeCode: "8", numOfPayments: null, curPaymentNum: "2" },
      ]);
      expect(row.fxFeeMinor).toBeNull();
      expect(row.fxFeeCurrency).toBeNull();
      expect(row.details.currencyExchange).toBeUndefined();
    }
  });

  it("keeps an explicit single-payment restatement as one purchase", () => {
    const rows = extract(
      payment({
        numOfPayments: 1,
        curPaymentNum: 1,
        amtBeforeConvAndIndex: 100,
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amountMinor: -10000,
      installmentCount: 1,
      billingDate: "2040-07-10",
    });
    expect(rows[0]!.purchaseKey).toBeUndefined();
    expect(rows[0]!.installmentNumber ?? null).toBeNull();
  });

  it("does not invent a billed line when the source states no ordinal or count", () => {
    const rows = extract(payment({ curPaymentNum: null }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amountMinor: -10000,
      currency: "ILS",
      amountBasis: "unknown",
      installmentCount: null,
      billingDate: null,
    });
    expect(rows[0]!.details.issues).toContain("unresolved_installment_role");
    expect(rows[0]!.purchaseKey).toBeUndefined();
    expect(rows[0]!.installmentNumber ?? null).toBeNull();
  });

  it("keeps missing component money unresolved rather than substituting the principal", () => {
    const rows = extract(payment({ amtBeforeConvAndIndex: null }));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.amountMinor).toBe(-10000);
    expect(rows[1]).toMatchObject({
      purchaseKey: rows[0]!.sourceKey,
      amountMinor: null,
      currency: null,
      installmentCount: null,
      installmentNumber: 2,
    });
    expect(rows[1]!.details.issues).toContain(
      "unresolved_installment_component",
    );
  });
});
