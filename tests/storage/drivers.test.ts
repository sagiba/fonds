import { randomUUID } from "node:crypto";

import { createClient } from "@libsql/client/web";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError } from "../../src/domain/errors.js";
import {
  initializePostgresDatabase,
  openPostgresDatabase,
} from "../../src/storage/postgres/store.js";
import {
  databaseForClient,
  initializeTursoDatabase,
} from "../../src/storage/turso.js";
import { disposableDatabase } from "../helpers/postgres-database.js";
import { authorization, postingHarness } from "../helpers/posting.js";
import { row, synthetic } from "../helpers/storage-harness.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;
const httpUrl = process.env.FONDS_TEST_LIBSQL_HTTP_URL;
const largeHttpUrl = process.env.FONDS_TEST_LIBSQL_LARGE_HTTP_URL;
const captureInput = (connectionId: string, runId: string, text: string) => ({
  runId,
  debugArchiveDays: 2,
  connectionId,
  responses: [
    {
      accountKey: "account",
      endpoint: "synthetic",
      capturedAt: "2040-08-01T00:00:00Z",
      responseText: text,
    },
  ],
});

describe.skipIf(!postgresUrl)(
  "PostgreSQL transaction and schema guarantees",
  () => {
    let database: Awaited<ReturnType<typeof disposableDatabase>>;
    let db: ReturnType<typeof openPostgresDatabase>;
    let other: ReturnType<typeof openPostgresDatabase>;
    beforeEach(async () => {
      database = await disposableDatabase(postgresUrl!, "fonds_driver");
      const config = {
        connectionString: database.url,
        options: database.options,
        max: 1,
      };
      db = openPostgresDatabase(config);
      other = openPostgresDatabase(config);
      await initializePostgresDatabase(db.pool);
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
    });
    afterEach(async () => {
      await other?.close();
      await db?.close();
      await database?.drop();
    });
    it("locks the connection before reading versions and allocating ordered audit IDs", async () => {
      await db.ingestRun(
        captureInput("synthetic", "first", JSON.stringify([row("one")])),
        synthetic,
      );
      const transaction = (
        await db.listTransactionPage({ connectionId: "synthetic" })
      ).transactions[0]!;
      const writer = await db.pool.connect();
      await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await writer.query(
        "SELECT id FROM connections WHERE id='synthetic' FOR UPDATE",
      );
      await writer.query(
        "INSERT INTO annotations(transaction_id,version,data_json,updated_at) VALUES($1,1,$2,'2040-08-01T00:00:00Z')",
        [
          transaction.id,
          JSON.stringify({
            schemaVersion: 1,
            notes: "first",
            category: null,
            tags: [],
          }),
        ],
      );
      const first = (
        await writer.query(
          "INSERT INTO events(connection_id,transaction_id,type,created_at,actor) SELECT connection_id,id,'annotation.updated','2040-08-01T00:00:00Z','test' FROM transactions WHERE id=$1 RETURNING id",
          [transaction.id],
        )
      ).rows[0].id;
      const competing = Promise.resolve(
        other.editAnnotation({
          transactionId: transaction.id,
          expectedVersion: 0,
          notes: "second",
        }),
      );
      let settled = false;
      void competing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      await writer.query("COMMIT");
      writer.release();
      await expect(competing).rejects.toThrow(ConflictError);
      await other.editAnnotation({
        transactionId: transaction.id,
        expectedVersion: 1,
        notes: "second",
      });
      const changes = await db.listEvents({
        connectionId: "synthetic",
        after: Number(first),
      });
      expect(changes).toHaveLength(1);
      expect(changes[0]!.id).toBeGreaterThan(Number(first));
      expect(
        (
          await db.pool.query(
            "SELECT cache_size FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename",
          )
        ).rows.map((row) => String(row.cache_size)),
      ).toEqual(["1", "1", "1"]);
    });
    it("waits for another session's connection-row lock before ingest, apply and config writes", async () => {
      const deferred = {
        ...synthetic,
        extract: () => {
          throw new Error("defer apply");
        },
      };
      await expect(
        db.ingestRun(
          captureInput("synthetic", "unapplied", JSON.stringify([row("one")])),
          deferred,
        ),
      ).rejects.toThrow("defer apply");
      const operations = {
        ingest: () =>
          other.ingestRun(
            captureInput("synthetic", "locked", JSON.stringify([row("two")])),
            synthetic,
          ),
        apply: () => other.applyRun("unapplied", synthetic),
        config: () =>
          other.updateConfig("synthetic", (config) => ({
            ...config,
            setting: "after lock",
          })),
      };
      // FOR SHARE admits foreign-key inserts and blocks a config UPDATE either
      // way, so only the missing FOR UPDATE lets ingest/apply proceed, and a
      // config change made under the lock is lost unless the read waited.
      for (const [name, operation] of Object.entries(operations)) {
        const writer = await db.pool.connect();
        let pending: Promise<unknown> = Promise.resolve();
        try {
          await writer.query("BEGIN");
          await writer.query(
            "SELECT id FROM connections WHERE id='synthetic' FOR SHARE",
          );
          pending = Promise.resolve(operation());
          let settled = false;
          void pending.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(settled, name).toBe(false);
          if (name === "config") {
            await writer.query(
              "UPDATE connections SET config_json = (config_json::jsonb || '{\"writer\":\"kept\"}')::text WHERE id='synthetic'",
            );
          }
        } finally {
          await writer.query("COMMIT");
          writer.release();
        }
        await pending;
      }
      expect(
        (await db.listTransactionPage({ connectionId: "synthetic" }))
          .transactions,
      ).toHaveLength(2);
      const stored = await db.pool.query(
        "SELECT config_json FROM connections WHERE id='synthetic'",
      );
      expect(JSON.parse(stored.rows[0].config_json)).toMatchObject({
        writer: "kept",
        setting: "after lock",
      });
    });
    it("serializes concurrent ingest and unlink without losing current posted corrections", async () => {
      const harness = postingHarness(db);
      await db.ensureConnection({ id: harness.connectionId, provider: "cal" });
      await harness.capture(2, [authorization()]);
      const pending = await harness.byKey("pending");
      await db.editAnnotation({
        transactionId: pending.id,
        expectedVersion: 0,
        notes: "Retain during race",
      });
      await harness.capture(3, [row("posted")]);
      const survivor = await harness.byKey("posted");
      const postedId = survivor.details.postingLink!.postedId;
      const command = await harness.command(pending.id, postedId);
      const [ingest, split] = await Promise.allSettled([
        harness.capture(4, [row("posted", { amountMinor: -125 })]),
        other.unlinkPendingTransaction(command),
      ]);
      expect(ingest.status).toBe("fulfilled");
      if (split.status === "rejected") {
        expect(split.reason).toBeInstanceOf(ConflictError);
        await other.unlinkPendingTransaction(
          await harness.command(pending.id, postedId),
        );
      }
      expect(await db.getTransaction(postedId)).toMatchObject({
        status: "posted",
        amountMinor: -125,
        supersededById: null,
      });
      expect(await db.getTransaction(pending.id)).toMatchObject({
        status: "pending",
        amountMinor: -100,
        annotation: { data: { notes: "Retain during race" } },
      });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "transaction.unlinked",
        ),
      ).toHaveLength(2);
      expect(await db.getTotals()).toMatchObject({
        includedCount: 1,
        totals: [{ amountMinor: -125 }],
      });
    });
    it("keeps safe financial/version integers above PostgreSQL int32 exact", async () => {
      await db.ingestRun(
        captureInput(
          "synthetic",
          "large",
          JSON.stringify([
            row("one", {
              amountMinor: -9007199254740991,
              installmentCount: 9007199254740991,
            }),
          ]),
        ),
        synthetic,
      );
      const transaction = (
        await db.listTransactionPage({ connectionId: "synthetic" })
      ).transactions[0]!;
      await db.pool.query(
        "UPDATE transactions SET version=2147483648 WHERE id=$1",
        [transaction.id],
      );
      const result = await db.editAnnotation({
        transactionId: transaction.id,
        expectedVersion: 0,
        notes: "exact",
      });
      expect(result.version).toBe(1);
      expect(await db.getTransaction(transaction.id)).toMatchObject({
        installmentCount: 9007199254740991,
      });
      expect((await db.getTransaction(transaction.id))?.version).toBe(
        2147483648,
      );
      expect(
        (await db.getTotals({ connectionId: "synthetic" })).totals[0]
          ?.amountMinor,
      ).toBe(-9007199254740991);
    });
    it("isolates scalar NUL rows while retaining and applying the original evidence", async () => {
      await expect(
        db.ingestRun(
          captureInput(
            "synthetic",
            "nul-scalar",
            JSON.stringify([row("one", { description: "before\u0000after" })]),
          ),
          synthetic,
        ),
      ).resolves.toMatchObject({ status: "partial", created: 0 });
      expect(
        (await db.listTransactionPage({ connectionId: "synthetic" }))
          .transactions,
      ).toEqual([]);
      const run = (
        await db.pool.query(
          "SELECT r.applied_at,b.snapshot_json FROM sync_runs r JOIN sync_run_bodies b ON b.run_id=r.id WHERE r.id='nul-scalar'",
        )
      ).rows[0];
      expect(run.applied_at).not.toBeNull();
      expect(JSON.parse(run.snapshot_json).responses[0].responseText).toContain(
        "\\u0000",
      );
    });
    it("handles idle pool failure with a fixed diagnostic and preserves supplied listener ownership", async () => {
      const diagnostic = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      try {
        expect(() =>
          db.pool.emit("error", new Error("synthetic private driver detail")),
        ).not.toThrow();
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
          "PostgreSQL idle connection failed.",
        );
      } finally {
        diagnostic.mockRestore();
      }
      const supplied = new Pool({ connectionString: postgresUrl });
      const listener = vi.fn();
      supplied.on("error", listener);
      const wrapped = openPostgresDatabase(supplied);
      try {
        expect(supplied.listenerCount("error")).toBe(1);
        supplied.emit("error", new Error("synthetic"));
        expect(listener).toHaveBeenCalledOnce();
      } finally {
        await wrapped.close();
      }
    });
    it("enforces composite card references and permits transactions without a card", async () => {
      await db.ensureConnection({ id: "other", provider: "cal" });
      await db.ingestRun(
        captureInput("synthetic", "card-run", JSON.stringify([row("one")])),
        synthetic,
      );
      await db.pool.query(
        "INSERT INTO cards(id,connection_id,provider_key,created_at) VALUES('other-card','other','card','2040-08-01T00:00:00Z')",
      );
      await expect(
        db.pool.query("UPDATE transactions SET card_id='other-card'"),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        db.pool.query("DELETE FROM cards WHERE connection_id='synthetic'"),
      ).rejects.toMatchObject({ code: "23503" });
      for (const last4 of ["12345", "1234\n", "١٢٣٤"]) {
        await expect(
          db.pool.query(
            "INSERT INTO cards(id,connection_id,provider_key,created_at,last4) VALUES('bad','synthetic','bad','2040-08-01T00:00:00Z',$1)",
            [last4],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      }
      await db.pool.query(
        "INSERT INTO accounts(id,connection_id,provider_key,type,created_at) VALUES('other-account','other','account','depository','2040-08-01T00:00:00Z')",
      );
      await expect(
        db.pool.query(
          "UPDATE cards SET billing_account_id='other-account' WHERE connection_id='synthetic'",
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        db.pool.query("UPDATE transactions SET purchase_id='missing'"),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        db.pool.query("UPDATE transactions SET purchase_id=id"),
      ).rejects.toMatchObject({ code: "23514" });
      for (const assignment of [
        "installment_number = 0",
        "wallet = 'paypal'",
        "fx_fee_minor = -100",
      ]) {
        await expect(
          db.pool.query(`UPDATE transactions SET ${assignment}`),
        ).rejects.toMatchObject({ code: "23514" });
      }
      await db.pool.query("UPDATE transactions SET card_id=NULL");
      await db.pool.query("DELETE FROM cards WHERE connection_id='synthetic'");
      expect(
        (await db.listTransactionPage({ connectionId: "synthetic" }))
          .transactions[0]?.cardId,
      ).toBeNull();
    });
    it("rolls back card stubs and financial writes together while retaining unapplied evidence", async () => {
      await db.pool.query(
        `CREATE FUNCTION synthetic_card_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic financial failure'; END $$`,
      );
      await db.pool.query(
        "CREATE TRIGGER synthetic_card_failure BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION synthetic_card_failure()",
      );
      await expect(
        db.ingestRun(
          captureInput(
            "synthetic",
            "failed-card-run",
            JSON.stringify([row("one")]),
          ),
          synthetic,
        ),
      ).rejects.toThrow();
      expect((await db.pool.query("SELECT * FROM cards")).rows).toEqual([]);
      expect(await db.listEvents()).toEqual([]);
      expect(
        (await db.pool.query("SELECT applied_at FROM sync_runs")).rows,
      ).toEqual([{ applied_at: null }]);
      await db.pool.query(
        "DROP TRIGGER synthetic_card_failure ON transactions",
      );
      expect(await db.applyRun("failed-card-run", synthetic)).toMatchObject({
        created: 1,
      });
      expect(
        (
          await db.pool.query(
            "SELECT provider_key,last4,display_name,last_seen_at FROM cards",
          )
        ).rows,
      ).toEqual([
        {
          provider_key: "card",
          last4: null,
          display_name: null,
          last_seen_at: null,
        },
      ]);
    });
    it("re-initializes an unchanged schema", async () => {
      await expect(initializePostgresDatabase(db.pool)).resolves.not.toThrow();
    });
    it("rejects altered declarations despite an unchanged migration marker", async () => {
      await initializePostgresDatabase(db.pool);
      await db.pool.query(
        "ALTER TABLE transactions DROP CONSTRAINT transactions_amount_minor_check",
      );
      await expect(initializePostgresDatabase(db.pool)).rejects.toThrow(
        "declarations",
      );
    });
    it("rejects incompatible sequence caches and collation drift", async () => {
      await db.pool.query("ALTER SEQUENCE events_id_seq CACHE 2");
      await expect(initializePostgresDatabase(db.pool)).rejects.toThrow(
        "declarations",
      );
      await db.pool.query("ALTER SEQUENCE events_id_seq CACHE 1");
      await db.pool.query(
        'ALTER TABLE connections ALTER COLUMN display_name TYPE TEXT COLLATE "default"',
      );
      await expect(initializePostgresDatabase(db.pool)).rejects.toThrow(
        "declarations",
      );
    });
  },
);

describe.skipIf(!httpUrl)("libSQL over actual HTTP", () => {
  it.skipIf(!largeHttpUrl)(
    "atomically applies a 64MiB captured response with 10,000 synthetic rows on an explicitly provisioned server",
    async () => {
      const client = createClient({ url: largeHttpUrl!, intMode: "number" });
      const db = databaseForClient(client);
      await initializeTursoDatabase(client);
      const id = `large-${randomUUID()}`;
      await db.ensureConnection({ id, provider: "cal" });
      try {
        const rowsText = JSON.stringify(
          Array.from({ length: 10000 }, (_, index) =>
            row(`purchase-${String(index).padStart(5, "0")}`),
          ),
        );
        const text =
          rowsText +
          " ".repeat(
            64 * 1024 * 1024 - new TextEncoder().encode(rowsText).byteLength,
          );
        const input = captureInput(id, id, text);
        const started = performance.now();
        const result = await Promise.resolve(
          db.ingestRun(input, synthetic),
        ).catch((error) => {
          throw new Error(
            `Large-run driver rejection: ${driverCode(error) ?? "unknown"}`,
          );
        });
        expect(result).toMatchObject({ created: 10000, status: "completed" });
        expect(await db.applyRun(id, synthetic)).toMatchObject({
          replayed: true,
        });
        expect((await db.getTotals({ connectionId: id })).includedCount).toBe(
          10000,
        );
        console.info(
          `libSQL HTTP 10,000-row atomic ingest: ${Math.round(performance.now() - started)} ms, ${new TextEncoder().encode(text).byteLength} source bytes`,
        );
      } finally {
        db.close();
      }
    },
    30000,
  );
  it("reports a lost commit acknowledgement then resolves by applied-run replay", async () => {
    let commitCount = 0;
    let dropped = false;
    let armed = false;
    const client = createClient({
      url: httpUrl!,
      intMode: "number",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const text = await request.clone().text();
        const response = await fetch(request);
        if (armed && text.includes("COMMIT")) {
          commitCount++;
          if (commitCount === 2) {
            dropped = true;
            throw new TypeError("synthetic lost commit acknowledgement");
          }
        }
        return response;
      },
    });
    const db = databaseForClient(client);
    await initializeTursoDatabase(client);
    const id = `lost-${randomUUID()}`;
    await db.ensureConnection({ id, provider: "cal" });
    commitCount = 0;
    armed = true;
    try {
      await expect(
        db.ingestRun(
          captureInput(id, id, JSON.stringify([row("one")])),
          synthetic,
        ),
      ).rejects.toThrow();
      expect(dropped).toBe(true);
      const normal = createClient({ url: httpUrl!, intMode: "number" });
      const reader = databaseForClient(normal);
      try {
        expect(await reader.applyRun(id, synthetic)).toMatchObject({
          replayed: true,
        });
        expect(
          (await reader.listEvents({ connectionId: id })).filter(
            (c) => c.type === "sync.baseline",
          ),
        ).toHaveLength(1);
      } finally {
        reader.close();
      }
    } finally {
      db.close();
    }
  });
  it("rolls back expired canonical application while retaining evidence for a later retry", async () => {
    const normal = createClient({ url: httpUrl!, intMode: "number" });
    const reader = databaseForClient(normal);
    const id = `expired-${randomUUID()}`;
    await reader.ensureConnection({ id, provider: "cal" });
    let delayed = false;
    const client = createClient({
      url: httpUrl!,
      intMode: "number",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const text = await request.clone().text();
        const response = await fetch(request);
        if (
          !delayed &&
          text.includes("insert into") &&
          text.includes("transactions")
        ) {
          delayed = true;
          // A competing writer asks the server to enforce its namespace transaction deadline.
          await reader.ensureConnection({
            id: `contender-${id}`,
            provider: "cal",
          });
        }
        return response;
      },
    });
    const db = databaseForClient(client);
    const source = JSON.stringify([row("one")]);
    try {
      await expect(
        db.ingestRun(captureInput(id, id, source), synthetic),
      ).rejects.toThrow();
      expect(delayed).toBe(true);
      const stored = (
        await normal.execute({
          sql: "SELECT r.applied_at,b.snapshot_json FROM sync_runs r JOIN sync_run_bodies b ON b.run_id=r.id WHERE r.id=?",
          args: [id],
        })
      ).rows[0]!;
      expect(stored.applied_at).toBeNull();
      expect(
        JSON.parse(String(stored.snapshot_json)).responses[0].responseText,
      ).toBe(source);
      expect(
        (await reader.listTransactionPage({ connectionId: id })).transactions,
      ).toHaveLength(0);
      expect(await reader.listEvents({ connectionId: id })).toHaveLength(0);
      expect(await reader.applyRun(id, synthetic)).toMatchObject({
        created: 1,
        replayed: false,
      });
    } finally {
      db.close();
      reader.close();
    }
  }, 15000);
});

function driverCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "cause" in error ? driverCode(error.cause) : undefined;
}
