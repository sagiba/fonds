import { describe, expect, it } from "vitest";

import {
  emptyDetails,
  type StoredTransactionFacts,
  type TransactionFacts,
  type TransactionInput,
  unknownLedgerFacts,
} from "../../src/domain/model.js";
import { reviewState } from "../../src/domain/plans/annotation.js";
import {
  automaticPostingPairs,
  postingComponents,
} from "../../src/domain/plans/auto-posting.js";
import { planUnlinkPosting } from "../../src/domain/plans/lifecycle.js";
import { FinancialPlan, type LedgerRow } from "../../src/domain/plans/state.js";
import {
  extractRun,
  planRun,
  type PriorRun,
} from "../../src/domain/plans/sync.js";
import type {
  CollectionScope,
  Run,
  Transaction,
} from "../../src/domain/records.js";
import type {
  AutomaticPostingCapability,
  SourceAdapter,
} from "../../src/domain/source-adapter.js";
import { compatiblePostingGroups } from "../helpers/posting-evidence.js";

const capability: AutomaticPostingCapability = {
  compatibleGroups: compatiblePostingGroups,
  pendingAmountBasis: "authorization",
  postedAmountBasis: "purchase_commitment",
};

function row(
  sourceKey: string,
  fields: Partial<TransactionInput> = {},
): TransactionInput {
  return {
    sourceScope: "account",
    cardKey: "card",
    sourceKey,
    sourceAliases: [],
    identityStrength: "native",
    status: "posted",
    description: "Synthetic",
    counterpartyName: null,
    kind: "purchase",
    merchantName: "Merchant",
    merchantProviderId: null,
    merchantCategoryCode: null,
    transactionDate: "2040-07-01",
    bookingDate: null,
    billingDate: null,
    amountMinor: -100,
    currency: "ILS",
    amountBasis: capability.postedAmountBasis,
    originalAmountMinor: null,
    originalCurrency: null,
    installmentCount: null,
    details: emptyDetails(),
    ...fields,
  };
}

/** Synthetic card and purchase service IDs equal their provider keys (see `catalog`). */
function facts({
  cardKey,
  purchaseKey,
  installmentNumber,
  ...input
}: TransactionInput): StoredTransactionFacts {
  return {
    ...input,
    counterpartyName: input.counterpartyName ?? null,
    ...unknownLedgerFacts(cardKey),
    installmentNumber: installmentNumber ?? null,
    purchaseId: purchaseKey ?? null,
  };
}

const catalog = {
  cards: ["card", "other"].map((key) => ({
    id: key,
    connectionId: "posting",
    providerKey: key,
    billingAccountId: null,
    last4: null,
    displayName: null,
    attributes: null,
    createdAt: "2040-07-01T00:00:00.000Z",
    lastSeenAt: null,
  })),
  accounts: [],
};

function postedFacts(
  sourceKey: string,
  fields: Partial<TransactionInput> = {},
) {
  return facts(row(sourceKey, fields));
}

function pendingInput(key: string, fields: Partial<TransactionInput> = {}) {
  return row(key, {
    status: "pending",
    amountBasis: capability.pendingAmountBasis,
    ...fields,
  });
}

function pending(
  key: string,
  fields: Partial<TransactionInput> = {},
): Transaction {
  return {
    ...facts(pendingInput(key, fields)),
    id: key,
    connectionId: "posting",
    presence: "seen",
    firstSeenAt: "2040-07-02T00:00:00Z",
    lastSeenAt: "2040-07-02T00:00:00Z",
    lastSeenRunId: "first",
    version: 1,
    supersededById: null,
  };
}

const fakeAdapter: SourceAdapter = {
  provider: "FAKE",
  parserVersion: "fake-v1",
  sourceCoverage: { kind: "same_origin", statuses: ["pending", "posted"] },
  retainProviderEvidence: () => ({}),
  automaticPosting: {
    compatibleGroups: compatiblePostingGroups,
    pendingAmountBasis: "authorization",
    postedAmountBasis: "booked_entry",
  },
  recentComparableDays: 60,
  extract: (text) => ({
    transactions: JSON.parse(text) as TransactionInput[],
    partitions: (["pending", "posted"] as const).map((status) => ({
      accountKey: "account",
      status,
      success: true,
      comparable: true,
    })),
    historical: false,
    warnings: [],
  }),
};

function pairs(
  pendingRows: Transaction[],
  postedRows: (TransactionInput | TransactionFacts)[],
  disappearing = new Set(pendingRows.map((row) => row.id)),
) {
  return automaticPostingPairs(
    pendingRows,
    postedRows.map((row) => ("cardKey" in row ? facts(row) : row)),
    new Map(
      pendingRows
        .filter((row) => disappearing.has(row.id))
        .map((row) => [row, row]),
    ),
    capability,
  ).pairs;
}

