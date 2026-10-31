import { EventEmitter } from "node:events";

import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionStore } from "../../src/application/collection.js";
import type { FinancialStore } from "../../src/application/financial-store.js";
import {
  createApplication,
  operationDefinitions,
  type OperationLog,
  type OperationName,
} from "../../src/application/operations.js";
import {
  createSyncDiagnosticReport,
  type SyncDiagnostic,
} from "../../src/application/sync-diagnostics.js";
import {
  bytesReadSince,
  databaseByteMeter,
  initializePostgresDatabase,
  openPostgresDatabase,
} from "../../src/storage/postgres/store.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import { disposableDatabase } from "../helpers/postgres-database.js";
import { row, synthetic } from "../helpers/storage-harness.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;

type Ingesting = Pick<CollectionStore, "ingestRun">;

async function ingest(
  store: Ingesting,
  connectionId: string,
  keys: string[],
  capturedAt: string,
) {
  const report = createSyncDiagnosticReport();
  const result = await store.ingestRun(
    {
      runId: crypto.randomUUID(),
      connectionId,
      responses: [
        {
          accountKey: "account",
          endpoint: "synthetic",
          capturedAt,
          responseText: JSON.stringify(keys.map((key) => row(key))),
        },
      ],
    },
    synthetic,
    report.log,
  );
  const completed = report
    .report()
    .entries.find(
      (entry: SyncDiagnostic) =>
        entry.stage === "reconciliation" && entry.outcome === "completed",
    );
  return { result, counts: completed?.counts };
}

const keys = (count: number) =>
  Array.from({ length: count }, (_, index) => `key-${index}`);

