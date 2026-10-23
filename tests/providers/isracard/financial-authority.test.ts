import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  type TransactionFacts,
  unknownLedgerFacts,
} from "../../../src/domain/model.js";
import { isracardAdapter } from "../../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCardKey,
  serializeIsracardCapture,
} from "../../../src/providers/isracard/capture.js";

function baseline(): IsracardCapture {
  return JSON.parse(
    readFileSync(
      new URL("./fixtures/card-month.json", import.meta.url),
      "utf8",
    ),
  ) as IsracardCapture;
}

function declaration(capture: IsracardCapture) {
  const accountKey = isracardCardKey(capture.card);
  const result = isracardAdapter.extract(serializeIsracardCapture(capture), {
    accountKey,
    runId: "synthetic-run",
    scope: { kind: "recent", month: capture.billingMonth, cardKey: accountKey },
  });
  const input = result.transactions.find((row) =>
    row.sourceKey.includes("VOUCHER-1"),
  )!;
  const facts: TransactionFacts = {
    ...unknownLedgerFacts("synthetic-card"),
    ...input,
    counterpartyName: input.counterpartyName ?? null,
    installmentNumber: input.installmentNumber ?? null,
    providerTransactionCode: input.providerTransactionCode ?? null,
    fxFeeMinor: input.fxFeeMinor ?? null,
    fxFeeCurrency: input.fxFeeCurrency ?? null,
  };
  return {
    facts,
    authority: isracardAdapter.financialAuthority!(facts, result),
  };
}

function legacy(
  capture: IsracardCapture,
  patch: Record<string, unknown>,
): void {
  const response = JSON.parse(capture.responses.legacy!);
  Object.assign(
    response.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]
      .txnIsrael[0],
    patch,
  );
  capture.responses.legacy = JSON.stringify(response);
}

describe("Isracard ordinary financial component authority", () => {
  it("declares missing required DigitalV3 support without deriving original money or a kind from legacy", () => {
    const capture = baseline();
    const supported = declaration(capture);
    expect(supported.authority.kind).toBe("asserted");
    expect(supported.authority.continuitySignature).toBeDefined();
    delete capture.responses.digital;
    const incomplete = declaration(capture);
    expect(incomplete.authority).toEqual({
      kind: "incomplete",
      reason: "missing_required_digital_response",
      continuitySignature: supported.authority.continuitySignature,
    });
    expect(incomplete.facts).toMatchObject({
      kind: "unknown",
      amountBasis: "unknown",
      originalAmountMinor: null,
      originalCurrency: null,
    });
  });

  it.each([
    { paymentSum: 99 },
    { currencyId: "USD" },
    { dealSum: 99 },
    { currentPaymentCurrency: "USD" },
    { paymentSumSign: "-" },
    { voucherNumber: "changed-plan-identity" },
  ])(
    "changes the continuity signature for financial source evidence %j",
    (patch) => {
      const capture = baseline();
      const supported = declaration(capture);
      delete capture.responses.digital;
      legacy(capture, patch);
      const incomplete = declaration(capture);
      expect(incomplete.authority.continuitySignature).not.toBe(
        supported.authority.continuitySignature,
      );
    },
  );

  it("does not freeze merchant and display-only descriptions", () => {
    const capture = baseline();
    const supported = declaration(capture);
    delete capture.responses.digital;
    legacy(capture, {
      fullSupplierNameHeb: "Fresh synthetic name",
      supplierId: "Fresh merchant ID",
      city: "Fresh City",
      fullPaymentDate: "11/07/2040",
      isHoraatKeva: true,
    });
    expect(declaration(capture).authority.continuitySignature).toBe(
      supported.authority.continuitySignature,
    );
  });

  it("uses the surviving legacy component rather than requiring an optional detail to reappear", () => {
    const capture = baseline();
    const detail = JSON.parse(capture.responses.details![0]!.responseText);
    detail.PirteyIska_204Bean.dealCode = "1";
    detail.PirteyIska_204Bean.dealSum = "86.40";
    capture.responses.details![0]!.responseText = JSON.stringify(detail);
    const supported = declaration(capture);
    delete capture.responses.digital;
    delete capture.responses.details;
    expect(declaration(capture).authority).toEqual({
      kind: "incomplete",
      reason: "missing_required_digital_response",
      continuitySignature: supported.authority.continuitySignature,
    });
  });

  it("rejects a fresh bound detail's explicit installment role", () => {
    const capture = baseline();
    delete capture.responses.digital;
    const detail = JSON.parse(capture.responses.details![0]!.responseText);
    detail.PirteyIska_204Bean.paymentNumber = "1";
    detail.PirteyIska_204Bean.numberOfPayments = "3";
    capture.responses.details![0]!.responseText = JSON.stringify(detail);
    expect(declaration(capture).authority.kind).not.toBe("incomplete");
  });

  it("distinguishes a missing legacy companion from an unusable required DigitalV3 feed", () => {
    const missingLegacy = baseline();
    delete missingLegacy.responses.legacy;
    expect(declaration(missingLegacy).authority).toEqual({ kind: "asserted" });
    const invalidDigital = baseline();
    invalidDigital.responses.digital = JSON.stringify({
      isSuccess: false,
      data: null,
    });
    expect(declaration(invalidDigital).authority).toMatchObject({
      kind: "incomplete",
      reason: "invalid_digital_response",
    });
  });

  it("does not grant incomplete authority to an unresolved installment signal", () => {
    const capture = baseline();
    delete capture.responses.digital;
    legacy(capture, { moreInfo: "תשלום 1 מתוך 3" });
    const result = declaration(capture);
    expect(result.authority.kind).not.toBe("incomplete");
    expect(result.facts.amountBasis).toBe("unknown");
  });

  it("keeps an explicit unsupported DigitalV3 classification authoritative even in a partial capture", () => {
    const capture = baseline();
    const digital = JSON.parse(capture.responses.digital!);
    digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[0].transactionCode = 999;
    capture.responses.digital = JSON.stringify(digital);
    delete capture.responses.legacy;
    const result = declaration(capture);
    expect(result.authority.kind).toBe("asserted");
    expect(result.facts).toMatchObject({
      kind: "unknown",
      amountBasis: "unknown",
    });
  });
});
