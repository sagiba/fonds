import "../helpers/application-loading-differential.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSyncDiagnosticReport } from "../../src/application/sync-diagnostics.js";
import {
  presentWireTransaction,
  transactionDetailOutputSchema,
} from "../../src/application/wire-output.js";
import type { TransactionInput } from "../../src/domain/model.js";
import {
  settledMerchantMatch,
  settlementCompetitor,
} from "../../src/domain/plans/posting-settlement.js";
import type { LedgerRow } from "../../src/domain/plans/state.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { calSettlementPolicy } from "../../src/providers/cal/posting-evidence.js";
import {
  authorization,
  postingAdapter,
  postingHarness,
} from "../helpers/posting.js";
import {
  backends,
  type Harness,
  open,
  row,
} from "../helpers/storage-harness.js";

const unsettledIssues = [
  "unsupported_transaction_type",
  "unverified_amount_basis",
];
const settled: SourceAdapter = {
  ...postingAdapter,
  sourceCoverage: { kind: "same_origin", statuses: ["pending"] },
  automaticPosting: {
    ...postingAdapter.automaticPosting!,
    exactNameHeuristic: false,
    compatibleGroups: () => false,
    settledHeuristic: {
      compatiblePair: (pending, posted) =>
        [pending, posted].every((r) =>
          r.details.issues.every((i) =>
            [...unsettledIssues, "possible_pending_posted_match"].includes(i),
          ),
        ),
    },
  },
};
const { automaticPosting: _, ...manual } = settled;
const unknown = (fields: Partial<TransactionInput> = {}) => {
  const result = row("posted", {
    kind: "unknown",
    amountBasis: "unknown",
    ...fields,
  });
  result.details.issues.push(...unsettledIssues);
  return result;
};

describe("settled merchant comparison", () => {
  it("keeps every substantive name token and punctuation by default", () => {
    expect(
      settledMerchantMatch(
        "  Synthetic   River Store ",
        "SYNTHETIC RIVER STORE",
      ),
    ).toBe(true);
    for (const [left, right] of [
      ["ABC & Sons", "ABC Sons"],
      ["Shop+Go", "Shop Go"],
      ["example.com/uk", "example.com/us"],
      ["PAYPAL EX River Ltd EX", "PAYPAL EX River Ltd"],
      ["River Shop", "Shop River"],
      ["---", "---"],
    ]) {
      expect(settledMerchantMatch(left!, right!)).toBe(false);
    }
  });
  it("requires explicit opt-in for one repeated terminal token and retains other distinctions", () => {
    expect(
      settledMerchantMatch(
        "PAYPAL EX River Ltd EX",
        "PAYPAL EX River Ltd",
        true,
      ),
    ).toBe(true);
    for (const [left, right] of [
      ["PAYPAL EX River Ltd UK", "PAYPAL EX River Ltd"],
      ["EX River EX", "EX River"],
      ["PAYPAL EX River Ltd EX EX", "PAYPAL EX River Ltd"],
      ["PAYPAL EX River Ltd", "PAYPAL EX River Co"],
      ["PAYPAL EX River Ltd", "PAYPAL River EX Ltd"],
    ]) {
      expect(settledMerchantMatch(left!, right!, true)).toBe(false);
    }
  });
});

describe("settlement competitors", () => {
  const pending = authorization() as unknown as LedgerRow;
  const posted = { ...pending, id: "posted" } as LedgerRow;
  const candidate = {
    id: "other",
    cardId: null,
    transactionDate: null,
    merchantName: "Unrelated Merchant",
    amountMinor: -999,
    currency: "USD",
    originalAmountMinor: null,
    originalCurrency: null,
    supersededById: null,
    purchaseId: null,
    installmentNumber: null,
  };
  it("treats a foreign row as a rival only under the same or an unknown name", () => {
    const same = (name: string | null) => name === "Merchant";
    expect(settlementCompetitor(candidate, pending, posted, same)).toBe(false);
    expect(
      settlementCompetitor(
        { ...candidate, merchantName: "Merchant" },
        pending,
        posted,
        same,
      ),
    ).toBe(true);
    expect(
      settlementCompetitor(
        { ...candidate, merchantName: null },
        pending,
        posted,
        same,
      ),
    ).toBe(true);
  });
  it("treats partially specified legacy original money as a wildcard blocker", () => {
    expect(
      settlementCompetitor(
        { ...candidate, currency: "ILS", originalCurrency: "ILS" },
        pending,
        posted,
        () => false,
      ),
    ).toBe(true);
  });
});

