import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

function queryText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    if ("sql" in value && typeof value.sql === "string") {
      return value.sql;
    }
    if ("text" in value && typeof value.text === "string") {
      return value.text;
    }
  }
  throw new Error("Unrecognized synthetic query shape");
}

async function observe(db: Harness) {
  const sources: Array<() => string[]> = [];
  if (db.driver.kind === "postgres") {
    const client = await db.driver.pool.connect();
    const spy = vi.spyOn(client, "query");
    client.release();
    sources.push(() => spy.mock.calls.map(([query]) => queryText(query)));
  } else if (db.driver.kind === "d1") {
    // Drizzle prepares every D1 statement, including each member of a batch.
    const spy = vi.spyOn(db.driver.binding, "prepare");
    sources.push(() => spy.mock.calls.map(([query]) => query));
  } else {
    const client = db.driver.client;
    const spy = vi.spyOn(client, "execute");
    sources.push(() => spy.mock.calls.map(([query]) => queryText(query)));
    const transaction = client.transaction.bind(client);
    vi.spyOn(client, "transaction").mockImplementation(
      async (...args: Parameters<typeof transaction>) => {
        const tx = await transaction(...args);
        const execute = vi.spyOn(tx, "execute");
        sources.push(() =>
          execute.mock.calls.map(([query]) => queryText(query)),
        );
        return tx;
      },
    );
  }
  return () => {
    const queries = sources
      .flatMap((source) => source())
      .filter(
        (query) => !/^(begin|commit|rollback|savepoint|release)\b/i.test(query),
      );
    const reads = queries.filter((query) => /^select\b/i.test(query));
    return {
      total: queries.length,
      reads: reads.length,
      writes: queries.length - reads.length,
      fullSnapshots: reads.filter(
        (query) =>
          query.includes("snapshot_json") && !query.includes("json_object("),
      ).length,
    };
  };
}

