import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { calculateTotals } from "../../../src/domain/read-model.js";
import { isracardAdapter } from "../../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCardKey,
  serializeIsracardCapture,
} from "../../../src/providers/isracard/capture.js";
import { extractIsracard } from "../../../src/providers/isracard/extract.js";
import { openDatabase } from "../../../src/storage/sqlite/database.js";

type Row = Record<string, unknown>;

type Legacy = {
  CardsTransactionsListBean: {
    Index0: {
      CurrentCardTransactions: {
        txnIsrael: Row[];
        txnAbroad: Row[];
        txnInfo: Row[];
      }[];
    };
  };
};

type Digital = {
  data: {
    israelAbroadVouchers: {
      vouchers: { israelAbroadVouchersList: Row[]; totalForStatement?: Row };
      outOfStatementChargeDateVouchers: Row[];
    };
  };
};

function baseline(): IsracardCapture {
  return JSON.parse(
    readFileSync(
      new URL("./fixtures/card-month.json", import.meta.url),
      "utf8",
    ),
  ) as IsracardCapture;
}

/** The base capture with these DigitalV3 statement rows and legacy groups. */
function capture(change: {
  digital?: (data: Digital) => void;
  legacy?: (data: Legacy) => void;
}) {
  const result = baseline();
  const digital = JSON.parse(result.responses.digital!) as Digital;
  const legacy = JSON.parse(result.responses.legacy!) as Legacy;
  change.digital?.(digital);
  change.legacy?.(legacy);
  result.responses.digital = JSON.stringify(digital);
  result.responses.legacy = JSON.stringify(legacy);
  delete result.responses.details;
  return result;
}

function extract(source: IsracardCapture) {
  const accountKey = isracardCardKey(source.card);
  return extractIsracard(serializeIsracardCapture(source), {
    accountKey,
    runId: "synthetic-basis-run",
    scope: {
      kind: source.mode,
      month: source.billingMonth,
      cardKey: accountKey,
    },
  });
}

function totals(row: ReturnType<typeof extract>["transactions"][number]) {
  return calculateTotals([
    {
      ...row,
      supersededById: null,
      presence: "seen",
      fxFeeMinor: null,
      fxFeeCurrency: null,
    },
  ]);
}

const statementRow = (fields: Row): Row => ({
  purchaseDate: "11/06/2040",
  purchaseTime: "12:30:00",
  businessName: "Synthetic merchant",
  businessNumber: 7000009,
  isIsraelDeal: true,
  transactionCode: 1,
  billingAmount: 50,
  billingAmountCurrency: 0,
  originalAmount: 50,
  originalCurrencyIso: "ILS",
  discountAmount: null,
  currentInstallmentNum: null,
  numberOfInstallment: null,
  voucherNumber: 9001,
  seqVoucherNumber: "SYNTHETIC-BASIS-1",
  ...fields,
});

/** One DigitalV3 statement row, no legacy rows. */
function single(fields: Row) {
  return capture({
    digital: (data) => {
      data.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList = [
        statementRow(fields),
      ];
    },
    legacy: (data) => {
      data.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]!.txnIsrael =
        [];
    },
  });
}

