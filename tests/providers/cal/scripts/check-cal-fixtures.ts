/**
 * Validates the generated synthetic CAL fixtures; needs no private export.
 *
 *   npx tsx tests/providers/cal/scripts/check-cal-fixtures.ts
 *
 * Each generated file must match the observed schema exactly as its scenario
 * entry says, and the files must keep their structural and financial edge
 * cases. These checks cover example data and expected interpretation, not the
 * collector or reconciliation code.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { isLosslessNumber, parse } from "lossless-json";

import { compileSchema } from "./json-schema-subset.js";

type Row = Record<string, unknown>;

const ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const FIXTURES = join(ROOT, "tests/providers/cal/fixtures");
const SCALE = 6;
const UNIT = 10n ** BigInt(SCALE);

function load(path: string): Row {
  return parse(readFileSync(path, "utf8")) as Row;
}

/** An exact decimal in millionths; anything finer or non-numeric throws. */
function exact(value: unknown): bigint {
  const lexeme = isLosslessNumber(value) ? value.value : String(value);
  const match = lexeme.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  const fraction = (match?.[3] ?? "").replace(/0+$/, "");
  assert.ok(match && fraction.length <= SCALE, "unsupported decimal");
  const units = BigInt(`${match[2]}${fraction.padEnd(SCALE, "0")}`);
  return match[1] === "-" ? -units : units;
}

function sum(values: unknown[]): bigint {
  return values.reduce<bigint>((total, value) => total + exact(value), 0n);
}

/** A whole source number such as a currency code; null stays null. */
function code(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  const units = exact(value);
  assert.equal(units % UNIT, 0n, "not a whole number");
  return Number(units / UNIT);
}

const schema = load(
  join(ROOT, "tests/providers/cal/schemas/cal-observed.schema.json"),
);
const validate = compileSchema(schema);
const scenarios = load(join(FIXTURES, "scenarios.json")) as {
  files: { path: string; valid_observed_shape: boolean }[];
  coverage: Row;
  expectations: Record<string, Row>;
  expected_baseline_projection: {
    source_identity: { card_key: string; native_id: string };
    amount_minor: unknown;
    currency: string;
    amount_basis: string;
    booking_date: unknown;
    original_amount_minor: unknown;
  }[];
  expected_later_behavior: Row;
};
for (const item of scenarios.files) {
  const errors = validate(load(join(FIXTURES, item.path)));
  assert.equal(
    errors.length === 0,
    item.valid_observed_shape,
    `${item.path}: ${errors.map((error) => `${error.keyword} at ${error.path.join(".")}`).join(", ")}`,
  );
}

interface Recent {
  transactions: Row[];
  clearanceRequests: Row[];
}

const result = (name: string) => load(join(FIXTURES, name)).result as Recent;
const baseline = result("recent-01.json");
const later = result("recent-02.json");
const restored = result("recent-03.json");
const legacy = (
  load(join(FIXTURES, "legacy-history.json")).result as { transArr: Row[] }
).transArr;
const definitions = schema.$defs as Record<string, { properties: Row }>;
assert.equal(Object.keys(definitions.posted!.properties).length, 73);
assert.equal(Object.keys(definitions.pending!.properties).length, 19);
assert.ok(baseline.transactions.every((row) => Object.keys(row).length === 73));
assert.ok(
  legacy.every(
    (row) => Object.keys(row).length === 71 && !("paymentsMade" in row),
  ),
);
assert.ok(baseline.clearanceRequests.some((row) => !("transactionID" in row)));
assert.ok(baseline.clearanceRequests.some((row) => "transactionID" in row));
assert.deepEqual(
  new Set(baseline.transactions.map((row) => code(row.debCrdCurrencyCode))),
  new Set([1, 3, 7]),
);
assert.ok(
  baseline.transactions.every((row) =>
    String(row.trnPurchaseDate).startsWith("2040-"),
  ),
);

const rows = (document: Recent, nativeId: string) =>
  document.transactions.filter((row) => row.trnIntId === nativeId);
const distinct = (values: unknown[]) => new Set(values.map(exact)).size;

