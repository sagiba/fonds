import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "../../src/domain/errors.js";
import { emptyDetails, type TransactionInput } from "../../src/domain/model.js";
import type { CollectionScope } from "../../src/domain/records.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { compatibleCalPostingGroups } from "../../src/providers/cal/posting-evidence.js";
import { configureHydration } from "../../src/storage/store.js";
import {
  expectNarrowRowsExact,
  expectPlannedOrder,
  loadingComparisons,
} from "../helpers/application-loading-differential.js";
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
  synthetic,
} from "../helpers/storage-harness.js";

const latest = () => loadingComparisons.at(-1)!;

/**
 * The synthetic adapter with incomparable partitions: its captures read
 * every row of their account (its coverage declares both statuses) but
 * declare none absent, so they write only the rows they observe.
 */
const incomparable: SourceAdapter = {
  ...synthetic,
  extract(text, context) {
    const result = synthetic.extract(text, context);
    for (const partition of result.partitions) {
      partition.comparable = false;
    }
    return result;
  },
};

const evidence = "transaction_reconciliation.source_evidence_json";
const provider = "transactions.provider_json";
const aliases = "transactions.source_aliases_json";
const link = "transaction_posting_links.posting_link_json";

/**
 * Raw stored text, as a legacy or foreign writer could have left it, and
 * whether the narrow load may decide on it ("safe") or must hydrate the row
 * before planning ("doubt"). Expectations are written by hand.
 */
const rawDocuments: {
  key: string;
  column: string;
  text: string | null;
  outcome: "safe" | "doubt";
  retired?: boolean;
}[] = [
  {
    key: "evidence-null",
    column: evidence,
    text: null,
    outcome: "safe",
    retired: false,
  },
  {
    key: "evidence-json-null",
    column: evidence,
    text: "null",
    outcome: "safe",
    retired: false,
  },
  {
    key: "retired",
    column: evidence,
    text: '{"identity":{"retiredFromMatching":true}}',
    outcome: "safe",
    retired: true,
  },
  {
    key: "retired-newline",
    column: evidence,
    text: '{"identity":\n{"retiredFromMatching":true}}',
    outcome: "safe",
    retired: true,
  },
  {
    key: "kept-reordered",
    column: evidence,
    text: '{"identity":{"runId":"matrix-1","retiredFromMatching":false,"capturedAt":"2040-07-01T12:00:00.000Z","financialFingerprint":"{}"}}',
    outcome: "safe",
    retired: false,
  },
  {
    key: "fingerprint-mentions-key",
    column: evidence,
    text: JSON.stringify({
      identity: {
        financialFingerprint: '{"note":"retiredFromMatching":true}',
        runId: "matrix-1",
        capturedAt: "2040-07-01T12:00:00.000Z",
        retiredFromMatching: false,
      },
    }),
    outcome: "doubt",
  },
  {
    key: "retired-spaced",
    column: evidence,
    text: '{"identity": {"retiredFromMatching": true}}',
    outcome: "doubt",
  },
  {
    key: "retired-spaced-colon",
    column: evidence,
    text: '{"identity":{"retiredFromMatching" :true}}',
    outcome: "doubt",
  },
  {
    key: "retired-escaped-key",
    column: evidence,
    text: '{"identity":{"retiredFromMatch\\u0069ng":true}}',
    outcome: "doubt",
  },
  {
    key: "alias-nul",
    column: aliases,
    text: '["alias\\u0000x"]',
    outcome: "safe",
  },
  {
    key: "alias-surrogate",
    column: aliases,
    text: '["lone\\udc00"]',
    outcome: "safe",
  },
  {
    key: "alias-backslash",
    column: aliases,
    text: '["a\\\\u0000b"]',
    outcome: "safe",
  },
  {
    key: "provider-plain",
    column: provider,
    text: '{"cal":{"rows":[{"merchantName":"plain"}]}}',
    outcome: "safe",
  },
  {
    key: "provider-escapes",
    column: provider,
    text: '{"cal":{"rows":[{"merchantName":"a\\u0000b"},{"merchantName":"\\ud800"}]}}',
    outcome: "doubt",
  },
  {
    key: "provider-identity",
    column: provider,
    text: '{"cal":{"identity":{"baseKey":"legacy-base"}}}',
    outcome: "doubt",
  },
  {
    key: "provider-identity-spaced",
    column: provider,
    text: '{"cal":{"identity" : {"baseKey":"shared-base"}}}',
    outcome: "doubt",
  },
  {
    key: "provider-identity-newlines",
    column: provider,
    text: '{\n  "cal": {\n    "identity": {"baseKey": "x"}\n  }\n}',
    outcome: "doubt",
  },
  {
    key: "provider-identity-reordered",
    column: provider,
    text: '{"cal":{"rows":[],"identity":{"occurrenceCount":1,"baseKey":"y"}}}',
    outcome: "doubt",
  },
  {
    key: "provider-identity-in-string",
    column: provider,
    text: '{"cal":{"rows":[{"merchantName":"say \\"identity\\""}]}}',
    outcome: "doubt",
  },
  { key: "link-json-null", column: link, text: "null", outcome: "safe" },
  { key: "link-spaced-null", column: link, text: " null", outcome: "doubt" },
];

