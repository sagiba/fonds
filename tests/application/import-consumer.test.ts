import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createApplication } from "../../src/application/operations.js";
import {
  eventListOutputSchema,
  transactionReadOutputSchema,
} from "../../src/application/wire-output.js";
import type { RunInput } from "../../src/domain/plans/sync.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import { row, synthetic } from "../helpers/storage-harness.js";

it("bootstraps a public event-feed consumer through paged imports and resumes its checkpoint after restart", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "fonds-public-import-consumer-"),
  );
  const databasePath = join(directory, "service.sqlite");
  const checkpointPath = join(directory, "consumer-cursor.json");
  let db = await openDatabase(databasePath);
  try {
    const connectionId = "public-import-consumer";
    await db.ensureConnection({ id: connectionId, provider: "cal" });
    const initialRows = Array.from({ length: 7 }, (_, index) =>
      row(`initial-${index}`),
    );
    const historicalRows = Array.from({ length: 7 }, (_, index) =>
      row(`history-${index}`),
    );
    const initial: RunInput = {
      connectionId,
      runId: "public-initial",
      responses: [
        {
          accountKey: "account",
          endpoint: "/recent",
          capturedAt: "2040-08-01T00:00:00Z",
          responseText: JSON.stringify(initialRows),
        },
      ],
    };
    const history: RunInput = {
      connectionId,
      runId: "public-history",
      responses: [
        {
          accountKey: "account",
          endpoint: "/history",
          capturedAt: "2040-08-02T00:00:00Z",
          scope: { kind: "history" },
          responseText: JSON.stringify(historicalRows),
        },
      ],
    };
    const historicalAdapter: SourceAdapter = {
      ...synthetic,
      extract: (...args) => ({
        ...synthetic.extract(...args),
        historical: true,
      }),
    };
    await db.ingestRun(initial, synthetic);
    await db.ingestRun(history, historicalAdapter);

    let application = createApplication(db);
    const execute = (name: string, input: unknown) =>
      application.operations
        .find((operation) => operation.name === name)!
        .execute(input);
    const pageAfter = async (cursor: string | undefined) =>
      eventListOutputSchema.parse(
        await execute("list_events", {
          connectionId,
          ...(cursor !== undefined && { cursor }),
          limit: 3,
        }),
      );
    const currentTransactions = new Map<string, string>();
    const processedChangeIds = new Set<number>();
    const purchaseAlerts: string[] = [];
    const summaries: { transactionCount: number; historical: boolean }[] = [];
    const consume = async (page: Awaited<ReturnType<typeof pageAfter>>) => {
      expect(page.data.length).toBeLessThanOrEqual(3);
      for (const change of page.data) {
        expect(processedChangeIds.has(change.id)).toBe(false);
        processedChangeIds.add(change.id);
        expect(change).not.toHaveProperty("before");
        expect(change).not.toHaveProperty("after");
        if (change.type === "sync.baseline") {
          expect(change.transactionId).toBeNull();
          expect(Object.keys(change.summary!).sort()).toEqual([
            "historical",
            "transactionCount",
          ]);
          summaries.push(change.summary!);
          continue;
        }
        expect(["transaction.imported", "transaction.created"]).toContain(
          change.type,
        );
        const { transaction } = transactionReadOutputSchema.parse(
          await execute("get_transaction", {
            transactionId: change.transactionId,
            detail: false,
          }),
        );
        expect(transaction).toMatchObject({
          id: change.transactionId,
          amount: { amount: "-1.00", currency: "ILS" },
          amountBasis: "purchase_commitment",
          status: "posted",
        });
        currentTransactions.set(transaction.id, change.type);
        if (change.type === "transaction.created") {
          purchaseAlerts.push(transaction.id);
        }
      }
      // A consumer persists its own checkpoint after processing the complete page.
      await writeFile(checkpointPath, JSON.stringify(page.nextCursor));
    };

    // Poll without receiving a webhook; reads are repeatable until the consumer checkpoints.
    const first = await pageAfter(undefined);
    expect(first.data).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    expect(await pageAfter(undefined)).toEqual(first);
    await consume(first);
    await db.close();
    db = await openDatabase(databasePath);
    application = createApplication(db);
    let checkpoint: string = JSON.parse(await readFile(checkpointPath, "utf8"));
    expect(checkpoint).toBe(first.nextCursor);
    for (;;) {
      const page = await pageAfter(checkpoint);
      if (page.data.length === 0) {
        // An empty page still returns a resumable checkpoint.
        expect(page.hasMore).toBe(false);
        expect(page.nextCursor).toBe(checkpoint);
        break;
      }
      await consume(page);
      checkpoint = page.nextCursor;
    }
    expect(currentTransactions.size).toBe(14);
    expect([...currentTransactions.values()]).toEqual(
      Array<string>(14).fill("transaction.imported"),
    );
    expect(processedChangeIds.size).toBe(16);
    expect(summaries).toEqual([
      { transactionCount: 7, historical: false },
      { transactionCount: 7, historical: true },
    ]);
    expect(purchaseAlerts).toEqual([]);

    expect(await db.ingestRun(initial, synthetic)).toMatchObject({
      replayed: true,
    });
    expect(await db.ingestRun(history, historicalAdapter)).toMatchObject({
      replayed: true,
    });
    expect((await pageAfter(checkpoint)).data).toEqual([]);

    // Only a genuinely new recent discovery enters the consumer's purchase-alert path.
    await db.ingestRun(
      {
        ...initial,
        runId: "public-fresh-discovery",
        responses: [
          {
            ...initial.responses[0]!,
            capturedAt: "2040-08-03T00:00:00Z",
            responseText: JSON.stringify([...initialRows, row("fresh")]),
          },
        ],
      },
      synthetic,
    );
    const fresh = await pageAfter(checkpoint);
    expect(fresh.data.map((change) => change.type)).toEqual([
      "transaction.created",
    ]);
    await consume(fresh);
    expect(purchaseAlerts).toHaveLength(1);
    expect(purchaseAlerts[0]).toBe(fresh.data[0]!.transactionId);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
