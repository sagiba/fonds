import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createClient } from "@libsql/client/node";
import { expect, it } from "vitest";

import { FinancialPlan } from "../../src/domain/plans/state.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import { initializeTursoDatabase } from "../../src/storage/sqlite/initialize-libsql.js";
import { sqliteMigrations } from "../../src/storage/sqlite/migration.js";
import { syncRunBodies } from "../../src/storage/sqlite/schema.js";
import {
  applyPlan,
  connection,
  planRows,
  priorRuns,
} from "../../src/storage/sqlite/statements.js";
import { row, synthetic } from "../helpers/storage-harness.js";

const initialMigration = sqliteMigrations[0]!.sql;

it("creates the ledger, evidence and operational tables and enables foreign keys", async () => {
  const db = await openDatabase(":memory:");
  try {
    expect(
      (
        await db.client.execute(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
      ).rows.map((row) => ({ name: row.name })),
    ).toEqual([
      { name: "accounts" },
      { name: "annotations" },
      { name: "cards" },
      { name: "collection_leases" },
      { name: "connections" },
      { name: "deferred_evidence" },
      { name: "event_subscriptions" },
      { name: "events" },
      { name: "provider_credentials" },
      { name: "refresh_windows" },
      { name: "refreshes" },
      { name: "scheduled_collections" },
      { name: "settings" },
      { name: "sync_run_bodies" },
      { name: "sync_run_history" },
      { name: "sync_runs" },
      { name: "transaction_observations" },
      { name: "transaction_posting_links" },
      { name: "transaction_reconciliation" },
      { name: "transactions" },
    ]);
    expect((await db.client.execute("PRAGMA foreign_keys")).rows[0]?.[0]).toBe(
      1,
    );
    expect((await db.client.execute("PRAGMA user_version")).rows[0]?.[0]).toBe(
      sqliteMigrations.length,
    );
  } finally {
    await db.close();
  }
});

it("writes initial settings only while initializing a new file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fonds-initial-settings-"));
  const created = join(directory, "created.sqlite");
  const existing = join(directory, "existing.sqlite");
  try {
    await (await openDatabase(existing)).close();
    for (const [path, expected] of [
      [created, "first"],
      [existing, undefined],
    ] as const) {
      for (const value of ["first", "second"]) {
        const db = await openDatabase(path, { settings: { binding: value } });
        try {
          expect(await db.getSetting("binding")).toBe(expected);
        } finally {
          await db.close();
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("switches a new file to WAL while another process holds its write lock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fonds-wal-switch-"));
  const filename = join(directory, "contended.sqlite");
  // Another opener of the same new file, mid-initialization: it holds the
  // write lock, which makes SQLite refuse the WAL switch at once rather than
  // wait, then releases it as its initialization would.
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(process.argv[1]);
       db.exec("BEGIN IMMEDIATE");
       process.stdout.write("locked\\n");
       setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);`,
      filename,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    await new Promise((resolveLocked) =>
      holder.stdout.once("data", resolveLocked),
    );
    const db = await openDatabase(filename);
    try {
      expect(
        (await db.client.execute("PRAGMA journal_mode")).rows[0]?.[0],
      ).toBe("wal");
      expect(
        (await db.client.execute("PRAGMA user_version")).rows[0]?.[0],
      ).toBe(sqliteMigrations.at(-1)!.version);
    } finally {
      await db.close();
    }
  } finally {
    holder.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("refuses to overwrite an existing file with a backup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fonds-backup-"));
  const destination = join(directory, "existing-file");
  const db = await openDatabase(":memory:");
  try {
    writeFileSync(destination, "Preserve this file");
    await expect(db.backup(destination)).rejects.toThrow();
    expect(readFileSync(destination, "utf8")).toBe("Preserve this file");
  } finally {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("provisions libSQL from a current SQLite file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fonds-libsql-provision-"));
  const current = join(directory, "current.sqlite");
  const db = await openDatabase(current);
  await db.ensureConnection({ id: "provisioned", provider: "cal" });
  await db.close();
  const client = createClient({ url: `file:${current}`, intMode: "number" });
  try {
    await client.execute("PRAGMA foreign_keys=ON");
    await initializeTursoDatabase(client);
    expect(
      (await client.execute("SELECT id FROM connections")).rows.map(
        (row) => row.id,
      ),
    ).toEqual(["provisioned"]);
  } finally {
    client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([":memory:", "local file"])(
  "serializes concurrent reads/writes and recovers its queue after rejection (%s)",
  async (location) => {
    const directory = mkdtempSync(join(tmpdir(), "fonds-async-sqlite-"));
    const db = await openDatabase(
      location === ":memory:" ? location : join(directory, "database.sqlite"),
    );
    try {
      await db.ensureConnection({ id: "concurrent", provider: "cal" });
      const values = await Promise.allSettled([
        db.updateConfig("concurrent", (config) => ({ ...config, first: true })),
        db.getConnection("concurrent"),
        db.updateConfig("missing", (config) => config),
        db.updateConfig("concurrent", (config) => ({
          ...config,
          second: true,
        })),
      ]);
      expect(values.map((value) => value.status)).toEqual([
        "fulfilled",
        "fulfilled",
        "rejected",
        "fulfilled",
      ]);
      expect(
        (await db.getStoredConnection("concurrent"))?.config,
      ).toMatchObject({ first: true, second: true });
    } finally {
      await db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("backs up WAL state with ordering, annotations, cursors and replay intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fonds-async-backup-"));
  const source = await openDatabase(join(directory, "source.sqlite"));
  let restored: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    await source.ensureConnection({ id: "backup", provider: "cal" });
    const capture = (runId: string) => ({
      runId,
      connectionId: "backup",
      startedAt: "2040-08-01T00:00:00Z",
      responses: [
        {
          accountKey: "account",
          endpoint: "synthetic:backup",
          capturedAt: "2040-08-01T00:00:00Z",
          responseText: JSON.stringify([row("z-first"), row("a-second")]),
        },
      ],
    });
    await source.ingestRun(capture("z-first"), synthetic);
    await source.ingestRun(capture("a-second"), synthetic);
    const primary = (await source.listTransactions())[0]!;
    await source.editAnnotation({
      transactionId: primary.id,
      expectedVersion: 0,
      notes: "retained\u0000annotation",
    });
    await source.acknowledgeCursor("backup", "consumer", 0, 1);
    await source.client.execute("UPDATE transactions SET rowid = rowid + 100");
    await source.client.execute("UPDATE sync_runs SET rowid = rowid + 100");
    const before = await planRows(source.orm, "backup");
    const history = await priorRuns(source.orm, "backup");
    const filename = join(directory, "backup ?#%.sqlite");
    await source.backup(filename);
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    restored = await openDatabase(filename);
    expect(await planRows(restored.orm, "backup")).toEqual(before);
    expect(await priorRuns(restored.orm, "backup")).toEqual(history);
    expect(await restored.listEvents({ connectionId: "backup" })).toEqual(
      await source.listEvents({ connectionId: "backup" }),
    );
    expect(await restored.getDeliveryCursor("backup", "consumer")).toBe(1);
    expect(await restored.applyRun("z-first", synthetic)).toEqual(
      await source.applyRun("z-first", synthetic),
    );
    expect(await restored.ingestRun(capture("refresh"), synthetic)).toEqual(
      await source.ingestRun(capture("refresh"), synthetic),
    );
    expect(
      (await restored.client.execute("PRAGMA integrity_check")).rows[0]?.[0],
    ).toBe("ok");
  } finally {
    await restored?.close();
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("creates private database and WAL sidecar files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fonds-sqlite-"));
  const filename = join(directory, "database.sqlite");
  const db = await openDatabase(filename);
  try {
    await db.ensureConnection({ id: "private", provider: "cal" });
    for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  } finally {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("drains queued writes before close and rejects work submitted afterwards", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fonds-close-sqlite-"));
  const filename = join(directory, "database.sqlite");
  const db = await openDatabase(filename);
  try {
    await db.ensureConnection({ id: "closing", provider: "cal" });
    const writing = db.updateConfig("closing", (config) => ({
      ...config,
      retained: true,
    }));
    const closing = db.close();
    await expect(db.getConnection("closing")).rejects.toThrow(
      "Database is closed",
    );
    await writing;
    await closing;
    const restored = await openDatabase(filename);
    try {
      expect(
        (await restored.getStoredConnection("closing"))?.config.retained,
      ).toBe(true);
    } finally {
      await restored.close();
    }
  } finally {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("waits for another process's SQLite write lock using the existing five-second timeout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fonds-lock-sqlite-"));
  const filename = join(directory, "database.sqlite");
  const db = await openDatabase(filename);
  await db.ensureConnection({ id: "locked", provider: "cal" });
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked\\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 400);
  `,
      filename,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Synthetic lock process failed")),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    expect((await db.client.execute("PRAGMA busy_timeout")).rows[0]?.[0]).toBe(
      5000,
    );
    expect((await db.client.execute("PRAGMA synchronous")).rows[0]?.[0]).toBe(
      1,
    );
    expect((await db.client.execute("PRAGMA cache_size")).rows[0]?.[0]).toBe(
      -16000,
    );
    await db.updateConfig("locked", (config) => ({
      ...config,
      afterLock: true,
    }));
    await exited;
    expect((await db.getStoredConnection("locked"))?.config.afterLock).toBe(
      true,
    );
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
    await exited.catch(() => {});
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("retains a full 64 MiB source response through local backup and restore", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fonds-large-backup-"));
  const source = await openDatabase(join(directory, "source.sqlite"));
  let restored: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    await source.ensureConnection({ id: "large", provider: "cal" });
    const rows = JSON.stringify([row("large")]);
    const text = rows + " ".repeat(64 * 1024 * 1024 - Buffer.byteLength(rows));
    await source.ingestRun(
      {
        runId: "large",
        debugArchiveDays: 2,
        connectionId: "large",
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:large-backup",
            capturedAt: "2040-08-01T00:00:00Z",
            responseText: text,
          },
        ],
      },
      synthetic,
    );
    const filename = join(directory, "backup.sqlite");
    await source.backup(filename);
    restored = await openDatabase(filename);
    const archived = await restored.orm
      .select({ snapshot: syncRunBodies.snapshot })
      .from(syncRunBodies)
      .get();
    const retained = archived?.snapshot.responses[0]?.responseText;
    expect(retained?.length).toBe(64 * 1024 * 1024);
    expect(
      createHash("sha256")
        .update(retained ?? "")
        .digest("hex"),
    ).toBe(createHash("sha256").update(text).digest("hex"));
    expect(
      (await restored.getTotals({ connectionId: "large" })).includedCount,
    ).toBe(1);
    expect(
      (await restored.client.execute("PRAGMA integrity_check")).rows[0]?.[0],
    ).toBe("ok");
  } finally {
    await restored?.close();
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it("enforces card references within their connection while retaining bank records", async () => {
  const db = await openDatabase(":memory:");
  try {
    for (const id of ["synthetic", "other"]) {
      await db.ensureConnection({ id, provider: "cal" });
    }
    await db.ingestRun(
      {
        runId: "cards-run",
        connectionId: "synthetic",
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic",
            capturedAt: "2040-08-01T00:00:00Z",
            responseText: JSON.stringify([row("card-row")]),
          },
        ],
      },
      synthetic,
    );
    await db.client.execute(
      "INSERT INTO cards(id,connection_id,provider_key,created_at) VALUES('other-card','other','card','2040-08-01T00:00:00Z')",
    );
    await expect(
      db.client.execute("UPDATE transactions SET card_id='other-card'"),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      db.client.execute("DELETE FROM cards WHERE connection_id='synthetic'"),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      db.client.execute(
        "INSERT INTO cards(id,connection_id,provider_key,created_at) VALUES('duplicate','synthetic','card','2040-08-01T00:00:00Z')",
      ),
    ).rejects.toThrow(/UNIQUE/);
    for (const last4 of ["12345", "1234\n", "١٢٣٤"]) {
      await expect(
        db.client.execute({
          sql: "INSERT INTO cards(id,connection_id,provider_key,created_at,last4) VALUES('bad','synthetic','bad','2040-08-01T00:00:00Z',?)",
          args: [last4],
        }),
      ).rejects.toThrow(/CHECK/);
    }
    await db.client.execute(
      "INSERT INTO accounts(id,connection_id,provider_key,type,created_at) VALUES('other-account','other','account','depository','2040-08-01T00:00:00Z')",
    );
    await expect(
      db.client.execute(
        "UPDATE cards SET billing_account_id='other-account' WHERE connection_id='synthetic'",
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
    for (const [type, mask] of [
      ["credit_line", null],
      ["depository", "123"],
    ] as const) {
      await expect(
        db.client.execute({
          sql: "INSERT INTO accounts(id,connection_id,provider_key,type,mask,created_at) VALUES('bad','synthetic','bad',?,?,'2040-08-01T00:00:00Z')",
          args: [type, mask],
        }),
      ).rejects.toThrow(/CHECK/);
    }
    await db.client.execute("UPDATE transactions SET card_id=NULL");
    await db.client.execute(
      "DELETE FROM cards WHERE connection_id='synthetic'",
    );
    expect((await db.listTransactions())[0]?.cardId).toBeNull();
  } finally {
    await db.close();
  }
});

it("enforces purchase links, payment context and FX fee pairs on transactions", async () => {
  const db = await openDatabase(":memory:");
  try {
    for (const id of ["synthetic", "other"]) {
      await db.ensureConnection({ id, provider: "cal" });
      await db.ingestRun(
        {
          runId: `${id}-run`,
          connectionId: id,
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic",
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: JSON.stringify([row(`${id}-a`), row(`${id}-b`)]),
            },
          ],
        },
        synthetic,
      );
    }
    const ids = async (connectionId: string) =>
      (await db.listTransactions({ connectionId })).map((row) => row.id);
    const [line, purchase] = await ids("synthetic");
    const [foreign] = await ids("other");
    const update = (assignment: string, args: (string | number)[] = []) =>
      db.client.execute({
        sql: `UPDATE transactions SET ${assignment} WHERE id = ?`,
        args: [...args, line!],
      });
    await update("purchase_id = ?", [purchase!]);
    await expect(
      db.client.execute({
        sql: "DELETE FROM transactions WHERE id = ?",
        args: [purchase!],
      }),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(update("purchase_id = ?", [foreign!])).rejects.toThrow(
      /FOREIGN KEY/,
    );
    await expect(update("purchase_id = id")).rejects.toThrow(/CHECK/);
    for (const assignment of [
      "installment_number = 0",
      "authorization_method = 'tap'",
      "wallet = 'paypal'",
      "card_present = 2",
      "fx_fee_minor = -100",
      "fx_fee_currency = 'ILS'",
      "fx_fee_minor = -100, fx_fee_currency = 'ils'",
    ]) {
      await expect(update(assignment)).rejects.toThrow(/CHECK/);
    }
    await update(
      "installment_number = 1, authorization_method = 'contactless', wallet = 'apple_pay', card_present = 1, three_d_secure_used = 0, recurring = 1, provider_transaction_code = '5', fx_fee_minor = -100, fx_fee_currency = 'ILS'",
    );
    expect(
      (await db.listTransactions({ connectionId: "synthetic" })).find(
        (row) => row.id === line,
      ),
    ).toMatchObject({
      purchaseId: purchase,
      installmentNumber: 1,
      authorizationMethod: "contactless",
      wallet: "apple_pay",
      cardPresent: true,
      threeDSecureUsed: false,
      recurring: true,
      providerTransactionCode: "5",
      fxFeeMinor: -100,
      fxFeeCurrency: "ILS",
    });
    await expect(
      db.client.execute(
        "INSERT INTO events(type,created_at,actor) VALUES('transaction.created','2040-08-01T00:00:00Z','sync')",
      ),
    ).rejects.toThrow(/NOT NULL/);
  } finally {
    await db.close();
  }
});

