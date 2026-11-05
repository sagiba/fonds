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
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
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
      existingPairRecheck: true,
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

describe.each(backends)("%s settled identity heuristic", (backend) => {
  let db: Harness;
  let h: ReturnType<typeof postingHarness>;
  beforeEach(async () => {
    db = await open(backend);
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
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap?.settlement,
    ).toBeUndefined();
    await h.capture(4, [unknown()], settled);
    const witness = (await db.getTransaction(pending.id))!.details
      .postingOverlap!;
    expect(witness).toMatchObject({
      capturedAt: "2040-07-04T12:00:00.000Z",
      settlement: { origin: "first_arrival" },
    });
    await h.capture(5, [unknown()], settled, {
      runId: "before-24-hours",
      hour: "11",
    });
    await noLink(pending.id);
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toEqual(witness);
    const peer = await db.peer();
    try {
      expect(
        (await peer.getTransaction(pending.id))!.details.postingOverlap,
      ).toEqual(witness);
    } finally {
      await peer.close();
    }
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
    });
    await h.capture(6, [unknown()], settled);
    expect(
      (await db.listEvents()).filter((e) => e.type === "transaction.linked"),
    ).toHaveLength(1);
  });
  it("does not fabricate historical arrival evidence and starts a new current recheck instead", async () => {
    await h.capture(2, [authorization()], manual);
    const pending = await h.byKey("pending");
    await h.capture(3, [unknown()], manual);
    await h.capture(7, [unknown()], settled);
    await noLink(pending.id);
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toMatchObject({
      capturedAt: "2040-07-07T12:00:00.000Z",
      settlement: { origin: "existing_pair_recheck" },
    });
    await h.capture(8, [unknown()], settled);
    expect((await h.byKey("posted")).id).toBe(pending.id);
  });
  it.each([
    ["same-day posted", {}],
    ["neighboring date", { transactionDate: "2040-07-08" }],
    ["unknown date", { transactionDate: null }],
    ["unknown card", { cardKey: null }],
    ["unknown money", { amountMinor: null, currency: null }],
    ["unknown currency", { amountMinor: null, currency: null }],
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
        (await db.getTransaction(pending.id))!.details.postingOverlap
          ?.settlement?.invalidatedAt,
      ).toBeDefined();
      await h.capture(
        5,
        [
          unknown(),
          row("competitor", {
            amountMinor: -999,
            transactionDate: "2040-01-01",
          }),
        ],
        settled,
      );
      await h.capture(6, [unknown()], settled);
      await noLink(pending.id);
    },
  );
  it.each([
    ["amount", { amountMinor: -200 }],
    ["date", { transactionDate: "2040-07-02" }],
    ["name", { merchantName: "Another Merchant" }],
    [
      "classification",
      { kind: "purchase", amountBasis: "purchase_commitment" },
    ],
  ] satisfies [string, Partial<TransactionInput>][])(
    "never reuses a witness after %s correction and reversal",
    async (_label, fields) => {
      const { pending } = await start();
      await h.capture(4, [unknown(fields)], settled, { hour: "11" });
      await h.capture(5, [unknown()], settled);
      await h.capture(6, [unknown()], settled);
      await noLink(pending.id);
      expect(
        (await db.getTransaction(pending.id))!.details.postingOverlap
          ?.settlement?.invalidatedAt,
      ).toBeDefined();
    },
  );
  it("treats partially specified legacy original money as a wildcard blocker", async () => {
    const { pending, posted } = await start();
    expect(
      settlementCompetitor(
        {
          ...posted,
          id: "other",
          amountMinor: -999,
          originalAmountMinor: null,
          originalCurrency: "ILS",
        },
        pending,
        posted,
      ),
    ).toBe(true);
  });
  it("keeps historical probation off unless explicitly opted in", async () => {
    const prospective = {
      ...settled,
      automaticPosting: {
        ...settled.automaticPosting!,
        settledHeuristic: {
          ...settled.automaticPosting!.settledHeuristic!,
          existingPairRecheck: false,
        },
      },
    };
    await h.capture(2, [authorization()], manual);
    const pending = await h.byKey("pending");
    await h.capture(3, [unknown()], manual);
    await h.capture(4, [unknown()], prospective);
    await h.capture(5, [unknown()], prospective);
    await noLink(pending.id);
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeUndefined();
  });
  it("keeps an invalidated prior arrival from becoming new historical probation", async () => {
    const { settledHeuristic: _settled, ...automaticPosting } =
      settled.automaticPosting!;
    const arrivalOnly = { ...settled, automaticPosting };
    await h.capture(2, [authorization()], arrivalOnly);
    const pending = await h.byKey("pending");
    await h.capture(3, [unknown()], arrivalOnly);
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeDefined();
    await h.capture(
      4,
      [unknown({ merchantName: "Corrected merchant" })],
      settled,
    );
    await h.capture(5, [unknown()], settled);
    await h.capture(7, [unknown()], settled);
    await noLink(pending.id);
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap?.settlement
        ?.invalidatedAt,
    ).toBeDefined();
  });
  it("cannot replace an invalidated arrival with a different newly arriving posting", async () => {
    const { settledHeuristic: _settled, ...automaticPosting } =
      settled.automaticPosting!;
    const arrivalOnly = { ...settled, automaticPosting };
    await h.capture(2, [authorization()], arrivalOnly);
    const pending = await h.byKey("pending");
    await h.capture(3, [authorization(), unknown()], arrivalOnly);
    const posted = await h.byKey("posted");
    await db.confirmRemoval({
      transactionId: posted.id,
      expectedVersion: posted.version,
      reason: "Synthetic incorrect entry",
    });
    await h.capture(
      4,
      [authorization(), { ...unknown(), sourceKey: "replacement" }],
      settled,
    );
    const witness = (await db.getTransaction(pending.id))!.details
      .postingOverlap!;
    expect(witness.postedId).toBe(posted.id);
    expect(witness.settlement?.invalidatedAt).toBeDefined();
    await h.capture(5, [{ ...unknown(), sourceKey: "replacement" }], settled);
    await h.capture(7, [{ ...unknown(), sourceKey: "replacement" }], settled);
    await noLink(pending.id);
  });
  it("leaves descriptor collisions unlinked even under the optional terminal-token policy", async () => {
    const risky = {
      ...settled,
      automaticPosting: {
        ...settled.automaticPosting!,
        settledHeuristic: {
          ...settled.automaticPosting!.settledHeuristic!,
          repeatedTerminalToken: true,
        },
      },
    };
    await h.capture(
      2,
      [authorization("pending", { merchantName: "PAYPAL EX RIVER STORE EX" })],
      risky,
    );
    const pending = await h.byKey("pending");
    const postings = [
      unknown({ merchantName: "PAYPAL EX RIVER STORE" }),
      row("distinct", { merchantName: "PAYPAL EX RIVER STORE EX" }),
    ];
    await h.capture(3, postings, risky);
    await h.capture(5, postings, risky);
    await noLink(pending.id);
  });
  it("permanently invalidates on pending reappearance", async () => {
    const { pending } = await start();
    await h.capture(4, [authorization(), unknown()], settled);
    await h.capture(5, [unknown()], settled);
    await noLink(pending.id);
  });
  it("never moves a posted annotation or revives a witness after it is cleared", async () => {
    const { pending, posted } = await start();
    const annotation = await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: 0,
      notes: "Different purchase",
    });
    await h.capture(4, [unknown()], settled);
    await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: annotation.version,
      notes: null,
    });
    await h.capture(5, [unknown()], settled);
    await noLink(pending.id);
  });
  it.each(["pending", "posted", "warning", "incomparable"])(
    "does not start or complete a window on incomplete %s evidence",
    async (partition) => {
      const partial: SourceAdapter = {
        ...settled,
        extract(...args) {
          const result = settled.extract(...args);
          if (partition === "warning") {
            result.warnings.push("unsupported_source_shape");
          } else {
            const part = result.partitions.find(
              (p) =>
                p.status ===
                (partition === "incomparable" ? "pending" : partition),
            )!;
            if (partition !== "incomparable") {
              part.success = false;
            }
            part.comparable = false;
          }
          return result;
        },
      };
      await h.capture(2, [authorization()], settled);
      const pending = await h.byKey("pending");
      await h.capture(3, [unknown()], partial);
      expect(
        (await db.getTransaction(pending.id))!.details.postingOverlap
          ?.settlement,
      ).toBeUndefined();
      await h.capture(4, [unknown()], settled);
      const witness = (await db.getTransaction(pending.id))!.details
        .postingOverlap;
      await h.capture(5, [unknown()], partial);
      await noLink(pending.id);
      expect(
        (await db.getTransaction(pending.id))!.details.postingOverlap,
      ).toEqual(witness);
      await h.capture(6, [unknown()], settled);
      await h.capture(7, [unknown()], settled);
      await noLink(pending.id);
    },
  );
  it.each(["failure-only", "mixed", "unscoped"])(
    "fences a settling window across %s collection failures",
    async (mode) => {
      const { pending } = await start();
      const before = await epoch();
      await db.ingestRun(
        {
          connectionId: h.connectionId,
          runId: "collection-failure",
          responses:
            mode === "failure-only"
              ? []
              : [
                  {
                    accountKey: "account",
                    endpoint: "synthetic:cal/recent",
                    capturedAt: "2040-07-04T11:00:00Z",
                    responseText: JSON.stringify([unknown()]),
                  },
                ],
          failures: [
            {
              accountKey:
                mode === "unscoped"
                  ? null
                  : mode === "mixed"
                    ? "other-account"
                    : "account",
              endpoint: "synthetic:cal/recent",
              code: "invalid_response",
            },
          ],
        },
        settled,
      );
      expect(await epoch()).not.toBe(before);
      await h.capture(5, [unknown()], settled);
      await h.capture(6, [unknown()], settled);
      await noLink(pending.id);
    },
  );
  it("fences an applied-history summary with a missing latest capture time", async () => {
    const { pending } = await start();
    const original = await epoch();
    const rows = await db.raw(
      "SELECT document_json AS value FROM sync_run_history WHERE connection_id = ?",
      [h.connectionId],
    );
    const document = JSON.parse(String(rows[0]!.value));
    document.latestCapture = null;
    await db.raw(
      "UPDATE sync_run_history SET document_json = ? WHERE connection_id = ?",
      [JSON.stringify(document), h.connectionId],
    );
    await h.capture(4, [unknown()], settled);
    expect(await epoch()).not.toBe(original);
    await h.capture(5, [unknown()], settled);
    await noLink(pending.id);
  });
  it.each(["not-an-instant", ""])(
    "rejects invalid capture time %s before it can establish settlement",
    async (capturedAt) => {
      const { pending } = await start();
      await expect(
        db.ingestRun(
          {
            connectionId: h.connectionId,
            runId: "invalid-time",
            responses: [
              {
                accountKey: "account",
                endpoint: "synthetic:cal/recent",
                capturedAt,
                responseText: JSON.stringify([unknown()]),
              },
            ],
          },
          settled,
        ),
      ).rejects.toThrow();
      await noLink(pending.id);
    },
  );
  it("fences an older capture applied after the current settlement witness", async () => {
    const { pending } = await start();
    const original = await epoch();
    await h.capture(2, [unknown()], settled, { runId: "late-old-capture" });
    expect(await epoch()).not.toBe(original);
    await h.capture(5, [unknown()], settled);
    await h.capture(6, [unknown()], settled);
    await noLink(pending.id);
  });
  it("fences when manual apply skips an archived extraction failure", async () => {
    const { pending } = await start();
    const original = await epoch();
    const broken: SourceAdapter = {
      ...settled,
      extract() {
        throw new Error("synthetic extraction failure");
      },
    };
    await expect(h.capture(4, [unknown()], broken)).rejects.toThrow();
    expect(await epoch()).toBe(original);
    await h.capture(5, [unknown()], settled);
    expect(await epoch()).not.toBe(original);
    await db.applyRun("posting-4", settled);
    await h.capture(6, [unknown()], settled);
    await noLink(pending.id);
    expect((await db.getTransaction(pending.id))!.presence).toBe(
      "not_returned",
    );
  });
  it("keeps the original absence clock and epoch through ordinary recaptures", async () => {
    const { pending } = await start();
    const witness = (await db.getTransaction(pending.id))!.details
      .postingOverlap!;
    const generation = await epoch();
    await h.capture(3, [unknown()], settled, {
      runId: "same-day-recheck",
      hour: "13",
    });
    const rechecked = (await db.getTransaction(pending.id))!;
    expect(await epoch()).toBe(generation);
    expect(rechecked.details.postingOverlap!.capturedAt).toBe(
      witness.capturedAt,
    );
    expect(rechecked.sourceAbsence?.capturedAt).not.toBe(witness.capturedAt);
    await h.capture(4, [unknown()], settled);
    expect((await h.byKey("posted")).id).toBe(pending.id);
  });
  it.each([
    [
      "conflicting money",
      { originalAmountMinor: -200, originalCurrency: "ILS" },
    ],
    ["partial original money", { originalAmountMinor: -100 }],
    ["FX", { originalAmountMinor: -100, originalCurrency: "USD" }],
    ["billed line", { installmentNumber: 1, purchaseKey: "purchase" }],
    ["installment plan", { installmentCount: 2 }],
    ["different date", { transactionDate: "2040-07-02" }],
    ["different name", { merchantName: "Different" }],
  ] satisfies [string, Partial<TransactionInput>][])(
    "does not admit %s",
    async (_label, fields) => {
      await h.capture(2, [authorization()], settled);
      const pending = await h.byKey("pending");
      await h.capture(3, [unknown(fields)], settled);
      await h.capture(5, [unknown(fields)], settled);
      await noLink(pending.id);
    },
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
  it("keeps unknown classification and separate source corrections after unlink", async () => {
    const { pending, posted } = await start();
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "Synthetic note kept on authorization",
    });
    await h.capture(4, [unknown()], settled);
    expect((await db.getTransaction(pending.id))!).toMatchObject({
      kind: "unknown",
      amountBasis: "unknown",
    });
    await db.unlinkPendingTransaction(await h.command(pending.id, posted.id));
    expect((await db.getTransaction(pending.id))!).toMatchObject({
      status: "pending",
      amountMinor: -100,
      amountBasis: "authorization",
      annotation: { data: { notes: "Synthetic note kept on authorization" } },
    });
    expect((await db.getTransaction(posted.id))!).toMatchObject({
      status: "posted",
      amountMinor: -100,
      kind: "unknown",
      amountBasis: "unknown",
    });
    await h.capture(
      5,
      [
        unknown({
          amountMinor: -175,
          merchantName: "Corrected synthetic merchant",
        }),
      ],
      settled,
    );
    const corrected = (await db.getTransaction(posted.id))!;
    expect(corrected).toMatchObject({
      amountMinor: -175,
      kind: "unknown",
      amountBasis: "unknown",
      merchantName: "Corrected synthetic merchant",
    });
    expect(corrected.details.issues).toEqual(
      expect.arrayContaining(unsettledIssues),
    );
    expect((await db.getTransaction(pending.id))!).toMatchObject({
      status: "pending",
      amountMinor: -100,
      annotation: { data: { notes: "Synthetic note kept on authorization" } },
    });
    await h.capture(6, [unknown()], settled);
    await h.capture(7, [unknown()], settled);
    expect((await db.getTransaction(posted.id))!.amountMinor).toBe(-100);
    expect(
      (await db.listEvents()).filter((e) => e.type === "transaction.linked"),
    ).toHaveLength(1);
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

  async function epoch() {
    const result = await db.raw(
      "SELECT config_json AS value FROM connections WHERE id = ?",
      [h.connectionId],
    );
    return JSON.parse(String(result[0]!.value)).settlementEpoch as
      string | null | undefined;
  }

  it.each([
    "disabled",
    "ready",
    "row_budget",
    "evidence_budget",
    "incomplete_capture",
  ] as const)(
    "reports %s to an operator without financial fields or private config",
    async (status) => {
      const report = createSyncDiagnosticReport();
      await db.updateConfig(h.connectionId, (config) => ({
        ...config,
        encryptedCredential: "invented-secret-sentinel",
      }));
      const inputs =
        status === "row_budget"
          ? Array.from({ length: 1001 }, (_, i) => row(`budget-${i}`))
          : [authorization()];
      if (status === "evidence_budget") {
        inputs[0]!.details.additionalInformation = ["x".repeat(70000)];
      }
      const failure = status === "incomplete_capture";
      await db.ingestRun(
        {
          connectionId: h.connectionId,
          runId: "diagnostic-run",
          responses: failure
            ? []
            : [
                {
                  accountKey: "account",
                  endpoint: "synthetic:cal/recent",
                  capturedAt: "2040-07-02T12:00:00Z",
                  responseText: JSON.stringify(inputs),
                },
              ],
          ...(failure
            ? {
                failures: [
                  {
                    accountKey: "account",
                    endpoint: "synthetic:cal/recent",
                    code: "invalid_response" as const,
                  },
                ],
              }
            : {}),
        },
        status === "disabled" ? manual : settled,
        report.log,
      );
      expect(
        report
          .report()
          .entries.find(
            (e) => e.stage === "reconciliation" && e.outcome === "started",
          )?.settlement,
      ).toBe(status);
      expect(JSON.stringify(report.report())).not.toMatch(
        /invented-secret-sentinel|settlementEpoch|merchantName|provider_json|amountMinor|responseText/u,
      );
    },
  );
  it.each(["replace", "mutate", "delete"])(
    "rejects a %s config callback that could restore an earlier valid epoch",
    async (mode) => {
      const { pending } = await start();
      const earlier = (await epoch())!;
      await h.capture(4, [unknown()], manual);
      const current = await epoch();
      expect(current).not.toBe(earlier);
      await expect(
        db.updateConfig(h.connectionId, (config) => {
          if (mode === "mutate") {
            config.settlementEpoch = earlier;
            return config;
          }
          if (mode === "delete") {
            delete config.settlementEpoch;
            return config;
          }
          return { ...config, settlementEpoch: earlier };
        }),
      ).rejects.toThrow("Settlement state is internal");
      expect(await epoch()).toBe(current);
      await db.updateConfig(h.connectionId, (config) => {
        config.unrelated = "allowed";
        return config;
      });
      expect(await epoch()).toBe(current);
      expect(
        (await db.getStoredConnection(h.connectionId))!.config.unrelated,
      ).toBe("allowed");
      await h.capture(5, [unknown()], settled);
      await noLink(pending.id);
    },
  );
  it("preserves unrelated config through a concurrent epoch update", async () => {
    await start();
    const peer = await db.peer();
    try {
      const results = await Promise.allSettled([
        h.capture(4, [unknown()], settled),
        peer.updateConfig(h.connectionId, (config) => ({
          ...config,
          concurrentSetting: "retained",
        })),
      ]);
      if (results[0]!.status === "rejected") {
        await db.applyRun("posting-4", settled);
      }
      if (results[1]!.status === "rejected") {
        await peer.updateConfig(h.connectionId, (config) => ({
          ...config,
          concurrentSetting: "retained",
        }));
      }
      expect(
        (await db.getStoredConnection(h.connectionId))!.config
          .concurrentSetting,
      ).toBe("retained");
      expect(await epoch()).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
    } finally {
      await peer.close();
    }
  });
  it("preserves unrelated config while initializing a non-reusable generation", async () => {
    await db.updateConfig(h.connectionId, (config) => ({
      ...config,
      custom: { label: "Synthetic private setting" },
      encryptedCredential: "invented-test-ciphertext",
    }));
    await h.capture(2, [authorization()], settled);
    const generation = await epoch();
    expect(generation).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
    const result = await db.raw(
      "SELECT config_json AS value FROM connections WHERE id = ?",
      [h.connectionId],
    );
    expect(JSON.parse(String(result[0]!.value))).toMatchObject({
      custom: { label: "Synthetic private setting" },
      encryptedCredential: "invented-test-ciphertext",
    });
  });
  it("fails closed on scalar byte overflow, advances the fence, and never revives after correction", async () => {
    await h.capture(
      2,
      [
        authorization(),
        row("remote", { transactionDate: "2030-01-01", amountMinor: -999 }),
      ],
      settled,
    );
    const pending = await h.byKey("pending");
    await h.capture(3, [unknown()], settled);
    const oldEpoch = await epoch();
    const remote = await h.byKey("remote");
    const oversizedCard = "😀".repeat(70);
    await db.raw(
      "INSERT INTO cards (id, connection_id, provider_key, created_at) VALUES (?, ?, ?, ?)",
      [oversizedCard, h.connectionId, "oversized-card", "2040-07-03T12:00:00Z"],
    );
    await db.raw("UPDATE transactions SET card_id = ? WHERE source_key = ?", [
      oversizedCard,
      "remote",
    ]);
    const result = await h.capture(4, [unknown()], settled);
    expect(result.status).toBe("completed");
    expect(await epoch()).not.toBe(oldEpoch);
    await db.raw("UPDATE transactions SET card_id = ? WHERE source_key = ?", [
      remote.cardId,
      "remote",
    ]);
    await h.capture(5, [unknown()], settled);
    await h.capture(6, [unknown()], settled);
    await noLink(pending.id);
  });
  it("never fetches an unrelated oversized provider document for competitor comparison", async () => {
    await h.capture(
      2,
      [
        authorization(),
        row("remote", { transactionDate: "2030-01-01", amountMinor: -999 }),
      ],
      settled,
    );
    const pending = await h.byKey("pending");
    await db.raw(
      "UPDATE transactions SET provider_json = ? WHERE source_key = ?",
      [JSON.stringify({ cal: { padding: "x".repeat(200000) } }), "remote"],
    );
    await h.capture(3, [unknown()], settled);
    await h.capture(4, [unknown()], settled);
    expect((await h.byKey("posted")).id).toBe(pending.id);
  });
  it("skips oversized candidate evidence and preserves a durable veto after it becomes small again", async () => {
    const { pending } = await start();
    const original = await db.raw(
      "SELECT provider_json AS value FROM transactions WHERE source_key = ?",
      ["pending"],
    );
    const oldEpoch = await epoch();
    await db.raw(
      "UPDATE transactions SET provider_json = ? WHERE source_key = ?",
      [JSON.stringify({ cal: { padding: "x".repeat(200000) } }), "pending"],
    );
    await h.capture(4, [unknown()], settled);
    expect(await epoch()).not.toBe(oldEpoch);
    await db.raw(
      "UPDATE transactions SET provider_json = ? WHERE source_key = ?",
      [String(original[0]!.value), "pending"],
    );
    await h.capture(5, [unknown()], settled);
    await noLink(pending.id);
  });
  it("continues ordinary sync when new observations overflow the heuristic budget", async () => {
    const { pending } = await start();
    const oldEpoch = await epoch();
    const many = Array.from({ length: 1001 }, (_, index) =>
      row(`remote-${index}`, {
        transactionDate: "2030-01-01",
        amountMinor: -999,
      }),
    );
    const result = await h.capture(4, [unknown(), ...many], settled);
    expect(result).toMatchObject({ status: "completed", created: 1001 });
    expect(await epoch()).not.toBe(oldEpoch);
    await h.capture(5, [unknown()], settled);
    await noLink(pending.id);
  });
  it("skips a capped stored-account scan without aborting collection", async () => {
    const many = Array.from({ length: 1001 }, (_, index) =>
      row(`remote-${index}`, {
        transactionDate: "2030-01-01",
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
  });
  it.each(["missing", "malformed", "exhausted", "disabled"])(
    "never reuses an older generation after %s config state",
    async (state) => {
      const { pending } = await start();
      const oldEpoch = await epoch();
      const result = await db.raw(
        "SELECT config_json AS value FROM connections WHERE id = ?",
        [h.connectionId],
      );
      const config = JSON.parse(String(result[0]!.value));
      if (state === "missing") {
        delete config.settlementEpoch;
      } else {
        config.settlementEpoch =
          state === "malformed"
            ? "invalid"
            : state === "exhausted"
              ? Number.MAX_SAFE_INTEGER
              : null;
      }
      await db.raw("UPDATE connections SET config_json = ? WHERE id = ?", [
        JSON.stringify(config),
        h.connectionId,
      ]);
      await h.capture(4, [unknown()], settled);
      expect(await epoch()).not.toBe(oldEpoch);
      await h.capture(5, [unknown()], settled);
      await noLink(pending.id);
    },
  );
  it("fences old windows across disabling and reenabling the policy", async () => {
    const { pending } = await start();
    const oldEpoch = await epoch();
    await h.capture(4, [unknown()], manual);
    expect(await epoch()).not.toBe(oldEpoch);
    await h.capture(5, [unknown()], settled);
    await h.capture(6, [unknown()], settled);
    await noLink(pending.id);
  });
  it("commits the fence with the applied marker and rolls both back on failure", async () => {
    const { pending } = await start();
    const oldEpoch = await epoch();
    const before = await h.state();
    const partial = {
      ...settled,
      extract(...args: Parameters<SourceAdapter["extract"]>) {
        const result = settled.extract(...args);
        result.warnings.push("synthetic_incomplete");
        return result;
      },
    };
    if (backend === "postgres") {
      await db.raw(
        "CREATE FUNCTION reject_settlement_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic fence failure'; END $$",
      );
      await db.raw(
        "CREATE TRIGGER reject_settlement_fence BEFORE UPDATE ON connections FOR EACH ROW EXECUTE FUNCTION reject_settlement_fence()",
      );
    } else {
      await db.raw(
        "CREATE TRIGGER reject_settlement_fence BEFORE UPDATE OF config_json ON connections BEGIN SELECT RAISE(ABORT, 'synthetic fence failure'); END",
      );
    }
    await expect(h.capture(4, [unknown()], partial)).rejects.toThrow();
    expect(await epoch()).toBe(oldEpoch);
    expect(await h.state()).toEqual(before);
    await db.raw(
      backend === "postgres"
        ? "DROP TRIGGER reject_settlement_fence ON connections"
        : "DROP TRIGGER reject_settlement_fence",
    );
    await db.applyRun("posting-4", partial);
    const fenced = await epoch();
    expect(fenced).not.toBe(oldEpoch);
    await db.applyRun("posting-4", partial);
    expect(await epoch()).toBe(fenced);
    await h.capture(5, [unknown()], settled);
    await noLink(pending.id);
  });
  it("does not rotate the generation or duplicate a link on racing applied-run retries", async () => {
    const { pending } = await start();
    const oldEpoch = await epoch();
    const peer = await db.peer();
    try {
      const outcomes = await Promise.allSettled([
        h.capture(4, [unknown()], settled),
        postingHarness(peer).capture(4, [unknown()], settled),
      ]);
      expect(outcomes.some((result) => result.status === "fulfilled")).toBe(
        true,
      );
      await db.applyRun("posting-4", settled);
      expect(await epoch()).toBe(oldEpoch);
      expect((await h.byKey("posted")).id).toBe(pending.id);
      expect(
        (await db.listEvents()).filter(
          (event) => event.type === "transaction.linked",
        ),
      ).toHaveLength(1);
    } finally {
      await peer.close();
    }
  });
});
