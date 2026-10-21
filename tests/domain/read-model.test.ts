import { describe, expect, it } from "vitest";

import {
  calculateTotals,
  inPerspective,
  type TotalRow,
} from "../../src/domain/read-model.js";

describe("spending total money roles", () => {
  it("preserves retirement, pending and nonspending-kind exclusion precedence", () => {
    const row: TotalRow = {
      status: "posted",
      amountBasis: "authorization",
      supersededById: null,
      presence: "seen",
      kind: "purchase",
      amountMinor: -100,
      currency: "ILS",
      identityStrength: "native",
      originalCurrency: null,
      fxFeeMinor: null,
      fxFeeCurrency: null,
    };
    const result = calculateTotals([
      { ...row, supersededById: "successor" },
      { ...row, presence: "removed" },
      { ...row, status: "pending" },
      { ...row, kind: "income" },
      { ...row, kind: "transfer" },
      row,
    ]);
    expect(result).toMatchObject({
      includedCount: 0,
      excludedCount: 6,
      excluded: {
        retiredOrRemoved: 2,
        pending: 1,
        transferOrIncome: 2,
        authorization: 1,
        unresolved: 0,
      },
    });
  });
  it.each(["pending", "posted"] as const)(
    "allows only booked and commitment money for source status %s",
    (status) => {
      const bases = [
        "booked_entry",
        "authorization",
        "purchase_commitment",
        "unknown",
      ] as const;
      const rows: TotalRow[] = bases.map((amountBasis) => ({
        status,
        amountBasis,
        supersededById: null,
        presence: "seen",
        kind: "purchase",
        amountMinor: -100,
        currency: "ILS",
        identityStrength: "native",
        originalCurrency: null,
        fxFeeMinor: null,
        fxFeeCurrency: null,
      }));
      const result = calculateTotals(rows);
      expect(result.totals.map((total) => total.amountBasis)).toEqual(
        status === "pending" ? [] : ["booked_entry", "purchase_commitment"],
      );
      expect(result.includedCount).toBe(status === "pending" ? 0 : 2);
      expect(result.excluded.pending).toBe(status === "pending" ? 4 : 0);
      expect(result.excluded.authorization).toBe(status === "pending" ? 0 : 1);
      expect(result.excluded.unresolved).toBe(status === "pending" ? 0 : 1);
    },
  );
});

describe("perspectives", () => {
  const roles = {
    // Both facts null: SQL's NOT (count >= 2 AND number IS NULL) is NULL here.
    unknownCount: {
      purchaseId: null,
      installmentCount: null,
      installmentNumber: null,
    },
    singlePayment: {
      purchaseId: null,
      installmentCount: 1,
      installmentNumber: null,
    },
    zeroCount: {
      purchaseId: null,
      installmentCount: 0,
      installmentNumber: null,
    },
    planPurchase: {
      purchaseId: null,
      installmentCount: 3,
      installmentNumber: null,
    },
    billedLine: {
      purchaseId: "plan",
      installmentCount: 3,
      installmentNumber: 2,
    },
    standaloneLine: {
      purchaseId: null,
      installmentCount: 3,
      installmentNumber: 2,
    },
  };

  it.each([
    ["unknownCount", true, true],
    ["singlePayment", true, true],
    ["zeroCount", true, true],
    ["planPurchase", true, false],
    ["billedLine", false, true],
    ["standaloneLine", true, true],
  ] as const)("places a %s row by its own facts", (role, spending, billing) => {
    expect(inPerspective(roles[role], "spending", false)).toBe(spending);
    expect(inPerspective(roles[role], "billing", false)).toBe(billing);
    expect(inPerspective(roles[role], "all", false)).toBe(true);
  });

  it("excludes a purchase with live billed lines even when its count is unknown", () => {
    expect(inPerspective(roles.unknownCount, "billing", true)).toBe(false);
    expect(inPerspective(roles.unknownCount, "spending", true)).toBe(true);
    expect(inPerspective(roles.unknownCount, "all", true)).toBe(true);
  });

  const row: TotalRow = {
    status: "posted",
    amountBasis: "purchase_commitment",
    supersededById: null,
    presence: "seen",
    kind: "purchase",
    amountMinor: -100,
    currency: "ILS",
    identityStrength: "native",
    originalCurrency: null,
    fxFeeMinor: null,
    fxFeeCurrency: null,
  };

  it("groups billing totals per currency and spending totals per basis", () => {
    const rows: TotalRow[] = [
      row,
      { ...row, amountBasis: "booked_entry", amountMinor: -50 },
      { ...row, currency: "USD", amountMinor: -7 },
    ];
    expect(calculateTotals(rows, "billing").totals).toEqual([
      { currency: "ILS", amountBasis: null, amountMinor: -150 },
      { currency: "USD", amountBasis: null, amountMinor: -7 },
    ]);
    expect(calculateTotals(rows, "spending").totals).toEqual([
      { currency: "ILS", amountBasis: "booked_entry", amountMinor: -50 },
      {
        currency: "ILS",
        amountBasis: "purchase_commitment",
        amountMinor: -100,
      },
      { currency: "USD", amountBasis: "purchase_commitment", amountMinor: -7 },
    ]);
  });

  it("sums published FX fees per currency and counts unknown converted fees", () => {
    const converted = { ...row, originalCurrency: "USD" };
    const result = calculateTotals([
      { ...converted, fxFeeMinor: -3, fxFeeCurrency: "ILS" },
      { ...converted, fxFeeMinor: -2, fxFeeCurrency: "ILS" },
      converted,
      // Same-currency rows are not converted; excluded rows never count.
      { ...row, originalCurrency: "ILS" },
      { ...converted, status: "pending" },
    ]);
    expect(result.fxFees).toEqual([{ currency: "ILS", amountMinor: -5 }]);
    expect(result.fxFeeUnknownCount).toBe(1);
  });
});