describe("database byte readings", () => {
  const transactionOn = (stream: object) => ({
    session: { client: { connection: { stream } } },
  });

  it("reads the delta of the connection socket's received bytes", () => {
    const socket = { bytesRead: 1_000 };
    const reading = bytesReadSince(transactionOn(socket));
    expect(reading()).toBe(0);
    socket.bytesRead = 1_640;
    expect(reading()).toBe(640);
  });

  it("is unknown, never thrown, when the driver exposes no socket count", () => {
    expect(bytesReadSince({})()).toBeUndefined();
    expect(bytesReadSince(null)()).toBeUndefined();
    expect(
      bytesReadSince(transactionOn({ bytesRead: "1000" }))(),
    ).toBeUndefined();
    const failing = {
      get bytesRead(): number {
        throw new Error("synthetic socket failure");
      },
    };
    expect(bytesReadSince(transactionOn(failing))()).toBeUndefined();
    const socket = { bytesRead: 10 as unknown };
    const reading = bytesReadSince(transactionOn(socket));
    socket.bytesRead = undefined;
    expect(reading()).toBeUndefined();
  });

  /** A fake pooled client whose socket the test advances by hand. */
  const client = (bytesRead: number) => ({ bytesRead });
  const transaction = (socket: { bytesRead: number }) => transactionOn(socket);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("attributes concurrent operations' transactions to their own meter", async () => {
    const meter = databaseByteMeter();
    const a: number[] = [];
    const b: number[] = [];
    const socketA = client(5_000);
    const socketB = client(9_000);
    await Promise.all([
      meter.run(
        () =>
          meter.measure(transaction(socketA), async () => {
            await tick();
            socketA.bytesRead += 100;
            await tick();
            socketA.bytesRead += 20;
          }),
        (bytes) => a.push(bytes),
      ),
      meter.run(
        () =>
          meter.measure(transaction(socketB), async () => {
            socketB.bytesRead += 250;
            await tick();
            await tick();
            socketB.bytesRead += 3;
          }),
        (bytes) => b.push(bytes),
      ),
    ]);
    expect(a).toEqual([120]);
    expect(b).toEqual([253]);
  });

  it("reports parallel transactions in one operation once each", async () => {
    const meter = databaseByteMeter();
    const observed: number[] = [];
    const first = client(0);
    const second = client(70);
    await meter.run(
      () =>
        Promise.all([
          meter.measure(transaction(first), async () => {
            await tick();
            first.bytesRead += 40;
          }),
          meter.measure(transaction(second), async () => {
            second.bytesRead += 15;
            await tick();
          }),
        ]),
      (bytes) => observed.push(bytes),
    );
    expect(observed.sort((x, y) => x - y)).toEqual([15, 40]);
  });

  it("carries no bytes over when a pooled client serves the next transaction", async () => {
    const meter = databaseByteMeter();
    const observed: number[] = [];
    const reused = client(1_000);
    await meter.run(
      async () => {
        await meter.measure(transaction(reused), async () => {
          reused.bytesRead += 100;
        });
        // Bytes between transactions, such as a COMMIT acknowledgement.
        reused.bytesRead += 17;
        await meter.measure(transaction(reused), async () => {
          reused.bytesRead += 30;
        });
      },
      (bytes) => observed.push(bytes),
    );
    expect(observed).toEqual([100, 30]);
  });

  it("reports a failed transaction's bytes once and keeps its error", async () => {
    const meter = databaseByteMeter();
    const observed: number[] = [];
    const socket = client(200);
    const failure = new Error("synthetic statement failure");
    await expect(
      meter.run(
        () =>
          meter.measure(transaction(socket), async () => {
            socket.bytesRead += 40;
            throw failure;
          }),
        (bytes) => observed.push(bytes),
      ),
    ).rejects.toBe(failure);
    expect(observed).toEqual([40]);
  });

  it("reads a transaction's bytes so far and reports nothing without a meter", async () => {
    const meter = databaseByteMeter();
    const socket = client(10);
    const tx = transaction(socket);
    const midway = await meter.measure(tx, async () => {
      socket.bytesRead += 64;
      return meter.bytesRead(tx);
    });
    expect(midway).toBe(64);
    expect(meter.bytesRead({})).toBeUndefined();
    let calls = 0;
    const result = await meter.run(
      () => meter.measure(transaction(client(0)), async () => "result"),
      () => {
        calls += 1;
        throw new Error("synthetic observer failure");
      },
    );
    expect(result).toBe("result");
    expect(calls).toBe(1);
  });

  /**
   * A pool that never connects: each checked-out client answers every
   * statement with no rows, its socket receiving a fixed byte count. Pooled
   * `query` fails, so a statement that escapes metering is visible.
   */
  function fakePool(
    bytesPerStatement: number,
    script: (statement: string) => {
      bytes?: number;
      delayMs?: number;
      error?: Error;
    } = () => ({}),
  ) {
    const pool = new Pool();
    const log: string[] = [];
    const received: string[][] = [];
    let sent = 0;
    let failNext: Error | undefined;
    const checkout = async () => {
      const socket = { bytesRead: 7_000 };
      const statements: string[] = [];
      received.push(statements);
      return Object.assign(new EventEmitter(), {
        connection: { stream: socket },
        async query(config: string | { text: string }) {
          const text = typeof config === "string" ? config : config.text;
          statements.push(text);
          const { bytes = bytesPerStatement, delayMs, error } = script(text);
          await (delayMs === undefined
            ? tick()
            : new Promise((resolve) => setTimeout(resolve, delayMs)));
          socket.bytesRead += bytes;
          sent += bytes;
          const failure = error ?? failNext;
          failNext = undefined;
          if (failure) {
            throw failure;
          }
          return { rows: [], rowCount: 0, fields: [] };
        },
        release(error?: Error | boolean) {
          log.push(error ? "discarded" : "released");
        },
      });
    };
    Object.assign(pool, {
      connect: checkout,
      query: async () => {
        log.push("unmetered");
        return { rows: [], rowCount: 0, fields: [] };
      },
    });
    return {
      pool,
      log,
      received,
      takeSent: () => {
        const bytes = sent;
        sent = 0;
        return bytes;
      },
      failNext: (error: Error) => {
        failNext = error;
      },
    };
  }

  it("meters a statement outside a transaction on its own client, before releasing it", async () => {
    const fake = fakePool(300);
    const meter = databaseByteMeter();
    const pool = meter.pool(fake.pool);
    await meter.run(
      () => pool.query("SELECT 1"),
      (bytes) => fake.log.push(`observed ${bytes}`),
    );
    expect(fake.log).toEqual(["observed 300", "released"]);
    await pool.query("SELECT 2");
    expect(fake.log.at(-1)).toBe("unmetered");
    expect(fake.received).toEqual([["SELECT 1"]]);
  });

  it("meters a lazy thenable that issues its statement only when awaited", async () => {
    // Drizzle queries are thenables that start on `then`, after `run` returns them.
    const fake = fakePool(250);
    const meter = databaseByteMeter();
    const pool = meter.pool(fake.pool);
    const lazy = {
      then: (
        resolve: (value: unknown) => void,
        reject: (error: unknown) => void,
      ) => pool.query("SELECT 1").then(resolve, reject),
    };
    await meter.run(
      () => lazy as unknown as Promise<unknown>,
      (bytes) => fake.log.push(`observed ${bytes}`),
    );
    expect(fake.log).toEqual(["observed 250", "released"]);
  });

  it("keeps overlapping operations' pooled statements on their own meters", async () => {
    const meter = databaseByteMeter();
    const small = meter.pool(fakePool(20).pool);
    const large = meter.pool(fakePool(900).pool);
    const a: number[] = [];
    const b: number[] = [];
    await Promise.all([
      meter.run(
        () => Promise.all([small.query("A1"), large.query("A2")]),
        (bytes) => a.push(bytes),
      ),
      meter.run(
        () => large.query("B1"),
        (bytes) => b.push(bytes),
      ),
    ]);
    expect(a.sort((x, y) => x - y)).toEqual([20, 900]);
    expect(b).toEqual([900]);
  });

  it("reports a failed pooled statement once, discards its client and keeps its error", async () => {
    const fake = fakePool(55);
    const meter = databaseByteMeter();
    const pool = meter.pool(fake.pool);
    const failure = new Error("synthetic statement failure");
    fake.failNext(failure);
    await expect(
      meter.run(
        () => pool.query("SELECT 1"),
        (bytes) => fake.log.push(`observed ${bytes}`),
      ),
    ).rejects.toBe(failure);
    expect(fake.log).toEqual(["observed 55", "discarded"]);
  });

  it("logs a failed operation once every statement it issued has reported", async () => {
    const failure = new Error("synthetic statement failure");
    const fake = fakePool(0, (statement) =>
      statement === "FAILING"
        ? { bytes: 150, error: failure }
        : { bytes: 900, delayMs: 20 },
    );
    const meter = databaseByteMeter();
    const pool = meter.pool(fake.pool);
    const entries: OperationLog[] = [];
    // Two connections whose reads run in parallel: one fails at once and the
    // other is still receiving rows when the operation's promise rejects.
    const store = {
      backend: "postgres",
      listConnections: async () => {
        await Promise.all([pool.query("SLOW"), pool.query("FAILING")]);
        return [];
      },
    } as unknown as FinancialStore;
    const listConnections = createApplication(store, {
      onOperation: (entry) => {
        entries.push(entry);
      },
      meterDbBytes: meter.run,
    }).operations.find(({ name }) => name === "list_connections")!;
    await expect(listConnections.execute({})).rejects.toBe(failure);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      operation: "list_connections",
      dbBytesRead: 1_050,
    });
    expect(fake.log.sort()).toEqual(["discarded", "released"]);
  });

  it("waits for a store transaction still starting beside a failed statement", async () => {
    const failure = new Error("synthetic statement failure");
    const fake = fakePool(0, (statement) =>
      statement === "FAILING"
        ? { bytes: 40, error: failure }
        : /^(begin|commit|rollback)/.test(statement)
          ? { bytes: 5 }
          : { bytes: 600, delayMs: 20 },
    );
    const db = openPostgresDatabase(fake.pool);
    const observed: number[] = [];
    await expect(
      db.meterDbBytes(
        () =>
          Promise.all([
            // Its connection lock finds no row, after its read is received.
            db.updateConfig("synthetic", (config) => config),
            db.pool.query("FAILING"),
          ]),
        (bytes) => observed.push(bytes),
      ),
    ).rejects.toBe(failure);
    // BEGIN and ROLLBACK acknowledgements fall outside the measured body.
    expect(observed.sort((x, y) => x - y)).toEqual([40, 600]);
    expect(fake.received.flat()).toContain("rollback");
  });

  it("stays a pool to Drizzle, which keeps a transaction on one client", async () => {
    const fake = fakePool(10);
    const db = openPostgresDatabase(fake.pool);
    expect(db.pool).toBeInstanceOf(Pool);
    await db.meterDbBytes(
      () =>
        db.orm.transaction(async (tx) => {
          await tx.execute(sql`SELECT 1`);
        }),
      () => undefined,
    );
    expect(fake.received).toEqual([["begin", "SELECT 1", "commit"]]);
    expect(fake.log).toEqual(["released"]);
  });

  it("logs every read operation's bytes, statements outside transactions included", async () => {
    const fake = fakePool(100);
    const db = openPostgresDatabase(fake.pool);
    const entries: OperationLog[] = [];
    const application = createApplication(db, {
      onOperation: (entry) => {
        entries.push(entry);
      },
      meterDbBytes: db.meterDbBytes,
    });
    const scope = { connectionId: "synthetic" };
    const inputs: Partial<Record<OperationName, object[]>> = {
      list_connections: [{}],
      get_connection: [scope],
      get_connection_coverage: [scope],
      list_cards: [scope],
      get_card: [{ cardId: "synthetic-card" }],
      list_accounts: [scope],
      get_account: [{ accountId: "synthetic-account" }],
      list_transactions: [{}, { view: "summary" }],
      get_transaction: [
        { transactionId: "synthetic-transaction" },
        { transactionId: "synthetic-transaction", detail: false },
      ],
      get_transactions: [
        { ids: ["synthetic-transaction"] },
        { ids: ["synthetic-transaction"], view: "summary" },
        { ids: ["synthetic-transaction"], view: "detail" },
      ],
      get_transaction_totals: [{}, { groupBy: "month" }],
      list_events: [scope],
      list_sync_runs: [scope],
      get_refresh: [{ refreshId: "synthetic-refresh" }],
      list_refreshes: [scope],
    };
    const reads = operationDefinitions
      .filter((definition) => definition.access === "read")
      .map((definition) => definition.name);
    expect(Object.keys(inputs).sort()).toEqual([...reads].sort());
    for (const operation of application.operations) {
      for (const input of inputs[operation.name as OperationName] ?? []) {
        // Absent rows end some reads as not found; their bytes still count.
        await operation.execute(input).catch(() => undefined);
        const sent = fake.takeSent();
        expect(sent, operation.name).toBeGreaterThan(0);
        expect(entries.at(-1)).toMatchObject({
          operation: operation.name,
          dbBytesRead: sent,
        });
      }
    }
    expect(fake.log).not.toContain("unmetered");
  });

  it("reports no database bytes on SQLite, which is not network-metered", async () => {
    const db = await openDatabase(":memory:");
    try {
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
      await ingest(db, "synthetic", ["a", "b"], "2040-07-02T00:00:00Z");
      const { counts } = await ingest(
        db,
        "synthetic",
        ["a", "b", "c"],
        "2040-07-03T00:00:00Z",
      );
      expect(counts?.ledgerRows).toBe(2);
      expect(counts).not.toHaveProperty("dbBytesRead");
    } finally {
      await db.close();
    }
  });
});

