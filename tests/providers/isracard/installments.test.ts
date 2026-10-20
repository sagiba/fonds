import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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

type Row = Record<string, unknown>;

/** The invented three-payment plan (voucher 4242), a decoy and a legacy-only plan. */
function fixture(): IsracardCapture {
  return JSON.parse(
    readFileSync(
      new URL("./fixtures/card-month-installments.json", import.meta.url),
      "utf8",
    ),
  ) as IsracardCapture;
}

function digitalRows(capture: IsracardCapture): Row[] {
  return (
    JSON.parse(capture.responses.digital!) as {
      data: {
        israelAbroadVouchers: { vouchers: { israelAbroadVouchersList: Row[] } };
      };
    }
  ).data.israelAbroadVouchers.vouchers.israelAbroadVouchersList;
}

function updateDigital(
  capture: IsracardCapture,
  change: (rows: Row[]) => Row[] | void,
): void {
  const response = JSON.parse(capture.responses.digital!) as {
    data: {
      israelAbroadVouchers: { vouchers: { israelAbroadVouchersList: Row[] } };
    };
  };
  const vouchers = response.data.israelAbroadVouchers.vouchers;
  vouchers.israelAbroadVouchersList =
    change(vouchers.israelAbroadVouchersList) ??
    vouchers.israelAbroadVouchersList;
  capture.responses.digital = JSON.stringify(response);
}

function updateLegacy(
  capture: IsracardCapture,
  change: (rows: Row[]) => Row[] | void,
): void {
  const response = JSON.parse(capture.responses.legacy!) as {
    CardsTransactionsListBean: {
      Index0: { CurrentCardTransactions: { txnIsrael: Row[] }[] };
    };
  };
  const group =
    response.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]!;
  group.txnIsrael = change(group.txnIsrael) ?? group.txnIsrael;
  capture.responses.legacy = JSON.stringify(response);
}

/** Payments of the 4242 plan: an uneven first payment, then 33.00 twice. */
const planPayments = [34, 33, 33];

/**
 * The capture of billing month `2040-(03 + payment)`: payment `payment` of the
 * 4242 plan in both generations and payment `payment + 3` of the legacy-only
 * 10-payment plan. Only the first month keeps the decoy and the bound detail.
 */
function planMonth(payment: number): IsracardCapture {
  const capture = fixture();
  capture.billingMonth = `2040-${String(3 + payment).padStart(2, "0")}`;
  const voucher = `70000010${payment}`;
  const amount = planPayments[payment - 1]!;
  updateDigital(capture, (rows) => {
    const plan = rows[0]!;
    Object.assign(plan, {
      seqVoucherNumber: voucher,
      billingAmount: amount,
      ilsAmount: amount,
      currentInstallmentNum: payment,
      isLastInstallment: payment === 3,
      moreInfo: ` תשלום ${payment} מ 3  `,
    });
    return payment === 1 ? rows : [plan];
  });
  updateLegacy(capture, (rows) => {
    const [plan, decoy, legacyOnly] = rows as [Row, Row, Row];
    Object.assign(plan, {
      voucherNumberRatz: voucher,
      paymentSum: `${amount}.00`,
      moreInfo: `תשלום ${payment}  מתוך 3`,
    });
    Object.assign(legacyOnly, {
      voucherNumberRatz: `70000030${payment + 3}`,
      moreInfo: `תשלום ${payment + 3} מתוך 10`,
    });
    return payment === 1 ? [plan, decoy, legacyOnly] : [plan, legacyOnly];
  });
  if (payment !== 1) {
    delete capture.responses.details;
  }
  return capture;
}

function extract(capture: IsracardCapture) {
  const accountKey = isracardCardKey(capture.card);
  return extractIsracard(serializeIsracardCapture(capture), {
    accountKey,
    runId: "synthetic-installment-run",
    scope: {
      kind: capture.mode,
      month: capture.billingMonth,
      cardKey: accountKey,
    },
  });
}

const card = isracardCardKey({ companyCode: "11", cardSuffix: "1234" });
const planKey = `isracard:posted:purchase:${JSON.stringify([card, "4242", "2040-03-15"])}`;
const legacyPlanKey = `isracard:posted:purchase:${JSON.stringify([card, "31337", "2039-11-20"])}`;
/** The per-payment key every Isracard row has had: card, purchase date, voucher. */
const paymentKey = (date: string, voucher: string) =>
  `isracard:posted:${JSON.stringify([card, date, voucher])}`;

