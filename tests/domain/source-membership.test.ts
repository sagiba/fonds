import { describe, expect, it } from "vitest";

import {
  resourceKey,
  scopeKey,
  snapshotContainsRow,
  sourceCoverage,
} from "../../src/domain/plans/source-membership.js";
import type {
  CollectionScope,
  FinancialResponse,
  Partition,
} from "../../src/domain/records.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import { isracardAdapter } from "../../src/providers/isracard/adapter.js";

type Response = Omit<FinancialResponse, "responseText">;

type Row = Parameters<typeof snapshotContainsRow>[2];

const adapter: SourceAdapter = {
  provider: "synthetic",
  parserVersion: "synthetic-v1",
  retainProviderEvidence: () => ({}),
  extract: () => ({
    transactions: [],
    partitions: [],
    warnings: [],
    historical: false,
  }),
  sourceCoverage: {
    kind: "account_window",
    resources: ["recent"],
    dateField: "transactionDate",
    days: 60,
  },
  resourceKey: (endpoint) =>
    endpoint === "recent-alias" ? "recent" : endpoint,
};
const sameOrigin: SourceAdapter = {
  ...adapter,
  sourceCoverage: { kind: "same_origin" },
};

function response(fields: Partial<Response> = {}): Response {
  return {
    accountKey: "account",
    endpoint: "recent",
    capturedAt: "2040-08-02T23:59:00.000Z",
    scope: { kind: "recent" },
    ...fields,
  };
}

function partition(fields: Partial<Partition> = {}): Partition {
  return {
    accountKey: "account",
    resource: "recent",
    status: "posted",
    success: true,
    comparable: true,
    ...fields,
  };
}

function row(fields: Partial<Row> = {}): Row {
  return {
    sourceScope: "account",
    status: "posted",
    transactionDate: "2040-07-01",
    bookingDate: null,
    billingDate: null,
    purchaseId: null,
    installmentNumber: null,
    ...fields,
  };
}

function contains(
  fields: Partial<Row> = {},
  scope: CollectionScope = { kind: "recent" },
  cardKey?: string | null,
): boolean {
  const coverage = sourceCoverage(adapter, response({ scope }), partition());
  return (
    coverage !== undefined &&
    snapshotContainsRow(adapter, coverage, row(fields), undefined, cardKey)
  );
}