function prior(
  id: string,
  day: number,
  coverage: {
    status: "pending" | "posted";
    success: boolean;
    comparable: boolean;
  }[],
  priorScope?: CollectionScope,
): PriorRun {
  return {
    id,
    status: "completed",
    startedAt: `2040-07-0${day}T00:00:00Z`,
    coverage: coverage.map((partition) => ({
      ...partition,
      accountKey: "account",
      resource: "synthetic:fake/recent",
      ...(priorScope ? { scope: priorScope } : {}),
    })),
    snapshot: {
      responses: [
        {
          accountKey: "account",
          endpoint: "synthetic:fake/recent",
          capturedAt: `2040-07-0${day}T00:00:00Z`,
          ...(priorScope ? { scope: priorScope } : {}),
        },
      ],
    },
  };
}

function capturePlan(
  rows: LedgerRow[],
  inputs: TransactionInput[],
  day = 3,
  automatic = true,
  options: {
    adapter?: Partial<SourceAdapter>;
    priorRuns?: PriorRun[];
    scope?: CollectionScope;
    removals?: { transactionId: string; createdAt: string }[];
  } = {},
) {
  const { automaticPosting: _capability, ...manualAdapter } = fakeAdapter;
  const adapter: SourceAdapter = {
    ...manualAdapter,
    ...(automatic ? { automaticPosting: capability } : {}),
    pendingPostingCandidates: true,
    ...options.adapter,
  };
  const plan = new FinancialPlan({
    connection: {
      id: "posting",
      provider: adapter.provider,
      displayName: "Synthetic",
      config: { schemaVersion: 1 },
      createdAt: "2040-07-01T00:00:00Z",
    },
    rows,
    annotations: [],
    priorRuns:
      options.priorRuns ??
      (rows.length
        ? [
            prior(
              "first",
              2,
              [
                { status: "pending", success: true, comparable: true },
                { status: "posted", success: true, comparable: true },
              ],
              options.scope,
            ),
          ]
        : []),
    removals: options.removals ?? [],
    catalog,
  });
  const run: Run = {
    id: `run-${day}`,
    connectionId: "posting",
    startedAt: `2040-07-0${day}T00:00:00Z`,
    completedAt: null,
    refreshId: null,
    evidenceDigest: "0".repeat(64),
    bodyAvailable: true,
    bodyRetention: "staged",
    bodyExpiresAt: null,
    appliedAt: null,
    status: "started",
    collectorVersion: "synthetic",
    parserVersion: adapter.parserVersion,
    snapshot: {
      schemaVersion: 1,
      responses: [
        {
          accountKey: "account",
          endpoint: "synthetic:fake/recent",
          capturedAt: `2040-07-0${day}T00:00:00Z`,
          responseText: JSON.stringify(inputs),
          ...(options.scope ? { scope: options.scope } : {}),
        },
      ],
    },
    coverage: [],
    warnings: [],
  };
  let nextId = 0;
  planRun(
    plan,
    run,
    adapter,
    extractRun(run, adapter),
    run.startedAt,
    () => `new-${day}-${nextId++}`,
  );
  return plan;
}

function permutations<T>(values: T[]): T[][] {
  return values.length === 0
    ? [[]]
    : values.flatMap((value, index) =>
        permutations(values.filter((_, other) => other !== index)).map(
          (rest) => [value, ...rest],
        ),
      );
}

