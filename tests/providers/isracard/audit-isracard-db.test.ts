import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isracardAdapter } from "../../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCardKey,
  serializeIsracardCapture,
} from "../../../src/providers/isracard/capture.js";
import { ISRACARD_ENDPOINTS } from "../../../src/providers/isracard/transport.js";
import { openDatabase } from "../../../src/storage/sqlite/database.js";

// Every value below is invented. Each must stay out of stdout, stderr and the profile.
const SUFFIX = "9137";
const PARTNER_SUFFIX = "6608";
const LEGACY_ONLY_SUFFIX = "5524";
const GUID = "SYNTHETIC-SECRET-GUID-A";
const PARTNER_GUID = "SYNTHETIC-SECRET-GUID-B";
const MERCHANT = "Synthetic Secret Merchant";
const LEGACY_ONLY_MERCHANT = "Synthetic Hidden Old Merchant";
const CARD_LIST_HOLDER = "SYNTHETIC_CARDLIST_HOLDER";
const LEGACY_HOLDER = "SYNTHETIC_LEGACY_HOLDER";
const IDENTITY = "039482716";
const ACCOUNT_NUMBER = "55512345";
const LIMIT = "424242";
const VOUCHER = "731946285";
const PLAN_VOUCHER = "731946286";
const ODD_VOUCHER = "731946287";
const LEGACY_ONLY_VOUCHER = "731946299";
const BILLING = "876543.21";
const ORIGINAL = "987654.32";
const DISCOUNT = "111111.11";
const PLAN_PAYMENT = "123123.12";
const PLAN_TOTAL = "369369.36";
const PURCHASE_DATE = "13/11/2041";
const PHONE = "SYNTHETIC-SECRET-PHONE";
const DETAIL_INFO = "SYNTHETIC_SECRET_INFO";
const UNLISTED_CODE = "SYNTHETIC_SECRET_CODE";
const BRACKETED_CODE = "<Synthetic Bracketed Merchant>";
const DISGUISED_HOLDER = "Synthetic Disguised Holder";
const MISMATCH_VOUCHER = "731946288";
// Provider-body keys that look like field names but carry private text.
const ADVERSARIAL_KEYS = ["AliceSmith", "SyntheticHolderKey", "xq7Private"];
const SECRETS = [
  SUFFIX,
  PARTNER_SUFFIX,
  LEGACY_ONLY_SUFFIX,
  GUID,
  PARTNER_GUID,
  MERCHANT,
  LEGACY_ONLY_MERCHANT,
  CARD_LIST_HOLDER,
  LEGACY_HOLDER,
  IDENTITY,
  ACCOUNT_NUMBER,
  LIMIT,
  VOUCHER,
  PLAN_VOUCHER,
  ODD_VOUCHER,
  LEGACY_ONLY_VOUCHER,
  BILLING,
  "876543",
  ORIGINAL,
  "987654",
  DISCOUNT,
  PLAN_PAYMENT,
  PLAN_TOTAL,
  PURCHASE_DATE,
  "2041-11-13",
  PHONE,
  DETAIL_INFO,
  UNLISTED_CODE,
  BRACKETED_CODE,
  "Bracketed",
  DISGUISED_HOLDER,
  MISMATCH_VOUCHER,
  ...ADVERSARIAL_KEYS,
  "offline-v137",
  "7319",
  "Synthetic Secret Card Name",
  "SYNTHETIC_SECRET",
  "isracard:card:",
];

const card = { companyCode: "11" as const, cardGuid: GUID, cardSuffix: SUFFIX };
const partner = {
  companyCode: "77" as const,
  cardGuid: PARTNER_GUID,
  cardSuffix: PARTNER_SUFFIX,
};

const rawCardList = JSON.stringify({
  isSuccess: true,
  data: {
    cardsList: [
      {
        ...card,
        cardName: "Synthetic Secret Card Name",
        firstName: CARD_LIST_HOLDER,
        lastName: CARD_LIST_HOLDER,
        bank: "12",
        branch: "345",
        accountNumber: ACCOUNT_NUMBER,
        limitData: { limit: LIMIT },
        isActive: true,
        isPartner: false,
      },
      {
        ...partner,
        cardName: "Synthetic Secret Card Name",
        firstName: CARD_LIST_HOLDER,
        isActive: true,
        isPartner: true,
      },
    ],
  },
});

function digitalRow(overrides: Record<string, unknown>) {
  return {
    billingAmount: "#BILLING",
    billingAmountCurrency: 0,
    billingAmountCurrencySymbol: "ILS",
    businessName: MERCHANT,
    businessNumber: 4815162342,
    cityDescription: "Synthetic Secret City",
    countryCode: "ISR",
    currentInstallmentNum: null,
    discountAmount: "#DISCOUNT",
    discountIndication: true,
    ilsAmount: "#BILLING",
    isIsraelDeal: true,
    isLastInstallment: null,
    isdirectDebit: false,
    moreInfo: null,
    numberOfInstallment: null,
    originalAmount: "#ORIGINAL",
    originalCurrency: 0,
    originalCurrencyIso: "ILS",
    purchaseDate: PURCHASE_DATE,
    purchaseTime: "10:11:12",
    seqVoucherNumber: VOUCHER,
    transactionCode: 1,
    tranzacCodeType: "V",
    usdAmount: null,
    voucherNumber: 4815,
    ...overrides,
  };
}

/** Writes money as bare JSON number lexemes, as the provider does. */
function numbers(text: string): string {
  return text
    .replaceAll('"#BILLING"', BILLING)
    .replaceAll('"#ORIGINAL"', ORIGINAL)
    .replaceAll('"#DISCOUNT"', DISCOUNT)
    .replaceAll('"#PLAN_PAYMENT"', PLAN_PAYMENT)
    .replaceAll('"#PLAN_TOTAL"', PLAN_TOTAL)
    .replaceAll('"#HUNDRED"', "100.00")
    .replaceAll('"#NINETY"', "90.00")
    .replaceAll('"#NEGATIVE_HUNDRED"', "-100.00")
    .replaceAll('"#EXPONENT"', "1e2");
}

