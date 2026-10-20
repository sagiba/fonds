import { randomUUID } from "node:crypto";

import { createClient } from "@libsql/client/web";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deliverFromStore } from "../../src/application/change-delivery.js";
import {
  initializePostgresDatabase,
  openPostgresDatabase,
} from "../../src/storage/postgres/store.js";
import { databaseForClient } from "../../src/storage/turso.js";
import { disposableDatabase } from "../helpers/postgres-database.js";
import { row, synthetic } from "../helpers/storage-harness.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;
const httpUrl = process.env.FONDS_TEST_LIBSQL_HTTP_URL;
const input = (connectionId: string, runId: string, amountMinor = -100) => ({
  runId,
  connectionId,
  responses: [
    {
      accountKey: "account",
      endpoint: "synthetic",
      capturedAt: "2040-08-01T00:00:00Z",
      responseText: JSON.stringify([row("one", { amountMinor })]),
    },
  ],
});

describe.skipIf(!postgresUrl)(
  "PostgreSQL independent delivery and schema behavior",
  () => {
    let admin: Pool;
    let database: Awaited<ReturnType<typeof disposableDatabase>>;
    let db: ReturnType<typeof openPostgresDatabase>;
    let writerStore: ReturnType<typeof openPostgresDatabase>;
    beforeEach(async () => {
      database = await disposableDatabase(postgresUrl!, "fonds_delivery");
      // Advisory locks are per database, so the test gate joins this one.
      admin = new Pool({ connectionString: database.url });
      const config = {
        connectionString: database.url,
        options: database.options,
        max: 1,
      };
      db = openPostgresDatabase(config);
      writerStore = openPostgresDatabase(config);
      await initializePostgresDatabase(db.pool);
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
    });
    afterEach(async () => {
      await writerStore?.close();
      await db?.close();
      await admin?.end();
      await database?.drop();
    });
    it("delivers changes while an asynchronous write waits for the connection lock", async () => {
      await db.ingestRun(input("synthetic", "baseline"), synthetic);
      const transaction = (
        await db.listTransactionPage({ connectionId: "synthetic" })
      ).transactions[0]!;
      const lock = await db.pool.connect();
      await lock.query("BEGIN");
      await lock.query(
        "SELECT id FROM connections WHERE id='synthetic' FOR UPDATE",
      );
      const writing = Promise.resolve(
        writerStore.editAnnotation({
          transactionId: transaction.id,
          expectedVersion: 0,
          notes: "concurrent edit",
        }),
      );
      let delivery: ReturnType<typeof deliverFromStore> | undefined;
      try {
        await new Promise((resolve) => setTimeout(resolve, 30));
        delivery = deliverFromStore(
          writerStore,
          { connectionId: "synthetic", consumerId: "test" },
          async () => {},
        );
        void delivery.catch(() => {});
      } finally {
        await lock.query("COMMIT");
        lock.release();
      }
      await writing;
      expect(await delivery).toMatchObject({ delivered: 3 });
      expect(
        await writerStore.getDeliveryCursor("synthetic", "test"),
      ).toBeGreaterThan(0);
    });
    for (const rollbackFirst of [false, true]) {
      it(`never skips a lower allocated change while another connection writes, including rollback=${rollbackFirst}`, async () => {
        await db.ensureConnection({ id: "other", provider: "cal" });
        await db.ingestRun(input("synthetic", "baseline"), synthetic);
        await db.ingestRun(input("other", "other-baseline"), synthetic);
        const first = (
          await db.listTransactionPage({ connectionId: "synthetic" })
        ).transactions[0]!;
        const second = (await db.listTransactionPage({ connectionId: "other" }))
          .transactions[0]!;
        const before = await db.latestEventId();
        const competing = openPostgresDatabase({
          connectionString: database.url,
          options: database.options,
          max: 1,
        });
        const firstPid = (
          await writerStore.pool.query("SELECT pg_backend_pid() AS pid")
        ).rows[0].pid as number;
        const secondPid = (
          await competing.pool.query("SELECT pg_backend_pid() AS pid")
        ).rows[0].pid as number;
        const gate = await admin.connect();
        // This independent test gate pauses the first writer after nextval has
        // allocated its change ID, while all of its financial writes are hidden.
        await gate.query("SELECT pg_advisory_lock(1178882898,2)");
        await db.pool.query(`
          CREATE FUNCTION pause_first_change() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.transaction_id = '${first.id}' AND NEW.type = 'annotation.updated' THEN
              PERFORM pg_advisory_xact_lock(1178882898,2);
              ${rollbackFirst ? "RAISE EXCEPTION 'synthetic rollback';" : ""}
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER pause_first_change AFTER INSERT ON events
          FOR EACH ROW EXECUTE FUNCTION pause_first_change();
        `);
        const writingFirst = writerStore
          .editAnnotation({
            transactionId: first.id,
            expectedVersion: 0,
            notes: "first connection",
          })
          .then(
            () => "committed",
            () => "rolled_back",
          );
        let writingSecond: Promise<unknown> | undefined;
        try {
          await expect
            .poll(async () =>
              Number(
                (
                  await admin.query(
                    "SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND classid=1178882898 AND objid=2 AND NOT granted AND pid=$1",
                    [firstPid],
                  )
                ).rows[0].count,
              ),
            )
            .toBe(1);
          const allocated = Number(
            (await db.pool.query("SELECT last_value FROM events_id_seq"))
              .rows[0].last_value,
          );
          expect(allocated).toBeGreaterThan(before);
          writingSecond = competing.editAnnotation({
            transactionId: second.id,
            expectedVersion: 0,
            notes: "second connection",
          });
          void writingSecond.catch(() => {});
          await expect
            .poll(async () =>
              Number(
                (
                  await admin.query(
                    "SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND classid=1178882898 AND objid=1 AND NOT granted AND pid=$1",
                    [secondPid],
                  )
                ).rows[0].count,
              ),
            )
            .toBe(1);
          expect(await db.latestEventId()).toBe(before);
          expect(await db.listEvents({ after: before })).toEqual([]);
          expect((await db.getTransaction(first.id))?.annotation).toBeNull();
          expect((await db.getTransaction(second.id))?.annotation).toBeNull();
        } finally {
          await gate.query("SELECT pg_advisory_unlock(1178882898,2)");
          gate.release();
          await writingFirst;
          await writingSecond;
          await competing.close();
        }
        expect(await writingFirst).toBe(
          rollbackFirst ? "rolled_back" : "committed",
        );
        const delivered = [];
        let cursor = before;
        for (;;) {
          const page = await db.listEvents({ after: cursor, limit: 1 });
          if (!page.length) {
            break;
          }
          delivered.push(page[0]!);
          cursor = page[0]!.id;
        }
        expect(delivered.map((change) => change.transactionId)).toEqual(
          rollbackFirst ? [second.id] : [first.id, second.id],
        );
        if (rollbackFirst) {
          expect(delivered[0]!.id).toBeGreaterThan(before + 1);
          expect((await db.getTransaction(first.id))?.annotation).toBeNull();
        }
      });
    }
    for (const drift of [
      "trigger",
      "rule",
      "row security",
      "policy",
    ] as const) {
      it(`rejects unexpected ${drift} behavior in an otherwise matching schema`, async () => {
        if (drift === "trigger") {
          await db.pool.query(
            "CREATE FUNCTION synthetic_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
          );
          await db.pool.query(
            "CREATE TRIGGER synthetic_noop BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION synthetic_noop()",
          );
        }
        if (drift === "rule") {
          await db.pool.query(
            "CREATE RULE synthetic_suppress AS ON INSERT TO events DO INSTEAD NOTHING",
          );
        }
        if (drift === "row security") {
          await db.pool.query(
            "ALTER TABLE connections ENABLE ROW LEVEL SECURITY",
          );
        }
        if (drift === "policy") {
          await db.pool.query(
            "CREATE POLICY synthetic_policy ON connections USING (true)",
          );
        }
        await expect(initializePostgresDatabase(db.pool)).rejects.toThrow(
          "declarations",
        );
      });
    }
  },
);

