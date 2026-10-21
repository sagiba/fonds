import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deliverFromStore,
  DeliveryConflictError,
} from "../../src/application/change-delivery.js";
import type { InternalStore } from "../../src/application/financial-store.js";
import type { LedgerEvent as ChangeRow } from "../../src/domain/records.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

const consumerId = "synthetic-notifications";
const responseText = readFileSync(
  new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
  "utf8",
);

async function baseline(db: InternalStore, id: string) {
  await db.ensureConnection({ id, provider: "cal" });
  await db.ingestRun(
    {
      connectionId: id,
      runId: `${id}-baseline`,
      responses: [
        {
          accountKey: "synthetic-account",
          endpoint: "/synthetic-financial-response",
          capturedAt: "2040-08-01T00:00:00Z",
          responseText,
        },
      ],
    },
    calAdapter,
  );
}

async function annotate(db: InternalStore, id: string, version = 0) {
  await db.editAnnotation({
    transactionId: (await db.listTransactions({ connectionId: id }))[0]!.id,
    expectedVersion: version,
    notes: `Synthetic note ${version + 1}`,
  });
}

for (const backend of backends) {
  describe(`durable change delivery: ${backend}`, () => {
    let db: Harness;
    let connectionId: string;
    let options: { connectionId: string; consumerId: string };
    beforeEach(async () => {
      db = await open(backend);
      connectionId = `delivery-${randomUUID()}`;
      options = { connectionId, consumerId };
      await baseline(db, connectionId);
    });
    afterEach(() => db?.close());

    it("delivers ordered, connection-scoped run and transaction changes in bounded pages", async () => {
      await baseline(db, `${connectionId}-other`);
      await annotate(db, connectionId);
      await annotate(db, `${connectionId}-other`);
      await annotate(db, connectionId, 1);
      const expected = await db.listEvents({ connectionId });
      expect(expected.map((change) => change.type)).toEqual([
        ...Array<string>(
          (await db.listTransactions({ connectionId })).length,
        ).fill("transaction.imported"),
        "sync.baseline",
        "annotation.updated",
        "annotation.updated",
      ]);
      const received: ChangeRow[] = [];
      const first = await deliverFromStore(
        db,
        { ...options, limit: 2 },
        async (message) => {
          await db.updateConfig(connectionId, (config) => config);
          expect(message.deliveryKey).toBe(
            JSON.stringify([connectionId, message.event.id]),
          );
          received.push(message.event);
        },
      );
      expect(first).toEqual({ delivered: 2, cursor: expected[1]!.id });
      const second = await deliverFromStore(
        db,
        options,
        async ({ event: change }) => {
          received.push(change);
        },
      );
      expect(second).toEqual({
        delivered: expected.length - 2,
        cursor: expected.at(-1)!.id,
      });
      expect(received).toEqual(expected);
      expect(
        await db.getDeliveryCursor(`${connectionId}-other`, consumerId),
      ).toBe(0);
    });

    it("does not deliver an acknowledged change again", async () => {
      const first = await deliverFromStore(db, options, async () => {});
      const repeated = await deliverFromStore(db, options, async () => {
        throw new Error("Already delivered");
      });
      expect(repeated).toEqual({ delivered: 0, cursor: first.cursor });
    });

    it("returns cursor zero for a new connection with no changes", async () => {
      await db.ensureConnection({
        id: `${connectionId}-empty`,
        provider: "cal",
      });
      expect(
        await deliverFromStore(
          db,
          { ...options, connectionId: `${connectionId}-empty` },
          async () => {
            throw new Error("No change expected");
          },
        ),
      ).toEqual({ delivered: 0, cursor: 0 });
    });

    it("keeps independent consumers and preserves configuration updates during delivery", async () => {
      const received: number[] = [];
      await deliverFromStore(
        db,
        { ...options, limit: 1 },
        async ({ event: change }) => {
          const other = await deliverFromStore(
            db,
            { ...options, consumerId: "other-consumer", limit: 1 },
            async ({ event: change }) => {
              received.push(change.id);
            },
          );
          expect(other.cursor).toBe(change.id);
          await db.updateConfig(connectionId, (config) => ({
            ...config,
            syntheticSetting: "keep",
          }));
          received.push(change.id);
        },
      );
      const config = (await db.getStoredConnection(connectionId))!.config;
      expect(config).toMatchObject({
        schemaVersion: 1,
        syntheticSetting: "keep",
        changeCursors: {
          [consumerId]: received[0],
          "other-consumer": received[0],
        },
      });
      expect(received).toHaveLength(2);
    });

    it("rejects overlapping delivery for one consumer and releases its guard afterwards", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = deliverFromStore(db, options, async () => gate);
      try {
        await expect(
          deliverFromStore(db, options, async () => {}),
        ).rejects.toThrow(DeliveryConflictError);
      } finally {
        release();
      }
      const result = await first;
      expect(await deliverFromStore(db, options, async () => {})).toEqual({
        delivered: 0,
        cursor: result.cursor,
      });
    });

    it("detects a changed cursor without overwriting it", async () => {
      await expect(
        deliverFromStore(db, options, async ({ event: change }) => {
          await db.raw("UPDATE connections SET config_json = ? WHERE id = ?", [
            JSON.stringify({
              schemaVersion: 1,
              changeCursors: { [consumerId]: change.id },
            }),
            connectionId,
          ]);
        }),
      ).rejects.toThrow(DeliveryConflictError);
      expect(await db.getDeliveryCursor(connectionId, consumerId)).toBe(
        (await db.listEvents())[0]!.id,
      );
    });

    it("rejects missing connections and invalid IDs, limits, or stored cursors", async () => {
      await expect(db.getDeliveryCursor("missing", consumerId)).rejects.toThrow(
        "Connection not found",
      );
      await expect(
        deliverFromStore(
          db,
          { ...options, connectionId: "missing" },
          async () => {},
        ),
      ).rejects.toThrow("Connection not found");
      await expect(db.getDeliveryCursor(connectionId, "")).rejects.toThrow();
      await expect(
        deliverFromStore(db, { ...options, connectionId: "" }, async () => {}),
      ).rejects.toThrow();
      for (const limit of [0, -1, 1.5, 1001, Number.POSITIVE_INFINITY]) {
        await expect(
          deliverFromStore(db, { ...options, limit }, async () => {}),
        ).rejects.toThrow();
      }
      await db.raw("UPDATE connections SET config_json = ? WHERE id = ?", [
        JSON.stringify({
          schemaVersion: 1,
          changeCursors: { [consumerId]: -1 },
        }),
        connectionId,
      ]);
      await expect(
        db.getDeliveryCursor(connectionId, consumerId),
      ).rejects.toThrow();
    });

    it("keeps delivery callbacks outside the transaction that acknowledges their cursor", async () => {
      const received: ChangeRow[] = [];
      const result = await deliverFromStore(
        db,
        options,
        async ({ event: change }) => {
          await db.updateConfig(connectionId, (config) => ({
            ...config,
            syntheticDelivery: true,
          }));
          received.push(change);
        },
      );
      expect(received.length).toBe(result.delivered);
      expect(await db.getDeliveryCursor(connectionId, consumerId)).toBe(
        result.cursor,
      );
      expect(
        (await db.getStoredConnection(connectionId))?.config.syntheticDelivery,
      ).toBe(true);
    });

    it.each(["constructor", "toString", "__proto__"])(
      "supports the consumer ID %s without inherited cursor values",
      async (id) => {
        expect(await db.getDeliveryCursor(connectionId, id)).toBe(0);
        const result = await deliverFromStore(
          db,
          { ...options, consumerId: id },
          async () => {},
        );
        expect(await db.getDeliveryCursor(connectionId, id)).toBe(
          result.cursor,
        );
      },
    );
  });
}