const digital = numbers(
  JSON.stringify({
    isSuccess: true,
    data: {
      approvals: null,
      israelAbroadVouchers: {
        vouchers: {
          israelAbroadVouchersList: [
            digitalRow({}),
            digitalRow({
              seqVoucherNumber: PLAN_VOUCHER,
              transactionCode: 3,
              billingAmount: "#PLAN_PAYMENT",
              ilsAmount: "#PLAN_PAYMENT",
              originalAmount: "#PLAN_TOTAL",
              discountAmount: null,
              discountIndication: false,
              numberOfInstallment: 3,
              currentInstallmentNum: 3,
              isLastInstallment: true,
            }),
            digitalRow({
              seqVoucherNumber: ODD_VOUCHER,
              transactionCode: UNLISTED_CODE,
              tranzacCodeType: UNLISTED_CODE,
              originalCurrencyIso: UNLISTED_CODE,
            }),
            digitalRow({ seqVoucherNumber: ODD_VOUCHER, transactionCode: 97 }),
          ],
          informativeOnlyVouchers: [],
        },
        outOfStatementChargeDateVouchers: [],
      },
    },
  }),
);

/** A later month that breaks the acceptance rules and carries hostile keys and codes. */
const adversarialDigital = numbers(
  JSON.stringify({
    isSuccess: true,
    data: {
      approvals: null,
      israelAbroadVouchers: {
        vouchers: {
          israelAbroadVouchersList: [
            digitalRow({}),
            digitalRow({
              seqVoucherNumber: MISMATCH_VOUCHER,
              transactionCode: BRACKETED_CODE,
              [ADVERSARIAL_KEYS[0]!]: MERCHANT,
              [ADVERSARIAL_KEYS[1]!]: { name: "Synthetic Hostile Value" },
              [ADVERSARIAL_KEYS[2]!]: true,
              id42: IDENTITY,
            }),
            // A zero discount beside a real delta is a disagreement, not omitted.
            digitalRow({
              seqVoucherNumber: "731946290",
              billingAmount: "#NINETY",
              ilsAmount: "#NINETY",
              originalAmount: "#HUNDRED",
              discountAmount: 0,
              discountIndication: false,
            }),
            // Opposite signs prove the label order: original first, then billing.
            digitalRow({
              seqVoucherNumber: "731946291",
              billingAmount: "#NINETY",
              ilsAmount: "#NINETY",
              originalAmount: "#NEGATIVE_HUNDRED",
              discountAmount: null,
              discountIndication: false,
            }),
            // An exponent lexeme is exact money, equal to its plain spelling.
            digitalRow({
              seqVoucherNumber: "731946289",
              billingAmount: "#HUNDRED",
              ilsAmount: "#EXPONENT",
              originalAmount: "#HUNDRED",
              discountAmount: null,
              discountIndication: false,
            }),
            "SYNTHETIC_SECRET_ROW_TEXT",
          ],
          informativeOnlyVouchers: [],
        },
        outOfStatementChargeDateVouchers: [],
      },
    },
  }),
);

const emptyDigital = JSON.stringify({
  isSuccess: true,
  data: {
    approvals: null,
    israelAbroadVouchers: null,
    currentTransactionsList: null,
  },
});

/** One valid row beside a malformed one: partial evidence. */
const partialDigital = numbers(
  JSON.stringify({
    isSuccess: true,
    data: {
      approvals: null,
      israelAbroadVouchers: {
        vouchers: {
          israelAbroadVouchersList: [digitalRow({}), 7],
          informativeOnlyVouchers: [],
        },
        outOfStatementChargeDateVouchers: [],
      },
    },
  }),
);

/**
 * Complete vouchers beside unsupported non-null approvals, and two rows that
 * differ only by a JSON number versus the same digits as a "#"-prefixed string.
 */
const approvalsDigital = numbers(
  JSON.stringify({
    isSuccess: true,
    data: {
      approvals: [],
      israelAbroadVouchers: {
        vouchers: {
          israelAbroadVouchersList: [
            digitalRow({
              seqVoucherNumber: "731946292",
              billingAmount: 123,
              ilsAmount: null,
            }),
            digitalRow({
              seqVoucherNumber: "731946292",
              billingAmount: "#123",
              ilsAmount: null,
            }),
            // The other side missing: labels name each operand in check order.
            digitalRow({
              seqVoucherNumber: "731946293",
              billingAmount: null,
              ilsAmount: 123,
            }),
          ],
          informativeOnlyVouchers: [],
        },
        outOfStatementChargeDateVouchers: [],
      },
    },
  }),
);

/** Looks like the allowlisted projection but nests holder data. */
const disguisedCardList = JSON.stringify({
  isSuccess: true,
  data: {
    cardsList: [
      {
        ...card,
        cardName: "Synthetic Secret Card Name",
        billingAccount: {
          providerKey: `12|345|${ACCOUNT_NUMBER}`,
          mask: "2345",
          holder: { name: DISGUISED_HOLDER },
        },
      },
    ],
  },
});

function legacyRow(overrides: Record<string, unknown>) {
  return {
    cardIndex: "0",
    currencyId: "ILS",
    currentPaymentCurrency: "ILS",
    dealSum: ORIGINAL,
    dealSumOutbound: null,
    dealSumType: null,
    // Known field names inside a dynamic container stay unlisted.
    displayProperties: { bank: MERCHANT, [MERCHANT]: LEGACY_HOLDER },
    fullPaymentDate: "10/12/2041",
    fullPurchaseDate: PURCHASE_DATE,
    fullSupplierNameHeb: MERCHANT,
    holderName: LEGACY_HOLDER,
    holderId: IDENTITY,
    isHoraatKeva: null,
    moreInfo: null,
    paymentSum: BILLING,
    paymentSumOutbound: null,
    paymentSumSign: null,
    supplierId: "4815162342",
    voucherNumber: "4815",
    voucherNumberRatz: VOUCHER,
    voucherNumberRatzOutbound: null,
    ...overrides,
  };
}