describe.skipIf(!httpUrl)("libSQL HTTP independent delivery", () => {
  it("delivers and acknowledges committed changes while another named ingest is active", async () => {
    let pause = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const inserted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const client = createClient({
      url: httpUrl!,
      intMode: "number",
      fetch: async (value: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(value, init);
        const text = await request.clone().text();
        const response = await fetch(request);
        if (
          pause &&
          text.includes("insert into") &&
          text.includes("transactions")
        ) {
          pause = false;
          reached();
          await gate;
        }
        return response;
      },
    });
    const db = databaseForClient(client);
    const id = `delivery-${randomUUID()}`;
    await db.ensureConnection({ id, provider: "cal" });
    await db.ingestRun(input(id, `${id}-baseline`), synthetic);
    // Everything the baseline committed; the paused update must add nothing.
    const committed = (await db.listEvents({ connectionId: id })).length;
    expect(committed).toBeGreaterThan(0);
    pause = true;
    const writing = Promise.resolve(
      db.ingestRun(input(id, `${id}-update`, -200), synthetic),
    );
    let delivery: ReturnType<typeof deliverFromStore> | undefined;
    try {
      await inserted;
      let entered!: () => void;
      const callback = new Promise<void>((resolve) => {
        entered = resolve;
      });
      delivery = deliverFromStore(
        db,
        { connectionId: id, consumerId: "test" },
        async () => {
          entered();
        },
      );
      void delivery.catch(() => {});
      await Promise.race([callback, delivery]);
      release();
      expect(await writing).toMatchObject({ updated: 1 });
      expect(await delivery).toMatchObject({ delivered: committed });
      expect(await db.getDeliveryCursor(id, "test")).toBeGreaterThan(0);
    } finally {
      release();
      await writing.catch(() => {});
      db.close();
    }
  });
});
