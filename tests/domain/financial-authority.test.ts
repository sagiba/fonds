import { describe, expect, it } from "vitest";

import {
  emptyDetails,
  type TransactionFacts,
  unknownLedgerFacts,
} from "../../src/domain/model.js";
import { reconcileFinancialBundle } from "../../src/domain/plans/financial-authority.js";
import type { Transaction } from "../../src/domain/records.js";

function facts(patch: Partial<TransactionFacts> = {}): TransactionFacts {
  return {
    ...unknownLedgerFacts("synthetic-card"),
    sourceScope: "synthetic-account",
    sourceKey: "synthetic-source",
    sourceAliases: [],
    identityStrength: "native",
    status: "posted",
    description: "Current description",
    counterpartyName: null,
    kind: "purchase",
    merchantName: "Synthetic merchant",
    merchantProviderId: null,
    merchantCategoryCode: null,
    transactionDate: "2040-07-01",
    bookingDate: null,
    billingDate: null,
    amountMinor: -1000,
    currency: "ILS",
    amountBasis: "purchase_commitment",
    originalAmountMinor: -1100,
    originalCurrency: "ILS",
    installmentCount: null,
    details: emptyDetails(),
    ...patch,
  };
}

function previous(patch: Partial<Transaction> = {}): Transaction {
  return {
    ...facts(),
    ...unknownLedgerFacts("synthetic-card"),
    id: "synthetic-id",
    connectionId: "synthetic-connection",
    presence: "seen",
    firstSeenAt: "2040-07-01T00:00:00.000Z",
    lastSeenAt: "2040-07-01T00:00:00.000Z",
    lastSeenRunId: "supported",
    version: 1,
    supersededById: null,
    sourceEvidence: {
      financial: {
        runId: "supported",
        capturedAt: "2040-07-01T00:00:00.000Z",
        continuitySignature: "same-source-component",
      },
    },
    ...patch,
  };
}

function partial(patch: Partial<TransactionFacts> = {}): TransactionFacts {
  return facts({
    kind: "unknown",
    amountBasis: "unknown",
    originalAmountMinor: null,
    originalCurrency: null,
    ...patch,
  });
}

const receipt = { runId: "newer", capturedAt: "2040-07-02T00:00:00.000Z" };
const incomplete = {
  kind: "incomplete" as const,
  reason: "missing_required_auxiliary",
  continuitySignature: "same-source-component",
};