async function withDatabase(
  run: (
    db: Database,
    ingest: (capture: IsracardCapture) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const db = await openDatabase(":memory:");
  let index = 0;
  const ingest = async (capture: IsracardCapture) => {
    const accountKey = isracardCardKey(capture.card);
    index++;
    await db.ingestRun(
      {
        connectionId: "synthetic-isracard",
        runId: `synthetic-installments-${index}`,
        responses: [
          {
            accountKey,
            endpoint: "isracard:card-month",
            capturedAt: `2040-08-${String(index).padStart(2, "0")}T00:00:00.000Z`,
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
  };
  try {
    await db.ensureConnection({
      id: "synthetic-isracard",
      provider: "isracard",
    });
    await run(db, ingest);
  } finally {
    await db.close();
  }
}

describe("Isracard installment plans", () => {
  it("emits the fixture's payments as billed lines of one plan purchase each and keeps the decoy ordinary", () => {
    const result = extract(fixture());
    expect(result.warnings).toEqual([]);
    const byKey = new Map(
      result.transactions.map((row) => [row.sourceKey, row]),
    );
    expect(byKey.get(paymentKey("2040-03-15", "700000101"))).toMatchObject({
      kind: "purchase",
      amountMinor: -3400,
      currency: "ILS",
      amountBasis: "booked_entry",
      installmentNumber: 1,
      installmentCount: 3,
      purchaseKey: planKey,
      transactionDate: "2040-03-15",
      identityStrength: "native",
    });
    expect(byKey.get(planKey)).toMatchObject({
      kind: "purchase",
      // The stated total, never a multiple or sum of payments.
      amountMinor: -10000,
      currency: "ILS",
      amountBasis: "purchase_commitment",
      installmentCount: 3,
      transactionDate: "2040-03-15",
      billingDate: null,
      identityStrength: "native",
      merchantName: "Synthetic installment shop",
    });
    expect(byKey.get(planKey)!.installmentNumber ?? null).toBeNull();
    expect(byKey.get(planKey)!.purchaseKey ?? null).toBeNull();
    for (const key of [planKey, paymentKey("2040-03-15", "700000101")]) {
      expect(byKey.get(key)!.details.issues).not.toContain(
        "unverified_installment_amount_basis",
      );
      expect(byKey.get(key)!.details.issues).not.toContain(
        "unverified_amount_basis",
      );
      expect(byKey.get(key)!.details.transactionDateTime).toBeNull();
    }
    // The legacy-only plan uses its moreInfo text, dealSum and paymentSum.
    expect(byKey.get(paymentKey("2039-11-20", "700000304"))).toMatchObject({
      kind: "purchase",
      amountMinor: -9000,
      amountBasis: "booked_entry",
      installmentNumber: 4,
      installmentCount: 10,
      purchaseKey: legacyPlanKey,
    });
    expect(byKey.get(legacyPlanKey)).toMatchObject({
      amountMinor: -100000,
      amountBasis: "purchase_commitment",
      installmentCount: 10,
      providerTransactionCode: null,
    });
    // The decoy shares plan voucher 4242 on another purchase date.
    const decoy = byKey.get(paymentKey("2040-03-02", "700000201"))!;
    // An ordinary same-currency charge: its own purchase commitment.
    expect(decoy).toMatchObject({
      amountMinor: -2500,
      amountBasis: "purchase_commitment",
      installmentCount: null,
    });
    expect(decoy.purchaseKey ?? null).toBeNull();
    expect(result.transactions).toHaveLength(5);
  });

  it("creates exactly one purchase and one line per payment across months and generations, counted once per perspective", async () => {
    await withDatabase(async (db, ingest) => {
      await ingest(planMonth(1));
      await ingest(planMonth(2));
      // A legacy-only month of the same plan: padded voucher, legacy text.
      const third = planMonth(3);
      delete third.responses.digital;
      await ingest(third);
      const rows = await db.listTransactions();
      const purchases = rows.filter((row) =>
        row.sourceKey.includes(":purchase:"),
      );
      expect(purchases.map((row) => row.sourceKey).sort()).toEqual(
        [planKey, legacyPlanKey].sort(),
      );
      const purchase = purchases.find((row) => row.sourceKey === planKey)!;
      expect(purchase).toMatchObject({
        amountMinor: -10000,
        installmentCount: 3,
        installmentNumber: null,
        purchaseId: null,
      });
      const lines = rows
        .filter((row) => row.purchaseId === purchase.id)
        .sort(
          (left, right) => left.installmentNumber! - right.installmentNumber!,
        );
      expect(
        lines.map((row) => [
          row.sourceKey,
          row.installmentNumber,
          row.installmentCount,
          row.amountMinor,
          row.amountBasis,
        ]),
      ).toEqual([
        [paymentKey("2040-03-15", "700000101"), 1, 3, -3400, "booked_entry"],
        [paymentKey("2040-03-15", "700000102"), 2, 3, -3300, "booked_entry"],
        [paymentKey("2040-03-15", "700000103"), 3, 3, -3300, "booked_entry"],
      ]);
      const legacyPurchase = purchases.find(
        (row) => row.sourceKey === legacyPlanKey,
      )!;
      expect(
        rows
          .filter((row) => row.purchaseId === legacyPurchase.id)
          .map((row) => row.installmentNumber)
          .sort(),
      ).toEqual([4, 5, 6]);
      expect(rows).toHaveLength(2 + 6 + 1);

      const ids = (perspective: "spending" | "billing") =>
        db
          .listTransactions({ perspective })
          .then((items) => items.map((row) => row.id).sort());
      expect(await ids("spending")).toEqual(
        rows
          .filter((row) => row.purchaseId === null)
          .map((row) => row.id)
          .sort(),
      );
      expect(await ids("billing")).toEqual(
        rows
          .filter((row) => !row.sourceKey.includes(":purchase:"))
          .map((row) => row.id)
          .sort(),
      );
      // Spending counts each plan once at its stated total; billing counts
      // each payment once. The 25.00 decoy is an ordinary charge in both.
      expect(await db.getTotals({ perspective: "spending" })).toMatchObject({
        totals: [
          {
            currency: "ILS",
            amountBasis: "purchase_commitment",
            amountMinor: -112500,
          },
        ],
        includedCount: 3,
        excludedCount: 0,
      });
      expect(await db.getTotals({ perspective: "billing" })).toMatchObject({
        totals: [{ currency: "ILS", amountBasis: null, amountMinor: -39500 }],
        includedCount: 7,
        excludedCount: 0,
      });
    });
  });

  it("takes a mid-plan purchase total as stated, never from the observed payments", () => {
    const capture = planMonth(4);
    delete capture.responses.digital;
    updateLegacy(capture, (rows) => rows.slice(1));
    const result = extract(capture);
    expect(result.transactions).toHaveLength(2);
    const [line, purchase] = result.transactions as [
      (typeof result.transactions)[number],
      (typeof result.transactions)[number],
    ];
    expect(line).toMatchObject({
      installmentNumber: 7,
      installmentCount: 10,
      amountMinor: -9000,
      purchaseKey: legacyPlanKey,
    });
    // Seven times 90.00 or the one observed payment would both be wrong.
    expect(purchase).toMatchObject({
      sourceKey: legacyPlanKey,
      amountMinor: -100000,
      installmentCount: 10,
    });
  });

  it("leaves a plan total unknown when its payments or generations state different totals", () => {
    const sameCapture = fixture();
    updateDigital(sameCapture, (rows) => {
      rows.push({
        ...rows[0],
        seqVoucherNumber: "700000102",
        billingAmount: 33,
        currentInstallmentNum: 2,
        moreInfo: " תשלום 2 מ 3 ",
        originalAmount: 101,
      });
    });
    let result = extract(sameCapture);
    let purchase = result.transactions.find(
      (row) => row.sourceKey === planKey,
    )!;
    expect(purchase).toMatchObject({
      amountMinor: null,
      currency: null,
      amountBasis: "purchase_commitment",
      installmentCount: 3,
    });
    expect(purchase.details.issues).toContain("conflicting_installment_total");
    // The plan is not split, and both payments stay its lines.
    expect(
      result.transactions.filter((row) => row.purchaseKey === planKey),
    ).toHaveLength(2);
    expect(
      result.transactions.filter((row) => row.sourceKey.includes("purchase:")),
    ).toHaveLength(2);

    const generations = fixture();
    updateLegacy(generations, (rows) => {
      rows[0]!.dealSum = "100.01";
    });
    result = extract(generations);
    purchase = result.transactions.find((row) => row.sourceKey === planKey)!;
    expect(purchase.amountMinor).toBeNull();
    expect(purchase.details.issues).toContain("conflicting_installment_total");

    const unreadable = fixture();
    updateDigital(unreadable, (rows) => {
      rows[0]!.originalAmount = "about 100";
    });
    purchase = extract(unreadable).transactions.find(
      (row) => row.sourceKey === planKey,
    )!;
    expect(purchase.amountMinor).toBeNull();
    expect(purchase.details.issues).toContain("unresolved_amount");
    expect(purchase.details.provider.isracard).toMatchObject({
      monetaryEvidence: { statedTotals: [null, ["ILS", 10000]] },
    });

    const counts = fixture();
    updateDigital(counts, (rows) => {
      rows.push({
        ...rows[0],
        seqVoucherNumber: "700000102",
        currentInstallmentNum: 2,
        numberOfInstallment: 4,
        moreInfo: " תשלום 2 מ 4 ",
      });
    });
    purchase = extract(counts).transactions.find(
      (row) => row.sourceKey === planKey,
    )!;
    // A differing plan fact flags the purchase; it still counts through lines.
    expect(purchase.details.issues).toContain("conflicting_installment_facts");
    expect(purchase.installmentCount).toBe(3);

    for (const merchant of [
      { businessName: "Synthetic other shop" },
      { businessNumber: 7000002 },
    ]) {
      const payments = fixture();
      updateDigital(payments, (rows) => {
        rows.push({
          ...rows[0],
          seqVoucherNumber: "700000102",
          currentInstallmentNum: 2,
          moreInfo: " תשלום 2 מ 3 ",
          ...merchant,
        });
      });
      purchase = extract(payments).transactions.find(
        (row) => row.sourceKey === planKey,
      )!;
      expect(purchase.details.issues, JSON.stringify(merchant)).toContain(
        "conflicting_installment_facts",
      );
      expect(purchase.amountMinor).toBe(-10000);
    }
  });

  it("leaves a plan total unknown when equal numeric totals name different currencies", () => {
    const capture = fixture();
    updateDigital(capture, (rows) => {
      rows.push({
        ...rows[0],
        seqVoucherNumber: "700000102",
        currentInstallmentNum: 2,
        moreInfo: " תשלום 2 מ 3 ",
        originalCurrencyIso: "USD",
      });
    });
    const result = extract(capture);
    const purchase = result.transactions.find(
      (row) => row.sourceKey === planKey,
    )!;
    expect(purchase).toMatchObject({ amountMinor: null, currency: null });
    expect(purchase.details.issues).toContain("conflicting_installment_total");
    expect(purchase.details.provider.isracard).toMatchObject({
      monetaryEvidence: {
        statedTotals: [
          ["ILS", 10000],
          ["ILS", 10000],
          ["USD", 10000],
        ],
      },
    });
    expect(
      result.transactions.find(
        (row) => row.sourceKey === paymentKey("2040-03-15", "700000102"),
      )?.details.issues,
    ).toContain("unverified_converted_installments");
  });

  it.each([
    [
      "DigitalV3 numbers against its own text",
      (capture: IsracardCapture) =>
        updateDigital(capture, (rows) => {
          rows[0]!.moreInfo = " תשלום 2 מ 3 ";
        }),
    ],
    [
      "the legacy text",
      (capture: IsracardCapture) =>
        updateLegacy(capture, (rows) => {
          rows[0]!.moreInfo = "תשלום 1 מתוך 4";
        }),
    ],
    [
      "the bound detail",
      (capture: IsracardCapture) => {
        const detail = capture.responses.details![0]!;
        detail.responseText = detail.responseText.replace(
          '"paymentNumber": "1"',
          '"paymentNumber": "2"',
        );
      },
    ],
    [
      "the final-payment flag",
      (capture: IsracardCapture) =>
        updateDigital(capture, (rows) => {
          rows[0]!.isLastInstallment = true;
        }),
    ],
    [
      "an unreadable installment text",
      (capture: IsracardCapture) =>
        updateLegacy(capture, (rows) => {
          rows[0]!.moreInfo = "תשלום ראשון מתוך 3";
        }),
    ],
    [
      "an ordinal above the count",
      (capture: IsracardCapture) => {
        updateDigital(capture, (rows) => {
          Object.assign(rows[0]!, {
            currentInstallmentNum: 4,
            moreInfo: " תשלום 4 מ 3 ",
          });
        });
        updateLegacy(capture, (rows) => {
          rows[0]!.moreInfo = "תשלום 4 מתוך 3";
        });
        delete capture.responses.details;
      },
    ],
    [
      "a malformed DigitalV3 ordinal",
      (capture: IsracardCapture) =>
        updateDigital(capture, (rows) => {
          rows[0]!.currentInstallmentNum = "1 ";
        }),
    ],
  ])(
    "keeps a payment unresolved and creates no purchase when ordinals conflict: %s",
    (_name, change) => {
      const capture = fixture();
      change(capture);
      const result = extract(capture);
      const payment = result.transactions.find(
        (row) => row.sourceKey === paymentKey("2040-03-15", "700000101"),
      )!;
      expect(payment).toMatchObject({
        amountMinor: null,
        currency: null,
        amountBasis: "unknown",
        installmentCount: null,
      });
      expect(payment.installmentNumber ?? null).toBeNull();
      expect(payment.purchaseKey ?? null).toBeNull();
      expect(payment.details.issues).toEqual(
        expect.arrayContaining([
          "invalid_installment_ordinal",
          "unverified_installment_amount_basis",
        ]),
      );
      expect(result.transactions.some((row) => row.sourceKey === planKey)).toBe(
        false,
      );
    },
  );

  it("joins a padded legacy plan voucher to the DigitalV3 number but reviews non-digit or different vouchers", () => {
    // Padding alone never splits a plan: months 1 (both), 2 (DigitalV3 only)
    // and 3 (legacy only) name one purchase.
    const second = planMonth(2);
    delete second.responses.legacy;
    const third = planMonth(3);
    delete third.responses.digital;
    for (const capture of [planMonth(1), second, third]) {
      expect(
        extract(capture).transactions.filter(
          (row) => row.sourceKey === planKey,
        ),
      ).toHaveLength(1);
    }
    expect(digitalRows(fixture())[0]!.voucherNumber).toBe(4242);

    for (const [digital, legacy] of [
      [4242, "0004243"],
      ["42A2", "00042A2"],
      [4242, "4242 "],
      [0, "0000000"],
    ] as const) {
      const capture = fixture();
      updateDigital(capture, (rows) => {
        rows[0]!.voucherNumber = digital;
      });
      updateLegacy(capture, (rows) => {
        rows[0]!.voucherNumber = legacy;
      });
      const result = extract(capture);
      const payment = result.transactions.find(
        (row) => row.sourceKey === paymentKey("2040-03-15", "700000101"),
      )!;
      expect(payment).toMatchObject({
        amountMinor: null,
        installmentCount: null,
      });
      expect(payment.purchaseKey ?? null).toBeNull();
      expect(payment.details.issues).toEqual(
        expect.arrayContaining([
          "invalid_installment_plan_voucher",
          "unverified_installment_amount_basis",
        ]),
      );
      expect(
        result.transactions.some((row) => row.sourceKey.includes("purchase:")),
      ).toBe(true);
      expect(result.transactions.some((row) => row.sourceKey === planKey)).toBe(
        false,
      );
    }
  });

  it("keeps an unrelated row with the same plan voucher and another purchase date separate", async () => {
    await withDatabase(async (db, ingest) => {
      await ingest(planMonth(1));
      const rows = await db.listTransactions();
      const decoy = rows.find(
        (row) => row.sourceKey === paymentKey("2040-03-02", "700000201"),
      )!;
      expect(decoy).toMatchObject({
        purchaseId: null,
        installmentCount: null,
        installmentNumber: null,
        amountBasis: "purchase_commitment",
      });
      // A decoy that is itself a plan payment forms a plan of its own date.
      const capture = planMonth(1);
      updateDigital(capture, (items) => {
        Object.assign(items[1]!, {
          transactionCode: 3,
          numberOfInstallment: 2,
          currentInstallmentNum: 1,
          isLastInstallment: false,
          moreInfo: " תשלום 1 מ 2 ",
          originalAmount: 50,
        });
      });
      updateLegacy(capture, (items) => {
        Object.assign(items[1]!, {
          moreInfo: "תשלום 1 מתוך 2",
          dealSum: "50.00",
        });
      });
      const result = extract(capture);
      expect(
        result.transactions
          .filter((row) => row.sourceKey.includes(":purchase:"))
          .map((row) => [row.sourceKey, row.amountMinor]),
      ).toEqual([
        [planKey, -10000],
        [
          `isracard:posted:purchase:${JSON.stringify([card, "4242", "2040-03-02"])}`,
          -5000,
        ],
        [legacyPlanKey, -100000],
      ]);
    });
  });

  it("keeps foreign, converted, non-plan-code and non-positive payments unresolved", () => {
    const cases: [string, (capture: IsracardCapture) => void, string[]][] = [
      [
        "a converted plan",
        (capture) =>
          updateDigital(capture, (rows) => {
            rows[0]!.originalCurrencyIso = "USD";
          }),
        ["unverified_converted_installments"],
      ],
      [
        "an unknown legacy total currency",
        (capture) =>
          updateLegacy(capture, (rows) => {
            delete rows[0]!.kodMatbeaMekori;
          }),
        [],
      ],
      [
        "a foreign-acquired row",
        (capture) =>
          updateDigital(capture, (rows) => {
            rows[0]!.isIsraelDeal = false;
          }),
        [],
      ],
      [
        "another transaction code",
        (capture) =>
          updateDigital(capture, (rows) => {
            rows[0]!.transactionCode = 1;
          }),
        [],
      ],
      [
        "a negative payment",
        (capture) => {
          updateDigital(capture, (rows) => {
            rows[0]!.billingAmount = -34;
          });
          updateLegacy(capture, (rows) => {
            rows[0]!.paymentSum = "-34.00";
          });
        },
        ["unsupported_amount_direction"],
      ],
    ];
    for (const [name, change, issues] of cases) {
      const capture = fixture();
      change(capture);
      const result = extract(capture);
      const payment = result.transactions.find(
        (row) => row.sourceKey === paymentKey("2040-03-15", "700000101"),
      )!;
      expect(payment, name).toMatchObject({
        amountMinor: null,
        amountBasis: "unknown",
        installmentCount: null,
      });
      expect(payment.purchaseKey ?? null, name).toBeNull();
      expect(payment.details.issues, name).toEqual(
        expect.arrayContaining([
          "unverified_installment_amount_basis",
          ...issues,
        ]),
      );
      expect(
        result.transactions.some((row) => row.sourceKey === planKey),
        name,
      ).toBe(false);
    }
  });

  it("keeps money on ordinary DigitalV3 rows whose prose names a payment", () => {
    for (const [moreInfo, count] of [
      ["תשלום מנוי חודשי", null],
      [" תשלום 1 מ 1 ", 1],
    ] as const) {
      const capture = fixture();
      updateDigital(capture, (rows) => {
        Object.assign(rows[1]!, {
          moreInfo,
          numberOfInstallment: count,
          currentInstallmentNum: count,
        });
      });
      const decoy = extract(capture).transactions.find(
        (row) => row.sourceKey === paymentKey("2040-03-02", "700000201"),
      )!;
      expect(decoy, moreInfo).toMatchObject({
        amountMinor: -2500,
        currency: "ILS",
        installmentCount: count,
      });
      expect(decoy.details.issues, moreInfo).not.toContain(
        "unverified_installment_amount_basis",
      );
    }
  });

  it("proves a plan from the bound detail's numbers alone", () => {
    const capture = fixture();
    updateDigital(capture, (rows) => {
      Object.assign(rows[0]!, {
        numberOfInstallment: null,
        currentInstallmentNum: null,
        isLastInstallment: null,
        moreInfo: "",
      });
    });
    updateLegacy(capture, (rows) => {
      rows[0]!.moreInfo = null;
    });
    const result = extract(capture);
    expect(
      result.transactions.find(
        (row) => row.sourceKey === paymentKey("2040-03-15", "700000101"),
      ),
    ).toMatchObject({
      amountMinor: -3400,
      installmentNumber: 1,
      installmentCount: 3,
      purchaseKey: planKey,
    });
    expect(
      result.transactions.find((row) => row.sourceKey === planKey)?.amountMinor,
    ).toBe(-10000);
  });

  it("builds plans on a DigitalV3-only co-branded card", () => {
    const capture = fixture();
    capture.card.companyCode = "77";
    capture.responses.cardList = capture.responses.cardList.replace(
      '"companyCode": "11"',
      '"companyCode": "77"',
    );
    delete capture.responses.legacy;
    delete capture.legacyCardIndex;
    delete capture.responses.details;
    const result = extract(capture);
    const card77 = isracardCardKey({ companyCode: "77", cardSuffix: "1234" });
    expect(result.partitions).toEqual([
      expect.objectContaining({ success: true }),
    ]);
    expect(
      result.transactions.find(
        (row) =>
          row.sourceKey ===
          `isracard:posted:purchase:${JSON.stringify([card77, "4242", "2040-03-15"])}`,
      ),
    ).toMatchObject({ amountMinor: -10000, installmentCount: 3 });
  });

  it("never bills one ordinal twice when two payment vouchers state it", () => {
    const capture = fixture();
    updateDigital(capture, (rows) => {
      rows.push({ ...rows[0], seqVoucherNumber: "700000109" });
    });
    const result = extract(capture);
    const lines = result.transactions.filter(
      (row) => row.purchaseKey === planKey,
    );
    expect(lines.map((row) => row.sourceKey).sort()).toEqual(
      [
        paymentKey("2040-03-15", "700000101"),
        paymentKey("2040-03-15", "700000109"),
      ].sort(),
    );
    for (const line of lines) {
      expect(line).toMatchObject({ amountMinor: null, installmentNumber: 1 });
      expect(line.details.issues).toContain("duplicate_installment_ordinal");
    }
    const purchase = result.transactions.find(
      (row) => row.sourceKey === planKey,
    )!;
    expect(purchase.amountMinor).toBe(-10000);
    expect(purchase.details.issues).toContain("conflicting_installment_facts");
  });

  it("keeps a duplicate ordinal held across captures until the owner removes one line", async () => {
    // Voucher B restates ordinal 1 of the 4242 plan under another voucher.
    const withB = (keepA: boolean) => {
      const capture = fixture();
      updateDigital(capture, (rows) => {
        const b = { ...rows[0], seqVoucherNumber: "700000109" };
        return keepA ? [...rows, b] : [b, rows[1]!];
      });
      updateLegacy(capture, (rows) => (keepA ? rows : rows.slice(1)));
      if (!keepA) {
        delete capture.responses.details;
      }
      return capture;
    };
    const lineAmounts = async (db: Database) => {
      const rows = await db.listTransactions();
      const purchase = rows.find((row) => row.sourceKey === planKey)!;
      return rows
        .filter((row) => row.purchaseId === purchase.id)
        .map((row) => [row.sourceKey, row.amountMinor, row.details.issues])
        .sort();
    };
    const held = (voucher: string) => [
      paymentKey("2040-03-15", voucher),
      null,
      expect.arrayContaining(["duplicate_installment_ordinal"]),
    ];
    const ordinalOneBilled = async (db: Database) =>
      (await db.getTotals({ perspective: "billing" })).totals[0]!.amountMinor;

    // Seen together, then each alone: neither regains its amount.
    await withDatabase(async (db, ingest) => {
      await ingest(withB(true));
      await ingest(fixture());
      await ingest(withB(false));
      expect(await lineAmounts(db)).toEqual([
        held("700000101"),
        held("700000109"),
      ]);
      // Only the legacy-only plan's line and the decoy are billed.
      expect(await ordinalOneBilled(db)).toBe(-11500);
      const events = await db.listEvents({});
      await ingest(fixture());
      await ingest(withB(false));
      expect(
        (await db.listEvents({ after: events.at(-1)!.id })).filter((event) =>
          event.type.startsWith("transaction."),
        ),
      ).toEqual([]);
    });
    // Never seen together: the earlier line is held once the later arrives,
    // and the owner's removal of one releases the other on its next read.
    await withDatabase(async (db, ingest) => {
      await ingest(fixture());
      await ingest(withB(false));
      expect(await lineAmounts(db)).toEqual([
        held("700000101"),
        held("700000109"),
      ]);
      expect(await ordinalOneBilled(db)).toBe(-11500);
      const b = (await db.listTransactions()).find(
        (row) => row.sourceKey === paymentKey("2040-03-15", "700000109"),
      )!;
      await db.confirmRemoval({
        transactionId: b.id,
        expectedVersion: b.version,
        reason: "Synthetic duplicate payment",
      });
      await ingest(fixture());
      const a = (await db.listTransactions()).find(
        (row) => row.sourceKey === paymentKey("2040-03-15", "700000101"),
      )!;
      expect(a.amountMinor).toBe(-3400);
      expect(a.details.issues).not.toContain("duplicate_installment_ordinal");
    });
  });

  it("counts every installment naming the plan toward its total, even an unresolved one", () => {
    for (const change of [
      // A stated total of 101 on an unresolved payment of the same plan.
      (rows: Row[]) => {
        rows.push({
          ...rows[0],
          seqVoucherNumber: "700000102",
          currentInstallmentNum: 2,
          moreInfo: " תשלום 3 מ 3 ",
          originalAmount: 101,
        });
      },
      // A different planned count on an unresolved payment of the same plan.
      (rows: Row[]) => {
        rows.push({
          ...rows[0],
          seqVoucherNumber: "700000102",
          currentInstallmentNum: 2,
          numberOfInstallment: 4,
          moreInfo: " תשלום 3 מ 4 ",
        });
      },
      // A readable planned count beside a malformed ordinal.
      (rows: Row[]) => {
        rows.push({
          ...rows[0],
          seqVoucherNumber: "700000102",
          currentInstallmentNum: "unknown",
          numberOfInstallment: 4,
          moreInfo: "",
        });
      },
    ]) {
      const capture = fixture();
      updateDigital(capture, change);
      const result = extract(capture);
      const unresolved = result.transactions.find(
        (row) => row.sourceKey === paymentKey("2040-03-15", "700000102"),
      )!;
      expect(unresolved.purchaseKey ?? null).toBeNull();
      expect(unresolved.details.issues).toContain(
        "invalid_installment_ordinal",
      );
      const purchase = result.transactions.find(
        (row) => row.sourceKey === planKey,
      )!;
      if (purchase.amountMinor === null) {
        expect(purchase.details.issues).toContain(
          "conflicting_installment_total",
        );
      } else {
        expect(purchase.details.issues).toContain(
          "conflicting_installment_facts",
        );
      }
    }
    const total = fixture();
    updateDigital(total, (rows) => {
      rows.push({
        ...rows[0],
        seqVoucherNumber: "700000102",
        currentInstallmentNum: 2,
        moreInfo: " תשלום 3 מ 3 ",
        originalAmount: 101,
      });
    });
    const purchase = extract(total).transactions.find(
      (row) => row.sourceKey === planKey,
    )!;
    expect(purchase.amountMinor).toBeNull();
    expect(purchase.details.provider.isracard).toMatchObject({
      monetaryEvidence: {
        statedTotals: [
          ["ILS", 10000],
          ["ILS", 10000],
          ["ILS", 10100],
        ],
      },
    });
    expect(purchase.details.sourceRefs.map(({ path }) => path)).toEqual([
      "$.responses.digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[0]",
      "$.responses.legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0].txnIsrael[0]",
      "$.responses.digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[2]",
    ]);
    expect(purchase.details.provider.isracard!.rows).toHaveLength(2);
    const count = fixture();
    updateDigital(count, (rows) => {
      rows.push({
        ...rows[0],
        seqVoucherNumber: "700000102",
        currentInstallmentNum: "unknown",
        numberOfInstallment: 4,
        moreInfo: "",
      });
    });
    const counted = extract(count).transactions.find(
      (row) => row.sourceKey === planKey,
    )!;
    expect(counted.amountMinor).toBe(-10000);
    expect(counted.details.issues).toContain("conflicting_installment_facts");
  });

  it.each([
    ["on one purchase date", "2040-03-15"],
    ["on different purchase dates", "2040-03-16"],
  ])(
    "counts no purchase confidently when one payment's occurrences name different plans %s",
    async (_name, otherDate) => {
      const capture = fixture();
      if (otherDate === "2040-03-15") {
        updateDigital(capture, (rows) => {
          rows.push({ ...rows[0], voucherNumber: 4243, originalAmount: 101 });
        });
      }
      updateLegacy(capture, (rows) => {
        rows[0]!.voucherNumber = "0004243";
        rows[0]!.dealSum = "101.00";
        rows[0]!.fullPurchaseDate = otherDate.split("-").reverse().join("/");
      });
      const result = extract(capture);
      const purchases = result.transactions.filter(
        (row) =>
          row.sourceKey.includes(":purchase:") &&
          row.sourceKey !== legacyPlanKey,
      );
      expect(purchases.map((row) => row.sourceKey).sort()).toEqual(
        [
          planKey,
          `isracard:posted:purchase:${JSON.stringify([card, "4243", otherDate])}`,
        ].sort(),
      );
      for (const purchase of purchases) {
        expect(purchase.amountMinor).toBeNull();
        expect(purchase.details.issues).toContain(
          "invalid_installment_plan_voucher",
        );
      }
      await withDatabase(async (db, ingest) => {
        await ingest(capture);
        // Only the legacy-only plan and the decoy count.
        expect(await db.getTotals({ perspective: "spending" })).toMatchObject({
          totals: [{ amountMinor: -102500 }],
        });
      });
    },
  );

  it("keeps duplicate payment vouchers as ambiguous lines of the one plan, outside totals", async () => {
    await withDatabase(async (db, ingest) => {
      const capture = fixture();
      updateDigital(capture, (rows) => {
        rows.push({ ...rows[0] });
      });
      await ingest(capture);
      const rows = await db.listTransactions();
      const purchase = rows.find((row) => row.sourceKey === planKey)!;
      expect(purchase.amountMinor).toBe(-10000);
      const lines = rows.filter((row) => row.purchaseId === purchase.id);
      expect(lines).toHaveLength(3);
      expect(
        lines.every(
          (row) =>
            row.identityStrength === "ambiguous" &&
            row.amountMinor === null &&
            row.installmentNumber === 1,
        ),
      ).toBe(true);
      expect(await db.getTotals({ perspective: "billing" })).toMatchObject({
        totals: [{ currency: "ILS", amountMinor: -11500 }],
        includedCount: 2,
      });
    });
  });

  it("replays identical captures quietly", async () => {
    await withDatabase(async (db, ingest) => {
      const months = [planMonth(1), planMonth(2), planMonth(3)];
      for (const capture of months) {
        await ingest(capture);
      }
      const before = await db.listTransactions();
      const events = await db.listEvents({});
      for (const capture of months) {
        await ingest(capture);
      }
      expect(
        (await db.listEvents({ after: events.at(-1)!.id })).filter((event) =>
          event.type.startsWith("transaction."),
        ),
      ).toEqual([]);
      const after = await db.listTransactions();
      expect(
        after.map((row) => [row.id, row.version, row.purchaseId]).sort(),
      ).toEqual(
        before.map((row) => [row.id, row.version, row.purchaseId]).sort(),
      );
    });
  });

  it("turns an existing unresolved payment row into a line without moving its annotation", async () => {
    await withDatabase(async (db, ingest) => {
      // An unreadable text keeps the payment one unresolved row, the form a
      // stored row has before its plan is proven.
      const unresolved = fixture();
      updateLegacy(unresolved, (rows) => {
        rows[0]!.moreInfo = "תשלום ראשון מתוך 3";
      });
      await ingest(unresolved);
      const original = (await db.listTransactions()).find(
        (row) => row.sourceKey === paymentKey("2040-03-15", "700000101"),
      )!;
      expect(original).toMatchObject({
        amountMinor: null,
        purchaseId: null,
        installmentNumber: null,
      });
      await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Synthetic installment note",
      });
      await ingest(fixture());
      const line = (await db.getTransaction(original.id))!;
      const purchase = (await db.listTransactions()).find(
        (row) => row.sourceKey === planKey,
      )!;
      expect(line).toMatchObject({
        sourceKey: original.sourceKey,
        purchaseId: purchase.id,
        installmentNumber: 1,
        installmentCount: 3,
        amountMinor: -3400,
        amountBasis: "booked_entry",
      });
      expect(line.version).toBe(original.version + 1);
      expect(line.annotation?.data.notes).toBe("Synthetic installment note");
      await ingest(planMonth(2));
      expect(
        (await db.getTransaction(original.id))?.annotation?.data.notes,
      ).toBe("Synthetic installment note");
    });
  });
});
