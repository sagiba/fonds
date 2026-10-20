import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectFromStore,
  type CollectionStore,
  validateCollectionRange,
} from "../../src/application/collection.js";
import { RECONCILIATION_POLICY_VERSION } from "../../src/domain/plans/sync.js";
import type {
  CollectionEvent,
  ProviderCollector,
  SourceAdapter,
} from "../../src/domain/source-adapter.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  CAL_COLLECTOR_VERSION,
  collectCal,
} from "../../src/providers/cal/collect.js";
import { CAL_ENDPOINTS } from "../../src/providers/cal/transport.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import { syncRuns, transactions } from "../../src/storage/sqlite/schema.js";

const responseText = readFileSync(
  new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
  "utf8",
);
const capture: CollectionEvent = {
  type: "capture",
  capture: {
    accountKey: "synthetic-account",
    endpoint: "synthetic/recent",
    capturedAt: "2040-08-01T00:00:00Z",
    responseText,
  },
};
const failure: CollectionEvent = {
  type: "failure",
  failure: {
    accountKey: "synthetic-other",
    endpoint: "synthetic/recent",
    code: "network_error",
  },
  fatal: false,
};

function collector(
  events: CollectionEvent[],
  provider = "cal",
): ProviderCollector {
  return {
    provider,
    collectorVersion: "synthetic-v1",
    async *collect() {
      yield* events;
    },
  };
}