describe.each(backends)("%s narrow ledger loading", (backend) => {
  let db: Harness;
  const connectionId = "matrix";

  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(async () => {
    configureHydration();
    await db.close();
  });

  const capture = (
    runId: string,
    day: number,
    rows: TransactionInput[],
    accountKey = "account",
    adapter: SourceAdapter = synthetic,
    scope?: CollectionScope,
  ) =>
    db.ingestRun(
      {
        connectionId,
        runId,
        responses: [
          {
            accountKey,
            endpoint: "synthetic:matrix",
            capturedAt: `2040-07-0${day}T12:00:00Z`,
            responseText: JSON.stringify(rows),
            ...(scope ? { scope } : {}),
          },
        ],
      },
      adapter,
    );

  async function idOf(sourceKey: string) {
    const [stored] = await db.raw(
      "SELECT id FROM transactions WHERE source_key = ?",
      [sourceKey],
    );
    return stored!.id as string;
  }

  async function writeRaw(key: string, column: string, text: string | null) {
    const [table, name] = column.split(".");
    await db.raw(
      `UPDATE ${table} SET ${name} = ? WHERE ${table === "transactions" ? "id" : "transaction_id"} = ?`,
      [text, await idOf(key)],
    );
  }

  it("decides only on canonical stored text and hydrates every doubt", async () => {
    await capture(
      "matrix-1",
      1,
      rawDocuments.map(({ key }) => row(key)),
    );
    for (const { key, column, text } of rawDocuments) {
      await writeRaw(key, column, text);
    }
    const before = loadingComparisons.length;
    // A capture that declares nothing absent leaves every stored row untouched.
    await capture("matrix-2", 2, [row("unrelated")], "account", incomparable);
    expect(loadingComparisons).toHaveLength(before + 1);
    const loaded = latest();
    const byKey = async (key: string) => {
      const id = await idOf(key);
      return {
        id,
        row: loaded.narrowRows.find((candidate) => candidate.id === id)!,
        complete: loaded.completeRows.find((candidate) => candidate.id === id)!,
      };
    };
    for (const { key, outcome, retired } of rawDocuments) {
      const { id, row: stored } = await byKey(key);
      if (outcome === "doubt") {
        expect(loaded.doubtful, key).toContain(id);
        expect(loaded.hydrated, key).toContain(id);
      } else {
        expect(loaded.doubtful, key).not.toContain(id);
        expect(loaded.hydrated, key).not.toContain(id);
      }
      if (retired !== undefined) {
        expect(stored.retired, key).toBe(retired);
      }
    }
    expect((await byKey("alias-nul")).row.sourceAliases).toEqual([
      "alias\u0000x",
    ]);
    expect((await byKey("alias-surrogate")).row.sourceAliases).toEqual([
      "lone\udc00",
    ]);
    expect((await byKey("alias-backslash")).row.sourceAliases).toEqual([
      "a\\u0000b",
    ]);
    expect((await byKey("provider-plain")).row.providerIdentity).toEqual({});
    expect((await byKey("link-json-null")).row.details.postingLink).toBe(
      undefined,
    );
    const complete = async (key: string) => (await byKey(key)).complete;
    expect(
      (await complete("retired-spaced")).sourceEvidence?.identity
        ?.retiredFromMatching,
    ).toBe(true);
    expect(
      (await complete("retired-escaped-key")).sourceEvidence?.identity
        ?.retiredFromMatching,
    ).toBe(true);
    expect(
      (await complete("provider-identity-spaced")).details.provider.cal
        ?.identity,
    ).toEqual({ baseKey: "shared-base" });
    expect((await complete("link-spaced-null")).details.postingLink).toBe(
      undefined,
    );
    expect(loaded.hydrated.length).toBeLessThan(loaded.narrowRows.length);
  });

  it("groups by an identity left in non-canonical provider text before matching", async () => {
    await capture("matrix-1", 1, [row("legacy")]);
    await writeRaw(
      "legacy",
      provider,
      '{"cal":{"identity" : {"baseKey":"shared-base"}}}',
    );
    const historical = row("historical", {
      details: {
        ...emptyDetails(),
        provider: { cal: { identity: { baseKey: "shared-base" } } },
      },
    });
    const result = await capture(
      "matrix-2",
      2,
      [historical],
      "account",
      synthetic,
      { kind: "history" },
    );
    // The stored row's declared base makes the historical row a known
    // identity, never a second transaction.
    expect(result.created).toBe(0);
    const legacy = await idOf("legacy");
    expect(latest().doubtful).toContain(legacy);
    expect(latest().hydrated).toContain(legacy);
    expect(await db.raw("SELECT id FROM transactions")).toHaveLength(1);
  });

  it("detects a corrupted narrow fact of a row the plan never hydrated", async () => {
    await capture("matrix-1", 1, [row("kept")]);
    await capture("matrix-2", 2, [row("unrelated")], "account", incomparable);
    const loaded = latest();
    const untouched = loaded.narrowRows.find(
      (candidate) => !loaded.hydrated.includes(candidate.id),
    );
    expect(untouched).toBeDefined();
    expect(() => expectNarrowRowsExact(loaded)).not.toThrow();
    const corrupted = loaded.narrowRows.map((candidate) =>
      candidate === untouched
        ? { ...candidate, merchantName: "Corrupted" }
        : candidate,
    );
    // The plans agreed (the verifier asserted it); only the every-row check
    // sees the corrupted fact.
    expect(() =>
      expectNarrowRowsExact({ ...loaded, narrowRows: corrupted }),
    ).toThrow();
  });

  it("hydrates only the rows an application touches", async () => {
    await capture("matrix-1", 1, [row("a"), row("b")]);
    await capture("matrix-2", 2, [row("c", { sourceScope: "other" })], "other");
    await capture("matrix-3", 3, [row("a"), row("b")]);
    const loaded = latest();
    // Another account's row is outside the capture's scope: never read.
    expect(loaded.narrowRows.map(({ id }) => id).sort()).toEqual(
      [await idOf("a"), await idOf("b")].sort(),
    );
    expect(new Set(loaded.hydrated)).toEqual(
      new Set([await idOf("a"), await idOf("b")]),
    );
    expect(loaded.rounds).toBe(1);
  });

  it("plans in one round when the prediction covers every read", async () => {
    await capture("matrix-1", 1, [row("a"), row("b")]);
    await capture("matrix-2", 2, [row("a"), row("b")]);
    expect(latest()).toMatchObject({ rounds: 1 });
    configureHydration({ predict: false });
    await capture("matrix-3", 3, [row("a"), row("b")]);
    expect(latest().rounds).toBe(2);
    expect(latest().hydrated).toHaveLength(2);
  });

  it("hydrates a late absence demand in the next round", async () => {
    await capture("matrix-1", 1, [row("a"), row("b")]);
    await capture("matrix-2", 2, [row("a")]);
    const absent = await idOf("b");
    expect(latest().rounds).toBe(2);
    expect(latest().hydrated).toContain(absent);
    expect(await db.getTransaction(absent)).toMatchObject({
      presence: "not_returned",
    });
  });

  it("falls back to every row after the round limit", async () => {
    await capture("matrix-1", 1, [row("a"), row("b")]);
    // No planning of these captures, which declare nothing absent, demands "b".
    const unrelated = await idOf("b");
    configureHydration({ predict: false });
    await capture("matrix-3", 3, [row("a")], "account", incomparable);
    expect(latest().rounds).toBe(2);
    expect(latest().narrowRows.map(({ id }) => id)).toContain(unrelated);
    expect(latest().hydrated).not.toContain(unrelated);
    configureHydration({ predict: false, rounds: 1 });
    await capture("matrix-4", 4, [row("a")], "account", incomparable);
    expect(latest().rounds).toBe(2);
    expect(latest().hydrated).toContain(unrelated);
    expect(latest().hydrated).toHaveLength(latest().narrowRows.length);
  });

  it("fails rather than plan without a row it had to hydrate", async () => {
    await capture("matrix-1", 1, [row("a")]);
    configureHydration({
      beforeRead: (ids) => {
        ids.push("missing-row");
      },
    });
    await expect(capture("matrix-2", 2, [row("a")])).rejects.toThrow(
      "A hydrated transaction is missing",
    );
  });

  if (backend === "d1-local") {
    it("rejects the commit when the connection changes between loading and hydration", async () => {
      await capture("matrix-1", 1, [row("a")]);
      const id = await idOf("a");
      let interrupted = false;
      configureHydration({
        beforeRead: async () => {
          if (interrupted) {
            return;
          }
          interrupted = true;
          const peer = await db.peer();
          try {
            await peer.editAnnotation({
              transactionId: id,
              expectedVersion: 0,
              notes: "Concurrent",
            });
          } finally {
            await peer.close();
          }
        },
      });
      await expect(capture("matrix-2", 2, [row("a")])).rejects.toBeInstanceOf(
        ConflictError,
      );
    });
  }
});

