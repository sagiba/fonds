import { describe, expect, it } from "vitest";

import { unknownLedgerFacts } from "../../src/domain/model.js";
import type { Connection, Transaction } from "../../src/domain/records.js";
import type { Statements } from "../../src/storage/statements.js";
import { createStore, type StoreDatabase } from "../../src/storage/store.js";
import { narrowFacts } from "../../src/storage/transaction-codec.js";
import { row } from "../helpers/storage-harness.js";

const connection: Connection = {
  id: "synthetic",
  provider: "cal",
  displayName: "Synthetic",
  config: { schemaVersion: 1 },
  createdAt: "2040-07-01T00:00:00Z",
};

function transaction(id: string): Transaction {
  const { cardKey: _cardKey, ...facts } = row(id);
  return {
    ...facts,
    counterpartyName: facts.counterpartyName ?? null,
    ...unknownLedgerFacts("card"),
    id,
    connectionId: connection.id,
    presence: "seen",
    firstSeenAt: "2040-07-01T00:00:00Z",
    lastSeenAt: "2040-07-01T00:00:00Z",
    lastSeenRunId: "run",
    version: 1,
    supersededById: null,
  };
}

function mockD1(changeRevision: boolean) {
  const data = Array.from({ length: 101 }, (_, i) =>
    transaction(`row-${String(i).padStart(3, "0")}`),
  );
  let locks = 0;
  let reads = 0;
  let writes = 0;
  const driver: StoreDatabase<object> = {
    backend: "d1",
    identity: {},
    root: {},
    execute: async (statement) => statement,
    transaction: async (work) => work({}),
    commit: async () => {
      writes++;
      return [] as never;
    },
  };
  const statements = {
    repairLockConnectionOf: async () => [
      { ...connection, revision: ++locks === 1 || !changeRevision ? 1 : 2 },
    ],
    repairLedgerRows: async (
      _db: object,
      _connectionId: string,
      _anchorId: string,
      afterId: string | undefined,
      limit: number,
    ) => {
      reads++;
      return data
        .filter((item) => afterId === undefined || item.id > afterId)
        .slice(0, limit)
        .map((item, i) => ({
          row: narrowFacts(item),
          annotation: null,
          doubt: false,
          position: data.indexOf(item) + i,
        }));
    },
  } as unknown as Statements<object>;
  return {
    store: createStore(driver, statements),
    counts: () => ({ locks, reads, writes }),
  };
}

describe("D1 repair revision guard", () => {
  it.each(["preview", "apply"] as const)(
    "rejects a changed revision after all candidate pages on %s",
    async (mode) => {
      const { store, counts } = mockD1(true);
      await expect(
        store.repairExactPostings({
          transactionId: "row-000",
          from: "2040-07-01",
          to: "2040-07-31",
          reason: "Synthetic",
          mode,
          ...(mode === "apply" ? { expected: [] } : {}),
        }),
      ).rejects.toThrow("changed concurrently");
      expect(counts()).toEqual({ locks: 2, reads: 2, writes: 0 });
    },
  );
  it("returns a stable preview only after the final revision read", async () => {
    const { store, counts } = mockD1(false);
    expect(
      await store.repairExactPostings({
        transactionId: "row-000",
        from: "2040-07-01",
        to: "2040-07-31",
        reason: "Synthetic",
        mode: "preview",
      }),
    ).toEqual({ mode: "preview", pairs: [] });
    expect(counts()).toEqual({ locks: 2, reads: 2, writes: 0 });
  });
});