const legacy = JSON.stringify({
  Header: { Status: "1" },
  CardsTransactionsListBean: {
    cardNumberList: [
      `Synthetic card ${SUFFIX}`,
      `Synthetic old card ${LEGACY_ONLY_SUFFIX}`,
    ],
    [`id${IDENTITY}`]: { holderName: LEGACY_HOLDER },
    Index0: {
      CurrentCardTransactions: [
        {
          txnIsrael: [
            legacyRow({}),
            legacyRow({
              voucherNumberRatz: PLAN_VOUCHER,
              paymentSum: PLAN_PAYMENT,
              dealSum: PLAN_TOTAL,
              moreInfo: "תשלום 3 מתוך 3",
            }),
          ],
          txnAbroad: null,
          txnInfo: null,
        },
      ],
    },
    Index1: {
      CurrentCardTransactions: [
        {
          txnIsrael: [
            legacyRow({
              cardIndex: "1",
              voucherNumberRatz: LEGACY_ONLY_VOUCHER,
              fullSupplierNameHeb: LEGACY_ONLY_MERCHANT,
            }),
          ],
        },
      ],
    },
  },
});

const detail = JSON.stringify({
  Header: { Status: "1" },
  PirteyIska_204Bean: {
    address: "Synthetic Secret Street",
    chargeSum: BILLING,
    dealSum: ORIGINAL,
    discount: DISCOUNT,
    info: DETAIL_INFO,
    phoneNumber: PHONE,
    sumBeforeDiscount: ORIGINAL,
    voucherNumberRatz: VOUCHER,
  },
});

/** A detail whose own voucher differs from the requested one. */
const mismatchedDetail = JSON.stringify({
  Header: { Status: "1" },
  PirteyIska_204Bean: {
    chargeSum: BILLING,
    dealSum: ORIGINAL,
    voucherNumberRatz: MISMATCH_VOUCHER,
  },
});

function capture(
  mode: "recent" | "history",
  billingMonth: string,
  overrides: Partial<IsracardCapture> = {},
  responses: Partial<IsracardCapture["responses"]> = {},
): IsracardCapture {
  return {
    schemaVersion: 1,
    provider: "isracard",
    mode,
    billingMonth,
    card,
    legacyCardIndex: "0",
    responses: {
      cardList: rawCardList,
      digital,
      legacy,
      details: [{ voucherNumber: VOUCHER, responseText: detail }],
      ...responses,
    },
    ...overrides,
  };
}

const laterCapture = capture(
  "recent",
  "2041-12",
  {},
  {
    cardList: disguisedCardList,
    digital: adversarialDigital,
    details: [
      { voucherNumber: VOUCHER, responseText: detail },
      { voucherNumber: PLAN_VOUCHER, responseText: mismatchedDetail },
    ],
  },
);

/** Every invented leaf value in the provider bodies, for an exhaustive leak check. */
function inventedLeaves(): string[] {
  const leaves = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      leaves.add(value);
    } else if (typeof value === "number") {
      leaves.add(String(value));
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  for (const text of [
    rawCardList,
    disguisedCardList,
    digital,
    adversarialDigital,
    partialDigital,
    approvalsDigital,
    legacy,
    detail,
    mismatchedDetail,
  ]) {
    visit(JSON.parse(text));
  }
  // Short tokens (codes, flags, small counts) cannot be told apart from labels.
  return [...leaves].filter((leaf) => leaf.length >= 4);
}

const partnerCapture: IsracardCapture = {
  schemaVersion: 1,
  provider: "isracard",
  mode: "history",
  billingMonth: "2041-11",
  card: partner,
  responses: {
    cardList: rawCardList,
    digital: JSON.stringify({
      isSuccess: true,
      data: {
        approvals: null,
        israelAbroadVouchers: null,
        currentTransactionsList: null,
      },
    }),
  },
};

function response(value: IsracardCapture) {
  const accountKey = isracardCardKey(value.card);
  return {
    accountKey,
    endpoint: "isracard:card-month",
    capturedAt: "2041-12-01T00:00:00.000Z",
    responseText: serializeIsracardCapture(value),
    scope: { kind: value.mode, month: value.billingMonth, cardKey: accountKey },
  };
}

async function buildArchive(path: string): Promise<void> {
  const db = await openDatabase(path);
  try {
    await db.ensureConnection({ id: "synthetic-isr", provider: "isracard" });
    await db.ingestRun(
      {
        runId: "synthetic-run-1",
        connectionId: "synthetic-isr",
        responses: [
          response(capture("history", "2041-11")),
          response(partnerCapture),
        ],
      },
      isracardAdapter,
    );
    await db.ingestRun(
      {
        runId: "synthetic-run-2",
        connectionId: "synthetic-isr",
        responses: [response(laterCapture)],
        failures: [
          {
            accountKey: isracardCardKey(partner),
            endpoint: ISRACARD_ENDPOINTS.transactions,
            code: "network_error",
            scope: {
              kind: "recent",
              month: "2041-12",
              cardKey: isracardCardKey(partner),
            },
          },
        ],
      },
      isracardAdapter,
    );
    await db.ingestRun(
      {
        runId: "synthetic-run-3",
        connectionId: "synthetic-isr",
        responses: [],
        failures: [
          {
            accountKey: isracardCardKey(card),
            endpoint: ISRACARD_ENDPOINTS.transactions,
            code: "budget_exhausted",
            scope: {
              kind: "history",
              month: "2041-10",
              cardKey: isracardCardKey(card),
            },
          },
          {
            accountKey: null,
            endpoint: ISRACARD_ENDPOINTS.legacy,
            code: "network_error",
            scope: { kind: "history", month: "2041-10" },
          },
        ],
      },
      isracardAdapter,
    );
  } finally {
    await db.close();
  }
}

/**
 * A looser archive layout: no JSON checks, an extra column and table, a
 * second provider, and malformed records that no supported write path produces.
 */
