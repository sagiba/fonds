import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../../src/domain/model.js";
import {
  type IsracardCapture,
  isracardCardKey,
} from "../../../src/providers/isracard/capture.js";
import {
  mergeIsracardEvidence,
  projectIsracardState,
  retainIsracardEvidence,
} from "../../../src/providers/isracard/evidence.js";
import { extractIsracard } from "../../../src/providers/isracard/extract.js";

describe("Isracard retained evidence", () => {
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

  it("filters fresh extraction and projects old evidence identically", () => {
    const capture = JSON.parse(
      readFileSync(
        new URL("./fixtures/card-month.json", import.meta.url),
        "utf8",
      ),
    ) as IsracardCapture;
    const digital = JSON.parse(capture.responses.digital!) as {
      data: {
        israelAbroadVouchers: {
          vouchers: { israelAbroadVouchersList: JsonObject[] };
        };
      };
    };
    const first =
      digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[0]!;
    first.future = { nested: true };
    first.discountAmount = { nested: true };
    capture.responses.digital = JSON.stringify(digital);
    const result = extractIsracard(JSON.stringify(capture), {
      accountKey: isracardCardKey(capture.card),
      runId: "synthetic-run",
      scope: {
        kind: capture.mode,
        month: capture.billingMonth,
        cardKey: isracardCardKey(capture.card),
      },
    });
    expect(result.transactions.length).toBeGreaterThan(0);
    const namespace = result.transactions[0]!.details.provider.isracard!;
    expect(JSON.stringify(namespace)).not.toContain("nested");
    const rows = namespace.rows as JsonObject[];
    const legacy = {
      ...namespace,
      rows: rows.map((row) => ({ ...row, future: { nested: true } })),
      billingMonth: "2040-08",
    };
    expect(retainIsracardEvidence(legacy)).toEqual(
      retainIsracardEvidence(namespace),
    );
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
    expect(
      mergeIsracardEvidence(mergeIsracardEvidence(merged, first), second),
    ).toEqual(merged);
    const correction = mergeIsracardEvidence(merged, {
      rows: [digital("2", "21"), digital("2", "21")],
    });
    expect(correction.rows).toHaveLength(4);
    expect(correction.rows).toContainEqual(digital("2", "21"));
    expect(correction.rows).not.toContainEqual(digital("2", "20"));
    expect(mergeIsracardEvidence(correction, first)).toEqual(correction);
  });

  it("keeps malformed containers and explicit null distinct from missing without nested noise", () => {
    expect(
      retainIsracardEvidence({ rows: { unknown: "discard" }, detail: null }),
    ).toEqual({ rows: {}, detail: null });
    expect(retainIsracardEvidence({ rows: [null, "malformed"] })).toEqual({
      rows: ["malformed", null],
    });
    expect(retainIsracardEvidence({})).toEqual({});
  });
});
