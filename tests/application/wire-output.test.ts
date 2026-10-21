import { describe, expect, it } from "vitest";

import {
  decodeCursor,
  decodeKeyset,
  encodeCursor,
  encodeKeyset,
  listCursorSchema,
  pageSchema,
  totalsSchema,
} from "../../src/application/query-inputs.js";
import { emptyCounts } from "../../src/application/refreshes.js";
import {
  OUTPUT_MAX_BYTES,
  outputByteLength,
  presentRefresh,
  presentWireEvent,
  presentWireTotals,
  presentWireTransaction,
  refreshSummaryOutputSchema,
  transactionDetailOutputSchema,
  transactionOutputSchema,
  transactionReadOutputSchema,
} from "../../src/application/wire-output.js";
import {
  annotationSchema,
  emptyDetails,
  refreshFailureCodeSchema,
  unknownLedgerFacts,
} from "../../src/domain/model.js";
import {
  calculateTotals,
  presentTransaction,
} from "../../src/domain/read-model.js";
import type { Transaction } from "../../src/domain/records.js";

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "synthetic-wire-transaction",
    connectionId: "synthetic-connection",
    sourceScope: "synthetic-account",
    sourceKey: "synthetic-source-private-key",
    sourceAliases: ["synthetic-source-private-alias"],
    identityStrength: "native",
    status: "posted",
    presence: "seen",
    description: "Synthetic purchase",
    counterpartyName: null,
    kind: "purchase",
    merchantName: "Synthetic merchant",
    merchantProviderId: null,
    merchantCategoryCode: null,
    transactionDate: "2040-08-01",
    bookingDate: null,
    billingDate: "2040-09-01",
    amountMinor: -120000,
    currency: "ILS",
    amountBasis: "purchase_commitment",
    originalAmountMinor: null,
    originalCurrency: null,
    installmentCount: 12,
    ...unknownLedgerFacts("synthetic-card"),
    details: emptyDetails(),
    firstSeenAt: "2040-08-01T00:00:00Z",
    lastSeenAt: "2040-08-01T00:00:00Z",
    lastSeenRunId: "synthetic-run",
    version: 1,
    supersededById: null,
    ...overrides,
  };
}