describe("streamed collection application boundary", () => {
  let db: Database;
  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.ensureConnection({ id: "synthetic", provider: "cal" });
  });
  afterEach(() => db.close());

  it("persists and applies a response before asking the adapter for its next window", async () => {
    const streaming: ProviderCollector = {
      provider: "cal",
      collectorVersion: "synthetic-v1",
      async *collect() {
        yield capture;
        expect(await db.orm.select().from(syncRuns).all()).toHaveLength(1);
        expect(await db.listTransactions()).toHaveLength(21);
        yield failure;
        yield capture;
      },
    };
    const summary = await collectFromStore(
      db,
      { connectionId: "synthetic" },
      streaming,
      calAdapter,
    );
    expect(summary).toMatchObject({
      status: "partial",
      captures: 2,
      failures: 1,
      created: 21,
    });
    expect(summary.runIds).toHaveLength(3);
    expect(
      (await db.orm.select().from(syncRuns).all())[0]?.snapshot.responses[0]
        ?.responseText,
    ).toBe(responseText);
    expect(
      (await db.orm.select().from(syncRuns).all())[0]?.collectorVersion,
    ).toBe("synthetic-v1");
  });

  it("retains completed windows and archives a safe failure when an adapter throws secret text", async () => {
    const streaming: ProviderCollector = {
      provider: "cal",
      collectorVersion: "synthetic-v1",
      async *collect() {
        yield capture;
        throw new Error("SYNTHETIC_SECRET_TOKEN_AND_BODY");
      },
    };
    expect(
      await collectFromStore(
        db,
        { connectionId: "synthetic" },
        streaming,
        calAdapter,
      ),
    ).toMatchObject({ status: "partial", captures: 1, failures: 1 });
    const runs = await db.orm.select().from(syncRuns).all();
    expect(JSON.stringify(runs)).not.toContain(
      "SYNTHETIC_SECRET_TOKEN_AND_BODY",
    );
    expect(runs[1]?.snapshot.failures).toEqual([
      { accountKey: null, endpoint: "collection", code: "network_error" },
    ]);
  });

  it("stops and closes the generator on fatal authentication failure", async () => {
    let closed = false;
    let continued = false;
    const streaming: ProviderCollector = {
      provider: "cal",
      collectorVersion: "synthetic-v1",
      async *collect() {
        try {
          yield {
            type: "failure",
            failure: {
              accountKey: null,
              endpoint: "authentication",
              code: "authentication_challenge",
            },
            fatal: true,
          } as const;
          continued = true;
          yield capture;
        } finally {
          closed = true;
        }
      },
    };
    expect(
      await collectFromStore(
        db,
        { connectionId: "synthetic" },
        streaming,
        calAdapter,
      ),
    ).toMatchObject({ status: "failed", captures: 0, failures: 1 });
    expect(closed).toBe(true);
    expect(continued).toBe(false);
  });

  it("stops fetching after persistence failure and releases the local collection guard", async () => {
    await db.client.executeMultiple(
      "CREATE TRIGGER reject_capture BEFORE INSERT ON sync_runs BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END",
    );
    let advanced = false;
    const streaming: ProviderCollector = {
      provider: "cal",
      collectorVersion: "synthetic-v1",
      async *collect() {
        yield capture;
        advanced = true;
        yield capture;
      },
    };
    await expect(
      collectFromStore(
        db,
        { connectionId: "synthetic" },
        streaming,
        calAdapter,
      ),
    ).rejects.toThrow();
    expect(advanced).toBe(false);
    await db.client.executeMultiple("DROP TRIGGER reject_capture");
    expect(
      await collectFromStore(
        db,
        { connectionId: "synthetic" },
        collector([capture]),
        calAdapter,
      ),
    ).toMatchObject({ status: "completed" });
  });

  it("rejects overlapping collectors on one database handle before the second network call", async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first: ProviderCollector = {
      provider: "cal",
      collectorVersion: "synthetic-v1",
      async *collect() {
        await paused;
        yield capture;
      },
    };
    const running = collectFromStore(
      db,
      { connectionId: "synthetic" },
      first,
      calAdapter,
    );
    await expect(
      collectFromStore(
        db,
        { connectionId: "synthetic" },
        collector([capture]),
        calAdapter,
      ),
    ).rejects.toThrow("already running");
    release();
    await running;
  });

  it("never starts the network for an invalid range, provider mismatch or pre-aborted request", async () => {
    let started = false;
    const streaming: ProviderCollector = {
      provider: "cal",
      collectorVersion: "synthetic-v1",
      async *collect() {
        started = true;
        yield capture;
      },
    };
    await expect(
      collectFromStore(
        db,
        {
          connectionId: "synthetic",
          range: { from: "2041-02-29", to: "2041-03-01" },
        },
        streaming,
        calAdapter,
      ),
    ).rejects.toThrow("calendar");
    await expect(
      collectFromStore(
        db,
        { connectionId: "synthetic" },
        { ...streaming, provider: "other" },
        calAdapter,
      ),
    ).rejects.toThrow("must match");
    expect(
      await collectFromStore(
        db,
        { connectionId: "synthetic", signal: AbortSignal.abort() },
        streaming,
        calAdapter,
      ),
    ).toMatchObject({ status: "failed", failures: 1 });
    expect(started).toBe(false);
  });

  it("stops a default collector before resuming its generator after cancellation", async () => {
    const controller = new AbortController();
    let resumed = false;
    let closed = false;
    const streaming: ProviderCollector = {
      provider: "cal",
      collectorVersion: "synthetic-v1",
      async *collect() {
        try {
          controller.abort();
          yield capture;
          resumed = true;
          yield capture;
        } finally {
          closed = true;
        }
      },
    };
    expect(
      await collectFromStore(
        db,
        { connectionId: "synthetic", signal: controller.signal },
        streaming,
        calAdapter,
      ),
    ).toMatchObject({ status: "partial", captures: 1, failures: 1 });
    expect(resumed).toBe(false);
    expect(closed).toBe(true);
  });

  describe("identical repeat captures", () => {
    const base = (capture as Extract<CollectionEvent, { type: "capture" }>)
      .capture;
    const changedText = responseText.replace(
      /"daysRange": [^,]*/,
      '"daysRange": 89',
    );
    // CAL's per-request identifier differs on every otherwise identical read.
    const read = (
      groupPid: string,
      overrides: Partial<typeof base> = {},
      text = responseText,
    ): CollectionEvent => ({
      type: "capture",
      capture: {
        ...base,
        // Only freshly fetched captures can be reused.
        capturedAt: new Date().toISOString(),
        responseText: text.replace(
          /"groupPid": "[^"]*"/,
          `"groupPid": "${groupPid}"`,
        ),
        ...overrides,
      },
    });
    const runs = async () =>
      (await db.orm.select().from(syncRuns).all()).length;
    const collect = (
      events: CollectionEvent[],
      target: CollectionStore = db,
      source: SourceAdapter = calAdapter,
    ) =>
      collectFromStore(
        target,
        { connectionId: "synthetic" },
        collector(events),
        source,
      );

    /** A changing ingest is confirmed by one more archive, then repeats are skipped. */
    async function settle(groupPid: string) {
      await collect([read(`${groupPid}-1`)]);
      await collect([read(`${groupPid}-2`)]);
      expect((await collect([read(`${groupPid}-3`)])).unchanged).toBe(1);
    }

    it("updates card metadata without invalidating identical financial rereads or emitting transaction changes", async () => {
      await settle("directory");
      const stored = await runs();
      const revision = await db.ledgerRevision("synthetic");
      const first = {
        type: "card_discovery" as const,
        discovery: {
          observedAt: "2040-01-01T00:00:00Z",
          cards: [{ cardKey: "card", last4: "0012" }],
        },
      };
      expect((await collect([first, read("directory-4")])).unchanged).toBe(1);
      expect(
        (
          await collect([
            {
              ...first,
              discovery: {
                observedAt: "2040-02-01T00:00:00Z",
                cards: [{ ...first.discovery.cards[0]!, last4: "3456" }],
              },
            },
            read("directory-5"),
          ])
        ).unchanged,
      ).toBe(1);
      expect(
        (await db.listCards({ connectionId: "synthetic" })).cards.find(
          (card) => card.providerKey === "card",
        )?.last4,
      ).toBe("3456");
      expect(await runs()).toBe(stored);
      expect(await db.ledgerRevision("synthetic")).toBe(revision);
    });

    it("skips identical rereads once the ledger is settled, without storing anything", async () => {
      expect(
        await collectFromStore(
          db,
          { connectionId: "synthetic" },
          collector([read("A")]),
          calAdapter,
        ),
      ).toMatchObject({ status: "completed", unchanged: 0, created: 21 });
      await collect([read("B")]);
      const stored = await runs();
      expect(await collect([read("C")])).toMatchObject({
        status: "completed",
        captures: 1,
        unchanged: 1,
        failures: 0,
        runIds: [],
      });
      expect(await runs()).toBe(stored);
    });

    it("archives changed content, parser upgrades and non-2xx responses", async () => {
      await settle("A");
      const stored = await runs();
      expect((await collect([read("B", {}, changedText)])).unchanged).toBe(0);
      expect(
        (
          await collect([read("C", {}, changedText)], db, {
            ...calAdapter,
            parserVersion: `${calAdapter.parserVersion}-next`,
          })
        ).unchanged,
      ).toBe(0);
      expect((await collect([read("D", { httpStatus: 503 })])).unchanged).toBe(
        0,
      );
      expect(await runs()).toBe(stored + 3);
    });

    it("re-ingests identical content once after auto-posting-v7 to v8 without changing the parser", async () => {
      expect(RECONCILIATION_POLICY_VERSION).toBe("auto-posting-v8");
      const fingerprintUnder = (policyVersion: string) =>
        createHash("sha256")
          .update(
            [
              calAdapter.parserVersion,
              collector([]).collectorVersion,
              policyVersion,
              calAdapter.recentComparableDays,
              calAdapter.rejectEmptyRecentPosted,
              calAdapter.contentFingerprint!(responseText),
            ].join("\n"),
          )
          .digest("hex");
      await settle("A");
      const stored = await runs();
      const lastCapture = (await db.getStoredConnection("synthetic"))?.config
        .lastCapture as { fingerprint: string };
      expect(lastCapture.fingerprint).toBe(
        fingerprintUnder(RECONCILIATION_POLICY_VERSION),
      );
      // Emulate the same capture accepted under an earlier policy version.
      await db.updateConfig("synthetic", (config) => ({
        ...config,
        lastCapture: {
          ...lastCapture,
          fingerprint: fingerprintUnder("auto-posting-v7"),
        },
      }));
      expect((await collect([read("B")])).unchanged).toBe(0);
      expect(await runs()).toBe(stored + 1);
      expect((await collect([read("C")])).unchanged).toBe(1);
      expect(
        (
          await collect([read("D")], db, {
            ...calAdapter,
            recentComparableDays: 59,
          })
        ).unchanged,
      ).toBe(0);
      expect(
        (await db.orm.select().from(syncRuns).all()).every(
          (run) => run.parserVersion === calAdapter.parserVersion,
        ),
      ).toBe(true);
    });

    it("never caches a rejected capture, even though its ledger revision is unchanged", async () => {
      const date = new Date().toISOString().slice(0, 10);
      const populated = responseText
        .replaceAll("2040-05-20", date)
        .replaceAll("2040-06-11", date);
      await collect([read("A", {}, populated)]);
      await collect([read("B", {}, populated)]);
      const revision = await db.ledgerRevision("synthetic");
      const stored = await runs();
      const empty = JSON.parse(populated);
      empty.result.transactions = [];
      for (const groupPid of ["C", "D", "E"]) {
        expect(
          await collect([read(groupPid, {}, JSON.stringify(empty))]),
        ).toMatchObject({
          status: "failed",
          failureCodes: ["implausible_empty"],
          unchanged: 0,
        });
        expect(await db.ledgerRevision("synthetic")).toBe(revision);
        expect(
          (await db.getStoredConnection("synthetic"))?.config.lastCapture,
        ).not.toHaveProperty("fingerprint");
      }
      expect(await runs()).toBe(stored + 3);
      expect(await collect([read("F", {}, populated)])).toMatchObject({
        status: "completed",
        unchanged: 0,
      });
      expect(await db.ledgerRevision("synthetic")).toBe(revision);
    });

    it("reconciles again after a removal, including one made during the ingest", async () => {
      await settle("A");
      const store = db;
      const [first, second] = await db.listTransactions();
      await store.confirmRemoval({
        transactionId: first!.id,
        expectedVersion: first!.version,
        reason: "Synthetic removal before an identical reread",
      });
      expect((await collect([read("B")])).unchanged).toBe(0);
      await collect([read("C")]);
      // A removal racing the ingest is newer than the sampled change ID.
      const racing: CollectionStore = {
        ...store,
        async ingestRun(...args) {
          const result = await store.ingestRun(...args);
          const current = (await db.listTransactions()).find(
            (row) => row.id === second!.id,
          )!;
          await store.confirmRemoval({
            transactionId: current.id,
            expectedVersion: current.version,
            reason: "Synthetic removal racing an ingest",
          });
          return result;
        },
      };
      await collect([read("D", {}, changedText)], racing);
      expect((await collect([read("E", {}, changedText)])).unchanged).toBe(0);
    });

    it("restores rows deleted outside the ledger on the next identical reread", async () => {
      await settle("A");
      // A row no billed line references, so the deletion keeps the FK intact.
      const victim = (await db.listTransactions()).find(
        (row) => row.installmentCount === null,
      );
      // Simulate out-of-band corruption without violating the import-event foreign key.
      await db.client.execute({
        sql: "UPDATE events SET transaction_id = NULL WHERE transaction_id = ?",
        args: [victim!.id],
      });
      await db.orm.delete(transactions).where(eq(transactions.id, victim!.id));
      expect(await db.listTransactions()).toHaveLength(20);
      expect((await collect([read("B")])).unchanged).toBe(0);
      const restored = await db.listTransactions();
      expect(restored).toHaveLength(21);
      expect(restored.map((row) => row.sourceKey)).toContain(victim!.sourceKey);
    });

    it("never reuses a capture after a failure, a crash, another scope or a stale capture", async () => {
      await settle("A");
      // An explicit failure whose archive write throws still clears the record.
      const store = db;
      const crashing: CollectionStore = {
        ...store,
        async ingestRun() {
          throw new Error("synthetic storage crash");
        },
      };
      await expect(collect([failure], crashing)).rejects.toThrow(
        "synthetic storage crash",
      );
      expect((await collect([read("B")])).unchanged).toBe(0);

      await settle("C");
      await collect([read("D", { scope: { kind: "recent" } })]);
      expect((await collect([read("E")])).unchanged).toBe(0);

      // A delayed capture with other content, even one whose offset timestamp
      // sorts after the newest capture as a string, never becomes reusable.
      await settle("F");
      const delayed = Date.now() - 60 * 60 * 1000;
      // The same instant written at +02:00 sorts after a newer "Z" string.
      const offset = `${new Date(delayed + 2 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19)}+02:00`;
      for (const capturedAt of [new Date(delayed).toISOString(), offset]) {
        await collect([read("G", { capturedAt }, changedText)]);
        expect((await collect([read("H", {}, changedText)])).unchanged).toBe(0);
        await settle("I");
      }
    });
  });

  it("does not report a silent empty adapter as a successful collection", async () => {
    expect(
      await collectFromStore(
        db,
        { connectionId: "synthetic" },
        collector([]),
        calAdapter,
      ),
    ).toMatchObject({ status: "failed", failures: 1 });
  });

  it("does not let a recent refresh clear an interrupted historical campaign", async () => {
    const range = { from: "2010-01-01", to: "2040-08-01" };
    await collectFromStore(
      db,
      { connectionId: "synthetic", range, signal: AbortSignal.abort() },
      collector([capture]),
      calAdapter,
    );
    expect(
      (await db.orm.select().from(syncRuns).get())?.snapshot.failures?.[0]
        ?.scope,
    ).toEqual({ kind: "history", ...range });
    await collectFromStore(
      db,
      { connectionId: "synthetic" },
      collector([capture]),
      calAdapter,
    );
    expect(
      (await db.listEvents()).some((event) => event.type === "sync.recovered"),
    ).toBe(false);
  });

  it("retains unattempted history after a fatal login failure and a later recent success", async () => {
    const range = { from: "2040-01-01", to: "2040-06-30" };
    const failed: CollectionEvent = {
      type: "failure",
      failure: {
        accountKey: null,
        endpoint: "authentication",
        code: "authentication_failed",
      },
      fatal: true,
    };
    expect(
      await collectFromStore(
        db,
        { connectionId: "synthetic", range },
        collector([failed]),
        calAdapter,
      ),
    ).toMatchObject({ status: "failed", failures: 2 });
    const runs = await db.orm.select().from(syncRuns).all();
    expect(runs[1]?.snapshot.failures?.[0]).toMatchObject({
      accountKey: null,
      endpoint: "collection",
      scope: { kind: "history", ...range },
    });
    await collectFromStore(
      db,
      { connectionId: "synthetic" },
      collector([capture]),
      calAdapter,
    );
    const recovery = (await db.listEvents())
      .filter((event) => event.type === "sync.recovered")
      .at(-1);
    expect(
      (recovery?.after as { failedScopes: string[] }).failedScopes.some(
        (scope) => scope.includes('"kind":"history"'),
      ),
    ).toBe(true);
  });

  it("does not mistake recovery of the failed window for completion of a stopped backfill", async () => {
    const range = { from: "2040-01-01", to: "2040-06-30" };
    const window = {
      kind: "history" as const,
      month: "2040-02",
      from: "2040-02-01",
      to: "2040-02-29",
    };
    const failed: CollectionEvent = {
      type: "failure",
      failure: {
        accountKey: "synthetic-account",
        endpoint: "synthetic/search",
        code: "network_error",
        scope: window,
      },
      fatal: true,
    };
    await collectFromStore(
      db,
      { connectionId: "synthetic", range },
      collector([failed]),
      calAdapter,
    );
    const retry: CollectionEvent = {
      type: "capture",
      capture: {
        ...capture.capture,
        endpoint: "synthetic/search",
        scope: window,
      },
    };
    await collectFromStore(
      db,
      {
        connectionId: "synthetic",
        range: { from: window.from, to: window.to },
      },
      collector([retry]),
      calAdapter,
    );
    const recovery = (await db.listEvents())
      .filter((event) => event.type === "sync.recovered")
      .at(-1);
    expect(
      (recovery?.after as { failedScopes: string[] }).failedScopes,
    ).toHaveLength(1);
    expect(
      (recovery?.after as { failedScopes: string[] }).failedScopes[0],
    ).toContain(range.to);
  });

  it("does not record the same broad fatal range twice", async () => {
    const range = { from: "2040-01-01", to: "2040-06-30" };
    const event: CollectionEvent = {
      type: "failure",
      failure: {
        accountKey: null,
        endpoint: "collection",
        code: "network_error",
        scope: { kind: "history", ...range },
      },
      fatal: true,
    };
    expect(
      await collectFromStore(
        db,
        { connectionId: "synthetic", range },
        collector([event]),
        calAdapter,
      ),
    ).toMatchObject({ failures: 1 });
    expect(await db.orm.select().from(syncRuns).all()).toHaveLength(1);
  });

  it("supports a second provider through its own extraction and collection implementations", async () => {
    await db.ensureConnection({
      id: "synthetic-bank",
      provider: "synthetic-bank",
    });
    let received = "";
    const adapter: SourceAdapter = {
      provider: "synthetic-bank",
      parserVersion: "synthetic-bank-v1",
      extract(raw, context) {
        received = raw;
        return {
          transactions: [],
          partitions: [
            {
              accountKey: context.accountKey,
              status: "posted",
              success: true,
              comparable: true,
            },
          ],
          warnings: [],
          historical: false,
        };
      },
    };
    const event: CollectionEvent = {
      type: "capture",
      capture: { ...capture.capture, responseText: '{"bankEntries":[]}' },
    };
    expect(
      await collectFromStore(
        db,
        { connectionId: "synthetic-bank" },
        collector([event], "synthetic-bank"),
        adapter,
      ),
    ).toMatchObject({ status: "completed", captures: 1 });
    expect(received).toBe('{"bankEntries":[]}');
    expect((await db.orm.select().from(syncRuns).get())?.parserVersion).toBe(
      "synthetic-bank-v1",
    );
  });

  it("accepts multi-year caller ranges without silently truncating them", () => {
    expect(
      validateCollectionRange({ from: "2000-02-29", to: "2040-12-31" }),
    ).toEqual({ from: "2000-02-29", to: "2040-12-31" });
    expect(() =>
      validateCollectionRange({ from: "2040-12-31", to: "2000-02-29" }),
    ).toThrow("reversed");
  });

  it("runs two complete synthetic billing years through CAL transport, streaming archive and extraction", async () => {
    const cards = ["SYNTHETIC-CARD-A", "SYNTHETIC-CARD-B"];
    let requests = 0;
    const fetcher: typeof fetch = async (url, init) => {
      requests++;
      if (url === CAL_ENDPOINTS.login) {
        return Response.json({ token: "SYNTHETIC-SECRET-TOKEN" });
      }
      if (url === CAL_ENDPOINTS.init) {
        return Response.json({
          statusCode: 1,
          result: {
            bankAccounts: [{ bankAccountUniqueId: "synthetic-account" }],
            cards: cards.map((cardUniqueId) => ({
              cardUniqueId,
              bankAccountUniqueId: "synthetic-account",
            })),
          },
        });
      }
      if (url === CAL_ENDPOINTS.recent) {
        return new Response(responseText);
      }
      expect(url).toBe(CAL_ENDPOINTS.monthly);
      const body = JSON.parse(String(init?.body));
      return Response.json({
        statusCode: 1,
        result: {
          bankAccounts: [
            {
              debitDates: [
                {
                  transactions: [
                    {
                      trnIntId: "SYNTHETIC-HISTORY",
                      cardUniqueId: body.cardUniqueId,
                      amtBeforeConvAndIndex: 15.4,
                    },
                  ],
                },
              ],
              immidiateDebits: { debitDays: [] },
            },
          ],
        },
      });
    };
    const summary = await collectFromStore(
      db,
      {
        connectionId: "synthetic",
        range: { from: "2039-01-01", to: "2040-12-31" },
      },
      {
        provider: "cal",
        collectorVersion: CAL_COLLECTOR_VERSION,
        collect: (options) =>
          collectCal({
            ...options,
            historyMode: "monthly",
            fetch: fetcher,
            credentials: {
              username: "SYNTHETIC-SECRET-USERNAME",
              password: "SYNTHETIC-SECRET-PASSWORD",
            },
          }),
      },
      calAdapter,
    );
    expect(summary).toMatchObject({
      status: "partial",
      captures: 49,
      failures: 48,
      created: 21,
    });
    expect(requests).toBe(51);
    const runs = await db.orm.select().from(syncRuns).all();
    expect(runs).toHaveLength(49);
    const historical = runs.filter(
      (run) => run.snapshot.responses[0]?.scope?.kind === "history",
    );
    expect(historical).toHaveLength(48);
    expect(
      new Set(historical.map((run) => run.snapshot.responses[0]?.scope?.month))
        .size,
    ).toBe(24);
    expect(
      historical.every((run) =>
        run.warnings.includes("unsupported_monthly_rows:1"),
      ),
    ).toBe(true);
    expect(JSON.stringify(runs)).not.toContain("SYNTHETIC-SECRET");
    expect(await db.listTransactions()).toHaveLength(21);
  });
});
