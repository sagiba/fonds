/**
 * Generates wholly synthetic CAL examples from the committed observed shape.
 *
 *   npx tsx tests/providers/cal/scripts/generate-cal-fixtures.ts [--check]
 *
 * No private export, credential, network request or random seed is used.
 * `--check` verifies that the committed fixtures are reproduced byte for byte.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const DIRECTORY = join(ROOT, "tests/providers/cal/fixtures");
const SCHEMA = JSON.parse(
  readFileSync(
    join(ROOT, "tests/providers/cal/schemas/cal-observed.schema.json"),
    "utf8",
  ),
) as {
  $defs: Record<
    string,
    { properties: Record<string, { "x-observed-types": string[] }> }
  >;
};
const CARD = "SYNTHETIC-CARD-A";
const OTHER_CARD = "SYNTHETIC-CARD-B";

/** A JSON number written with a decimal point, as the fixtures spell source decimals. */
class Float {
  constructor(readonly value: number) {}
}

type Json =
  null | boolean | number | string | Float | Json[] | { [key: string]: Json };

type Row = Record<string, Json>;

const float = (value: number) => new Float(value);

function clone<T extends Json>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => clone(item)) as T;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Float)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)]),
    ) as T;
  }
  return value;
}

/** A row with every observed field at an empty value of its observed type. */
function defaults(definition: string): Row {
  const row: Row = {};
  for (const [key, property] of Object.entries(
    SCHEMA.$defs[definition]!.properties,
  )) {
    const types = property["x-observed-types"];
    row[key] = types.includes("null")
      ? null
      : types.includes("array")
        ? []
        : types.includes("boolean")
          ? false
          : types.includes("string")
            ? ""
            : 0;
  }
  return row;
}

function posted(name: string, amount = 86.4, overrides: Row = {}): Row {
  return {
    ...defaults("posted"),
    ...{
      cardUniqueId: CARD,
      trnIntId: `SYNTHETIC-TXN-${name}`,
      trnPurchaseDate: "2040-05-20T14:30:00",
      debCrdDate: "2040-06-10T00:00:00",
      merchantName: `בית עסק סינתטי ${name}`,
      merchantId: `SYNTHETIC-MERCHANT-${name}`,
      merchantAddress: "רחוב הדוגמה 1, עיר הדוגמה",
      merchantPhoneNo: "000-000-0000",
      internationalBranchID: "5411",
      internationalBranchDesc: "סיווג סינתטי",
      amountForDisplay: float(amount),
      amtBeforeConvAndIndex: float(amount),
      trnAmt: float(Math.abs(amount)),
      currencyForDisplay: "₪",
      debCrdCurrencyCode: 3,
      debCrdCurrencyDesc: "שח",
      debCrdCurrencySymbol: "₪",
      trnCurrencyIsoCode: "376",
      trnCurrencySymbol: "₪",
      transOriginalCurrencyCode: 3,
      srcCurrencyCode: "376",
      transOriginalSumCurrency: "תיאור מטבע סינתטי",
      transactionTypeCode: 5,
      trnType: "רגילה",
      refundInd: amount < 0,
      numOfPayments: 0,
      curPaymentNum: 0,
      trnNumaretor: float(90001),
      transCardPresentInd: true,
      immediateComments: [],
      paymentsMade: [],
      paymentsMadeComment: null,
    },
    ...overrides,
  };
}

function pending(name: string, amount: number, modern = true): Row {
  const row: Row = {
    ...defaults("pending"),
    ...{
      cardUniqueID: CARD,
      merchantName: `בית עסק סינתטי ${name}`,
      trnPurchaseDate: "2040-06-11T11:00:00",
      trnAmt: float(amount),
      trnCurrencySymbol: "₪",
      trnType: "רגילה",
      trnTypeCode: "5",
      numberOfPayments: 0,
      firstPaymentAmount: float(0),
      internationalBranchID: "5411",
      branchCodeDesc: "סיווג סינתטי",
      transactionID: `SYNTHETIC-AUTH-${name}`,
      isAbroadApproval: false,
    },
  };
  if (!modern) {
    delete row.transactionID;
    delete row.isAbroadApproval;
  }
  return row;
}