it("rewrites a captured transaction without scanning its connection for purchase links", async () => {
  const db = await openDatabase(":memory:");
  try {
    await db.ensureConnection({ id: "synthetic", provider: "cal" });
    await db.ingestRun(
      {
        runId: "index-run",
        connectionId: "synthetic",
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic",
            capturedAt: "2040-08-01T00:00:00Z",
            responseText: JSON.stringify([row("indexed")]),
          },
        ],
      },
      synthetic,
    );
    const [stored] = await planRows(db.orm, "synthetic");
    const plan = new FinancialPlan({
      connection: (await connection(db.orm, "synthetic"))[0]!,
      rows: [stored!.row],
      annotations: [],
      priorRuns: [],
      removals: [],
    });
    plan.updateTransaction(stored!.row.id, {
      version: stored!.row.version + 1,
    });
    const [upsert] = [...applyPlan(db.orm, plan)];
    const { sql, params } = upsert!.toSQL();
    // A row's connection never changes, so the update leaves it alone.
    expect(sql).not.toContain('excluded."connection_id"');
    const steps = (
      await db.client.execute({
        sql: `EXPLAIN QUERY PLAN ${sql}`,
        args: params as never[],
      })
    ).rows.map((step) => String(step.detail));
    // SQLite's purchase-link checks probe the child key by its own index, not
    // every transaction of the connection through transactions_source.
    expect(steps).toContain(
      "SEARCH transactions USING COVERING INDEX transactions_purchase (connection_id=? AND purchase_id=?)",
    );
    expect(
      steps.filter((step) => step.includes("transactions_source")),
    ).toEqual([]);
  } finally {
    await db.close();
  }
});

