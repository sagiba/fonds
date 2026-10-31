import { drizzle as libsqlDrizzle } from "drizzle-orm/libsql";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createApplication,
  inProcessInvoker,
  publicError,
} from "../../src/application/operations.js";
import { filtersSchema } from "../../src/application/query-inputs.js";
import * as postgresSchema from "../../src/storage/postgres/schema.js";
import {
  transactionListByIdQuery as postgresListById,
  transactionListQuery as postgresListQuery,
} from "../../src/storage/postgres/statements.js";
import * as sqliteSchema from "../../src/storage/sqlite/schema.js";
import {
  transactionListByIdQuery as sqliteListById,
  transactionListQuery as sqliteListQuery,
} from "../../src/storage/sqlite/statements.js";
import { seedRun, storedRow } from "../helpers/ledger-rows.js";
import {
  backends,
  type Harness,
  insertTransactionFixture,
  open,
} from "../helpers/storage-harness.js";

describe("compact read by ID statement", () => {
  it.each([
    [
      "postgres",
      () =>
        postgresListById(postgresDrizzle.mock({ schema: postgresSchema }), [
          "a",
          "b",
        ]).toSQL().sql,
    ],
    [
      "sqlite",
      () =>
        sqliteListById(libsqlDrizzle.mock({ schema: sqliteSchema }), [
          "a",
          "b",
        ]).toSQL().sql,
    ],
  ])("%s reads the list projection, not the full record", (_d, text) => {
    const statement = text();
    for (const column of [
      "provider_json",
      "additional_information_json",
      "source_aliases_json",
      "source_evidence_json",
      "transaction_observations",
      "transaction_posting_links",
    ]) {
      expect(statement).not.toContain(column);
    }
  });
});

describe("drift checkpoint", () => {
  it("leaves the page statement without the event feed", () => {
    const input = { ...filtersSchema.parse({}), limit: 51 };
    for (const statement of [
      postgresListQuery(
        postgresDrizzle.mock({ schema: postgresSchema }),
        input,
      ).toSQL().sql,
      sqliteListQuery(
        libsqlDrizzle.mock({ schema: sqliteSchema }),
        input,
      ).toSQL().sql,
    ]) {
      expect(statement).not.toContain("events");
    }
  });
});