const installments = legacy.filter(
  (row) => row.trnIntId === "SYNTHETIC-TXN-LEGACY-INSTALLMENTS",
);
assert.equal(installments.length, 3);
assert.equal(distinct(installments.map((row) => row.amountForDisplay)), 1);
assert.equal(
  sum(installments.map((row) => row.amountForDisplay)),
  exact("3600.0"),
);
assert.equal(exact(installments[0]!.amountForDisplay), exact("1200.0"));
assert.equal(
  sum(installments.map((row) => row.amtBeforeConvAndIndex)),
  exact("300.0"),
);
assert.equal(
  new Set(installments.map((row) => code(row.curPaymentNum))).size,
  3,
);
const cancellations = rows(baseline, "SYNTHETIC-TXN-CANCEL");
assert.equal(cancellations.length, 2);
assert.equal(new Set(cancellations.map((row) => row.debCrdDate)).size, 1);
assert.ok(
  cancellations.every(
    (row) => row.refundInd === true && row.trnType === "ביטול תשלומים",
  ),
);
assert.equal(distinct(cancellations.map((row) => row.trnAmt)), 1);
assert.ok(exact(cancellations[0]!.trnAmt) > 0n);
assert.equal(
  sum(cancellations.map((row) => row.amountForDisplay)),
  exact("-525.0"),
);
const refund = rows(baseline, "SYNTHETIC-TXN-REFUND")[0]!;
assert.ok(exact(refund.trnAmt) > 0n && exact(refund.amountForDisplay) < 0n);
const fee = rows(baseline, "SYNTHETIC-TXN-WAIVED-FEE")[0]!;
assert.ok(exact(fee.trnAmt) > 0n && exact(fee.amountForDisplay) === 0n);
const fx = rows(baseline, "SYNTHETIC-TXN-CONVERTED-USD")[0]!;
assert.equal(code(fx.debCrdCurrencyCode), 3);
assert.equal(fx.trnCurrencyIsoCode, "840");
assert.equal(code(fx.transOriginalCurrencyCode), 1);
const originalCodes: Record<string, number> = { "376": 3, "840": 1, "978": 7 };
for (const row of baseline.transactions) {
  assert.equal(
    code(row.transOriginalCurrencyCode),
    originalCodes[String(row.trnCurrencyIsoCode)] ?? null,
  );
}
assert.equal(exact(fx.amountForDisplay), exact("222.0"));
assert.equal(exact(fx.trnAmt), exact("60.0"));
const before = rows(baseline, "SYNTHETIC-TXN-HISTORY")[0]!;
const after = rows(later, "SYNTHETIC-TXN-HISTORY")[0]!;
const historyBefore = before.paymentsMade as Row[];
const historyAfter = after.paymentsMade as Row[];
assert.ok(before.numOfPayments === null && before.curPaymentNum === null);
assert.ok(historyBefore.length === 2 && historyAfter.length === 3);
assert.ok(
  historyBefore.every((item) =>
    historyAfter.some((other) => isDeepStrictEqual(item, other)),
  ),
);
assert.ok(!isDeepStrictEqual(historyBefore[0], historyAfter[0]));
assert.notEqual(
  sum(historyAfter.map((item) => item.amount)),
  exact(after.amountForDisplay),
);
assert.ok(
  historyAfter.every(
    (item) => typeof item.num === "string" && item.num.includes("‎"),
  ),
);
assert.ok(
  rows(later, "SYNTHETIC-TXN-VANISH").length === 0 &&
    rows(restored, "SYNTHETIC-TXN-VANISH").length > 0,
);
const regular = rows(baseline, "SYNTHETIC-TXN-REGULAR");
assert.equal(regular.length, 2);
assert.equal(new Set(regular.map((row) => row.cardUniqueId)).size, 2);
const opaqueCash = regular.find(
  (row) => row.cardUniqueId === "SYNTHETIC-CARD-A",
)!;
assert.equal(exact(opaqueCash.cashAccountTrnAmt), exact("123.4567"));
assert.notEqual(
  exact(opaqueCash.cashAccountTrnAmt),
  exact(opaqueCash.amountForDisplay),
);
assert.equal(exact(opaqueCash.amountForDisplay), exact("86.4"));
assert.equal(scenarios.coverage.all_recent_files, "unknown");
assert.equal(
  scenarios.expectations.pending_candidate!.provider_link_proven,
  false,
);

const projection = scenarios.expected_baseline_projection;
const sourceGroups = new Map<string, Row[]>();
for (const row of baseline.transactions) {
  const key = JSON.stringify([row.cardUniqueId, row.trnIntId]);
  sourceGroups.set(key, [...(sourceGroups.get(key) ?? []), row]);
}
assert.ok(projection.length === sourceGroups.size && projection.length === 18);
const currencies: Record<number, string> = { 1: "USD", 3: "ILS", 7: "EUR" };
for (const row of projection) {
  const group = sourceGroups.get(
    JSON.stringify([
      row.source_identity.card_key,
      row.source_identity.native_id,
    ]),
  )!;
  const native = group.every(
    (item) => item.refundInd === true && item.trnType === "ביטול תשלומים",
  )
    ? sum(group.map((item) => item.amountForDisplay))
    : exact(group[0]!.amountForDisplay);
  // Signed minor units, truncated toward zero.
  assert.equal(exact(row.amount_minor), ((-native * 100n) / UNIT) * UNIT);
  assert.equal(row.currency, currencies[code(group[0]!.debCrdCurrencyCode)!]);
  assert.ok(
    row.amount_basis === "purchase_commitment" && row.booking_date === null,
  );
  if (row.original_amount_minor !== null) {
    assert.ok(exact(row.original_amount_minor) * exact(row.amount_minor) > 0n);
  }
}
assert.equal(
  code(
    scenarios.expected_later_behavior.legacy_pending_unchanged_identity_count,
  ),
  1,
);
// Fake identifiers are intentionally conspicuous and have no production origin.
const synthetic = (value: unknown) =>
  typeof value === "string" && value.startsWith("SYNTHETIC-");
for (const document of [baseline, later, restored]) {
  for (const row of document.transactions) {
    assert.ok(
      synthetic(row.cardUniqueId) &&
        synthetic(row.trnIntId) &&
        synthetic(row.merchantId),
    );
  }
  for (const row of document.clearanceRequests) {
    assert.ok(synthetic(row.cardUniqueID));
    if ("transactionID" in row) {
      assert.ok(synthetic(row.transactionID));
    }
  }
}
process.stdout.write(
  "PASS: six response fixtures, observed schema, and currency/installment/history/identity edge cases.\n",
);
