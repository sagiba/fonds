import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  parsedLedgerFacts,
  storedPaymentContext,
  transactionInputSchema,
} from "../../../src/domain/model.js";
import { calAdapter } from "../../../src/providers/cal/adapter.js";
import { extractCal } from "../../../src/providers/cal/extract.js";
import { retained } from "../../helpers/provider-evidence.js";

type SyntheticRow = Record<string, unknown>;

interface SyntheticResponse {
  result: { transactions: SyntheticRow[]; clearanceRequests: SyntheticRow[] };
}

interface GoldenProjection {
  source_identity: { card_key: string; native_id: string };
  status: string;
  amount_basis: string;
  kind: string;
  amount_minor: number | null;
  currency: string | null;
  original_amount_minor: number | null;
  original_currency: string | null;
  booking_date: string | null;
}

const context = { accountKey: "SYNTHETIC-CAL-ACCOUNT", runId: "synthetic-run" };
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
const baseline = (): SyntheticResponse => JSON.parse(fixture("recent-01"));
/** Payment facts as the ledger stores them: an omitted fact (no evidence) is null. */
const extract = (response: unknown) => {
  const result = extractCal(JSON.stringify(response), context);
  return {
    ...result,
    transactions: result.transactions.map((row) => ({
      ...row,
      ...parsedLedgerFacts(row),
      ...storedPaymentContext(row, undefined),
    })),
  };
};
const onePosted = (): SyntheticResponse => {
  const response = baseline();
  response.result.transactions = [response.result.transactions[0]!];
  response.result.clearanceRequests = [];
  return response;
};

