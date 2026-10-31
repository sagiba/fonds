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
      max: 1,
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

  it("logs an operation's transaction bytes and leaves pooled reads uncounted", async () => {
    await db.ensureConnection({ id: "synthetic", provider: "cal" });
    await ingest(db, "synthetic", ["a"], "2040-07-02T00:00:00Z");
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
    await operations.get("update_annotation")!.execute({
      transactionId: page.data[0]!.id,
      expectedVersion: 0,
      notes: "Synthetic note",
    });
    expect(entries.map(({ operation }) => operation)).toEqual([
      "list_transactions",
      "update_annotation",
    ]);
    expect(entries[0]).not.toHaveProperty("dbBytesRead");
    expect(entries[1]!.dbBytesRead).toBeGreaterThan(0);
  });
});
