import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { transactionInputSchema } from "../../../src/domain/model.js";
import { extractCal } from "../../../src/providers/cal/extract.js";

// Invented examples reproduce only patterns described by the live shape audit.
// No live financial response or identifier is needed by these tests.
type Row = Record<string, unknown>;

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/recent-01.json", import.meta.url), "utf8"),
);
const installment: Row = fixture.result.transactions.find(
  (row: Row) => row.trnIntId === "SYNTHETIC-TXN-INSTALLMENTS",
);
const cancellation: Row = fixture.result.transactions.find(
  (row: Row) => row.trnIntId === "SYNTHETIC-TXN-CANCEL",
);
const regular: Row = fixture.result.transactions.find(
  (row: Row) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
);

function extract(rows: Row[]) {
  const result = extractCal(
    JSON.stringify({
      statusCode: 1,
      result: { transactions: rows, clearanceRequests: [] },
    }),
    {
      accountKey: "SYNTHETIC-LIVE-PATTERN-ACCOUNT",
      runId: "synthetic-live-pattern-run",
    },
  );
  for (const row of result.transactions) {
    expect(transactionInputSchema.safeParse(row).success).toBe(true);
  }
  return result;
}

describe("CAL patterns evidenced by the live shape audit", () => {
  it.each([4, 7])(
    "groups %i native installment observations with absent original currency without multiplying commitment money",
    (count) => {
      const rows = Array.from({ length: count }, (_, index) => ({
        ...installment,
        trnIntId: "SYNTHETIC-MISSING-ORIGINAL",
        amountForDisplay: 1680,
        trnAmt: 1680.5,
        trnCurrencyIsoCode: null,
        transOriginalCurrencyCode: null,
        numOfPayments: 12,
        curPaymentNum: index + 1,
        debCrdDate: `2040-${String(index + 1).padStart(2, "0")}-10T00:00:00`,
        trnNumaretor: index + 10,
        earlyPaymentInd: index % 2 === 0,
      }));
      const result = extract(rows);
      // One purchase from any rows, plus one billed line per payment.
      expect(result.transactions).toHaveLength(count + 1);
      expect(result.transactions[0]).toMatchObject({
        identityStrength: "native",
        amountMinor: -168000,
        currency: "ILS",
        originalAmountMinor: null,
        originalCurrency: null,
        billingDate: null,
        installmentCount: 12,
      });
      expect(
        result.transactions.slice(1).map((line) => line.installmentNumber),
      ).toEqual(rows.map((row) => row.curPaymentNum));
      expect(result.transactions[0]!.details.sourceRefs).toHaveLength(count);
      expect(result.warnings).not.toContain("ambiguous_posted_identity");
    },
  );

  it.each([
    { trnAmt: -2 },
    { trnAmt: 20.01 },
    { trnCurrencyIsoCode: "999" },
    { transOriginalCurrencyCode: 99 },
  ])(
    "keeps one purchase in review when its payments differ by %j",
    (difference) => {
      const row = {
        ...installment,
        trnCurrencyIsoCode: null,
        transOriginalCurrencyCode: null,
        trnAmt: 20,
      };
      const result = extract([
        { ...row, curPaymentNum: 1 },
        { ...row, curPaymentNum: 2, ...difference },
      ]);
      const [purchase, ...lines] = result.transactions;
      expect(purchase).toMatchObject({
        identityStrength: "native",
      });
      expect(purchase!.details.issues).toContain(
        "conflicting_installment_facts",
      );
      expect(lines.map((line) => line.installmentNumber)).toEqual([1, 2]);
      expect(result.warnings).not.toContain("ambiguous_posted_identity");
    },
  );

  it("sums explicit cancellation components with distinct zero and positive ordinals", () => {
    const row = {
      ...cancellation,
      trnIntId: "SYNTHETIC-ZERO-CANCELLATION",
      numOfPayments: 0,
      debCrdDate: "2040-07-10T00:00:00",
    };
    const result = extract([
      { ...row, amountForDisplay: -175, curPaymentNum: 0 },
      { ...row, amountForDisplay: -225, curPaymentNum: 2 },
    ]);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      identityStrength: "native",
      kind: "refund",
      amountMinor: 40000,
      currency: "ILS",
      installmentCount: null,
    });
    expect(result.transactions[0]!.details.issues).toContain(
      "unknown_installment_count",
    );
    expect(result.transactions[0]!.details.sourceRefs).toHaveLength(2);
    expect(result.transactions[0]!.billingDate).toBeNull();
    expect(result.transactions[0]!.installmentNumber).toBeUndefined();
  });

  it("keeps a plan with contradictory original symbols in review when both original currency codes are absent", () => {
    const row = {
      ...installment,
      trnCurrencyIsoCode: null,
      transOriginalCurrencyCode: null,
      trnAmt: 20,
    };
    const result = extract([
      { ...row, curPaymentNum: 1, trnCurrencySymbol: "USD" },
      { ...row, curPaymentNum: 2, trnCurrencySymbol: "EUR" },
    ]);
    expect(result.transactions).toHaveLength(3);
    expect(result.transactions[0]).toMatchObject({
      identityStrength: "native",
    });
    expect(result.transactions[0]!.details.issues).toContain(
      "conflicting_installment_facts",
    );
    const consistent = extract([
      { ...row, curPaymentNum: 1, trnCurrencySymbol: "USD" },
      { ...row, curPaymentNum: 2, trnCurrencySymbol: "USD" },
    ]);
    expect(consistent.transactions).toHaveLength(3);
    expect(consistent.transactions[0]!.details.issues).not.toContain(
      "conflicting_installment_facts",
    );
    expect(consistent.transactions[0]).toMatchObject({
      identityStrength: "native",
      originalCurrency: null,
      originalAmountMinor: null,
    });
  });

  it("leaves a plan's original money unknown when its rows state different original amounts", () => {
    const rows = [
      { ...installment, curPaymentNum: 1, trnAmt: 1200 },
      { ...installment, curPaymentNum: 2, trnAmt: 1100 },
    ];
    const [purchase] = extract(rows).transactions;
    expect(purchase).toMatchObject({
      amountMinor: -120000,
      currency: "ILS",
      originalAmountMinor: null,
      originalCurrency: null,
    });
    expect(purchase!.details.issues).toContain("conflicting_original_amount");
    const [agreeing] = extract(
      rows.map((row) => ({ ...row, trnAmt: 1200 })),
    ).transactions;
    expect(agreeing).toMatchObject({
      originalAmountMinor: -120000,
      originalCurrency: "ILS",
    });
    expect(agreeing!.details.issues).not.toContain(
      "conflicting_original_amount",
    );
  });

  it("makes payment context a conflict when a plan's rows disagree, keeping every comment as text", () => {
    const contactless = "עסקה שבוצעה באמצעות Contact less";
    const rows = [
      {
        ...installment,
        curPaymentNum: 1,
        trnExacWay: 21,
        comments: [{ key: contactless, value: "" }],
      },
      { ...installment, curPaymentNum: 2, trnExacWay: 12, comments: [] },
    ];
    const [purchase] = extract(rows).transactions;
    expect(purchase!.authorizationMethod).toBeNull();
    expect(purchase!.details.issues).toContain("conflicting_payment_context");
    expect(purchase!.details.additionalInformation).toContain(contactless);
    // A row without evidence does not vote: the contactless row alone decides.
    const [agreeing] = extract([
      rows[0]!,
      { ...rows[1]!, trnExacWay: 0 },
    ]).transactions;
    expect(agreeing!.authorizationMethod).toBe("contactless");
    expect(agreeing!.details.issues).not.toContain(
      "conflicting_payment_context",
    );
    expect(agreeing!.details.additionalInformation).not.toContain(contactless);
  });

  it.each([-1, 0.5, 2])(
    "rejects invalid or duplicate cancellation ordinals %i",
    (ordinal) => {
      const row = { ...cancellation, numOfPayments: 0 };
      const result = extract([
        { ...row, curPaymentNum: ordinal },
        { ...row, curPaymentNum: 2 },
      ]);
      expect(result.transactions).toHaveLength(2);
      expect(
        result.transactions.every(
          (item) => item.identityStrength === "ambiguous",
        ),
      ).toBe(true);
    },
  );

  it("keeps ordinal zero unsupported for ordinary installment grouping", () => {
    const result = extract([
      { ...installment, curPaymentNum: 0 },
      { ...installment, curPaymentNum: 2 },
    ]);
    expect(result.transactions).toHaveLength(2);
    expect(
      result.transactions.every(
        (item) => item.identityStrength === "ambiguous",
      ),
    ).toBe(true);
  });

  it("interprets a consistent recurring reversal as a refund with exact canonical sign", () => {
    const result = extract([
      {
        ...regular,
        transactionTypeCode: 9,
        trnType: "הוראת קבע",
        refundInd: true,
        amountForDisplay: -44.25,
        trnAmt: 44.25,
      },
    ]);
    expect(result.transactions[0]).toMatchObject({
      kind: "refund",
      amountMinor: 4425,
      currency: "ILS",
      originalAmountMinor: 4425,
      originalCurrency: "ILS",
    });
    expect(result.transactions[0]!.details.issues).not.toContain(
      "unsupported_amount_direction",
    );
  });

  it.each([
    { transactionTypeCode: 5, trnType: "רגילה" },
    { transactionTypeCode: 25, trnType: "השבת מכירה" },
  ])(
    "interprets the evidenced regular/sale reversal only with a consistent refund flag and negative display %j",
    (difference) => {
      expect(
        extract([
          {
            ...regular,
            ...difference,
            refundInd: true,
            amountForDisplay: -44.25,
            trnAmt: 44.25,
          },
        ]).transactions[0],
      ).toMatchObject({
        kind: "refund",
        amountMinor: 4425,
        currency: "ILS",
        originalAmountMinor: 4425,
        originalCurrency: "ILS",
      });
    },
  );

  it.each([
    { refundInd: false, amountForDisplay: -44.25 },
    { refundInd: true, amountForDisplay: 44.25 },
  ])(
    "leaves inconsistent sale reversal signs/flags unresolved %j",
    (difference) => {
      const row = extract([
        {
          ...regular,
          transactionTypeCode: 25,
          trnType: "השבת מכירה",
          ...difference,
        },
      ]).transactions[0]!;
      expect(row).toMatchObject({
        kind: "refund",
        amountMinor: null,
        currency: null,
      });
      expect(row.details.issues).toContain("unsupported_amount_direction");
    },
  );

  it("classifies an evidenced cash withdrawal (type 7) as an outflow", () => {
    const row = extract([
      {
        ...regular,
        transactionTypeCode: 7,
        trnType: "משיכת מזומן",
        refundInd: false,
        amountForDisplay: 60,
      },
    ]).transactions[0]!;
    expect(row).toMatchObject({
      kind: "cash_withdrawal",
      amountMinor: -6000,
      currency: "ILS",
      providerTransactionCode: "7",
    });
    expect(row.details.issues).not.toContain("unsupported_transaction_type");
    expect(transactionInputSchema.safeParse(row).success).toBe(true);
  });

  it("classifies a flagged service refund (type 71) as an inflow and keeps inconsistent signs unresolved", () => {
    const refund = extract([
      {
        ...regular,
        transactionTypeCode: 71,
        trnType: "החזר שרותים",
        refundInd: true,
        amountForDisplay: -60,
      },
    ]).transactions[0]!;
    expect(refund).toMatchObject({
      kind: "refund",
      amountMinor: 6000,
      currency: "ILS",
      providerTransactionCode: "71",
    });
    expect(refund.details.issues).not.toContain("unsupported_transaction_type");
    const inconsistent = extract([
      {
        ...regular,
        transactionTypeCode: 71,
        trnType: "החזר שרותים",
        refundInd: true,
        amountForDisplay: 60,
      },
    ]).transactions[0]!;
    expect(inconsistent).toMatchObject({
      kind: "refund",
      amountMinor: null,
    });
    expect(inconsistent.details.issues).toContain(
      "unsupported_amount_direction",
    );
  });

  it.each([
    {
      transactionTypeCode: 26,
      refundInd: false,
      amountForDisplay: 60,
      trnType: "ביטול זיכוי",
    },
    {
      transactionTypeCode: 27,
      refundInd: true,
      amountForDisplay: -60,
      trnType: "השבת מזומן",
    },
    // A service refund without the source refund flag is not a refund.
    {
      transactionTypeCode: 71,
      refundInd: false,
      amountForDisplay: -60,
      trnType: "החזר שרותים",
    },
    {
      transactionTypeCode: 76,
      refundInd: false,
      amountForDisplay: 60,
      trnType: "חיוב/זיכוי",
    },
    {
      transactionTypeCode: 72,
      refundInd: false,
      amountForDisplay: 60,
      trnType: "שירות",
    },
    {
      transactionTypeCode: 72,
      refundInd: true,
      amountForDisplay: -60,
      trnType: "שירות",
    },
  ])(
    "preserves unsupported credit/service/adjustment variants for review without inventing financial policy %j",
    (difference) => {
      const row = extract([{ ...regular, ...difference }]).transactions[0]!;
      expect(row).toMatchObject({
        kind: "unknown",
        amountMinor: null,
        currency: null,
      });
      expect(row.details.issues).toContain("unsupported_transaction_type");
      expect(row.details.provider.cal?.rows).toEqual([
        expect.objectContaining({
          transactionTypeCode: String(difference.transactionTypeCode),
          amountForDisplay: String(difference.amountForDisplay),
          refundInd: difference.refundInd,
        }),
      ]);
    },
  );

  it.each([
    { transactionTypeCode: 9, refundInd: false, amountForDisplay: -44.25 },
    { transactionTypeCode: 9, refundInd: true, amountForDisplay: 44.25 },
    { transactionTypeCode: 8, refundInd: true, amountForDisplay: -44.25 },
  ])(
    "does not generalize recurring-refund policy to inconsistent flags or other codes %j",
    (difference) => {
      const result = extract([{ ...regular, ...difference }]);
      expect(result.transactions[0]).toMatchObject({
        kind: "purchase",
        amountMinor: null,
        currency: null,
      });
      expect(result.transactions[0]!.details.issues).toContain(
        "unsupported_amount_direction",
      );
    },
  );

  it.each([
    { refundInd: false, amountForDisplay: 88.5 },
    { refundInd: true, amountForDisplay: -88.5 },
  ])(
    "retains type76 charge/credit evidence unresolved without inventing financial meaning %j",
    (direction) => {
      const result = extract([
        {
          ...regular,
          transactionTypeCode: 76,
          trnType: "חיוב/זיכוי",
          ...direction,
        },
      ]);
      expect(result.transactions[0]).toMatchObject({
        identityStrength: "native",
        kind: "unknown",
        amountMinor: null,
        currency: null,
      });
      expect(result.transactions[0]!.details.issues).toContain(
        "unsupported_transaction_type",
      );
      expect(result.transactions[0]!.details.provider.cal?.rows).toEqual([
        expect.objectContaining({
          transactionTypeCode: "76",
          amountForDisplay: String(direction.amountForDisplay),
          refundInd: direction.refundInd,
        }),
      ]);
    },
  );
});