describe("CAL extraction", () => {
  it("preserves nonempty source rate, cash-account, discount and POS detail without inventing financial roles", () => {
    const source = JSON.parse(fixture("detail-rich")) as {
      result: { transArr: SyntheticRow[] };
    };
    const result = extractCal(fixture("detail-rich"), context);
    expect(result.transactions).toHaveLength(2);
    const [converted, discounted] = result.transactions;
    expect(converted).toMatchObject({
      amountMinor: -8125,
      currency: "ILS",
      originalAmountMinor: -2250,
      originalCurrency: "USD",
      amountBasis: "purchase_commitment",
      kind: "purchase",
    });
    expect(discounted).toMatchObject({
      amountMinor: -4620,
      currency: "ILS",
      originalAmountMinor: null,
      originalCurrency: null,
      kind: "purchase",
    });
    for (const [index, row] of result.transactions.entries()) {
      const original = source.result.transArr[index]!;
      const retained = row.details.provider.cal!.rows as SyntheticRow[];
      for (const key of [
        "forcedDebRate",
        "cashAccountAmt",
        "cashAccountCurrency",
        "discountAmount",
        "discountReason",
        "posEntryMod",
        "transSafeIndication",
        "srcCurrencyCode",
        "crmIccCurrencyDesc",
        "crdExtIdNumTypeCode",
        "comments",
        "immediateComments",
        "transTypeCommentDetails",
      ]) {
        expect(retained[0]![key]).toEqual(original[key]);
      }
      expect(row.details).not.toHaveProperty("exchangeRate");
      expect(row.details).not.toHaveProperty("fees");
      expect(row.wallet ?? null).toBeNull();
      expect(row.authorizationMethod ?? null).toBeNull();
      expect(transactionInputSchema.safeParse(row).success).toBe(true);
    }
    expect(converted!.details.provider.cal!.rows).toMatchObject([
      { cashAccountTrnAmt: "17.125", forcedDebRate: "1.234567890123456789" },
    ]);
    expect(converted!.details.merchant).toMatchObject({
      address: "17 Synthetic Street, Example City",
      phone: null,
    });
    expect(retained(converted!.details, "comments")).toContainEqual({
      key: "Synthetic source note",
      value: "<b>Invented source description</b>",
    });
    expect(discounted!.cardPresent).toBe(false);
    expect(discounted!.details.provider.cal!.rows).toMatchObject([
      {
        linkedComments: [
          {
            text: "Synthetic source link",
            linkDisplayName: "Synthetic detail",
            linkType: "7",
            link: "https://example.invalid/synthetic-details",
          },
        ],
        immediateComments: null,
      },
    ]);
  });

  it.each(["01", "02", "05", "1", "7", "S"])(
    "retains observed POS token %s verbatim without inferring a channel or card presence",
    (posEntryMod) => {
      const response = onePosted();
      Object.assign(response.result.transactions[0]!, {
        posEntryMod,
        transCardPresentInd: null,
      });
      const row = extract(response).transactions[0]!;
      expect(row).toMatchObject({
        cardPresent: null,
        wallet: null,
        authorizationMethod: null,
      });
      expect(row.details.provider.cal!.rows).toMatchObject([{ posEntryMod }]);
    },
  );

  it("retains an opaque pending indicator without changing authorization meaning", () => {
    const response = baseline();
    response.result.transactions = [];
    response.result.clearanceRequests = [
      {
        ...response.result.clearanceRequests[0],
        j5Indicator: "SYNTHETIC-UNINTERPRETED-INDICATOR",
      },
    ];
    const row = extract(response).transactions[0]!;
    expect(row).toMatchObject({
      status: "pending",
      amountBasis: "authorization",
      amountMinor: -5875,
      currency: "ILS",
    });
    expect(
      (row.details.provider.cal!.rows as SyntheticRow[])[0],
    ).toHaveProperty("j5Indicator", "SYNTHETIC-UNINTERPRETED-INDICATOR");
    expect(row).toMatchObject({ cardPresent: false, wallet: null });
  });

  it.each([
    "2040-06-11T12:30",
    "2040-06-11T12:30:01",
    "2040-06-11T12:30:01.1200",
    "2040-06-11T00:30:01+03:00",
    "2040-06-11T23:30:01-05:00",
    "2040-06-11T12:30:01Z",
  ])(
    "retains the exact source purchase time %s without timezone conversion",
    (timestamp) => {
      const response = onePosted();
      response.result.transactions[0]!.trnPurchaseDate = timestamp;
      const row = extract(response).transactions[0]!;
      expect(row.transactionDate).toBe("2040-06-11");
      expect(row.details.transactionDateTime).toBe(timestamp);
      expect(transactionInputSchema.safeParse(row).success).toBe(true);
    },
  );

  it("does not expose installment component time as the purchase time", () => {
    const response = baseline();
    response.result.transactions = response.result.transactions.filter(
      (row) => String(row.transactionTypeCode) === "8",
    );
    expect(response.result.transactions.length).toBeGreaterThan(0);
    const rows = extract(response).transactions.filter(
      (row) => row.status === "posted",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.details.transactionDateTime).toBeNull();
    }
    expect(rows.some((row) => row.installmentNumber != null)).toBe(true);
  });

  it.each([
    [3, "Apple Pay", true, "apple_pay", null],
    [3, "Apple Pay", false, "apple_pay", "online"],
    [32, "אינטרנט", false, null, "online"],
    [32, "אינטרנט", true, null, "online"],
    [0, "", false, null, null],
    [null, null, null, null, null],
    [999, "Apple Pay", false, null, null],
    [3, "אינטרנט", false, null, null],
    [32, "Apple Pay", false, null, "online"],
    [3, "Synthetic unknown wallet", false, null, null],
    [32, "Synthetic unknown channel", false, null, "online"],
    [32, "", false, null, "online"],
    [null, "אינטרנט", false, null, null],
  ])(
    "separates reviewed wallet/channel evidence %j/%j from card presence %j",
    (code, description, cardPresent, wallet, authorizationMethod) => {
      const response = onePosted();
      Object.assign(response.result.transactions[0]!, {
        walletProviderCode: code,
        walletProviderDesc: description,
        transCardPresentInd: cardPresent,
      });
      const row = extract(response).transactions[0]!;
      expect(row).toMatchObject({ cardPresent, wallet, authorizationMethod });
      expect(row.details.provider.cal!.rows).toEqual([
        expect.objectContaining({
          walletProviderCode: code === null ? null : String(code),
          walletProviderDesc: description,
          transCardPresentInd: cardPresent,
        }),
      ]);
      expect(transactionInputSchema.safeParse(row).success).toBe(true);
    },
  );

  it.each(["0123", "5411", 5411])(
    "projects reviewed four-digit source classification %s without duplicating the card party",
    (code) => {
      const response = onePosted();
      response.result.transactions[0]!.internationalBranchID = code;
      const row = extract(response).transactions[0]!;
      expect(row.merchantCategoryCode).toBe(String(code));
      expect(row.merchantName).toBe(
        response.result.transactions[0]!.merchantName,
      );
      expect(row.counterpartyName).toBeNull();
      expect(row.details.issues).not.toContain(
        "invalid_merchant_category_code",
      );
    },
  );

  it.each([
    "not-an-MCC",
    "123",
    "12345",
    "12A4",
    "１２３４",
    "5411\n",
    " 5411",
    541,
    {},
  ])(
    "retains invalid source classification %j only as evidence and flags its unresolved interpretation",
    (code) => {
      const response = onePosted();
      response.result.transactions[0]!.internationalBranchID = code;
      const row = extract(response).transactions[0]!;
      expect(row.merchantCategoryCode).toBeNull();
      expect(row.details.issues).toContain("invalid_merchant_category_code");
      expect(row.details.provider.cal!.rows).toEqual([
        expect.objectContaining({
          internationalBranchID: typeof code === "number" ? String(code) : code,
        }),
      ]);
      expect(transactionInputSchema.safeParse(row).success).toBe(true);
    },
  );

  it.each([null, undefined, "", "  ", "\t\n"])(
    "keeps absent source classification %s unknown without a malformed-value issue",
    (code) => {
      const response = onePosted();
      response.result.transactions[0]!.internationalBranchID = code;
      const row = extract(response).transactions[0]!;
      expect(row.merchantCategoryCode).toBeNull();
      expect(row.details.issues).not.toContain(
        "invalid_merchant_category_code",
      );
    },
  );

  it("matches every golden posted baseline projection with exact native and original money", () => {
    const result = extractCal(fixture("recent-01"), context);
    const scenarios = JSON.parse(fixture("scenarios")) as {
      expected_baseline_projection: GoldenProjection[];
    };
    expect(result.partitions).toEqual([
      {
        accountKey: context.accountKey,
        status: "posted",
        success: true,
        comparable: true,
      },
      {
        accountKey: context.accountKey,
        status: "pending",
        success: true,
        comparable: true,
      },
    ]);
    // Billed lines are additional rows; the golden projection covers purchases.
    expect(
      result.transactions.filter(
        (row) => row.status === "posted" && row.installmentNumber == null,
      ),
    ).toHaveLength(scenarios.expected_baseline_projection.length);
    for (const golden of scenarios.expected_baseline_projection) {
      const row = result.transactions.find(
        (row) =>
          row.sourceKey ===
          "cal:posted:purchase:" +
            JSON.stringify([
              golden.source_identity.card_key,
              golden.source_identity.native_id,
            ]),
      );
      expect(row).toMatchObject({
        cardKey: golden.source_identity.card_key,
        status: golden.status,
        amountBasis: golden.amount_basis,
        kind: golden.kind,
        amountMinor: golden.amount_minor,
        currency: golden.currency,
        originalAmountMinor: golden.original_amount_minor,
        originalCurrency: golden.original_currency,
        bookingDate: golden.booking_date,
      });
    }
    for (const row of result.transactions) {
      expect(transactionInputSchema.safeParse(row).success).toBe(true);
      expect(row.counterpartyName).toBeNull();
    }
  });

  it("creates one purchase and one billed line per payment, and treats legacy coverage as historical", () => {
    const result = extractCal(fixture("legacy-history"), context);
    const plan = result.transactions.filter((row) =>
      row.sourceKey.includes("LEGACY-INSTALLMENTS"),
    );
    const purchaseKey =
      "cal:posted:purchase:" +
      JSON.stringify(["SYNTHETIC-CARD-A", "SYNTHETIC-TXN-LEGACY-INSTALLMENTS"]);
    const [row, ...lines] = plan;
    expect(result.historical).toBe(true);
    expect(result.partitions).toEqual([
      {
        accountKey: context.accountKey,
        status: "posted",
        success: true,
        comparable: false,
      },
    ]);
    expect(row).toMatchObject({
      sourceKey: purchaseKey,
      amountMinor: -120000,
      amountBasis: "purchase_commitment",
      billingDate: null,
      installmentCount: 12,
    });
    expect(row!.installmentNumber).toBeUndefined();
    expect(row!.purchaseKey).toBeUndefined();
    expect(row!.details.provider.cal!.rows).toMatchObject([
      { curPaymentNum: "1" },
      { curPaymentNum: "2" },
      { curPaymentNum: "3" },
    ]);
    expect(row!.details.sourceRefs).toHaveLength(3);
    expect(
      lines.map((line) => ({
        sourceKey: line.sourceKey,
        purchaseKey: line.purchaseKey,
        identityStrength: line.identityStrength,
        status: line.status,
        kind: line.kind,
        amountBasis: line.amountBasis,
        amountMinor: line.amountMinor,
        currency: line.currency,
        originalAmountMinor: line.originalAmountMinor,
        transactionDate: line.transactionDate,
        billingDate: line.billingDate,
        installmentCount: line.installmentCount,
        installmentNumber: line.installmentNumber,
        merchantName: line.merchantName,
        merchantCategoryCode: line.merchantCategoryCode,
      })),
    ).toEqual(
      [1, 2, 3].map((number) => ({
        sourceKey:
          "cal:posted:line:" +
          JSON.stringify([
            "SYNTHETIC-CARD-A",
            "SYNTHETIC-TXN-LEGACY-INSTALLMENTS",
            number,
          ]),
        purchaseKey,
        identityStrength: "native",
        status: "posted",
        kind: "purchase",
        amountBasis: "booked_entry",
        amountMinor: -10000,
        currency: "ILS",
        originalAmountMinor: null,
        transactionDate: row!.transactionDate,
        billingDate: `2040-0${number + 1}-10`,
        installmentCount: 12,
        installmentNumber: number,
        merchantName: row!.merchantName,
        merchantCategoryCode: row!.merchantCategoryCode,
      })),
    );
    for (const line of lines) {
      expect(line.details.sourceRefs).toHaveLength(1);
      expect(transactionInputSchema.safeParse(line).success).toBe(true);
    }
    const cancellation = result.transactions.find((row) =>
      row.sourceKey.includes("TXN-CANCEL"),
    );
    expect(cancellation).toMatchObject({
      amountMinor: 52500,
      kind: "refund",
      installmentCount: null,
    });
    expect(cancellation!.installmentNumber).toBeUndefined();
  });

  it.each(["ביטול עסקה", "זיכוי", "ביטול תשלומים אחר"])(
    "keeps ordinary single-payment refund %s as one row with its billing date",
    (label) => {
      const response = onePosted();
      Object.assign(response.result.transactions[0]!, {
        trnType: label,
        refundInd: true,
        amountForDisplay: -86.4,
        transactionTypeCode: 5,
      });
      const row = extract(response).transactions[0]!;
      expect(row).toMatchObject({
        kind: "refund",
        amountMinor: 8640,
        billingDate: "2040-06-10",
      });
      expect(extract(response).transactions).toHaveLength(1);
      expect(row.installmentNumber).toBeNull();
    },
  );

  it("keeps purchase fields stable as the captured installment subset expands and shrinks", () => {
    const response = JSON.parse(fixture("legacy-history")) as {
      result: { transArr: SyntheticRow[] };
    };
    const components = response.result.transArr.filter((row) =>
      String(row.trnIntId).includes("LEGACY-INSTALLMENTS"),
    );
    const captures = [[components[0]!], components, [components[1]!]].map(
      (transArr) => extract({ ...response, result: { transArr } }).transactions,
    );
    for (const [purchase] of captures) {
      expect(purchase).toMatchObject({
        amountMinor: -120000,
        billingDate: null,
        installmentCount: 12,
      });
    }
    // A mid-plan window yields the same purchase plus only its own lines.
    expect(captures.map((rows) => rows.length - 1)).toEqual([1, 3, 1]);
    expect(captures[2]![1]).toMatchObject({
      installmentNumber: 2,
      billingDate: "2040-03-10",
    });
  });

  it("keeps grouped dates and ordinals order-independent and distinguishable from unobserved values", () => {
    const response = JSON.parse(fixture("legacy-history")) as {
      result: { transArr: SyntheticRow[] };
    };
    const observations = response.result.transArr.filter((row) =>
      String(row.trnIntId).includes("LEGACY-INSTALLMENTS"),
    );
    expect(observations).toHaveLength(3);
    const expectedComponents = observations.map((row) => ({
      installmentNumber: Number(row.curPaymentNum),
      billingDate: String(row.debCrdDate).slice(0, 10),
    }));
    for (const ordering of [
      observations,
      [...observations].reverse(),
      [...observations.slice(1), observations[0]!],
    ]) {
      const [grouped, ...lines] = extract({
        ...response,
        result: { transArr: ordering },
      }).transactions;
      expect(grouped).toMatchObject({
        billingDate: null,
        amountMinor: -120000,
      });
      expect(
        lines.map((line) => ({
          installmentNumber: line.installmentNumber,
          billingDate: line.billingDate,
        })),
      ).toEqual(expectedComponents);
    }
    const unobserved = extract({
      ...response,
      result: {
        transArr: [
          { ...observations[0]!, curPaymentNum: null, debCrdDate: null },
        ],
      },
    }).transactions;
    expect(unobserved).toHaveLength(1);
    expect(unobserved[0]).toMatchObject({ billingDate: null });
    expect(unobserved[0]!.installmentNumber).toBeNull();
  });

  it("preserves nested history labels and observations without changing parent amounts", () => {
    const before = extractCal(fixture("recent-01"), context).transactions.find(
      (row) => row.sourceKey.includes("TXN-HISTORY"),
    )!;
    const after = extractCal(fixture("recent-02"), context).transactions.find(
      (row) => row.sourceKey.includes("TXN-HISTORY"),
    )!;
    expect(before.amountMinor).toBe(-84000);
    expect(after.amountMinor).toBe(before.amountMinor);
    expect(retained(before.details, "paymentHistory")).toHaveLength(2);
    expect(retained(after.details, "paymentHistory")).toHaveLength(3);
    expect(retained(before.details, "paymentHistory")[0]).toMatchObject({
      num: "תשלום \u200e1\u200e מתוך \u200e4\u200e",
      amount: expect.any(String),
    });
    expect(before.installmentCount).toBeNull();
  });

  it("isolates malformed pending coverage while preserving valid posted data", () => {
    const result = extractCal(fixture("malformed-pending"), context);
    expect(result.transactions.some((row) => row.status === "posted")).toBe(
      true,
    );
    expect(
      result.partitions.find((partition) => partition.status === "posted")
        ?.success,
    ).toBe(true);
    expect(
      result.partitions.find((partition) => partition.status === "pending"),
    ).toMatchObject({ success: false, comparable: false });
  });

  it("never asserts success for a bad envelope or application failure", () => {
    for (const input of [
      "{",
      "{}",
      '{"statusCode":2,"result":{"transactions":[],"clearanceRequests":[]}}',
      '{"statusCode":"1","result":{"transactions":[],"clearanceRequests":[]}}',
    ]) {
      const result = extractCal(input, context);
      expect(result.transactions).toEqual([]);
      expect(result.partitions).toHaveLength(2);
      expect(
        result.partitions.every(
          (partition) => !partition.success && !partition.comparable,
        ),
      ).toBe(true);
    }
  });

  it.each([
    ["root", "hasMore", true],
    ["root", "totalPages", 2],
    ["root", "nextPage", 2],
    ["result", "nextCursor", "synthetic-cursor"],
    ["result", "nextPageToken", "synthetic-token"],
    ["result", "continuationToken", "synthetic-token"],
    ["result", "cursor", "synthetic-cursor"],
    ["result", "pagination", { page: 1 }],
  ] as const)(
    "keeps rows but makes no completeness claim when %s carries %s",
    (container, key, value) => {
      const response = onePosted();
      const target = container === "root" ? response : response.result;
      (target as unknown as Record<string, unknown>)[key] = value;
      const result = extract(response);
      expect(result.transactions).toHaveLength(1);
      expect(result.warnings).toContain("unsupported_pagination");
      expect(result.partitions).toEqual([
        expect.objectContaining({ success: false, comparable: false }),
        expect.objectContaining({ success: false, comparable: false }),
      ]);
    },
  );

  it.each([
    ["hasMore", false],
    ["totalPages", 1],
    ["nextPage", null],
    ["nextCursor", ""],
    ["cursor", false],
  ] as const)("treats %s=%s as no continuation", (key, value) => {
    const response = onePosted();
    (response.result as Record<string, unknown>)[key] = value;
    const result = extract(response);
    expect(result.warnings).not.toContain("unsupported_pagination");
    expect(result.partitions).toEqual([
      expect.objectContaining({ success: true, comparable: true }),
      expect.objectContaining({ success: true, comparable: true }),
    ]);
  });

  it("accepts future fields without retaining undeclared evidence", () => {
    const response = onePosted();
    response.result.transactions[0]!.futureField = {
      anything: [true, "new", 125],
    };
    const result = extract(response);
    expect(result.partitions.every((partition) => partition.success)).toBe(
      true,
    );
    expect(
      (result.transactions[0]!.details.provider.cal!.rows as SyntheticRow[])[0],
    ).not.toHaveProperty("futureField");
    expect(
      extractCal(fixture("future-field"), context).transactions.length,
    ).toBeGreaterThan(0);
  });

  it("retains large numeric identifiers and exact decimal lexemes before converting amounts", () => {
    const response = onePosted();
    const serialized = JSON.stringify(response)
      .replace('"SYNTHETIC-TXN-REGULAR"', "9007199254740993123")
      .replace('"amountForDisplay":86.4', '"amountForDisplay":0.2900')
      .replace('"trnAmt":86.4', '"trnAmt":0.2900');
    const row = extractCal(serialized, context).transactions[0]!;
    expect(row.sourceKey).toContain("9007199254740993123");
    expect(row.amountMinor).toBe(-29);
    expect(row.originalAmountMinor).toBe(-29);
    expect(row.details.provider.cal!.rows).toMatchObject([
      { amountForDisplay: "0.2900", trnIntId: "9007199254740993123" },
    ]);
    expect(transactionInputSchema.safeParse(row).success).toBe(true);
  });

  it("retains opaque numeric cash-account metadata exactly while using only display money", () => {
    for (const amountForDisplay of [86.4, 0]) {
      const response = onePosted();
      response.result.transactions[0]!.amountForDisplay = amountForDisplay;
      const source = JSON.stringify(response).replace(
        '"cashAccountTrnAmt":123.4567',
        '"cashAccountTrnAmt":123.456700',
      );
      const row = extractCal(source, context).transactions[0]!;
      expect(row.details.provider.cal!.rows).toMatchObject([
        { cashAccountTrnAmt: "123.456700" },
      ]);
      expect(row.amountMinor).toBe(amountForDisplay === 0 ? 0 : -8640);
      expect(row.currency).toBe("ILS");
      expect(row.amountBasis).toBe("purchase_commitment");
    }
  });

  it("keeps unsupported money unresolved instead of rounding, inventing currency or using original amount", () => {
    for (const patch of [
      { amountForDisplay: 1.001 },
      { amountForDisplay: 90071992547410 },
      { debCrdCurrencyCode: 999 },
      { transactionTypeCode: 999 },
      { amountForDisplay: -10, refundInd: false },
    ]) {
      const response = onePosted();
      Object.assign(response.result.transactions[0]!, patch);
      const row = extract(response).transactions[0]!;
      expect(row).toMatchObject({
        amountMinor: null,
        currency: null,
        originalAmountMinor: null,
        originalCurrency: null,
      });
    }
  });

  it("does not infer unsupported pending directions or unknown type semantics", () => {
    for (const patch of [
      { trnAmt: -10 },
      { trnTypeCode: "6", trnAmt: 10 },
      { trnTypeCode: "999", trnAmt: -10 },
    ]) {
      const response = baseline();
      response.result.transactions = [];
      response.result.clearanceRequests = [
        Object.assign(response.result.clearanceRequests[0]!, patch),
      ];
      expect(extract(response).transactions[0]).toMatchObject({
        status: "pending",
        amountBasis: "authorization",
        amountMinor: null,
        currency: null,
      });
    }
  });

  it("preserves weak pending multiplicity and never links a pending row to a similar posted row", () => {
    const response = baseline();
    const weak = response.result.clearanceRequests[1]!;
    response.result.clearanceRequests = [weak, { ...weak }];
    const pending = extract(response).transactions.filter(
      (row) => row.status === "pending",
    );
    expect(pending).toHaveLength(2);
    expect(new Set(pending.map((row) => row.sourceKey)).size).toBe(2);
    expect(
      pending.every(
        (row) =>
          row.identityStrength === "ambiguous" && row.details.issues.length > 0,
      ),
    ).toBe(true);
    const before = extractCal(fixture("recent-01"), context).transactions;
    const after = extractCal(fixture("recent-02"), context).transactions;
    const authorization = before.find((row) =>
      row.sourceKey.includes("AUTH-PENDING-POSTED"),
    )!;
    const posted = after.find((row) =>
      row.sourceKey.includes("TXN-PENDING-POSTED"),
    )!;
    expect(posted.sourceKey).not.toBe(authorization.sourceKey);
    expect(posted.sourceAliases).toEqual([]);
  });

  it("keeps the full source time and exact decimal in weak identity signatures", () => {
    const response = baseline();
    response.result.transactions = [];
    const weak = response.result.clearanceRequests[1]!;
    response.result.clearanceRequests = [
      weak,
      { ...weak, trnPurchaseDate: "2040-06-11T12:00:00" },
    ];
    const rows = extract(response).transactions;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.identityStrength === "weak")).toBe(true);
    expect(rows[0]?.sourceKey).not.toBe(rows[1]?.sourceKey);
  });

  it("retains every native collision unless a consistent installment/cancellation group is established", () => {
    const response = onePosted();
    const first = response.result.transactions[0]!;
    response.result.transactions = [
      first,
      { ...first, amountForDisplay: 100, trnAmt: 100 },
    ];
    const rows = extract(response).transactions;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.amountMinor)).toEqual([-8640, -10000]);
    expect(
      rows.every(
        (row) =>
          row.identityStrength === "ambiguous" && row.details.issues.length > 0,
      ),
    ).toBe(true);
  });

  it("marks a structurally invalid row partition failed without losing valid sibling rows", () => {
    const response = onePosted();
    response.result.transactions.push({
      ...response.result.transactions[0],
      amountForDisplay: "not a number",
    });
    const result = extract(response);
    expect(result.transactions).toHaveLength(1);
    expect(result.partitions[0]).toMatchObject({
      success: false,
      comparable: false,
    });
  });

  it("rejects a cancellation total beyond safe minor units after exact aggregation", () => {
    const response = baseline();
    response.result.transactions = response.result.transactions.filter(
      (row) => row.trnIntId === "SYNTHETIC-TXN-CANCEL",
    );
    response.result.clearanceRequests = [];
    const serialized = JSON.stringify(response)
      .replace(
        '"amountForDisplay":-210',
        '"amountForDisplay":-45035996273704.96',
      )
      .replace(
        '"amountForDisplay":-315',
        '"amountForDisplay":-45035996273704.96',
      );
    const rows = extractCal(serialized, context).transactions;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amountMinor: null,
      currency: null,
    });
    expect(rows[0]!.details.issues).toContain("amount_out_of_range");
    expect(rows[0]!.details.sourceRefs).toHaveLength(2);
  });

  it("keeps one purchase in review when a capture states conflicting plan totals", () => {
    const response = JSON.parse(fixture("legacy-history")) as {
      result: { transArr: SyntheticRow[] };
    };
    const rows = response.result.transArr.filter(
      (row) => row.trnIntId === "SYNTHETIC-TXN-LEGACY-INSTALLMENTS",
    );
    response.result.transArr = rows;
    rows[1]!.amountForDisplay = 1201;
    const [purchase, ...lines] = extract(response).transactions;
    expect(purchase).toMatchObject({
      identityStrength: "native",
      amountMinor: null,
      currency: null,
    });
    expect(purchase!.details.issues).toContain("conflicting_installment_total");
    expect(lines.map((row) => [row.identityStrength, row.amountMinor])).toEqual(
      [
        ["native", -10000],
        ["native", -10000],
        ["native", -10000],
      ],
    );
  });

  it("marks missing posted IDs ambiguous and keys them by displayed money", () => {
    const response = onePosted();
    const row = response.result.transactions[0]!;
    delete row.trnIntId;
    response.result.transactions = [row, { ...row, amountForDisplay: 100 }];
    const rows = extract(response).transactions;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.sourceKey)).size).toBe(2);
    expect(
      rows.every(
        (row) =>
          row.identityStrength === "ambiguous" && row.details.issues.length > 0,
      ),
    ).toBe(true);
    expect(rows[0]!.details.provider.cal!.identity).toMatchObject({
      occurrenceCount: 1,
    });
  });

  it("does not resolve conflicting currency evidence or unknown original currency codes", () => {
    const conflict = onePosted();
    conflict.result.transactions[0]!.currencyForDisplay = "€";
    expect(extract(conflict).transactions[0]).toMatchObject({
      amountMinor: null,
      currency: null,
    });
    const original = onePosted();
    original.result.transactions[0]!.trnCurrencyIsoCode = "999";
    expect(extract(original).transactions[0]).toMatchObject({
      amountMinor: -8640,
      currency: "ILS",
      originalAmountMinor: null,
      originalCurrency: null,
    });
  });

  it("retains malformed date evidence without inventing a transaction date", () => {
    for (const sourceDate of [
      "2040-02-30T12:00:00",
      "2040-06-11T24:00:00",
      "2040-06-11T25:00:00",
    ]) {
      const response = onePosted();
      response.result.transactions[0]!.trnPurchaseDate = sourceDate;
      const row = extract(response).transactions[0]!;
      expect(row).toMatchObject({ transactionDate: null });
      expect(row.details.issues).toContain("invalid_source_date");
    }
  });

  it("treats inherited-property-like type and currency codes as unsupported data", () => {
    for (const code of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ]) {
      for (const field of [
        "transactionTypeCode",
        "debCrdCurrencyCode",
        "currencyForDisplay",
      ]) {
        const response = onePosted();
        response.result.transactions[0]![field] = code;
        const result = extract(response);
        const row = result.transactions[0]!;
        expect(result.partitions.every((partition) => partition.success)).toBe(
          true,
        );
        expect(row).toMatchObject({
          amountMinor: null,
          currency: null,
        });
        expect(typeof row.kind).toBe("string");
        expect(transactionInputSchema.safeParse(row).success).toBe(true);
      }
      for (const field of [
        "trnCurrencyIsoCode",
        "transOriginalCurrencyCode",
        "trnCurrencySymbol",
      ]) {
        const response = onePosted();
        response.result.transactions[0]![field] = code;
        const row = extract(response).transactions[0]!;
        expect(row).toMatchObject({
          amountMinor: -8640,
          currency: "ILS",
          originalAmountMinor: null,
          originalCurrency: null,
        });
        expect(transactionInputSchema.safeParse(row).success).toBe(true);
      }
      const pending = baseline();
      pending.result.transactions = [];
      pending.result.clearanceRequests = [
        {
          ...pending.result.clearanceRequests[0]!,
          trnCurrencySymbol: code,
          trnTypeCode: code,
        },
      ];
      const row = extract(pending).transactions[0]!;
      expect(row).toMatchObject({
        kind: "unknown",
        amountMinor: null,
        currency: null,
      });
      expect(transactionInputSchema.safeParse(row).success).toBe(true);
    }
  });

  it("still reports malformed pending coverage when explicitly present in a legacy archive", () => {
    const response = JSON.parse(fixture("legacy-history")) as {
      result: { transArr: SyntheticRow[]; clearanceRequests?: unknown };
    };
    response.result.clearanceRequests = null;
    const result = extract(response);
    expect(result.partitions).toEqual([
      {
        accountKey: context.accountKey,
        status: "posted",
        success: true,
        comparable: false,
      },
      {
        accountKey: context.accountKey,
        status: "pending",
        success: false,
        comparable: false,
      },
    ]);
    expect(result.warnings).toContain("invalid_pending_partition");
  });
});

// The provider owns the source amount roles; the domain only consumes this declaration.
describe("CAL automatic posting capability", () => {
  it.each(["recent-01", "recent-02", "malformed-pending", "future-field"])(
    "successful nonhistorical %s partitions are comparable",
    (name) => {
      const result = extractCal(fixture(name), context);
      expect(result.historical).toBe(false);
      const successful = result.partitions.filter(
        (partition) => partition.success,
      );
      expect(successful.length).toBeGreaterThan(0);
      for (const partition of successful) {
        expect(partition.comparable).toBe(true);
      }
    },
  );

  it("declares authorization to purchase-commitment continuation with the current parser", () => {
    expect(calAdapter.automaticPosting).toEqual({
      compatibleGroups: expect.any(Function),
      pendingAmountBasis: "authorization",
      postedAmountBasis: "purchase_commitment",
    });
    expect(calAdapter.parserVersion).toBe("cal-v14");
  });
});
