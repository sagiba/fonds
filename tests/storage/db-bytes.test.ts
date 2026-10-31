import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionStore } from "../../src/application/collection.js";
import {
  createApplication,
  type OperationLog,
} from "../../src/application/operations.js";
import {
  createSyncDiagnosticReport,
  type SyncDiagnostic,
} from "../../src/application/sync-diagnostics.js";
import {
  bytesReadSince,
  initializePostgresDatabase,
  openPostgresDatabase,
  transactionByteMeter,
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
    const meter = transactionByteMeter();
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
    const meter = transactionByteMeter();
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
    const meter = transactionByteMeter();
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
    const meter = transactionByteMeter();
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
    const meter = transactionByteMeter();
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
    meter: ReturnType<typeof transactionByteMeter>,
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
    const meter = transactionByteMeter();
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
    const meter = transactionByteMeter();
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
      const meter = transactionByteMeter();
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

  it("reports a rolled-back transaction's bytes once", async () => {
    const meter = transactionByteMeter();
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

  it("logs each operation's own transaction bytes and leaves pooled reads uncounted", async () => {
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
    expect(entries[0]).not.toHaveProperty("dbBytesRead");
    // The same edit of a like row reads about the same; a concurrent call's
    // bytes counted twice or on the wrong call would double or vanish.
    const alone = entries[1]!.dbBytesRead!;
    expect(alone).toBeGreaterThan(0);
    for (const entry of entries.slice(2)) {
      expect(Math.abs(entry.dbBytesRead! - alone)).toBeLessThan(alone / 4);
    }
  });
});