describe("deliberate financial wire projection", () => {
  it("publishes useful source text, merchant and payment facts without requiring evidence", () => {
    const details = emptyDetails();
    details.additionalInformation = [
      "<b>Invented source message</b>",
      "Synthetic waiver explanation",
    ];
    details.merchant = {
      address: "Invented street",
      phone: "Synthetic phone",
      city: "Invented city",
      countryCode: "FRA",
    };
    const exchange = {
      sourceCurrency: "EUR",
      targetCurrency: "ILS",
      unitCurrency: "EUR",
      exchangeRate: "3.9876",
      quotationDate: "2040-08-02",
    };
    details.currencyExchange = [exchange];
    details.transactionDateTime = "2040-08-01T12:30:00";
    const row = transaction({
      details,
      cardPresent: false,
      authorizationMethod: "online",
      wallet: "apple_pay",
      threeDSecureUsed: true,
      recurring: null,
      providerTransactionCode: "5",
      fxFeeMinor: -275,
      fxFeeCurrency: "ILS",
    });
    const facts = {
      cardPresent: false,
      authorizationMethod: "online",
      wallet: "apple_pay",
      threeDSecureUsed: true,
      recurring: null,
      currencyExchange: [exchange],
      fxFee: { currency: "ILS", amount: "-2.75" },
      providerTransactionCode: "5",
      transactionDateTime: "2040-08-01T12:30:00",
      merchant: {
        name: "Synthetic merchant",
        addressLine: "Invented street",
        city: "Invented city",
        phone: "Synthetic phone",
        countryCode: "FRA",
      },
    };
    const compact = transactionOutputSchema.parse(
      presentWireTransaction(presentTransaction(row, null)),
    );
    expect(compact).toMatchObject(facts);
    // Explanatory prose is detail-only.
    expect(compact).not.toHaveProperty("additionalInformation");
    for (const evidence of [false, true]) {
      const output = transactionDetailOutputSchema.parse(
        presentWireTransaction(presentTransaction(row, null), true, evidence),
      );
      expect(output).toMatchObject({
        ...facts,
        additionalInformation: details.additionalInformation,
      });
      expect(output).not.toHaveProperty("detailsTruncated");
      expect(output).not.toHaveProperty("additionalInformationCount");
      if (!evidence) {
        expect(output).not.toHaveProperty("evidence");
        // Source details are published as typed fields, never as a details object.
        expect(output).not.toHaveProperty("details");
      }
    }
  });

  it("publishes unknown payment context and FX as null, never false or zero", () => {
    const output = transactionOutputSchema.parse(
      presentWireTransaction(presentTransaction(transaction(), null)),
    );
    expect(output).toMatchObject({
      cardPresent: null,
      authorizationMethod: null,
      wallet: null,
      threeDSecureUsed: null,
      recurring: null,
      currencyExchange: null,
      fxFee: null,
      providerTransactionCode: null,
    });
  });

  it("bounds useful source prose and reports clipping without changing stored source text", () => {
    const details = emptyDetails();
    details.additionalInformation = Array.from(
      { length: 120 },
      (_, index) => `${index}:` + "😀".repeat(3000),
    );
    details.merchant.address = "a".repeat(5000);
    details.sourceRefs = Array.from({ length: 100 }, (_, index) => ({
      runId: `run-${index}`,
      path: "x".repeat(4096),
    }));
    const view = presentTransaction(transaction({ details }), null);
    for (const evidence of [false, true]) {
      const output = transactionDetailOutputSchema.parse(
        presentWireTransaction(view, true, evidence),
      );
      expect(output.detailsTruncated).toBe(true);
      expect(output.additionalInformationCount).toBe(120);
      expect(output.additionalInformation.length).toBeLessThan(100);
      expect(outputByteLength({ transaction: output })).toBeLessThanOrEqual(
        OUTPUT_MAX_BYTES,
      );
      for (const message of output.additionalInformation) {
        expect(message.length).toBeLessThanOrEqual(4096);
        expect(message.endsWith("😀")).toBe(true);
      }
    }
    const compact = transactionOutputSchema.parse(presentWireTransaction(view));
    expect(compact.detailsTruncated).toBe(true);
    expect(compact.merchant.addressLine).toHaveLength(4096);
    expect(details.additionalInformation).toHaveLength(120);
    expect(details.merchant.address).toHaveLength(5000);
  });

  it("trims verbose source explanations before actionable review context", () => {
    const details = emptyDetails();
    details.additionalInformation = Array.from(
      { length: 120 },
      (_, index) => `${index}:` + "x".repeat(6 * 1024),
    );
    details.issues = ["synthetic_issue"];
    details.pendingPostingCandidates = ["synthetic-candidate-id"];
    details.sourceRefs = Array.from({ length: 100 }, (_, index) => ({
      runId: `run-${index}`,
      path: "x".repeat(4096),
    }));
    const view = presentTransaction(transaction({ details }), null);
    for (const includeEvidence of [false, true]) {
      const output = transactionDetailOutputSchema.parse(
        presentWireTransaction(view, true, includeEvidence),
      );
      expect(output.detailsTruncated).toBe(true);
      expect(output.review.truncated).toBe(false);
      expect(output.review.sourceIssues).toEqual(["synthetic_issue"]);
      expect(output.review.pendingPostingCandidateIds).toEqual([
        "synthetic-candidate-id",
      ]);
      expect(output.review.reasons).toEqual(view.reviewReasons);
      expect(outputByteLength({ transaction: output })).toBeLessThanOrEqual(
        OUTPUT_MAX_BYTES,
      );
    }
  });

  it("signals text-only clipping without suggesting information entries were omitted", () => {
    const details = emptyDetails();
    details.additionalInformation = ["x".repeat(5000)];
    const output = transactionDetailOutputSchema.parse(
      presentWireTransaction(
        presentTransaction(transaction({ details }), null),
        true,
      ),
    );
    expect(output.detailsTruncated).toBe(true);
    expect(output.additionalInformation[0]).toHaveLength(4096);
    expect(output).not.toHaveProperty("additionalInformationCount");
  });

  it("returns exact purchase time in ordinary detail and retains it when diagnostic evidence is truncated", () => {
    const details = emptyDetails();
    details.transactionDateTime = "2040-08-01T23:30:01.1200-05:00";
    details.sourceRefs = Array.from({ length: 150 }, (_, index) => ({
      runId: `synthetic-run-${index}`,
      path: "x".repeat(4096),
    }));
    const row = presentTransaction(transaction({ details }), null);
    const ordinary = transactionDetailOutputSchema.parse(
      presentWireTransaction(row, true),
    );
    expect(ordinary).toMatchObject({
      transactionDateTime: details.transactionDateTime,
    });
    expect(ordinary).not.toHaveProperty("evidence");
    const diagnostic = transactionDetailOutputSchema.parse(
      presentWireTransaction(row, true, true),
    );
    expect(diagnostic.diagnosticsTruncated).toBe(true);
    expect(diagnostic.transactionDateTime).toBe(details.transactionDateTime);
    expect(diagnostic.transactionDate).toBe("2040-08-01");
    const unknown = transactionDetailOutputSchema.parse(
      presentWireTransaction(presentTransaction(transaction(), null), true),
    );
    expect(unknown).toMatchObject({ transactionDateTime: null });
  });

  it.each([
    "booked_entry",
    "authorization",
    "purchase_commitment",
    "unknown",
  ] as const)("uses the same primary money field for %s", (amountBasis) => {
    const status = amountBasis === "authorization" ? "pending" : "posted";
    const row = presentTransaction(transaction({ amountBasis, status }), null);
    for (const detail of [false, true]) {
      const projected = presentWireTransaction(row, detail);
      expect(projected).toMatchObject({
        amount: { currency: "ILS", amount: "-1200.00" },
        amountBasis,
        status,
      });
      for (const key of [
        "fonds",
        "authorizationAmount",
        "purchaseCommitmentAmount",
        "unclassifiedAmount",
      ]) {
        expect(projected).not.toHaveProperty(key);
      }
      const schema = detail
        ? transactionDetailOutputSchema
        : transactionOutputSchema;
      expect(schema.safeParse(projected).success).toBe(true);
      expect(
        schema.safeParse({ ...projected, amountBasis: undefined }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...projected, status: undefined }).success,
      ).toBe(false);
    }
  });

  it("keeps a posted purchase commitment separate from a booked installment", () => {
    const commitment = transaction();
    const installment = transaction({
      id: "synthetic-billed-installment",
      amountBasis: "booked_entry",
      amountMinor: -10000,
    });
    const projected = presentWireTransaction(
      presentTransaction(commitment, null),
    );
    expect(projected).toMatchObject({
      id: commitment.id,
      amount: { currency: "ILS", amount: "-1200.00" },
      status: "posted",
      amountBasis: "purchase_commitment",
    });
    expect(projected).not.toHaveProperty("transactionId");
    const booked = presentWireTransaction(
      presentTransaction(installment, null),
    );
    expect(booked).toMatchObject({
      amount: { currency: "ILS", amount: "-100.00" },
      amountBasis: "booked_entry",
    });
    const totals = presentWireTotals(
      calculateTotals([
        commitment,
        installment,
        transaction({
          amountBasis: "booked_entry",
          currency: "USD",
          amountMinor: -2500,
        }),
        transaction({ amountBasis: "unknown" }),
        transaction({ status: "pending", amountBasis: "authorization" }),
      ]),
    );
    expect(totals.totals).toEqual([
      { currency: "ILS", amount: "-100.00", amountBasis: "booked_entry" },
      { currency: "USD", amount: "-25.00", amountBasis: "booked_entry" },
      {
        currency: "ILS",
        amount: "-1200.00",
        amountBasis: "purchase_commitment",
      },
    ]);
    expect(totals.includedCount).toBe(3);
    expect(totals.excluded).toMatchObject({ pending: 1, unresolved: 1 });
  });

  it("preserves separate original FX money and authorizations without claiming booking", () => {
    const row = transaction({
      status: "pending",
      amountBasis: "authorization",
      amountMinor: -12345,
      originalAmountMinor: -3210,
      originalCurrency: "USD",
    });
    for (const detail of [false, true]) {
      expect(
        presentWireTransaction(presentTransaction(row, null), detail),
      ).toMatchObject({
        originalAmount: { currency: "USD", amount: "-32.10" },
        amount: { currency: "ILS", amount: "-123.45" },
        amountBasis: "authorization",
        status: "pending",
      });
    }
  });

  it("returns an annotation once in detail and retains its summary in compact reads", () => {
    const source = transaction();
    const data = annotationSchema.parse({
      category: "Travel",
      tags: ["trip"],
      notes: "Synthetic note",
    });
    const row = presentTransaction(source, {
      transactionId: source.id,
      version: 2,
      data,
      updatedAt: "2040-08-02T00:00:00Z",
    });
    const compact = presentWireTransaction(row);
    expect(compact).toHaveProperty("annotation", {
      version: 2,
      category: "Travel",
      tags: ["trip"],
      hasNotes: true,
      metadata: {},
    });
    expect(compact).not.toHaveProperty("annotation.notes");
    expect(
      transactionReadOutputSchema.safeParse({ transaction: compact }).success,
    ).toBe(true);
    for (const includeEvidence of [false, true]) {
      const detail = presentWireTransaction(row, true, includeEvidence);
      expect(detail).toHaveProperty("annotation", {
        version: 2,
        notes: "Synthetic note",
        category: "Travel",
        tags: ["trip"],
        metadata: {},
        review: null,
        updatedAt: "2040-08-02T00:00:00Z",
      });
      expect(detail).not.toHaveProperty("annotation.hasNotes");
      expect(
        transactionReadOutputSchema.safeParse({ transaction: detail }).success,
      ).toBe(true);
      expect(
        transactionDetailOutputSchema.safeParse({
          ...detail,
          annotation: { version: 2, category: null, tags: [], hasNotes: true },
        }).success,
      ).toBe(false);
    }
  });

  it("requires a complete compact or detailed record and rejects mixed or unknown output fields", () => {
    const row = presentTransaction(transaction(), null);
    const compact = transactionOutputSchema.parse(presentWireTransaction(row));
    const detail = transactionDetailOutputSchema.parse(
      presentWireTransaction(row, true),
    );
    const { postingMatch: _postingMatch, ...incompleteDetail } = detail;
    for (const projected of [
      incompleteDetail,
      { ...compact, source: detail.source },
      { ...detail, annotationSummary: null },
      { ...compact, unexpected: true },
      { ...detail, unexpected: true },
    ]) {
      expect(
        transactionReadOutputSchema.safeParse({ transaction: projected })
          .success,
      ).toBe(false);
    }
    expect(
      transactionReadOutputSchema.safeParse({
        transaction: compact,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("serves a bank entry without manufacturing a card, merchant or party role", () => {
    const row = transaction({
      cardId: null,
      merchantName: null,
      kind: "income",
      amountBasis: "booked_entry",
      amountMinor: 1234,
      currency: "JPY",
      counterpartyName: "Unknown role source party",
    });
    const projected = presentWireTransaction(presentTransaction(row, null));
    expect(transactionOutputSchema.parse(projected)).toMatchObject({
      amount: { currency: "JPY", amount: "1234" },
      merchant: { name: null, providerId: null, categoryCode: null },
      cardId: null,
      amountBasis: "booked_entry",
      counterpartyName: "Unknown role source party",
    });
    expect(projected).not.toHaveProperty("creditorName");
    expect(projected).not.toHaveProperty("debtorName");
  });

  it("keeps unknown money null and exposes unclassified known money explicitly", () => {
    const unknown = transaction({
      amountMinor: null,
      currency: null,
      amountBasis: "unknown",
    });
    expect(
      presentWireTransaction(presentTransaction(unknown, null)),
    ).toMatchObject({
      amount: null,
      amountBasis: "unknown",
    });
    const known = transaction({ amountBasis: "unknown" });
    expect(
      presentWireTransaction(presentTransaction(known, null)),
    ).toMatchObject({
      amount: { currency: "ILS", amount: "-1200.00" },
      amountBasis: "unknown",
    });
  });

  it("omits provider data and private source identity in both compact and detail reads", () => {
    const details = emptyDetails();
    details.provider = {
      synthetic: {
        retainedSensitiveProviderProperty: "private-source-sentinel",
        retained: {
          comments: ["private-comment-sentinel"],
          paymentHistory: [{ privateHistory: true }],
        },
      },
    };
    details.sourceRefs = [{ runId: "synthetic-run", path: "/rows/1" }];
    const row = presentTransaction(transaction({ details }), null);
    const compact = transactionOutputSchema.parse(presentWireTransaction(row));
    const detail = transactionDetailOutputSchema.parse(
      presentWireTransaction(row, true, true),
    );
    expect(compact).not.toHaveProperty("details");
    expect(detail).not.toHaveProperty("details");
    expect(detail.diagnosticsTruncated).toBe(false);
    expect(detail.review.truncated).toBe(false);
    expect(detail.review.counts).toEqual({
      pendingPostingCandidateIds: 0,
      reasons: 0,
      sourceIssues: 0,
    });
    expect(detail.diagnosticCounts).toEqual({ evidence: 1 });
    expect(detail.evidence).toEqual([
      { runId: "synthetic-run", path: "/rows/1" },
    ]);
    for (const value of [compact, detail]) {
      expect(JSON.stringify(value)).not.toMatch(
        /private-source|private-comment|privateHistory|synthetic-source-private|sourceAliases|paymentHistory/,
      );
    }
  });

  it("requires four decimal digits for a published merchant category code", () => {
    const projected = presentWireTransaction(
      presentTransaction(transaction({ merchantCategoryCode: "0742" }), null),
    );
    expect(transactionOutputSchema.parse(projected).merchant.categoryCode).toBe(
      "0742",
    );
    for (const merchantCategoryCode of [
      "742",
      "12345",
      "ABCD",
      "74.2",
      "0742\n",
    ]) {
      expect(
        transactionOutputSchema.safeParse({
          ...projected,
          merchant: {
            ...projected.merchant,
            categoryCode: merchantCategoryCode,
          },
        }).success,
      ).toBe(false);
    }
  });

  it("names retained content changes while excluding operational observations", () => {
    const event = (before: object, after: object) =>
      presentWireEvent({
        id: 1,
        connectionId: "synthetic-connection",
        transactionId: "synthetic-id",
        runId: null,
        createdAt: "2040-08-01T00:00:00Z",
        actor: "system",
        type: "transaction.updated",
        before,
        after,
      }).changedFields;
    const versioned: Record<string, [string, unknown, unknown]> = {
      amount: ["amountMinor", -100, -200],
      originalAmount: ["originalAmountMinor", -100, -200],
      amountBasis: ["amountBasis", "authorization", "booked_entry"],
      kind: ["kind", "purchase", "refund"],
      status: ["status", "pending", "posted"],
      presence: ["presence", "seen", "not_returned"],
      transactionDate: ["transactionDate", "2040-01-01", "2040-01-02"],
      bookingDate: ["bookingDate", null, "2040-01-02"],
      billingDate: ["billingDate", null, "2040-01-02"],
      installmentCount: ["installmentCount", 3, 4],
      installmentNumber: ["installmentNumber", 1, 2],
      purchaseId: ["purchaseId", null, "purchase"],
      supersededById: ["supersededById", null, "posted"],
      description: ["description", "a", "b"],
      counterpartyName: ["counterpartyName", "a", "b"],
      "merchant.name": ["merchantName", "a", "b"],
      "merchant.providerId": ["merchantProviderId", "1", "2"],
      "merchant.categoryCode": ["merchantCategoryCode", "5411", "5812"],
      currencyExchange: ["currencyExchange", null, [{ exchangeRate: "3.9" }]],
      fxFee: ["fxFeeMinor", null, -275],
      cardId: ["cardId", null, "card"],
      "source.identityStrength": ["identityStrength", "weak", "native"],
      cardPresent: ["cardPresent", null, true],
      authorizationMethod: ["authorizationMethod", null, "contactless"],
      wallet: ["wallet", null, "apple_pay"],
      threeDSecureUsed: ["threeDSecureUsed", null, true],
      recurring: ["recurring", null, true],
      "merchant.city": ["merchantCity", null, "Synthetic City"],
      "merchant.countryCode": ["merchantCountryCode", null, "ISR"],
      "merchant.addressLine": [
        "merchantAddressLine",
        null,
        "Synthetic Address",
      ],
      "merchant.phone": ["merchantPhone", null, "Synthetic Phone"],
      transactionDateTime: ["transactionDateTime", null, "2040-01-01T12:30:00"],
      additionalInformation: [
        "additionalInformation",
        [],
        ["Source explanation"],
      ],
      providerTransactionCode: ["providerTransactionCode", null, "5"],
      "review.sourceIssues": ["sourceIssues", [], ["unknown_amount_basis"]],
      evidence: [
        "providerEvidence",
        [],
        [{ path: ["rows"], present: true, value: "private" }],
      ],
    };
    for (const [field, [key, before, after]] of Object.entries(versioned)) {
      expect(event({ [key]: before }, { [key]: after })).toEqual([field]);
    }
    for (const key of [
      "lastSeenAt",
      "lastSeenRunId",
      "sourceRefs",
      "sourceKey",
      "version",
      "pendingPostingCandidates",
    ]) {
      expect(event({ [key]: "a" }, { [key]: "b" })).toBeUndefined();
    }
  });

  it("exposes typed baseline summaries and allowlisted changed field names without historical values", () => {
    const metadata = {
      id: 2,
      connectionId: "synthetic-connection",
      transactionId: "synthetic-id",
      runId: "synthetic-run",
      createdAt: "2040-08-01T00:00:00Z",
      actor: "system",
    };
    const updated = presentWireEvent({
      ...metadata,
      type: "transaction.updated",
      before: {
        amountMinor: -100,
        currency: "ILS",
        originalCurrency: "USD",
        merchantName: "Old private merchant",
        privateProvider: "old secret",
      },
      after: {
        amountMinor: -200,
        currency: "USD",
        originalCurrency: "EUR",
        merchantName: "New private merchant",
        privateProvider: "new secret",
      },
    });
    expect(updated.changedFields).toEqual([
      "amount",
      "originalAmount",
      "merchant.name",
    ]);
    const exchange = {
      sourceCurrency: "EUR",
      targetCurrency: "ILS",
      unitCurrency: "EUR",
      exchangeRate: "3.9876",
      quotationDate: "2040-08-02",
    };
    const fx = (before: object, after: object) =>
      presentWireEvent({
        ...metadata,
        type: "transaction.updated",
        before,
        after,
      }).changedFields;
    // Structurally equal FX facts are unchanged; a different rate or fee is a change.
    expect(
      fx(
        {
          currencyExchange: [exchange],
          fxFeeMinor: -275,
          fxFeeCurrency: "ILS",
        },
        {
          currencyExchange: [{ ...exchange }],
          fxFeeMinor: -275,
          fxFeeCurrency: "ILS",
        },
      ),
    ).toBeUndefined();
    expect(
      fx(
        {
          currencyExchange: [exchange],
          fxFeeMinor: -275,
          fxFeeCurrency: "ILS",
        },
        {
          currencyExchange: [{ ...exchange, exchangeRate: "3.9877" }],
          fxFeeMinor: null,
          fxFeeCurrency: null,
        },
      ),
    ).toEqual(["fxFee", "currencyExchange"]);
    expect(JSON.stringify(updated)).not.toMatch(
      /secret|private merchant|-100|-200/,
    );
    const baseline = presentWireEvent({
      ...metadata,
      type: "sync.baseline",
      transactionId: null,
      before: null,
      after: {
        transactionCount: 20,
        privateProvider: "private-baseline-secret",
      },
    });
    expect(baseline.summary).toEqual({
      transactionCount: 20,
      historical: false,
    });
    expect(JSON.stringify(baseline)).not.toContain("private-baseline-secret");
    expect(
      presentWireEvent({
        ...metadata,
        type: "sync.baseline",
        before: null,
        after: { transactionCount: 5, historical: true },
      }).summary,
    ).toEqual({ transactionCount: 5, historical: true });
    const imported = presentWireEvent({
      ...metadata,
      type: "transaction.imported",
      before: null,
      after: { privateProvider: "private-imported-secret" },
    });
    expect(imported).toMatchObject({
      transactionId: metadata.transactionId,
      type: "transaction.imported",
    });
    expect(imported).not.toHaveProperty("summary");
    expect(JSON.stringify(imported)).not.toContain("private-imported-secret");
  });

  it("publishes change metadata without historical provider or annotation documents", () => {
    const projected = presentWireEvent({
      id: 1,
      connectionId: "synthetic-connection",
      transactionId: "synthetic-id",
      runId: "synthetic-run",
      type: "transaction.updated",
      createdAt: "2040-08-01T00:00:00Z",
      actor: "system",
      before: { privateSource: true },
      after: { privateAnnotation: true },
    });
    expect(projected).toEqual({
      id: 1,
      type: "transaction.updated",
      connectionId: "synthetic-connection",
      transactionId: "synthetic-id",
      syncRunId: "synthetic-run",
      createdAt: "2040-08-01T00:00:00Z",
      actor: "system",
    });
  });
});

describe("shared list and totals filters", () => {
  it("admits the same billing account and card identifier lengths as service records", () => {
    expect(
      pageSchema.safeParse({
        billingAccountId: "a".repeat(1024),
        cardId: "c".repeat(1024),
      }).success,
    ).toBe(true);
    expect(
      pageSchema.safeParse({ billingAccountId: "a".repeat(1025) }).success,
    ).toBe(false);
    expect(pageSchema.safeParse({ cardId: "c".repeat(1025) }).success).toBe(
      false,
    );
    for (const legacy of [{ accountKey: "account" }, { cardKey: "card" }]) {
      expect(pageSchema.safeParse(legacy).success).toBe(false);
    }
  });

  it("requires a date role and rejects reversed dates for both reads", () => {
    for (const schema of [pageSchema, totalsSchema]) {
      expect(schema.safeParse({ from: "2040-08-01" }).success).toBe(false);
      expect(
        schema.safeParse({
          dateRole: "booking",
          from: "2040-09-01",
          to: "2040-08-01",
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          dateRole: "billing",
          from: "2040-08-01",
          to: "2040-09-01",
          currency: "ILS",
          amountBasis: "purchase_commitment",
          billingAccountId: "synthetic-account",
          cardId: "synthetic-card",
        }).success,
      ).toBe(true);
    }
  });
});

describe("opaque list cursors", () => {
  it("round-trips a position only for the list kind that issued it", () => {
    const event = encodeCursor("event", Number.MAX_SAFE_INTEGER);
    expect(decodeCursor("event", event)).toBe(Number.MAX_SAFE_INTEGER);
    expect(event).toMatch(/^[A-Za-z0-9_-]+$/);
    const longId = "א".repeat(1024);
    for (const position of [
      ["2040-08-01", "synthetic-id"],
      [null, longId],
    ] satisfies [string | null, string][]) {
      const cursor = encodeKeyset("transactions", position);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(listCursorSchema.safeParse(cursor).success).toBe(true);
      expect(decodeKeyset("transactions", cursor)).toEqual(position);
      expect(() => decodeKeyset("cards", cursor)).toThrow();
    }
    expect(() =>
      decodeCursor("event", encodeKeyset("cards", ["2040", "id"])),
    ).toThrow();
    expect(() => decodeKeyset("cards", event)).toThrow();
  });

  it("rejects malformed, non-canonical and out-of-range cursors", () => {
    const valid = encodeKeyset("transactions", ["2040-08-01", "id"]);
    for (const cursor of [
      "",
      "not base64!",
      `${valid}=`,
      btoa(JSON.stringify(["transactions", "2040-02-30", "id"])),
      btoa(JSON.stringify(["transactions", "2040-08-01", ""])),
      btoa(JSON.stringify(["transactions", "2040-08-01"])),
      btoa(JSON.stringify({ kind: "transactions" })),
    ]) {
      expect(() => decodeKeyset("transactions", cursor)).toThrow();
    }
    for (const cursor of [
      "",
      btoa("event:01").replace(/=+$/, ""),
      btoa("event:-1").replace(/=+$/, ""),
      btoa("event:1"),
    ]) {
      expect(() => decodeCursor("event", cursor)).toThrow();
    }
  });
});

describe("refresh failure codes", () => {
  const refresh = {
    id: "synthetic-refresh",
    connectionId: "synthetic-connection",
    trigger: "manual" as const,
    status: "failed" as const,
    skipReason: null,
    range: null,
    occurrence: null,
    scheduledAt: null,
    createdAt: "2040-01-01T00:00:00.000Z",
    startedAt: "2040-01-01T00:00:00.000Z",
    finishedAt: "2040-01-01T00:01:00.000Z",
    requiresAttention: true,
    providerStopReason: "authentication_challenge" as const,
    hasAcceptedEvidence: false,
    counts: { ...emptyCounts(), failures: 2 },
    failureCodes: [
      "authentication_challenge" as const,
      "network_error" as const,
    ],
    failureReason: null,
    missed: null,
    windows: [],
  };

  it("publishes the codes in their one field and keeps the stop reason internal", () => {
    const wire = refreshSummaryOutputSchema.parse(presentRefresh(refresh));
    expect(wire.failureCodes).toEqual([
      "authentication_challenge",
      "network_error",
    ]);
    expect(wire).not.toHaveProperty("providerStopReason");
    expect(
      refreshSummaryOutputSchema.parse({
        ...wire,
        failureCodes: [...refreshFailureCodeSchema.options].sort(),
      }).failureCodes,
    ).toHaveLength(7);
  });

  it.each(["expired", "collection", "persistence", "Synthetic reason", ""])(
    "rejects %j, which is not a refresh failure code",
    (code) => {
      expect(
        refreshSummaryOutputSchema.safeParse({
          ...presentRefresh(refresh),
          failureCodes: [code],
        }).success,
      ).toBe(false);
    },
  );
});