describe("declared account-window coverage", () => {
  it("reconstructs a body-independent descriptor and covers rows without requiring their previous origin", () => {
    const coverage = sourceCoverage(adapter, response(), partition());
    expect(coverage).toEqual({
      kind: "account_window",
      accountKey: "account",
      status: "posted",
      resource: "recent",
      scopeKey: '{"kind":"recent"}',
      capturedAt: "2040-08-02T23:59:00.000Z",
      dateField: "transactionDate",
      from: "2040-06-03",
      to: "2040-08-02",
    });
    const historical = response({
      endpoint: "history-search",
      scope: { kind: "history", from: "2040-01-01", to: "2040-07-31" },
    });
    expect(snapshotContainsRow(adapter, coverage!, row(), historical)).toBe(
      true,
    );
    expect(snapshotContainsRow(adapter, coverage!, row())).toBe(true);
  });

  it.each([
    ["2040-06-02", false],
    ["2040-06-03", true],
    ["2040-07-01", true],
    ["2040-08-02", true],
    ["2040-08-03", false],
    ["2040-06-31", false],
    [null, false],
  ])("tests declared purchase-date membership for %s", (date, expected) => {
    expect(contains({ transactionDate: date, bookingDate: "2040-07-01" })).toBe(
      expected,
    );
  });

  it("uses UTC capture dates rather than local offset dates", () => {
    const coverage = sourceCoverage(
      adapter,
      response({ capturedAt: "2040-08-03T01:30:00+03:00" }),
      partition(),
    );
    expect(coverage).toMatchObject({ from: "2040-06-03", to: "2040-08-02" });
  });

  it("uses only the declared date field, not a guessed alternate date", () => {
    const bookingAdapter: SourceAdapter = {
      ...adapter,
      sourceCoverage: {
        kind: "account_window",
        resources: ["recent"],
        dateField: "bookingDate",
        days: 60,
      },
    };
    const coverage = sourceCoverage(bookingAdapter, response(), partition())!;
    expect(snapshotContainsRow(bookingAdapter, coverage, row())).toBe(false);
    expect(
      snapshotContainsRow(
        bookingAdapter,
        coverage,
        row({ transactionDate: null, bookingDate: "2040-07-01" }),
      ),
    ).toBe(true);
  });

  it.each([
    { sourceScope: "another-account" },
    { status: "pending" as const },
    { purchaseId: "purchase" },
    { installmentNumber: 1 },
  ])("never covers a different partition or a billed line: %j", (fields) => {
    expect(contains(fields)).toBe(false);
  });

  it.each([
    { success: false },
    { comparable: false },
    { accountKey: "another-account" },
    { resource: "another-resource" },
    { scope: { kind: "history" as const } },
  ])("rejects incomplete or mismatched partition metadata: %j", (fields) => {
    expect(
      sourceCoverage(adapter, response(), partition(fields)),
    ).toBeUndefined();
  });

  it.each([
    { scope: { kind: "history" as const } },
    { httpStatus: 500 },
    { capturedAt: "invalid" },
    { endpoint: "undeclared-resource" },
  ])("rejects captures without recent coverage authority: %j", (fields) => {
    expect(
      sourceCoverage(adapter, response(fields), {
        accountKey: "account",
        status: "posted",
        success: true,
        comparable: true,
      }),
    ).toBeUndefined();
  });

  it("accepts only declared resource aliases", () => {
    expect(
      sourceCoverage(
        adapter,
        response({ endpoint: "recent-alias" }),
        partition(),
      ),
    ).toMatchObject({ kind: "account_window", resource: "recent" });
  });

  it.each([
    { month: "2040-07" },
    { filters: {} },
    { filters: { merchant: "synthetic" } },
  ])(
    "does not fall back to same-origin for unsupported criteria: %j",
    (fields) => {
      expect(
        sourceCoverage(
          adapter,
          response({ scope: { kind: "recent", ...fields } }),
          partition(),
        ),
      ).toBeUndefined();
    },
  );

  it("intersects actual request bounds while ignoring nominal overlap bounds", () => {
    const scope: CollectionScope = {
      kind: "recent",
      from: "2040-06-20",
      to: "2040-07-20",
      windowFrom: "2040-07-01",
      windowTo: "2040-07-10",
    };
    const coverage = sourceCoverage(adapter, response({ scope }), partition());
    expect(coverage).toMatchObject({ from: "2040-06-20", to: "2040-07-20" });
    expect(contains({ transactionDate: "2040-06-19" }, scope)).toBe(false);
    expect(contains({ transactionDate: "2040-06-20" }, scope)).toBe(true);
    expect(contains({ transactionDate: "2040-07-20" }, scope)).toBe(true);
    expect(contains({ transactionDate: "2040-07-21" }, scope)).toBe(false);
    expect(
      sourceCoverage(
        adapter,
        response({ scope: { kind: "recent", from: "2040-08-03" } }),
        partition(),
      ),
    ).toBeUndefined();
  });

  it("does not let broad request bounds expand the declared window", () => {
    const coverage = sourceCoverage(
      adapter,
      response({
        scope: { kind: "recent", from: "2040-01-01", to: "2040-12-31" },
      }),
      partition(),
    );
    expect(coverage).toMatchObject({ from: "2040-06-03", to: "2040-08-02" });
  });

  it.each([
    { from: "2040-06-31" },
    { to: "invalid" },
    { from: "2040-07-20", to: "2040-07-19" },
  ])("rejects invalid or reversed actual date bounds: %j", (fields) => {
    expect(
      sourceCoverage(
        adapter,
        response({ scope: { kind: "recent", ...fields } }),
        partition(),
      ),
    ).toBeUndefined();
  });

  it("requires resolved provider-card membership only for restricted captures", () => {
    const scope: CollectionScope = {
      kind: "recent",
      cardKeys: ["card-b", "card-a", "card-a"],
    };
    expect(
      sourceCoverage(adapter, response({ scope }), partition()),
    ).toMatchObject({ cardKeys: ["card-a", "card-b"] });
    expect(contains({}, scope, "card-a")).toBe(true);
    expect(contains({}, scope, "card-b")).toBe(true);
    expect(contains({}, scope, "card-c")).toBe(false);
    expect(contains({}, scope)).toBe(false);
    expect(contains({}, scope, null)).toBe(false);
    expect(contains()).toBe(true);
  });

  it("intersects singular and plural card restrictions without expanding either", () => {
    const scope: CollectionScope = {
      kind: "recent",
      cardKey: "card-a",
      cardKeys: ["card-a", "card-b"],
    };
    expect(contains({}, scope, "card-a")).toBe(true);
    expect(contains({}, scope, "card-b")).toBe(false);
    expect(contains({}, { ...scope, cardKey: "card-c" }, "card-c")).toBe(false);
  });

  it.each([-1, 0.5, Infinity])(
    "rejects invalid horizon declarations (%s)",
    (days) => {
      expect(
        sourceCoverage(
          {
            ...adapter,
            sourceCoverage: {
              kind: "account_window",
              resources: ["recent"],
              dateField: "transactionDate",
              days,
            },
          },
          response(),
          partition(),
        ),
      ).toBeUndefined();
    },
  );
});

