// ISO 4217 Current Currency & Funds, SIX list-one.xml, Pblshd=2026-09-17.
// Retrieved 2026-10-18; 165 distinct codes with numeric minor-unit precision.
// Source: https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
// Source SHA-256: 33139b438657d1cee116ba737807ea71d19d6de4b90f799a09c56f0cc6a1b0ff
// Entries with N.A. minor units (including metals, XTS and XXX) are unsupported.
// HRK is the one explicit historical addition (2 minor digits, SIX Amendment 174):
// https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/amendments/dl-currency-iso-amendment-174.pdf
const currencyScales: Readonly<Record<string, number>> = {
  AED: 2,
  AFN: 2,
  ALL: 2,
  AMD: 2,
  AOA: 2,
  ARS: 2,
  AUD: 2,
  AWG: 2,
  AZN: 2,
  BAM: 2,
  BBD: 2,
  BDT: 2,
  BHD: 3,
  BIF: 0,
  BMD: 2,
  BND: 2,
  BOB: 2,
  BOV: 2,
  BRL: 2,
  BSD: 2,
  BTN: 2,
  BWP: 2,
  BYN: 2,
  BZD: 2,
  CAD: 2,
  CDF: 2,
  CHE: 2,
  CHF: 2,
  CHW: 2,
  CLF: 4,
  CLP: 0,
  CNY: 2,
  COP: 2,
  COU: 2,
  CRC: 2,
  CUP: 2,
  CVE: 2,
  CZK: 2,
  DJF: 0,
  DKK: 2,
  DOP: 2,
  DZD: 2,
  EGP: 2,
  ERN: 2,
  ETB: 2,
  EUR: 2,
  FJD: 2,
  FKP: 2,
  GBP: 2,
  GEL: 2,
  GHS: 2,
  GIP: 2,
  GMD: 2,
  GNF: 0,
  GTQ: 2,
  GYD: 2,
  HKD: 2,
  HNL: 2,
  HRK: 2,
  HTG: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  IQD: 3,
  IRR: 2,
  ISK: 0,
  JMD: 2,
  JOD: 3,
  JPY: 0,
  KES: 2,
  KGS: 2,
  KHR: 2,
  KMF: 0,
  KPW: 2,
  KRW: 0,
  KWD: 3,
  KYD: 2,
  KZT: 2,
  LAK: 2,
  LBP: 2,
  LKR: 2,
  LRD: 2,
  LSL: 2,
  LYD: 3,
  MAD: 2,
  MDL: 2,
  MGA: 2,
  MKD: 2,
  MMK: 2,
  MNT: 2,
  MOP: 2,
  MRU: 2,
  MUR: 2,
  MVR: 2,
  MWK: 2,
  MXN: 2,
  MXV: 2,
  MYR: 2,
  MZN: 2,
  NAD: 2,
  NGN: 2,
  NIO: 2,
  NOK: 2,
  NPR: 2,
  NZD: 2,
  OMR: 3,
  PAB: 2,
  PEN: 2,
  PGK: 2,
  PHP: 2,
  PKR: 2,
  PLN: 2,
  PYG: 0,
  QAR: 2,
  RON: 2,
  RSD: 2,
  RUB: 2,
  RWF: 0,
  SAR: 2,
  SBD: 2,
  SCR: 2,
  SDG: 2,
  SEK: 2,
  SGD: 2,
  SHP: 2,
  SLE: 2,
  SOS: 2,
  SRD: 2,
  SSP: 2,
  STN: 2,
  SVC: 2,
  SYP: 2,
  SZL: 2,
  THB: 2,
  TJS: 2,
  TMT: 2,
  TND: 3,
  TOP: 2,
  TRY: 2,
  TTD: 2,
  TWD: 2,
  TZS: 2,
  UAH: 2,
  UGX: 0,
  USD: 2,
  USN: 2,
  UYI: 0,
  UYU: 2,
  UYW: 4,
  UZS: 2,
  VED: 2,
  VES: 2,
  VND: 0,
  VUV: 0,
  WST: 2,
  XAD: 2,
  XAF: 0,
  XCD: 2,
  XCG: 2,
  XOF: 0,
  XPF: 0,
  YER: 2,
  ZAR: 2,
  ZMW: 2,
  ZWG: 2,
};

