import { describe, expect, it } from "vitest";

import { emptyDetails } from "../../../src/domain/model.js";
import {
  approvalPaymentContext,
  postedPaymentContext,
  retainedPaymentContext,
} from "../../../src/providers/isracard/enrichment.js";

describe("Isracard payment context evidence", () => {
  it("reinterprets only a retained detail bound to the current native observation", () => {
    const details = emptyDetails();
    details.provider.isracard = {
      rows: [
        { seqVoucherNumber: "SYNTHETIC-CURRENT", tranzacCodeType: "V" },
        { seqVoucherNumber: "SYNTHETIC-OLD", tranzacCodeType: "R" },
      ],
      identity: { currentRows: [0] },
      detail: { voucherNumberRatz: "SYNTHETIC-CURRENT", clearingData: "הוצג" },
    };
    const input = {
      status: "posted" as const,
      identityStrength: "native" as const,
      details,
    };
    expect(retainedPaymentContext(input)).toMatchObject({
      payment: {
        cardPresent: null,
        authorizationMethod: null,
        threeDSecureUsed: null,
      },
      issues: ["conflicting_payment_context"],
    });
    expect(
      retainedPaymentContext({ ...input, identityStrength: "ambiguous" }),
    ).toBeUndefined();
    expect(
      retainedPaymentContext({ ...input, status: "pending" }),
    ).toBeUndefined();
    details.provider.isracard.identity = { currentRows: [1] };
    expect(retainedPaymentContext(input)).toBeUndefined();
    details.provider.isracard.identity = { currentRows: [999] };
    expect(retainedPaymentContext(input)).toBeUndefined();
  });

  it.each(["U", "V", "T"])(
    "recognizes remote use from posted channel %s without a detail",
    (code) => {
      const issues: string[] = [];
      expect(
        postedPaymentContext(
          [{ tranzacCodeType: code, presentCard: false }],
          null,
          issues,
        ),
      ).toMatchObject({
        cardPresent: false,
        authorizationMethod: code === "T" ? undefined : "online",
        threeDSecureUsed: code === "V" ? true : undefined,
      });
      expect(issues).toEqual([]);
    },
  );

  it.each(["R", "H", null, "SYNTHETIC-UNKNOWN"])(
    "does not infer physical mode or wallet brand from generic channel %s and flags",
    (code) => {
      const issues: string[] = [];
      expect(
        postedPaymentContext(
          [
            {
              tranzacCodeType: code,
              presentCard: false,
              isWalletTransaction: true,
              isTransactionSecure: true,
            },
          ],
          null,
          issues,
        ),
      ).toEqual({
        cardPresent: undefined,
        authorizationMethod: undefined,
        wallet: undefined,
        threeDSecureUsed: undefined,
      });
      expect(issues).toEqual([]);
    },
  );

  it.each([
    ["הוצג", true, undefined],
    ["לא הוצג", false, "online"],
  ])(
    "interprets a bound Apple Pay detail saying %s independently of the digital false flag",
    (clearingData, cardPresent, authorizationMethod) => {
      const issues: string[] = [];
      expect(
        postedPaymentContext(
          [{ tranzacCodeType: "R", presentCard: false }],
          {
            clearingData,
            transactionType: "APPLE PAY",
            walletPayName: "APPLE PAY",
          },
          issues,
        ),
      ).toMatchObject({
        cardPresent,
        wallet: "apple_pay",
        authorizationMethod,
      });
      expect(issues).toEqual([]);
    },
  );

  it("uses a legacy-only detail's explicit online channel", () => {
    const issues: string[] = [];
    expect(
      postedPaymentContext(
        [],
        {
          dealCode: " V ",
          transactionType: "APPLE PAY",
          clearingData: "לא הוצג",
        },
        issues,
      ),
    ).toEqual({
      cardPresent: false,
      authorizationMethod: "online",
      wallet: "apple_pay",
      threeDSecureUsed: true,
    });
    expect(issues).toEqual([]);
  });

  it("flags conflicting source presence while retaining an undisputed wallet", () => {
    const issues: string[] = [];
    const result = postedPaymentContext(
      [{ presentCard: true }],
      { clearingData: "לא הוצג", walletPayName: "Apple Pay" },
      issues,
    );
    expect(result).toMatchObject({
      cardPresent: null,
      wallet: "apple_pay",
      authorizationMethod: null,
    });
    expect(issues).toContain("conflicting_payment_context");
  });

  it("does not discard a channel/presence contradiction", () => {
    const issues: string[] = [];
    expect(
      postedPaymentContext(
        [{ tranzacCodeType: "V" }],
        { clearingData: "הוצג" },
        issues,
      ),
    ).toMatchObject({
      cardPresent: null,
      authorizationMethod: null,
      threeDSecureUsed: null,
    });
    expect(issues).toContain("conflicting_payment_context");
  });

  it("keeps conflicting named wallets unknown", () => {
    const issues: string[] = [];
    expect(
      postedPaymentContext(
        [],
        { transactionType: "Apple Pay", walletPayName: "Google Pay" },
        issues,
      ).wallet,
    ).toBeNull();
    expect(issues).toContain("conflicting_payment_context");
  });

  it("flags incompatible explicit channels without losing their agreement on remote use", () => {
    const issues: string[] = [];
    expect(
      postedPaymentContext(
        [{ tranzacCodeType: "V" }],
        { transactionType: "טלפוני" },
        issues,
      ),
    ).toMatchObject({
      cardPresent: false,
      authorizationMethod: null,
      threeDSecureUsed: null,
    });
    expect(issues).toContain("conflicting_payment_context");
  });

  it("does not interpret an unknown presentation label as false", () => {
    expect(
      postedPaymentContext([], { clearingData: "Synthetic unknown label" }, [])
        .cardPresent,
    ).toBeUndefined();
  });

  it("reads a pending named wallet without treating numeric flags as posted booleans", () => {
    expect(
      approvalPaymentContext(
        {
          walletTypeDescription: "APPLE MC",
          isWalletTransaction: 0,
          isTransactionSecure: 0,
          tranzacCodeType: "R",
          securityIndicatorCode: "W",
        },
        [],
      ),
    ).toEqual({
      wallet: "apple_pay",
      cardPresent: undefined,
      authorizationMethod: undefined,
      threeDSecureUsed: undefined,
    });
  });

  it("uses a pending internet label without treating security code V as posted 3-D Secure", () => {
    expect(
      approvalPaymentContext(
        {
          tranzacCodeType: "10",
          tranzacCodeDescription: "אינטרנט",
          securityIndicatorCode: "V",
          securityIndicatorDescription: "עסקת אינטרנט",
          isWalletTransaction: 1,
          isTransactionSecure: 1,
        },
        [],
      ),
    ).toEqual({
      cardPresent: false,
      authorizationMethod: "online",
      wallet: undefined,
      threeDSecureUsed: undefined,
    });
  });

  it("keeps generic pending wallet and security descriptions uninterpreted", () => {
    expect(
      approvalPaymentContext(
        {
          securityIndicatorCode: "V",
          isWalletTransaction: true,
          isTransactionSecure: true,
          securityIndicatorDescription: "עסקה שבוצעה עם הארנק הדיגיטלי",
        },
        [],
      ),
    ).toEqual({
      cardPresent: undefined,
      authorizationMethod: undefined,
      wallet: undefined,
      threeDSecureUsed: undefined,
    });
  });
});