// These cases close/reopen or back up a SQLite file to verify durable checkpoints.
describe("SQLite-only delivery file recovery", () => {
  let db: Database;
  let directory: string;
  let filename: string;
  let connectionId: string;
  let options: { connectionId: string; consumerId: string };
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "financial-delivery-test-"));
    filename = join(directory, "service.sqlite");
    db = await openDatabase(filename);
    connectionId = `delivery-recovery-${randomUUID()}`;
    options = { connectionId, consumerId };
    await baseline(db, connectionId);
  });
  afterEach(async () => {
    await db?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it("discovers baseline and history rows through paged imports across restart without a wake-up", async () => {
    const historicalRows = Array.from({ length: 7 }, (_, index) =>
      row(`historical-${index}`),
    );
    const historyInput = {
      connectionId,
      runId: "historical-import",
      responses: [
        {
          accountKey: "account",
          endpoint: "/history",
          capturedAt: "2040-08-02T00:00:00Z",
          scope: { kind: "history" as const },
          responseText: JSON.stringify(historicalRows),
        },
      ],
    };
    const historyAdapter = {
      ...synthetic,
      extract: (...args: Parameters<typeof synthetic.extract>) => ({
        ...synthetic.extract(...args),
        historical: true,
      }),
    };
    await db.ingestRun(historyInput, historyAdapter);
    const expectedRows = await db.listTransactions({ connectionId });
    const expectedChanges = await db.listEvents({ connectionId });
    expect(
      expectedChanges.filter(
        (change) => change.type === "transaction.imported",
      ),
    ).toHaveLength(expectedRows.length);
    expect(
      expectedChanges.filter((change) => change.type === "transaction.created"),
    ).toEqual([]);
    const importedIds: string[] = [];
    const receivedIds: number[] = [];
    const receive = async ({ event: change }: { event: ChangeRow }) => {
      receivedIds.push(change.id);
      if (change.type === "transaction.imported") {
        expect(change.transactionId).not.toBeNull();
        const current = await db.getTransaction(change.transactionId!);
        expect(current?.id).toBe(change.transactionId);
        importedIds.push(current!.id);
      }
    };
    // Poll the durable feed directly: a missed webhook cannot hide imports.
    const first = await deliverFromStore(db, { ...options, limit: 3 }, receive);
    expect(first.delivered).toBe(3);
    await db.close();
    db = await openDatabase(filename);
    expect(await db.getDeliveryCursor(connectionId, consumerId)).toBe(
      first.cursor,
    );
    let delivered;
    do {
      ({ delivered } = await deliverFromStore(
        db,
        { ...options, limit: 3 },
        receive,
      ));
    } while (delivered > 0);
    expect(receivedIds).toEqual(expectedChanges.map((change) => change.id));
    expect(new Set(importedIds).size).toBe(expectedRows.length);
    expect(importedIds.sort()).toEqual(
      expectedRows.map((current) => current.id).sort(),
    );

    await baseline(db, connectionId);
    expect(await db.ingestRun(historyInput, historyAdapter)).toMatchObject({
      replayed: true,
    });
    expect(await db.listEvents({ connectionId })).toEqual(expectedChanges);
    expect(await deliverFromStore(db, options, receive)).toMatchObject({
      delivered: 0,
    });

    // Subsequent recent discovery, financial correction and annotation remain distinct.
    await db.ingestRun(
      {
        ...historyInput,
        runId: "recent-after-history",
        responses: [
          {
            ...historyInput.responses[0]!,
            capturedAt: "2040-08-03T00:00:00Z",
            scope: { kind: "recent" },
            responseText: JSON.stringify([
              ...historicalRows.map((current, index) =>
                index === 0 ? { ...current, amountMinor: -200 } : current,
              ),
              row("fresh-discovery"),
            ]),
          },
        ],
      },
      synthetic,
    );
    const corrected = (await db.listTransactions({ connectionId })).find(
      (current) => current.sourceKey === "historical-0",
    )!;
    await db.editAnnotation({
      transactionId: corrected.id,
      expectedVersion: 0,
      notes: "Independent note after financial correction",
    });
    const afterImports = await db.listEvents({
      connectionId,
      after: expectedChanges.at(-1)!.id,
    });
    expect(
      afterImports
        .filter((change) => change.type !== "transaction.restored")
        .map((change) => change.type),
    ).toEqual([
      "transaction.updated",
      "transaction.created",
      "annotation.updated",
    ]);
    expect(
      afterImports.filter((change) => change.type === "transaction.restored"),
    ).toHaveLength(historicalRows.length);
    expect(
      afterImports.find((change) => change.type === "transaction.updated")!
        .transactionId,
    ).not.toBe(
      afterImports.find((change) => change.type === "transaction.created")!
        .transactionId,
    );
    expect(
      afterImports.find((change) => change.type === "annotation.updated"),
    ).toMatchObject({ transactionId: corrected.id });
    expect(
      afterImports.find((change) => change.type === "transaction.updated"),
    ).toMatchObject({ transactionId: corrected.id });
    await deliverFromStore(db, options, receive);
    expect(importedIds).toHaveLength(expectedRows.length);
  });

  it("stops on callback failure and resumes from the last checkpoint after reopening", async () => {
    await annotate(db, connectionId);
    await annotate(db, connectionId, 1);
    const expected = await db.listEvents({ connectionId });
    const attempted: number[] = [];
    await expect(
      deliverFromStore(db, options, async ({ event: change }) => {
        attempted.push(change.id);
        if (change.id === expected[1]!.id) {
          throw new Error("Synthetic send failure");
        }
      }),
    ).rejects.toThrow("Synthetic send failure");
    expect(attempted).toEqual(expected.slice(0, 2).map((change) => change.id));
    expect(await db.getDeliveryCursor(connectionId, consumerId)).toBe(
      expected[0]!.id,
    );
    await db.close();
    db = await openDatabase(filename);
    const received: number[] = [];
    expect(
      await deliverFromStore(db, options, async ({ event: change }) => {
        received.push(change.id);
      }),
    ).toEqual({ delivered: expected.length - 1, cursor: expected.at(-1)!.id });
    expect(received).toEqual(expected.slice(1).map((change) => change.id));
  });

  it("retries the same delivery key after a send succeeds but its checkpoint fails", async () => {
    await db.client
      .executeMultiple(`CREATE TRIGGER synthetic_ack_failure BEFORE UPDATE OF config_json ON connections
      BEGIN SELECT RAISE(ABORT, 'synthetic acknowledgement failure'); END;`);
    const attempts: string[] = [];
    const notified = new Set<string>();
    const userNotifications: number[] = [];
    const receive = async ({
      deliveryKey,
      event: change,
    }: {
      deliveryKey: string;
      event: ChangeRow;
    }) => {
      attempts.push(deliveryKey);
      if (notified.has(deliveryKey)) {
        return;
      }
      notified.add(deliveryKey);
      userNotifications.push(change.id);
    };
    await expect(deliverFromStore(db, options, receive)).rejects.toMatchObject({
      cause: {
        message: expect.stringContaining("synthetic acknowledgement failure"),
      },
    });
    expect(await db.getDeliveryCursor(connectionId, consumerId)).toBe(0);
    await db.client.executeMultiple("DROP TRIGGER synthetic_ack_failure");
    await db.close();
    db = await openDatabase(filename);
    expect(
      await deliverFromStore(db, { ...options, limit: 1 }, receive),
    ).toEqual({
      delivered: 1,
      cursor: (await db.listEvents({ connectionId }))[0]!.id,
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
    expect(userNotifications).toHaveLength(1);
  });

  it("backs up and restores delivery checkpoints with the changes they acknowledge", async () => {
    const result = await deliverFromStore(db, options, async () => {});
    const backupPath = join(directory, "backup.sqlite");
    await db.backup(backupPath);
    const restored = await openDatabase(backupPath);
    try {
      expect(await restored.getDeliveryCursor(connectionId, consumerId)).toBe(
        result.cursor,
      );
      expect(
        await deliverFromStore(restored, options, async () => {
          throw new Error("Backup checkpoint was lost");
        }),
      ).toEqual({ delivered: 0, cursor: result.cursor });
    } finally {
      await restored.close();
    }
  });
});
