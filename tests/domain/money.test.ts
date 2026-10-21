import { describe, expect, it } from "vitest";

import {
  decimalToMinor,
  isSupportedCurrency,
  minorToDecimal,
  sumMinor,
} from "../../src/domain/money.js";

describe("exact minor-unit conversion", () => {
  it.each([
    ["125.50", "ILS", 12_550],
    ["-125.50", "USD", -12_550],
    ["0.29", "EUR", 29],
    ["1.2300", "USD", 123],
    [".5", "USD", 50],
    ["2.9e-1", "EUR", 29],
    ["1e3", "JPY", 1_000],
    ["-1.234", "KWD", -1_234],
    ["-0.0000", "ILS", 0],
    ["90071992547409.91", "USD", Number.MAX_SAFE_INTEGER],
    ["-90071992547409.91", "USD", -Number.MAX_SAFE_INTEGER],
  ])("converts %s %s to exact minor units", (decimal, currency, expected) => {
    expect(decimalToMinor(decimal, currency)).toBe(expected);
  });

  it.each(["1.001", "0.0001", "1e-3"])(
    "rejects unsupported USD precision: %s",
    (decimal) => {
      expect(() => decimalToMinor(decimal, "USD")).toThrow(/precision/);
    },
  );

  it("uses each supported currency scale", () => {
    expect(() => decimalToMinor("1.1", "JPY")).toThrow(/precision/);
    expect(() => decimalToMinor("1.2345", "KWD")).toThrow(/precision/);
    expect(() => decimalToMinor("1", "ZZZ")).toThrow(/Unsupported currency/);
    expect(() => decimalToMinor("1", "toString")).toThrow(
      /Unsupported currency/,
    );
  });

  it.each([
    [
      "two-decimal",
      [
        "HRK",
        "TRY",
        "BAM",
        "GBP",
        "HUF",
        "CZK",
        "HKD",
        "MXN",
        "THB",
        "CHF",
        "UAH",
        "CAD",
        "PLN",
        "AUD",
        "SEK",
      ],
      "42.75",
      "-0.01",
      "42.751",
    ],
    [
      "zero-decimal",
      ["JPY", "KRW", "VND", "BIF", "CLP", "ISK", "RWF", "UGX"],
      "4275.000",
      "-1",
      "42.75",
    ],
    ["three-decimal", ["JOD"], "4.275", "-0.001", "4.2751"],
  ] as const)(
    "uses verified %s minor units without rounding",
    (_scale, currencies, positive, negative, excessive) => {
      for (const currency of currencies) {
        expect(decimalToMinor(positive, currency), currency).toBe(4275);
        expect(decimalToMinor(negative, currency), currency).toBe(-1);
        expect(() => decimalToMinor(excessive, currency), currency).toThrow(
          /precision/,
        );
      }
    },
  );

  it.each(["BHD", "IQD", "LYD", "OMR", "TND"])(
    "uses ISO three-decimal minor units for %s without rounding",
    (currency) => {
      expect(isSupportedCurrency(currency)).toBe(true);
      expect(decimalToMinor("-4.275", currency)).toBe(-4275);
      expect(minorToDecimal(4275, currency)).toBe("4.275");
      expect(() => decimalToMinor("4.2751", currency)).toThrow(/precision/);
    },
  );

  it.each(["CLF", "UYW"])(
    "uses ISO four-decimal minor units for %s without rounding",
    (currency) => {
      expect(isSupportedCurrency(currency)).toBe(true);
      expect(decimalToMinor("-4.2751", currency)).toBe(-42751);
      expect(minorToDecimal(-42751, currency)).toBe("-4.2751");
      expect(() => decimalToMinor("4.27511", currency)).toThrow(/precision/);
      expect(decimalToMinor("900719925474.0991", currency)).toBe(
        Number.MAX_SAFE_INTEGER,
      );
      expect(() => decimalToMinor("900719925474.0992", currency)).toThrow(
        /range/,
      );
    },
  );

  it.each([
    "XAG",
    "XAU",
    "XBA",
    "XBB",
    "XBC",
    "XBD",
    "XDR",
    "XPD",
    "XPT",
    "XSU",
    "XTS",
    "XUA",
    "XXX",
  ])(
    "rejects ISO code %s with no defined numeric minor-unit precision",
    (currency) => {
      expect(isSupportedCurrency(currency)).toBe(false);
      expect(() => decimalToMinor("1", currency)).toThrow(
        /Unsupported currency/,
      );
      expect(() => minorToDecimal(1, currency)).toThrow(/Unsupported currency/);
    },
  );

  it.each(["90071992547409.92", "-90071992547409.92", "1e1000000"])(
    "rejects out-of-range values: %s",
    (decimal) => {
      expect(() => decimalToMinor(decimal, "USD")).toThrow(/range/);
    },
  );

  it.each(["", " 1", "1 ", "NaN", "Infinity", "1,200", "1/2", "0x10"])(
    "rejects malformed decimal strings: %s",
    (decimal) => {
      expect(() => decimalToMinor(decimal, "USD")).toThrow(/decimal string/);
    },
  );
});

describe("exact totals", () => {
  it("sums safely even when an intermediate result exceeds JavaScript integer precision", () => {
    expect(
      sumMinor([Number.MAX_SAFE_INTEGER, 2, -Number.MAX_SAFE_INTEGER]),
    ).toBe(2);
    expect(sumMinor(new Set([-29, -71]))).toBe(-100);
    expect(sumMinor([])).toBe(0);
  });

  it("rejects unsafe totals and non-integer inputs", () => {
    expect(() => sumMinor([Number.MAX_SAFE_INTEGER, 1])).toThrow(/range/);
    expect(() => sumMinor([0.1])).toThrow(/safe integers/);
    expect(() => sumMinor([Number.MAX_SAFE_INTEGER + 1])).toThrow(
      /safe integers/,
    );
    expect(() => sumMinor([NaN])).toThrow(/safe integers/);
  });
});

describe("exact decimal wire formatting", () => {
  it.each([
    [-1, "USD", "-0.01"],
    [0, "USD", "0.00"],
    [12550, "ILS", "125.50"],
    [-1234, "KWD", "-1.234"],
    [1234, "JPY", "1234"],
    [4275, "PLN", "42.75"],
    [-4275, "AUD", "-42.75"],
    [4275, "SEK", "42.75"],
    [1, "CLF", "0.0001"],
    [-1, "UYW", "-0.0001"],
    [Number.MAX_SAFE_INTEGER, "CLF", "900719925474.0991"],
    [Number.MAX_SAFE_INTEGER, "USD", "90071992547409.91"],
    [-Number.MAX_SAFE_INTEGER, "KWD", "-9007199254740.991"],
  ])("formats %s %s without precision loss", (minor, currency, expected) => {
    expect(minorToDecimal(minor, currency)).toBe(expected);
    expect(decimalToMinor(minorToDecimal(minor, currency), currency)).toBe(
      minor,
    );
  });

  it("rejects unsupported currencies and unsafe minor units", () => {
    expect(() => minorToDecimal(1, "ZZZ")).toThrow(/Unsupported currency/);
    expect(() => minorToDecimal(0.1, "USD")).toThrow(/safe integers/);
    expect(() => minorToDecimal(Number.MAX_SAFE_INTEGER + 1, "USD")).toThrow(
      /safe integers/,
    );
  });
});
