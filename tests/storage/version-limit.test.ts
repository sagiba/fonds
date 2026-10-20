import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "../../src/domain/errors.js";
import type { TransactionInput } from "../../src/domain/model.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

const limit = Number.MAX_SAFE_INTEGER;

async function expectExhausted(action: Promise<unknown>) {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ConflictError);
  expect((error as Error).message).toBe("Version limit reached");
}

for (const backend of backends) {
  describe(`version limit: ${backend}`, () => {
    let db: Harness;
    let day: number;

    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({ id: "synthetic", provider: "cal" });
      day = 0;
    });

    afterEach(async () => db?.close());

    async function capture(inputs: TransactionInput[]) {
      day++;
      return db.ingestRun(
        {
          connectionId: "synthetic",
          runId: `limit-${day}`,
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:limit",
              capturedAt: `2040-08-0${day}T00:00:00Z`,
              responseText: JSON.stringify(inputs),
            },
          ],
        },
        synthetic,
      );
    }

    async function transaction(sourceKey: string) {
      const rows = await db.listTransactions();
      return rows.find((entry) => entry.sourceKey === sourceKey)!;
    }

    async function setVersion(
      table: "transactions" | "annotations",
      id: string,
      version: number,
    ) {
      const key = table === "transactions" ? "id" : "transaction_id";
      await db.raw(`UPDATE ${table} SET version = ? WHERE ${key} = ?`, [
        version,
        id,
      ]);
    }

    async function state() {
      return {
        rows: await db.listTransactions({ includeSuperseded: true }),
        events: await db.listEvents({}),
      };
    }

    it("advances an annotation to the limit, then refuses edits and undo", async () => {
      await capture([row("a")]);
      const { id } = await transaction("a");
      await db.editAnnotation({
        transactionId: id,
        expectedVersion: 0,
        notes: "First",
      });
      await setVersion("annotations", id, limit - 1);
      const last = await db.editAnnotation({
        transactionId: id,
        expectedVersion: limit - 1,
        notes: "Last",
      });
      expect(last).toMatchObject({ version: limit, data: { notes: "Last" } });
      const before = await state();
      const change = before.events.at(-1)!;
      expect(change).toMatchObject({
        type: "annotation.updated",
        after: { version: limit },
      });
      await expectExhausted(
        db.editAnnotation({
          transactionId: id,
          expectedVersion: limit,
          notes: "Beyond",
        }),
      );
      await expectExhausted(
        db.undoAnnotation({ eventId: change.id, expectedVersion: limit }),
      );
      // An edit that changes nothing writes no version.
      await expect(
        db.editAnnotation({
          transactionId: id,
          expectedVersion: limit,
          notes: "Last",
        }),
      ).resolves.toMatchObject({ version: limit });
      expect(await state()).toEqual(before);
    });

    it("refuses a source change to a transaction at the limit", async () => {
      await capture([row("a")]);
      const { id } = await transaction("a");
      await setVersion("transactions", id, limit);
      // Unchanged facts keep the version, so the read still applies.
      expect(await capture([row("a")])).toMatchObject({ updated: 0 });
      expect(await transaction("a")).toMatchObject({ version: limit });
      const before = await state();
      await expectExhausted(capture([row("a", { amountMinor: -200 })]));
      expect(await state()).toEqual(before);
    });

    it("refuses to unlist a transaction at the limit", async () => {
      await capture([row("a"), row("b")]);
      const { id } = await transaction("a");
      await setVersion("transactions", id, limit);
      const before = await state();
      await expectExhausted(capture([row("b")]));
      expect(await state()).toEqual(before);
    });

    it("refuses an owner removal at the limit", async () => {
      await capture([row("a"), row("b")]);
      await capture([row("b")]);
      const { id } = await transaction("a");
      await setVersion("transactions", id, limit);
      const before = await state();
      await expectExhausted(
        db.confirmRemoval({
          transactionId: id,
          expectedVersion: limit,
          reason: "Synthetic removal",
        }),
      );
      expect(await state()).toEqual(before);
    });
  });
}
