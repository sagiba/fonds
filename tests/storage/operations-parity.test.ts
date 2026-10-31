import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEventService,
  type EventSubscription,
  type SignedWebhookInput,
} from "../../src/application/events.js";
import {
  createApplication,
  inProcessInvoker,
} from "../../src/application/operations.js";
import type { Refresh } from "../../src/application/refreshes.js";
import type {
  CollectionEvent,
  ProviderCollector,
} from "../../src/domain/source-adapter.js";
import {
  createRefreshService,
  ownerRefreshes,
  UNIT_DEADLINE_MS,
} from "../../src/runtime/refresh-service.js";
import * as postgresSchema from "../../src/storage/postgres/schema.js";
import {
  prepareRun,
  runEvidenceDigest,
} from "../../src/storage/run-evidence.js";
import * as sqliteSchema from "../../src/storage/sqlite/schema.js";
import {
  backends,
  type Harness,
  open,
  type Peer,
  row,
  sourceKeysOf,
  synthetic,
} from "../helpers/storage-harness.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function capture(sourceKey: string): CollectionEvent {
  return {
    type: "capture",
    capture: {
      accountKey: "account",
      endpoint: "synthetic",
      capturedAt: new Date().toISOString(),
      responseText: JSON.stringify([row(sourceKey)]),
    },
  };
}

function collector(
  collect: ProviderCollector["collect"],
): ProviderCollector & { calls: number } {
  const value = {
    provider: "cal",
    collectorVersion: "synthetic-collector-v1",
    calls: 0,
    async *collect(options: Parameters<ProviderCollector["collect"]>[0]) {
      value.calls++;
      yield* collect(options);
    },
  };
  return value;
}

