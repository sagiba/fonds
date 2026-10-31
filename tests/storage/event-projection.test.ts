import { drizzle as libsqlDrizzle } from "drizzle-orm/libsql";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createApplication,
  inProcessInvoker,
} from "../../src/application/operations.js";
import { presentWireEvent } from "../../src/application/wire-output.js";
import * as postgresSchema from "../../src/storage/postgres/schema.js";
import { wireEvents as postgresWireEvents } from "../../src/storage/postgres/statements.js";
import * as sqliteSchema from "../../src/storage/sqlite/schema.js";
import { wireEvents as sqliteWireEvents } from "../../src/storage/sqlite/statements.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

describe("public event feed statement", () => {
  const input = { connectionId: "feed", after: 0, limit: 101 };
  it.each([
    [
      "postgres",
      () =>
        postgresWireEvents(
          postgresDrizzle.mock({ schema: postgresSchema }),
          input,
        ).toSQL().sql,
    ],
    [
      "sqlite",
      () =>
        sqliteWireEvents(
          libsqlDrizzle.mock({ schema: sqliteSchema }),
          input,
        ).toSQL().sql,
    ],
  ])(
    "%s selects stored documents only behind their event types",
    (_d, text) => {
      const statement = text();
      for (const column of ["before_json", "after_json"]) {
        const all = statement.split(column).length - 1;
        const guarded = (
          statement.match(
            new RegExp(`then (?:"events"\\.)?"${column}" end`, "g"),
          ) ?? []
        ).length;
        expect(all).toBe(1);
        expect(guarded).toBe(1);
      }
    },
  );
});

for (const backend of backends) {
  describe(`public event feed: ${backend}`, () => {
    let db: Harness;
    const connectionId = "feed";
    let sequence = 0;
    const capture = (amountMinor: number) =>
      db.ingestRun(
        {
          connectionId,
          runId: `feed-${sequence++}`,
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic",
              capturedAt: `2040-08-0${sequence}T00:00:00Z`,
              responseText: JSON.stringify([
                row("feed-row", { amountMinor }),
                row("steady"),
              ]),
            },
          ],
        },
        synthetic,
      );
    beforeEach(async () => {
      db = await open(backend);
      sequence = 0;
      await db.ensureConnection({ id: connectionId, provider: "cal" });
      await capture(-100);
      await capture(-250);
      const [first] = await db.listTransactions({ connectionId });
      await db.editAnnotation({
        transactionId: first!.id,
        expectedVersion: 0,
        notes: "Synthetic note",
      });
    });
    afterEach(() => db?.close());

    it("presents every event exactly as the full feed does", async () => {
      const full = await db.listEvents({ connectionId, limit: 1000 });
      const types = full.map((event) => event.type);
      expect(types).toEqual(
        expect.arrayContaining([
          "sync.baseline",
          "transaction.updated",
          "annotation.updated",
        ]),
      );
      const page = (await inProcessInvoker(createApplication(db)).invoke(
        "list_events",
        { connectionId, limit: 200 },
      )) as { data: unknown[] };
      expect(page.data).toEqual(full.map(presentWireEvent));
      expect(page.data).toContainEqual(
        expect.objectContaining({
          type: "transaction.updated",
          changedFields: ["amount"],
        }),
      );
      expect(page.data).toContainEqual(
        expect.objectContaining({
          type: "sync.baseline",
          summary: { transactionCount: 2, historical: false },
        }),
      );
    });

    // The libSQL HTTP server refuses PRAGMA, so it cannot store corrupt JSON.
    it.skipIf(backend === "libsql-http")(
      "never reads the documents of events whose items do not need them",
      async () => {
        // Deliberately corrupt only this synthetic database.
        const corruption = {
          sql: "UPDATE events SET before_json = ?, after_json = ? WHERE type IN ('transaction.imported', 'transaction.created', 'annotation.updated')",
          args: ["invalid before", "invalid after"],
        };
        if (db.driver.kind === "postgres") {
          await db.raw(corruption.sql, corruption.args);
        } else if (db.driver.kind === "libsql") {
          const tx = await db.driver.client.transaction("write");
          try {
            await tx.execute("PRAGMA ignore_check_constraints = ON");
            await tx.execute(corruption);
            await tx.execute("PRAGMA ignore_check_constraints = OFF");
            await tx.commit();
          } finally {
            tx.close();
          }
        } else {
          const binding = db.driver.binding;
          await binding.batch([
            binding.prepare("PRAGMA ignore_check_constraints = ON"),
            binding.prepare(corruption.sql).bind(...corruption.args),
            binding.prepare("PRAGMA ignore_check_constraints = OFF"),
          ]);
        }
        await expect(
          db.listEvents({ connectionId, limit: 1000 }),
        ).rejects.toThrow();
        const page = (await inProcessInvoker(createApplication(db)).invoke(
          "list_events",
          { connectionId, limit: 200 },
        )) as { data: { type: string }[] };
        expect(page.data.map((event) => event.type)).toContain(
          "annotation.updated",
        );
      },
    );
  });
}