it("rolls back new card stubs with a failed financial application and retains retryable evidence", async () => {
  const db = await openDatabase(":memory:");
  try {
    await db.ensureConnection({ id: "synthetic", provider: "cal" });
    await db.client.executeMultiple(
      "CREATE TRIGGER synthetic_card_failure BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'synthetic financial failure'); END;",
    );
    await expect(
      db.ingestRun(
        {
          runId: "failed-card-run",
          connectionId: "synthetic",
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic",
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: JSON.stringify([row("card-row")]),
            },
          ],
        },
        synthetic,
      ),
    ).rejects.toThrow();
    expect((await db.client.execute("SELECT * FROM cards")).rows).toEqual([]);
    expect(await db.listEvents()).toEqual([]);
    expect(
      (await db.client.execute("SELECT applied_at FROM sync_runs")).rows,
    ).toEqual([{ applied_at: null }]);
    await db.client.execute("DROP TRIGGER synthetic_card_failure");
    expect(await db.applyRun("failed-card-run", synthetic)).toMatchObject({
      created: 1,
    });
    expect(
      (
        await db.client.execute(
          "SELECT provider_key,billing_account_id,last4,display_name,last_seen_at FROM cards",
        )
      ).rows,
    ).toEqual([
      {
        provider_key: "card",
        billing_account_id: null,
        last4: null,
        display_name: null,
        last_seen_at: null,
      },
    ]);
  } finally {
    await db.close();
  }
});