describe.each(backends)("%s speculative planning rounds", (backend) => {
  let db: Harness;
  let harness: ReturnType<typeof postingHarness>;
  beforeEach(async () => {
    db = await open(backend);
    harness = postingHarness(db);
    await db.ensureConnection({ id: harness.connectionId, provider: "cal" });
  });
  afterEach(async () => {
    configureHydration();
    await db.close();
  });

  const withCompatibility = (
    compatibleGroups: NonNullable<
      SourceAdapter["automaticPosting"]
    >["compatibleGroups"],
  ): SourceAdapter => ({
    ...postingAdapter,
    automaticPosting: { ...postingAdapter.automaticPosting!, compatibleGroups },
  });

  it("keeps a hydrated duplicate key in its ingestion position", async () => {
    const { automaticPosting: _automatic, ...manual } = postingAdapter;
    // The posted row is stored first; linking a later authorization to it
    // leaves two rows with its source key, the retired one first.
    await harness.capture(1, [row("posted")], manual);
    // A posted row keeps the capture plausible while "posted" is absent.
    await harness.capture(
      2,
      [
        authorization("pending"),
        row("unrelated", { merchantName: "Other shop", amountMinor: -500 }),
      ],
      manual,
    );
    const posted = (
      await db.listTransactions({
        connectionId: harness.connectionId,
        includeSuperseded: true,
      })
    ).find((candidate) => candidate.sourceKey === "posted")!;
    const pending = await harness.byKey("pending");
    await db.linkPendingTransaction({
      ...(await harness.command(pending.id, posted.id)),
      reason: "Owner verified the posting",
    });
    configureHydration({ predict: false });
    const result = await harness.capture(3, [row("posted")], manual);
    const loaded = latest();
    // Of the two rows with the key, only the second is read complete, and
    // the key attributes to it; the unrelated row is hydrated for its absence.
    const unrelated = await harness.byKey("unrelated");
    expect(new Set(loaded.hydrated)).toEqual(
      new Set([pending.id, unrelated.id]),
    );
    expect(result.created).toBe(0);
    expect((await db.getTransaction(pending.id))!.lastSeenRunId).toBe(
      "posting-3",
    );
    const order = loaded.completeRows.map(({ id }) => id);
    expect(order.indexOf(posted.id)).toBeLessThan(order.indexOf(pending.id));
    expect(loaded.plannedRows).toEqual(
      order.map((id) => ({
        id,
        narrow: id !== pending.id && id !== unrelated.id,
      })),
    );
    expectPlannedOrder(loaded);
  });

  it("discards an error a demand round raised on speculative facts", async () => {
    await harness.capture(2, [authorization("pending")]);
    const pending = await harness.byKey("pending");
    const adapter = withCompatibility((pendingRows, postedRows) => {
      if (pendingRows.some((candidate) => !candidate.details.provider.cal)) {
        throw new Error("Speculative facts");
      }
      return compatibleCalPostingGroups(pendingRows, postedRows);
    });
    await harness.capture(3, [row("posted")], adapter);
    expect(latest().rounds).toBe(2);
    expect(latest().hydrated).toContain(pending.id);
    expect(await harness.byKey("posted")).toMatchObject({ id: pending.id });
  });

  it("raises an error the complete round raises again", async () => {
    await harness.capture(2, [authorization("pending")]);
    const adapter = withCompatibility(() => {
      throw new Error("Persistent planner failure");
    });
    await expect(harness.capture(3, [row("posted")], adapter)).rejects.toThrow(
      "Persistent planner failure",
    );
  });
});