describe("atomic financial authority", () => {
  it("retains the whole supported financial interpretation but accepts current nonfinancial display facts", () => {
    const before = previous({
      fxFeeMinor: -100,
      fxFeeCurrency: "ILS",
      providerTransactionCode: "supported-code",
    });
    const result = reconcileFinancialBundle({
      previous: before,
      input: partial({
        merchantName: "Fresh merchant",
        description: "Fresh description",
        counterpartyName: "Fresh counterparty",
      }),
      authority: incomplete,
      receipt,
      retainEligible: true,
    });
    expect(result).toMatchObject({
      retained: true,
      stale: false,
      financialReceipt: before.sourceEvidence!.financial,
      facts: {
        kind: "purchase",
        amountBasis: "purchase_commitment",
        amountMinor: -1000,
        currency: "ILS",
        originalAmountMinor: -1100,
        originalCurrency: "ILS",
        fxFeeMinor: -100,
        fxFeeCurrency: "ILS",
        providerTransactionCode: "supported-code",
        merchantName: "Fresh merchant",
        description: "Fresh description",
        counterpartyName: "Fresh counterparty",
      },
    });
    expect(result.facts.details.issues).toContain(
      "retained_financial_evidence",
    );
  });

  it.each([
    { amountMinor: -1001 },
    { currency: "USD" },
    { kind: "refund" as const },
    { amountBasis: "booked_entry" as const },
    { originalAmountMinor: -1200, originalCurrency: "ILS" },
    { fxFeeMinor: -20, fxFeeCurrency: "USD" },
    { providerTransactionCode: "changed-code" },
    { installmentCount: 3 },
    { installmentNumber: 1 },
    { purchaseId: "different-purchase" },
    { transactionDate: "2040-06-30" },
    { cardId: "different-card" },
    { status: "pending" as const },
    { amountMinor: null, currency: null },
    { identityStrength: "ambiguous" as const },
  ])(
    "does not mix old support into contradictory or unbound incomplete facts %j",
    (patch) => {
      const input = partial(patch);
      const result = reconcileFinancialBundle({
        previous: previous(),
        input,
        authority: incomplete,
        receipt,
        retainEligible: true,
      });
      expect(result).toMatchObject({
        retained: false,
        financialReceipt: undefined,
        facts: { ...input, amountBasis: "unknown" },
      });
    },
  );

  it("requires the same positive component signature and explicit incompleteness", () => {
    for (const authority of [
      { kind: "asserted" as const },
      { kind: "conflicting" as const },
      { kind: "incomplete" as const, reason: "missing_required_auxiliary" },
      { ...incomplete, continuitySignature: "changed-source-component" },
    ]) {
      expect(
        reconcileFinancialBundle({
          previous: previous(),
          input: partial(),
          authority,
          receipt,
          retainEligible: true,
        }),
      ).toMatchObject({ retained: false, financialReceipt: undefined });
    }
  });

  it("does not accept an unasserted bundle merely because its individual assertions are populated", () => {
    for (const authority of [incomplete, { kind: "conflicting" as const }]) {
      const result = reconcileFinancialBundle({
        input: facts(),
        authority,
        receipt,
        retainEligible: true,
      });
      expect(result).toMatchObject({
        retained: false,
        financialReceipt: undefined,
        facts: { amountBasis: "unknown" },
      });
    }
  });

  it("clears accepted support for an explicit unknown classification even when a basis is present", () => {
    expect(
      reconcileFinancialBundle({
        previous: previous(),
        input: facts({ kind: "unknown" }),
        authority: { kind: "asserted" },
        receipt,
        retainEligible: true,
      }),
    ).toMatchObject({
      retained: false,
      financialReceipt: undefined,
      facts: { kind: "unknown" },
    });
  });

  it("cannot revive support from an unresolved intervening snapshot", () => {
    const unresolved = previous({
      kind: "unknown",
      amountBasis: "unknown",
      sourceEvidence: undefined,
    });
    expect(
      reconcileFinancialBundle({
        previous: unresolved,
        input: partial(),
        authority: incomplete,
        previousAuthority: {
          kind: "asserted",
          continuitySignature: "same-source-component",
        },
        receipt,
        retainEligible: true,
      }),
    ).toMatchObject({ retained: false, financialReceipt: undefined });
  });

  it("keeps legacy accepted support without inventing its receipt", () => {
    const legacy = previous({ sourceEvidence: undefined });
    expect(
      reconcileFinancialBundle({
        previous: legacy,
        input: partial(),
        authority: incomplete,
        previousAuthority: {
          kind: "asserted",
          continuitySignature: "same-source-component",
        },
        receipt,
        retainEligible: true,
      }),
    ).toMatchObject({
      retained: true,
      financialReceipt: undefined,
      facts: { kind: "purchase", amountBasis: "purchase_commitment" },
    });
  });

  it("does not mistake independent context uncertainty for contradictory money", () => {
    const before = previous();
    before.details.issues = [
      "conflicting_payment_context",
      "conflicting_billing_date",
      "ambiguous_transaction_detail",
    ];
    const input = partial();
    input.details.issues = [
      ...before.details.issues,
      "invalid_transaction_detail",
    ];
    expect(
      reconcileFinancialBundle({
        previous: before,
        input,
        authority: incomplete,
        receipt,
        retainEligible: true,
      }),
    ).toMatchObject({
      retained: true,
      facts: { kind: "purchase", amountBasis: "purchase_commitment" },
    });
  });

  it("does not retain legacy conflicted support or bypass caller eligibility", () => {
    for (const issue of [
      "conflicting_installment_restatement",
      "conflicting_installment_lines",
      "ambiguous_identity",
    ]) {
      const before = previous();
      before.details.issues = [issue];
      expect(
        reconcileFinancialBundle({
          previous: before,
          input: partial(),
          authority: incomplete,
          receipt,
          retainEligible: true,
        }).retained,
      ).toBe(false);
    }
    expect(
      reconcileFinancialBundle({
        previous: previous(),
        input: partial(),
        authority: incomplete,
        receipt,
        retainEligible: false,
      }).retained,
    ).toBe(false);
  });

  it("accepts genuinely supported corrections and records their current receipt", () => {
    const input = facts({ amountMinor: -2000, originalAmountMinor: -2000 });
    expect(
      reconcileFinancialBundle({
        previous: previous(),
        input,
        authority: {
          kind: "asserted",
          continuitySignature: "corrected-component",
        },
        receipt,
        retainEligible: true,
      }),
    ).toMatchObject({
      retained: false,
      facts: input,
      financialReceipt: {
        ...receipt,
        continuitySignature: "corrected-component",
      },
    });
  });

  it("accepts caller-approved current source priority over a later historical import", () => {
    const before = previous({ lastSeenAt: "2040-07-03T00:00:00.000Z" });
    const input = facts({ amountMinor: -2000, originalAmountMinor: -2000 });
    expect(
      reconcileFinancialBundle({
        previous: before,
        input,
        authority: { kind: "asserted" },
        receipt,
        retainEligible: true,
        currentOverHistorical: true,
      }),
    ).toMatchObject({
      stale: false,
      retained: false,
      facts: input,
      financialReceipt: receipt,
    });
  });

  it.each(["2040-06-30T00:00:00.000Z", "2040-07-03T00:00:00.000Z"])(
    "never turns historical support into retained current money at %s",
    (capturedAt) => {
      const before = previous();
      expect(
        reconcileFinancialBundle({
          previous: before,
          input: partial(),
          authority: incomplete,
          receipt: { ...receipt, capturedAt },
          retainEligible: true,
          currentOverHistorical: true,
        }),
      ).toMatchObject({
        stale: false,
        retained: false,
        facts: { kind: "unknown", amountBasis: "unknown" },
        financialReceipt: undefined,
      });
    },
  );

  it("still rejects an older asserted current observation without source-priority acceptance", () => {
    const before = previous();
    expect(
      reconcileFinancialBundle({
        previous: before,
        input: facts({ amountMinor: -2000 }),
        authority: { kind: "asserted" },
        receipt: { ...receipt, capturedAt: "2040-06-30T00:00:00.000Z" },
        retainEligible: true,
      }),
    ).toMatchObject({
      stale: true,
      retained: false,
      facts: before,
      financialReceipt: before.sourceEvidence?.financial,
    });
  });

  it("rejects older financial observations without replacing facts or support", () => {
    const before = previous();
    for (const capturedAt of ["2040-06-30T00:00:00.000Z"]) {
      const result = reconcileFinancialBundle({
        previous: before,
        input: partial({ amountMinor: -2000 }),
        authority: incomplete,
        receipt: { runId: "stale", capturedAt },
        retainEligible: true,
      });
      expect(result).toMatchObject({
        stale: true,
        retained: false,
        facts: before,
        financialReceipt: before.sourceEvidence!.financial,
      });
    }
  });
});