it("reopens a current SQLite file repeatedly and rejects current-version files whose schema differs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fonds-schema-sqlite-"));
  try {
    const current = join(directory, "current.sqlite");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const db = await openDatabase(current);
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
      await db.close();
    }
    const reopened = await openDatabase(current);
    expect(await reopened.getConnection("synthetic")).not.toBeNull();
    await reopened.close();

    const variants: Record<string, string> = {
      "missing-index": "DROP INDEX transactions_date",
      "missing-column": "ALTER TABLE connections ADD COLUMN extra TEXT",
      "extra-table": "CREATE TABLE extra_table (id TEXT)",
      "altered-declaration": initialMigration.replace(
        "CHECK (json_valid(config_json))",
        "CHECK (1)",
      ),
    };
    for (const [name, change] of Object.entries(variants)) {
      const filename = join(directory, `${name}.sqlite`);
      const altered = new DatabaseSync(filename);
      if (name === "altered-declaration") {
        expect(change).not.toBe(initialMigration);
        altered.exec(change);
      } else {
        altered.exec(initialMigration);
        altered.exec(change);
      }
      altered.exec(`PRAGMA user_version = ${sqliteMigrations.length}`);
      altered.close();
      await expect(openDatabase(filename)).rejects.toThrow(
        "Unsupported database schema",
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