function buildLooseArchive(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE connections (id TEXT, provider TEXT);
    CREATE TABLE sync_runs (id TEXT, connection_id TEXT, started_at TEXT,
      status TEXT, collector_version TEXT, parser_version TEXT, snapshot_json TEXT,
      coverage_json TEXT, warnings_json TEXT, applied_at TEXT, SYNTHETIC_SECRET_COLUMN TEXT);
    CREATE TABLE SYNTHETIC_SECRET_TABLE (value TEXT);
    PRAGMA user_version = 7319;
    INSERT INTO connections VALUES ('synthetic-isr', 'isracard'), ('synthetic-other', 'cal');
  `);
  const insert = raw.prepare(
    `INSERT INTO sync_runs (id, connection_id, started_at, status, collector_version,
      parser_version, snapshot_json, coverage_json, warnings_json)
     VALUES (?, ?, '2041-12-02T00:00:00.000Z', 'partial', ?,
      'SYNTHETIC_SECRET_VERSION', ?, '[]', ?)`,
  );
  insert.run(
    "synthetic-bad-1",
    "synthetic-isr",
    "isracard-web-v1",
    `{"responses": [ SYNTHETIC_SECRET_SNAPSHOT ${BILLING}`,
    JSON.stringify([
      `SYNTHETIC_SECRET_WARNING:${BILLING}`,
      "invalid_digital_response",
    ]),
  );
  const extraKey = JSON.parse(
    serializeIsracardCapture(capture("recent", "2041-12")),
  );
  extraKey.SYNTHETIC_SECRET_KEY = MERCHANT;
  const brokenLists = {
    ...capture("recent", "2041-12"),
    responses: {
      cardList: `SYNTHETIC_SECRET_CARDLIST { ${CARD_LIST_HOLDER}`,
      digital: `{"isSuccess": SYNTHETIC_SECRET ${BILLING}`,
      legacy: `{"Header": ${MERCHANT}`,
    },
  };
  insert.run(
    "synthetic-bad-2",
    "synthetic-isr",
    "isracard-web-v1",
    JSON.stringify({
      schemaVersion: 1,
      responses: [
        {
          ...response(capture("recent", "2041-12")),
          responseText: JSON.stringify(extraKey),
        },
        {
          ...response(capture("recent", "2041-12")),
          responseText: JSON.stringify(brokenLists),
        },
        {
          accountKey: isracardCardKey(card),
          endpoint: ISRACARD_ENDPOINTS.cards,
          capturedAt: "2041-12-02T00:00:00.000Z",
          responseText: rawCardList,
        },
        42,
      ],
    }),
    "[]",
  );
  // The capture claims the index of another card: its rows are never attributed.
  insert.run(
    "synthetic-bad-3",
    "synthetic-isr",
    "offline-v137",
    JSON.stringify({
      schemaVersion: 1,
      responses: [
        response(capture("history", "2042-01", { legacyCardIndex: "1" })),
      ],
    }),
    "[]",
  );
  // A capture archived with HTTP 500 is rejected by ingestion before extraction.
  insert.run(
    "synthetic-http-500",
    "synthetic-isr",
    "isracard-web-v1",
    JSON.stringify({
      schemaVersion: 1,
      responses: [
        { ...response(capture("history", "2042-02")), httpStatus: 500 },
      ],
    }),
    "[]",
  );
  // An empty success in one run cannot vouch for partial rows in another.
  for (const [id, body] of [
    ["synthetic-empty", emptyDigital],
    ["synthetic-partial", partialDigital],
    ["synthetic-complete", digital],
  ] as const) {
    insert.run(
      id,
      "synthetic-isr",
      "isracard-web-v1",
      JSON.stringify({
        schemaVersion: 1,
        responses: [
          response(capture("history", "2042-03", {}, { digital: body })),
        ],
      }),
      "[]",
    );
  }
  insert.run(
    "synthetic-approvals",
    "synthetic-isr",
    "isracard-web-v1",
    JSON.stringify({
      schemaVersion: 1,
      responses: [
        response(
          capture("history", "2042-04", {}, { digital: approvalsDigital }),
        ),
      ],
    }),
    "[]",
  );
  insert.run(
    "synthetic-other-provider",
    "synthetic-other",
    "isracard-web-v1",
    JSON.stringify({ responses: [{ responseText: MERCHANT }] }),
    "[]",
  );
  raw.close();
}

function listing(directory: string): string[] {
  return readdirSync(directory).sort();
}

function run(
  args: string[],
  env: Record<string, string> = {},
  nodeArguments = ["--no-warnings"],
) {
  return spawnSync(
    process.execPath,
    [
      ...nodeArguments,
      "--import",
      "tsx",
      "tests/providers/isracard/scripts/audit-isracard-db.ts",
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      // As documented: the loader then writes no compile cache anywhere.
      env: { ...process.env, TSX_DISABLE_CACHE: "1", ...env },
    },
  );
}

function expectNoSecrets(text: string): void {
  for (const secret of [...SECRETS, ...inventedLeaves()]) {
    expect(text, "an invented sensitive value leaked").not.toContain(secret);
  }
}

/** Checks every decoded key and value, so JSON escaping cannot hide a value. */
function expectNoDecodedSecrets(value: unknown): void {
  const secrets = [...SECRETS, ...inventedLeaves()];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      for (const secret of secrets) {
        expect(item, "an invented sensitive value leaked").not.toContain(
          secret,
        );
      }
    } else if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item !== null && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        visit(key);
        visit(child);
      }
    }
  };
  visit(value);
}

/** Words the profile may contain: the script, the domain model and fixture field names. */
function profileVocabulary(): Set<string> {
  const words = new Set<string>();
  const add = (text: string) => {
    for (const word of text.match(/[A-Za-z0-9]+/g) ?? []) {
      words.add(word);
    }
  };
  // Domain enum labels and totals-exclusion keys come from the model and read model.
  for (const source of [
    "./scripts/audit-isracard-db.ts",
    "../../../src/domain/model.ts",
    "../../../src/domain/read-model.ts",
  ]) {
    add(readFileSync(new URL(source, import.meta.url), "utf8"));
  }
  const visit = (value: unknown): void => {
    if (typeof value === "string" && /^\s*[[{]/.test(value)) {
      try {
        visit(JSON.parse(value));
      } catch {
        // Ordinary invented text, not a nested response.
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        add(key);
        visit(child);
      }
    }
  };
  const fixtures = new URL("./fixtures/", import.meta.url);
  for (const name of readdirSync(fixtures)) {
    if (name.endsWith(".json")) {
      visit(JSON.parse(readFileSync(new URL(name, fixtures), "utf8")));
    }
  }
  return words;
}

/**
 * Outside the two fixed explanation fields, every profile key and string is
 * built only from words in the script itself or fixture field names, short
 * numbers, and billing months; every other leaf is a non-negative integer
 * count or a boolean. Unseen names, identifiers and amounts cannot pass.
 */
function expectClosedVocabulary(profile: Record<string, unknown>): void {
  const words = profileVocabulary();
  const shekelLabels = new Set(["₪", 'ש"ח', "ש״ח"]);
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      for (const part of item.split("|")) {
        if (shekelLabels.has(part) || /^\d{4}-(?:0[1-9]|1[0-2])$/.test(part)) {
          continue;
        }
        expect(/^[\x21-\x7e]*$/.test(part), "non-ASCII profile text").toBe(
          true,
        );
        for (const token of part.match(/[A-Za-z0-9]+/g) ?? []) {
          // Short numbers are counts, lengths or version numbers.
          expect(
            /^(?:\d{1,2}|v\d{1,2})$/.test(token) || words.has(token),
            "profile token outside the closed vocabulary",
          ).toBe(true);
        }
      }
    } else if (typeof item === "number") {
      expect(Number.isSafeInteger(item) && item >= 0, "non-count number").toBe(
        true,
      );
    } else if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item !== null && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        visit(key);
        visit(child);
      }
    } else {
      expect(item === null || typeof item === "boolean").toBe(true);
    }
  };
  const { privacy, notes, ...rest } = profile;
  expect(typeof privacy).toBe("string");
  expect(Array.isArray(notes)).toBe(true);
  visit(rest);
}

/** Stdout is a closed set of total-only lines. */
const STDOUT_LINES = [
  /^Isracard profile \d+ \(parser isracard-v\d+\) written to the requested file\.$/,
  /^archives \d+; captures \d+ valid, \d+ invalid$/,
  /^cards \d+; legacy-only cards \d+$/,
  /^coverage (?:digital|legacy|details): (?:[a-z_]+ \d+(?:, [a-z_]+ \d+)*)?$/,
  /^distinct extracted transactions \d+$/,
  /^record errors \d+$/,
  /^replay ledgers kept in the requested directory$/,
];

function expectClosedStdout(stdout: string): void {
  for (const line of stdout.trimEnd().split("\n")) {
    expect(
      STDOUT_LINES.some((pattern) => pattern.test(line)),
      "unexpected stdout line",
    ).toBe(true);
  }
}

describe("value-free read-only Isracard archive profile", () => {
  let directory: string;
  let archives: string;
  let archive: string;
  let loose: string;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "fonds-isracard-audit-"));
    archives = join(directory, "archives");
    archive = join(archives, "invented.sqlite");
    // A separate directory shows that profiling and replay add no file beside the archive.
    mkdirSync(archives);
    await buildArchive(archive);
    loose = join(archives, "invented-loose.sqlite");
    buildLooseArchive(loose);
  });

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("profiles, maps coverage and replays without exposing invented values", () => {
    // The store leaves its write-ahead log beside the archive, as a live archive can.
    expect(existsSync(`${archive}-wal`)).toBe(true);
    const before = listing(archives).map((name) =>
      readFileSync(join(archives, name)),
    );
    const filesBefore = listing(archives);
    const out = join(directory, "profile.json");
    const kept = join(directory, "kept-replay");
    const result = run(
      ["--out", out, "--replay", "--keep-replay", kept, archive, loose],
      { TMPDIR: directory },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(listing(archives)).toEqual(filesBefore);
    expect(
      listing(archives).map((name) => readFileSync(join(archives, name))),
    ).toEqual(before);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const text = readFileSync(out, "utf8");
    expectNoSecrets(result.stdout);
    expectNoSecrets(text);
    // Billing months may appear in the private file, never on stdout.
    expect(text).toContain("2041-11");
    expect(result.stdout).not.toContain("2041");

    const profile = JSON.parse(text);
    expectNoDecodedSecrets(profile);
    expectClosedVocabulary(profile);
    expectClosedStdout(result.stdout);
    expect(profile.archives[0].runs).toMatchObject({
      isracardRuns: 3,
      invalidSnapshots: 0,
      applied: { applied: 3 },
      versions: {
        "collector|offline-v1": 3,
        "parser|isracard-v11": 3,
      },
    });
    expect(profile.archives[0].schema.unlistedTables).toBe(0);
    expect(profile.archives[1].schema).toMatchObject({
      userVersion: "<unlisted>",
      unlistedTables: 1,
      unlistedSyncRunColumns: 1,
    });
    expect(profile.archives[1].connectionsByProvider).toEqual({
      cal: 1,
      isracard: 1,
    });
    expect(profile.archives[1].runs).toMatchObject({
      isracardRuns: 8,
      otherProviderRuns: 1,
      invalidSnapshots: 1,
      statuses: { partial: 8 },
      versions: {
        "collector|<unlisted>": 1,
        "collector|isracard-web-v1": 7,
        "parser|<unlisted>": 8,
      },
      warnings: { "<unlisted>": 1, invalid_digital_response: 1 },
    });
    expect(profile.inventory.counts).toMatchObject({
      "captures|valid": 10,
      "captures|invalid-envelope": 1,
    });
    expect(profile.inventory.invalidEnvelopeIssues).toEqual({
      "unrecognized_keys|$": 1,
    });
    // Cards never merge across archives: the second archive's card is card-3.
    expect(profile.inventory).toMatchObject({ cards: 3, legacyOnlyCards: 2 });

    const matrix = profile.coverage.matrix;
    expect(matrix["card-1"].companyCode).toBe("11");
    expect(matrix["card-1"].months["2041-11"].digital.status).toBe(
      "successful_nonempty",
    );
    expect(matrix["card-1"].months["2041-11"].legacy.status).toBe(
      "successful_nonempty",
    );
    expect(matrix["card-1"].months["2041-11"].details.status).toBe(
      "successful_nonempty",
    );
    // A local budget stop never sent the request; a month-wide legacy failure did.
    expect(matrix["card-1"].months["2041-10"].digital.status).toBe(
      "unattempted",
    );
    expect(matrix["card-1"].months["2041-10"].legacy.status).toBe("failed");
    expect(matrix["card-2"].companyCode).toBe("77");
    expect(matrix["card-2"].months["2041-11"].digital.status).toBe(
      "successful_empty",
    );
    expect(matrix["card-2"].months["2041-11"].legacy.status).toBe(
      "unsupported",
    );
    expect(matrix["card-2"].months["2041-12"].digital.status).toBe("failed");
    // The same legacy body answering two months covers both months.
    expect(matrix["legacy-card-1"].months["2041-11"].legacy.status).toBe(
      "undiscoverable",
    );
    expect(matrix["legacy-card-1"].months["2041-12"].legacy.status).toBe(
      "undiscoverable",
    );
    // The disguised projection is treated as raw.
    expect(matrix["card-1"].cardList).toMatchObject({ "raw|bound": 2 });
    // A response that breaks the acceptance rules is partial, not successful.
    expect(matrix["card-1"].months["2041-12"].digital).toMatchObject({
      status: "partial",
      outcomes: { invalid_partial: 1 },
    });
    // Rows of another card's legacy index are never attributed.
    expect(matrix["card-3"]).toMatchObject({
      archive: "archive-2",
      connection: "connection-1",
    });
    expect(matrix["card-3"].months["2042-01"].legacy).toMatchObject({
      status: "failed",
      outcomes: { unbound: 1 },
      maxRows: 0,
    });
    expect(matrix["card-3"].months["2042-01"].digital.status).toBe(
      "successful_nonempty",
    );
    expect(matrix["card-3"].months["2042-02"].digital).toMatchObject({
      status: "failed",
      outcomes: { http_error: 1 },
      maxRows: 0,
    });
    // Neither an empty nor a nonempty complete response vouches for partial rows.
    expect(matrix["card-3"].months["2042-03"].digital).toMatchObject({
      status: "partial",
      outcomes: { success_empty: 1, invalid_partial: 1, success_rows: 1 },
    });
    // A detail bound to another voucher is not coverage, and one fetched
    // detail cannot vouch for it.
    expect(matrix["card-1"].months["2041-12"].details).toMatchObject({
      status: "partial",
      outcomes: { fetched: 1, unbound_detail: 1 },
    });
    expect(profile.extraction.captures["http-rejected"]).toBe(1);
    // Unsupported approvals make the card-month partial, as the extractor does.
    expect(matrix["card-3"].months["2042-04"].digital).toMatchObject({
      status: "partial",
      outcomes: { success_rows: 1, pending_unsupported: 1 },
    });

    // A code that looks like a placeholder is still only an unlisted value.
    expect(profile.codes.counts["digital.transactionCode"]).toEqual({
      "1": 8,
      "3": 2,
      "<unlisted>": 3,
      "<unlisted-small-integer>": 2,
    });
    expect(
      profile.codes.unlistedDistinctValues["digital.transactionCode"],
    ).toBe(3);
    expect(profile.codes.counts["digital.tranzacCodeType"]).toEqual({
      V: 13,
      "<unlisted>": 2,
    });

    const relationships = profile.relationships;
    expect(relationships["digital.discountVsOriginalMinusBilling"]).toEqual({
      "discount-nonzero|agree": 5,
      "discount-nonzero|amount-missing": 2,
      "discount-nonzero|disagree": 1,
      // Installment rows and the opposite-sign row: a delta with no discount.
      "discount-null|delta": 3,
      "discount-null|no-delta": 1,
      "discount-zero|disagree": 1,
    });
    // A number and the same digits as text stay distinct rows.
    expect(relationships["digital.billingSignByContainer"]).toMatchObject({
      "israelAbroadVouchersList|unparseable": 1,
    });
    // A missing operand is labelled by its own name.
    expect(relationships["digital.ilsAmountVsBillingAmount"]).toMatchObject({
      "domestic|ils-null~billing-present": 1,
      "domestic|ils-null~billing-unparseable": 1,
      "domestic|ils-present~billing-null": 1,
    });
    expect(relationships["digital.originalSignVsBillingSign"]).toEqual({
      "original-negative|billing-positive": 1,
      "original-positive|billing-null": 1,
      "original-positive|billing-positive": 12,
      "original-positive|billing-unparseable": 1,
    });
    expect(relationships["digital.installmentOriginalVsBilling"]).toEqual({
      "billing-times-count": 2,
    });
    expect(relationships["digital.isLastInstallmentVsOrdinal"]).toEqual({
      "true|final": 2,
    });
    expect(relationships["digital.ilsAmountVsBillingAmount"]).toEqual({
      // Includes an exponent lexeme equal to its plain spelling.
      "domestic|equal": 12,
      "domestic|ils-null~billing-present": 1,
      "domestic|ils-null~billing-unparseable": 1,
      "domestic|ils-present~billing-null": 1,
    });
    expect(
      relationships["detail.discountVsSumBeforeDiscountMinusCharge"],
    ).toEqual({
      "currency-unstated|discount|agree": 3,
      "missing|absent|positive|absent": 1,
    });
    // A detail bound to another voucher is never compared with a row.
    expect(relationships["detail.voucherBinding"]).toEqual({
      different: 1,
      equal: 3,
    });
    // The same detail without a DigitalV3 row is counted as its own case.
    expect(relationships["detail.matchedDigitalRow"]).toEqual({
      "binding-different": 1,
      none: 1,
      unique: 2,
    });
    // Equal lexemes never count as agreement while the detail's unit is unstated.
    expect(relationships["detail.chargeSumVsDigitalBilling"]).toEqual({
      "currency-unresolved|equal": 2,
    });
    expect(relationships["join.billingAmount"]).toEqual({
      "currency-agree|equal": 4,
    });
    expect(relationships["join.voucherNumberFields"]).toEqual({ equal: 4 });
    // Counted per accepted legacy body and billing month; HTTP 500 adds nothing.
    expect(relationships["legacy.cardIndexes"]).toEqual({
      discovered: 5,
      "not-in-card-list": 5,
    });

    const paths = Object.keys(profile.fieldProfiles.legacy);
    expect(paths).toContain(
      "$.CardsTransactionsListBean.Index<n>.CurrentCardTransactions[].txnIsrael[].paymentSum|string-decimal",
    );
    expect(paths).toContain("$.CardsTransactionsListBean.id<n>|object");
    // Unlisted provider keys appear by shape only; their names are only counted.
    const digitalPaths = Object.keys(profile.fieldProfiles.digital);
    expect(digitalPaths).toContain(
      "$.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[].<unlisted-key:upper-camel>|string-text",
    );
    expect(
      profile.unlistedKeyNamesPerPath[
        "$.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[]"
      ],
    ).toBe(3);
    expect(Object.keys(profile.fieldProfiles["cardList-raw"])).toContain(
      "$.data.cardsList[].limitData.limit|string-digits-6",
    );
    expect(profile.fieldProfiles["unlisted-endpoint-cards"]).toBeDefined();

    expect(profile.extraction.transactions.distinct).toBeGreaterThan(0);
    expect(profile.errors).toMatchObject({
      "parse_run_snapshot|SyntaxError": 1,
      "extract_capture|SyntaxError": 1,
    });

    const replay = profile.replay["archive-1"];
    expect(replay.results["status|partial"]).toBeGreaterThan(0);
    expect(replay.skipped).toEqual({});
    expect(profile.replay["archive-2"].skipped).toEqual({
      "endpoint-cards": 1,
      "unprojectable-capture": 2,
      "invalid-response": 1,
      "empty-run": 1,
    });
    expect(replay.ledger.transactions.rows).toBeGreaterThan(0);
    expect(replay.ledger.sourceIssues["<unlisted>"]).toBeUndefined();
    expect(replay.ledger.reviewReasons["<unlisted>"]).toBeUndefined();
    // Positive DigitalV3 rows with a purchase code map to purchases; the rest stay unknown.
    expect(replay.ledger.kind).toEqual({ purchase: 4, unknown: 4 });
    expect(replay.ledger.transactions.rows).toBe(8);
    expect(
      replay.totals["replay-1|spending"].excluded.unresolved,
    ).toBeGreaterThan(0);

    // The kept replay is owner-only and never received a raw card list.
    expect(result.stdout).toContain(
      "replay ledgers kept in the requested directory",
    );
    expect(result.stdout).not.toContain(directory);
    expect(statSync(kept).mode & 0o777).toBe(0o700);
    // Only the replay ledgers remain; the private archive copies are gone.
    expect(readdirSync(kept).every((name) => name.startsWith("archive-"))).toBe(
      true,
    );
    expect(readdirSync(kept).some((name) => name.includes("-copy"))).toBe(
      false,
    );
    for (const file of readdirSync(kept)) {
      const bytes = readFileSync(join(kept, file), "latin1");
      expect(bytes).not.toContain(CARD_LIST_HOLDER);
      expect(bytes).not.toContain(DISGUISED_HOLDER);
      expect(bytes).not.toContain(LIMIT);
    }
  }, 90_000);

  it("produces the same profile when every private value changes", async () => {
    // Same-length, same-class replacements that keep every relationship:
    // original minus billing still equals the discount, the plan total is
    // still three payments, and shared vouchers stay shared.
    const replacements: [RegExp | string, string][] = [
      ["Secret", "Covert"],
      ["SECRET", "COVERT"],
      ["HOLDER", "OWNERS"],
      ["Holder", "Owners"],
      ["Hostile", "Furtive"],
      ["AliceSmith", "BrianJones"],
      ["Bracketed", "Concealed"],
      [IDENTITY, "051627384"],
      [ACCOUNT_NUMBER, "55567890"],
      [LIMIT, "535353"],
      ["7319462", "8420573"],
      [BILLING, "654321.09"],
      [ORIGINAL, "765432.20"],
      [PLAN_PAYMENT, "234234.23"],
      [PLAN_TOTAL, "702702.69"],
      ["4815162342", "5926273453"],
      ["4815", "5926"],
      [SUFFIX, "9246"],
      [LEGACY_ONLY_SUFFIX, "5635"],
      [PARTNER_SUFFIX, "6719"],
      [PURCHASE_DATE, "14/11/2041"],
      ["10:11:12", "11:12:13"],
      [/(transactionCode\W{1,8})97/g, "$196"],
    ];
    const substitute = (text: string) =>
      replacements.reduce(
        (result, [from, to]) =>
          typeof from === "string"
            ? result.replaceAll(from, to)
            : result.replace(from, to),
        text,
      );
    const variants = join(directory, "variants");
    mkdirSync(variants);
    const copies = [archive, loose].map((source) => {
      const target = join(variants, source.slice(archives.length + 1));
      for (const suffix of ["", "-wal"]) {
        if (existsSync(`${source}${suffix}`)) {
          writeFileSync(
            `${target}${suffix}`,
            readFileSync(`${source}${suffix}`),
          );
        }
      }
      const db = new DatabaseSync(target);
      const rows = db
        .prepare("SELECT rowid, snapshot_json, warnings_json FROM sync_runs")
        .all() as {
        rowid: number;
        snapshot_json: string;
        warnings_json: string;
      }[];
      const update = db.prepare(
        "UPDATE sync_runs SET snapshot_json = ?, warnings_json = ? WHERE rowid = ?",
      );
      for (const row of rows) {
        const snapshot = substitute(row.snapshot_json);
        // The substitution must really change the private values it targets.
        for (const value of [MERCHANT, BILLING, ORIGINAL, VOUCHER, SUFFIX]) {
          expect(snapshot).not.toContain(value);
        }
        update.run(snapshot, substitute(row.warnings_json), row.rowid);
      }
      expect(rows.some((row) => row.snapshot_json.includes(BILLING))).toBe(
        true,
      );
      db.close();
      return target;
    });
    const profile = (paths: string[], name: string) => {
      const out = join(directory, name);
      const result = run(["--out", out, "--replay", ...paths], {
        TMPDIR: directory,
      });
      expect(result.status).toBe(0);
      return {
        stdout: result.stdout,
        profile: JSON.parse(readFileSync(out, "utf8")),
      };
    };
    const original = profile([archive, loose], "metamorphic-original.json");
    const changed = profile(copies, "metamorphic-changed.json");
    expect(changed.profile).toEqual(original.profile);
    expect(changed.stdout).toBe(original.stdout);
    const paths = Object.keys(original.profile.fieldProfiles.legacy);
    expect(paths.some((path) => path.includes("displayProperties.bank"))).toBe(
      false,
    );
    expect(paths).toContain(
      "$.CardsTransactionsListBean.Index<n>.CurrentCardTransactions[].txnIsrael[].displayProperties.<unlisted-key:lower-camel>|string-text",
    );
  }, 120_000);

  it("writes the whole profile even when each write call is short", () => {
    // Caps every fs.writeSync call, as a short write would. A single unchecked
    // writeSync of the profile would leave truncated JSON behind.
    const cap = `data:text/javascript,${encodeURIComponent(
      [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const write = fs.writeSync;",
        "fs.writeSync = (fd, data, ...rest) => typeof data === 'string'",
        "  ? write(fd, data.slice(0, 64)) : write(fd, data.subarray(0, 64));",
        "syncBuiltinESMExports();",
      ].join("\n"),
    )}`;
    const out = join(directory, "profile-short-writes.json");
    const result = run(["--out", out, archive], {}, [
      "--no-warnings",
      "--import",
      cap,
    ]);
    expect(result.status).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text.length).toBeGreaterThan(64);
    expect(() => JSON.parse(text)).not.toThrow();
  }, 90_000);

  it("keeps warning text off stderr and refuses an unsafe launch", () => {
    // A warning emitted before the script loads, as a dependency could.
    const warning = `data:text/javascript,process.emitWarning(${encodeURIComponent(JSON.stringify(`SYNTHETIC_SECRET_WARNING ${MERCHANT}`))})`;
    const out = join(directory, "profile-warning.json");
    const warned = run(["--out", out, archive], {}, [
      "--no-warnings",
      "--import",
      warning,
    ]);
    expect(warned.status).toBe(0);
    expect(warned.stderr).toBe("");
    expectNoSecrets(warned.stdout);
    expectNoSecrets(readFileSync(out, "utf8"));

    const printing = join(directory, "profile-printing.json");
    for (const unsafe of [
      run(["--out", printing, archive], {}, []),
      run(["--out", printing, archive], { TSX_DISABLE_CACHE: "0" }),
    ]) {
      expect(unsafe.status).toBe(1);
      expect(unsafe.stdout).toBe("");
      expect(unsafe.stderr).toMatch(
        /^Run as: TSX_DISABLE_CACHE=1 node --no-warnings/,
      );
    }
    expect(existsSync(printing)).toBe(false);
  }, 90_000);

  it("removes the replay by default", () => {
    const replayRoot = mkdtempSync(join(directory, "replay-root-"));
    const out = join(directory, "profile-default.json");
    const result = run(["--out", out, "--replay", archive], {
      TMPDIR: replayRoot,
    });
    expect(result.status).toBe(0);
    expect(
      readdirSync(replayRoot).filter((name) =>
        name.startsWith("fonds-isracard-audit-"),
      ),
    ).toEqual([]);
    expectNoSecrets(result.stdout);
  }, 90_000);

  it("fails with value-free errors and leaves no partial profile", () => {
    const notDatabase = join(
      archives,
      "SYNTHETIC_SECRET_NOT_A_DATABASE.sqlite",
    );
    writeFileSync(notDatabase, `SYNTHETIC_SECRET ${MERCHANT} ${BILLING}`);
    const out = join(directory, "failed-profile.json");
    const failed = run(["--out", out, notDatabase]);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toMatch(
      /^Isracard audit failed at read_schema \(\w+\)\.\n$/,
    );
    expect(existsSync(out)).toBe(false);

    // A hot rollback journal cannot be read without a write, so it is refused.
    const journaled = join(directory, "journaled");
    mkdirSync(journaled);
    const copy = join(journaled, "copy.sqlite");
    writeFileSync(copy, readFileSync(archive));
    writeFileSync(`${copy}-journal`, `SYNTHETIC_SECRET ${MERCHANT}`);
    const sidecar = run(["--out", out, copy]);
    expect(sidecar.status).toBe(1);
    expect(sidecar.stderr).toBe(
      "Isracard audit failed at open_archive (ArchiveSidecarError).\n",
    );
    expect(existsSync(out)).toBe(false);
    expect(listing(journaled)).toEqual(["copy.sqlite", "copy.sqlite-journal"]);

    const missing = run([
      "--out",
      join(directory, "missing-profile.json"),
      join(directory, `SYNTHETIC_SECRET_${SUFFIX}.sqlite`),
    ]);
    expect(missing.status).toBe(1);
    expectNoSecrets(missing.stderr);

    const unknown = run(["--private", MERCHANT, "--out", out, archive]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/^Usage: /);
    expectNoSecrets(unknown.stderr);

    // The profile never lands inside the repository or replaces an existing file.
    const inside = run(["--out", "SYNTHETIC-profile.json", archive]);
    expect(inside.status).toBe(1);
    expect(existsSync("SYNTHETIC-profile.json")).toBe(false);
    const existing = join(directory, "existing.json");
    writeFileSync(existing, "keep");
    const overwrite = run(["--out", existing, archive]);
    expect(overwrite.status).toBe(1);
    expect(readFileSync(existing, "utf8")).toBe("keep");
    // Nothing is created inside a directory that holds an archive.
    const filesBefore = listing(archives);
    const besideArchive = run(["--out", join(archives, "p.json"), archive]);
    const keptBeside = run([
      "--out",
      join(directory, "kept-beside.json"),
      "--replay",
      "--keep-replay",
      join(archives, "kept"),
      archive,
    ]);
    const temporaryBeside = run(
      ["--out", join(directory, "tmp-beside.json"), archive],
      { TMPDIR: archives },
    );
    const keptExisting = run([
      "--out",
      join(directory, "kept-existing.json"),
      "--replay",
      "--keep-replay",
      journaled,
      archive,
    ]);
    // A kept replay holds raw evidence, so it stays in temporary storage.
    const temporaryRoot = join(directory, "temporary-root");
    mkdirSync(temporaryRoot);
    const keptOutside = run(
      [
        "--out",
        join(directory, "kept-outside.json"),
        "--replay",
        "--keep-replay",
        join(directory, "kept-outside"),
        archive,
      ],
      { TMPDIR: temporaryRoot },
    );
    expect(existsSync(join(directory, "kept-outside"))).toBe(false);
    for (const refused of [
      besideArchive,
      keptBeside,
      temporaryBeside,
      keptExisting,
      keptOutside,
    ]) {
      expect(refused.status).toBe(1);
      expect(refused.stderr).toMatch(/^Usage: /);
    }
    expect(keptExisting.status).toBe(1);
    expect(existsSync(join(directory, "kept-existing.json"))).toBe(false);
    expect(listing(archives)).toEqual(filesBefore);
    for (const output of [
      failed,
      sidecar,
      missing,
      unknown,
      inside,
      overwrite,
      besideArchive,
      keptBeside,
      temporaryBeside,
      keptExisting,
      keptOutside,
    ]) {
      expectNoSecrets(output.stdout + output.stderr);
    }
  }, 90_000);
});
