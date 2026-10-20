import { readdirSync, readFileSync } from "node:fs";

import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "../../src/domain/errors.js";
import { emptyDetails } from "../../src/domain/model.js";
import { sqliteMigrations } from "../../src/storage/sqlite/migration.js";
import {
  d1Enabled,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

const connectionId = "synthetic-d1";
let db: Harness;
let pending: Array<() => Promise<unknown>>;
let openD1Database: (typeof import("../../src/storage/d1.js"))["openD1Database"];

/** A second store whose next write batches run only after a competing commit. */
function staleStore() {
  if (db.driver.kind !== "d1") {
    throw new Error("D1 harness required");
  }
  const binding = db.driver.binding;
  return openD1Database({
    ...binding,
    batch: async (statements: Parameters<D1Database["batch"]>[0]) => {
      await pending.shift()?.();
      return binding.batch(statements);
    },
  } as D1Database);
}

/** Records SQL that a store executes outside a batch. */
function directWriteStore(direct: string[]) {
  if (db.driver.kind !== "d1") {
    throw new Error("D1 harness required");
  }
  const binding = db.driver.binding;
  const observe = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }
        if (key === "bind") {
          return (...args: unknown[]) =>
            observe(value.apply(target, args) as D1PreparedStatement, query);
        }
        if (["all", "first", "raw", "run"].includes(String(key))) {
          return (...args: unknown[]) => {
            if (!/^\s*select\b/i.test(query)) {
              direct.push(query);
            }
            return value.apply(target, args) as unknown;
          };
        }
        return value.bind(target) as unknown;
      },
    });
  return openD1Database({
    ...binding,
    prepare: (query: string) => observe(binding.prepare(query), query),
  } as D1Database);
}

function capture(store: Pick<Harness, "ingestRun">, runId: string) {
  return store.ingestRun(
    {
      connectionId,
      runId,
      responses: [
        {
          accountKey: "account",
          endpoint: "synthetic:d1",
          capturedAt: "2040-08-01T00:00:00Z",
          responseText: JSON.stringify(
            Array.from({ length: 40 }, (_, index) =>
              row(`row-${index}`, { cardKey: `card-${index}` }),
            ),
          ),
        },
      ],
    },
    synthetic,
  );
}

it("keeps each D1 migration a copy of the SQLite one, the initial one with the connection revision", () => {
  const directory = new URL("../../migrations/d1/", import.meta.url);
  expect(readdirSync(directory).sort()).toEqual(
    sqliteMigrations.map(({ name }) => `${name}.sql`),
  );
  for (const { version, name, sql } of sqliteMigrations) {
    const copy = readFileSync(new URL(`${name}.sql`, directory), "utf8");
    expect(
      version === 1
        ? copy.replace(
            ",\n  revision INTEGER NOT NULL DEFAULT 0 CONSTRAINT connection_revision CHECK (revision BETWEEN 0 AND 9007199254740991)",
            "",
          )
        : copy,
    ).toBe(sql);
  }
});

