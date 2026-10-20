import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  annotationSchema,
  detailsSchema,
  emptyDetails,
  transactionInputSchema,
  unknownLedgerFacts,
} from "../../src/domain/model.js";
import { runSchema } from "../../src/domain/plans/sync.js";

const bankFixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/generic/bank-transactions.json", import.meta.url),
    "utf8",
  ),
);

function bankInput(index = 0): Record<string, unknown> {
  const { id, connection_id, presence, version, details_json, ...fields } =
    bankFixture.transactions[index];
  return {
    ...Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        value,
      ]),
    ),
    identityStrength: "native",
    details: details_json,
  };
}

describe("shared financial transaction schema", () => {
  it("preserves supplied transaction time precision and offset without requiring old detail documents to contain it", () => {
    expect(detailsSchema.parse(emptyDetails())).not.toHaveProperty(
      "transactionDateTime",
    );
    for (const transactionDateTime of [
      null,
      "2040-02-29T12:30",
      "2040-02-29T12:30:01",
      "2040-02-29T12:30:01.1200",
      "2040-02-29T12:30:01Z",
      "2040-02-29T12:30:01+03:00",
      "2040-02-29T12:30:01-05:30",
    ]) {
      expect(
        detailsSchema.parse({ ...emptyDetails(), transactionDateTime })
          .transactionDateTime,
      ).toBe(transactionDateTime);
    }
    for (const transactionDateTime of [
      "2040-02-30T12:30:00",
      "0000-01-01T12:30:00",
      "2040-02-29",
      "2040-02-29T24:00:00",
      "2040-02-29T12:30:60",
      "2040-02-29T12:30:00+25:00",
      "2040-02-29T12:30:00\n",
    ]) {
      expect(
        detailsSchema.safeParse({ ...emptyDetails(), transactionDateTime })
          .success,
      ).toBe(false);
    }
  });

  it("requires purchase time to agree with the source-local transaction date", () => {
    for (const transactionDate of ["2040-06-11", "2040-06-10", null]) {
      expect(
        transactionInputSchema.safeParse({
          ...bankInput(),
          transactionDate,
          details: {
            ...emptyDetails(),
            transactionDateTime: "2040-06-11T00:30:00+03:00",
          },
        }).success,
      ).toBe(transactionDate === "2040-06-11");
    }
  });

  it("rejects an empty canonical card identifier while retaining absent bank cards", () => {
    expect(
      transactionInputSchema.safeParse({ ...bankInput(), cardKey: "" }).success,
    ).toBe(false);
    expect(
      transactionInputSchema.safeParse({ ...bankInput(), cardKey: null })
        .success,
    ).toBe(true);
  });
  it.each(["sourceScope", "cardKey"])(
    "bounds canonical resource identifier %s for mandatory compact reads",
    (field) => {
      expect(
        transactionInputSchema.safeParse({
          ...bankInput(),
          [field]: "x".repeat(1024),
        }).success,
      ).toBe(true);
      expect(
        transactionInputSchema.safeParse({
          ...bankInput(),
          [field]: "x".repeat(1025),
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    "description",
    "counterpartyName",
    "merchantName",
    "merchantProviderId",
  ])(
    "rejects canonical %s beyond the compact wire bound while preserving raw evidence",
    (field) => {
      expect(
        transactionInputSchema.safeParse({
          ...bankInput(),
          [field]: "x".repeat(4096),
        }).success,
      ).toBe(true);
      expect(
        transactionInputSchema.safeParse({
          ...bankInput(),
          [field]: "x".repeat(4097),
        }).success,
      ).toBe(false);
      expect(
        transactionInputSchema.parse({
          ...bankInput(),
          details: {
            ...emptyDetails(),
            provider: { synthetic: { text: "x".repeat(4097) } },
          },
        }).details.provider.synthetic?.text,
      ).toHaveLength(4097);
    },
  );
  it.each([
    "sourceScope",
    "cardKey",
    "sourceKey",
    "description",
    "counterpartyName",
    "merchantName",
    "merchantProviderId",
    "merchantCategoryCode",
  ])(
    "rejects NUL in canonical scalar %s without altering JSON or annotations",
    (key) => {
      expect(
        transactionInputSchema.safeParse({
          ...bankInput(),
          [key]: "before\u0000after",
        }).success,
      ).toBe(false);
      const input = transactionInputSchema.parse({
        ...bankInput(),
        description: "literal\\u0000",
        sourceAliases: ["alias\u0000suffix"],
        details: {
          ...emptyDetails(),
          provider: { synthetic: { retained: "actual\u0000literal\\u0000" } },
        },
      });
      expect(input.description).toBe("literal\\u0000");
      expect(input.sourceAliases).toEqual(["alias\u0000suffix"]);
      expect(input.details.provider.synthetic?.retained).toBe(
        "actual\u0000literal\\u0000",
      );
      expect(annotationSchema.parse({ notes: "note\u0000suffix" }).notes).toBe(
        "note\u0000suffix",
      );
    },
  );

  it("accepts synthetic bank income, transfer and direct debit without a card, merchant, or purchase date", () => {
    const salary = transactionInputSchema.parse(bankInput());
    const transfer = transactionInputSchema.parse(bankInput(1));
    const directDebit = transactionInputSchema.parse(bankInput(2));
    expect(salary).toMatchObject({
      kind: "income",
      amountBasis: "booked_entry",
      cardKey: null,
      merchantName: null,
      counterpartyName: "Example Employer",
      transactionDate: null,
    });
    expect(transfer).toMatchObject({
      kind: "transfer",
      amountMinor: -50_000,
      sourceAliases: [],
    });
    expect(directDebit).toMatchObject({
      kind: "purchase",
      amountBasis: "booked_entry",
      amountMinor: -4200,
      cardKey: null,
      merchantName: null,
      transactionDate: null,
      counterpartyName: "Example Utility",
    });
  });

  it("preserves unknown primary and original money as paired nulls", () => {
    expect(
      transactionInputSchema.parse({
        ...bankInput(),
        amountMinor: null,
        currency: null,
      }).amountMinor,
    ).toBeNull();
    expect(
      transactionInputSchema.safeParse({ ...bankInput(), amountMinor: null })
        .success,
    ).toBe(false);
    expect(
      transactionInputSchema.safeParse({
        ...bankInput(),
        originalAmountMinor: 100,
      }).success,
    ).toBe(false);
  });

  it("requires four decimal digits for canonical merchant category codes without losing leading zeros", () => {
    expect(
      transactionInputSchema.parse({
        ...bankInput(),
        merchantCategoryCode: "0123",
      }).merchantCategoryCode,
    ).toBe("0123");
    for (const merchantCategoryCode of [
      "123",
      "12345",
      "12A4",
      "１２３４",
      "5411\n",
    ]) {
      expect(
        transactionInputSchema.safeParse({
          ...bankInput(),
          merchantCategoryCode,
        }).success,
      ).toBe(false);
    }
  });

  it("validates safe minor units, ISO-shaped currency, real dates, and independent installment counts", () => {
    for (const change of [
      { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
      { amountMinor: 1.5 },
      { currency: "usd" },
      { currency: "ZZZ" },
      { bookingDate: "2040-02-30" },
      { installmentCount: -1 },
    ]) {
      expect(
        transactionInputSchema.safeParse({ ...bankInput(), ...change }).success,
      ).toBe(false);
    }
    expect(
      transactionInputSchema.safeParse({
        ...bankInput(),
        installmentCount: 0,
      }).success,
    ).toBe(true);
    expect(
      transactionInputSchema.safeParse({ ...bankInput(), installmentNumber: 4 })
        .success,
    ).toBe(true);
    for (const change of [
      { installmentNumber: 0 },
      { purchaseKey: "" },
      { purchaseKey: bankInput().sourceKey },
    ]) {
      expect(
        transactionInputSchema.safeParse({ ...bankInput(), ...change }).success,
      ).toBe(false);
    }
    expect(
      transactionInputSchema.safeParse({ ...bankInput(), currency: "CAD" })
        .success,
    ).toBe(true);
  });
});

describe("versioned details", () => {
  it("retains exact optional source prose without turning arbitrary objects into text", () => {
    const additionalInformation = [
      "  <b>Synthetic source explanation</b>  ",
      "x".repeat(5000),
    ];
    expect(
      detailsSchema.parse({ ...emptyDetails(), additionalInformation })
        .additionalInformation,
    ).toEqual(additionalInformation);
    expect(detailsSchema.parse(emptyDetails())).not.toHaveProperty(
      "additionalInformation",
    );
    for (const invalid of [null, "text", [1], [{ text: "opaque" }]]) {
      expect(
        detailsSchema.safeParse({
          ...emptyDetails(),
          additionalInformation: invalid,
        }).success,
      ).toBe(false);
    }
  });

  it("bounds run identifiers admitted to source references, posting evidence and runs", () => {
    const { cardKey, ...facts } = transactionInputSchema.parse(bankInput());
    const pending = {
      ...facts,
      ...unknownLedgerFacts(cardKey),
      status: "pending",
      id: "pending",
      connectionId: "connection",
      presence: "seen",
      firstSeenAt: "2040-06-01T00:00:00Z",
      lastSeenAt: "2040-06-01T00:00:00Z",
      lastSeenRunId: "run",
      version: 1,
      supersededById: null,
    };
    for (const length of [1024, 1025]) {
      const runId = "r".repeat(length);
      const expected = length === 1024;
      expect(
        detailsSchema.safeParse({
          ...emptyDetails(),
          sourceRefs: [{ runId, path: "/row" }],
        }).success,
      ).toBe(expected);
      expect(
        detailsSchema.safeParse({
          ...emptyDetails(),
          postingLink: {
            schemaVersion: 1,
            policyVersion: "synthetic",
            automatic: true,
            postedId: "posted",
            pending,
            pendingKeys: ["pending"],
            postedKeys: ["posted"],
            evidence: { runId, capturedAt: "2040-06-01T00:00:00Z" },
          },
        }).success,
      ).toBe(expected);
      expect(
        runSchema.safeParse({
          runId,
          connectionId: "connection",
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic",
              capturedAt: "2040-06-01T00:00:00Z",
              responseText: "{}",
            },
          ],
        }).success,
      ).toBe(expected);
    }
  });
  it("accepts v1 documents with optional merchant location and stated FX", () => {
    const legacy = emptyDetails();
    expect(detailsSchema.parse(legacy)).toEqual(legacy);
    const enriched = {
      ...legacy,
      merchant: {
        ...legacy.merchant,
        city: "Synthetic city",
        countryCode: "ISR",
      },
      currencyExchange: [
        {
          sourceCurrency: "EUR",
          targetCurrency: "ILS",
          unitCurrency: "EUR",
          exchangeRate: "3.9876",
          quotationDate: "2040-06-01",
        },
      ],
    };
    expect(detailsSchema.parse(enriched)).toEqual(enriched);
    expect(
      detailsSchema.parse({
        ...enriched,
        merchant: { ...enriched.merchant, city: null, countryCode: null },
      }).merchant.city,
    ).toBeNull();
    for (const invalid of [
      { ...legacy, merchant: { ...legacy.merchant, city: 0 } },
      // Only a valid ISO 3166-1 alpha-3 code is a country code.
      { ...legacy, merchant: { ...legacy.merchant, countryCode: "IL" } },
      { ...legacy, merchant: { ...legacy.merchant, countryCode: "XXX" } },
      { ...legacy, merchant: { ...legacy.merchant, countryCode: "isr" } },
      // Payment context lives in typed transaction fields, not in details.
      { ...legacy, payment: { cardPresent: true, walletName: null } },
      {
        ...enriched,
        currencyExchange: [
          { ...enriched.currencyExchange[0]!, exchangeRate: "3,98" },
        ],
      },
      { ...enriched, currencyExchange: [] },
    ]) {
      expect(detailsSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("keeps nested source objects, labels, and opaque exact numeric strings", () => {
    const details = emptyDetails();
    details.provider.cal = {
      nativeId: "9007199254740993123",
      nullable: null,
      flags: [true, false],
      retained: {
        paymentHistory: [
          { num: "Payment 2 of 12", amount: "0.29", currency: "₪" },
        ],
        comments: ["Source text", { link: "https://example.invalid" }],
      },
    };
    expect(detailsSchema.parse(details)).toEqual(details);
  });

  it("rejects unsupported versions, fields, and lossy or non-JSON values", () => {
    const details = emptyDetails();
    expect(
      detailsSchema.safeParse({ ...details, schemaVersion: 2 }).success,
    ).toBe(false);
    expect(
      detailsSchema.safeParse({ ...details, arbitrary: true }).success,
    ).toBe(false);
    for (const value of [
      Infinity,
      NaN,
      undefined,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        detailsSchema.safeParse({ ...details, provider: { cal: { value } } })
          .success,
      ).toBe(false);
    }
  });

  it("creates independent mutable detail documents", () => {
    const first = emptyDetails();
    first.issues.push("Example issue");
    first.merchant.address = "Example address";
    expect(emptyDetails().issues).toEqual([]);
    expect(emptyDetails().merchant.address).toBeNull();
  });
});

describe("independent annotations", () => {
  it("bounds category, tags and the serialized document before any write", () => {
    for (const data of [
      { tags: Array(51).fill("tag") },
      { tags: ["x".repeat(101)] },
      { tags: [" "] },
      { category: "x".repeat(101) },
      { category: "" },
      { notes: "x".repeat(65536) },
      { metadata: { content: "😀".repeat(17000) } },
    ]) {
      expect(annotationSchema.safeParse(data).success).toBe(false);
    }
    expect(
      annotationSchema.safeParse({
        category: "x".repeat(100),
        tags: Array(50).fill("x".repeat(100)),
      }).success,
    ).toBe(true);
  });

  it("defaults a small note document and preserves optional review/metadata context", () => {
    expect(annotationSchema.parse({ notes: "Check receipt" })).toEqual({
      schemaVersion: 1,
      notes: "Check receipt",
      category: null,
      tags: [],
      metadata: {},
      review: null,
    });
    expect(
      annotationSchema.parse({
        review: {
          status: "approved",
          financialVersion: 2,
          basis: {
            amountMinor: -100,
            currency: "USD",
            amountBasis: "booked_entry",
            kind: "fee",
          },
        },
        metadata: { businessUse: "uncertain", nested: { any: [1, null] } },
      }),
    ).toMatchObject({
      review: { financialVersion: 2 },
      metadata: { businessUse: "uncertain", nested: { any: [1, null] } },
    });
  });
});
