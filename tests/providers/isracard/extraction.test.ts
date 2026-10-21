import { readFileSync } from "node:fs";

import { isLosslessNumber, parse } from "lossless-json";
import { describe, expect, it } from "vitest";

import { presentWireTransaction } from "../../../src/application/wire-output.js";
import {
  parsedLedgerFacts,
  storedPaymentContext,
  transactionInputSchema,
} from "../../../src/domain/model.js";
import { calculateTotals } from "../../../src/domain/read-model.js";
import { isracardAdapter } from "../../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCardKey,
  serializeIsracardCapture,
} from "../../../src/providers/isracard/capture.js";
import { extractIsracard } from "../../../src/providers/isracard/extract.js";
import {
  type Database,
  openDatabase,
} from "../../../src/storage/sqlite/database.js";
import { syncRunBodies, syncRuns } from "../../../src/storage/sqlite/schema.js";

type Row = Record<string, unknown>;

function baseline(name = "card-month"): IsracardCapture {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as IsracardCapture;
}

async function ingestCapture(
  db: Database,
  capture: IsracardCapture,
  index: number,
) {
  const accountKey = isracardCardKey(capture.card);
  return db.ingestRun(
    {
      debugArchiveDays: 2,
      connectionId: "synthetic-isracard",
      runId: `synthetic-review-${index}`,
      responses: [
        {
          accountKey,
          endpoint: "isracard:card-month",
          capturedAt: `2040-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
          responseText: serializeIsracardCapture(capture),
          scope: {
            kind: capture.mode,
            month: capture.billingMonth,
            cardKey: accountKey,
          },
        },
      ],
    },
    isracardAdapter,
  );
}

function extractRaw(capture = baseline()) {
  const accountKey = isracardCardKey(capture.card);
  return extractIsracard(serializeIsracardCapture(capture), {
    accountKey,
    runId: "synthetic-isracard-run",
    scope: {
      kind: capture.mode,
      month: capture.billingMonth,
      cardKey: accountKey,
    },
  });
}

/** Payment facts as the ledger stores them: an omitted fact (no evidence) is null. */
function extract(capture = baseline()) {
  const result = extractRaw(capture);
  return {
    ...result,
    transactions: result.transactions.map((row) => ({
      ...row,
      ...parsedLedgerFacts(row),
      ...storedPaymentContext(row, undefined),
    })),
  };
}

function updateDigital(
  capture: IsracardCapture,
  change: (rows: Row[], data: Row) => void,
): void {
  const response = JSON.parse(capture.responses.digital!) as {
    data: Row & {
      israelAbroadVouchers: { vouchers: { israelAbroadVouchersList: Row[] } };
    };
  };
  change(
    response.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList,
    response.data,
  );
  capture.responses.digital = JSON.stringify(response);
}

function updateLegacy(
  capture: IsracardCapture,
  change: (rows: Row[], data: Row) => void,
): void {
  const response = JSON.parse(capture.responses.legacy!) as {
    CardsTransactionsListBean: Row & {
      Index0: { CurrentCardTransactions: { txnIsrael: Row[] }[] };
    };
  };
  change(
    response.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]!
      .txnIsrael,
    response.CardsTransactionsListBean,
  );
  capture.responses.legacy = JSON.stringify(response);
}

describe("Isracard extraction", () => {
  it.each([
    ["Apple Pay", "apple_pay"],
    [" Apple  Pay ", "apple_pay"],
    ["GOOGLE PAY", "google_pay"],
    ["Samsung Pay", "samsung_pay"],
    ["Synthetic opaque wallet display", null],
  ])(
    "maps explicit wallet name %j to %j only from a uniquely matched detail without inferring presence",
    (walletPayName, wallet) => {
      const capture = baseline();
      const entry = capture.responses.details![0]!;
      entry.responseText = JSON.stringify({
        Header: { Status: "1" },
        PirteyIska_204Bean: {
          voucherNumberRatz: entry.voucherNumber,
          walletPayName,
        },
      });
      const row = extract(capture).transactions[0]!;
      expect(row.wallet).toBe(wallet);
      // A false presentCard states nothing: in-store wallet payments are false.
      expect(row.cardPresent ?? null).toBeNull();
      expect(row.details.provider.isracard!.detail).toMatchObject({
        walletPayName,
      });
    },
  );

  it.each([
    [
      "wallet flags",
      [
        "missing",
        "mismatch",
        "padded",
        "duplicate-detail",
        "ambiguous-transaction",
        "flag-only",
        "whitespace",
      ],
    ],
    [
      "detail projection",
      ["mismatch", "missing", "padded", "numeric", "bound"],
    ],
    ["walletPayName", ["mismatch", "missing", "matched"]],
    ["transactionType", ["mismatch", "missing", "matched"]],
  ] as const)(
    "binds %s only to unique matching vouchers",
    (context, variants) => {
      for (const variant of variants) {
        const capture = baseline();
        if (variant === "bound") {
          const row = extract(capture).transactions[0]!;
          expect(row.details.merchant).toMatchObject({
            address: "1 Synthetic Street",
            phone: "SYNTHETIC-PHONE",
          });
          expect(row.details.issues).not.toContain(
            "invalid_transaction_detail",
          );
          continue;
        }
        const entry = capture.responses.details![0]!;
        const rich = context === "detail projection";
        const bean: Row = rich
          ? (JSON.parse(entry.responseText) as { PirteyIska_204Bean: Row })
              .PirteyIska_204Bean
          : {};
        if (rich) {
          expect(bean.voucherNumberRatz).toBe(entry.voucherNumber);
        }
        if (variant === "missing") {
          delete bean.voucherNumberRatz;
        } else {
          bean.voucherNumberRatz =
            variant === "mismatch"
              ? "OTHER-SYNTHETIC-VOUCHER"
              : variant === "padded"
                ? rich
                  ? `0${entry.voucherNumber}`
                  : ` ${entry.voucherNumber} `
                : variant === "numeric"
                  ? 1
                  : entry.voucherNumber;
        }
        const field =
          context === "transactionType" ? "transactionType" : "walletPayName";
        bean[field] =
          variant === "flag-only"
            ? null
            : variant === "whitespace"
              ? " \t\n "
              : context === "transactionType"
                ? "APPLE PAY"
                : "Apple Pay";
        entry.responseText = JSON.stringify({
          Header: { Status: "1" },
          PirteyIska_204Bean: bean,
        });
        if (variant === "duplicate-detail") {
          capture.responses.details!.push({ ...entry });
        }
        if (context === "wallet flags") {
          updateDigital(capture, (rows) => {
            rows[0]!.isWalletTransaction = true;
            if (variant === "ambiguous-transaction") {
              rows.push({ ...rows[0] });
            }
          });
        }
        const rows = extract(capture).transactions;
        if (context === "wallet flags") {
          for (const row of rows) {
            expect(row.wallet, variant).toBeNull();
            expect(row.cardPresent ?? null, variant).toBeNull();
          }
        } else {
          const row = rows[0]!;
          expect(row.wallet, variant).toBe(
            variant === "matched" ? "apple_pay" : null,
          );
          if (rich) {
            expect(row.details.merchant.address, variant).toBeNull();
            expect(row.details.merchant.phone, variant).toBeNull();
            expect(row.details.provider.isracard!.detail).toBeUndefined();
            expect(
              row.details.sourceRefs.map((ref) => ref.path),
            ).not.toContainEqual(
              expect.stringContaining("$.responses.details"),
            );
            expect(row.details.issues).toContain("invalid_transaction_detail");
          }
        }
      }
    },
  );

  it("projects established time, channel and location from rich observed field shapes while retaining discount and source-code evidence", () => {
    const capture = baseline("card-month-rich");
    const result = extract(capture);
    expect(
      result.transactions.filter((row) => row.status === "posted"),
    ).toHaveLength(7);
    expect(
      result.transactions.filter((row) => row.status === "pending"),
    ).toHaveLength(2);
    expect(
      result.partitions.find((partition) => partition.status === "posted"),
    ).toMatchObject({ success: true });
    expect(result.warnings).toContain(
      "legacy_statement_artifacts_preserved_raw",
    );
    const discount = result.transactions.find(
      (row) => row.merchantName === "Synthetic discount shop",
    )!;
    expect(discount).toMatchObject({
      amountMinor: -11000,
      currency: "ILS",
      // originalAmount 120 = billingAmount 110 + discountAmount 10.
      amountBasis: "purchase_commitment",
      kind: "purchase",
      originalAmountMinor: -12000,
      originalCurrency: "ILS",
      details: {
        transactionDateTime: "2040-06-15T09:17:23",
        merchant: {
          city: "Invented City",
          // The source supplies alpha-2 "IL"; only alpha-3 is a country code.
          countryCode: null,
          address: "42 Imaginary Street",
          phone: "SYNTHETIC-PHONE",
        },
      },
      // Phone order (T) is not an evidenced method; an unknown wallet label is not a wallet.
      authorizationMethod: null,
      threeDSecureUsed: null,
      wallet: null,
      recurring: null,
      providerTransactionCode: "1",
    });
    expect(discount.cardPresent).toBeNull();
    expect(discount.details.provider.isracard!.rows).toContainEqual(
      expect.objectContaining({
        discountAmount: "10",
        discountIndication: true,
        discountClubName: null,
        clearedCode: "1  ",
        tranzacCodeType: "T",
        isTransactionSecure: true,
        isWalletTransaction: false,
        originalAmount: "120",
        billingAmount: "110",
        usdAmount: "31.43",
        ilsAmount: "110",
      }),
    );
    expect(discount.details.provider.isracard!.detail).toMatchObject({
      purchaseTime: "09:17",
      commissionNetValue: null,
      commissionNetValueCurrency: null,
      exchangeRateZMD: null,
      dollarTransferRate: null,
      conversionDateZMD: null,
      discount: "10.00",
      sumBeforeDiscount: "120.00",
      motavName: "Synthetic unclassified party",
      dealCode: "SYNTHETIC-DEAL-CODE",
      linking: null,
      saleName: "Synthetic seasonal offer",
      supplierId: "SYNTHETIC-SUPPLIER",
      walletPayName: "Synthetic wallet label",
    });
    expect(discount.details.provider.isracard!.detail).not.toHaveProperty(
      "isError",
    );
    expect(discount.details.provider.isracard!.rows).toContainEqual(
      expect.objectContaining({
        kodMatbeaMekori: "SYNTHETIC-CURRENCY-CODE",
        purchaseDate: "15/06/2040",
      }),
    );
    const recurring = result.transactions.find(
      (row) => row.merchantName === "Synthetic recurring service",
    )!;
    expect(recurring.details.transactionDateTime).toBeNull();
    expect(recurring.details.merchant).toMatchObject({
      city: null,
      countryCode: null,
    });
    // DigitalV3 isdirectDebit evidences recurrence; legacy isHoraatKeva is unmapped here.
    expect(recurring).toMatchObject({
      recurring: true,
      providerTransactionCode: "10",
    });
    expect(recurring.details.provider.isracard!.rows).toContainEqual(
      expect.objectContaining({
        purchaseTime: null,
        cityDescription: null,
        countryDescription: null,
        isdirectDebit: true,
        isNewDirectDebit: null,
        moreInfo: "Synthetic recurring note",
      }),
    );
    // Kinds follow each DigitalV3 code and source sign; a negative row stays unknown.
    expect(
      Object.fromEntries(
        result.transactions.map((row) => [row.merchantName, row.kind]),
      ),
    ).toEqual({
      "Synthetic approval shop": "unknown",
      "Synthetic foreign authorization": "unknown",
      "Synthetic discount shop": "purchase",
      "Synthetic recurring service": "fee",
      "Synthetic overseas ILS bill": "fee",
      "Synthetic overseas USD bill": "purchase",
      "Synthetic final installment": "purchase",
      "Synthetic negative source amount": "unknown",
      "Synthetic informational standing order": "unknown",
    });
    for (const row of result.transactions) {
      expect(transactionInputSchema.safeParse(row).success).toBe(true);
      // A row is unverified exactly when its basis is unknown.
      expect(row.amountBasis === "unknown").toBe(
        row.details.issues.includes("unverified_amount_basis"),
      );
    }
  });

  it("keeps independent foreign source amounts, payment tables and null fee placeholders as evidence without deriving money or a repayment graph", () => {
    const result = extract(baseline("card-month-rich"));
    const ils = result.transactions.find(
      (row) => row.merchantName === "Synthetic overseas ILS bill",
    )!;
    const usd = result.transactions.find(
      (row) => row.merchantName === "Synthetic overseas USD bill",
    )!;
    // Cross-currency: the stated original money, no rate, and an unknown
    // basis for the billed side.
    expect(ils).toMatchObject({
      amountMinor: -8900,
      currency: "ILS",
      amountBasis: "unknown",
      originalAmountMinor: -2000,
      originalCurrency: "EUR",
    });
    expect(usd).toMatchObject({
      amountMinor: -1900,
      currency: "USD",
      amountBasis: "unknown",
      originalAmountMinor: -1800,
      originalCurrency: "EUR",
    });
    expect(usd.details.provider.isracard!.monetaryEvidence).toMatchObject({
      billingMinor: 1900,
      billingCurrency: "USD",
      originalMinor: 1800,
      originalCurrency: "EUR",
    });
    expect(usd.details.provider.isracard!.rows).toContainEqual(
      expect.objectContaining({
        originalAmount: "18",
        billingAmount: "19",
        ilsAmount: "73.05",
        usdAmount: "19",
        originalCurrency: "999",
      }),
    );
    const installment = result.transactions.find(
      (row) => row.merchantName === "Synthetic final installment",
    )!;
    // Only a code 3 payment with agreeing ordinals is a plan line; this code 7
    // row with an unrecognized text stays one unresolved row.
    expect(installment).toMatchObject({
      amountMinor: null,
      currency: null,
      amountBasis: "unknown",
      installmentCount: null,
      installmentNumber: null,
      billingDate: null,
    });
    expect(installment.details.provider.isracard!.rows).toContainEqual(
      expect.objectContaining({ numberOfInstallment: "3" }),
    );
    expect(
      installment.details.provider.isracard!.monetaryEvidence,
    ).toMatchObject({ billingMinor: 4000 });
    expect(installment.details.transactionDateTime).toBeNull();
    expect(installment.details.issues).toContain(
      "unverified_installment_amount_basis",
    );
    expect(installment.details.provider.isracard!.rows).toContainEqual(
      expect.objectContaining({ isLastInstallment: true }),
    );
    const detail = installment.details.provider.isracard!.detail;
    expect(detail).toMatchObject({
      numberOfPayments: "3",
      paymentNumber: "3",
      interestPercentage: null,
      moneyWithdrawalCommission: null,
      dollarTransferCommissionPercentage: null,
      Table1: [
        expect.objectContaining({
          paymentNumber: "1",
          paymentDate: "10/05/2040",
          paymentSum: "40.00",
          currencyId: "ILS",
        }),
        expect.objectContaining({
          paymentNumber: "2",
          paymentDate: "10/06/2040",
          paymentSum: "40.00",
        }),
        expect.objectContaining({
          paymentNumber: "3",
          paymentDate: "10/07/2040",
          paymentSum: "40.00",
        }),
        expect.objectContaining({
          paymentNumber: null,
          paymentSum: "120.00",
          currencyId: null,
        }),
      ],
    });
    const informative = result.transactions.find(
      (row) => row.merchantName === "Synthetic informational standing order",
    )!;
    expect(informative.amountMinor).toBeNull();
    expect(informative.details.issues).toContain(
      "unverified_legacy_source_role",
    );
    const negative = result.transactions.find(
      (row) => row.merchantName === "Synthetic negative source amount",
    )!;
    expect(negative).toMatchObject({
      amountMinor: 1500,
      kind: "unknown",
      amountBasis: "unknown",
    });
    expect(negative.details.provider.isracard!.rows).toContainEqual(
      expect.objectContaining({
        paymentSum: "-15.00",
        paymentSumSign: "-",
        paymentSumOutbound: null,
      }),
    );
  });

  it.each(["-", "SYNTHETIC-UNINTERPRETED-SIGN"])(
    "retains legacy sign %s without applying it again to already negative money",
    (paymentSumSign) => {
      const capture = baseline("card-month-rich");
      updateLegacy(capture, (rows) => {
        const negative = rows.find(
          (row) => row.supplierName === "Synthetic negative source amount",
        )!;
        negative.paymentSumSign = paymentSumSign;
      });
      const negative = extract(capture).transactions.find(
        (row) => row.merchantName === "Synthetic negative source amount",
      )!;
      expect(negative).toMatchObject({
        amountMinor: 1500,
        currency: "ILS",
        kind: "unknown",
        amountBasis: "unknown",
      });
      expect(negative.details.provider.isracard!.rows).toContainEqual(
        expect.objectContaining({
          paymentSum: "-15.00",
          paymentSumSign,
          paymentSumOutbound: null,
        }),
      );
    },
  );

  it.each([
    "12:30",
    "12:30:01",
    "12:30:01.1200",
    "00:30:01+03:00",
    "23:30:01-05:00",
    "12:30:01Z",
  ])(
    "pairs the same DigitalV3 purchase date and time %s without inventing a timezone",
    (time) => {
      const capture = baseline();
      updateDigital(capture, (rows) => {
        rows[0]!.purchaseTime = time;
      });
      const row = extract(capture).transactions[0]!;
      expect(row.transactionDate).toBe("2040-06-11");
      expect(row.details.transactionDateTime).toBe(`2040-06-11T${time}`);
      expect(transactionInputSchema.safeParse(row).success).toBe(true);
    },
  );

  it("leaves malformed or missing purchase time unknown and never borrows optional voucher detail or billing time", () => {
    for (const time of [
      undefined,
      null,
      "",
      "24:00:00",
      "12:60:00",
      "12:30:60",
      "12:30:00\n",
    ]) {
      const capture = baseline();
      updateDigital(capture, (rows) => {
        rows[0]!.purchaseTime = time;
      });
      const row = extract(capture).transactions[0]!;
      expect(row.details.transactionDateTime).toBeNull();
      expect(row.transactionDate).toBe("2040-06-11");
      expect(row.details.provider.isracard!.detail).toMatchObject({
        purchaseTime: "12:30:00",
      });
    }
  });

  it("does not promote ambiguous, invalid-date or installment source times into a purchase timestamp", () => {
    for (const change of [
      (rows: Row[]) => rows.push({ ...rows[0] }),
      (rows: Row[]) => {
        rows[0]!.purchaseDate = "30/02/2040";
      },
      (rows: Row[]) => {
        rows[0]!.numberOfInstallment = 3;
        rows[0]!.currentInstallmentNum = 2;
      },
    ]) {
      const capture = baseline();
      updateDigital(capture, change);
      expect(
        extract(capture).transactions.every(
          (row) => row.details.transactionDateTime === null,
        ),
      ).toBe(true);
    }
  });

  it("updates source purchase time without moving annotations and keeps historical time from replacing current time", async () => {
    const db = await openDatabase(":memory:");
    try {
      await db.ensureConnection({
        id: "synthetic-isracard",
        provider: "isracard",
      });
      const capture = baseline();
      await ingestCapture(db, capture, 0);
      const original = (await db.listTransactions()).find(
        (row) => row.merchantName === "Synthetic merchant",
      )!;
      expect(original.details.transactionDateTime).toBe("2040-06-11T12:30:00");
      await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Synthetic time correction note",
      });
      updateDigital(capture, (rows) => {
        rows[0]!.purchaseTime = "13:45:00";
      });
      await ingestCapture(db, capture, 1);
      const updated = await db.getTransaction(original.id);
      expect(updated?.details.transactionDateTime).toBe("2040-06-11T13:45:00");
      expect(updated?.annotation?.data.notes).toBe(
        "Synthetic time correction note",
      );
      expect(updated?.version).toBe(original.version + 1);
      expect(
        (await db.listEvents()).find(
          (event) =>
            event.type === "transaction.updated" &&
            event.transactionId === original.id,
        ),
      ).toMatchObject({
        before: { transactionDateTime: "2040-06-11T12:30:00" },
        after: {
          transactionDateTime: "2040-06-11T13:45:00",
          providerEvidence: expect.any(Array),
        },
      });

      capture.mode = "history";
      updateDigital(capture, (rows) => {
        rows[0]!.purchaseTime = "09:00:00";
      });
      await ingestCapture(db, capture, 2);
      expect(
        (await db.getTransaction(original.id))?.details.transactionDateTime,
      ).toBe("2040-06-11T13:45:00");
      expect(
        (await db.getTransaction(original.id))?.annotation?.data.notes,
      ).toBe("Synthetic time correction note");
      expect(await db.listTransactions()).toHaveLength(2);

      capture.mode = "recent";
      updateDigital(capture, (rows) => {
        delete rows[0]!.purchaseTime;
      });
      await ingestCapture(db, capture, 3);
      expect(
        (await db.getTransaction(original.id))?.details.transactionDateTime ??
          null,
      ).toBeNull();
      expect(
        (await db.getTransaction(original.id))?.annotation?.data.notes,
      ).toBe("Synthetic time correction note");
    } finally {
      await db.close();
    }
  });

  it("prefers DigitalV3, joins unique voucher evidence, fills legacy gaps and retains detail enrichment", () => {
    const result = extract();
    expect(result.transactions).toHaveLength(2);
    const joined = result.transactions[0]!;
    expect(joined).toMatchObject({
      sourceScope: isracardCardKey(baseline().card),
      cardKey: isracardCardKey(baseline().card),
      identityStrength: "native",
      merchantName: "Synthetic merchant",
      counterpartyName: null,
      transactionDate: "2040-06-11",
      billingDate: "2040-07-10",
      amountMinor: -8640,
      currency: "ILS",
      kind: "purchase",
      amountBasis: "purchase_commitment",
      originalAmountMinor: -8640,
      originalCurrency: "ILS",
    });
    expect(joined.details.sourceRefs).toHaveLength(3);
    // Only the unverified legacy-only row keeps the blanket review signal.
    expect(
      result.transactions.map((row) =>
        row.details.issues.includes("isracard_unverified_semantics"),
      ),
    ).toEqual([false, true]);
    expect(joined.details.merchant).toMatchObject({
      address: "1 Synthetic Street",
      phone: "SYNTHETIC-PHONE",
      city: "Synthetic City",
      countryCode: null,
    });
    expect(joined.cardPresent ?? null).toBeNull();
    expect(joined.wallet).toBeNull();
    expect(joined.details.provider.isracard!.observations).toHaveLength(2);
    expect(result.transactions[1]).toMatchObject({
      merchantName: "Synthetic standing order",
      billingDate: null,
      amountMinor: -1250,
    });
    expect(result.partitions).toEqual([
      {
        accountKey: joined.sourceScope,
        status: "posted",
        success: true,
        comparable: false,
      },
    ]);
    for (const row of result.transactions) {
      expect(transactionInputSchema.safeParse(row).success).toBe(true);
    }
  });

  it("archives source bodies verbatim and extracts exact decimal lexemes and large vouchers", () => {
    const capture = baseline();
    delete capture.responses.legacy;
    capture.responses.digital = capture.responses
      .digital!.replace('"billingAmount": 86.4', '"billingAmount": 0.2900')
      .replace(
        '"seqVoucherNumber": "VOUCHER-1"',
        '"seqVoucherNumber": 9007199254740993123',
      );
    const serialized = serializeIsracardCapture(capture);
    expect((JSON.parse(serialized) as IsracardCapture).responses.digital).toBe(
      capture.responses.digital,
    );
    const row = extract(capture).transactions[0]!;
    expect(row.sourceKey).toContain("9007199254740993123");
    expect(row.amountMinor).toBe(-29);
    expect(row.details.provider.isracard!.rows).toMatchObject([
      {
        billingAmount: "0.2900",
        seqVoucherNumber: "9007199254740993123",
      },
    ]);
  });

  it.each([
    [0, null],
    ["000", null],
    [7000003, "7000003"],
  ])(
    "publishes no merchant number for the all-zero foreign sentinel %j",
    (businessNumber, expected) => {
      const capture = baseline();
      updateDigital(capture, (rows) => {
        Object.assign(rows[0]!, { businessNumber, isIsraelDeal: false });
      });
      const row = extract(capture).transactions[0]!;
      expect(row.merchantProviderId).toBe(expected);
      expect(row.details.provider.isracard!.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ businessNumber: String(businessNumber) }),
        ]),
      );
    },
  );

  it.each([
    ["+99 999 9999999", null],
    ["999-9999999", null],
    ["+9 (999) 999-9999", null],
    ["999.999.9999", null],
    ["Synthetic City", "Synthetic City"],
  ])("keeps only a city name in the merchant city: %j", (city, expected) => {
    const capture = baseline();
    updateDigital(capture, (rows) => {
      rows[0]!.cityDescription = city;
    });
    expect(extract(capture).transactions[0]!.details.merchant.city).toBe(
      expected,
    );
  });

  it.each([
    [null, "2040-07-10"],
    ["10/07/2040", "2040-07-10"],
    ["11/07/2040", null],
  ])(
    "uses a bound detail's charge date as a billing date: legacy=%s",
    (legacyDate, expected) => {
      const capture = baseline();
      updateLegacy(capture, (rows) => {
        rows[0]!.fullPaymentDate = legacyDate;
      });
      const entry = capture.responses.details![0]!;
      entry.responseText = JSON.stringify({
        Header: { Status: "1" },
        PirteyIska_204Bean: {
          voucherNumberRatz: entry.voucherNumber,
          moedChiuvFull: "10/07/2040",
          clearingData: "לא הוצג",
          solek: "I  ",
        },
      });
      const row = extract(capture).transactions.find((item) =>
        item.sourceKey.includes("VOUCHER-1"),
      )!;
      expect(row.billingDate).toBe(expected);
      expect(row.details.issues.includes("conflicting_billing_date")).toBe(
        expected === null,
      );
      expect(row.details.provider.isracard!.detail).toMatchObject({
        moedChiuvFull: "10/07/2040",
        clearingData: "לא הוצג",
        solek: "I  ",
      });
    },
  );

  it.each([
    ["10/07/2040", "11/07/2040", null],
    ["11/07/2040", "10/07/2040", null],
    ["10/07/2040", "10/07/2040", "2040-07-10"],
    ["10/07/2040", null, "2040-07-10"],
    [null, "10/07/2040", "2040-07-10"],
    [null, null, null],
  ])(
    "projects joined billing dates by agreement rather than observation precedence: digital=%s legacy=%s",
    (digitalDate, legacyDate, expected) => {
      const capture = baseline();
      updateDigital(capture, (rows, data) => {
        const [row] = rows.splice(0, 1);
        const vouchers = data.israelAbroadVouchers as Row;
        vouchers.outOfStatementChargeDateVouchers = [
          {
            totalVouchersCurrencyDate: { dateImmediateVouchers: digitalDate },
            immediateVouchersCurrencyDate: [row],
          },
        ];
      });
      updateLegacy(capture, (rows) => {
        rows[0]!.fullPaymentDate = legacyDate;
      });
      const row = extract(capture).transactions.find((item) =>
        item.sourceKey.includes("VOUCHER-1"),
      )!;
      expect(row.billingDate).toBe(expected);
      expect(row.details.sourceRefs).toHaveLength(3);
      expect(row.details.provider.isracard!.rows).toEqual([
        expect.objectContaining({ seqVoucherNumber: "VOUCHER-1" }),
        expect.objectContaining({ fullPaymentDate: legacyDate }),
      ]);
    },
  );

  it("uses the observed USD currency code without assuming every bill is ILS", () => {
    const capture = baseline();
    delete capture.responses.legacy;
    updateDigital(capture, (rows) =>
      Object.assign(rows[0]!, {
        billingAmountCurrency: 19,
        billingAmount: -4.25,
      }),
    );
    expect(extract(capture).transactions[0]).toMatchObject({
      amountMinor: 425,
      currency: "USD",
      kind: "unknown",
    });
  });

  it("leaves unknown currencies and unsupported money precision unresolved", () => {
    for (const patch of [
      { billingAmountCurrency: 999 },
      { billingAmount: 0.001 },
      { billingAmount: 90071992547410 },
    ]) {
      const capture = baseline();
      delete capture.responses.legacy;
      updateDigital(capture, (rows) => Object.assign(rows[0]!, patch));
      expect(extract(capture).transactions[0]).toMatchObject({
        amountMinor: null,
        currency: null,
      });
    }
  });

  it.each([
    ["U", "online", null],
    ["V", "online", true],
    ["R", null, null],
    ["T", null, null],
    ["H", null, null],
    [null, null, null],
  ])(
    "maps DigitalV3 tranzacCodeType %j to %j / 3-D Secure %j",
    (tranzacCodeType, authorizationMethod, threeDSecureUsed) => {
      const capture = baseline();
      updateDigital(capture, (rows) =>
        Object.assign(rows[0]!, {
          tranzacCodeType,
          isTransactionSecure: true,
          isWalletTransaction: true,
        }),
      );
      const row = extract(capture).transactions[0]!;
      expect(row).toMatchObject({ authorizationMethod, threeDSecureUsed });
      // Security and wallet flags alone stay raw evidence.
      expect(row.wallet).toBeNull();
    },
  );

  it.each([
    [{ isdirectDebit: true }, {}, true],
    [{ isdirectDebit: false }, {}, null],
    [{}, { isHoraatKeva: true }, true],
    [{}, { isHoraatKeva: "true" }, true],
    [{}, { isHoraatKeva: "false" }, null],
    [{}, { isHoraatKeva: "synthetic-unmapped" }, null],
  ])(
    "maps direct-debit evidence digital %j / legacy %j to recurring %j",
    (digital, legacy, recurring) => {
      const capture = baseline();
      updateDigital(capture, (rows) =>
        Object.assign(rows[0]!, { isdirectDebit: false, ...digital }),
      );
      updateLegacy(capture, (rows) =>
        Object.assign(rows[0]!, { isHoraatKeva: null, ...legacy }),
      );
      expect(extract(capture).transactions[0]!.recurring).toBe(recurring);
    },
  );

  it("leaves conflicting explicit wallet names null with a source issue", () => {
    const capture = baseline();
    const entry = capture.responses.details![0]!;
    entry.responseText = JSON.stringify({
      Header: { Status: "1" },
      PirteyIska_204Bean: {
        voucherNumberRatz: entry.voucherNumber,
        walletPayName: "Google Pay",
        transactionType: "APPLE PAY",
      },
    });
    const row = extract(capture).transactions[0]!;
    expect(row.wallet).toBeNull();
    expect(row.details.issues).toContain("conflicting_payment_context");
  });

  it("keeps same-row DigitalV3 moreInfo as additional information and supplies no MCC", () => {
    const capture = baseline();
    updateDigital(capture, (rows) => {
      rows[0]!.moreInfo = "Synthetic DigitalV3 note";
    });
    updateLegacy(capture, (rows) => {
      rows[0]!.moreInfo = "Synthetic legacy note";
    });
    const row = extract(capture).transactions[0]!;
    expect(row.details.additionalInformation).toEqual([
      "Synthetic DigitalV3 note",
    ]);
    expect(row.merchantCategoryCode ?? null).toBeNull();
  });

  it("keeps only a valid ISO 3166-1 alpha-3 merchant country code", () => {
    for (const [countryCode, expected] of [
      ["FRA", "FRA"],
      ["FR", null],
      ["XXX", null],
      ["fra", null],
      ["250", null],
    ] as const) {
      const capture = baseline();
      updateDigital(capture, (rows) =>
        Object.assign(rows[0]!, { countryCode }),
      );
      expect(
        extract(capture).transactions[0]!.details.merchant.countryCode,
      ).toBe(expected);
    }
  });

  it.each([
    [1, "purchase"],
    [3, "purchase"],
    [7, "purchase"],
    [8, "cash_withdrawal"],
    [10, "fee"],
    [12, "fee"],
    [20, "transfer"],
    [23, "transfer"],
    ["8", "cash_withdrawal"],
    ["12", "fee"],
  ] as const)(
    "maps DigitalV3 transactionCode %j with positive same-currency billing to %j as a purchase commitment",
    (code, kind) => {
      const capture = baseline();
      updateDigital(capture, (rows) =>
        Object.assign(rows[0]!, { transactionCode: code, presentCard: true }),
      );
      const row = extract(capture).transactions[0]!;
      // Code 3 bills installment payments: outside a proven plan its role
      // stays unknown.
      const verified = String(code) !== "3";
      expect(row).toMatchObject({
        kind,
        amountMinor: -8640,
        currency: "ILS",
        amountBasis: verified ? "purchase_commitment" : "unknown",
        // originalAmount 86.4 equals the bill with no discount.
        originalAmountMinor: -8640,
        originalCurrency: "ILS",
        // The issuer code stays opaque, as supplied.
        providerTransactionCode: String(code),
      });
      // A presented physical card is source-stated card presence.
      expect(row.cardPresent).toBe(true);
      expect(row.details.issues).not.toContain("unsupported_transaction_type");
      expect(row.details.issues).toContain("source_derived_amount_direction");
      for (const issue of [
        "isracard_unverified_semantics",
        "unverified_amount_basis",
      ]) {
        expect(row.details.issues.includes(issue)).toBe(!verified);
      }
      // A verified charge counts like a CAL posted charge; transfers are
      // excluded by kind first.
      expect(
        calculateTotals([
          {
            ...row,
            supersededById: null,
            presence: "seen",
            fxFeeMinor: null,
            fxFeeCurrency: null,
          },
        ]),
      ).toMatchObject(
        kind === "transfer"
          ? { totals: [], excluded: { transferOrIncome: 1 } }
          : verified
            ? {
                totals: [
                  {
                    currency: "ILS",
                    amountBasis: "purchase_commitment",
                    amountMinor: -8640,
                  },
                ],
                includedCount: 1,
              }
            : { totals: [], excluded: { unresolved: 1 } },
      );
    },
  );

  it("maps card fees at any sign but keeps negative, zero or unreadable outflow-code rows unknown", () => {
    for (const code of [1, 3, 7, 8, 10, 12, 20, 23]) {
      for (const billingAmount of [-86.4, "-86.40", 0, "0.00", "-0", null]) {
        const capture = baseline();
        updateDigital(capture, (rows) =>
          Object.assign(rows[0]!, { transactionCode: code, billingAmount }),
        );
        const row = extract(capture).transactions[0]!;
        const fee = code === 10 || code === 12;
        expect(row.kind, `${code} ${billingAmount}`).toBe(
          fee ? "fee" : "unknown",
        );
        expect(row.amountBasis).toBe("unknown");
        if (!fee) {
          // No refund without a source refund marker.
          expect(row.details.issues).toContain("unsupported_transaction_type");
        }
      }
    }
    for (const billingAmount of ["abc", "1e", "+86.4", true]) {
      const capture = baseline();
      updateDigital(capture, (rows) =>
        Object.assign(rows[0]!, { transactionCode: 1, billingAmount }),
      );
      expect(extract(capture).transactions[0]!.kind).toBe("unknown");
    }
  });

  it("maps positive code 1 Bit transfers by their exact provider label and keeps other code 1 rows purchases", () => {
    for (const [code, businessName, billingAmount, kind] of [
      [1, "העברה בBIT", 86.4, "transfer"],
      [1, "  העברה בBIT\t", 86.4, "transfer"],
      ["1", "העברה בBIT", "86.40", "transfer"],
      [1, 'העברה ב BIT בנה"פ', 86.4, "transfer"],
      [1, ' העברה ב BIT בנה"פ ', 86.4, "transfer"],
      [1, "העברה בBIT", -86.4, "unknown"],
      [1, "העברה בBIT", 0, "unknown"],
      [1, "העברה ב BIT", 86.4, "purchase"],
      [1, "העברה בbit", 86.4, "purchase"],
      [1, "Synthetic merchant העברה בBIT", 86.4, "purchase"],
      [1, null, 86.4, "purchase"],
      [3, "העברה בBIT", 86.4, "purchase"],
      [7, "העברה בBIT", 86.4, "purchase"],
      [8, "העברה בBIT", 86.4, "cash_withdrawal"],
      [12, "העברה בBIT", -86.4, "fee"],
      [999, "העברה בBIT", 86.4, "unknown"],
    ] as const) {
      const capture = baseline();
      updateDigital(capture, (rows) =>
        Object.assign(rows[0]!, {
          transactionCode: code,
          businessName,
          billingAmount,
        }),
      );
      const row = extract(capture).transactions[0]!;
      expect(row.kind, `${code} ${businessName} ${billingAmount}`).toBe(kind);
      // Only a bill that reconciles with originalAmount 86.4 states its role.
      expect(row.amountBasis).toBe(
        kind !== "unknown" && code !== 3 && Number(billingAmount) === 86.4
          ? "purchase_commitment"
          : "unknown",
      );
    }
    // A legacy companion's name never makes a transfer.
    const capture = baseline();
    updateLegacy(capture, (rows) => {
      rows[0]!.fullSupplierNameHeb = "העברה בBIT";
    });
    expect(extract(capture).transactions[0]!.kind).toBe("purchase");
  });

  it("keeps a code 8 cash withdrawal's fee-inclusive DigitalV3 bill and its fee-exclusive legacy line as a conflict without deriving either", () => {
    const capture = baseline();
    // DigitalV3 bills the withdrawal with its 2% fee; legacy lists the withdrawal alone.
    updateDigital(capture, (rows) =>
      Object.assign(rows[0]!, { transactionCode: 8, billingAmount: 102 }),
    );
    updateLegacy(capture, (rows) => {
      rows[0]!.paymentSum = 100;
    });
    const row = extract(capture).transactions[0]!;
    expect(row).toMatchObject({
      kind: "cash_withdrawal",
      amountMinor: null,
      currency: null,
      amountBasis: "unknown",
    });
    expect(row.details.issues).toContain(
      "conflicting_generation_billing_amount",
    );
    expect(row.details.provider.isracard!.monetaryEvidence).toMatchObject({
      billingMinor: 10200,
    });
  });

  it("names a transfer's counterparty only from its bound detail's nonempty motavName", () => {
    const party = "Synthetic Transfer Party";
    const cases = [
      { code: 20, name: party, bound: true, expected: party },
      { code: 23, name: `  ${party}\n`, bound: true, expected: party },
      { code: 1, bit: true, name: party, bound: true, expected: party },
      { code: 20, name: party, bound: false, expected: undefined },
      { code: 20, name: " \t ", bound: true, expected: null },
      { code: 20, name: "", bound: true, expected: null },
      { code: 20, name: null, bound: true, expected: null },
      { code: 20, name: 42, bound: true, expected: null },
      // Not a transfer: a purchase, a negative P2P row and a fee keep no counterparty.
      { code: 1, name: party, bound: true, expected: null },
      { code: 20, amount: -86.4, name: party, bound: true, expected: null },
      { code: 10, name: party, bound: true, expected: null },
    ];
    for (const item of cases) {
      const capture = baseline();
      updateDigital(capture, (rows) =>
        Object.assign(rows[0]!, {
          transactionCode: item.code,
          billingAmount: item.amount ?? 86.4,
          ...(item.bit ? { businessName: "העברה בBIT" } : {}),
        }),
      );
      const entry = capture.responses.details![0]!;
      entry.responseText = JSON.stringify({
        Header: { Status: "1" },
        PirteyIska_204Bean: {
          voucherNumberRatz: item.bound
            ? entry.voucherNumber
            : "OTHER-SYNTHETIC-VOUCHER",
          motavName: item.name,
        },
      });
      const row = extract(capture).transactions[0]!;
      expect(row.counterpartyName, JSON.stringify(item)).toBe(item.expected);
    }
    // No optional lookup supplies no observation, rather than an explicit clear.
    const capture = baseline();
    delete capture.responses.details;
    updateDigital(capture, (rows) =>
      Object.assign(rows[0]!, { transactionCode: 20 }),
    );
    expect(extractRaw(capture).transactions[0]).toMatchObject({
      kind: "transfer",
      counterpartyName: undefined,
    });
  });

  it("does not treat absent or unbound optional details as an observed transfer counterparty clear", () => {
    for (const variant of [
      "empty",
      "unrelated-request",
      "malformed",
      "failed",
      "wrong-voucher",
      "duplicate",
    ] as const) {
      const capture = baseline();
      updateDigital(capture, (rows) =>
        Object.assign(rows[0]!, { transactionCode: 20 }),
      );
      const entry = capture.responses.details![0]!;
      entry.responseText = JSON.stringify({
        Header: { Status: "1" },
        PirteyIska_204Bean: {
          voucherNumberRatz: entry.voucherNumber,
          motavName: "Synthetic party",
        },
      });
      if (variant === "empty") {
        capture.responses.details = [];
      }
      if (variant === "unrelated-request") {
        entry.voucherNumber = "UNRELATED-REQUEST";
      }
      if (variant === "malformed") {
        entry.responseText = "{";
      }
      if (variant === "failed") {
        entry.responseText = '{"Header":{"Status":"2"}}';
      }
      if (variant === "wrong-voucher") {
        entry.responseText = JSON.stringify({
          Header: { Status: "1" },
          PirteyIska_204Bean: {
            voucherNumberRatz: "UNRELATED-RESPONSE",
            motavName: "Synthetic party",
          },
        });
      }
      if (variant === "duplicate") {
        capture.responses.details!.push({ ...entry });
      }
      const row = extractRaw(capture).transactions.find(
        (row) => row.kind === "transfer",
      )!;
      expect(row.counterpartyName, variant).toBeUndefined();
      if (["malformed", "failed", "wrong-voucher"].includes(variant)) {
        expect(row.details.issues).toContain("invalid_transaction_detail");
      }
      if (variant === "duplicate") {
        expect(row.details.issues).toContain("ambiguous_transaction_detail");
      }
    }
  });

  it("leaves unmapped, padded and malformed transaction codes unknown", () => {
    for (const code of [
      2,
      5,
      9,
      11,
      999,
      "01",
      " 1",
      "10 ",
      "1.0",
      null,
      "__proto__",
      true,
    ]) {
      const capture = baseline();
      updateDigital(capture, (rows) =>
        Object.assign(rows[0]!, { transactionCode: code, presentCard: true }),
      );
      const row = extract(capture).transactions[0]!;
      expect(row.kind, String(code)).toBe("unknown");
      expect(row.details.issues).toContain("unsupported_transaction_type");
      expect(row.cardPresent).toBe(true);
    }
  });

  it("leaves legacy-only rows unknown even when a legacy row carries a mapped code", () => {
    const capture = baseline();
    updateLegacy(capture, (rows) => {
      for (const row of rows) {
        row.transactionCode = 10;
      }
    });
    const legacyOnly = extract(capture).transactions.find(
      (row) => row.merchantName === "Synthetic standing order",
    )!;
    expect(legacyOnly.kind).toBe("unknown");
    expect(legacyOnly.details.issues).toContain("unsupported_transaction_type");
    delete capture.responses.digital;
    const result = extract(capture);
    expect(result.transactions.length).toBeGreaterThan(0);
    for (const row of result.transactions) {
      expect(row.kind).toBe("unknown");
    }
  });

  it("keeps code 3 installment money and installment fields null while mapping its kind", () => {
    const capture = baseline();
    updateDigital(capture, (rows) =>
      Object.assign(rows[0]!, {
        transactionCode: 3,
        numberOfInstallment: 3,
        currentInstallmentNum: 2,
      }),
    );
    const row = extract(capture).transactions[0]!;
    expect(row).toMatchObject({
      kind: "purchase",
      amountMinor: null,
      currency: null,
      amountBasis: "unknown",
      installmentCount: null,
      installmentNumber: null,
      billingDate: null,
    });
    expect(row.details.issues).toContain("unverified_installment_amount_basis");
  });

  it("preserves all duplicate voucher occurrences without arbitrary cross-generation joins", () => {
    const capture = baseline();
    updateDigital(capture, (rows) =>
      rows.push({ ...rows[0]!, billingAmount: 100 }),
    );
    const result = extract(capture);
    expect(result.transactions).toHaveLength(4);
    const duplicates = result.transactions.filter((row) =>
      row.sourceKey.includes("VOUCHER-1"),
    );
    expect(duplicates).toHaveLength(3);
    expect(new Set(duplicates.map((row) => row.sourceKey)).size).toBe(3);
    expect(
      duplicates.every(
        (row) =>
          row.identityStrength === "ambiguous" && row.details.issues.length > 0,
      ),
    ).toBe(true);
    expect(
      duplicates.every((row) => row.details.merchant.address === null),
    ).toBe(true);
  });

  it("keeps differing purchase dates separate and never joins on display voucherNumber", () => {
    const capture = baseline();
    updateDigital(capture, (rows) =>
      Object.assign(rows[0]!, {
        purchaseDate: "13/06/2040",
        voucherNumber: "VOUCHER-1",
      }),
    );
    const result = extract(capture);
    expect(result.transactions).toHaveLength(3);
    expect(
      result.transactions
        .filter((row) => row.sourceKey.includes("VOUCHER-1"))
        .every((row) => row.identityStrength === "ambiguous"),
    ).toBe(true);
    updateDigital(capture, (rows) =>
      Object.assign(rows[0]!, {
        seqVoucherNumber: "UNRELATED-VOUCHER",
        purchaseDate: "11/06/2040",
      }),
    );
    expect(extract(capture).transactions).toHaveLength(3);
  });

  it("keeps known legacy statement summaries raw-only without creating canonical financial transactions", () => {
    const capture = baseline();
    updateLegacy(capture, (rows) => {
      rows.push({
        ...rows[0]!,
        voucherNumberRatz: "000000000",
        paymentSum: 999999,
      });
      rows.push({
        ...rows[0]!,
        voucherNumberRatz: "ARTIFACT-VOUCHER",
        dealSumType: "1",
        paymentSum: 999999,
      });
    });
    const result = extract(capture);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions.map((row) => row.amountMinor)).toEqual([
      -8640, -1250,
    ]);
    expect(result.warnings).toContain(
      "legacy_statement_artifacts_preserved_raw",
    );
    expect(capture.responses.legacy).toContain("ARTIFACT-VOUCHER");
  });

  it.each(["txnAbroad", "txnInfo"])(
    "does not extend domestic T-total classification to %s",
    (partition) => {
      const capture = baseline();
      updateDigital(capture, (rows) => {
        rows.length = 0;
      });
      updateLegacy(capture, (rows, data) => {
        rows.length = 0;
        const entry = data.Index0 as { CurrentCardTransactions: Row[] };
        entry.CurrentCardTransactions[0]![partition] = [
          {
            dealSumType: "T",
            voucherNumberRatz: "SYNTHETIC-NONDOMESTIC-T",
            voucherNumberRatzOutbound: "SYNTHETIC-NONDOMESTIC-T",
            fullPurchaseDate: "11/06/2040",
            fullPurchaseDateOutbound: "11/06/2040",
            paymentSum: "7.25",
            paymentSumOutbound: "7.25",
            currencyId: "USD",
          },
        ];
      });
      const result = extract(capture);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]!.sourceKey).toContain(
        "SYNTHETIC-NONDOMESTIC-T",
      );
      expect(result.transactions[0]!.details.sourceRefs).toContainEqual({
        runId: "synthetic-isracard-run",
        path: `$.responses.legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0].${partition}[0]`,
      });
      expect(result.warnings).not.toContain(
        "legacy_statement_artifacts_preserved_raw",
      );
    },
  );

  it("keeps a colliding domestic USD total from blocking a purchase correction or moving its annotation", async () => {
    const capture = baseline();
    delete capture.responses.details;
    updateDigital(capture, (rows) => {
      Object.assign(rows[0]!, {
        billingAmount: 7.25,
        billingAmountCurrency: 19,
        originalAmount: 7.25,
        originalCurrencyIso: "USD",
      });
    });
    updateLegacy(capture, (rows) => {
      rows.splice(
        0,
        rows.length,
        {
          fullPurchaseDate: "11/06/2040",
          voucherNumberRatz: "VOUCHER-1",
          fullSupplierNameHeb: "Synthetic purchase",
          paymentSum: "7.25",
          currencyId: "USD",
        },
        {
          fullPurchaseDate: "12/06/2040",
          voucherNumberRatz: "SYNTHETIC-USD-2",
          fullSupplierNameHeb: "Synthetic second purchase",
          paymentSum: "7.25",
          currencyId: "USD",
        },
        {
          fullPurchaseDate: "11/06/2040",
          voucherNumberRatz: "000000000",
          dealSumType: "T",
          paymentSum: "14.50",
          currencyId: "USD",
        },
      );
    });
    const db = await openDatabase(":memory:");
    try {
      await db.ensureConnection({
        id: "synthetic-isracard",
        provider: "isracard",
      });
      await ingestCapture(db, capture, 0);
      const before = (await db.listTransactions()).find(
        (row) => row.transactionDate === "2040-06-11",
      )!;
      expect(before).toMatchObject({
        amountMinor: -725,
        currency: "USD",
        amountBasis: "purchase_commitment",
        identityStrength: "native",
      });
      await db.editAnnotation({
        transactionId: before.id,
        expectedVersion: 0,
        notes: "Synthetic purchase note",
      });
      updateDigital(capture, (rows) => {
        Object.assign(rows[0]!, { billingAmount: 8.25, originalAmount: 8.25 });
      });
      updateLegacy(capture, (rows) => {
        rows[0]!.paymentSum = "8.25";
        Object.assign(rows[2]!, {
          voucherNumberRatz: "VOUCHER-1",
          paymentSum: "15.50",
        });
      });
      const parsed = extract(capture);
      expect(parsed.transactions).toHaveLength(2);
      expect(parsed.warnings).not.toContain("legacy_total_mismatch");
      expect(parsed.warnings).not.toContain("ambiguous_posted_identity");
      expect(await ingestCapture(db, capture, 1)).toMatchObject({
        created: 0,
        updated: 1,
      });
      const after = await db.getTransaction(before.id);
      expect(after).toMatchObject({
        id: before.id,
        amountMinor: -825,
        currency: "USD",
        amountBasis: "purchase_commitment",
        identityStrength: "native",
        version: before.version + 1,
        annotation: { data: { notes: "Synthetic purchase note" } },
      });
      expect(await db.listTransactions()).toHaveLength(2);
      expect(await db.getTotals()).toMatchObject({
        totals: [{ currency: "USD", amountMinor: -825 }],
      });
      const runs = await db.orm.select().from(syncRunBodies).all();
      const archived = JSON.parse(
        runs.find((run) => run.runId === "synthetic-review-1")!.snapshot
          .responses[0]!.responseText,
      ) as IsracardCapture;
      expect(archived.responses.legacy).toBe(capture.responses.legacy);
    } finally {
      await db.close();
    }
  });

  it("does not promote monthly installment billing into a purchase commitment or a billed line", () => {
    const capture = baseline();
    delete capture.responses.legacy;
    updateDigital(capture, (rows) =>
      Object.assign(rows[0]!, {
        currentInstallmentNum: 2,
        numberOfInstallment: 12,
        billingAmount: 10,
        originalAmount: 120,
      }),
    );
    const first = extract(capture).transactions[0]!;
    expect(first).toMatchObject({
      amountMinor: null,
      currency: null,
      amountBasis: "unknown",
      // A count without lines would read as a plan purchase (billing perspective).
      installmentCount: null,
      installmentNumber: null,
    });
    expect(first.details.issues).toContain(
      "unverified_installment_amount_basis",
    );
    expect(first.details.provider.isracard!.monetaryEvidence).toMatchObject({
      billingMinor: 1000,
      originalMinor: 12000,
    });
  });

  it("respects legacy installment evidence even if the preferred DigitalV3 row omits its installment fields", () => {
    const capture = baseline();
    updateLegacy(capture, (rows) => {
      rows[0]!.moreInfo = "תשלום 2 מתוך 12";
    });
    const row = extract(capture).transactions[0]!;
    // The legacy text agrees, but only a code 3 DigitalV3 row is a plan payment.
    expect(row).toMatchObject({
      amountMinor: null,
      currency: null,
      installmentCount: null,
      installmentNumber: null,
    });
    expect(row.details.issues).toContain("unverified_installment_amount_basis");
  });

  it.each([
    { currentInstallmentNum: 13, numberOfInstallment: 12 },
    { currentInstallmentNum: 2, numberOfInstallment: 1 },
    { currentInstallmentNum: 2, numberOfInstallment: null },
  ])(
    "keeps missing or conflicting purchase installment counts unknown: %j",
    (fields) => {
      const capture = baseline();
      delete capture.responses.legacy;
      updateDigital(capture, (rows) => Object.assign(rows[0]!, fields));
      const row = extract(capture).transactions[0]!;
      expect(row).toMatchObject({
        installmentCount: null,
        installmentNumber: null,
        amountBasis: "unknown",
      });
      expect(row.details.provider.isracard!.rows).toContainEqual(
        expect.objectContaining({
          currentInstallmentNum:
            fields.currentInstallmentNum === null
              ? null
              : String(fields.currentInstallmentNum),
        }),
      );
    },
  );

  it("nulls conflicting joined billing money while retaining both observations", () => {
    const capture = baseline();
    updateLegacy(capture, (rows) =>
      Object.assign(rows[0]!, { paymentSum: 100 }),
    );
    const row = extract(capture).transactions[0]!;
    expect(row).toMatchObject({ amountMinor: null, currency: null });
    expect(row.details.issues).toContain(
      "conflicting_generation_billing_amount",
    );
    expect(row.details.provider.isracard!.observations).toHaveLength(2);
  });

  it("keeps preferred DigitalV3 money when a joined legacy row has no amount evidence", () => {
    const capture = baseline();
    updateLegacy(capture, (rows) => {
      delete rows[0]!.paymentSum;
      delete rows[0]!.currencyId;
    });
    const row = extract(capture).transactions[0]!;
    expect(row).toMatchObject({ amountMinor: -8640, currency: "ILS" });
    expect(row.details.issues).toContain("unresolved_companion_billing_amount");
    expect(row.details.issues).not.toContain(
      "conflicting_generation_billing_amount",
    );
  });

  it("maps billing currency code 100 to EUR and the legacy dollar text to USD", () => {
    const digitalOnly = baseline();
    delete digitalOnly.responses.legacy;
    updateDigital(digitalOnly, (rows) =>
      Object.assign(rows[0]!, {
        billingAmountCurrency: 100,
        billingAmount: 12.5,
      }),
    );
    expect(extract(digitalOnly).transactions[0]).toMatchObject({
      amountMinor: -1250,
      currency: "EUR",
    });
    for (const code of [10, 1000, "100 ", "EUR"]) {
      const capture = baseline();
      delete capture.responses.legacy;
      updateDigital(capture, (rows) =>
        Object.assign(rows[0]!, { billingAmountCurrency: code }),
      );
      expect(extract(capture).transactions[0], String(code)).toMatchObject({
        amountMinor: null,
        currency: null,
      });
    }
    const legacyOnly = baseline();
    delete legacyOnly.responses.digital;
    updateLegacy(legacyOnly, (rows) => {
      rows[0]!.currencyId = "דולר";
    });
    expect(extract(legacyOnly).transactions[0]).toMatchObject({
      amountMinor: -8640,
      currency: "USD",
    });
    // A dollar legacy companion of an ILS DigitalV3 bill is a currency conflict.
    const joined = baseline();
    updateLegacy(joined, (rows) => {
      rows[0]!.currencyId = "דולר";
    });
    const row = extract(joined).transactions[0]!;
    expect(row).toMatchObject({ amountMinor: null, currency: null });
    expect(row.details.issues).toContain(
      "conflicting_generation_billing_amount",
    );
    for (const text of ["דולר ", "דולרים", "$"]) {
      const capture = baseline();
      delete capture.responses.digital;
      updateLegacy(capture, (rows) => {
        rows[0]!.currencyId = text;
      });
      expect(extract(capture).transactions[0]!.currency, text).toBeNull();
    }
  });

  it("maps the source-derived legacy NIS alias to ILS in legacy-only and joined captures", () => {
    for (const legacyOnly of [true, false]) {
      const capture = baseline();
      if (legacyOnly) {
        delete capture.responses.digital;
      }
      updateLegacy(capture, (rows) => {
        rows[0]!.currencyId = "NIS";
      });
      const row = extract(capture).transactions[0]!;
      expect(row).toMatchObject({ amountMinor: -8640, currency: "ILS" });
      expect(row.details.issues).not.toContain(
        "conflicting_generation_billing_amount",
      );
      expect(row.details.provider.isracard!.rows).toMatchObject(
        legacyOnly ? [{ currencyId: "NIS" }] : [{}, { currencyId: "NIS" }],
      );
    }
  });

  it.each(["₪", 'ש"ח', "ש״ח"])(
    "maps the legacy shekel texts %s to ILS",
    (currencyId) => {
      const capture = baseline();
      delete capture.responses.digital;
      updateLegacy(capture, (rows) => {
        rows[0]!.currencyId = currencyId;
      });
      expect(extract(capture).transactions[0]).toMatchObject({
        amountMinor: -8640,
        currency: "ILS",
      });
    },
  );

  it("keeps unsupported legacy currency money unresolved without creating false companion conflicts", () => {
    for (const currencyId of ["AAA", "XXX"]) {
      for (const legacyOnly of [true, false]) {
        const capture = baseline();
        if (legacyOnly) {
          delete capture.responses.digital;
        }
        updateLegacy(capture, (rows) => {
          rows[0]!.currencyId = currencyId;
        });
        const row = extract(capture).transactions[0]!;
        expect(row).toMatchObject(
          legacyOnly
            ? { amountMinor: null, currency: null }
            : { amountMinor: -8640, currency: "ILS" },
        );
        expect(row.details.issues).toContain(
          legacyOnly
            ? "unresolved_billing_amount"
            : "unresolved_companion_billing_amount",
        );
        expect(row.details.issues).not.toContain(
          "conflicting_generation_billing_amount",
        );
      }
    }
  });

  it("preserves legacy-only txnInfo standing-order evidence without assigning canonical money to its unverified source role", () => {
    const capture = baseline();
    delete capture.responses.digital;
    const response = JSON.parse(capture.responses.legacy!) as {
      CardsTransactionsListBean: {
        Index0: {
          CurrentCardTransactions: { txnIsrael: Row[]; txnInfo: Row[] }[];
        };
      };
    };
    const group =
      response.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]!;
    group.txnInfo.push(group.txnIsrael.pop()!);
    capture.responses.legacy = JSON.stringify(response);
    const row = extract(capture).transactions.find((item) =>
      item.sourceKey.includes("LEGACY-ONLY"),
    )!;
    expect(row).toMatchObject({
      amountMinor: null,
      currency: null,
      billingDate: null,
    });
    expect(row.details.issues).toContain("unverified_legacy_source_role");
    expect(row.details.issues).not.toContain("informational_statement_row");
    expect(row.details.provider.isracard!.monetaryEvidence).toMatchObject({
      billingMinor: 1250,
      billingCurrency: "ILS",
    });
    expect(row.details.provider.isracard!.rows).toMatchObject([
      { isHoraatKeva: true },
    ]);
  });

  it("preserves foreign legacy voucher and purchase-date fields without coercing boolean original amounts", () => {
    const capture = baseline();
    delete capture.responses.digital;
    const response = JSON.parse(capture.responses.legacy!) as {
      CardsTransactionsListBean: { Index0: { CurrentCardTransactions: Row[] } };
    };
    response.CardsTransactionsListBean.Index0.CurrentCardTransactions = [
      {
        txnAbroad: [
          {
            fullPurchaseDateOutbound: "09/06/2040",
            fullSupplierNameOutbound: "Synthetic foreign merchant",
            voucherNumberRatzOutbound: "FOREIGN-VOUCHER",
            paymentSumOutbound: 7.5,
            dealSumOutbound: true,
            currencyId: "USD",
          },
        ],
      },
    ];
    capture.responses.legacy = JSON.stringify(response);
    const row = extract(capture).transactions[0]!;
    expect(row).toMatchObject({
      merchantName: "Synthetic foreign merchant",
      transactionDate: "2040-06-09",
      amountMinor: -750,
      currency: "USD",
      originalAmountMinor: null,
    });
    expect(row.sourceKey).toContain("FOREIGN-VOUCHER");
  });

  it("extracts out-of-statement billing dates and retains informative DigitalV3 rows without counting them", () => {
    const capture = baseline();
    delete capture.responses.legacy;
    const response = JSON.parse(capture.responses.digital!) as {
      data: {
        israelAbroadVouchers: {
          vouchers: {
            israelAbroadVouchersList: Row[];
            informativeOnlyVouchers: Row[];
          };
          outOfStatementChargeDateVouchers: Row[];
        };
      };
    };
    const base = response.data.israelAbroadVouchers;
    base.vouchers.informativeOnlyVouchers = [
      {
        ...base.vouchers.israelAbroadVouchersList[0],
        seqVoucherNumber: "INFO-VOUCHER",
      },
    ];
    base.outOfStatementChargeDateVouchers = [
      {
        immediateVouchersCurrencyDate: [
          {
            ...base.vouchers.israelAbroadVouchersList[0],
            seqVoucherNumber: "IMMEDIATE-VOUCHER",
          },
        ],
        totalVouchersCurrencyDate: { dateImmediateVouchers: "12/06/2040" },
      },
    ];
    capture.responses.digital = JSON.stringify(response);
    const rows = extract(capture).transactions;
    expect(rows).toHaveLength(3);
    expect(
      rows.find((row) => row.sourceKey.includes("IMMEDIATE-VOUCHER")),
    ).toMatchObject({ billingDate: "2040-06-12", amountMinor: -8640 });
    expect(
      rows.find((row) => row.sourceKey.includes("INFO-VOUCHER")),
    ).toMatchObject({ amountMinor: null, currency: null });
  });

  it.each(["card-month-approvals", "card-month-rich"])(
    "keeps full approval evidence in %s separate from posted identities",
    (name) => {
      const capture = baseline(name);
      const source = capture.responses.digital;
      const result = extract(capture);
      const withoutApprovals = structuredClone(capture);
      updateDigital(withoutApprovals, (_rows, data) => {
        data.approvals = null;
      });
      const posted = result.transactions.filter(
        (row) => row.status === "posted",
      );
      expect(posted).toEqual(
        extract(withoutApprovals).transactions.filter(
          (row) => row.status === "posted",
        ),
      );
      expect(
        posted.flatMap((row) => row.details.sourceRefs),
      ).not.toContainEqual(
        expect.objectContaining({ path: expect.stringContaining("approvals") }),
      );
      expect(result.warnings).not.toContain(
        "unsupported_approvals_preserved_raw",
      );
      expect(result.transactions.length).toBeGreaterThan(0);
      expect(
        result.transactions.filter((row) => row.status === "pending"),
      ).toHaveLength(2);
      expect(
        result.partitions.find((partition) => partition.status === "pending"),
      ).toMatchObject({ success: true, comparable: true });
      expect(
        result.partitions.find((partition) => partition.status === "posted"),
      ).toMatchObject({ success: true, comparable: false });
      expect(
        (JSON.parse(serializeIsracardCapture(capture)) as IsracardCapture)
          .responses.digital,
      ).toBe(source);
    },
  );

  it.each([
    { approvedTransactions: [], totalEstimatedAmount: 0 },
    { approvedTransactions: null, totalEstimatedAmount: null },
    { approvedTransactions: [{ purchaseDate: "11/06/2040" }] },
    { approvedTransactions: "Synthetic unsupported array" },
  ])("never certifies unsupported approval coverage from %j", (approvals) => {
    const capture = baseline();
    updateDigital(capture, (_rows, data) => {
      data.approvals = approvals;
    });
    const result = extract(capture);
    expect(result.transactions.every((row) => row.status === "posted")).toBe(
      true,
    );
    expect(result.warnings).toContain("unsupported_approvals_preserved_raw");
    expect(
      result.partitions.find((partition) => partition.status === "pending"),
    ).toMatchObject({ success: false, comparable: false });
  });

  it("accepts the observed approvals-only response as empty posted coverage alongside a pending snapshot", () => {
    const capture = baseline("card-month-approvals");
    updateDigital(capture, (_rows, data) => {
      data.israelAbroadVouchers = null;
      data.currentTransactionsList = null;
    });
    capture.card.companyCode = "77";
    capture.responses.cardList = JSON.stringify({
      isSuccess: true,
      data: { cardsList: [capture.card] },
    });
    delete capture.responses.legacy;
    delete capture.responses.details;
    delete capture.legacyCardIndex;
    const result = extract(capture);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions.every((row) => row.status === "pending")).toBe(
      true,
    );
    expect(result.warnings).not.toContain(
      "unsupported_approvals_preserved_raw",
    );
    expect(result.warnings).not.toContain("unsupported_digital_empty_shape");
    expect(result.partitions).toEqual([
      expect.objectContaining({
        status: "pending",
        success: true,
        comparable: true,
      }),
      expect.objectContaining({
        status: "posted",
        success: true,
        comparable: false,
      }),
    ]);
  });

  it.each<[Row, Row | null]>([
    [{ approvedTransactions: [], totalEstimatedAmount: null }, null],
    [{ approvedTransactions: [], totalEstimatedAmount: "0" }, null],
    [{ approvedTransactions: null, totalEstimatedAmount: 0 }, null],
    [{ approvedTransactions: {}, totalEstimatedAmount: 0 }, null],
    [{ approvedTransactions: [null], totalEstimatedAmount: 0 }, null],
    [{ approvedTransactions: [42], totalEstimatedAmount: 0 }, null],
    [
      { approvedTransactions: [], totalEstimatedAmount: 0, unknown: true },
      null,
    ],
    [{ approvedTransactions: [] }, null],
    [
      (
        JSON.parse(baseline("card-month-approvals").responses.digital!) as {
          data: { approvals: Row };
        }
      ).data.approvals,
      (
        JSON.parse(
          baseline("card-month-pending-summary").responses.digital!,
        ) as { data: { currentTransactionsList: Row } }
      ).data.currentTransactionsList,
    ],
  ])(
    "keeps unsupported posted null-voucher shapes partial beside approval evidence: approvals=%j summary=%j",
    (approvals, currentTransactionsList) => {
      const capture = baseline("card-month-approvals");
      updateDigital(capture, (_rows, data) => {
        data.israelAbroadVouchers = null;
        data.currentTransactionsList = currentTransactionsList;
        data.approvals = approvals;
      });
      const result = extract(capture);
      expect(result.warnings).toContain("unsupported_digital_empty_shape");
      if (currentTransactionsList !== null) {
        expect(result.warnings).toContain("unsupported_pending_summary");
      }
      expect(result.partitions).toEqual([
        expect.objectContaining({
          status: "pending",
          success: currentTransactionsList !== null,
          comparable: currentTransactionsList !== null,
        }),
        expect.objectContaining({
          status: "posted",
          success: false,
          comparable: false,
        }),
      ]);
    },
  );

  it.each<{
    name: string;
    errorCode: unknown;
    accepted: boolean;
    archive?: boolean;
    pending?: boolean;
  }>([
    { name: "missing", errorCode: undefined, accepted: true },
    { name: "null", errorCode: null, accepted: true },
    { name: "numeric zero", errorCode: 0, accepted: true },
    { name: "string zero", errorCode: "0", accepted: true, archive: true },
    { name: "empty", errorCode: "", accepted: true },
    {
      name: "numeric one",
      errorCode: 1,
      accepted: false,
      archive: true,
      pending: true,
    },
    {
      name: "numeric thirteen",
      errorCode: 13,
      accepted: false,
      archive: true,
      pending: true,
    },
    {
      name: "numeric ninety-one",
      errorCode: 91,
      accepted: false,
      archive: true,
    },
    { name: "string one", errorCode: "1", accepted: false, archive: true },
    {
      name: "string thirteen",
      errorCode: "13",
      accepted: false,
      archive: true,
      pending: true,
    },
    { name: "unknown", errorCode: "unknown", accepted: false, archive: true },
    { name: "padded zero", errorCode: "00", accepted: false },
    { name: "spaced zero", errorCode: " 0 ", accepted: false },
    { name: "false", errorCode: false, accepted: false },
    {
      name: "unrecognized numeric code",
      errorCode: 999,
      accepted: false,
      pending: true,
    },
  ])(
    "extracts and retains imported DigitalV3 evidence with $name root status",
    async ({ errorCode, accepted, archive, pending }) => {
      if (accepted) {
        const capture = baseline("card-month-approvals");
        const digital = JSON.parse(capture.responses.digital!) as Row;
        delete digital.errorCode;
        capture.responses.digital = JSON.stringify(digital);
        const expected = extract(capture);
        if (errorCode !== undefined) {
          digital.errorCode = errorCode;
        }
        capture.responses.digital = JSON.stringify(digital);
        expect(extract(capture)).toEqual(expected);
      } else if (errorCode !== 999) {
        for (const keepLegacy of [true, false]) {
          const capture = baseline("card-month-approvals");
          if (!keepLegacy) {
            delete capture.responses.legacy;
          }
          const digital = JSON.parse(capture.responses.digital!) as Row;
          digital.errorCode = errorCode;
          capture.responses.digital = JSON.stringify(digital);
          const withoutDigital = structuredClone(capture);
          delete withoutDigital.responses.digital;
          const result = extract(capture);
          expect(result.transactions).toEqual(
            extract(withoutDigital).transactions,
          );
          expect(
            result.transactions
              .flatMap((row) => row.details.sourceRefs)
              .every(({ path }) => !path.startsWith("$.responses.digital")),
          ).toBe(true);
          expect(result.warnings).toContain("invalid_digital_response");
          expect(result.partitions).toEqual([
            expect.objectContaining({
              status: "pending",
              success: false,
              comparable: false,
            }),
            expect.objectContaining({
              status: "posted",
              success: false,
              comparable: false,
            }),
          ]);
          if (!keepLegacy) {
            expect(result.transactions).toEqual([]);
          }
        }
      }
      if (pending) {
        const capture = baseline("card-month-approvals");
        capture.card.companyCode = "77";
        capture.responses.cardList = JSON.stringify({
          isSuccess: true,
          data: { cardsList: [capture.card] },
        });
        delete capture.responses.legacy;
        delete capture.responses.details;
        delete capture.legacyCardIndex;
        const digital = JSON.parse(capture.responses.digital!) as {
          errorCode?: unknown;
          data: Row;
        };
        const approvals = digital.data.approvals as {
          approvedTransactions: Row[];
        };
        digital.data.approvals = {
          approvedTransactions: [approvals.approvedTransactions[0]!],
          totalEstimatedAmount: 86.4,
        };
        digital.errorCode = errorCode;
        capture.responses.digital = JSON.stringify(digital);
        const result = extract(capture);
        expect(result.transactions).toEqual([]);
        expect(
          result.partitions.every(
            (partition) => !partition.success && !partition.comparable,
          ),
        ).toBe(true);
      }
      if (archive) {
        const capture = baseline("card-month-approvals");
        const digital = JSON.parse(capture.responses.digital!) as Row;
        digital.errorCode = errorCode;
        capture.responses.digital = ` \n${JSON.stringify(digital, null, 2)}\n`;
        const source = serializeIsracardCapture(capture);
        const db = await openDatabase(":memory:");
        try {
          await db.ensureConnection({
            id: "synthetic-isracard",
            provider: "isracard",
          });
          const result = await ingestCapture(db, capture, 1);
          if (errorCode === "0") {
            expect(result.status).toBe("completed");
          } else {
            expect(result.status).not.toBe("completed");
          }
          const [run] = await db.orm.select().from(syncRuns).all();
          const [body] = await db.orm.select().from(syncRunBodies).all();
          expect(run!.snapshot.responses[0]).not.toHaveProperty("responseText");
          expect(body!.snapshot.responses[0]!.responseText).toBe(source);
          const archived = JSON.parse(
            body!.snapshot.responses[0]!.responseText,
          ) as IsracardCapture;
          expect(archived.responses.digital).toBe(capture.responses.digital);
          expect(run!.coverage).toContainEqual(
            expect.objectContaining({
              status: "pending",
              success: errorCode === "0",
              comparable: errorCode === "0",
            }),
          );
          expect(await db.listTransactions({ status: "pending" })).toHaveLength(
            errorCode === "0" ? 2 : 0,
          );
        } finally {
          await db.close();
        }
      }
    },
  );

  it.each(["0.0", "0e0", "-0"])(
    "accepts numeric zero status lexeme %s without changing source money",
    (lexeme) => {
      const capture = baseline("card-month-approvals");
      const digital = JSON.parse(capture.responses.digital!) as Row;
      digital.errorCode = 0;
      capture.responses.digital = JSON.stringify(digital);
      const expected = extract(capture);
      const original = capture.responses.digital;
      capture.responses.digital = capture.responses.digital.replace(
        '"errorCode":0',
        `"errorCode":${lexeme}`,
      );
      expect(capture.responses.digital).not.toBe(original);
      const root = parse(capture.responses.digital) as Row;
      const rootCode = isLosslessNumber(root.errorCode)
        ? root.errorCode
        : undefined;
      expect(rootCode?.value).toBe(lexeme);
      expect(extract(capture)).toEqual(expected);
    },
  );

  it("preserves valid DigitalV3 rows if the legacy response fails or cannot bind", () => {
    for (const failure of [
      "malformed",
      "failed",
      "missing-index",
      "ambiguous-index",
    ]) {
      const capture = baseline();
      if (failure === "malformed") {
        capture.responses.legacy = "{";
      } else if (failure === "failed") {
        capture.responses.legacy = '{"Header":{"Status":"2"}}';
      } else if (failure === "missing-index") {
        delete capture.legacyCardIndex;
      } else {
        updateLegacy(capture, (_rows, data) => {
          data.cardNumberList = ["Synthetic 1234", "Collision 1234"];
        });
      }
      const result = extract(capture);
      expect(result.transactions).toHaveLength(1);
      expect(result.partitions[0]).toMatchObject({
        success: false,
        comparable: false,
      });
    }
  });

  it("rejects suffix-only identity and captures bound to another account or scope", () => {
    const capture = baseline();
    const responseText = serializeIsracardCapture(capture);
    for (const context of [
      { accountKey: "1234", runId: "run" },
      {
        accountKey: isracardCardKey(capture.card),
        runId: "run",
        scope: {
          kind: "recent" as const,
          month: "2040-06",
          cardKey: isracardCardKey(capture.card),
        },
      },
    ]) {
      const result = extractIsracard(responseText, context);
      expect(result.transactions).toEqual([]);
      expect(result.partitions[0]).toMatchObject({
        success: false,
        comparable: false,
      });
    }
    const cards = JSON.parse(capture.responses.cardList) as {
      data: { cardsList: Row[] };
    };
    cards.data.cardsList.push({
      ...cards.data.cardsList[0]!,
      cardGuid: "COLLIDING-GUID",
    });
    capture.responses.cardList = JSON.stringify(cards);
    expect(extract(capture).transactions).toEqual([]);
  });

  it("retains malformed dates and malformed siblings as reviewable or incomplete evidence", () => {
    const capture = baseline();
    delete capture.responses.legacy;
    updateDigital(capture, (rows) => {
      rows[0]!.purchaseDate = "30/02/2040";
      rows.push(null as unknown as Row);
    });
    const result = extract(capture);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      transactionDate: null,
      identityStrength: "ambiguous",
    });
    expect(result.partitions[0]).toMatchObject({
      success: false,
      comparable: false,
    });
  });

  it("marks history explicitly and never permits disappearance from month captures", () => {
    for (const mode of ["recent", "history"] as const) {
      const capture = baseline();
      capture.mode = mode;
      const result = extract(capture);
      expect(result.historical).toBe(mode === "history");
      expect(
        result.partitions.every((partition) => !partition.comparable),
      ).toBe(true);
    }
  });

  it("reports invalid captures without successful coverage", () => {
    for (const responseText of ["{", "{}", '{"schemaVersion":2}']) {
      const result = extractIsracard(responseText, {
        accountKey: "synthetic",
        runId: "run",
      });
      expect(result.transactions).toEqual([]);
      expect(result.warnings).toContain("invalid_isracard_capture");
      expect(result.partitions).toEqual([
        {
          accountKey: "synthetic",
          status: "posted",
          success: false,
          comparable: false,
        },
      ]);
    }
  });

  it("requires explicit matching scope before projecting an otherwise valid raw capture", () => {
    const capture = baseline();
    const result = extractIsracard(serializeIsracardCapture(capture), {
      accountKey: isracardCardKey(capture.card),
      runId: "synthetic-unscoped",
    });
    expect(result.transactions).toEqual([]);
    expect(result.partitions).toEqual([
      {
        accountKey: isracardCardKey(capture.card),
        status: "posted",
        success: false,
        comparable: false,
      },
    ]);
    expect(result.warnings).toContain("invalid_card_or_scope_binding");
    expect(extract(capture).transactions).toHaveLength(2);
  });

  it("reconciles legacy-only, combined and DigitalV3-only captures onto the same permanent identities", async () => {
    const db = await openDatabase(":memory:");
    try {
      await db.ensureConnection({
        id: "synthetic-isracard",
        provider: "isracard",
      });
      const variants = [baseline(), baseline(), baseline()];
      delete variants[0]!.responses.digital;
      delete variants[2]!.responses.legacy;
      let ids: string[] | undefined;
      for (const [index, capture] of variants.entries()) {
        const accountKey = isracardCardKey(capture.card);
        await db.ingestRun(
          {
            debugArchiveDays: 2,
            connectionId: "synthetic-isracard",
            runId: `synthetic-isracard-run-${index}`,
            responses: [
              {
                accountKey,
                endpoint: "isracard:card-month",
                capturedAt: `2040-07-0${index + 1}T00:00:00.000Z`,
                responseText: serializeIsracardCapture(capture),
                scope: {
                  kind: capture.mode,
                  month: capture.billingMonth,
                  cardKey: accountKey,
                },
              },
            ],
          },
          isracardAdapter,
        );
        const rows = await db.listTransactions();
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.presence === "seen")).toBe(true);
        const currentIds = rows.map((row) => row.id).sort();
        if (ids) {
          expect(currentIds).toEqual(ids);
        }
        ids = currentIds;
      }
    } finally {
      db.close();
    }
  });

  it("keeps card and transaction identity when a later login issues a new session cardGuid", async () => {
    const db = await openDatabase(":memory:");
    try {
      await db.ensureConnection({
        id: "synthetic-isracard",
        provider: "isracard",
      });
      const later = baseline();
      later.card.cardGuid = "SYNTHETIC-NEXT-SESSION-GUID";
      const cards = JSON.parse(later.responses.cardList) as {
        data: { cardsList: Row[] };
      };
      cards.data.cardsList[0]!.cardGuid = later.card.cardGuid;
      later.responses.cardList = JSON.stringify(cards);
      expect(isracardCardKey(later.card)).toBe(
        isracardCardKey(baseline().card),
      );
      const first = await ingestCapture(db, baseline(), 0);
      const second = await ingestCapture(db, later, 1);
      expect(first.created).toBeGreaterThan(0);
      expect(second.created).toBe(0);
      const rows = await db.listTransactions();
      expect(rows).toHaveLength(first.created);
      expect(
        rows.every((row) => row.lastSeenRunId === "synthetic-review-1"),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("does not enrich a current purchase from a historical same-voucher purchase on another date", async () => {
    const db = await openDatabase(":memory:");
    try {
      await db.ensureConnection({
        id: "synthetic-isracard",
        provider: "isracard",
      });
      await ingestCapture(db, baseline(), 0);
      const before = (await db.listTransactions()).find(
        (row) => row.transactionDate === "2040-06-11",
      )!;
      const historical = baseline();
      historical.mode = "history";
      delete historical.responses.legacy;
      delete historical.responses.details;
      updateDigital(historical, (rows) => {
        rows[0]!.purchaseDate = "12/05/2039";
        rows[0]!.cityDescription = "Other historical city";
        rows[0]!.businessName = "Other historical merchant";
      });
      await ingestCapture(db, historical, 1);
      const after = (await db.listTransactions()).find(
        (row) => row.id === before.id,
      )!;
      expect(after.details.merchant.city).toBe(before.details.merchant.city);
      expect(after.details.sourceRefs).toEqual(before.details.sourceRefs);
      expect(after.version).toBe(before.version);
    } finally {
      db.close();
    }
  });

  it("keeps one row per voucher for non-plan installment payments across monthly captures and replays quietly", async () => {
    const db = await openDatabase(":memory:");
    const monthly = (installment: number) => {
      const capture = baseline();
      delete capture.responses.legacy;
      capture.billingMonth = installment === 2 ? "2040-07" : "2040-08";
      updateDigital(capture, (rows) =>
        Object.assign(rows[0]!, {
          currentInstallmentNum: installment,
          numberOfInstallment: 12,
          billingAmount: 10,
          originalAmount: 120,
        }),
      );
      return capture;
    };
    try {
      await db.ensureConnection({
        id: "synthetic-isracard",
        provider: "isracard",
      });
      await ingestCapture(db, monthly(2), 0);
      await ingestCapture(db, monthly(3), 1);
      const rows = await db.listTransactions();
      // A code 1 row with installment numbers is not a plan payment: one
      // unresolved row per voucher.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        amountMinor: null,
        installmentCount: null,
        installmentNumber: null,
        purchaseId: null,
      });
      expect(presentWireTransaction(rows[0]!)).toMatchObject({
        installmentCount: null,
        installmentNumber: null,
        amount: null,
      });
      const events = await db.listEvents({});
      await ingestCapture(db, monthly(3), 2);
      expect(
        (await db.listEvents({ after: events.at(-1)!.id })).filter((event) =>
          event.type.startsWith("transaction."),
        ),
      ).toEqual([]);
      expect((await db.listTransactions())[0]!.version).toBe(rows[0]!.version);
    } finally {
      db.close();
    }
  });

  it("joins equal numeric voucher lexemes and flags numeric-equivalent mismatches without normalizing identity", () => {
    const capture = baseline("card-month-numeric");
    expect(extract(capture).transactions).toHaveLength(2);
    updateDigital(capture, (rows) => {
      rows[0]!.seqVoucherNumber = "123456";
    });
    const result = extract(capture);
    expect(result.warnings).toContain("numeric_equivalent_voucher_mismatch");
    expect(
      result.partitions.find((partition) => partition.status === "posted"),
    ).toMatchObject({ success: false, comparable: false });
    const uncertain = result.transactions.filter((row) =>
      row.sourceKey.includes("123456"),
    );
    expect(uncertain).toHaveLength(2);
    expect(
      uncertain.every(
        (row) =>
          row.identityStrength === "ambiguous" &&
          row.amountMinor === null &&
          row.currency === null,
      ),
    ).toBe(true);
    expect(
      uncertain
        .map((row) => row.sourceKey)
        .some((key) => key.includes("000123456")),
    ).toBe(true);
    expect(
      uncertain
        .map((row) => row.sourceKey)
        .some((key) => !key.includes("000123456")),
    ).toBe(true);
  });

  it("joins informative DigitalV3 evidence with its unique legacy companion and keeps its canonical money null", () => {
    const capture = baseline();
    const digital = JSON.parse(capture.responses.digital!) as {
      data: {
        israelAbroadVouchers: {
          vouchers: {
            israelAbroadVouchersList: Row[];
            informativeOnlyVouchers: Row[];
          };
        };
      };
    };
    const vouchers = digital.data.israelAbroadVouchers.vouchers;
    vouchers.informativeOnlyVouchers.push(
      vouchers.israelAbroadVouchersList.pop()!,
    );
    capture.responses.digital = JSON.stringify(digital);
    const result = extract(capture);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({
      amountMinor: null,
      currency: null,
      identityStrength: "native",
    });
    expect(
      result.transactions[0]!.details.provider.isracard!.observations,
    ).toHaveLength(2);
    expect(
      result.transactions.reduce((sum, row) => sum + (row.amountMinor ?? 0), 0),
    ).toBe(-1250);
  });

  it("keeps ambiguous cross-generation billing money only as evidence", () => {
    for (const change of ["duplicate", "different-date", "invalid-date"]) {
      const capture = baseline();
      updateDigital(capture, (rows) => {
        if (change === "duplicate") {
          rows.push({ ...rows[0]!, billingAmount: 100 });
        } else {
          rows[0]!.purchaseDate =
            change === "different-date" ? "12/06/2040" : "31/02/2040";
        }
      });
      const rows = extract(capture).transactions.filter((row) =>
        row.sourceKey.includes("VOUCHER-1"),
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(
        rows.every((row) => row.amountMinor === null && row.currency === null),
      ).toBe(true);
      expect(
        rows.every(
          (row) =>
            row.details.provider.isracard!.monetaryEvidence !== undefined,
        ),
      ).toBe(true);
    }
  });

  it("fails closed on malformed nonnull installment indicators", () => {
    for (const field of ["currentInstallmentNum", "numberOfInstallment"]) {
      for (const value of ["12 ", "N/A", -1, 1.5, "2e0", "9007199254740993"]) {
        const capture = baseline();
        delete capture.responses.legacy;
        updateDigital(capture, (rows) => {
          rows[0]![field] = value;
        });
        const row = extract(capture).transactions[0]!;
        expect(row).toMatchObject({
          amountMinor: null,
          currency: null,
          installmentCount: null,
          installmentNumber: null,
        });
        expect(row.details.issues).toContain("invalid_installment_ordinal");
        expect(row.details.issues).toContain(
          "unverified_installment_amount_basis",
        );
      }
    }
  });

  it("does not create permanent duplicates when a native voucher becomes ambiguous", async () => {
    const db = await openDatabase(":memory:");
    try {
      await db.ensureConnection({
        id: "synthetic-isracard",
        provider: "isracard",
      });
      const capture = baseline();
      delete capture.responses.legacy;
      await ingestCapture(db, capture, 0);
      const original = (await db.listTransactions())[0]!;
      await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Synthetic owner note",
      });
      updateDigital(capture, (rows) => {
        rows.push({
          ...rows[0]!,
          businessName: "Another synthetic merchant",
          billingAmount: 100,
        });
      });
      const result = await ingestCapture(db, capture, 1);
      expect(result.created).toBe(0);
      const rows = await db.listTransactions();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: original.id,
        sourceKey: original.sourceKey,
        merchantName: original.merchantName,
        presence: "seen",
      });
      expect(
        (await db.getTransaction(original.id))?.annotation?.data.notes,
      ).toBe("Synthetic owner note");
    } finally {
      db.close();
    }
  });

  it("does not claim full coverage from a missing required financial source", () => {
    for (const missing of ["digital", "legacy"] as const) {
      const capture = baseline();
      delete capture.responses[missing];
      const result = extract(capture);
      expect(result.transactions.length).toBeGreaterThan(0);
      expect(
        result.partitions.find((partition) => partition.status === "posted"),
      ).toMatchObject({ success: false, comparable: false });
      expect(result.warnings).toContain(`missing_required_${missing}_response`);
    }
    const amex = baseline();
    amex.card.companyCode = "77";
    amex.responses.cardList = JSON.stringify({
      isSuccess: true,
      data: { cardsList: [amex.card] },
    });
    delete amex.responses.legacy;
    expect(extract(amex).partitions).toMatchObject([
      { status: "posted", success: true, comparable: false },
    ]);
  });

  it("leaves optional detail failures separate from financial source health aliases", () => {
    expect(
      isracardAdapter.resourceKey!(
        "https://web.isracard.co.il/ocp/transactions/DigitalV3.Transactions/GetTransactionsList",
      ),
    ).toBe("isracard:card-month");
    const detail =
      "https://digital.isracard.co.il/services/ProxyRequestHandler.ashx?reqName=PirteyIska_204";
    expect(isracardAdapter.resourceKey!(detail)).toBe(detail);
    const capture = baseline();
    capture.responses.details![0]!.responseText = '{"Header":{"Status":"2"}}';
    expect(extract(capture).partitions).toMatchObject([
      { status: "posted", success: true },
    ]);
  });

  it("accepts the observed all-null DigitalV3 month as empty and keeps legacy gap filling", () => {
    const capture = baseline();
    const expected = extract(capture).transactions.filter((transaction) =>
      (
        transaction.details.provider.isracard as {
          observations: { generation: string }[];
        }
      ).observations.some((item) => item.generation === "legacy"),
    ).length;
    capture.responses.digital =
      '{"data":{"approvals":null,"israelAbroadVouchers":null,"currentTransactionsList":null},"errorCode":"0","errorDescription":null,"isSuccess":true}';
    const result = extract(capture);
    expect(result.warnings).not.toContain("unsupported_digital_empty_shape");
    expect(
      result.partitions.find((partition) => partition.status === "posted"),
    ).toMatchObject({ success: true, comparable: false });
    expect(expected).toBeGreaterThan(0);
    expect(result.transactions).toHaveLength(expected);
  });

  it("reports a non-null current-transactions partition beside vouchers as partial and keeps the voucher rows", () => {
    const expected = extract().transactions.map((row) => row.sourceKey);
    for (const currentTransactionsList of [
      [{ seqVoucherNumber: "SYNTHETIC-CURRENT", billingAmount: 5 }],
      [],
      {},
      "synthetic",
    ]) {
      const capture = baseline();
      updateDigital(capture, (_rows, data) => {
        data.currentTransactionsList = currentTransactionsList;
      });
      const result = extract(capture);
      expect(result.warnings).toContain(
        "unsupported_current_transactions_preserved_raw",
      );
      expect(
        result.partitions.find((partition) => partition.status === "posted"),
      ).toMatchObject({ success: false, comparable: false });
      expect(result.transactions.map((row) => row.sourceKey)).toEqual(expected);
    }
    for (const currentTransactionsList of [null, undefined]) {
      const capture = baseline();
      updateDigital(capture, (_rows, data) => {
        data.currentTransactionsList = currentTransactionsList;
      });
      const result = extract(capture);
      expect(result.warnings).not.toContain(
        "unsupported_current_transactions_preserved_raw",
      );
      expect(
        result.partitions.find((partition) => partition.status === "posted"),
      ).toMatchObject({ success: true });
    }
  });

  it("keeps the pending summary raw without partial posted coverage or pending rows", () => {
    const expected = extract().transactions.map((row) => row.sourceKey);
    const summary = baseline("card-month-pending-summary");
    const result = extract(summary);
    expect(result.warnings).toContain("unsupported_pending_summary");
    expect(result.warnings).not.toContain(
      "unsupported_current_transactions_preserved_raw",
    );
    expect(result.partitions).toEqual([
      expect.objectContaining({ status: "posted", success: true }),
    ]);
    expect(result.transactions.map((row) => row.sourceKey)).toEqual(expected);
    expect(result.transactions.every((row) => row.status === "posted")).toBe(
      true,
    );
    expect(summary.responses.digital).toContain(
      "currentTransactionsBillingMonth",
    );

    // The summary beside an empty month is accepted too.
    const empty = baseline("card-month-pending-summary");
    updateDigital(empty, (_rows, data) => {
      data.israelAbroadVouchers = null;
    });
    delete empty.responses.legacy;
    empty.card.companyCode = "77";
    empty.responses.cardList = empty.responses.cardList.replace(
      '"companyCode": "11"',
      '"companyCode": "77"',
    );
    delete empty.legacyCardIndex;
    const emptyResult = extract(empty);
    expect(emptyResult.transactions).toEqual([]);
    expect(emptyResult.warnings).toContain("unsupported_pending_summary");
    expect(emptyResult.partitions).toEqual([
      expect.objectContaining({ status: "posted", success: true }),
    ]);

    // Any other shape stays unsupported and partial.
    const month = (total: Row): Row => ({
      currentBillingMonth: "10/08/2040",
      totalTransactionsCurrency: [total],
    });
    const total: Row = {
      transactionsTotal: 42.5,
      transactionsCurrency: 0,
      transactionsSymbol: "₪",
      transactionsCount: 1,
    };
    for (const currentTransactionsList of [
      { currentTransactionsBillingMonth: [month({ ...total, extra: 1 })] },
      {
        currentTransactionsBillingMonth: [
          month({ ...total, transactionsTotal: "42.50" }),
        ],
      },
      {
        currentTransactionsBillingMonth: [
          month({ ...total, transactionsCount: 1.5 }),
        ],
      },
      {
        currentTransactionsBillingMonth: [
          { ...month(total), currentBillingMonth: "2040-08-10" },
        ],
      },
      { currentTransactionsBillingMonth: [month(total)], transactions: [] },
      { currentTransactionsBillingMonth: {} },
    ]) {
      const capture = baseline();
      updateDigital(capture, (_rows, data) => {
        data.currentTransactionsList = currentTransactionsList;
      });
      const other = extract(capture);
      expect(other.warnings).toContain(
        "unsupported_current_transactions_preserved_raw",
      );
      expect(other.warnings).not.toContain("unsupported_pending_summary");
      expect(other.partitions[0]).toMatchObject({ success: false });
    }
  });

  it("reads the observed one-partition legacy groups with null empty partitions", () => {
    const capture = baseline();
    const expected = extract(capture).transactions.length;
    const response = JSON.parse(capture.responses.legacy!) as {
      CardsTransactionsListBean: {
        Index0: { CurrentCardTransactions: Row[] };
      };
    };
    const entry = response.CardsTransactionsListBean.Index0;
    const [group] = entry.CurrentCardTransactions;
    entry.CurrentCardTransactions = ["txnIsrael", "txnInfo", "txnAbroad"].map(
      (field) => ({
        "@cardTransactions": "synthetic",
        [field]: (group![field] as Row[] | undefined)?.length
          ? group![field]
          : null,
      }),
    );
    capture.responses.legacy = JSON.stringify(response);
    const result = extract(capture);
    expect(result.transactions).toHaveLength(expected);
    expect(
      result.partitions.find((partition) => partition.status === "posted"),
    ).toMatchObject({ success: true, comparable: false });
    for (const groups of [
      [{ txnIsrael: "malformed" }],
      [{}],
      [{ "@cardTransactions": "synthetic", txnUnknown: [{}] }],
      [{ txnIsrael: null, txnUnknown: [] }],
      [{ txnIsrael: null, txnUnknown: { rows: [{}] } }],
    ]) {
      entry.CurrentCardTransactions = groups;
      capture.responses.legacy = JSON.stringify(response);
      expect(
        extract(capture).partitions.find(
          (partition) => partition.status === "posted",
        ),
      ).toMatchObject({ success: false });
    }
  });

  it("keeps recognized legacy rows when a sibling container is unsupported", () => {
    const capture = baseline();
    const expected = extract(capture).transactions;
    const response = JSON.parse(capture.responses.legacy!) as {
      CardsTransactionsListBean: {
        Index0: { CurrentCardTransactions: Row[] };
      };
    };
    response.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]!.txnUnknown =
      [];
    capture.responses.legacy = JSON.stringify(response);
    const result = extract(capture);
    expect(result.transactions.map((row) => row.sourceKey)).toEqual(
      expected.map((row) => row.sourceKey),
    );
    expect(
      result.transactions.map((row) => row.details.sourceRefs.length),
    ).toEqual(expected.map((row) => row.details.sourceRefs.length));
    expect(
      result.partitions.find((partition) => partition.status === "posted"),
    ).toMatchObject({ success: false });
  });

  it("reports unverified null empty shapes as partial instead of inventing successful coverage", () => {
    for (const field of [
      "israelAbroadVouchers",
      "outOfStatementChargeDateVouchers",
      "informativeOnlyVouchers",
    ]) {
      const capture = baseline();
      const digital = JSON.parse(capture.responses.digital!) as {
        data: Row & { israelAbroadVouchers: Row & { vouchers: Row } };
      };
      if (field === "israelAbroadVouchers") {
        digital.data[field] = null as unknown as Row & { vouchers: Row };
      } else if (field === "informativeOnlyVouchers") {
        digital.data.israelAbroadVouchers.vouchers[field] = null;
      } else {
        digital.data.israelAbroadVouchers[field] = null;
      }
      capture.responses.digital = JSON.stringify(digital);
      expect(
        extract(capture).partitions.find(
          (partition) => partition.status === "posted",
        ),
      ).toMatchObject({ success: false, comparable: false });
    }
  });

  it("matches reordered duplicate rows by source facts while retaining their annotations", async () => {
    const db = await openDatabase(":memory:");
    try {
      await db.ensureConnection({
        id: "synthetic-isracard",
        provider: "isracard",
      });
      const capture = baseline();
      delete capture.responses.legacy;
      updateDigital(capture, (rows) => {
        rows.push({
          ...rows[0]!,
          businessName: "Second synthetic merchant",
          billingAmount: 100,
        });
      });
      await ingestCapture(db, capture, 0);
      const original = (await db.listTransactions()).find(
        (row) => row.merchantName === "Synthetic merchant",
      )!;
      await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Note for first merchant",
      });
      updateDigital(capture, (rows) => {
        rows.reverse();
      });
      const result = await ingestCapture(db, capture, 1);
      expect(result.created).toBe(0);
      const rows = await db.listTransactions();
      expect(rows).toHaveLength(2);
      expect(
        rows.find((row) => row.merchantName === "Synthetic merchant")?.id,
      ).toBe(original.id);
      expect(
        (await db.getTransaction(original.id))?.annotation?.data.notes,
      ).toBe("Note for first merchant");
    } finally {
      db.close();
    }
  });

  it("does not re-key incomplete rows when new rows shift their source-array indexes", async () => {
    for (const missing of ["purchaseDate", "seqVoucherNumber"]) {
      const db = await openDatabase(":memory:");
      try {
        await db.ensureConnection({
          id: "synthetic-isracard",
          provider: "isracard",
        });
        const capture = baseline();
        delete capture.responses.legacy;
        updateDigital(capture, (rows) => {
          rows[0]![missing] = null;
        });
        await ingestCapture(db, capture, 0);
        const original = (await db.listTransactions())[0]!;
        await db.editAnnotation({
          transactionId: original.id,
          expectedVersion: 0,
          notes: "Note for incomplete row",
        });
        updateDigital(capture, (rows) => {
          rows.unshift({
            ...rows[0]!,
            purchaseDate: "13/06/2040",
            seqVoucherNumber: "NEW-VOUCHER",
            businessName: "New synthetic merchant",
          });
        });
        const result = await ingestCapture(db, capture, 1);
        expect(result.created).toBe(1);
        const rows = await db.listTransactions();
        expect(rows).toHaveLength(2);
        expect(
          rows.find((row) => row.merchantName === "Synthetic merchant")?.id,
        ).toBe(original.id);
        expect(
          (await db.getTransaction(original.id))?.annotation?.data.notes,
        ).toBe("Note for incomplete row");
      } finally {
        db.close();
      }
    }
  });
});