// Local D1 runs in workerd through Miniflare; enable it with FONDS_TEST_D1=1.
describe.skipIf(!d1Enabled)("guarded D1 write batches", () => {
  beforeEach(async () => {
    ({ openD1Database } = await import("../../src/storage/d1.js"));
    db = await open("d1-local");
    pending = [];
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });

  afterEach(async () => {
    await db?.close();
  });

  it("rejects a stale annotation batch instead of overwriting a newer edit", async () => {
    await capture(db, "run-1");
    const [transaction] = (await db.listTransactionPage({ connectionId }))
      .transactions;
    pending.push(() =>
      db.editAnnotation({
        transactionId: transaction!.id,
        expectedVersion: 0,
        notes: "newer",
      }),
    );
    const stale = staleStore();
    // Both edits read version 0; only the guard can tell the second batch is stale.
    await expect(
      stale.editAnnotation({
        transactionId: transaction!.id,
        expectedVersion: 0,
        notes: "stale",
      }),
    ).rejects.toThrow(ConflictError);
    expect(
      (await db.getTransaction(transaction!.id))?.annotation,
    ).toMatchObject({
      version: 1,
      data: { notes: "newer" },
    });
    expect(
      (await db.listEvents({ connectionId })).filter(
        (change) => change.type === "annotation.updated",
      ),
    ).toHaveLength(1);
    // A retry rereads current state, so the planner reports the real version conflict.
    await expect(
      stale.editAnnotation({
        transactionId: transaction!.id,
        expectedVersion: 0,
        notes: "stale",
      }),
    ).rejects.toThrow(ConflictError);
    await stale.editAnnotation({
      transactionId: transaction!.id,
      expectedVersion: 1,
      notes: "retried",
    });
    expect(
      (await db.getTransaction(transaction!.id))?.annotation?.data,
    ).toMatchObject({ notes: "retried" });
  });

  it("rejects a stale multi-statement run without applying any of it", async () => {
    const stale = staleStore();
    // Let evidence commit, then race the application batch with a config write.
    pending.push(
      async () => {},
      () =>
        db.updateConfig(connectionId, (config) => ({
          ...config,
          edited: true,
        })),
    );
    await expect(capture(stale, "run-1")).rejects.toThrow(ConflictError);
    expect(await db.listTransactionPage({ connectionId })).toMatchObject({
      transactions: [],
    });
    expect(await db.raw("SELECT * FROM cards")).toEqual([]);
    expect(await db.listEvents({ connectionId })).toEqual([]);
    expect(
      await db.raw("SELECT applied_at FROM sync_runs WHERE id = ?", ["run-1"]),
    ).toEqual([{ applied_at: null }]);
    expect((await db.getStoredConnection(connectionId))?.config).toMatchObject({
      edited: true,
    });
    expect(await stale.applyRun("run-1", synthetic)).toMatchObject({
      replayed: false,
      created: 40,
    });
  });

  it("rolls back the guard and earlier inserts when a late statement fails", async () => {
    await db.raw(
      "CREATE TRIGGER synthetic_fail BEFORE INSERT ON events WHEN NEW.run_id = 'run-1' BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END",
    );
    // The guard, card stubs and transaction inserts precede the failing change insert.
    const failure = await capture(db, "run-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ConflictError);
    expect(
      await db.raw("SELECT revision FROM connections WHERE id = ?", [
        connectionId,
      ]),
    ).toEqual([{ revision: 1 }]);
    expect(await db.raw("SELECT count(*) AS count FROM transactions")).toEqual([
      { count: 0 },
    ]);
    expect(await db.raw("SELECT * FROM cards")).toEqual([]);
    expect(await db.listEvents({ connectionId })).toEqual([]);
    expect(
      await db.raw("SELECT applied_at FROM sync_runs WHERE id = ?", ["run-1"]),
    ).toEqual([{ applied_at: null }]);
    await db.raw("DROP TRIGGER synthetic_fail");
    expect(await db.applyRun("run-1", synthetic)).toMatchObject({
      created: 40,
    });
    expect(await db.raw("SELECT count(*) AS count FROM cards")).toEqual([
      { count: 40 },
    ]);
  });

  it("sends every write inside a store transaction through the guarded batch", async () => {
    const direct: string[] = [];
    const store = directWriteStore(direct);
    const pendingRow = row("pending", {
      status: "pending",
      amountBasis: "authorization",
      details: { ...emptyDetails(), issues: ["possible_pending_posted_match"] },
    });
    const ingest = (runId: string) =>
      store.ingestRun(
        {
          connectionId,
          runId,
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:d1",
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: JSON.stringify([
                pendingRow,
                row("posted"),
                row("third"),
              ]),
            },
          ],
        },
        synthetic,
      );
    await ingest("run-1");
    await ingest("run-1");
    const rows = (await store.listTransactionPage({ connectionId }))
      .transactions;
    const bySource = (sourceKey: string) =>
      rows.find((candidate) => candidate.sourceKey === sourceKey)!;
    await store.editAnnotation({
      transactionId: bySource("third").id,
      expectedVersion: 0,
      notes: "edited",
    });
    const annotated = (await store.listEvents({ connectionId })).find(
      (change) => change.type === "annotation.updated",
    )!;
    await store.undoAnnotation({ eventId: annotated.id, expectedVersion: 1 });
    await store.linkPendingTransaction({
      pendingId: bySource("pending").id,
      postedId: bySource("posted").id,
      expectedPendingVersion: bySource("pending").version,
      expectedPostedVersion: bySource("posted").version,
      expectedPendingAnnotationVersion: 0,
      expectedPostedAnnotationVersion: 0,
      reason: "synthetic confirmation",
    });
    const third = (await store.getTransaction(bySource("third").id))!;
    await store.confirmRemoval({
      transactionId: third.id,
      expectedVersion: third.version,
      reason: "synthetic removal",
    });
    await store.acknowledgeCursor(connectionId, "consumer", 0, 1);
    await store.ensureConnection({ id: "synthetic-other", provider: "cal" });
    // Creating a connection is one atomic statement outside any store transaction.
    expect(direct).toEqual([
      expect.stringMatching(/^insert into "connections"/i),
    ]);
  });

  it("advances the connection revision once per committed batch", async () => {
    const revision = async () =>
      (
        await db.raw("SELECT revision FROM connections WHERE id = ?", [
          connectionId,
        ])
      )[0]?.revision;
    expect(await revision()).toBe(0);
    await capture(db, "run-1");
    expect(await revision()).toBe(2);
    await capture(db, "run-1");
    // A replay's evidence batch inserts nothing but still advances the revision.
    expect(await revision()).toBe(3);
  });
});