const maxSafeMinor = BigInt(Number.MAX_SAFE_INTEGER);

/** Digits in Number.MAX_SAFE_INTEGER: longer digit strings cannot be safe. */
const MAX_SAFE_DIGITS = 16;

const OUT_OF_RANGE = "Amount exceeds the safe integer minor-unit range";

const UNSUPPORTED_PRECISION =
  "Amount has unsupported fractional minor-unit precision";

export function isSupportedCurrency(currency: string): boolean {
  return Object.hasOwn(currencyScales, currency);
}

function currencyScale(currency: string): number {
  const scale = isSupportedCurrency(currency)
    ? currencyScales[currency]
    : undefined;
  if (scale === undefined) {
    throw new RangeError(`Unsupported currency precision: ${currency}`);
  }
  return scale;
}

/** Format exact signed minor units without floating-point division or rounding. */
export function minorToDecimal(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) {
    throw new TypeError("Minor-unit amounts must be safe integers");
  }
  const scale = currencyScale(currency);
  const value = BigInt(minor);
  const digits = (value < 0n ? -value : value)
    .toString()
    .padStart(scale + 1, "0");
  const decimal =
    scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return `${value < 0n ? "-" : ""}${decimal}`;
}

function toSafeNumber(value: bigint): number {
  if (value < -maxSafeMinor || value > maxSafeMinor) {
    throw new RangeError(OUT_OF_RANGE);
  }
  return Number(value);
}

/** Convert an exact source decimal, including exponent notation, without rounding. */
export function decimalToMinor(decimal: string, currency: string): number {
  const scale = currencyScale(currency);

  const match =
    /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(decimal);
  if (!match) {
    throw new TypeError("Amount must be a decimal string");
  }

  const [, sign, integerPart, fractionalPart, leadingFractionalPart, exponent] =
    match;
  const fractionDigits = fractionalPart ?? leadingFractionalPart ?? "";
  let digits = `${integerPart ?? "0"}${fractionDigits}`.replace(/^0+/, "");
  if (digits === "") {
    return 0;
  }

  const decimalShift =
    BigInt(exponent ?? "0") + BigInt(scale) - BigInt(fractionDigits.length);
  if (decimalShift >= 0n) {
    // Check the digit count before allocating powers of ten for oversized inputs.
    if (BigInt(digits.length) + decimalShift > BigInt(MAX_SAFE_DIGITS)) {
      throw new RangeError(OUT_OF_RANGE);
    }
    digits += "0".repeat(Number(decimalShift));
  } else {
    const removedDigitCount = -decimalShift;
    if (removedDigitCount >= BigInt(digits.length)) {
      throw new RangeError(UNSUPPORTED_PRECISION);
    }
    const splitIndex = digits.length - Number(removedDigitCount);
    if (!/^0+$/.test(digits.slice(splitIndex))) {
      throw new RangeError(UNSUPPORTED_PRECISION);
    }
    digits = digits.slice(0, splitIndex);
    if (digits.length > MAX_SAFE_DIGITS) {
      throw new RangeError(OUT_OF_RANGE);
    }
  }

  return toSafeNumber(BigInt(digits) * (sign === "-" ? -1n : 1n));
}

/** Sum one currency/basis only; callers own that grouping. */
export function sumMinor(amounts: Iterable<number>): number {
  let total = 0n;
  for (const amount of amounts) {
    if (!Number.isSafeInteger(amount)) {
      throw new TypeError("Minor-unit amounts must be safe integers");
    }
    total += BigInt(amount);
  }
  return toSafeNumber(total);
}