describe("automatic posting candidate graph", () => {
  it("keeps unrelated merchants ineligible inside the broad group", () => {
    const authorization = pending("pending");
    const posted = postedFacts("posted", { merchantName: "Other merchant" });
    expect(pairs([authorization], [posted]).size).toBe(0);
  });

  it("does not extract matching subgroups around unrelated shop competitors", () => {
    expect(
      pairs(
        [pending("p-a"), pending("p-b", { merchantName: "Other" })],
        [row("s-a"), row("s-b", { merchantName: "Other" })],
      ).size,
    ).toBe(0);
  });

  it.each([2, 3])(
    "pairs k=%i twins by first-seen time then native key under every input permutation",
    (count) => {
      const pendingRows = Array.from({ length: count }, (_, index) =>
        pending(`pending-${index}`),
      );
      // Earlier first-seen takes precedence over lexical native-key order.
      pendingRows[count - 1]!.firstSeenAt = "2040-07-01T00:00:00Z";
      const postedRows = Array.from({ length: count }, (_, index) =>
        postedFacts(`posted-${index}`),
      );
      const expected = [
        pendingRows[count - 1]!,
        ...pendingRows.slice(0, -1),
      ].map((authorization, index) => [
        postedRows[index]!.sourceKey,
        authorization.sourceKey,
      ]);
      for (const pending of permutations(pendingRows)) {
        for (const posted of permutations(postedRows)) {
          expect(
            [...pairs(pending, posted)].map(([posted, pending]) => [
              posted.sourceKey,
              pending.sourceKey,
            ]),
          ).toEqual(expected);
        }
      }
    },
  );

  it.each([
    [1, 2],
    [2, 1],
  ])(
    "leaves unequal %i-pending/%i-posted components unlinked",
    (pendingCount, postedCount) => {
      expect(
        pairs(
          Array.from({ length: pendingCount }, (_, index) =>
            pending(`pending-${index}`),
          ),
          Array.from({ length: postedCount }, (_, index) =>
            row(`posted-${index}`),
          ),
        ).size,
      ).toBe(0);
    },
  );

  it.each([1, 2])(
    "blocks attribution with an already-unlisted competitor and %i posted rows",
    (count) => {
      const old = { ...pending("old"), presence: "not_returned" as const };
      const current = pending("current");
      expect(
        pairs(
          [old, current],
          Array.from({ length: count }, (_, index) => row(`posted-${index}`)),
          new Set([current.id]),
        ).size,
      ).toBe(0);
    },
  );

  it("requires same-run disappearance even for an isolated pair", () => {
    expect(pairs([pending("pending")], [row("posted")], new Set()).size).toBe(
      0,
    );
  });

  it("blocks an ineligible pending competitor before eligibility filtering", () => {
    const clean = pending("clean");
    const flagged = pending("flagged", {
      details: { ...emptyDetails(), issues: ["unsupported_direction"] },
    });
    expect(pairs([clean, flagged], [row("posted")]).size).toBe(0);
  });

  it("blocks a new posted row when an earlier unlinked posted row is plausible", () => {
    const old = postedFacts("old");
    const fresh = postedFacts("fresh");
    const authorization = pending("pending");
    expect(
      automaticPostingPairs(
        [authorization],
        [old, fresh],
        new Map([[authorization, authorization]]),
        capability,
        new Set([fresh]),
      ).pairs.size,
    ).toBe(0);
  });

  it("does not pair two disappearing twins with one earlier and one new posting", () => {
    const pendingRows = [pending("pending-a"), pending("pending-b")];
    const old = postedFacts("old");
    const fresh = postedFacts("fresh");
    expect(
      automaticPostingPairs(
        pendingRows,
        [old, fresh],
        new Map(pendingRows.map((row) => [row, row])),
        capability,
        new Set([fresh]),
      ).pairs.size,
    ).toBe(0);
  });

  it("keeps a split pending competitor in the complete component", () => {
    const split = pending("split", {
      details: { ...emptyDetails(), rejectedPostingKeys: ["other-posted"] },
    });
    expect(
      pairs([split, pending("clean")], [row("posted")], new Set(["clean"]))
        .size,
    ).toBe(0);
  });

  it.each(["pending", "posted"] as const)(
    "vetoes a split %s row against a different native identity",
    (side) => {
      const pendingRow = pending("pending");
      const postedRow = row("posted");
      (side === "pending"
        ? pendingRow
        : postedRow
      ).details.rejectedPostingKeys = ["unrelated-key"];
      expect(pairs([pendingRow], [postedRow]).size).toBe(0);
    },
  );

  it("planner keeps an issue-bearing pending competitor in review", () => {
    const plan = capturePlan(
      [
        pending("clean"),
        pending("flagged", {
          details: { ...emptyDetails(), issues: ["unsupported_direction"] },
        }),
      ],
      [row("posted", { merchantName: "Different merchant" })],
    );
    expect(
      plan.events.filter((event) => event.type === "transaction.posted"),
    ).toEqual([]);
    expect(plan.orderedRows().every((row) => reviewState(row).required)).toBe(
      true,
    );
    expect(plan.transaction("clean")!.status).toBe("pending");
  });

  it("planner blocks a later posted competitor across captures", () => {
    const first = capturePlan(
      [pending("pending")],
      [pendingInput("pending"), row("old")],
    );
    const next = capturePlan(first.orderedRows(), [row("fresh")], 4);
    expect(
      next.events.filter((event) => event.type === "transaction.posted"),
    ).toEqual([]);
    expect(next.transaction("pending")!.status).toBe("pending");
    expect(next.orderedRows()).toHaveLength(3);
    expect(
      next.transaction("pending")!.details.pendingPostingCandidates,
    ).toHaveLength(2);
  });

  it.each(["pending", "posted"] as const)(
    "keeps current known %s corrections in the complete candidate component",
    (status) => {
      for (const aliased of [false, true]) {
        const competitor = pending("competitor", {
          status,
          amountBasis:
            status === "pending" ? "authorization" : "purchase_commitment",
          amountMinor: -200,
        });
        const corrected = row(aliased ? "current-competitor" : "competitor", {
          status,
          amountBasis: competitor.amountBasis,
          sourceAliases: aliased ? ["competitor"] : [],
        });
        const plan = capturePlan(
          [pending("pending"), competitor],
          [corrected, row("posted")],
        );
        expect(
          plan.transaction("pending")!.status,
          `${status}, alias=${aliased}`,
        ).toBe("pending");
        expect(
          plan.events.some((event) => event.type === "transaction.posted"),
        ).toBe(false);
      }
    },
  );

  it.each(["pending", "posted"] as const)(
    "keeps current corrected %s reappearances as blockers after owner removal",
    (status) => {
      const competitor = pending("removed", {
        status,
        amountBasis:
          status === "pending" ? "authorization" : "purchase_commitment",
        amountMinor: -200,
      });
      competitor.presence = "removed";
      competitor.version = 2;
      const plan = capturePlan(
        [pending("pending"), competitor],
        [
          row("removed", { status, amountBasis: competitor.amountBasis }),
          row("posted"),
        ],
        3,
        true,
        {
          removals: [
            { transactionId: "removed", createdAt: "2040-07-02T12:00:00Z" },
          ],
        },
      );
      expect(plan.transaction("pending")!.status).toBe("pending");
      expect(plan.transaction("removed")!.presence).toBe("seen");
      expect(
        plan.events.some((event) => event.type === "transaction.posted"),
      ).toBe(false);
    },
  );

  it("does not revive a linked pending alias as a competing authorization", () => {
    const linked = capturePlan(
      [pending("linked", { amountMinor: -200 })],
      [row("linked-posted", { amountMinor: -200 })],
    );
    const plan = capturePlan(
      [pending("pending"), ...linked.orderedRows()],
      [pendingInput("linked"), row("posted")],
      4,
    );
    expect(plan.transaction("pending")!.status).toBe("posted");
    expect(plan.transaction("linked")).toMatchObject({
      status: "posted",
      amountMinor: -200,
    });
    expect(
      plan.events.filter((event) => event.type === "transaction.posted"),
    ).toHaveLength(1);
  });

  it("planner keeps a split pending blocker beside a new pair", () => {
    const linked = capturePlan([pending("split")], [row("original-posted")]);
    const survivor = linked.hydrated("split")!;
    const postedId = survivor.details.postingLink!.postedId;
    const { pending: split } = planUnlinkPosting(
      linked,
      {
        pendingId: survivor.id,
        postedId,
        expectedPendingVersion: survivor.version,
        expectedPostedVersion: linked.transaction(postedId)!.version,
        expectedPendingAnnotationVersion: 0,
        expectedPostedAnnotationVersion: 0,
        reason: "Synthetic owner split",
      },
      "2040-07-03T01:00:00Z",
    );
    const plan = capturePlan([split, pending("clean")], [row("posted")], 4);
    expect(
      plan.events.filter((event) => event.type === "transaction.posted"),
    ).toEqual([]);
    expect(plan.transaction("clean")!.status).toBe("pending");
    expect(plan.orderedRows().every((row) => reviewState(row).required)).toBe(
      true,
    );
  });

  it("keeps a listed exact-key pending component in review", () => {
    const listed = pending("listed", { merchantName: "Shop X" });
    const plan = capturePlan(
      [listed],
      [
        pendingInput("listed", { merchantName: "Shop X" }),
        row("posted", { merchantName: "Shop Y" }),
      ],
    );
    expect(
      plan.events.filter((event) => event.type === "transaction.posted"),
    ).toEqual([]);
    expect(plan.orderedRows().every((row) => reviewState(row).required)).toBe(
      true,
    );
    expect(
      plan.transaction(listed.id)!.details.pendingPostingCandidates,
    ).toHaveLength(1);
  });

  it("keeps unresolved FX in stable review against a plausible pending row", () => {
    const authorization = pending("pending", {
      merchantName: "Shop X",
      currency: "MXN",
    });
    const posted = row("fx", {
      merchantName: "Shop Y",
      amountMinor: -350,
      details: { ...emptyDetails(), issues: ["unsupported_original_currency"] },
    });
    const first = capturePlan([authorization], [posted]);
    const postedRow = first
      .orderedRows()
      .find((row) => row.sourceKey === "fx")!;
    expect(first.transaction("pending")).toMatchObject({
      status: "pending",
      details: { pendingPostingCandidates: [postedRow.id] },
    });
    expect(postedRow.details.pendingPostingCandidates).toEqual(["pending"]);
    const next = capturePlan(first.orderedRows(), [posted], 4);
    expect(
      next.transaction("pending")!.details.pendingPostingCandidates,
    ).toEqual([postedRow.id]);
    expect(
      next.events.filter((event) =>
        event.type.startsWith("transaction.review_"),
      ),
    ).toEqual([]);
    expect(
      next.events.filter((event) => event.type === "transaction.posted"),
    ).toEqual([]);
  });

  it.each([
    { cardKey: "other" },
    { transactionDate: "2040-07-02" },
    { currency: "ILS" },
    { kind: "refund", amountMinor: 100, currency: "MXN" },
    { kind: "refund", amountMinor: -100, currency: "MXN" },
    { kind: "purchase", amountMinor: 100, currency: "MXN" },
    { kind: "unknown", currency: "MXN" },
    { amountMinor: 0, currency: "MXN" },
    { cardKey: null },
    { transactionDate: null },
    { currency: null, amountMinor: null },
  ] satisfies Partial<TransactionInput>[])(
    "does not suggest unresolved FX with incompatible pending evidence %j",
    (fields) => {
      const plan = capturePlan(
        [pending("pending", { currency: "MXN", ...fields })],
        [
          row("fx", {
            merchantName: "Shop Y",
            amountMinor: -350,
            details: {
              ...emptyDetails(),
              issues: ["unsupported_original_currency"],
            },
          }),
        ],
      );
      expect(
        plan.transaction("pending")!.details.pendingPostingCandidates ?? [],
      ).toEqual([]);
    },
  );

  it("planner includes a newly listed pending competitor", () => {
    const plan = capturePlan(
      [pending("old")],
      [
        row("new-pending", { status: "pending", amountBasis: "authorization" }),
        row("posted"),
      ],
    );
    expect(
      plan.events.filter((event) => event.type === "transaction.posted"),
    ).toEqual([]);
    expect(plan.transaction("old")!.status).toBe("pending");
    expect(plan.orderedRows().every((row) => reviewState(row).required)).toBe(
      true,
    );
  });

  it.each([true, false])(
    "keeps merchant-based ordinary review rules: automatic %s",
    (automatic) => {
      const listed = pending("pending", {
        merchantName: "Shop X",
        transactionDate: "2040-07-04",
      });
      const plan = capturePlan(
        [listed],
        [
          pendingInput("pending", {
            merchantName: "Shop X",
            transactionDate: "2040-07-04",
          }),
          row("posted", {
            merchantName: "Shop Y",
            transactionDate: "2040-07-01",
          }),
        ],
        5,
        automatic,
      );
      expect(
        plan.orderedRows().every((row) => !reviewState(row).required),
      ).toBe(true);
      expect(
        plan
          .orderedRows()
          .flatMap((row) => row.details.pendingPostingCandidates ?? []),
      ).toEqual([]);
    },
  );

  it.each<[string, Partial<TransactionInput>, Partial<TransactionInput>]>([
    ["earlier date", {}, { transactionDate: "2040-06-30" }],
    ["later date", {}, { transactionDate: "2040-07-02" }],
    ["amount", {}, { amountMinor: -101 }],
    ["currency", {}, { currency: "USD" }],
    ["card", {}, { cardKey: "other" }],
    ["account", {}, { sourceScope: "other" }],
    ["missing card", { cardKey: null }, { cardKey: null }],
    ["missing date", { transactionDate: null }, { transactionDate: null }],
    [
      "unknown money",
      { amountMinor: null, currency: null },
      { amountMinor: null, currency: null },
    ],
    ["weak identity", { identityStrength: "weak" }, {}],
    ["unknown kind", { kind: "unknown" }, {}],
    ["pending basis", { amountBasis: "booked_entry" }, {}],
    ["posted basis", {}, { amountBasis: "booked_entry" }],
    ["installment count", { installmentCount: 2 }, { installmentCount: 2 }],
    ["billed-line ordinal", {}, { installmentNumber: 1 }],
    ["billed-line purchase", {}, { purchaseKey: "plan" }],
    [
      "interpretation issue",
      {},
      { details: { ...emptyDetails(), issues: ["unsupported_direction"] } },
    ],
  ])(
    "never creates an edge with ineligible %s evidence",
    (_name, pendingFields, postedFields) => {
      expect(
        pairs(
          [pending("pending", pendingFields)],
          [postedFacts("posted", postedFields)],
        ).size,
      ).toBe(0);
    },
  );

  it("removes billed lines before grouping, so a lookalike line never blocks a match", () => {
    const line = row("line", {
      amountBasis: "purchase_commitment",
      installmentNumber: 1,
      purchaseKey: "plan",
    });
    expect(pairs([pending("pending")], [row("posted"), line]).size).toBe(1);
    expect(
      postingComponents(
        [pending("pending")],
        [postedFacts("posted"), facts(line)],
      ).flatMap((group) => group.posted.map((item) => item.sourceKey)),
    ).toEqual(["posted"]);
  });

  it("allows the shared review-candidate issue without treating it as an interpretation failure", () => {
    const authorization = pending("pending");
    authorization.details.issues = ["possible_pending_posted_match"];
    expect(pairs([authorization], [row("posted")]).size).toBe(1);
  });

  it.each<
    [string, Partial<TransactionInput>, Partial<TransactionInput>, number]
  >([
    [
      "positive refunds",
      { kind: "refund", amountMinor: 100 },
      { kind: "refund", amountMinor: 100 },
      1,
    ],
    ["refund versus purchase", { kind: "refund", amountMinor: 100 }, {}, 0],
    [
      "negative refunds",
      { kind: "refund", amountMinor: -100 },
      { kind: "refund", amountMinor: -100 },
      0,
    ],
    ["positive purchases", { amountMinor: 100 }, { amountMinor: 100 }, 0],
    ["zero purchases", { amountMinor: 0 }, { amountMinor: 0 }, 0],
    [
      "zero refunds",
      { kind: "refund", amountMinor: 0 },
      { kind: "refund", amountMinor: 0 },
      0,
    ],
    [
      "opposite original sign",
      { kind: "refund", amountMinor: 100 },
      {
        kind: "refund",
        amountMinor: 100,
        originalAmountMinor: -100,
        originalCurrency: "ILS",
      },
      0,
    ],
  ])(
    "applies the canonical sign rule to %s",
    (_name, pendingFields, postedFields, expected) => {
      expect(
        pairs(
          [pending("pending", pendingFields)],
          [postedFacts("posted", postedFields)],
        ).size,
      ).toBe(expected);
    },
  );

  it.each<
    [string, Partial<TransactionInput>, Partial<TransactionInput>, number]
  >([
    [
      "foreign original money",
      { currency: "MXN", amountMinor: -2347 },
      {
        amountMinor: -589,
        originalAmountMinor: -2347,
        originalCurrency: "MXN",
      },
      1,
    ],
    [
      "original overrides equal billed money",
      { currency: "USD" },
      { currency: "USD", originalAmountMinor: -100, originalCurrency: "MXN" },
      0,
    ],
    [
      "original amount mismatch",
      {},
      { originalAmountMinor: -101, originalCurrency: "ILS" },
      0,
    ],
    ["same-currency billed fallback", {}, {}, 1],
    ["foreign billed fallback", { currency: "MXN" }, {}, 0],
    [
      "unresolved billing with known original",
      {},
      {
        amountMinor: null,
        currency: null,
        originalAmountMinor: -100,
        originalCurrency: "ILS",
      },
      0,
    ],
  ])(
    "compares purchase money using %s",
    (_name, pendingFields, postedFields, expected) => {
      expect(
        pairs(
          [pending("pending", pendingFields)],
          [postedFacts("posted", postedFields)],
        ).size,
      ).toBe(expected);
    },
  );

  it("uses a FAKE adapter's declared bases in the pure matcher", () => {
    const authorization = pending("pending");
    const posted = postedFacts("posted", { amountBasis: "booked_entry" });
    expect([
      ...automaticPostingPairs(
        [authorization],
        [posted],
        new Map([[authorization, authorization]]),
        fakeAdapter.automaticPosting!,
      ).pairs,
    ]).toEqual([[posted, authorization]]);
  });

  it("continues a FAKE non-CAL booked entry without allocating a random discovery identity", () => {
    const authorization = pending("pending");
    const plan = new FinancialPlan({
      connection: {
        id: "posting",
        provider: fakeAdapter.provider,
        displayName: "Synthetic",
        config: { schemaVersion: 1 },
        createdAt: authorization.firstSeenAt,
      },
      rows: [authorization],
      annotations: [],
      priorRuns: [
        prior("first", 2, [
          { status: "pending", success: true, comparable: true },
        ]),
      ],
      removals: [],
      catalog,
    });
    const run: Run = {
      id: "next",
      connectionId: "posting",
      startedAt: "2040-07-03T00:00:00Z",
      completedAt: null,
      refreshId: null,
      evidenceDigest: "0".repeat(64),
      bodyAvailable: true,
      bodyRetention: "staged",
      bodyExpiresAt: null,
      appliedAt: null,
      status: "started",
      collectorVersion: "synthetic",
      parserVersion: fakeAdapter.parserVersion,
      snapshot: {
        schemaVersion: 1,
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:fake/recent",
            capturedAt: "2040-07-03T00:00:00Z",
            responseText: JSON.stringify([
              row("posted", { amountBasis: "booked_entry" }),
            ]),
          },
        ],
      },
      coverage: [],
      warnings: [],
    };
    const result = planRun(
      plan,
      run,
      fakeAdapter,
      extractRun(run, fakeAdapter),
      run.startedAt,
      () => {
        throw new Error("Unexpected random ID allocation");
      },
    );
    expect(plan.transaction(authorization.id)).toMatchObject({
      status: "posted",
      amountBasis: "booked_entry",
    });
    expect(result).toMatchObject({ created: 0, updated: 1, unlisted: 0 });
    expect(plan.events.map((event) => event.type)).toEqual([
      "transaction.posted",
      "transaction.linked",
    ]);
  });
});