for (const backend of backends) {
  describe(`statement budgets: ${backend}`, () => {
    let db: Harness;
    let count: Awaited<ReturnType<typeof observe>>;
    let connectionId: string;
    let sequence = 0;
    // D1 leads each write batch with its revision guard and binds at most 100 parameters.
    const guard = backend === "d1-local" ? 1 : 0;
    // PostgreSQL serializes allocation of the global feed until commit.
    const feedLock = backend === "postgres" ? 1 : 0;
    // D1's bound-parameter limit applies independently to each physical table.
    const [transactionRows, changeRows] =
      backend === "d1-local" ? [2, 11] : [25, 100];
    const [observationRows, reconciliationRows, postingLinkRows] =
      backend === "d1-local" ? [25, 11, 50] : [100, 100, 100];
    const capture = (
      rows = [
        row("pending", { status: "pending", amountBasis: "authorization" }),
        row("posted"),
      ],
    ) =>
      db.ingestRun(
        {
          connectionId,
          runId: `${connectionId}-${sequence++}`,
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:budget",
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: JSON.stringify(rows),
            },
          ],
        },
        synthetic,
      );
    const measure = async (work: () => unknown) => {
      const before = count();
      const value = work();
      await value;
      const after = count();
      expect(after.total - before.total).toBeGreaterThan(0);
      return {
        total: after.total - before.total,
        reads: after.reads - before.reads,
        writes: after.writes - before.writes,
        fullSnapshots: after.fullSnapshots - before.fullSnapshots,
      };
    };
    const all = async () =>
      (await db.listTransactionPage({ connectionId })).transactions;
    beforeEach(async () => {
      db = await open(backend);
      connectionId = `budget-${randomUUID()}`;
      sequence = 0;
      count = await observe(db);
      await db.ensureConnection({ id: connectionId, provider: "cal" });
      await capture();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await db?.close();
    });

    it("edits annotations in at most two reads and two writes", async () => {
      const transaction = (await all())[0]!;
      const counts = await measure(() =>
        db.editAnnotation({
          transactionId: transaction.id,
          expectedVersion: 0,
          notes: "synthetic edit",
        }),
      );
      expect(counts.reads).toBeLessThanOrEqual(2 + feedLock);
      expect(counts.total).toBeLessThanOrEqual(4 + guard + feedLock);
    });
    it("undoes annotations in at most three reads and two writes", async () => {
      const transaction = (await all())[0]!;
      await db.editAnnotation({
        transactionId: transaction.id,
        expectedVersion: 0,
        notes: "synthetic edit",
      });
      const change = (await db.listEvents({ connectionId })).find(
        (value) => value.type === "annotation.updated",
      )!;
      const counts = await measure(() =>
        db.undoAnnotation({ eventId: change.id, expectedVersion: 1 }),
      );
      expect(counts.reads).toBeLessThanOrEqual(3 + feedLock);
      expect(counts.total).toBeLessThanOrEqual(5 + guard + feedLock);
    });
    it("loads lifecycle state in two reads after the connection lock", async () => {
      const transaction = (await all()).find(
        (value) => value.status === "posted",
      )!;
      const counts = await measure(() =>
        db.confirmRemoval({
          transactionId: transaction.id,
          expectedVersion: transaction.version,
          reason: "synthetic removal",
        }),
      );
      expect(counts.reads).toBeLessThanOrEqual(2 + feedLock);
    });
    it("confirms posting with two reads for a valid account-scoped pair", async () => {
      const rows = await all();
      const pending = rows.find((value) => value.status === "pending")!;
      const posted = rows.find((value) => value.status === "posted")!;
      const counts = await measure(() =>
        db.linkPendingTransaction({
          pendingId: pending.id,
          postedId: posted.id,
          expectedPendingVersion: pending.version,
          expectedPostedVersion: posted.version,
          expectedPendingAnnotationVersion: 0,
          expectedPostedAnnotationVersion: 0,
          reason: "synthetic posting",
        }),
      );
      expect(counts.reads).toBeLessThanOrEqual(2 + feedLock);
    });
    it("reads the full capture once per new application", async () => {
      const counts = await measure(() => capture());
      // Includes catalog resolution and checking the staged body's retention policy.
      expect(counts.reads).toBeLessThanOrEqual(10 + feedLock);
      expect(counts.fullSnapshots).toBe(1);
    });
    it("reads nonempty filtered views without an existence round trip", async () => {
      for (const work of [
        () => db.listTransactionPage({ connectionId }),
        () => db.getTotals({ connectionId }),
        () => db.listEvents({ connectionId }),
        () => db.listSyncRuns(connectionId, { limit: 20 }),
      ]) {
        expect((await measure(work)).reads).toBeLessThanOrEqual(1);
      }
    });
    it("updates configuration with two statements and reads an existing connection once", async () => {
      expect(
        (
          await measure(() =>
            db.updateConfig(connectionId, (config) => ({
              ...config,
              synthetic: true,
            })),
          )
        ).total,
      ).toBeLessThanOrEqual(2 + guard);
      expect(
        (
          await measure(() =>
            db.ensureConnection({ id: connectionId, provider: "cal" }),
          )
        ).total,
      ).toBe(1);
    });
    it("batches 1,000 discovered cards and updates their retained metadata on rediscovery", async () => {
      const cards = Array.from({ length: 1000 }, (_, index) => ({
        cardKey: `discovered-${String(index).padStart(4, "0")}`,
        last4: "1234",
        displayName: "Synthetic card",
      }));
      // D1 binds 100 parameters: 11 nine-column card rows per statement.
      const cardsPerStatement = backend === "d1-local" ? 11 : 100;
      const first = await measure(() =>
        db.recordCardDiscovery(connectionId, {
          observedAt: "2040-08-01T00:00:00Z",
          cards,
        }),
      );
      expect(first.writes).toBeLessThanOrEqual(
        Math.ceil(cards.length / cardsPerStatement) + guard,
      );
      // Connection lock, then the card and account catalog.
      expect(first.reads).toBeLessThanOrEqual(3);
      const [{ id }] = (await db.raw(
        "SELECT id FROM cards WHERE connection_id=? AND provider_key=?",
        [connectionId, cards[0]!.cardKey],
      )) as [{ id: string }];
      const original = await db.getCard(id);
      const repeated = await measure(() =>
        db.recordCardDiscovery(connectionId, {
          observedAt: "2040-08-02T00:00:00Z",
          cards: cards.map((card) => ({
            ...card,
            last4: "9876",
            displayName: "Updated synthetic card",
          })),
        }),
      );
      expect(repeated.writes).toBeLessThanOrEqual(
        Math.ceil(cards.length / cardsPerStatement) + guard,
      );
      expect(repeated.reads).toBeLessThanOrEqual(3);
      const updated = await db.raw(
        "SELECT provider_key,last4,display_name,last_seen_at FROM cards WHERE connection_id=? AND display_name=? ORDER BY provider_key",
        [connectionId, "Updated synthetic card"],
      );
      expect(updated).toHaveLength(1000);
      expect(
        updated.every(
          (card) =>
            card.last4 === "9876" &&
            card.last_seen_at === "2040-08-02T00:00:00Z",
        ),
      ).toBe(true);
      expect((await db.getCard(id))?.createdAt).toBe(original?.createdAt);
    });

    it("batches canonical and audit writes on every driver", async () => {
      const before = (await db.listEvents({ connectionId, limit: 1000 }))
        .length;
      const counts = await measure(() =>
        capture(
          Array.from({ length: 100 }, (_, index) => row(`batch-${index}`)),
        ),
      );
      const changes =
        (await db.listEvents({ connectionId, limit: 1000 })).length - before;
      const transactionCount = (
        await db.listTransactionPage({
          connectionId,
          limit: 200,
          includeSuperseded: true,
          presence: "all",
        })
      ).transactions.length;
      expect(counts.writes).toBeLessThanOrEqual(
        Math.ceil(transactionCount / transactionRows) +
          Math.ceil(transactionCount / observationRows) +
          Math.ceil(transactionCount / reconciliationRows) +
          Math.ceil(transactionCount / postingLinkRows) +
          Math.ceil(changes / changeRows) +
          5 + // Receipt/body staging, run application, staged-body release and expired-body pruning.
          2 * guard,
      );
    });
  });
}
