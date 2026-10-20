import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { emptyDetails, unknownLedgerFacts } from "../../src/domain/model.js";
import type { Transaction } from "../../src/domain/records.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import {
  cards,
  syncRuns,
  transactions,
} from "../../src/storage/sqlite/schema.js";
import { row, synthetic } from "../helpers/storage-harness.js";

it("loads lifecycle annotations by scoped join beyond SQLite's parameter limit", async () => {
  const db = await openDatabase(":memory:");
  try {
    await db.ensureConnection({
      id: "synthetic-large-account",
      provider: "cal",
    });
    await db.orm
      .insert(syncRuns)
      .values({
        id: "synthetic-run",
        connectionId: "synthetic-large-account",
        startedAt: "2040-01-01T00:00:00Z",
        status: "started",
        collectorVersion: "synthetic",
        parserVersion: "synthetic",
        snapshot: { schemaVersion: 1, responses: [] },
        coverage: [],
        warnings: [],
      })
      .run();
    const input = calAdapter.extract(
      readFileSync(
        new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
        "utf8",
      ),
      { accountKey: "account", runId: "synthetic-run" },
    ).transactions[0]!;
    const { cardKey, ...facts } = input;
    const template: Transaction = {
      ...facts,
      ...unknownLedgerFacts(cardKey),
      id: "template",
      sourceKey: "synthetic",
      connectionId: "synthetic-large-account",
      details: emptyDetails(),
      status: "posted",
      presence: "seen",
      firstSeenAt: "2040-01-01T00:00:00Z",
      lastSeenAt: "2040-01-01T00:00:00Z",
      lastSeenRunId: "synthetic-run",
      version: 1,
      supersededById: null,
    };
    await db.orm.insert(cards).values({
      id: template.cardId!,
      connectionId: template.connectionId,
      providerKey: cardKey!,
      createdAt: template.firstSeenAt,
    });
    await db.orm.transaction(async (tx) => {
      for (let offset = 0; offset < 33_000; offset += 250) {
        await tx
          .insert(transactions)
          .values(
            Array.from({ length: 250 }, (_, index) => ({
              ...template,
              id: `synthetic-${offset + index}`,
            })),
          )
          .run();
      }
    });
    expect(
      await db.confirmRemoval({
        transactionId: "synthetic-0",
        expectedVersion: 1,
        reason: "Synthetic removal",
      }),
    ).toMatchObject({ presence: "removed", version: 2 });
    expect(await db.getTransaction("synthetic-32999")).toMatchObject({
      presence: "seen",
      version: 1,
    });
  } finally {
    await db.close();
  }
}, 15_000);

it("updates existing rows without changing their SQLite insertion order", async () => {
  const db = await openDatabase(":memory:");
  try {
    await db.ensureConnection({ id: "synthetic", provider: "cal" });
    const capture = (runId: string, description: string) =>
      db.ingestRun(
        {
          runId,
          connectionId: "synthetic",
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:recent",
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: JSON.stringify([
                row("primary", { description }),
                row("related"),
              ]),
            },
          ],
        },
        synthetic,
      );
    await capture("first", "Original");
    const before = (
      await db.client.execute(
        "SELECT rowid,id FROM transactions ORDER BY rowid",
      )
    ).rows;
    await capture("second", "Updated");
    expect(
      (
        await db.client.execute(
          "SELECT rowid,id FROM transactions ORDER BY rowid",
        )
      ).rows,
    ).toEqual(before);
    expect(
      (await db.listTransactions()).find((row) => row.sourceKey === "primary")
        ?.description,
    ).toBe("Updated");
  } finally {
    await db.close();
  }
});

it("rejects an event cursor that cannot be acknowledged", async () => {
  const db = await openDatabase(":memory:");
  try {
    // Model corrupted external state; fresh schema constraints reject this ID.
    await db.ensureConnection({ id: "synthetic", provider: "cal" });
    await db.client.execute("PRAGMA ignore_check_constraints = ON");
    await db.client.execute(
      "INSERT INTO events (id, connection_id, type, created_at, actor) VALUES (-1, 'synthetic', 'synthetic', '2040-08-01T00:00:00Z', 'test')",
    );
    await expect(db.latestEventId()).rejects.toThrow("Invalid event cursor");
  } finally {
    await db.close();
  }
});
