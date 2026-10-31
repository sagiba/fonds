import { drizzle as libsqlDrizzle } from "drizzle-orm/libsql";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createApplication,
  inProcessInvoker,
  publicError,
} from "../../src/application/operations.js";
import * as postgresSchema from "../../src/storage/postgres/schema.js";
import { transactionListByIdQuery as postgresListById } from "../../src/storage/postgres/statements.js";
import * as sqliteSchema from "../../src/storage/sqlite/schema.js";
import { transactionListByIdQuery as sqliteListById } from "../../src/storage/sqlite/statements.js";
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
      });
      expect(await invoke("get_transactions", { ids: ["missing"] })).toEqual({
        data: [],
        missingIds: ["missing"],
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
