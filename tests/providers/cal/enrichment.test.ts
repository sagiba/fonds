import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createApplication } from "../../../src/application/operations.js";
import { presentWireEvent } from "../../../src/application/wire-output.js";
import {
  parsedLedgerFacts,
  storedPaymentContext,
  transactionInputSchema,
} from "../../../src/domain/model.js";
import { calAdapter } from "../../../src/providers/cal/adapter.js";
import { extractCal } from "../../../src/providers/cal/extract.js";
import { openDatabase } from "../../../src/storage/sqlite/database.js";
import { retained } from "../../helpers/provider-evidence.js";

type SyntheticRow = Record<string, unknown> & {
  comments: { key: string; value: string }[];
};

const context = { accountKey: "SYNTHETIC-CAL-ACCOUNT", runId: "synthetic-run" };
const fixtureText = readFileSync(
  new URL("./fixtures/comment-templates.json", import.meta.url),
  "utf8",
);
const templateRows = (): SyntheticRow[] =>
  JSON.parse(fixtureText).result.transArr;
const templateRow = (id: string): SyntheticRow =>
  structuredClone(
    templateRows().find((row) => row.trnIntId === `SYNTHETIC-TPL-${id}`)!,
  );
/** Payment facts as the ledger stores them: an omitted fact (no evidence) is null. */
const known = <Row extends Parameters<typeof parsedLedgerFacts>[0]>(
  row: Row,
) => ({
  ...row,
  ...parsedLedgerFacts(row),
  ...storedPaymentContext(row, undefined),
});
const extractRows = (rows: SyntheticRow[]) =>
  extractCal(
    JSON.stringify({ statusCode: 1, result: { transArr: rows } }),
    context,
  ).transactions.map(known);
const extractOne = (row: SyntheticRow) => extractRows([row])[0]!;
const byId = (id: string) =>
  known(
    extractCal(fixtureText, context).transactions.find((row) =>
      row.sourceKey.includes(`SYNTHETIC-TPL-${id}`),
    )!,
  );

const ILS_TEMPLATE = (rate: string) =>
  `בתאריך 05/06/2040 בוצעה המרה ל-₪ בשער יציג ${rate}`;