function payment(index: number, amount: number): Row {
  // Deliberately localized text, not an integer: preserve the label as supplied.
  return {
    date: `2040-0${index + 2}-10T00:00:00`,
    num: `תשלום ‎${index}‎ מתוך ‎4‎`,
    amount: float(amount),
    currency: "₪",
  };
}

function envelope(result: Row, label: string): Row {
  return {
    result,
    statusDescription: "SYNTHETIC SUCCESS",
    statusTitle: null,
    statusCode: 1,
    groupPid: `SYNTHETIC-RUN-${label}`,
  };
}

function recent(rows: Row[], approvals: Row[], label: string): Row {
  return envelope(
    { daysRange: 90, clearanceRequests: approvals, transactions: rows },
    label,
  );
}

function transactionsOf(document: Row): Row[] {
  return (document.result as Row).transactions as Row[];
}

function build(): Record<string, Row> {
  const installments: Row = {
    transactionTypeCode: 8,
    trnType: "תשלומים",
  };
  const cancellation: Row = {
    transactionTypeCode: 86,
    trnType: "ביטול תשלומים",
  };
  const dollar: Row = {
    trnCurrencyIsoCode: "840",
    trnCurrencySymbol: "$",
    transOriginalCurrencyCode: 1,
    srcCurrencyCode: "840",
  };
  const cafe: Row = {
    merchantName: "בית קפה סינתטי",
    merchantId: "SYNTHETIC-CAFE",
  };
  const rows = [
    posted("REGULAR", undefined, {
      earlyPaymentInd: true,
      cashAccountTrnAmt: float(123.4567),
    }),
    posted("CONVERTED-USD", 222, {
      trnAmt: float(60),
      ...dollar,
      isAbroadTransaction: true,
    }),
    posted("BILLED-USD", 45, {
      currencyForDisplay: "$",
      debCrdCurrencyCode: 1,
      debCrdCurrencyDesc: "$",
      debCrdCurrencySymbol: "$",
      ...dollar,
      isAbroadTransaction: true,
    }),
    posted("BILLED-EUR", 37.5, {
      currencyForDisplay: "€",
      debCrdCurrencyCode: 7,
      debCrdCurrencyDesc: "UE",
      debCrdCurrencySymbol: "€",
      trnCurrencyIsoCode: "978",
      trnCurrencySymbol: "€",
      transOriginalCurrencyCode: 7,
      srcCurrencyCode: "978",
    }),
    posted("INSTALLMENTS", 1200, {
      amtBeforeConvAndIndex: float(100),
      numOfPayments: 12,
      curPaymentNum: 3,
      ...installments,
    }),
    posted("UNKNOWN-PLAN", -300, {
      amtBeforeConvAndIndex: float(-50),
      numOfPayments: 0,
      curPaymentNum: 4,
      ...cancellation,
    }),
    posted("REFUND", -25, { transactionTypeCode: 6, trnType: "זיכוי" }),
    posted("CANCEL", -210, {
      trnAmt: float(900),
      numOfPayments: 6,
      curPaymentNum: 4,
      ...cancellation,
      trnNumaretor: float(90101),
    }),
    posted("CANCEL", -315, {
      trnAmt: float(900),
      numOfPayments: 6,
      curPaymentNum: 5,
      ...cancellation,
      trnNumaretor: float(90102),
    }),
    posted("WAIVED-FEE", 0, {
      trnAmt: float(12.5),
      discountAmount: "12.50",
      discountReason: "הנחה סינתטית",
      transactionTypeCode: 67,
      trnType: "דמי חבר",
      curPaymentNum: 0,
      numOfPayments: 0,
    }),
    posted("HISTORY", 840, {
      curPaymentNum: null,
      numOfPayments: null,
      ...installments,
      paymentsMade: [payment(1, 70), payment(2, 90)],
      paymentsMadeComment: "היסטוריית תשלומים סינתטית",
    }),
    posted("CONTEXT", 39.9, {
      transactionTypeCode: 9,
      trnType: "הוראת קבע",
      walletProviderCode: 3,
      walletProviderDesc: "Apple Pay",
      tokenInd: 1,
      walletTokenInd: 1,
      tokenNumber: "SYNTHETIC-WALLET-TOKEN",
      tokenNumberPart4: "0000",
      comments: [{ key: "הערה סינתטית", value: "<b>תוכן לדוגמה בלבד</b>" }],
      linkedComments: [
        {
          text: "מידע סינתטי",
          linkDisplayName: "דוגמה",
          linkType: 1,
          link: "https://example.invalid/synthetic-receipt",
        },
      ],
      immediateComments: [{ comment: "הסבר סינתטי" }],
      transTypeCommentDetails: ["פרט סינתטי על סוג העסקה"],
    }),
    posted("UNKNOWN-ORIGINAL-CURRENCY", 22, {
      trnCurrencyIsoCode: null,
      transOriginalCurrencyCode: null,
      srcCurrencyCode: "",
      immediateComments: [],
    }),
    posted("REMOTE", 48.6, {
      transCardPresentInd: false,
      walletProviderCode: 32,
      walletProviderDesc: "אינטרנט",
    }),
    posted("VANISH", 64.8),
    posted("CORRECTED", 72.1),
    posted("DUPLICATE-A", 18.2, cafe),
    posted("DUPLICATE-B", 18.2, cafe),
    posted("REGULAR", 86.4, { cardUniqueId: OTHER_CARD }),
  ];
  rows.forEach((row, index) => {
    if (row.trnIntId !== "SYNTHETIC-TXN-CANCEL") {
      row.trnNumaretor = float(91000 + index);
    }
  });
  const approvals = [
    pending("PENDING-POSTED", 58.75),
    pending("LEGACY-PENDING", 29.4, false),
  ];
  const baseline = recent(rows, approvals, "BASELINE");
  const laterRows = clone(rows).filter(
    (row) => row.trnIntId !== "SYNTHETIC-TXN-VANISH",
  );
  for (const row of laterRows) {
    if (row.trnIntId === "SYNTHETIC-TXN-REGULAR") {
      row.earlyPaymentInd = false;
    }
    if (row.trnIntId === "SYNTHETIC-TXN-HISTORY") {
      const old = row.paymentsMade as Row[];
      row.paymentsMade = [clone(old[1]!), payment(3, 45), clone(old[0]!)];
      row.paymentsMadeComment = "היסטוריה סינתטית מורחבת ומסודרת מחדש";
      row.debCrdDate = "2040-07-10T00:00:00";
      row.trnNumaretor = float(92001);
    }
    if (row.trnIntId === "SYNTHETIC-TXN-CORRECTED") {
      Object.assign(row, {
        amountForDisplay: float(75.6),
        trnAmt: float(75.6),
        amtBeforeConvAndIndex: float(75.6),
      });
    }
  }
  laterRows.push(
    posted("PENDING-POSTED", 58.75, { trnPurchaseDate: "2040-06-12T11:00:00" }),
    posted("NEW", 93.7, { trnPurchaseDate: "2040-07-11T10:00:00" }),
  );
  const later = recent(
    laterRows,
    [pending("LEGACY-PENDING", 29.4, false)],
    "LATER",
  );
  const restored = clone(later);
  restored.groupPid = "SYNTHETIC-RUN-REAPPEARANCE";
  transactionsOf(restored).push(posted("VANISH", 64.8));
  const legacyRows: Row[] = [];
  for (let number = 1; number < 4; number++) {
    legacyRows.push(
      posted("LEGACY-INSTALLMENTS", 1200, {
        amtBeforeConvAndIndex: float(100),
        numOfPayments: 12,
        curPaymentNum: number,
        ...installments,
        trnPurchaseDate: "2040-01-15T16:00:00",
        debCrdDate: `2040-0${number + 1}-10T00:00:00`,
        trnNumaretor: float(93000 + number),
      }),
    );
  }
  legacyRows.push(
    ...clone(rows.filter((row) => row.trnIntId === "SYNTHETIC-TXN-CANCEL")),
  );
  for (const row of legacyRows) {
    delete row.paymentsMade;
    delete row.paymentsMadeComment;
    row.immediateComments = null;
  }
  const legacy = envelope({ transArr: legacyRows }, "LEGACY");
  const future = recent([posted("FUTURE-FIELD", 16.3)], [], "FUTURE");
  transactionsOf(future)[0]!.syntheticFutureField = {
    label: "SYNTHETIC EXTENSION",
    value: null,
  };
  const malformed = recent([posted("PARTIAL", 41.8)], [], "MALFORMED-PENDING");
  (malformed.result as Row).clearanceRequests = null;
  return {
    "recent-01.json": baseline,
    "recent-02.json": later,
    "recent-03.json": restored,
    "legacy-history.json": legacy,
    "future-field.json": future,
    "malformed-pending.json": malformed,
    "scenarios.json": scenarios(),
  };
}