describe("conservative same-origin coverage", () => {
  it("defaults undeclared adapters to matching retained resource and normalized scope", () => {
    const { sourceCoverage: _coverage, ...undeclared } = adapter;
    const coverage = sourceCoverage(undeclared, response(), partition())!;
    expect(coverage.kind).toBe("same_origin");
    expect(snapshotContainsRow(undeclared, coverage, row(), response())).toBe(
      true,
    );
    expect(snapshotContainsRow(undeclared, coverage, row())).toBe(false);
    expect(
      snapshotContainsRow(
        undeclared,
        coverage,
        row(),
        response({ endpoint: "recent-alias" }),
      ),
    ).toBe(true);
    expect(
      snapshotContainsRow(
        undeclared,
        coverage,
        row(),
        response({ endpoint: "history" }),
      ),
    ).toBe(false);
    expect(
      snapshotContainsRow(
        undeclared,
        coverage,
        row(),
        response({ accountKey: "another-account" }),
      ),
    ).toBe(false);
  });

  it("preserves normalized card-set equality but not different card or filter scopes", () => {
    const coverage = sourceCoverage(
      sameOrigin,
      response({ scope: { kind: "recent", cardKeys: ["b", "a", "a"] } }),
      partition(),
    )!;
    expect(
      snapshotContainsRow(
        sameOrigin,
        coverage,
        row(),
        response({ scope: { kind: "recent", cardKeys: ["a", "b"] } }),
      ),
    ).toBe(true);
    for (const scope of [
      { kind: "recent", cardKeys: ["a"] },
      {
        kind: "recent",
        cardKeys: ["a", "b"],
        filters: { merchant: "changed" },
      },
      { kind: "history", cardKeys: ["a", "b"] },
    ] satisfies CollectionScope[]) {
      expect(
        snapshotContainsRow(sameOrigin, coverage, row(), response({ scope })),
      ).toBe(false);
    }
  });

  it("retains the optional legacy date horizon without inventing origin", () => {
    const bounded = { ...sameOrigin, recentComparableDays: 60 };
    const coverage = sourceCoverage(bounded, response(), partition())!;
    expect(
      snapshotContainsRow(
        bounded,
        coverage,
        row({ transactionDate: null, bookingDate: "2040-07-01" }),
        response(),
      ),
    ).toBe(true);
    expect(
      snapshotContainsRow(
        bounded,
        coverage,
        row({ transactionDate: "2040-06-02", bookingDate: "2040-07-01" }),
        response(),
      ),
    ).toBe(false);
    expect(
      snapshotContainsRow(
        bounded,
        coverage,
        row({ transactionDate: null }),
        response(),
      ),
    ).toBe(false);
    expect(snapshotContainsRow(bounded, coverage, row())).toBe(false);
  });

  it("never turns a historical capture into negative evidence", () => {
    expect(
      sourceCoverage(
        sameOrigin,
        response({ scope: { kind: "history" } }),
        partition(),
      ),
    ).toBeUndefined();
  });

  it("keeps Isracard pending coverage card-month-specific and posted noncomparable", () => {
    const capture = response({
      endpoint: "synthetic:isracard/card-month",
      scope: { kind: "recent", month: "2040-07", cardKey: "card" },
    });
    const pending = partition({
      resource: "isracard:card-month",
      status: "pending",
    });
    const coverage = sourceCoverage(isracardAdapter, capture, pending)!;
    expect(coverage.kind).toBe("same_origin");
    expect(
      snapshotContainsRow(
        isracardAdapter,
        coverage,
        row({ status: "pending" }),
        { ...capture, scope: { ...capture.scope!, from: "2040-07-05" } },
      ),
    ).toBe(true);
    for (const scope of [
      { kind: "recent", month: "2040-08", cardKey: "card" },
      { kind: "recent", month: "2040-07", cardKey: "another-card" },
    ] satisfies CollectionScope[]) {
      expect(
        snapshotContainsRow(
          isracardAdapter,
          coverage,
          row({ status: "pending" }),
          { ...capture, scope },
        ),
      ).toBe(false);
    }
    expect(
      sourceCoverage(isracardAdapter, capture, {
        ...pending,
        status: "posted",
        comparable: false,
      }),
    ).toBeUndefined();
  });
});