describe("provider-neutral continuation admission and freshness", () => {
  const scope: CollectionScope = {
    kind: "recent",
    month: "2040-07",
    cardKey: "card",
  };
  const partialPosted: SourceAdapter["extract"] = (raw) => {
    const result = fakeAdapter.extract(raw, {
      accountKey: "account",
      runId: "synthetic",
    });
    result.partitions.find(
      (partition) => partition.status === "posted",
    )!.comparable = false;
    return result;
  };
  const singleton: AutomaticPostingCapability = {
    pendingAmountBasis: "authorization",
    postedAmountBasis: "purchase_commitment",
    compatibleGroups(pending, posted) {
      return (
        pending.length === 1 &&
        posted.length === 1 &&
        pending[0]!.kind === "unknown" &&
        posted[0]!.kind === "purchase" &&
        pending[0]!.merchantName === posted[0]!.merchantName &&
        [...pending, ...posted].every((row) =>
          row.details.issues.every(
            (issue) =>
              issue === "synthetic_provenance" ||
              issue === "possible_pending_posted_match",
          ),
        )
      );
    },
  };
  const authorization = () =>
    pending("pending", {
      kind: "unknown",
      details: { ...emptyDetails(), issues: ["synthetic_provenance"] },
    });

  it("allows an adapter-evidenced unknown pending kind and informational issue with positive noncomparable posting", () => {
    const plan = capturePlan([authorization()], [row("posted")], 3, true, {
      adapter: { automaticPosting: singleton, extract: partialPosted },
      scope,
    });
    expect(plan.transaction("pending")).toMatchObject({
      status: "posted",
      kind: "purchase",
    });
    expect(plan.hydrated("pending")!.details.postingLink!.pending.kind).toBe(
      "unknown",
    );
    expect(
      plan.events.filter((event) => event.type === "transaction.posted"),
    ).toHaveLength(1);
  });

  it("does not compare previously posted absence when admitting positive posting evidence", () => {
    const old = {
      ...pending("unrelated", {
        status: "posted",
        amountBasis: "purchase_commitment",
        amountMinor: -999,
      }),
      id: "old",
    };
    const plan = capturePlan([authorization(), old], [row("posted")], 3, true, {
      adapter: { automaticPosting: singleton, extract: partialPosted },
      scope,
    });
    expect(plan.transaction("pending")!.status).toBe("posted");
    expect(plan.transaction("old")!.presence).toBe("seen");
  });

  it("cannot widen native identity, amount roles or billed-line admission through an accepting callback", () => {
    for (const fields of [
      { identityStrength: "weak" as const },
      { amountBasis: "unknown" as const },
      { amountMinor: null, currency: null },
      { amountMinor: 100 },
      { installmentCount: 2 },
      { installmentNumber: 1 },
      { details: { ...emptyDetails(), rejectedPostingKeys: ["another"] } },
    ]) {
      const pendingRow = authorization();
      Object.assign(pendingRow, fields);
      expect(
        automaticPostingPairs(
          [pendingRow],
          [postedFacts("posted")],
          new Map([[pendingRow, pendingRow]]),
          { ...singleton, compatibleGroups: () => true },
        ).pairs.size,
      ).toBe(0);
    }
  });

  it("leaves equal-size twins to an adapter that requires singleton evidence", () => {
    const left = [
      authorization(),
      { ...authorization(), id: "second", sourceKey: "second" },
    ];
    expect(
      automaticPostingPairs(
        left,
        [postedFacts("posted-a"), postedFacts("posted-b")],
        new Map(left.map((row) => [row, row])),
        singleton,
      ).pairs.size,
    ).toBe(0);
  });

  it.each([3, 4])(
    "rejects positive posted evidence after successful equal/newer noncomparable coverage at day %i",
    (day) => {
      const plan = capturePlan([authorization()], [row("posted")], 3, true, {
        adapter: { automaticPosting: singleton, extract: partialPosted },
        scope,
        priorRuns: [
          prior(
            "first",
            2,
            [{ status: "pending", success: true, comparable: true }],
            scope,
          ),
          prior(
            "later",
            day,
            [{ status: "posted", success: true, comparable: false }],
            scope,
          ),
        ],
      });
      expect(
        plan.events.some((event) => event.type === "transaction.posted"),
      ).toBe(false);
    },
  );

  it.each([3, 4])(
    "rejects equal/newer unscoped successful posted coverage at day %i",
    (day) => {
      const plan = capturePlan([authorization()], [row("posted")], 3, true, {
        adapter: { automaticPosting: singleton, extract: partialPosted },
        priorRuns: [
          prior("first", 2, [
            { status: "pending", success: true, comparable: true },
          ]),
          prior("later", day, [
            { status: "posted", success: true, comparable: false },
          ]),
        ],
      });
      expect(
        plan.events.some((event) => event.type === "transaction.posted"),
      ).toBe(false);
    },
  );

  it.each([3, 4])(
    "rejects equal/newer comparable pending snapshots at day %i",
    (day) => {
      const plan = capturePlan([authorization()], [row("posted")], 3, true, {
        adapter: { automaticPosting: singleton, extract: partialPosted },
        scope,
        priorRuns: [
          prior(
            "first",
            2,
            [{ status: "pending", success: true, comparable: true }],
            scope,
          ),
          prior(
            "later",
            day,
            [{ status: "pending", success: true, comparable: true }],
            scope,
          ),
        ],
      });
      expect(
        plan.events.some((event) => event.type === "transaction.posted"),
      ).toBe(false);
    },
  );

  it("does not infer disappearance when the prior origin receipt is unavailable", () => {
    const plan = capturePlan([authorization()], [row("posted")], 3, true, {
      adapter: { automaticPosting: singleton, extract: partialPosted },
      scope,
      priorRuns: [],
    });
    expect(plan.transaction("pending")).toMatchObject({
      status: "pending",
      presence: "seen",
    });
    expect(
      plan.events.some((event) => event.type === "transaction.posted"),
    ).toBe(false);
  });

  it("does not treat an unscoped historical pending observation as a disappearing current authorization", () => {
    const plan = capturePlan([authorization()], [row("posted")], 3, true, {
      adapter: { automaticPosting: singleton },
      priorRuns: [
        prior("first", 2, [
          { status: "pending", success: true, comparable: false },
        ]),
      ],
    });
    expect(
      plan.events.some((event) => event.type === "transaction.posted"),
    ).toBe(false);
  });

  it("imports initial pending and posted rows separately even when the provider accepts their component", () => {
    const plan = capturePlan(
      [],
      [pendingInput("pending", { kind: "unknown" }), row("posted")],
      3,
      true,
      {
        adapter: { automaticPosting: singleton, extract: partialPosted },
        scope,
      },
    );
    expect(
      plan.events.filter((event) => event.type === "transaction.imported"),
    ).toHaveLength(2);
    expect(
      plan.events.some((event) => event.type === "transaction.posted"),
    ).toBe(false);
  });

  it("does not infer disappearance or posting across a billing-month rollover", () => {
    const plan = capturePlan([authorization()], [row("posted")], 3, true, {
      adapter: { automaticPosting: singleton, extract: partialPosted },
      scope: { ...scope, month: "2040-08" },
      priorRuns: [
        prior(
          "first",
          2,
          [{ status: "pending", success: true, comparable: true }],
          scope,
        ),
      ],
    });
    expect(plan.transaction("pending")).toMatchObject({
      status: "pending",
      presence: "seen",
    });
    expect(
      plan.events.some((event) => event.type === "transaction.posted"),
    ).toBe(false);
  });
});

describe("financial corrections", () => {
  it.each([
    { billingDate: "2040-08-10" },
    { installmentCount: 12 },
    { merchantCategoryCode: "5411" },
  ] satisfies Partial<TransactionInput>[])(
    "revises corrected financial facts atomically with their change: %j",
    (correction) => {
      const original = pending("source", {
        status: "posted",
        amountBasis: "purchase_commitment",
      });
      const plan = capturePlan(
        [original],
        [row(original.sourceKey, correction)],
        3,
        false,
      );
      const corrected = plan.transaction(original.id)!;
      expect(corrected).toMatchObject({ ...correction, version: 2 });
      expect(plan.transactionWrites.get(original.id)).toEqual(corrected);
      expect(plan.events).toContainEqual(
        expect.objectContaining({
          type: "transaction.updated",
          transactionId: original.id,
          before: expect.objectContaining(
            Object.fromEntries(
              Object.keys(correction).map((key) => [
                key,
                original[key as keyof Transaction],
              ]),
            ),
          ),
          after: expect.objectContaining(correction),
        }),
      );
    },
  );
});
