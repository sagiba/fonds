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
// ISO codes/scales verified against SIX on 2026-10-13. Provider pairs were observed
// in source shape analysis; these values/identifiers are invented examples.
const originalCases = [
  { iso: "191", provider: 66, currency: "HRK", symbol: "HRK", scale: 2 },
  { iso: "949", provider: 134, currency: "TRY", symbol: "TRY", scale: 2 },
  { iso: "977", provider: 119, currency: "BAM", symbol: "BAM", scale: 2 },
  { iso: "826", provider: 2, currency: "GBP", symbol: "£", scale: 2 },
  { iso: "348", provider: 97, currency: "HUF", symbol: "HUF", scale: 2 },
  { iso: "203", provider: 69, currency: "CZK", symbol: "CZK", scale: 2 },
  { iso: "704", provider: 118, currency: "VND", symbol: "VND", scale: 0 },
  { iso: "344", provider: 96, currency: "HKD", symbol: "HKD", scale: 2 },
  { iso: "484", provider: 33, currency: "MXN", symbol: "MXN", scale: 2 },
  { iso: "764", provider: 81, currency: "THB", symbol: "THB", scale: 2 },
  { iso: "392", provider: 40, currency: "JPY", symbol: "JPY", scale: 0 },
  { iso: "410", provider: 58, currency: "KRW", symbol: "KRW", scale: 0 },
  { iso: "756", provider: 5, currency: "CHF", symbol: "CHF", scale: 2 },
  { iso: "980", provider: 71, currency: "UAH", symbol: "UAH", scale: 2 },
  { iso: "400", provider: 46, currency: "JOD", symbol: "JOD", scale: 3 },
  { iso: "124", provider: 57, currency: "CAD", symbol: "CAD", scale: 2 },
];

function extract(difference: Row) {
  const result = extractCal(
    JSON.stringify({
      statusCode: 1,
      result: {
        transactions: [{ ...regular, ...difference }],
        clearanceRequests: [],
      },
    }),
    {
      accountKey: "SYNTHETIC-CURRENCY-ACCOUNT",
      runId: "synthetic-currency-run",
    },
  );
  const transaction = result.transactions[0]!;
  expect(transactionInputSchema.safeParse(transaction).success).toBe(true);
  return transaction;
}

describe("CAL original-currency roles", () => {
  it.each(originalCases)(
    "preserves exact $currency original money without converting its already-billed ILS",
    ({ iso, provider, currency, symbol, scale }) => {
      const transaction = extract({
        trnCurrencyIsoCode: iso,
        transOriginalCurrencyCode: provider,
        trnCurrencySymbol: symbol,
        trnAmt: scale === 0 ? 4275 : scale === 3 ? 4.275 : 42.75,
      });
      expect(transaction).toMatchObject({
        amountMinor: -8640,
        currency: "ILS",
        amountBasis: "purchase_commitment",
        originalAmountMinor: -4275,
        originalCurrency: currency,
      });
    },
  );

  it.each(originalCases)(
    "resolves evidenced provider-original $currency code alone without interpreting it as a billing code",
    ({ provider, currency, symbol, scale }) => {
      const transaction = extract({
        trnCurrencyIsoCode: null,
        transOriginalCurrencyCode: provider,
        trnCurrencySymbol: symbol,
        trnAmt: scale === 0 ? 4275 : scale === 3 ? 4.275 : 42.75,
      });
      expect(transaction).toMatchObject({
        amountMinor: -8640,
        currency: "ILS",
        originalAmountMinor: -4275,
        originalCurrency: currency,
      });
    },
  );

  it.each(originalCases)(
    "keeps unsupported fractional $currency original precision reviewable while retaining billed ILS",
    ({ iso, provider, symbol, scale }) => {
      const transaction = extract({
        trnCurrencyIsoCode: iso,
        transOriginalCurrencyCode: provider,
        trnCurrencySymbol: symbol,
        trnAmt: scale === 0 ? 42.75 : scale === 3 ? 4.2751 : 42.751,
      });
      expect(transaction).toMatchObject({
        amountMinor: -8640,
        currency: "ILS",
        originalAmountMinor: null,
        originalCurrency: null,
      });
      expect(transaction.details.issues).toContain(
        "unresolved_original_amount",
      );
    },
  );

  it.each([
    {
      trnCurrencyIsoCode: "826",
      transOriginalCurrencyCode: 5,
      trnCurrencySymbol: "£",
    },
    {
      trnCurrencyIsoCode: "826",
      transOriginalCurrencyCode: 2,
      trnCurrencySymbol: "CHF",
    },
    {
      trnCurrencyIsoCode: "756",
      transOriginalCurrencyCode: 5,
      trnCurrencySymbol: "$",
    },
  ])(
    "does not choose an original currency when codes or symbol conflict %j",
    (difference) => {
      const transaction = extract(difference);
      expect(transaction).toMatchObject({
        amountMinor: -8640,
        currency: "ILS",
        originalAmountMinor: null,
        originalCurrency: null,
      });
      expect(transaction.details.issues).toContain(
        "conflicting_original_currency",
      );
    },
  );

  it("does not infer original currency from a pound symbol when both codes are absent", () => {
    expect(
      extract({
        trnCurrencyIsoCode: null,
        transOriginalCurrencyCode: null,
        trnCurrencySymbol: "£",
      }),
    ).toMatchObject({
      amountMinor: -8640,
      currency: "ILS",
      originalAmountMinor: null,
      originalCurrency: null,
    });
  });

  it("does not use an original provider code as a newly supported billing currency", () => {
    const transaction = extract({
      debCrdCurrencyCode: 2,
      currencyForDisplay: "£",
      debCrdCurrencySymbol: "£",
      trnCurrencyIsoCode: "826",
      transOriginalCurrencyCode: 2,
      trnCurrencySymbol: "£",
    });
    expect(transaction).toMatchObject({
      amountMinor: null,
      currency: null,
    });
  });
});

