import { describe, expect, it } from "vitest";

import {
  mergeIsracardEvidence,
  projectIsracardState,
  retainIsracardEvidence,
} from "../../../src/providers/isracard/evidence.js";

describe("Isracard retained evidence", () => {
  it("keeps approval classification and merchant facts without request or holder metadata", () => {
    const identity = {
      confirmationLocation: "23",
      seqConfirmationNumber: "SYNTHETIC-APPROVAL",
      confirmationTimeStamp: "opaque:synthetic:identity",
    };
    const facts = {
      walletType: "SYNTHETIC-WALLET-CODE",
      walletTypeDescription: "Synthetic wallet label",
      securityIndicatorCode: "SYNTHETIC-SECURITY-CODE",
      securityIndicatorDescription: "Synthetic security label",
      tranzacCodeDescription: "Synthetic channel label",
      branchCodeType: "42",
      clearedCode: "SYNTHETIC-ACQUIRER",
      clearedDescription: "Synthetic acquirer label",
      cityDescription: "Invented City",
      country: "SYNTHETIC-COUNTRY-CODE",
      countryCode: "ISR",
      countryDesc: "Synthetic country label",
      currencyName: "Synthetic currency label",
      creditFromBusiness: "2",
      creditOrCharge: "3",
      directDebit: "0",
    };
    expect(
      retainIsracardEvidence({
        rows: [
          {
            ...identity,
            ...facts,
            cardSuffix: "9999",
            cardName: "Synthetic duplicate card context",
            requestNumber: "request-1",
            refreshedAt: "2040-07-01T00:00:00Z",
            extraDetails: { generatedAt: "2040-07-01T00:00:00Z" },
            unknownField: "noise",
          },
        ],
      }),
    ).toEqual({ rows: [{ ...identity, ...facts }] });
  });

  it("keeps descriptive detail slots while excluding UI controls and holder context", () => {
    const facts = {
      voucherNumberRatz: "SYNTHETIC-VOUCHER",
      wayOfDeal: "Synthetic payment method",
      horaatKevaDesc: null,
      reasonOfTransaction: "Synthetic transaction explanation",
      websiteName: "merchant.example",
    };
    expect(
      retainIsracardEvidence({
        detail: {
          ...facts,
          info: "Synthetic holder context",
          sumOfCompensation: "Synthetic system-code label",
          canOrder: "1",
          isShowPaymentsTable: "yes",
          requestNumber: "request-1",
          selectedDate: "2040-07-01",
          tablePageNum: "0",
          future: { timestamp: "noise" },
        },
      }),
    ).toEqual({ detail: facts });
    expect(
      retainIsracardEvidence({
        detail: {
          ...facts,
          wayOfDeal: { changedAt: "2040-07-01", future: "noise" },
        },
      }),
    ).toEqual({ detail: { ...facts, wayOfDeal: {} } });
  });

  it("uses matching legacy row copies to preserve recorded origins despite opposite-family source noise", () => {
    const digital = {
      seqVoucherNumber: "DIGITAL-ID",
      billingAmount: "10.00",
      billingAmountCurrency: "0",
      transactionCode: "1",
      businessName: "Synthetic digital",
      voucherNumberRatz: "UPSTREAM-NOISE",
      generation: "legacy",
      nestedNoise: { origin: "legacy" },
    };
    const legacy = {
      voucherNumberRatz: "LEGACY-ID",
      paymentSum: "11.00",
      currencyId: "ILS",
      fullSupplierNameHeb: "Synthetic legacy",
      seqVoucherNumber: "UPSTREAM-NOISE",
      generation: "digital",
    };
    const namespace = {
      rows: [digital, legacy, digital],
      observations: [
        { generation: "legacy", path: "legacy-source", row: legacy },
        {
          generation: "digital",
          path: "digital-source-2",
          row: Object.fromEntries(Object.entries(digital).reverse()),
        },
        { generation: "digital", path: "digital-source-1", row: digital },
      ],
    };
    const evidence = retainIsracardEvidence(namespace);
    expect(evidence.rows).toEqual([
      {
        seqVoucherNumber: "DIGITAL-ID",
        billingAmount: "10.00",
        billingAmountCurrency: "0",
        transactionCode: "1",
        businessName: "Synthetic digital",
      },
      {
        seqVoucherNumber: "DIGITAL-ID",
        billingAmount: "10.00",
        billingAmountCurrency: "0",
        transactionCode: "1",
        businessName: "Synthetic digital",
      },
      {
        voucherNumberRatz: "LEGACY-ID",
        paymentSum: "11.00",
        currencyId: "ILS",
        fullSupplierNameHeb: "Synthetic legacy",
      },
    ]);
    expect(
      retainIsracardEvidence({
        ...namespace,
        rows: [...namespace.rows].reverse(),
        observations: [...namespace.observations].reverse(),
      }),
    ).toEqual(evidence);
    expect(JSON.stringify(evidence)).not.toContain("UPSTREAM-NOISE");
    expect(JSON.stringify(projectIsracardState(namespace))).not.toContain(
      "DIGITAL-ID",
    );
  });

  it("pairs identical legacy occurrences once each across different recorded origins", () => {
    const source = {
      seqVoucherNumber: "DUAL-ID",
      voucherNumberRatz: "DUAL-ID",
      billingAmount: "10.00",
      paymentSum: "10.00",
      businessName: "Synthetic digital",
      fullSupplierNameHeb: "Synthetic legacy",
    };
    const namespace = {
      rows: [source, source, source],
      observations: [
        { generation: "legacy", row: source },
        { generation: "digital", row: source },
        { generation: "digital", row: source },
      ],
    };
    expect(retainIsracardEvidence(namespace).rows).toEqual([
      {
        seqVoucherNumber: "DUAL-ID",
        billingAmount: "10.00",
        businessName: "Synthetic digital",
      },
      {
        seqVoucherNumber: "DUAL-ID",
        billingAmount: "10.00",
        businessName: "Synthetic digital",
      },
      {
        voucherNumberRatz: "DUAL-ID",
        paymentSum: "10.00",
        fullSupplierNameHeb: "Synthetic legacy",
      },
    ]);
  });

  it("does not zip sorted v3 rows with observation metadata that has no copied source statements", () => {
    const digital = {
      seqVoucherNumber: "DIGITAL-ID",
      billingAmount: "10.00",
      transactionCode: "1",
      businessName: "Synthetic digital",
    };
    const legacy = {
      voucherNumberRatz: "LEGACY-ID",
      paymentSum: "11.00",
      fullSupplierNameHeb: "Synthetic legacy",
    };
    expect(
      retainIsracardEvidence({
        rows: [digital, legacy],
        observations: [{ generation: "legacy" }, { generation: "digital" }],
      }),
    ).toEqual({ rows: [digital, legacy] });
  });
  it("keeps voucher layouts when old raw rows contain unrelated approval-looking fields", () => {
    expect(
      retainIsracardEvidence({
        rows: [
          {
            voucherNumberRatz: "0017",
            paymentSum: "10.00",
            currencyId: "ILS",
            currencyIso: "UNDECLARED-APPROVAL-CONTEXT",
          },
        ],
      }),
    ).toEqual({
      rows: [
        { voucherNumberRatz: "0017", paymentSum: "10.00", currencyId: "ILS" },
      ],
    });
    expect(
      retainIsracardEvidence({
        rows: [
          {
            seqVoucherNumber: "0017",
            billingAmount: "10.00",
            billingAmountCurrency: "0",
            confirmationNumber: "UNDECLARED-APPROVAL-CONTEXT",
          },
        ],
      }),
    ).toEqual({
      rows: [
        {
          seqVoucherNumber: "0017",
          billingAmount: "10.00",
          billingAmountCurrency: "0",
        },
      ],
    });
  });
  it("retains the approval identity and money lexemes without falling through to voucher fields", () => {
    expect(
      retainIsracardEvidence({
        rows: [
          {
            confirmationLocation: "17",
            seqConfirmationNumber: "0001701",
            confirmationTimeStamp: "opaque:000:01",
            confirmationNumber: "display:001",
            businessName: "Synthetic approval",
            purchaseDate: "11/06/2040",
            currencyIso: "USD",
            originalAmount: "0.2900",
            extraDetails: { nestedNoise: true },
            future: { nestedNoise: true },
          },
        ],
      }),
    ).toEqual({
      rows: [
        {
          confirmationLocation: "17",
          seqConfirmationNumber: "0001701",
          confirmationTimeStamp: "opaque:000:01",
          confirmationNumber: "display:001",
          businessName: "Synthetic approval",
          purchaseDate: "11/06/2040",
          currencyIso: "USD",
          originalAmount: "0.2900",
        },
      ],
    });
  });
  it("keeps derived state separate without duplicating source rows", () => {
    expect(
      projectIsracardState({
        identity: {
          baseKey: "synthetic-base",
          occurrenceCount: 1,
          currentRows: [2, 0],
          noise: "discard",
        },
        observations: [
          {
            generation: "digital",
            path: "capture-path",
            row: { billingAmount: "10" },
            unknown: "discard",
          },
        ],
        monetaryEvidence: {
          statedTotals: [["ILS", 1000], null],
          convention: "derived",
          unknown: "discard",
        },
        billingMonth: "2040-07",
        rows: [{ billingAmount: "10" }],
        unknown: "discard",
      }),
    ).toEqual({
      identity: {
        baseKey: "synthetic-base",
        occurrenceCount: 1,
        currentRows: [2, 0],
      },
      observations: [{ generation: "digital", path: "capture-path" }],
      monetaryEvidence: {
        statedTotals: [["ILS", 1000], null],
        convention: "derived",
      },
      billingMonth: "2040-07",
    });
  });
  it("keeps only recursively declared rows and detail fields", () => {
    const source = {
      rows: [
        {
          seqVoucherNumber: "SYNTHETIC-1",
          billingAmount: "0.2900",
          discountAmount: null,
          future: { nested: true },
          presentCard: { future: "noise" },
        },
      ],
      detail: {
        voucherNumberRatz: "SYNTHETIC-1",
        numberOfPayments: "2",
        commissionNetValue: null,
        Table1: [
          { paymentNumber: "1", paymentSum: "0.2900", noise: { nested: true } },
        ],
        future: { nested: true },
      },
      identity: { baseKey: "derived" },
      observations: [{ path: "capture-path", generation: "digital" }],
      billingMonth: "2040-07",
      monetaryEvidence: { convention: "derived" },
    };
    expect(retainIsracardEvidence(source)).toEqual({
      rows: [
        {
          seqVoucherNumber: "SYNTHETIC-1",
          billingAmount: "0.2900",
          discountAmount: null,
          presentCard: {},
        },
      ],
      detail: {
        voucherNumberRatz: "SYNTHETIC-1",
        numberOfPayments: "2",
        commissionNetValue: null,
        Table1: [{ paymentNumber: "1", paymentSum: "0.2900" }],
      },
    });
  });

  it("retains both source generations across alternating scopes and replaces a changed component", () => {
    const digital = (voucher: string, amount: string) => ({
      seqVoucherNumber: voucher,
      purchaseDate: "01/06/2040",
      billingAmount: amount,
    });
    const legacy = {
      voucherNumberRatz: "1",
      fullPurchaseDate: "01/06/2040",
      paymentSum: "10",
    };
    const first = {
      rows: [digital("1", "10"), legacy],
      detail: { voucherNumberRatz: "1", walletPayName: "Apple Pay" },
    };
    const second = { rows: [digital("2", "20")] };
    const merged = mergeIsracardEvidence(first, second);
    expect(merged.rows).toHaveLength(3);
    expect(merged.detail).toEqual(first.detail);
    const correction = mergeIsracardEvidence(merged, {
      rows: [digital("2", "21"), digital("2", "21")],
    });
    expect(correction.rows).toHaveLength(4);
    expect(correction.rows).toContainEqual(digital("2", "21"));
    expect(correction.rows).not.toContainEqual(digital("2", "20"));
  });
  it("preserves malformed row array entries without nested noise", () => {
    expect(retainIsracardEvidence({ rows: [null, "malformed"] })).toEqual({
      rows: ["malformed", null],
    });
  });
});