describe.each(backends)("%s settled identity heuristic", (backend) => {
  let db: Harness;
  let h: ReturnType<typeof postingHarness>;
  beforeEach(async () => {
    db = await open(backend, { settledPosting: "on" });
    h = postingHarness(db);
    await db.ensureConnection({ id: h.connectionId, provider: "cal" });
  });
  afterEach(async () => db.close());

  async function start() {
    await h.capture(2, [authorization()], settled);
    const pending = await h.byKey("pending");
    await h.capture(3, [unknown()], settled);
    return { pending, posted: await h.byKey("posted") };
  }

  async function noLink(id: string) {
    expect((await db.getTransaction(id))!.status).toBe("pending");
    expect(
      (await db.listEvents()).filter((e) => e.type === "transaction.linked"),
    ).toHaveLength(0);
  }

  const clock = async (id: string) =>
    (await db.getTransaction(id))!.details.postingOverlap;

  it("starts on disappearance, links only on a fresh capture after 24h, and preserves unknown facts and notes", async () => {
    await h.capture(2, [authorization()], settled);
    const pending = await h.byKey("pending");
    const annotation = await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "Synthetic authorization note",
      category: "Research",
    });
    await h.capture(3, [authorization(), unknown()], settled);
    expect((await clock(pending.id))?.settlement).toBeUndefined();
    await h.capture(4, [unknown()], settled);
    const witness = (await clock(pending.id))!;
    expect(witness).toMatchObject({
      capturedAt: "2040-07-04T12:00:00.000Z",
      settlement: { comparison: "merchant-presentation-v1" },
    });
    await h.capture(5, [unknown()], settled, {
      runId: "before-24-hours",
      hour: "11",
    });
    await noLink(pending.id);
    expect(await clock(pending.id)).toEqual(witness);
    await h.capture(5, [unknown()], settled, {
      runId: "at-24-hours",
      hour: "12",
    });
    const survivor = await h.byKey("posted");
    expect(survivor).toMatchObject({
      id: pending.id,
      kind: "unknown",
      amountBasis: "unknown",
      amountMinor: -100,
      annotation,
      details: {
        postingLink: {
          automatic: true,
          policyVersion: "settled-similarity-v1",
        },
      },
    });
    expect(survivor.details.issues).toEqual(
      expect.arrayContaining(unsettledIssues),
    );
    const wire = transactionDetailOutputSchema.parse(
      presentWireTransaction(survivor, true, false),
    );
    expect(wire.postingMatch).toMatchObject({
      heuristic: true,
      policyVersion: "settled-similarity-v1",
      settlement: {
        startedAt: "2040-07-04T12:00:00.000Z",
        comparison: "merchant-presentation-v1",
        observedLedgerOnly: true,
      },
    });
    await h.capture(6, [unknown()], settled);
    expect(
      (await db.listEvents()).filter((e) => e.type === "transaction.linked"),
    ).toHaveLength(1);
  });
  it("does nothing unless the deployment enables it", async () => {
    const off = await open(backend);
    try {
      const p = postingHarness(off);
      await off.ensureConnection({ id: p.connectionId, provider: "cal" });
      await p.capture(2, [authorization()], settled);
      const pending = await p.byKey("pending");
      await p.capture(3, [unknown()], settled);
      await p.capture(5, [unknown()], settled);
      const row = (await off.getTransaction(pending.id))!;
      expect(row.status).toBe("pending");
      expect(row.details.postingOverlap?.settlement).toBeUndefined();
    } finally {
      await off.close();
    }
  });
  it("matches a posting that arrives after an earlier disappearance", async () => {
    await h.capture(2, [authorization()], settled);
    const pending = await h.byKey("pending");
    await h.capture(3, [], settled);
    expect((await db.getTransaction(pending.id))!.presence).toBe(
      "not_returned",
    );
    await h.capture(4, [unknown()], settled);
    await noLink(pending.id);
    await h.capture(5, [unknown()], settled);
    expect((await h.byKey("posted")).id).toBe(pending.id);
  });
  it("applies the real CAL policy to a delayed arrival", async () => {
    const cal: SourceAdapter = {
      ...postingAdapter,
      automaticPosting: {
        ...postingAdapter.automaticPosting!,
        settledHeuristic: calSettlementPolicy,
      },
    };
    await h.capture(
      2,
      [
        authorization(),
        authorization("rival", { amountMinor: -300, merchantName: "Other" }),
      ],
      cal,
    );
    const pending = await h.byKey("pending");
    await h.capture(3, [], cal);
    await h.capture(4, [row("posted")], cal);
    await h.capture(5, [row("posted")], cal);
    expect(await h.byKey("posted")).toMatchObject({
      id: pending.id,
      kind: "purchase",
      details: { postingLink: { policyVersion: "settled-similarity-v1" } },
    });
  });
  it("starts a window for a recent pair that predates the policy", async () => {
    await h.capture(2, [authorization()], manual);
    const pending = await h.byKey("pending");
    await h.capture(3, [unknown()], manual);
    await h.capture(7, [unknown()], settled);
    await noLink(pending.id);
    await h.capture(8, [unknown()], settled);
    expect((await h.byKey("posted")).id).toBe(pending.id);
  });
  it("never relates a posting older than the authorization", async () => {
    await h.capture(2, [unknown()], settled);
    await h.capture(3, [unknown(), authorization()], settled);
    const pending = await h.byKey("pending");
    await h.capture(4, [unknown()], settled);
    await h.capture(6, [unknown()], settled);
    await noLink(pending.id);
    expect((await clock(pending.id))?.settlement).toBeUndefined();
  });
  it("leaves purchases past the horizon to owner repair", async () => {
    const old = { transactionDate: "2040-05-22" };
    await h.capture(2, [authorization("pending", old)], settled);
    const pending = await h.byKey("pending");
    await h.capture(3, [unknown(old)], settled);
    await h.capture(5, [unknown(old)], settled);
    await noLink(pending.id);
    expect((await clock(pending.id))?.settlement).toBeUndefined();
  });
  it.each([
    ["same-day posted", {}],
    ["neighboring date", { transactionDate: "2040-07-08" }],
    ["unknown date", { transactionDate: null }],
    ["unknown card", { cardKey: null }],
    ["unknown money", { amountMinor: null, currency: null }],
    ["foreign currency", { currency: "USD", amountMinor: -10000 }],
    [
      "original-money alternative",
      {
        currency: "USD",
        amountMinor: -500,
        originalAmountMinor: -100,
        originalCurrency: "ILS",
      },
    ],
  ] satisfies [string, Partial<TransactionInput>][])(
    "permanently invalidates when a %s competitor appears",
    async (_label, fields) => {
      const { pending } = await start();
      await h.capture(4, [unknown(), row("competitor", fields)], settled, {
        runId: "rival",
        hour: "11",
      });
      expect(
        (await clock(pending.id))?.settlement?.invalidatedAt,
      ).toBeDefined();
      await h.capture(6, [unknown()], settled);
      await noLink(pending.id);
    },
  );
  it("is not blocked by an unrelated foreign purchase nearby", async () => {
    const { pending } = await start();
    await h.capture(
      4,
      [
        unknown(),
        row("abroad", {
          merchantName: "Unrelated Abroad",
          currency: "USD",
          amountMinor: -777,
        }),
      ],
      settled,
    );
    expect((await h.byKey("posted")).id).toBe(pending.id);
  });
  it.each([
    ["amount", { amountMinor: -200 }],
    ["date", { transactionDate: "2040-07-02" }],
    ["name", { merchantName: "Another Merchant" }],
  ] satisfies [string, Partial<TransactionInput>][])(
    "never reuses a window after %s correction and reversal",
    async (_label, fields) => {
      const { pending } = await start();
      await h.capture(4, [unknown(fields)], settled, { hour: "11" });
      await h.capture(5, [unknown()], settled);
      await h.capture(6, [unknown()], settled);
      await noLink(pending.id);
      expect(
        (await clock(pending.id))?.settlement?.invalidatedAt,
      ).toBeDefined();
    },
  );
  it("keeps the window through stronger classification of the posting", async () => {
    const { pending } = await start();
    const classified = row("posted");
    await h.capture(4, [classified], settled, { hour: "11" });
    await h.capture(4, [classified], settled, {
      runId: "after-a-day",
      hour: "13",
    });
    expect(await h.byKey("posted")).toMatchObject({
      id: pending.id,
      kind: "purchase",
      amountBasis: "purchase_commitment",
    });
  });
  it("does not let a seen-again authorization finish, whichever capture saw it", async () => {
    const { pending } = await start();
    const notFresh: SourceAdapter = {
      ...settled,
      extract(...args) {
        const result = settled.extract(...args);
        result.partitions.find((p) => p.status === "pending")!.comparable =
          false;
        return result;
      },
    };
    await h.capture(4, [authorization(), unknown()], notFresh);
    await h.capture(6, [unknown()], settled);
    await noLink(pending.id);
    expect((await clock(pending.id))?.settlement?.invalidatedAt).toBeDefined();
  });
  it("never moves a posted annotation or revives a window after it is cleared", async () => {
    const { pending, posted } = await start();
    const annotation = await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: 0,
      notes: "Synthetic posted note",
    });
    await h.capture(4, [unknown()], settled);
    await noLink(pending.id);
    await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: annotation.version,
      notes: null,
    });
    await h.capture(5, [unknown()], settled);
    await noLink(pending.id);
  });
  it.each(["pending", "posted", "incomparable"])(
    "neither starts nor spends a window on incomplete %s evidence, and loses none",
    async (partition) => {
      const partial: SourceAdapter = {
        ...settled,
        extract(...args) {
          const result = settled.extract(...args);
          const part = result.partitions.find(
            (p) =>
              p.status ===
              (partition === "incomparable" ? "pending" : partition),
          )!;
          if (partition !== "incomparable") {
            part.success = false;
          }
          part.comparable = false;
          return result;
        },
      };
      await h.capture(2, [authorization()], settled);
      const pending = await h.byKey("pending");
      await h.capture(3, [unknown()], partial);
      expect((await clock(pending.id))?.settlement).toBeUndefined();
      await h.capture(4, [unknown()], settled);
      const witness = await clock(pending.id);
      await h.capture(5, [unknown()], partial);
      await noLink(pending.id);
      expect(await clock(pending.id)).toEqual(witness);
      await h.capture(6, [unknown()], settled);
      expect((await h.byKey("posted")).id).toBe(pending.id);
    },
  );
  it("reports why a capture skipped settlement", async () => {
    await h.capture(2, [authorization()], settled);
    const noPending: SourceAdapter = {
      ...settled,
      extract(...args) {
        const result = settled.extract(...args);
        result.partitions = result.partitions.filter(
          (p) => p.status !== "pending",
        );
        return result;
      },
    };
    const report = createSyncDiagnosticReport();
    await db.ingestRun(
      {
        connectionId: h.connectionId,
        runId: "posted-only",
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:cal/recent",
            capturedAt: "2040-07-03T12:00:00Z",
            responseText: JSON.stringify([unknown()]),
          },
        ],
      },
      noPending,
      report.log,
    );
    expect(
      report.report().entries.find((entry) => entry.settlement)?.settlement,
    ).toBe("no_pending_coverage");
  });
  // Local D1 cannot ingest this volume in one capture.
  it.skipIf(backend === "d1-local")(
    "is unaffected by history beyond the scan window",
    async () => {
      const many = Array.from({ length: 2001 }, (_, index) =>
        row(`remote-${index}`, {
          transactionDate: "2030-01-01",
          amountMinor: -999,
        }),
      );
      await h.capture(2, [authorization(), ...many], manual);
      const pending = await h.byKey("pending");
      await h.capture(3, [unknown()], settled);
      await h.capture(5, [unknown()], settled);
      expect((await h.byKey("posted")).id).toBe(pending.id);
    },
    60_000,
  );
  // Local D1 cannot ingest this volume in one capture.
  it.skipIf(backend === "d1-local")(
    "skips a scan over its row budget without aborting collection, then recovers",
    async () => {
      const many = Array.from({ length: 2001 }, (_, index) =>
        row(`near-${index}`, {
          transactionDate: "2040-06-20",
          amountMinor: -999,
        }),
      );
      await h.capture(2, [authorization(), ...many], manual);
      const pending = await h.byKey("pending");
      expect(await h.capture(3, [unknown()], settled)).toMatchObject({
        status: "completed",
        created: 1,
      });
      await h.capture(5, [unknown()], settled);
      await noLink(pending.id);
      expect((await clock(pending.id))?.settlement).toBeUndefined();
    },
    60_000,
  );
  it("honors explicit unlink forever", async () => {
    const { pending, posted } = await start();
    await h.capture(4, [unknown()], settled);
    await db.unlinkPendingTransaction(await h.command(pending.id, posted.id));
    await h.capture(5, [authorization(), unknown()], settled);
    await h.capture(6, [unknown()], settled);
    await h.capture(8, [unknown()], settled);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
    expect(
      (await db.listEvents()).filter((e) => e.type === "transaction.linked"),
    ).toHaveLength(1);
  });
  it("keeps unknown classification and annotations through unlink", async () => {
    const { pending, posted } = await start();
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "Synthetic note kept on authorization",
    });
    await h.capture(4, [unknown()], settled);
    await db.unlinkPendingTransaction(await h.command(pending.id, posted.id));
    expect((await db.getTransaction(pending.id))!).toMatchObject({
      status: "pending",
      amountBasis: "authorization",
      annotation: { data: { notes: "Synthetic note kept on authorization" } },
    });
    expect((await db.getTransaction(posted.id))!).toMatchObject({
      status: "posted",
      kind: "unknown",
      amountBasis: "unknown",
    });
  });
  it("rolls back linking atomically and retries the same capture exactly once", async () => {
    const { pending } = await start();
    const before = await h.state();
    if (backend === "postgres") {
      await db.raw(
        "CREATE FUNCTION reject_settled_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'transaction.linked' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$",
      );
      await db.raw(
        "CREATE TRIGGER reject_settled_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_settled_audit()",
      );
    } else {
      await db.raw(
        "CREATE TRIGGER reject_settled_audit BEFORE INSERT ON events WHEN NEW.type = 'transaction.linked' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END",
      );
    }
    await expect(h.capture(4, [unknown()], settled)).rejects.toThrow();
    expect(await h.state()).toEqual(before);
    await db.raw(
      backend === "postgres"
        ? "DROP TRIGGER reject_settled_audit ON events"
        : "DROP TRIGGER reject_settled_audit",
    );
    await db.applyRun("posting-4", settled);
    expect((await h.byKey("posted")).id).toBe(pending.id);
    const recovered = await h.state();
    await db.applyRun("posting-4", settled);
    expect(await h.state()).toEqual(recovered);
  });
  it("lets repair preview an account holding a window, and refuses an invalidated pair", async () => {
    const exact = (key: string, fields: Partial<TransactionInput> = {}) =>
      row(key, { merchantName: "Synthetic Exact", ...fields });
    await h.capture(2, [authorization()], settled);
    const pending = await h.byKey("pending");
    await h.capture(3, [row("posted")], settled);
    expect((await clock(pending.id))?.settlement).toBeDefined();
    const scope = {
      transactionId: pending.id,
      from: "2040-06-01",
      to: "2040-07-31",
      reason: "Synthetic preview",
      mode: "preview" as const,
    };
    expect((await db.repairExactPostings(scope)).pairs).toHaveLength(1);
    await h.capture(
      4,
      [authorization(), row("posted"), exact("other")],
      settled,
    );
    await h.capture(5, [row("posted"), exact("other")], settled);
    expect((await clock(pending.id))?.settlement?.invalidatedAt).toBeDefined();
    expect((await db.repairExactPostings(scope)).pairs).toEqual([]);
  });
});