describe("CAL pending original-currency symbols", () => {
  function pending(difference: Row) {
    const result = extractCal(
      JSON.stringify({
        statusCode: 1,
        result: {
          transactions: [],
          clearanceRequests: [
            { ...fixture.result.clearanceRequests[0], ...difference },
          ],
        },
      }),
      { accountKey: "synthetic-account", runId: "synthetic-pending-currency" },
    );
    const transaction = result.transactions[0]!;
    expect(transactionInputSchema.safeParse(transaction).success).toBe(true);
    return transaction;
  }

  it.each([
    ["₪", "ILS", 23.47, -2347],
    ["€", "EUR", 23.47, -2347],
    ["$", "USD", 23.47, -2347],
    ["£", "GBP", 23.47, -2347],
    ["MXN", "MXN", 23.47, -2347],
    ["JPY", "JPY", 2347, -2347],
    ["JOD", "JOD", 2.347, -2347],
    ["HRK", "HRK", 23.47, -2347],
    ["PLN", "PLN", 23.47, -2347],
    ["AUD", "AUD", 23.47, -2347],
    ["SEK", "SEK", 23.47, -2347],
    ["CLF", "CLF", 23.4712, -234712],
    ["UYW", "UYW", 23.4712, -234712],
  ])(
    "normalizes pending %s as exact signed %s money",
    (symbol, currency, source, amountMinor) => {
      const transaction = pending({
        trnCurrencySymbol: symbol,
        trnAmt: source,
      });
      expect(transaction).toMatchObject({
        currency,
        amountMinor,
      });
      expect(transaction.details.provider.cal).toMatchObject({
        currencyMapping: expect.stringContaining("CAL symbol mapping v2"),
      });
    },
  );

  it.each(["¤", "ZZZ", "usd", " USD ", "XAU", "XXX"])(
    "keeps unknown pending marker %s unresolved and flagged",
    (symbol) => {
      const transaction = pending({ trnCurrencySymbol: symbol, trnAmt: 23.47 });
      expect(transaction).toMatchObject({
        amountMinor: null,
        currency: null,
      });
      expect(transaction.details.issues).toContain("unresolved_amount");
    },
  );

  it("normalizes an explicit pending refund with the established refund sign convention", () => {
    expect(
      pending({ trnTypeCode: "6", trnAmt: -23.47, trnCurrencySymbol: "$" }),
    ).toMatchObject({
      kind: "refund",
      amountMinor: 2347,
      currency: "USD",
    });
  });
});