describe("Isracard amount basis", () => {
  it("names a same-currency charge's bill as a purchase commitment and keeps its stated original money", () => {
    const [row] = extract(
      single({ billingAmount: 45, discountAmount: 5 }),
    ).transactions;
    expect(row).toMatchObject({
      kind: "purchase",
      amountMinor: -4500,
      currency: "ILS",
      amountBasis: "purchase_commitment",
      originalAmountMinor: -5000,
      originalCurrency: "ILS",
    });
    expect(row!.details.issues).not.toContain("isracard_unverified_semantics");
    expect(row!.details.issues).not.toContain("unverified_amount_basis");
    expect(totals(row!)).toMatchObject({
      totals: [
        {
          currency: "ILS",
          amountBasis: "purchase_commitment",
          amountMinor: -4500,
        },
      ],
    });
  });

  it("keeps a same-currency row whose original money does not reconcile unverified", () => {
    for (const fields of [
      { billingAmount: 45 },
      { billingAmount: 45, discountAmount: 4 },
      { billingAmount: 45, discountAmount: "five" },
      // One minor unit either way still does not reconcile.
      { billingAmount: 45, discountAmount: 4.99 },
      { billingAmount: 45, discountAmount: 5.01 },
      { billingAmount: 45, discountAmount: 5, originalAmount: 50.01 },
    ]) {
      const [row] = extract(single(fields)).transactions;
      expect(row, JSON.stringify(fields)).toMatchObject({
        amountMinor: -4500,
        amountBasis: "unknown",
        originalAmountMinor: null,
        originalCurrency: null,
      });
      expect(row!.details.issues).toEqual(
        expect.arrayContaining([
          "conflicting_original_amount",
          "isracard_unverified_semantics",
          "unverified_amount_basis",
        ]),
      );
      expect(totals(row!).includedCount).toBe(0);
    }
  });

  it("keeps cross-currency bills at an unknown basis with their stated original money and no rate", () => {
    for (const [billingAmountCurrency, currency] of [
      [19, "USD"],
      [0, "ILS"],
    ] as const) {
      const [row] = extract(
        single({
          transactionCode: 7,
          isIsraelDeal: false,
          billingAmount: 102,
          billingAmountCurrency,
          originalAmount: 95,
          originalCurrencyIso: "EUR",
          discountAmount: 2.04,
        }),
      ).transactions;
      expect(row).toMatchObject({
        kind: "purchase",
        amountMinor: -10200,
        currency,
        amountBasis: "unknown",
        originalAmountMinor: -9500,
        originalCurrency: "EUR",
      });
      expect(row!.fxFeeMinor ?? null).toBeNull();
      expect(row!.details.currencyExchange ?? null).toBeNull();
      expect(row!.details.issues).toContain("unverified_amount_basis");
      expect(totals(row!).includedCount).toBe(0);
    }
  });

  it("maps a waived card fee to amount 0 with the list fee as original money", () => {
    const [row] = extract(
      single({
        transactionCode: 12,
        billingAmount: 0,
        originalAmount: 20,
        discountAmount: 20,
        discountIndication: true,
        moreInfo: '   הנחה 20 ש"ח ',
      }),
    ).transactions;
    expect(row).toMatchObject({
      kind: "fee",
      amountMinor: 0,
      currency: "ILS",
      amountBasis: "purchase_commitment",
      originalAmountMinor: -2000,
      originalCurrency: "ILS",
    });
    expect(row!.details.issues).not.toContain("unverified_amount_basis");
  });

  it("keeps rows of unknown kind excluded whatever their currencies", () => {
    for (const fields of [
      { transactionCode: 999 },
      { transactionCode: 7, billingAmount: -50, originalAmount: -50 },
      { transactionCode: "1 " },
    ]) {
      const [row] = extract(single(fields)).transactions;
      expect(row, JSON.stringify(fields)).toMatchObject({
        kind: "unknown",
        amountBasis: "unknown",
      });
      expect(row!.details.issues).toEqual(
        expect.arrayContaining([
          "isracard_unverified_semantics",
          "unverified_amount_basis",
          "unsupported_transaction_type",
        ]),
      );
      expect(totals(row!)).toMatchObject({
        includedCount: 0,
        excluded: { unresolved: 1 },
      });
    }
  });

  describe("cash withdrawals", () => {
    type Withdrawal = { voucher: string; billed: number; withdrawn: string };

    type FeeLine = { amount: string; currencyId?: string; index?: "Index1" };

    const legacyLine = (fields: Row): Row => ({
      voucherNumberRatzOutbound: "000000000",
      voucherNumber: null,
      fullPurchaseDateOutbound: null,
      fullPaymentDate: null,
      fullSupplierNameOutbound: null,
      paymentSumOutbound: null,
      currencyId: "NIS",
      currentPaymentCurrency: null,
      ...fields,
    });
    const feeLine = ({ amount, currencyId = "NIS" }: FeeLine) =>
      legacyLine({
        fullSupplierNameOutbound: "CASH ADVANCE FEE",
        paymentSumOutbound: amount,
        currencyId,
      });

    /**
     * Code 8 bills in ILS with their legacy abroad withdrawals, and fee lines
     * on this card's legacy index unless another index is named.
     */
    function atm(
      fees: FeeLine[],
      withdrawals: Withdrawal[] = [
        { voucher: "SYNTHETIC-ATM-1", billed: 102, withdrawn: "100.00" },
      ],
    ) {
      return capture({
        digital: (data) => {
          data.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList =
            withdrawals.map(({ voucher, billed }) =>
              statementRow({
                transactionCode: 8,
                isIsraelDeal: false,
                presentCard: true,
                tranzacCodeType: "R",
                billingAmount: billed,
                originalAmount: 340,
                originalCurrencyIso: "TRY",
                seqVoucherNumber: voucher,
              }),
            );
        },
        legacy: (data) => {
          const bean =
            data.CardsTransactionsListBean as Legacy["CardsTransactionsListBean"] &
              Record<string, unknown>;
          const group = bean.Index0.CurrentCardTransactions[0]!;
          group.txnIsrael = [];
          group.txnAbroad = [
            ...withdrawals.map(({ voucher, withdrawn }) =>
              legacyLine({
                voucherNumberRatzOutbound: voucher,
                voucherNumber: "0009001",
                fullPurchaseDateOutbound: "11/06/2040",
                fullPaymentDate: "10/07/2040",
                fullSupplierNameOutbound: "SYNTHETIC ATM",
                paymentSumOutbound: withdrawn,
                dealSumOutbound: "340.00",
                currentPaymentCurrency: "TRY",
              }),
            ),
            ...fees.filter((fee) => !fee.index).map(feeLine),
          ];
          // Another card's legacy index in the same response.
          bean.Index1 = {
            CurrentCardTransactions: [
              {
                txnIsrael: null,
                txnAbroad: fees.filter((fee) => fee.index).map(feeLine),
                txnInfo: null,
              },
            ],
          };
        },
      });
    }

    const conflicted = (
      row: ReturnType<typeof extract>["transactions"][number],
    ) => {
      expect(row).toMatchObject({ amountMinor: null, currency: null });
      expect(row.details.issues).toContain(
        "conflicting_generation_billing_amount",
      );
    };

    it("uses the fee-inclusive DigitalV3 bill when legacy lists exactly one matching fee line", () => {
      const result = extract(atm([{ amount: "2.00" }]));
      expect(result.transactions).toHaveLength(1);
      const [row] = result.transactions;
      expect(row).toMatchObject({
        kind: "cash_withdrawal",
        amountMinor: -10200,
        currency: "ILS",
        // Cross-currency: the billed side's role stays unknown.
        amountBasis: "unknown",
        originalAmountMinor: -34000,
        originalCurrency: "TRY",
      });
      expect(row!.details.issues).not.toContain(
        "conflicting_generation_billing_amount",
      );
      // The fee line stays raw evidence and never becomes a row.
      expect(result.warnings).toContain(
        "legacy_statement_artifacts_preserved_raw",
      );
    });

    it.each([
      ["no fee line", []],
      ["a fee line of another amount", [{ amount: "3.00" }]],
      [
        "two fee lines that only add up",
        [{ amount: "1.00" }, { amount: "1.00" }],
      ],
      [
        "a fee line in another currency",
        [{ amount: "2.00", currencyId: "USD" }],
      ],
      [
        "a fee line on another card",
        [{ amount: "2.00", index: "Index1" as const }],
      ],
    ])("keeps the generation conflict with %s", (_name, fees) => {
      conflicted(extract(atm(fees)).transactions[0]!);
    });

    it("lets one fee line explain at most one withdrawal", () => {
      const two: Withdrawal[] = [
        { voucher: "SYNTHETIC-ATM-1", billed: 102, withdrawn: "100.00" },
        { voucher: "SYNTHETIC-ATM-2", billed: 202, withdrawn: "200.00" },
      ];
      // One 2.00 fee fits both withdrawals: neither is explained.
      for (const row of extract(atm([{ amount: "2.00" }], two)).transactions) {
        conflicted(row);
      }
      // Two equal fee lines fit both withdrawals interchangeably: no unique
      // assignment, so both conflicts stay.
      for (const row of extract(
        atm([{ amount: "2.00" }, { amount: "2.00" }], two),
      ).transactions) {
        conflicted(row);
      }
      // Distinct fees with one fit each are a unique assignment.
      const distinct = extract(
        atm(
          [{ amount: "2.00" }, { amount: "4.00" }],
          [
            { voucher: "SYNTHETIC-ATM-1", billed: 102, withdrawn: "100.00" },
            { voucher: "SYNTHETIC-ATM-2", billed: 204, withdrawn: "200.00" },
          ],
        ),
      ).transactions;
      expect(distinct.map((row) => row.amountMinor)).toEqual([-10200, -20400]);
    });

    it("never takes a fee line from the adjacent month's capture", async () => {
      const db = await openDatabase(":memory:");
      try {
        await db.ensureConnection({
          id: "synthetic-isracard",
          provider: "isracard",
        });
        const july = atm([]);
        const august = atm([{ amount: "2.00" }], []);
        august.billingMonth = "2040-08";
        for (const [index, month] of [july, august].entries()) {
          const accountKey = isracardCardKey(month.card);
          await db.ingestRun(
            {
              connectionId: "synthetic-isracard",
              runId: `synthetic-atm-${index}`,
              responses: [
                {
                  accountKey,
                  endpoint: "isracard:card-month",
                  capturedAt: `2040-08-0${index + 1}T00:00:00.000Z`,
                  responseText: serializeIsracardCapture(month),
                  scope: {
                    kind: month.mode,
                    month: month.billingMonth,
                    cardKey: accountKey,
                  },
                },
              ],
            },
            isracardAdapter,
          );
        }
        const rows = await db.listTransactions();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          amountMinor: null,
          kind: "cash_withdrawal",
        });
        expect(rows[0]!.details.issues).toContain(
          "conflicting_generation_billing_amount",
        );
      } finally {
        await db.close();
      }
    });
  });

  it("maps a legacy-only domestic waived fee to a fee of amount 0 and keeps other legacy-only rows unknown", () => {
    const legacyOnly = (fields: Row) =>
      capture({
        digital: (data) => {
          data.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList = [];
        },
        legacy: (data) => {
          data.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]!.txnIsrael =
            [
              {
                fullPurchaseDate: "01/06/2040",
                fullSupplierNameHeb: "Synthetic card fee",
                voucherNumberRatz: "SYNTHETIC-FEE-1",
                voucherNumber: null,
                dealSum: "20.00",
                paymentSum: "0.00",
                currencyId: 'ש"ח',
                kodMatbeaMekori: 'ש"ח',
                moreInfo: 'הנחה 20.00      ש"ח מימון כל א',
                ...fields,
              },
            ];
        },
      });
    const [fee] = extract(legacyOnly({})).transactions;
    expect(fee).toMatchObject({ kind: "fee", amountMinor: 0, currency: "ILS" });
    expect(fee!.details.issues).not.toContain("unsupported_transaction_type");
    for (const fields of [
      { paymentSum: "5.00" },
      { dealSum: "0.00" },
      { moreInfo: "Synthetic note" },
    ]) {
      const [row] = extract(legacyOnly(fields)).transactions;
      expect(row!.kind, JSON.stringify(fields)).toBe("unknown");
    }
  });

  describe("source totals", () => {
    it("records no warning when every source total equals its rows", () => {
      const source = capture({
        digital: (data) => {
          const base = data.data.israelAbroadVouchers;
          base.vouchers.israelAbroadVouchersList = [
            statementRow({ billingAmount: 50 }),
            statementRow({
              billingAmount: 12.5,
              originalAmount: 12.5,
              seqVoucherNumber: "SYNTHETIC-BASIS-2",
            }),
          ];
          base.vouchers.totalForStatement = {
            totalIlsBillingDate: 62.5,
            totalUsdBillingDate: 0,
            totalEurBillingDate: 0,
          };
          base.outOfStatementChargeDateVouchers = [
            {
              totalVouchersCurrencyDate: {
                dateImmediateVouchers: "20/06/2040",
                currencyImmediateVouchers: 19,
                totalImmediateVouchers: 7.25,
                countImmediateVouchers: 1,
              },
              immediateVouchersCurrencyDate: [
                statementRow({
                  transactionCode: 7,
                  billingAmount: 7.25,
                  billingAmountCurrency: 19,
                  originalAmount: 7.25,
                  originalCurrencyIso: "USD",
                  seqVoucherNumber: "SYNTHETIC-BASIS-3",
                }),
              ],
            },
          ];
        },
        legacy: (data) => {
          data.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]!.txnIsrael =
            [
              {
                fullPurchaseDate: "11/06/2040",
                voucherNumberRatz: "SYNTHETIC-BASIS-1",
                paymentSum: "50.00",
                currencyId: 'ש"ח',
              },
              {
                fullPurchaseDate: "11/06/2040",
                voucherNumberRatz: "SYNTHETIC-BASIS-2",
                paymentSum: "12.50",
                currencyId: 'ש"ח',
              },
              {
                voucherNumberRatz: "000000000",
                dealSumType: "1",
                paymentSum: "62.50",
                currencyId: null,
              },
            ];
        },
      });
      const result = extract(source);
      for (const warning of [
        "digital_statement_total_mismatch",
        "digital_immediate_total_mismatch",
        "legacy_total_mismatch",
      ]) {
        expect(result.warnings).not.toContain(warning);
      }
      expect(result.partitions[0]!.success).toBe(true);

      // A wrong total in each source is a warning, never a failure.
      const digital = JSON.parse(source.responses.digital!) as Digital;
      digital.data.israelAbroadVouchers.vouchers.totalForStatement!.totalIlsBillingDate = 62.51;
      digital.data.israelAbroadVouchers.outOfStatementChargeDateVouchers[0]!.totalVouchersCurrencyDate =
        {
          dateImmediateVouchers: "20/06/2040",
          currencyImmediateVouchers: 19,
          totalImmediateVouchers: 7.25,
          countImmediateVouchers: 2,
        };
      source.responses.digital = JSON.stringify(digital);
      source.responses.legacy = source.responses.legacy!.replace(
        '"paymentSum":"62.50"',
        '"paymentSum":"62.00"',
      );
      const mismatched = extract(source);
      expect(mismatched.warnings).toEqual(
        expect.arrayContaining([
          "digital_statement_total_mismatch",
          "digital_immediate_total_mismatch",
          "legacy_total_mismatch",
        ]),
      );
      expect(mismatched.partitions[0]!.success).toBe(true);
      expect(mismatched.transactions).toHaveLength(3);
    });

    it.each(["000000000", "SYNTHETIC-USD-TOTAL"])(
      "compares legacy USD totals with voucher %s and abroad dated totals, fee lines included",
      (totalVoucher) => {
        const zero = "000000000";
        const legacy = (usdTotal: string, abroadTotal: string) =>
          capture({
            digital: (data) => {
              data.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList =
                [];
            },
            legacy: (data) => {
              const group =
                data.CardsTransactionsListBean.Index0
                  .CurrentCardTransactions[0]!;
              group.txnIsrael = [
                {
                  fullPurchaseDate: "11/06/2040",
                  voucherNumberRatz: "SYNTHETIC-USD-1",
                  paymentSum: "7.25",
                  currencyId: "USD",
                },
                {
                  voucherNumberRatz: totalVoucher,
                  fullPurchaseDate: "11/06/2040",
                  dealSumType: "T",
                  paymentSum: usdTotal,
                  currencyId: "USD",
                },
              ];
              group.txnAbroad = [
                {
                  fullPurchaseDateOutbound: "11/06/2040",
                  voucherNumberRatzOutbound: "SYNTHETIC-ATM-1",
                  fullSupplierNameOutbound: "SYNTHETIC ATM",
                  paymentSumOutbound: "100.00",
                  currencyId: "NIS",
                },
                ...[
                  ["CASH ADVANCE FEE", "2.00"],
                  ["TOTAL FOR DATE", abroadTotal],
                ].map(([label, amount]) => ({
                  voucherNumberRatzOutbound: zero,
                  fullSupplierNameOutbound: label,
                  paymentSumOutbound: amount,
                  currencyId: "NIS",
                })),
              ];
            },
          });
        const source = legacy("7.25", "102.00");
        const reconciled = extract(source);
        expect(reconciled.transactions).toHaveLength(2);
        expect(reconciled.transactions.map((row) => row.sourceKey)).toEqual([
          expect.stringContaining("SYNTHETIC-USD-1"),
          expect.stringContaining("SYNTHETIC-ATM-1"),
        ]);
        expect(source.responses.legacy).toContain(totalVoucher);
        expect(reconciled.warnings).not.toContain("legacy_total_mismatch");
        for (const [usdTotal, abroadTotal] of [
          ["7.00", "102.00"],
          ["7.25", "100.00"],
        ] as const) {
          const result = extract(legacy(usdTotal, abroadTotal));
          expect(result.warnings, `${usdTotal} ${abroadTotal}`).toContain(
            "legacy_total_mismatch",
          );
          expect(result.partitions[0]!.success).toBe(true);
        }
      },
    );
  });
});