describe("CAL comment templates and payment context", () => {
  it("extracts every invented template row as a valid adapter input", () => {
    const rows = extractCal(fixtureText, context).transactions;
    expect(rows).toHaveLength(templateRows().length);
    for (const row of rows) {
      expect(transactionInputSchema.safeParse(row).success).toBe(true);
    }
  });

  it("reads contactless, Apple Pay and card presence, and removes only the parsed comment", () => {
    const row = byId("CONTACTLESS");
    expect(row).toMatchObject({
      cardPresent: true,
      authorizationMethod: "contactless",
      wallet: "apple_pay",
      threeDSecureUsed: null,
      recurring: null,
      providerTransactionCode: "5",
    });
    // The wallet-token reminder has no typed home and stays as source text.
    expect(row.details.additionalInformation).toEqual([
      "בפנייה לבית העסק לבירורים בנוגע לעסקה יש למסור את 9 הספרות של מזהה הכרטיס בארנק.",
    ]);
    // The exact source comments stay in the evidence.
    expect(retained(row.details, "comments")).toContainEqual({
      key: "עסקה שבוצעה באמצעות Contact less",
      value: "",
    });
  });

  it("reads 3-D Secure from the secure-purchase comment and online from the execution method", () => {
    expect(byId("SECURE")).toMatchObject({
      cardPresent: false,
      authorizationMethod: "online",
      threeDSecureUsed: true,
      details: { additionalInformation: [] },
    });
    const commentOnly = templateRow("SECURE");
    delete commentOnly.trnExacWay;
    expect(extractOne(commentOnly)).toMatchObject({
      authorizationMethod: null,
      threeDSecureUsed: true,
    });
    const methodOnly = templateRow("SECURE");
    Object.assign(methodOnly, { trnExacWay: 35, comments: [] });
    expect(extractOne(methodOnly)).toMatchObject({
      authorizationMethod: "online",
      threeDSecureUsed: true,
    });
  });

  it.each([
    [12, "online", null],
    [21, "contactless", null],
    [15, "online", true],
    [35, "online", true],
    [9, null, null],
    [0, null, null],
    [7, null, null],
  ])(
    "maps execution method %j alone to %j / 3-D Secure %j",
    (trnExacWay, authorizationMethod, threeDSecureUsed) => {
      const row = templateRow("OTHER-TEMPLATES");
      Object.assign(row, { trnExacWay, comments: [] });
      const result = extractOne(row);
      expect(result).toMatchObject({ authorizationMethod, threeDSecureUsed });
      expect(result.details.issues).not.toContain(
        "conflicting_payment_context",
      );
    },
  );

  it("maps the reviewed internet wallet code to online and nothing else to a wallet", () => {
    const row = templateRow("OTHER-TEMPLATES");
    Object.assign(row, {
      comments: [],
      walletProviderCode: 32,
      walletProviderDesc: "אינטרנט",
    });
    expect(extractOne(row)).toMatchObject({
      authorizationMethod: "online",
      wallet: null,
    });
    Object.assign(row, { walletProviderCode: 3, walletProviderDesc: "" });
    const unlabeled = extractOne(row);
    expect(unlabeled).toMatchObject({
      authorizationMethod: null,
      wallet: null,
    });
    expect(unlabeled.details.issues).toEqual([]);
  });

  it("leaves conflicting payment context null with a source issue and keeps the comments", () => {
    const row = byId("CONFLICT");
    expect(row).toMatchObject({
      authorizationMethod: null,
      threeDSecureUsed: null,
    });
    expect(row.details.issues).toEqual(["conflicting_payment_context"]);
    expect(row.details.additionalInformation).toEqual([
      "עסקה שבוצעה באמצעות Contact less",
      "עסקה זו בוצעה באינטרנט ואושרה על ידך באמצעות שירות קניה בטוחה",
    ]);
    // A contactless method with an online wallet also conflicts.
    const mixed = templateRow("OTHER-TEMPLATES");
    Object.assign(mixed, {
      comments: [],
      trnExacWay: 21,
      walletProviderCode: 32,
      walletProviderDesc: "אינטרנט",
    });
    const result = extractOne(mixed);
    expect(result.authorizationMethod).toBeNull();
    expect(result.details.issues).toContain("conflicting_payment_context");
  });

  it("marks a standing order recurring by execution method or by type", () => {
    expect(byId("STANDING-ORDER")).toMatchObject({
      recurring: true,
      kind: "purchase",
      providerTransactionCode: "9",
    });
    for (const fields of [
      { trnExacWay: 9 },
      { transactionTypeCode: 9, trnType: "הוראת קבע", trnExacWay: 0 },
    ]) {
      const row = templateRow("OTHER-TEMPLATES");
      Object.assign(row, { comments: [], ...fields });
      expect(extractOne(row).recurring).toBe(true);
    }
    expect(byId("OTHER-TEMPLATES").recurring).toBeNull();
  });

  it("keeps unparsed templates and unknown text in additionalInformation without failing ingestion", () => {
    const row = byId("OTHER-TEMPLATES");
    expect(row.details.additionalInformation).toHaveLength(9);
    expect(row.details.additionalInformation).toContain(
      "Synthetic unknown issuer template",
    );
    expect(row.details.issues).toEqual([]);
    expect(row.amountMinor).toBe(-8640);
  });

  it("matches templates exactly: a near miss falls through unparsed", () => {
    for (const key of [
      "עסקה שבוצעה באמצעות Contact less ",
      "עסקה שבוצעה באמצעות contact less",
      " עסקה שבוצעה באמצעות Contact less",
    ]) {
      const row = templateRow("CONTACTLESS");
      row.comments = [{ key, value: "" }];
      const result = extractOne(row);
      // trnExacWay 21 alone still evidences contactless.
      expect(result.authorizationMethod).toBe("contactless");
      expect(result.details.additionalInformation).toEqual([key]);
    }
    const valued = templateRow("CONTACTLESS");
    valued.comments = [
      { key: "עסקה שבוצעה באמצעות Contact less", value: "unexpected" },
    ];
    expect(extractOne(valued).details.additionalInformation).toEqual([
      "עסקה שבוצעה באמצעות Contact less: unexpected",
    ]);
  });

  it("takes the provider transaction code from posted transactionTypeCode or pending trnTypeCode", () => {
    const recent = JSON.parse(
      readFileSync(
        new URL("./fixtures/recent-01.json", import.meta.url),
        "utf8",
      ),
    );
    const rows = extractCal(JSON.stringify(recent), context).transactions;
    const pending = rows.filter((row) => row.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    for (const row of pending) {
      const raw = (row.details.provider.cal!.rows as SyntheticRow[])[0]!;
      expect(row.providerTransactionCode).toBe(raw.trnTypeCode ?? null);
    }
    for (const row of rows.filter((item) => item.status === "posted")) {
      const raw = (row.details.provider.cal!.rows as SyntheticRow[])[0]!;
      expect(row.providerTransactionCode).toBe(String(raw.transactionTypeCode));
    }
  });
});

describe("CAL FX", () => {
  it("publishes a one-step conversion and the net fee of a reconciling purchase", () => {
    const row = byId("FX-ONE-STEP");
    // 50 EUR × 3.9871 + 1.50 − 0.50 = 200.355 → 200.36 billed.
    expect(row).toMatchObject({
      amountMinor: -20036,
      currency: "ILS",
      originalAmountMinor: -5000,
      originalCurrency: "EUR",
      fxFeeMinor: -100,
      fxFeeCurrency: "ILS",
    });
    expect(row.details.currencyExchange).toEqual([
      {
        sourceCurrency: "EUR",
        targetCurrency: "ILS",
        unitCurrency: "EUR",
        exchangeRate: "3.9871",
        quotationDate: "2040-06-05",
      },
    ]);
    expect(row.details.additionalInformation).toEqual([]);
    expect(row.details.issues).toEqual([]);
  });

  it("publishes a two-step conversion through USD in template order", () => {
    const row = byId("FX-TWO-STEP");
    // |50.80 USD| × 3.6543 + 1.78 = 187.41844 → 187.42 billed.
    expect(row).toMatchObject({
      amountMinor: -18742,
      fxFeeMinor: -178,
      fxFeeCurrency: "ILS",
    });
    expect(row.details.currencyExchange).toEqual([
      {
        sourceCurrency: "GBP",
        targetCurrency: "USD",
        unitCurrency: "GBP",
        exchangeRate: "1.270000",
        quotationDate: "2040-06-04",
      },
      {
        sourceCurrency: "USD",
        targetCurrency: "ILS",
        unitCurrency: "USD",
        exchangeRate: "3.6543",
        quotationDate: "2040-06-05",
      },
    ]);
  });

  it("gives a refund's fee the inflow sign, including a negative USD template amount", () => {
    // 30 USD × 3.6410 + |−0.9| = 110.13 billed back.
    expect(byId("FX-REFUND")).toMatchObject({
      kind: "refund",
      amountMinor: 11013,
      fxFeeMinor: 90,
      fxFeeCurrency: "ILS",
    });
    // |−25.40 USD| × 3.6543 = 92.81922 → 92.82, with no fee comment: a known zero fee.
    const twoStep = byId("FX-REFUND-TWO-STEP");
    expect(twoStep).toMatchObject({
      kind: "refund",
      amountMinor: 9282,
      fxFeeMinor: 0,
      fxFeeCurrency: "ILS",
    });
    expect(twoStep.details.currencyExchange).toHaveLength(2);
  });

  it("gives a USD-billed row its USD step and no fee, without an issue", () => {
    const row = byId("FX-USD-BILLED");
    expect(row).toMatchObject({
      amountMinor: -5220,
      currency: "USD",
      fxFeeMinor: null,
      fxFeeCurrency: null,
    });
    expect(row.details.currencyExchange).toEqual([
      {
        sourceCurrency: "EUR",
        targetCurrency: "USD",
        unitCurrency: "EUR",
        exchangeRate: "1.160000",
        quotationDate: "2040-06-08",
      },
    ]);
    expect(row.details.issues).toEqual([]);
    // The fee has no published home here, so its text stays.
    expect(row.details.additionalInformation).toEqual(['עמלת עסקת מט"ח: 0.75']);
  });

  it("keeps the stated rates but no fee when the row does not reconcile", () => {
    const row = byId("FX-UNRECONCILED");
    expect(row).toMatchObject({ fxFeeMinor: null, fxFeeCurrency: null });
    expect(row.details.issues).toEqual(["fx_unreconciled"]);
    expect(row.details.currencyExchange).toHaveLength(1);
    expect(row.details.additionalInformation).toEqual([
      'עמלת עסקת מט"ח: 1.50',
      'עסקה עם הנחה בעמלת מט"ח',
      'סכום הנחה בעמלת עסקאות מט"ח: 0.50',
    ]);
  });

  it.each([
    [200.36, true],
    [200.37, true],
    [200.35, true],
    [200.38, false],
    [200.34, false],
  ])(
    "reconciles billed %j against round2(200.355) = 200.36 within one minor unit: %j",
    (billed, reconciles) => {
      const row = templateRow("FX-ONE-STEP");
      Object.assign(row, {
        amountForDisplay: billed,
        amtBeforeConvAndIndex: billed,
      });
      const result = extractOne(row);
      expect(result.fxFeeMinor).toBe(reconciles ? -100 : null);
      expect(result.details.issues.includes("fx_unreconciled")).toBe(
        !reconciles,
      );
    },
  );

  it("rounds half up before comparing", () => {
    // 3 EUR × 3.335 = 10.005 → 10.01, so 10.00 is still within one unit and 9.99 is not.
    for (const [billed, reconciles] of [
      [10.01, true],
      [10.02, true],
      [9.99, false],
    ] as const) {
      const row = templateRow("FX-ONE-STEP");
      Object.assign(row, {
        trnAmt: 3,
        amountForDisplay: billed,
        comments: [{ key: ILS_TEMPLATE("3.335"), value: "" }],
      });
      expect(extractOne(row).fxFeeMinor).toBe(reconciles ? 0 : null);
    }
  });

  it("states an impossible quotation date as unknown", () => {
    const row = templateRow("FX-ONE-STEP");
    row.comments[0]!.key = row.comments[0]!.key.replace(
      "05/06/2040",
      "31/02/2040",
    );
    expect(extractOne(row).details.currencyExchange![0]!.quotationDate).toBe(
      null,
    );
  });

  it("publishes no conversion when the original currency is unresolved", () => {
    const row = templateRow("FX-ONE-STEP");
    row.trnCurrencyIsoCode = "999";
    const result = extractOne(row);
    expect(result.details.currencyExchange).toBeUndefined();
    expect(result.fxFeeMinor).toBeNull();
    expect(result.details.issues).toContain("unsupported_original_currency");
    expect(result.details.issues).not.toContain("fx_unreconciled");
  });

  it("does not choose between conflicting conversion comments", () => {
    const row = templateRow("FX-ONE-STEP");
    row.comments.push({ key: ILS_TEMPLATE("3.9999"), value: "" });
    const result = extractOne(row);
    expect(result.details.currencyExchange).toBeUndefined();
    expect(result.fxFeeMinor).toBeNull();
    expect(result.details.issues).toContain("conflicting_fx_comments");
    // A repeated identical comment is not a conflict.
    const repeated = templateRow("FX-ONE-STEP");
    repeated.comments.push({ ...repeated.comments[0]! });
    expect(extractOne(repeated).fxFeeMinor).toBe(-100);
  });

  it("gives installment-derived rows no FX facts", () => {
    const row = templateRow("FX-ONE-STEP");
    Object.assign(row, {
      transactionTypeCode: 8,
      trnType: "תשלומים",
      numOfPayments: 3,
      curPaymentNum: 1,
    });
    const result = extractOne(row);
    expect(result.details.currencyExchange).toBeUndefined();
    expect(result.fxFeeMinor).toBeNull();
    expect(result.details.issues).not.toContain("fx_unreconciled");
  });

  it("gives pending rows no FX facts, even with conversion comments and a posted original-currency code", () => {
    const recent = JSON.parse(
      readFileSync(
        new URL("./fixtures/recent-01.json", import.meta.url),
        "utf8",
      ),
    ) as { result: { clearanceRequests: Record<string, unknown>[] } };
    const pending = {
      ...recent.result.clearanceRequests[0]!,
      trnAmt: 50,
      trnCurrencySymbol: "€",
      // Posted-only field, so the conversion's original currency resolves.
      trnCurrencyIsoCode: "978",
      comments: [
        { key: ILS_TEMPLATE("3.9871"), value: "" },
        { key: 'עמלת עסקת מט"ח', value: "1.50" },
      ],
    };
    const [row] = extractCal(
      JSON.stringify({
        statusCode: 1,
        result: { transactions: [], clearanceRequests: [pending] },
      }),
      context,
    ).transactions.map(known);
    expect(row).toMatchObject({
      status: "pending",
      currency: "EUR",
      fxFeeMinor: null,
    });
    expect(row!.details.currencyExchange).toBeUndefined();
    expect(row!.details.issues).not.toContain("fx_unreconciled");
  });
});

describe("CAL FX versioning", () => {
  it("replays an identical FX row quietly and versions a changed rate with currencyExchange", async () => {
    const db = await openDatabase(":memory:");
    const connectionId = "synthetic-cal-fx";
    const ingest = async (day: number, rows: SyntheticRow[]) =>
      await db.ingestRun(
        {
          runId: `fx-${day}`,
          connectionId,
          responses: [
            {
              accountKey: "synthetic-account",
              endpoint: "/synthetic-financial-response",
              capturedAt: `2040-08-0${day}T00:00:00Z`,
              responseText: JSON.stringify({
                statusCode: 1,
                result: { transactions: rows, clearanceRequests: [] },
              }),
            },
          ],
        },
        calAdapter,
      );
    try {
      await db.ensureConnection({ id: connectionId, provider: "cal" });
      const first = templateRow("FX-ONE-STEP");
      await ingest(1, [first]);
      const original = (await db.listTransactions())[0]!;
      expect(original.fxFeeMinor).toBe(-100);
      const events = await db.listEvents({});
      const last = events.at(-1)!.id;
      // The same facts in a different comment order are structurally equal.
      const reordered = structuredClone(first);
      reordered.comments.reverse();
      await ingest(2, [reordered]);
      const quiet = (await db.listTransactions())[0]!;
      expect(quiet.version).toBe(original.version);
      expect(
        (await db.listEvents({ after: last })).filter(
          (event) => event.type === "transaction.updated",
        ),
      ).toEqual([]);
      // 50 × 3.9872 + 1.00 = 200.36: the same money with a different stated rate.
      const changed = structuredClone(first);
      changed.comments[0]!.key = ILS_TEMPLATE("3.9872");
      await ingest(3, [changed]);
      const updated = (await db.listTransactions())[0]!;
      expect(updated.version).toBe(original.version + 1);
      const update = (await db.listEvents({ after: last })).find(
        (event) => event.type === "transaction.updated",
      )!;
      expect(presentWireEvent(update).changedFields).toEqual([
        "currencyExchange",
      ]);
    } finally {
      db.close();
    }
  });
});

describe("CAL FX exact decimals", () => {
  // Lossless source tokens keep trailing zeros; JSON.stringify would drop them.
  const withTokens = (row: SyntheticRow, tokens: Record<string, string>) => {
    let text = JSON.stringify({ statusCode: 1, result: { transArr: [row] } });
    for (const [field, token] of Object.entries(tokens)) {
      text = text.replace(
        new RegExp(`"${field}":[^,}]+`),
        `"${field}":${token}`,
      );
    }
    return known(extractCal(text, context).transactions[0]!);
  };

  it("reconciles with trailing zeros in every FX input", () => {
    const row = templateRow("FX-ONE-STEP");
    // 50.000 × 3.9870 + 1.50 − 0.50 = 200.350, billed as 200.3500.
    row.comments = [
      { key: ILS_TEMPLATE("3.9870"), value: "" },
      { key: 'עמלת עסקת מט"ח', value: "1.50" },
      { key: 'סכום הנחה בעמלת עסקאות מט"ח', value: "0.50" },
    ];
    const result = withTokens(row, {
      trnAmt: "50.000",
      amountForDisplay: "200.3500",
      amtBeforeConvAndIndex: "200.3500",
    });
    expect(result).toMatchObject({
      amountMinor: -20035,
      fxFeeMinor: -100,
      fxFeeCurrency: "ILS",
    });
    expect(result.details.currencyExchange![0]!.exchangeRate).toBe("3.9870");
    expect(result.details.issues).toEqual([]);
  });

  it("reconciles a two-step conversion with trailing zeros and dropped fee zeros", () => {
    const row = templateRow("FX-TWO-STEP");
    // |50.80 USD| × 3.6540 + 1.8 = 187.4232 → 187.42, billed as 187.4200.
    row.comments = [
      {
        key: "בתאריך 04/06/2040 העסקה הומרה ל- 50.80$ בשער 1.270000. ההמרה ל- $ בוצעה לפי שער חליפין מכירה של  הבינלאומית.",
        value: "",
      },
      { key: ILS_TEMPLATE("3.6540"), value: "" },
      { key: 'עמלת עסקת מט"ח', value: "1.8" },
    ];
    const result = withTokens(row, {
      trnAmt: "40.00",
      amountForDisplay: "187.4200",
      amtBeforeConvAndIndex: "187.4200",
    });
    expect(result).toMatchObject({ fxFeeMinor: -180, fxFeeCurrency: "ILS" });
  });

  it("never aborts extraction on a billed amount finer than its currency", () => {
    const row = templateRow("FX-ONE-STEP");
    const result = withTokens(row, {
      amountForDisplay: "200.355",
      amtBeforeConvAndIndex: "200.355",
    });
    // The money itself is unresolved, so no fee is published.
    expect(result).toMatchObject({ amountMinor: null, fxFeeMinor: null });
    expect(result.details.currencyExchange).toHaveLength(1);
  });
});

describe("CAL payment context through ingestion", () => {
  const ingestRows = async (
    db: Awaited<ReturnType<typeof openDatabase>>,
    day: number,
    rows: SyntheticRow[],
  ) =>
    await db.ingestRun(
      {
        runId: `payment-${day}`,
        connectionId: "synthetic-cal-payment",
        responses: [
          {
            accountKey: "synthetic-account",
            endpoint: "/synthetic-financial-response",
            capturedAt: `2040-08-0${day}T00:00:00Z`,
            responseText: JSON.stringify({
              statusCode: 1,
              result: { transactions: rows, clearanceRequests: [] },
            }),
          },
        ],
      },
      calAdapter,
    );

  it("keeps all five known facts when a later read has no evidence for them", async () => {
    const db = await openDatabase(":memory:");
    try {
      await db.ensureConnection({
        id: "synthetic-cal-payment",
        provider: "cal",
      });
      const evidenced = templateRow("SECURE");
      Object.assign(evidenced, {
        transactionTypeCode: 9,
        trnType: "הוראת קבע",
        walletProviderCode: 3,
        walletProviderDesc: "Apple Pay",
      });
      await ingestRows(db, 1, [evidenced]);
      const original = (await db.listTransactions())[0]!;
      const facts = {
        cardPresent: false,
        authorizationMethod: "online",
        wallet: "apple_pay",
        threeDSecureUsed: true,
        recurring: true,
      };
      expect(original).toMatchObject(facts);
      const silent = templateRow("SECURE");
      // Same description and kind; only the payment evidence is absent.
      Object.assign(silent, {
        transactionTypeCode: 5,
        trnType: "הוראת קבע",
        trnExacWay: null,
        transCardPresentInd: null,
        walletProviderCode: 0,
        walletProviderDesc: "",
        comments: [],
      });
      await ingestRows(db, 2, [silent]);
      const retained = (await db.listTransactions())[0]!;
      expect(retained).toMatchObject({ ...facts, version: original.version });
    } finally {
      db.close();
    }
  });

  it("stores a conflicting read as unknown instead of restoring the earlier value", async () => {
    const db = await openDatabase(":memory:");
    try {
      await db.ensureConnection({
        id: "synthetic-cal-payment",
        provider: "cal",
      });
      await ingestRows(db, 1, [templateRow("SECURE")]);
      const original = (await db.listTransactions())[0]!;
      expect(original).toMatchObject({
        authorizationMethod: "online",
        threeDSecureUsed: true,
      });
      // A contactless comment with execution method 12, and a secure-purchase
      // comment that 12 contradicts.
      const conflicting = templateRow("CONFLICT");
      conflicting.trnIntId = "SYNTHETIC-TPL-SECURE";
      Object.assign(conflicting, {
        merchantId: original.merchantProviderId,
        merchantName: original.merchantName,
        transCardPresentInd: false,
      });
      await ingestRows(db, 2, [conflicting]);
      const stored = (await db.listTransactions())[0]!;
      expect(stored.id).toBe(original.id);
      expect(stored).toMatchObject({
        authorizationMethod: null,
        threeDSecureUsed: null,
        cardPresent: false,
        version: original.version,
      });
      expect(stored.details.issues).toContain("conflicting_payment_context");
      // A later read without evidence keeps the stored unknown.
      const sparse = templateRow("SECURE");
      Object.assign(sparse, {
        merchantId: original.merchantProviderId,
        merchantName: original.merchantName,
        trnExacWay: null,
        comments: [],
      });
      const beforeSparse = await db.latestEventId();
      await ingestRows(db, 3, [sparse]);
      const kept = (await db.listTransactions())[0]!;
      expect(kept).toMatchObject({
        authorizationMethod: null,
        threeDSecureUsed: null,
      });
      // The conflict stays evidenced while the read omits those facts.
      expect(kept.details.issues).toContain("conflicting_payment_context");
      expect(
        (await db.listEvents({ after: beforeSparse })).filter(
          (event) => event.type === "transaction.review_resolved",
        ),
      ).toEqual([]);
      // Explicit, consistent evidence sets the value again.
      await ingestRows(db, 4, [templateRow("SECURE")]);
      const restored = (await db.listTransactions())[0]!;
      expect(restored).toMatchObject({
        authorizationMethod: "online",
        threeDSecureUsed: true,
        version: original.version,
      });
      expect(restored.details.issues).not.toContain(
        "conflicting_payment_context",
      );
    } finally {
      db.close();
    }
  });
});

describe("CAL FX end to end", () => {
  it("ingests a reconciled fee through the adapter contract and reports it in totals", async () => {
    const db = await openDatabase(":memory:");
    const connectionId = "synthetic-cal-fx-totals";
    try {
      await db.ensureConnection({ id: connectionId, provider: "cal" });
      const rows = ["FX-ONE-STEP", "FX-UNRECONCILED", "CONTACTLESS"].map(
        templateRow,
      );
      const result = await db.ingestRun(
        {
          runId: "fx-totals-1",
          connectionId,
          responses: [
            {
              accountKey: "synthetic-account",
              endpoint: "/synthetic-financial-response",
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: JSON.stringify({
                statusCode: 1,
                result: { transactions: rows, clearanceRequests: [] },
              }),
            },
          ],
        },
        calAdapter,
      );
      // Nothing was rejected by the adapter input schema.
      expect(JSON.stringify(result)).not.toContain("invalid_extracted");
      const stored = await db.listTransactions();
      expect(stored).toHaveLength(3);
      const byMerchant = (id: string) =>
        stored.find(
          (row) => row.merchantProviderId === `SYNTHETIC-MERCHANT-${id}`,
        )!;
      // Parsed facts survive card resolution and storage.
      expect(byMerchant("FX-ONE-STEP")).toMatchObject({
        fxFeeMinor: -100,
        fxFeeCurrency: "ILS",
        authorizationMethod: "online",
        cardPresent: false,
        providerTransactionCode: "5",
      });
      expect(byMerchant("FX-ONE-STEP").cardId).not.toBeNull();
      expect(byMerchant("CONTACTLESS")).toMatchObject({
        authorizationMethod: "contactless",
        wallet: "apple_pay",
      });
      const operation = (name: string) =>
        createApplication(db).operations.find((value) => value.name === name)!;
      const detail = (await operation("get_transaction").execute({
        transactionId: byMerchant("FX-ONE-STEP").id,
      })) as { transaction: Record<string, unknown> };
      expect(detail.transaction).toMatchObject({
        fxFee: { currency: "ILS", amount: "-1.00" },
        authorizationMethod: "online",
        currencyExchange: [
          expect.objectContaining({
            sourceCurrency: "EUR",
            exchangeRate: "3.9871",
          }),
        ],
      });
      // The reconciled fee is summed; the converted row without a published
      // fee is counted as unknown, never as zero.
      expect(
        await operation("get_transaction_totals").execute({ connectionId }),
      ).toMatchObject({
        fxFees: [{ currency: "ILS", amount: "-1.00" }],
        fxFeeUnknownCount: 1,
      });
    } finally {
      db.close();
    }
  });
});