for (const backend of backends) {
  describe(`transactions by ID: ${backend}`, () => {
    let db: Harness;
    let invoke: (name: string, input: unknown) => Promise<unknown>;
    const connectionId = "batch";
    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({ id: connectionId, provider: "cal" });
      await seedRun(db, connectionId);
      await insertTransactionFixture(db, [
        storedRow(connectionId, "first", {
          merchantName: "First",
          amountMinor: -1500,
        }),
        storedRow(connectionId, "second", {
          merchantName: "Second",
          currency: "JPY",
          amountMinor: -100,
          amountBasis: "booked_entry",
        }),
      ]);
      await db.editAnnotation({
        transactionId: "second",
        expectedVersion: 0,
        category: "groceries",
        notes: "Private synthetic note",
      });
      invoke = inProcessInvoker(createApplication(db)).invoke;
    });
    afterEach(() => db?.close());

    it("returns records in request order and lists missing IDs", async () => {
      expect(
        await invoke("get_transactions", {
          ids: ["second", "missing", "first"],
          view: "summary",
        }),
      ).toEqual({
        data: [
          expect.objectContaining({
            id: "second",
            merchantName: "Second",
            amount: { currency: "JPY", amount: "-100" },
            amountBasis: "booked_entry",
            category: "groceries",
          }),
          expect.objectContaining({
            id: "first",
            amount: { currency: "ILS", amount: "-15.00" },
            category: null,
          }),
        ],
        missingIds: ["missing"],
        latestEventId: expect.any(Number),
      });
      expect(await invoke("get_transactions", { ids: ["missing"] })).toEqual({
        data: [],
        missingIds: ["missing"],
        latestEventId: expect.any(Number),
      });
    });

    it("mirrors the single read for every view", async () => {
      const ids = ["first", "second"];
      const read = (transactionId: string, input: object) =>
        invoke("get_transaction", { transactionId, ...input }).then(
          (result) => (result as { transaction: unknown }).transaction,
        );
      for (const [view, single] of [
        ["compact", { detail: false }],
        ["detail", {}],
        ["evidence", { includeEvidence: true }],
      ] as const) {
        const batch = (await invoke("get_transactions", { ids, view })) as {
          data: unknown[];
        };
        expect(batch.data).toEqual([
          await read("first", single),
          await read("second", single),
        ]);
      }
      const detailed = (await invoke("get_transactions", {
        ids: ["second"],
        view: "detail",
      })) as { data: { annotation: { notes: string } }[] };
      expect(detailed.data[0]!.annotation.notes).toBe("Private synthetic note");
    });

    // The libSQL HTTP server refuses PRAGMA, so it cannot store corrupt JSON.
    it.skipIf(backend === "libsql-http")(
      "reads compact records without the documents only full records decode",
      async () => {
        // Deliberately corrupt only this synthetic database: a full read must fail.
        const corruption = {
          sql: "UPDATE transactions SET provider_json = ?, source_aliases_json = ?, additional_information_json = ?",
          args: ["invalid details", "invalid aliases", "invalid prose"],
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
          invoke("get_transaction", { transactionId: "second" }),
        ).rejects.toThrow();
        expect(
          await invoke("get_transaction", {
            transactionId: "second",
            detail: false,
          }),
        ).toMatchObject({
          transaction: {
            id: "second",
            annotation: { category: "groceries", hasNotes: true },
          },
        });
        expect(
          await invoke("get_transactions", { ids: ["second", "first"] }),
        ).toMatchObject({ data: [{ id: "second" }, { id: "first" }] });
        await expect(
          invoke("get_transaction", {
            transactionId: "missing",
            detail: false,
          }),
        ).rejects.toThrow("not_found");
      },
    );

    it("carries the event feed position each read started from", async () => {
      await db.ensureConnection({ id: "other", provider: "cal" });
      await db.editAnnotation({
        transactionId: "first",
        expectedVersion: 0,
        notes: "Synthetic edit",
      });
      const latest = async (connection?: string) =>
        Math.max(
          0,
          ...(
            await db.listEvents({
              ...(connection && { connectionId: connection }),
              limit: 1000,
            })
          ).map((event) => event.id),
        );
      const scoped = await latest(connectionId);
      expect(scoped).toBeGreaterThan(0);
      expect(
        await invoke("list_transactions", { connectionId, view: "summary" }),
      ).toMatchObject({ latestEventId: scoped });
      expect(
        await invoke("list_transactions", { connectionId: "other" }),
      ).toMatchObject({ data: [], latestEventId: 0 });
      expect(await invoke("list_transactions", {})).toMatchObject({
        latestEventId: await latest(),
      });
      expect(
        await invoke("get_transactions", { ids: ["first"] }),
      ).toMatchObject({ latestEventId: await latest() });
      // A later change moves the checkpoint past the stored value.
      await db.editAnnotation({
        transactionId: "first",
        expectedVersion: 1,
        notes: "Synthetic second edit",
      });
      const moved = (await invoke("list_transactions", { connectionId })) as {
        latestEventId: number;
      };
      expect(moved.latestEventId).toBeGreaterThan(scoped);
      expect(moved.latestEventId).toBe(await latest(connectionId));
    });

    it("rejects duplicate, empty and oversized ID lists", async () => {
      for (const ids of [
        ["first", "first"],
        [],
        Array.from({ length: 101 }, (_, index) => `id-${index}`),
      ]) {
        await expect(invoke("get_transactions", { ids })).rejects.toThrow();
      }
      // A full list of IDs reads in bounded chunks.
      const many = Array.from({ length: 100 }, (_, index) =>
        index === 73 ? "first" : `absent-${index}`,
      );
      const result = (await invoke("get_transactions", {
        ids: many,
        view: "compact",
      })) as { data: { id: string }[]; missingIds: string[] };
      expect(result.data.map((item) => item.id)).toEqual(["first"]);
      expect(result.missingIds).toHaveLength(99);
    });

    it("fails a result over the response limit instead of trimming records", async () => {
      const prose = Array.from({ length: 60 }, () => "p".repeat(4000));
      await insertTransactionFixture(db, [
        storedRow(connectionId, "long-a", {
          details: {
            ...storedRow(connectionId, "long-a").details,
            additionalInformation: prose,
          },
        }),
        storedRow(connectionId, "long-b", {
          details: {
            ...storedRow(connectionId, "long-b").details,
            additionalInformation: prose,
          },
        }),
      ]);
      const failure = await invoke("get_transactions", {
        ids: ["long-a", "long-b"],
        view: "detail",
      }).catch((error: unknown) => error);
      expect(publicError(failure).code).toBe("output_too_large");
      // Each alone fits, and the compact view of both does.
      await expect(
        invoke("get_transactions", { ids: ["long-a"], view: "detail" }),
      ).resolves.toBeDefined();
      await expect(
        invoke("get_transactions", { ids: ["long-a", "long-b"] }),
      ).resolves.toBeDefined();
    });
  });
}