function scenarios(): Row {
  const expectations: Record<string, Row | Row[]> = {
    regular: {
      key: [CARD, "SYNTHETIC-TXN-REGULAR"],
      native_billing_amount: "86.40",
      billing_currency: "ILS",
      flag_only_change: true,
    },
    opaque_cash_account_amount: {
      key: [CARD, "SYNTHETIC-TXN-REGULAR"],
      source_numeric_example: "123.4567",
      canonical_amount_source: "amountForDisplay",
      role: "unvalidated; preserve as provider detail without replacing canonical money",
    },
    converted: {
      key: [CARD, "SYNTHETIC-TXN-CONVERTED-USD"],
      native_billing_amount: "222.00",
      billing_currency: "ILS",
      source_original_amount: "60.00",
      original_currency: "USD",
      do_not_convert_billing_again: true,
    },
    foreign_billing: [
      {
        id: "SYNTHETIC-TXN-BILLED-USD",
        native_billing_amount: "45.00",
        currency: "USD",
      },
      {
        id: "SYNTHETIC-TXN-BILLED-EUR",
        native_billing_amount: "37.50",
        currency: "EUR",
      },
    ],
    legacy_installments: {
      id: "SYNTHETIC-TXN-LEGACY-INSTALLMENTS",
      observations: 3,
      planned_count: 12,
      native_commitment_amount: "1200.00",
      observed_component_amounts: ["100.00", "100.00", "100.00"],
      must_not_sum_display_amounts: true,
    },
    cancellation: {
      id: "SYNTHETIC-TXN-CANCEL",
      observations: 2,
      same_billing_date: true,
      component_amounts: ["-210.00", "-315.00"],
      shared_positive_original_amount: "900.00",
      workflow_group_amount: "-525.00",
      rule_basis:
        "Fonds mapping policy, not an issuer-guaranteed universal rule",
    },
    refund: {
      id: "SYNTHETIC-TXN-REFUND",
      display_amount: "-25.00",
      trnAmt: "25.00",
      original_purchase_link: null,
    },
    waived_fee: {
      id: "SYNTHETIC-TXN-WAIVED-FEE",
      display_amount: "0.00",
      trnAmt: "12.50",
      must_not_create_12_50_charge: true,
    },
    history: {
      id: "SYNTHETIC-TXN-HISTORY",
      count_before: 2,
      count_after: 3,
      old_items_preserved: true,
      order_changes: true,
      parent_counts_null: true,
      history_sum_is_not_parent_amount: true,
      num_is_localized_text: true,
    },
    pending_candidate: {
      pending_id: "SYNTHETIC-AUTH-PENDING-POSTED",
      posted_id: "SYNTHETIC-TXN-PENDING-POSTED",
      purchase_date_changes: true,
      provider_link_proven: false,
      expected:
        "candidate requiring rule validation or owner decision, not an automatic identity link",
    },
    unlisted_and_returned: {
      id: "SYNTHETIC-TXN-VANISH",
      expected:
        "retain history/annotations; absence in unknown window is not deletion",
    },
    constructed_correction: {
      id: "SYNTHETIC-TXN-CORRECTED",
      before: "72.10",
      after: "75.60",
      basis: "hypothetical future update; not an observed response shape",
    },
    duplicates: {
      ids: ["SYNTHETIC-TXN-DUPLICATE-A", "SYNTHETIC-TXN-DUPLICATE-B"],
      expected_distinct_transactions: 2,
    },
    cross_card: {
      native_id: "SYNTHETIC-TXN-REGULAR",
      cards: [CARD, OTHER_CARD],
      expected_distinct_transactions: 2,
    },
    annotations: {
      transaction: "SYNTHETIC-TXN-CORRECTED",
      note: "Synthetic user note",
      category: "Example category",
      business_use: "uncertain",
      expected: "preserve through update",
    },
    unknown_original_currency: {
      id: "SYNTHETIC-TXN-UNKNOWN-ORIGINAL-CURRENCY",
      expected:
        "retain null source codes; billing currency does not supply missing original-currency proof",
    },
  };
  const observed = new Set([
    "regular",
    "opaque_cash_account_amount",
    "converted",
    "foreign_billing",
    "legacy_installments",
    "cancellation",
    "refund",
    "waived_fee",
    "history",
    "pending_candidate",
    "unknown_original_currency",
  ]);
  for (const [key, value] of Object.entries(expectations)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        item.evidence_basis = "observed currency combination; values invented";
      }
    } else {
      value.evidence_basis = observed.has(key)
        ? "observed structural/semantic pattern; values invented"
        : "constructed application behavior case";
    }
  }
  (expectations.unlisted_and_returned as Row).evidence_basis =
    "snapshot set differences observed; reappearance is a constructed lifecycle case";
  expectations.unknown_plan = {
    id: "SYNTHETIC-TXN-UNKNOWN-PLAN",
    observed_ordinal: 4,
    reported_total: 0,
    expected:
      "retain the observed ordinal; do not infer planned total or remaining count",
    evidence_basis: "observed cancellation pattern; values invented",
  };
  // Golden service projections are explicit policy examples, not issuer facts.
  // No service-generated UUID is prescribed; identify a fixture source group.
  const expectedRows: [
    string,
    number,
    string,
    string,
    number | null,
    string | null,
    ("purchase_commitment" | "unknown")?,
  ][] = [
    ["REGULAR", -8640, "ILS", "purchase", -8640, "ILS"],
    ["CONVERTED-USD", -22200, "ILS", "purchase", -6000, "USD"],
    ["BILLED-USD", -4500, "USD", "purchase", -4500, "USD"],
    ["BILLED-EUR", -3750, "EUR", "purchase", -3750, "EUR"],
    ["INSTALLMENTS", -120000, "ILS", "purchase", -120000, "ILS"],
    ["UNKNOWN-PLAN", 30000, "ILS", "refund", null, null],
    ["REFUND", 2500, "ILS", "refund", 2500, "ILS"],
    ["CANCEL", 52500, "ILS", "refund", null, null],
    ["WAIVED-FEE", 0, "ILS", "fee", null, null],
    ["HISTORY", -84000, "ILS", "purchase", -84000, "ILS", "unknown"],
    ["CONTEXT", -3990, "ILS", "purchase", -3990, "ILS"],
    ["UNKNOWN-ORIGINAL-CURRENCY", -2200, "ILS", "purchase", null, null],
    ["REMOTE", -4860, "ILS", "purchase", -4860, "ILS"],
    ["VANISH", -6480, "ILS", "purchase", -6480, "ILS"],
    ["CORRECTED", -7210, "ILS", "purchase", -7210, "ILS"],
    ["DUPLICATE-A", -1820, "ILS", "purchase", -1820, "ILS"],
    ["DUPLICATE-B", -1820, "ILS", "purchase", -1820, "ILS"],
  ];
  const projection: Row[] = expectedRows.map(
    ([name, amount, currency, kind, original, originalCurrency, basis]) => ({
      source_identity: { card_key: CARD, native_id: `SYNTHETIC-TXN-${name}` },
      status: "posted",
      amount_basis: basis ?? "purchase_commitment",
      kind,
      amount_minor: amount,
      currency,
      original_amount_minor: original,
      original_currency: originalCurrency,
      booking_date: null,
    }),
  );
  const secondCard = clone(projection[0]!);
  (secondCard.source_identity as Row).card_key = OTHER_CARD;
  projection.push(secondCard);
  (expectations.converted as Row).uninterpreted_source_fields = [
    "amtBeforeConvAndIndex",
  ];
  return {
    synthetic: true,
    description:
      "Constructed examples, not redacted source transactions. Values/identities/dates are invented. Assertions describe expected interpretation or uncertainty, not a complete importer implementation.",
    coverage: {
      all_recent_files: "unknown",
      daysRange_is_provider_assertion: true,
      no_disappearance_is_a_confirmed_deletion: true,
    },
    files: [
      { path: "recent-01.json", valid_observed_shape: true, role: "baseline" },
      {
        path: "recent-02.json",
        valid_observed_shape: true,
        role: "later capture",
      },
      {
        path: "recent-03.json",
        valid_observed_shape: true,
        role: "reappearance",
      },
      {
        path: "legacy-history.json",
        valid_observed_shape: true,
        role: "separate accumulated/legacy history; not a timed snapshot in the sequence",
      },
      {
        path: "future-field.json",
        valid_observed_shape: true,
        role: "constructed unknown-field forward compatibility",
      },
      {
        path: "malformed-pending.json",
        valid_observed_shape: false,
        role: "constructed partial response; preserve evidence and flag coverage",
      },
    ],
    expectations,
    collection_context: {
      provider: "cal",
      connection_id: "SYNTHETIC-CAL-CONNECTION",
      account_key: "SYNTHETIC-CAL-ACCOUNT",
    },
    expected_baseline_projection: projection,
    expected_later_behavior: {
      corrected_amount_minor: -7560,
      legacy_pending_unchanged_identity_count: 1,
      flag_only_change_financial_version_bump: false,
      history_reordering_financial_version_bump: false,
      unlisted_posted_transaction_retained: true,
      pending_to_posted_automatic_link: false,
      default_totals_group_by: ["amount_basis", "currency"],
      default_spending_excludes_pending: true,
    },
  };
}