describe.skipIf(!postgresUrl)("PostgreSQL database byte readings", () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let db: ReturnType<typeof openPostgresDatabase>;
  beforeEach(async () => {
    database = await disposableDatabase(postgresUrl!, "fonds_bytes");
    db = openPostgresDatabase({
      connectionString: database.url,
      options: database.options,
      max: 2,
    });
    await initializePostgresDatabase(db.pool);
  });
  afterEach(async () => {
    await db?.close();
    await database?.drop();
  });

  it("reports the bytes a reconciliation read, growing with the ledger it loaded", async () => {
    const reconciled = async (connectionId: string, count: number) => {
      await db.ensureConnection({ id: connectionId, provider: "cal" });
      await ingest(db, connectionId, keys(count), "2040-07-02T00:00:00Z");
      const { counts } = await ingest(
        db,
        connectionId,
        keys(count),
        "2040-07-03T00:00:00Z",
      );
      expect(counts?.ledgerRows).toBe(count);
      return counts?.dbBytesRead;
    };
    const small = await reconciled("synthetic-small", 20);
    const large = await reconciled("synthetic-large", 200);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small!);
  });

  it("tells a meter each transaction's bytes and survives a failing observer", async () => {
    await db.ensureConnection({ id: "synthetic", provider: "cal" });
    const observed: number[] = [];
    await db.meterDbBytes(
      () => ingest(db, "synthetic", ["a", "b"], "2040-07-02T00:00:00Z"),
      (bytesRead) => observed.push(bytesRead),
    );
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((bytes) => bytes > 0)).toBe(true);

    const { result } = await db.meterDbBytes(
      () => ingest(db, "synthetic", ["a", "b", "c"], "2040-07-03T00:00:00Z"),
      () => {
        throw new Error("synthetic observer failure");
      },
    );
    expect(result).toMatchObject({ status: "completed", created: 1 });
    expect(
      (await db.listTransactionPage({ connectionId: "synthetic" }))
        .transactions,
    ).toHaveLength(3);
  });

  /** A transaction whose body reads one row of `length` ASCII bytes. */
  function reader(
    store: ReturnType<typeof openPostgresDatabase>,
    meter: ReturnType<typeof databaseByteMeter>,
  ) {
    return (length: number, before?: () => Promise<void>, fail = false) =>
      store.orm.transaction((tx) =>
        meter.measure(tx, async (tx) => {
          await before?.();
          await tx.execute(sql`SELECT repeat('x', ${length}::int) AS payload`);
          if (fail) {
            throw new Error("synthetic statement failure");
          }
        }),
      );
  }

  /** Resolves once every party has arrived, so their transactions overlap. */
  function barrier(parties: number) {
    let arrived = 0;
    let release!: () => void;
    const all = new Promise<void>((resolve) => (release = resolve));
    return async () => {
      arrived += 1;
      if (arrived === parties) {
        release();
      }
      await all;
    };
  }

  // A one-row result adds its row description, row header, command tag and
  // ready message to the payload: tens of bytes, well under this margin.
  const within = (bytes: number | undefined, payload: number) => {
    expect(bytes).toBeGreaterThanOrEqual(payload);
    expect(bytes).toBeLessThan(payload + 512);
  };

  it("keeps overlapping operations' bytes on their own meters, once each", async () => {
    const meter = databaseByteMeter();
    const read = reader(db, meter);
    const meet = barrier(2);
    const a: number[] = [];
    const b: number[] = [];
    await Promise.all([
      meter.run(
        () => read(20_000, meet),
        (bytes) => a.push(bytes),
      ),
      meter.run(
        () => read(100, meet),
        (bytes) => b.push(bytes),
      ),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    within(a[0], 20_000);
    within(b[0], 100);
  });

  it("reports overlapping transactions within one operation once each", async () => {
    const meter = databaseByteMeter();
    const read = reader(db, meter);
    const meet = barrier(2);
    const observed: number[] = [];
    await meter.run(
      () => Promise.all([read(3_000, meet), read(7_000, meet)]),
      (bytes) => observed.push(bytes),
    );
    observed.sort((x, y) => x - y);
    expect(observed).toHaveLength(2);
    within(observed[0], 3_000);
    within(observed[1], 7_000);
  });

  it("starts each transaction on a reused pooled client from zero", async () => {
    const single = openPostgresDatabase({
      connectionString: database.url,
      options: database.options,
      max: 1,
    });
    try {
      const meter = databaseByteMeter();
      const read = reader(single, meter);
      const observed: number[] = [];
      await meter.run(
        async () => {
          await read(5_000);
          await read(100);
        },
        (bytes) => observed.push(bytes),
      );
      expect(single.pool.totalCount).toBe(1);
      expect(observed).toHaveLength(2);
      within(observed[0], 5_000);
      within(observed[1], 100);
    } finally {
      await single.close();
    }
  });

  it("meters overlapping statements outside transactions on their own operations", async () => {
    const a: number[] = [];
    const b: number[] = [];
    const select = (length: number) =>
      db.orm.execute(sql`SELECT repeat('x', ${length}::int) AS payload`);
    await Promise.all([
      db.meterDbBytes(
        () => select(20_000),
        (bytes) => a.push(bytes),
      ),
      db.meterDbBytes(
        () => select(100),
        (bytes) => b.push(bytes),
      ),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    within(a[0], 20_000);
    within(b[0], 100);
  });

  it("reports a rolled-back transaction's bytes once", async () => {
    const meter = databaseByteMeter();
    const observed: number[] = [];
    await expect(
      meter.run(
        () => reader(db, meter)(2_000, undefined, true),
        (bytes) => observed.push(bytes),
      ),
    ).rejects.toThrow("synthetic statement failure");
    expect(observed).toHaveLength(1);
    within(observed[0], 2_000);
  });

  it("logs each operation's own bytes, reads outside transactions included", async () => {
    await db.ensureConnection({ id: "synthetic", provider: "cal" });
    await ingest(db, "synthetic", ["a", "b", "c"], "2040-07-02T00:00:00Z");
    const entries: OperationLog[] = [];
    const operations = new Map(
      createApplication(db, {
        onOperation: (entry) => {
          entries.push(entry);
        },
        meterDbBytes: db.meterDbBytes,
      }).operations.map((operation) => [operation.name, operation]),
    );
    const page = (await operations
      .get("list_transactions")!
      .execute({ connectionId: "synthetic" })) as { data: { id: string }[] };
    expect(page.data).toHaveLength(3);
    const annotate = (transactionId: string) =>
      operations.get("update_annotation")!.execute({
        transactionId,
        expectedVersion: 0,
        notes: "Synthetic note",
      });
    await annotate(page.data[0]!.id);
    await Promise.all([annotate(page.data[1]!.id), annotate(page.data[2]!.id)]);
    expect(entries.map(({ operation }) => operation)).toEqual([
      "list_transactions",
      "update_annotation",
      "update_annotation",
      "update_annotation",
    ]);
    expect(entries[0]!.dbBytesRead).toBeGreaterThan(0);
    // The same edit of a like row reads about the same; a concurrent call's
    // bytes counted twice or on the wrong call would double or vanish.
    const alone = entries[1]!.dbBytesRead!;
    expect(alone).toBeGreaterThan(0);
    for (const entry of entries.slice(2)) {
      expect(Math.abs(entry.dbBytesRead! - alone)).toBeLessThan(alone / 4);
    }
  });
});
