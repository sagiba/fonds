import { describe, expect, it } from "vitest";

import { emptyDetails, type TransactionInput } from "../../src/domain/model.js";
import type { NarrowRow } from "../../src/domain/plans/state.js";
import {
  namedWindows,
  scopeNames,
  syncScope,
} from "../../src/domain/plans/sync-scope.js";
import type { CollectionScope } from "../../src/domain/records.js";

const adapter = {
  provider: "cal",
  sourceCoverage: {
    kind: "same_origin" as const,
    statuses: ["pending" as const],
  },
};

function observed(transactionDate: string): TransactionInput {
  return {
    sourceScope: "account",
    cardKey: "card",
    sourceKey: `key-${transactionDate}`,
    sourceAliases: [],
    identityStrength: "native",
    status: "posted",
    description: null,
    counterpartyName: null,
    kind: "purchase",
    merchantName: "Merchant",
    merchantProviderId: null,
    merchantCategoryCode: null,
    transactionDate,
    bookingDate: null,
    billingDate: null,
    amountMinor: -100,
    currency: "ILS",
    amountBasis: "purchase_commitment",
    originalAmountMinor: null,
    originalCurrency: null,
    installmentCount: null,
    details: emptyDetails(),
  };
}

/** One response's extraction, as `syncScope` reads it. */
function extraction(scope: CollectionScope, rows: TransactionInput[]) {
  return {
    extracted: [
      {
        response: {
          accountKey: "account",
          endpoint: "synthetic",
          capturedAt: "2040-07-01T12:00:00.000Z",
          responseText: "[]",
          scope,
        },
        result: {
          transactions: rows,
          partitions: [],
          historical: scope.kind === "history",
          warnings: [],
        },
        recentCutoff: undefined,
        deferred: [],
      },
    ],
  } as unknown as Parameters<typeof syncScope>[0];
}

const transactionWindows = (scope: ReturnType<typeof syncScope>) =>
  scope.windows
    .filter((window) => window.field === "transaction")
    .map(({ from, to }) => ({ from, to }));

describe("sync scope windows", () => {
  it("pads the requested dates by the configured days and an observation by the candidate distance", () => {
    const scope = syncScope(
      extraction({ kind: "recent" }, [observed("2040-03-10")]),
      adapter,
      40,
    );
    // Captured 2040-07-01: 40 days either side. The row observed on
    // 2040-03-10 brings only the seven days either side of its date.
    expect(scope.requestScope).toEqual({
      from: "2040-05-22",
      to: "2040-08-10",
    });
    expect(transactionWindows(scope)).toEqual([
      { from: "2040-03-03", to: "2040-03-17" },
      { from: "2040-05-22", to: "2040-08-10" },
    ]);
    expect(
      scope.windows
        .filter((window) => window.field === "billing")
        .map(({ from, to }) => ({ from, to })),
    ).toEqual([{ from: "2040-05-22", to: "2040-08-10" }]);
  });

  it("keeps windows near the first calendar day within year 0001", () => {
    const scope = syncScope(
      extraction({ kind: "history", month: "0001-01" }, [
        observed("0001-01-15"),
      ]),
      adapter,
      40,
    );
    // January 0001 less 40 days would be year zero; 31 January plus 40
    // days is 12 March in a common year.
    expect(scope.requestScope).toEqual({
      from: "0001-01-01",
      to: "0001-03-12",
    });
    expect(transactionWindows(scope)).toEqual([
      { from: "0001-01-01", to: "0001-03-12" },
    ]);
    expect(
      namedWindows([
        {
          sourceScope: "account",
          transactionDate: "0001-01-03",
        } as NarrowRow,
      ]),
    ).toEqual([
      {
        sourceScope: "account",
        field: "transaction",
        from: "0001-01-01",
        to: "0001-01-10",
      },
    ]);
  });

  it("keeps windows near the last calendar day within year 9999", () => {
    const scope = syncScope(
      extraction({ kind: "history" }, [observed("9999-12-28")]),
      adapter,
      40,
    );
    // An observation is padded by the candidate distance, clamped at the
    // last calendar day.
    expect(scope.requestScope).toBeUndefined();
    expect(transactionWindows(scope)).toEqual([
      { from: "9999-12-21", to: "9999-12-31" },
    ]);
    expect(
      namedWindows([
        {
          sourceScope: "account",
          transactionDate: "9999-12-28",
        } as NarrowRow,
      ]),
    ).toEqual([
      {
        sourceScope: "account",
        field: "transaction",
        from: "9999-12-21",
        to: "9999-12-31",
      },
    ]);
  });
});

describe("named rows", () => {
  it("names a row by an alias equal to an observation's key, and not by another alias", () => {
    const named = scopeNames({ keys: ["current-key"], bases: [] }, "cal");
    const row = (sourceAliases: string[]) =>
      ({
        sourceKey: "stored-key",
        sourceAliases,
        providerIdentity: {},
        hydration: "narrow",
      }) as unknown as NarrowRow;
    expect(named(row(["current-key"]))).toBe(true);
    expect(named(row(["earlier-key"]))).toBe(false);
  });
});