/** A fractional number as the committed fixtures spell it: `86.4`, `1200.0`. */
function floatText(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e16) {
    throw new RangeError("Fixture number outside the supported range");
  }
  if (Number.isInteger(value)) {
    return `${Object.is(value, -0) ? "-0" : value}.0`;
  }
  if (Math.abs(value) < 1e-4) {
    throw new RangeError("Fixture number outside the supported range");
  }
  return String(value);
}

/** Two-space indented JSON with literal non-ASCII text, one value per line. */
function serialize(value: Json, indent = ""): string {
  if (value instanceof Float) {
    return floatText(value.value);
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new RangeError("Fixture integer outside the supported range");
    }
    return JSON.stringify(value);
  }
  const inner = `${indent}  `;
  const entries = Array.isArray(value)
    ? value.map((item) => serialize(item, inner))
    : Object.entries(value).map(
        ([key, item]) => `${JSON.stringify(key)}: ${serialize(item, inner)}`,
      );
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return entries.length === 0
    ? `${open}${close}`
    : `${open}\n${inner}${entries.join(`,\n${inner}`)}\n${indent}${close}`;
}

const options = process.argv.slice(2);
if (options.some((option) => option !== "--check")) {
  process.stderr.write("Usage: generate-cal-fixtures.ts [--check]\n");
  process.exit(2);
}
const check = options.includes("--check");
const drift: string[] = [];
for (const [name, value] of Object.entries(build())) {
  const text = `${serialize(value)}\n`;
  const path = join(DIRECTORY, name);
  if (check) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
      drift.push(name);
    }
  } else {
    mkdirSync(DIRECTORY, { recursive: true });
    writeFileSync(path, text);
  }
}
if (drift.length) {
  process.stderr.write(`Fixture drift: ${drift.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write(
  `${check ? "Checked" : "Generated"} 7 fully synthetic fixture files.\n`,
);