describe("CAL coverage declaration", () => {
  const defaults = {
    merchantHebName: "",
    merchantHebCity: "",
    trnType: 0,
    fromTrnAmt: "0.00",
    toTrnAmt: "0.00",
    transactionsOrigin: 0,
    transCardPresentInd: 0,
  };
  const calResponse = response({ endpoint: "synthetic:cal/recent" });
  const calPartition = partition({ resource: "cal:recent" });

  it("opts in through data and treats normalized explicit filter defaults as unfiltered", () => {
    const coverage = sourceCoverage(
      calAdapter,
      { ...calResponse, scope: { kind: "recent", filters: { cal: defaults } } },
      calPartition,
    )!;
    expect(coverage).toMatchObject({
      kind: "account_window",
      dateField: "transactionDate",
      from: "2040-06-03",
      to: "2040-08-02",
    });
    expect(snapshotContainsRow(calAdapter, coverage, row())).toBe(true);
  });

  it.each([
    { cal: { ...defaults, merchantHebName: "Synthetic Merchant" } },
    { cal: { ...defaults, fromTrnAmt: "1.00" } },
    { cal: { ...defaults, unknown: true } },
    { cal: defaults, unknown: true },
    { unknown: true },
  ])(
    "rejects unknown or nondefault filters without same-origin fallback: %j",
    (filters) => {
      expect(
        sourceCoverage(
          calAdapter,
          { ...calResponse, scope: { kind: "recent", filters } },
          calPartition,
        ),
      ).toBeUndefined();
    },
  );
});

it("preserves resource and collection-unit normalization independently of membership", () => {
  expect(resourceKey(adapter, "recent-alias")).toBe("recent");
  expect(scopeKey(adapter)).toBe('{"kind":"recent"}');
  expect(
    scopeKey(adapter, {
      kind: "history",
      month: "2040-07",
      cardKeys: ["b", "a", "a"],
      from: "2040-07-02",
      to: "2040-07-20",
    }),
  ).toBe('{"cardKeys":["a","b"],"kind":"history","month":"2040-07"}');
  expect(
    scopeKey(adapter, {
      kind: "recent",
      from: "2040-06-29",
      to: "2040-08-02",
      windowFrom: "2040-07-01",
      windowTo: "2040-07-31",
    }),
  ).toBe('{"from":"2040-07-01","kind":"recent","to":"2040-07-31"}');
});