describe.each(backends)("operations parity on %s", (backend) => {
  let db: Harness;
  let peers: Peer[];
  let connectionId: string;

  beforeEach(async () => {
    db = await open(backend);
    peers = [];
    connectionId = `parity-${randomUUID()}`;
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(async () => {
    await Promise.all(peers.map((peer) => peer.close()));
    await db.close();
  });

  async function peer() {
    const opened = await db.peer();
    peers.push(opened);
    return opened;
  }

  /**
   * Archives one capture without applying it, as a crash between the two
   * leaves it; false where the harness has no ORM to write with.
   */
  async function archiveUnapplied(sourceKey: string) {
    const runs =
      db.driver.kind === "postgres"
        ? postgresSchema.syncRuns
        : sqliteSchema.syncRuns;
    const bodies =
      db.driver.kind === "postgres"
        ? postgresSchema.syncRunBodies
        : sqliteSchema.syncRunBodies;
    const orm = (db as unknown as { orm?: { insert: Function } }).orm;
    if (!orm) {
      return false;
    }
    const response = {
      accountKey: "account",
      endpoint: "synthetic",
      capturedAt: "2040-08-01T00:00:00Z",
      responseText: JSON.stringify([row(sourceKey)]),
    };
    await (
      orm as {
        insert(table: unknown): { values(value: object): Promise<unknown> };
      }
    )
      .insert(runs)
      .values({
        id: `archived-${sourceKey}`,
        connectionId,
        startedAt: "2040-08-01T00:00:00Z",
        status: "started",
        collectorVersion: "synthetic",
        parserVersion: synthetic.parserVersion,
        evidenceDigest: await runEvidenceDigest(
          prepareRun(
            {
              runId: `archived-${sourceKey}`,
              connectionId,
              collectorVersion: "synthetic",
              responses: [response],
            },
            synthetic,
          ),
        ),
        snapshot: {
          schemaVersion: 1,
          responses: [
            {
              accountKey: response.accountKey,
              endpoint: response.endpoint,
              capturedAt: response.capturedAt,
            },
          ],
        },
        coverage: [],
        warnings: [],
      });
    await (
      orm as {
        insert(table: unknown): { values(value: object): Promise<unknown> };
      }
    )
      .insert(bodies)
      .values({
        runId: `archived-${sourceKey}`,
        snapshot: { schemaVersion: 1, responses: [response] },
        retention: "staged",
        expiresAt: null,
      });
    return true;
  }

  describe("collection lock", () => {
    it("excludes another process without waiting, then lets it collect", async () => {
      const other = await peer();
      await db.ensureConnection({ id: `${connectionId}-b`, provider: "cal" });
      let release!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const holder = db.withCollectionLock(connectionId, async (store) => {
        await store.updateConfig(connectionId, (config) => ({
          ...config,
          held: true,
        }));
        entered();
        await paused;
        return "first";
      });
      await ready;
      const work = vi.fn(async () => "never");
      expect(await other.withCollectionLock(connectionId, work)).toEqual({
        acquired: false,
      });
      expect(work).not.toHaveBeenCalled();
      // Another connection's lock is independent.
      expect(
        await other.withCollectionLock(`${connectionId}-b`, async () => "b"),
      ).toEqual({ acquired: true, result: "b" });
      release();
      expect(await holder).toEqual({ acquired: true, result: "first" });
      expect(
        await other.withCollectionLock(connectionId, async (store) =>
          Boolean((await store.getStoredConnection(connectionId))?.config.held),
        ),
      ).toEqual({ acquired: true, result: true });
    });

    it("offers a locked collection only its fenced capability", async () => {
      const offered = await db.withCollectionLock(connectionId, async (store) =>
        Object.keys(store).sort(),
      );
      expect(offered).toEqual({
        acquired: true,
        result: [
          "applyRun",
          "getConnection",
          "getRefresh",
          "getStoredConnection",
          "identity",
          "ingestRun",
          "ledgerRevision",
          "recordCardDiscovery",
          "recoverPendingRuns",
          "updateConfig",
          "updateRefresh",
        ],
      });
      // Only the lease-fenced store records refresh progress.
      expect("updateRefresh" in db).toBe(false);
    });

    it("releases the lock when the work fails", async () => {
      await expect(
        db.withCollectionLock(connectionId, async () => {
          throw new Error("synthetic failure");
        }),
      ).rejects.toThrow("synthetic failure");
      expect(
        await db.withCollectionLock(connectionId, async () => "again"),
      ).toEqual({ acquired: true, result: "again" });
    });

    it("replays archived but unapplied evidence before collecting", async () => {
      if (!(await archiveUnapplied("recovered"))) {
        return;
      }
      const recovered = await db.withCollectionLock(
        connectionId,
        async (store) => [
          (await store.recoverPendingRuns(synthetic)).length,
          (await store.recoverPendingRuns(synthetic)).length,
          (await db.listTransactionPage({ connectionId })).transactions.length,
        ],
      );
      expect(recovered).toEqual({ acquired: true, result: [1, 0, 1] });
      await expect(
        db.withCollectionLock(connectionId, (store) =>
          store.recoverPendingRuns({ ...synthetic, parserVersion: "other" }),
        ),
      ).resolves.toEqual({ acquired: true, result: [] });
    });
  });

  describe("refresh", () => {
    function service(
      sources: Record<string, ProviderCollector>,
      options: {
        store?: Harness | Peer;
        afterRefresh?: (signal: AbortSignal) => Promise<void>;
      } = {},
    ) {
      return createRefreshService({
        store: options.store ?? db,
        targets: async () => ({
          targets: Object.entries(sources).map(([id, source]) => ({
            connectionId: id,
            adapter: synthetic,
            collector: async () => source,
          })),
          failures: 0,
        }),
        log: () => {},
        // A held lease answers at once here; retries have their own case.
        retryDelaysMs: [],
        ...(options.afterRefresh && { afterRefresh: options.afterRefresh }),
      });
    }

    /** A collector that waits inside its first request until released. */
    function paused() {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const source = collector(async function* () {
        entered();
        await gate;
        yield capture("paused");
      });
      return { source, ready, release };
    }

    it("records a completed refresh as the connection's latest and honors the cooldown", async () => {
      expect((await db.getConnection(connectionId))?.latestRefresh).toBeNull();
      const source = collector(async function* () {
        yield capture("refreshed");
      });
      const refreshes = service({ [connectionId]: source });
      const [first] = await refreshes.wait([
        await refreshes.start(connectionId, { trigger: "manual" }),
      ]);
      expect(first?.reason).toBeNull();
      expect(first?.refresh).toMatchObject({
        trigger: "manual",
        status: "completed",
        requiresAttention: false,
        counts: {
          captures: 1,
          unchanged: 0,
          failures: 0,
          created: 1,
          updated: 0,
        },
      });
      expect((await db.getConnection(connectionId))?.latestRefresh?.id).toBe(
        first?.refresh?.id,
      );
      const runs = await db.listSyncRuns(connectionId, { limit: 10 });
      expect(runs.map((run) => run.refreshId)).toEqual([first?.refresh?.id]);
      // Within the cooldown a start returns the finished refresh unexecuted.
      expect(
        await refreshes.start(connectionId, { trigger: "manual" }),
      ).toMatchObject({
        reason: "cooldown",
        refresh: { id: first?.refresh?.id },
      });
      expect(source.calls).toBe(1);
    });

    it("counts evidence replayed from an earlier crash in the refresh totals", async () => {
      if (!(await archiveUnapplied("replayed"))) {
        return;
      }
      const source = collector(async function* () {
        yield capture("refreshed");
      });
      const refreshes = service({ [connectionId]: source });
      const [result] = await refreshes.wait([
        await refreshes.start(connectionId, { trigger: "manual" }),
      ]);
      expect(result?.refresh).toMatchObject({
        status: "completed",
        counts: { captures: 2, observed: 2, created: 2, updated: 0 },
      });
    });

    it("answers busy to a start while another process's refresh is active, creating nothing", async () => {
      const other = await peer();
      const { source, ready, release } = paused();
      const running = service({ [connectionId]: source }, { store: other });
      const started = await running.start(connectionId, { trigger: "manual" });
      await ready;
      const rival = collector(async function* () {
        yield capture("rival");
      });
      const competing = service({ [connectionId]: rival });
      const start = () => competing.start(connectionId, { trigger: "manual" });
      // The in-memory libSQL harness has one connection for both "processes".
      const [busy, concurrent] =
        backend === "libsql-local"
          ? [await start(), await start()]
          : await Promise.all([start(), start()]);
      for (const result of [busy, concurrent]) {
        expect(result).toMatchObject({
          reason: "busy",
          refresh: { id: started.refresh?.id },
        });
      }
      // Two SQLite clients in one test process share its event loop, and the
      // native driver blocks it while waiting on a lock: no overlapping writes.
      await competing.settled();
      expect(rival.calls).toBe(0);
      release();
      await running.settled();
      expect(
        (await db.listRefreshes(connectionId, { limit: 10 })).map((refresh) => [
          refresh.id,
          refresh.status,
        ]),
      ).toEqual([[started.refresh?.id, "completed"]]);
    });

    it("fences a refresh whose lease another holder took mid-run", async () => {
      let stolen!: () => void;
      const taken = new Promise<void>((resolve) => {
        stolen = resolve;
      });
      const source = collector(async function* () {
        // Another process took the lease, as after a missed renewal.
        await db.raw(
          "UPDATE collection_leases SET holder='synthetic-successor', expires_at=expires_at+600000 WHERE connection_id=?",
          [connectionId],
        );
        stolen();
        yield capture("stale");
      });
      const refreshes = service({ [connectionId]: source });
      const started = await refreshes.start(connectionId, {
        trigger: "manual",
      });
      await taken;
      await refreshes.settled();
      expect(await db.getRefresh(started.refresh!.id)).toMatchObject({
        status: "running",
        counts: { captures: 0, created: 0 },
      });
      expect(
        (await db.listTransactionPage({ connectionId })).transactions,
      ).toEqual([]);
    });

    it("evaluates every admission rule in the transaction that records the refresh", async () => {
      const now = Date.now();
      const refresh = (id: string, extra: Partial<Refresh> = {}): Refresh => ({
        id,
        connectionId,
        trigger: "manual",
        status: "pending",
        skipReason: null,
        range: null,
        occurrence: null,
        scheduledAt: null,
        createdAt: new Date(now).toISOString(),
        startedAt: null,
        finishedAt: null,
        requiresAttention: false,
        counts: {
          captures: 0,
          observed: 0,
          unchangedTransactions: 0,
          unlisted: 0,
          unchanged: 0,
          failures: 0,
          created: 0,
          updated: 0,
        },
        failureCodes: [],
        failureReason: null,
        missed: null,
        windows: [],
        ...extra,
      });
      const ordinary = { operator: false, now };
      const operator = { operator: true, now };
      await db.admitRefresh(
        refresh("blocked", {
          status: "failed",
          startedAt: "2000-01-01T00:00:00.000Z",
          finishedAt: "2000-01-01T00:00:00.000Z",
          requiresAttention: true,
        }),
        operator,
      );
      expect(await db.admitRefresh(refresh("refused"), ordinary)).toMatchObject(
        { reason: "requires_attention", met: { id: "blocked" } },
      );
      expect(await db.admitRefresh(refresh("retry"), operator)).toMatchObject({
        reason: null,
        created: { id: "retry" },
      });
      expect(await db.admitRefresh(refresh("second"), operator)).toMatchObject({
        reason: "busy",
        met: { id: "retry" },
      });
      const occurrence = {
        occurrence: "scheduled-2040-01-02T09:00Z",
        scheduledAt: "2040-01-02T09:00:00.000Z",
        trigger: "scheduled" as const,
      };
      expect(
        await db.admitRefresh(refresh("scheduled", occurrence), ordinary),
      ).toMatchObject({
        reason: "busy",
        skipped: { id: "scheduled", status: "skipped", skipReason: "busy" },
      });
      expect(
        await db.admitRefresh(refresh("again", occurrence), ordinary),
      ).toMatchObject({ reason: "occurrence", existing: { id: "scheduled" } });
      await db.withCollectionLock(connectionId, (store) =>
        store.updateRefresh("retry", {
          status: "completed",
          startedAt: new Date(now).toISOString(),
          finishedAt: new Date(now).toISOString(),
        }),
      );
      expect(await db.admitRefresh(refresh("soon"), ordinary)).toMatchObject({
        reason: "cooldown",
        met: { id: "retry" },
      });
      expect(
        (await db.listRefreshes(connectionId, { limit: 10 }))
          .map((entry) => entry.id)
          .sort(),
      ).toEqual(["blocked", "retry", "scheduled"]);
    });

    it("resumes a crashed ranged refresh, redoing only its unfinished months", async () => {
      const id = randomUUID();
      const now = new Date().toISOString();
      await db.admitRefresh(
        {
          id,
          connectionId,
          trigger: "manual",
          status: "running",
          skipReason: null,
          range: { from: "2040-01-15", to: "2040-03-10" },
          occurrence: null,
          scheduledAt: null,
          createdAt: now,
          startedAt: now,
          finishedAt: null,
          requiresAttention: false,
          counts: {
            captures: 1,
            observed: 1,
            unchangedTransactions: 0,
            unlisted: 0,
            unchanged: 0,
            failures: 0,
            created: 1,
            updated: 0,
          },
          failureCodes: [],
          failureReason: null,
          missed: null,
          windows: [
            { from: "2040-03-01", to: "2040-03-10", status: "completed" },
            { from: "2040-02-01", to: "2040-02-29", status: "running" },
            { from: "2040-01-15", to: "2040-01-31", status: "pending" },
          ],
        },
        { operator: true, now: Date.now() },
      );
      const requested: string[] = [];
      const source = collector(async function* (options) {
        requested.push(`${options.range?.from}..${options.range?.to}`);
        yield capture(`month-${options.range?.from}`);
      });
      const refreshes = service({ [connectionId]: source });
      await refreshes.resumeStalled();
      await refreshes.settled();
      expect(requested).toEqual([
        "2040-02-01..2040-02-29",
        "2040-01-15..2040-01-31",
      ]);
      expect(await db.getRefresh(id)).toMatchObject({
        status: "completed",
        counts: { captures: 3, created: 3 },
        windows: [
          { from: "2040-03-01", status: "completed" },
          { from: "2040-02-01", status: "completed" },
          { from: "2040-01-15", status: "completed" },
        ],
      });
    });

    it("publishes one sorted list of the failure codes every window committed, across a resume", async () => {
      const detailFailure: CollectionEvent = {
        type: "failure",
        failure: {
          accountKey: null,
          endpoint: "synthetic-detail",
          code: "network_error",
        },
        fatal: false,
      };
      const source = collector(async function* (options) {
        const from = options.range!.from;
        if (from === "2040-03-01") {
          // Outlasts the first invocation's budget, so the refresh yields here.
          await sleep(700);
          yield capture("march");
          yield detailFailure;
        } else if (from === "2040-02-01") {
          yield capture("february");
          yield detailFailure;
          const rejected = capture("rejected") as Extract<
            CollectionEvent,
            { type: "capture" }
          >;
          yield {
            type: "capture",
            capture: {
              ...rejected.capture,
              accountKey: "other",
              httpStatus: 503,
            },
          };
        } else {
          yield capture("january");
        }
      });
      const targets = async () => ({
        targets: [
          {
            connectionId,
            adapter: synthetic,
            collector: async () => source,
          },
        ],
        failures: 0,
      });
      const background: Promise<unknown>[] = [];
      const bounded = createRefreshService({
        store: db,
        targets,
        log: () => {},
        retryDelaysMs: [],
        budgetMs: UNIT_DEADLINE_MS + 500,
        background: (work) => background.push(work),
        continueLater: async () => {},
      });
      const started = await bounded.start(connectionId, {
        trigger: "manual",
        range: { from: "2040-01-15", to: "2040-03-10" },
      });
      await bounded.settled();
      const id = started.refresh!.id;
      expect(await (await peer()).getRefresh(id)).toMatchObject({
        status: "running",
        failureCodes: ["network_error"],
        windows: [
          { status: "partial" },
          { status: "pending" },
          { status: "pending" },
        ],
      });
      const continued = createRefreshService({
        store: db,
        targets,
        log: () => {},
        retryDelaysMs: [],
      });
      await continued.resumeStalled();
      await continued.settled();
      const expected = ["invalid_response", "network_error"];
      expect(await db.getRefresh(id)).toMatchObject({
        status: "partial",
        failureCodes: expected,
        // March and February each commit one partial run.
        counts: { captures: 4, failures: 2 },
        windows: [
          { status: "partial" },
          { status: "partial" },
          { status: "completed" },
        ],
      });
      const invoker = inProcessInvoker(
        createApplication(db, { refreshes: ownerRefreshes(continued) }),
      );
      expect(
        await invoker.invoke("get_refresh", { refreshId: id }),
      ).toMatchObject({ refresh: { failureCodes: expected } });
      expect(
        await invoker.invoke("list_refreshes", { connectionId }),
      ).toMatchObject({ data: [{ id, failureCodes: expected }] });
      expect(
        await invoker.invoke("get_connection", { connectionId }),
      ).toMatchObject({
        connection: { latestRefresh: { id, failureCodes: expected } },
      });
    });

    it("records a scheduled occurrence it skips, once, and refreshes every other connection", async () => {
      const second = `${connectionId}-second`;
      await db.ensureConnection({ id: second, provider: "cal" });
      const { source, ready, release } = paused();
      const fresh = collector(async function* () {
        yield capture("second");
      });
      const refreshes = service({ [connectionId]: source, [second]: fresh });
      const active = await refreshes.start(connectionId, { trigger: "manual" });
      await ready;
      const occurrence = { key: `scheduled-${randomUUID()}`, at: Date.now() };
      const results = await refreshes.startAll({
        trigger: "scheduled",
        occurrence,
      });
      expect(
        results.map((result) => [result.connectionId, result.reason]),
      ).toEqual([
        [connectionId, "busy"],
        [second, null],
      ]);
      expect(results[0]?.refresh).toMatchObject({
        trigger: "scheduled",
        status: "skipped",
        skipReason: "busy",
      });
      // The in-memory libSQL harness has one connection: no overlapping runs.
      await refreshes.wait(results);
      // A retried occurrence reports what it recorded.
      const retried = await refreshes.startAll({
        trigger: "scheduled",
        occurrence,
      });
      expect(retried.map((result) => result.refresh?.id)).toEqual(
        results.map((result) => result.refresh?.id),
      );
      release();
      await refreshes.settled();
      expect(
        (await db.listRefreshes(connectionId, { limit: 10 })).map(
          (refresh) => refresh.status,
        ),
      ).toEqual(["skipped", "completed"]);
      expect(await db.getRefresh(active.refresh!.id)).toMatchObject({
        status: "completed",
      });
      expect(await db.getRefresh(results[1]!.refresh!.id)).toMatchObject({
        trigger: "scheduled",
        status: "completed",
      });
    });

    it("refreshes all connections, reporting why one did not start", async () => {
      const second = `${connectionId}-second`;
      await db.ensureConnection({ id: second, provider: "cal" });
      const sources = {
        [connectionId]: collector(async function* () {
          yield capture("first");
        }),
        [second]: collector(async function* () {
          yield capture("second");
        }),
      };
      const refreshes = service(sources);
      await refreshes.wait([
        await refreshes.start(connectionId, { trigger: "manual" }),
      ]);
      const all = await refreshes.wait(
        await refreshes.startAll({ trigger: "manual" }),
      );
      expect(
        all.map((result) => [
          result.connectionId,
          result.reason,
          result.refresh?.status,
        ]),
      ).toEqual([
        [connectionId, "cooldown", "completed"],
        [second, null, "completed"],
      ]);
      expect(sources[connectionId]!.calls).toBe(1);
    });

    it("blocks refresh after an authentication failure until an operator run", async () => {
      const failing = collector(async function* () {
        yield {
          type: "failure",
          failure: {
            accountKey: null,
            endpoint: "login",
            code: "authentication_failed",
          },
          fatal: true,
        };
      });
      const blocked = service({ [connectionId]: failing });
      const [failed] = await blocked.wait([
        await blocked.start(connectionId, { trigger: "manual" }),
      ]);
      expect(failed?.refresh).toMatchObject({
        status: "failed",
        requiresAttention: true,
      });
      // Move past the cooldown, as a later refresh would be.
      await db.raw("UPDATE refreshes SET finished_at=? WHERE id=?", [
        "2000-01-01T00:00:00.000Z",
        failed!.refresh!.id,
      ]);
      const source = collector(async function* () {
        yield capture("after-block");
      });
      const refreshes = service({ [connectionId]: source });
      expect(
        await refreshes.start(connectionId, { trigger: "manual" }),
      ).toMatchObject({ reason: "requires_attention" });
      expect(source.calls).toBe(0);
      const [retried] = await refreshes.wait([
        await refreshes.start(connectionId, {
          trigger: "manual",
          operator: true,
        }),
      ]);
      expect(retried?.refresh).toMatchObject({
        status: "completed",
        requiresAttention: false,
      });
    });

    it("delivers a signed Events wake-up for the changes a refresh committed", async () => {
      const sent: SignedWebhookInput[] = [];
      const events = createEventService({
        store: db.eventSubscriptions,
        source: db,
        sendSignedWebhook: async (input) => {
          sent.push(input);
          return new Response(null, { status: 204 });
        },
        verifyWebhookCallback: async () => {},
        grantCheck: async () => true,
      });
      const principal = {
        ownerId: "owner",
        clientId: `client-${connectionId}`,
        scopes: ["financial:read"],
      };
      const subscription = await events.subscribe(principal, {
        name: "changes.available",
        arguments: { connectionId },
        delivery: {
          mode: "webhook",
          url: "https://callback.synthetic.invalid/events",
          secret: `whsec_${btoa("s".repeat(32))}`,
        },
      });
      const source = collector(async function* () {
        yield capture("delivered");
      });
      const refreshes = service(
        { [connectionId]: source },
        {
          afterRefresh: async (signal) => {
            await events.deliver({ signal });
          },
        },
      );
      await refreshes.wait([
        await refreshes.start(connectionId, { trigger: "manual" }),
      ]);
      const mine = sent.filter(
        (input) => input.subscriptionId === subscription.id,
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]?.body).toMatchObject({
        name: "changes.available",
        data: { connectionId },
      });
      const stored = (await db.eventSubscriptions.get(
        subscription.id,
      )) as EventSubscription;
      expect(stored.cursor).toBe(await db.latestEventId(connectionId));
      expect(stored.pendingBatch).toBeNull();
    });
  });

  describe("Events subscription storage", () => {
    const now = Date.parse("2040-01-01T00:00:00Z");

    function subscription(id: string): EventSubscription {
      return {
        id,
        ownerId: "owner",
        clientId: "client",
        connectionId,
        url: "https://callback.synthetic.invalid/events",
        secret: `whsec_${btoa("s".repeat(32))}`,
        previousSecret: null,
        rotationUntil: null,
        verifiedUntil: now + 300_000,
        expiresAt: now + 86_400_000,
        status: "active",
        cursor: 0,
        pendingBatch: null,
        attempts: 0,
        nextAttemptAt: now,
        generation: 0,
        reason: null,
      };
    }

    it("accepts only one racing generation and never recreates a missing stale row", async () => {
      const store = db.eventSubscriptions;
      const id = `sub-${connectionId}`;
      const saved = (await store.save(subscription(id), 0))!;
      expect(saved.generation).toBe(1);
      const concurrent = (await peer()).eventSubscriptions;
      const results = await Promise.all([
        store.save({ ...saved, cursor: 1 }, saved.generation),
        concurrent.save({ ...saved, cursor: 2 }, saved.generation),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await store.get(id))?.generation).toBe(2);
      expect(
        await store.save({ ...saved, status: "inactive" }, saved.generation),
      ).toBeUndefined();
      expect(
        await store.save(subscription(`${id}-missing`), 10),
      ).toBeUndefined();
      expect(await store.get(`${id}-missing`)).toBeUndefined();
      expect(await store.save(subscription(id), 0)).toBeUndefined();
    });

    it("lists due subscriptions by persisted expiry, retry schedule and status", async () => {
      const store = db.eventSubscriptions;
      const id = (name: string) => `${name}-${connectionId}`;
      await store.save(subscription(id("due")), 0);
      await store.save(
        { ...subscription(id("later")), nextAttemptAt: now + 60_000 },
        0,
      );
      await store.save({ ...subscription(id("expired")), expiresAt: now }, 0);
      await store.save(
        { ...subscription(id("failed")), status: "failed", attempts: 5 },
        0,
      );
      const due = async (at: number) =>
        (await store.listDue(at, 1000))
          .map((value) => value.id)
          .filter((value) => value.endsWith(connectionId));
      expect(await due(now)).toEqual([id("due")]);
      expect(await due(now + 60_000)).toEqual([id("due"), id("later")]);
    });
  });
});

describe.each(backends)("collection lease on %s", (backend) => {
  let db: Harness;
  let peers: Peer[];
  let connectionId: string;

  beforeEach(async () => {
    db = await open(backend);
    peers = [];
    connectionId = `lease-${randomUUID()}`;
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(async () => {
    await Promise.all(peers.map((peer) => peer.close()));
    await db.close();
  });

  async function peer() {
    const opened = await db.peer();
    peers.push(opened);
    return opened;
  }

  it("takes over a crashed holder's lease once it expires", async () => {
    const other = await peer();
    // A holder that crashed: its lease is never renewed or released.
    const now =
      backend === "postgres"
        ? "(extract(epoch from clock_timestamp())*1000)::bigint"
        : "cast((julianday('now')-2440587.5)*86400000 as integer)";
    await db.raw(
      `INSERT INTO collection_leases(connection_id,holder,expires_at) VALUES(?,'synthetic-crashed',${now}+400)`,
      [connectionId],
    );
    expect(
      await other.withCollectionLock(connectionId, async () => "early"),
    ).toEqual({ acquired: false });
    await sleep(600);
    expect(
      await other.withCollectionLock(connectionId, async () => "late"),
    ).toEqual({ acquired: true, result: "late" });
  });

  it("renews its lease while a collection outlasts it", async () => {
    const other = await peer();
    let attempt: unknown;
    const held = await db.withCollectionLock(
      connectionId,
      async () => {
        await sleep(1200);
        attempt = await other.withCollectionLock(
          connectionId,
          async () => "stolen",
        );
        return "kept";
      },
      { leaseMs: 400 },
    );
    expect(held).toEqual({ acquired: true, result: "kept" });
    expect(attempt).toEqual({ acquired: false });
  });

  it("leaves evidence staged before a lost lease for the next holder to apply", async () => {
    const runId = `${connectionId}:staged-before-loss`;
    const failingOnce = {
      ...synthetic,
      extract: () => {
        throw new Error("synthetic interruption after staging");
      },
    };
    const lost = await db.withCollectionLock(
      connectionId,
      async (store, signal) => {
        await expect(
          store.ingestRun(
            {
              runId,
              connectionId,
              responses: [
                {
                  accountKey: "account",
                  endpoint: "synthetic:cal/recent",
                  capturedAt: "2040-08-01T00:00:00Z",
                  responseText: JSON.stringify([row("staged-native")]),
                },
              ],
            },
            failingOnce,
          ),
        ).rejects.toThrow("synthetic interruption");
        // Another process took the lease, as after a missed renewal.
        await db.raw(
          "UPDATE collection_leases SET holder='synthetic-successor', expires_at=expires_at+600000 WHERE connection_id=?",
          [connectionId],
        );
        // Renewal has not run, so only the write fence can refuse the apply.
        expect(signal.aborted).toBe(false);
        await expect(store.applyRun(runId, synthetic)).rejects.toThrow();
        expect(signal.aborted).toBe(false);
        return "lost";
      },
      // Renewal every 150 s cannot notice the successor during the test.
      { leaseMs: 600_000 },
    );
    expect(lost).toEqual({ acquired: true, result: "lost" });
    expect(
      (await db.listTransactionPage({ connectionId })).transactions,
    ).toEqual([]);
    expect(
      await db.raw("SELECT applied_at FROM sync_runs WHERE id = ?", [runId]),
    ).toEqual([{ applied_at: null }]);
    await db.raw("DELETE FROM collection_leases WHERE connection_id=?", [
      connectionId,
    ]);
    const recovered = await db.withCollectionLock(connectionId, (store) =>
      store.recoverPendingRuns(synthetic),
    );
    expect(recovered).toEqual({
      acquired: true,
      result: [expect.objectContaining({ replayed: false, created: 1 })],
    });
    expect(
      await sourceKeysOf(
        db,
        (await db.listTransactionPage({ connectionId })).transactions,
      ),
    ).toEqual([expect.stringContaining("staged-native")]);
  });

  it("aborts a holder whose lease passed on and rejects its later writes", async () => {
    const result = await db.withCollectionLock(
      connectionId,
      async (store, signal) => {
        await store.updateConfig(connectionId, (config) => ({
          ...config,
          before: true,
        }));
        // Another process took the lease, as after a missed renewal.
        await db.raw(
          "UPDATE collection_leases SET holder='synthetic-successor', expires_at=expires_at+600000 WHERE connection_id=?",
          [connectionId],
        );
        await expect(
          store.updateConfig(connectionId, (config) => ({
            ...config,
            stale: true,
          })),
        ).rejects.toThrow();
        await expect(
          store.recordCardDiscovery(connectionId, {
            observedAt: "2040-01-01T00:00:00Z",
            cards: [{ cardKey: "stale-card", last4: "0001" }],
          }),
        ).rejects.toThrow();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
          }
          signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return signal.aborted;
      },
      // Long enough that a slow database cannot expire the holder's own first
      // write; renewal still notices the successor within a quarter of it.
      { leaseMs: 2_000 },
    );
    expect(result).toEqual({ acquired: true, result: true });
    const config = (await db.getStoredConnection(connectionId))?.config;
    expect(config).toMatchObject({ before: true });
    expect(config?.stale).toBeUndefined();
    expect((await db.listCards({ connectionId })).cards).toEqual([]);
    // The successor's lease is untouched by the old holder's release.
    expect(
      await db.withCollectionLock(connectionId, async () => "blocked"),
    ).toEqual({ acquired: false });
  });

  // D1 sends the fence inside its write batch, so only the CHECK guards it.
  it.skipIf(backend === "d1-local")(
    "rejects a holder's writes once its lease row is gone",
    async () => {
      const result = await db.withCollectionLock(
        connectionId,
        async (store) => {
          await db.raw("DELETE FROM collection_leases WHERE connection_id=?", [
            connectionId,
          ]);
          await expect(
            store.updateConfig(connectionId, (config) => ({
              ...config,
              orphaned: true,
            })),
          ).rejects.toThrow();
          return "checked";
        },
      );
      expect(result).toEqual({ acquired: true, result: "checked" });
      expect(
        (await db.getStoredConnection(connectionId))?.config.orphaned,
      ).toBeUndefined();
    },
  );
});
