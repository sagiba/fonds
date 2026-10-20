import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  acknowledgeConfig,
  configSchema,
  cursorFor,
  DeliveryConflictError,
} from "../../src/application/change-delivery.js";
import type { Account } from "../../src/domain/accounts.js";
import type { Card } from "../../src/domain/cards.js";
import { unknownLedgerFacts } from "../../src/domain/model.js";
import { planAnnotation } from "../../src/domain/plans/annotation.js";
import {
  FinancialPlan,
  type FinancialSnapshot,
} from "../../src/domain/plans/state.js";
import { extractRun, planRun } from "../../src/domain/plans/sync.js";
import type {
  Annotation,
  Connection,
  LedgerEvent,
  Run,
  Transaction,
} from "../../src/domain/records.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import type * as pg from "../../src/storage/postgres/schema.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import {
  accounts,
  annotations,
  cards,
  connections,
  events,
  syncRuns,
  transactions,
} from "../../src/storage/sqlite/schema.js";

describe("shared storage domain", () => {
  it("keeps all seven SQLite row shapes mutually assignable with owned domain types", () => {
    expectTypeOf<typeof accounts.$inferSelect>().toExtend<Account>();
    expectTypeOf<Account>().toExtend<typeof accounts.$inferSelect>();
    expectTypeOf<typeof pg.accounts.$inferSelect>().toExtend<Account>();
    expectTypeOf<Account>().toExtend<typeof pg.accounts.$inferSelect>();
    expectTypeOf<typeof cards.$inferSelect>().toExtend<Card>();
    expectTypeOf<Card>().toExtend<typeof cards.$inferSelect>();
    expectTypeOf<typeof pg.cards.$inferSelect>().toExtend<Card>();
    expectTypeOf<Card>().toExtend<typeof pg.cards.$inferSelect>();
    expectTypeOf<typeof connections.$inferSelect>().toExtend<Connection>();
    expectTypeOf<Connection>().toExtend<typeof connections.$inferSelect>();
    expectTypeOf<typeof syncRuns.$inferSelect>().toExtend<Run>();
    expectTypeOf<Run>().toExtend<typeof syncRuns.$inferSelect>();
    expectTypeOf<typeof transactions.$inferSelect>().toExtend<Transaction>();
    expectTypeOf<Transaction>().toExtend<typeof transactions.$inferSelect>();
    expectTypeOf<typeof annotations.$inferSelect>().toExtend<Annotation>();
    expectTypeOf<Annotation>().toExtend<typeof annotations.$inferSelect>();
    expectTypeOf<typeof events.$inferSelect>().toExtend<LedgerEvent>();
    expectTypeOf<LedgerEvent>().toExtend<typeof events.$inferSelect>();
    expectTypeOf<typeof pg.connections.$inferSelect>().toExtend<Connection>();
    expectTypeOf<Connection>().toExtend<typeof pg.connections.$inferSelect>();
    expectTypeOf<
      Omit<typeof pg.syncRuns.$inferSelect, "ingestionOrder" | "metadata">
    >().toExtend<Run>();
    expectTypeOf<Run>().toExtend<
      Omit<typeof pg.syncRuns.$inferSelect, "ingestionOrder" | "metadata">
    >();
    expectTypeOf<
      Omit<typeof pg.transactions.$inferSelect, "ingestionOrder">
    >().toExtend<Transaction>();
    expectTypeOf<Transaction>().toExtend<
      Omit<typeof pg.transactions.$inferSelect, "ingestionOrder">
    >();
    expectTypeOf<typeof pg.annotations.$inferSelect>().toExtend<Annotation>();
    expectTypeOf<Annotation>().toExtend<typeof pg.annotations.$inferSelect>();
    expectTypeOf<typeof pg.events.$inferSelect>().toExtend<LedgerEvent>();
    expectTypeOf<LedgerEvent>().toExtend<typeof pg.events.$inferSelect>();
  });

  it("repeats a financial plan deterministically without changing the supplied snapshot or extraction", async () => {
    const db = await openDatabase(":memory:");
    try {
      const connection = await db.ensureConnection({
        id: "synthetic",
        provider: "cal",
      });
      const snapshot: FinancialSnapshot = {
        connection,
        rows: [],
        annotations: [],
        priorRuns: [],
        removals: [],
        catalog: { cards: [], accounts: [] },
      };
      const run: Run = {
        id: "synthetic-run",
        connectionId: connection.id,
        startedAt: "2040-01-01T00:00:00.000Z",
        completedAt: null,
        refreshId: null,
        status: "started",
        collectorVersion: "synthetic-v1",
        parserVersion: calAdapter.parserVersion,
        snapshot: {
          schemaVersion: 1,
          responses: [
            {
              accountKey: "synthetic-account",
              endpoint: "synthetic:cal/recent",
              capturedAt: "2040-01-01T00:00:00.000Z",
              responseText: readFileSync(
                new URL(
                  "../providers/cal/fixtures/recent-01.json",
                  import.meta.url,
                ),
                "utf8",
              ),
            },
          ],
        },
        coverage: [],
        warnings: [],
        appliedAt: null,
      };
      const extraction = extractRun(run, calAdapter);
      const before = structuredClone({ snapshot, extraction, run });
      const calculate = () => {
        const plan = new FinancialPlan(snapshot);
        let nextId = 0;
        const result = planRun(
          plan,
          run,
          calAdapter,
          extraction,
          "2040-01-02T00:00:00.000Z",
          () => `synthetic-${++nextId}`,
        );
        return {
          result,
          cards: [...plan.cardWrites.values()],
          rows: [...plan.transactionWrites.values()],
          events: plan.events,
          runUpdate: plan.runUpdate,
        };
      };
      const first = calculate();
      expect(first.rows.length).toBeGreaterThan(0);
      // Referenced cards get deterministic IDs from the supplied generator.
      expect(first.cards.length).toBeGreaterThan(0);
      expect(
        first.rows.every((row) =>
          first.cards.some((card) => card.id === row.cardId),
        ),
      ).toBe(true);
      expect(calculate()).toEqual(first);
      expect({ snapshot, extraction, run }).toEqual(before);
      const row = first.rows[0]!;
      const editSnapshot = { ...snapshot, rows: [row] };
      const editBefore = structuredClone(editSnapshot);
      const editPlan = new FinancialPlan(editSnapshot);
      const annotation = planAnnotation(
        editPlan,
        {
          transactionId: row.id,
          expectedVersion: 0,
          notes: "Synthetic note",
        },
        "2040-01-03T00:00:00.000Z",
      );
      expect(annotation.updatedAt).toBe("2040-01-03T00:00:00.000Z");
      expect(editSnapshot).toEqual(editBefore);
      expect(editPlan.transactionWrites.size).toBe(0);
      expect(editPlan.events.map((event) => event.type)).toContain(
        "annotation.updated",
      );
    } finally {
      await db.close();
    }
  });

  it("orders changing source keys by UTF-8 while retaining insertion ties and late inserts", async () => {
    const db = await openDatabase(":memory:");
    try {
      const connection = await db.ensureConnection({
        id: "synthetic",
        provider: "cal",
      });
      const { cardKey, ...input } = calAdapter.extract(
        readFileSync(
          new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
          "utf8",
        ),
        { accountKey: "account", runId: "run" },
      ).transactions[0]!;
      const original: Transaction = {
        ...input,
        ...unknownLedgerFacts(cardKey),
        id: "earlier",
        connectionId: connection.id,
        presence: "seen",
        firstSeenAt: "2040-01-01T00:00:00Z",
        lastSeenAt: "2040-01-01T00:00:00Z",
        lastSeenRunId: "run",
        version: 1,
        supersededById: null,
      };
      const plan = new FinancialPlan({
        connection,
        rows: [
          { ...original, sourceKey: "z" },
          { ...original, id: "later", sourceKey: "a" },
        ],
        annotations: [],
        priorRuns: [],
        removals: [],
      });
      expect(plan.orderedRows().map((row) => row.id)).toEqual([
        "later",
        "earlier",
      ]);
      plan.updateTransaction("earlier", { sourceKey: "a" });
      plan.insertTransaction({
        ...original,
        id: "late-insert",
        sourceKey: "a",
      });
      expect(plan.orderedRows().map((row) => row.id)).toEqual([
        "earlier",
        "later",
        "late-insert",
      ]);
      plan.updateTransaction("earlier", { sourceKey: "🚀" });
      plan.updateTransaction("later", { sourceKey: "\uE000" });
      expect(plan.orderedRows().map((row) => row.id)).toEqual([
        "late-insert",
        "later",
        "earlier",
      ]);
    } finally {
      await db.close();
    }
  });

  it("preserves special consumer keys and unrelated config while comparing the acknowledged cursor", () => {
    const original = JSON.parse(
      '{"schemaVersion":1,"other":{"keep":true},"changeCursors":{"__proto__":7,"other-consumer":9}}',
    );
    const next = acknowledgeConfig(original, "__proto__", 7, 10);
    expect(cursorFor(configSchema.parse(next), "__proto__")).toBe(10);
    expect(next).toMatchObject({
      other: { keep: true },
      changeCursors: { "other-consumer": 9 },
    });
    expect(original.changeCursors["__proto__"]).toBe(7);
    expect(Object.getPrototypeOf(next.changeCursors)).toBe(Object.prototype);
    expect(() => acknowledgeConfig(next, "__proto__", 7, 11)).toThrow(
      DeliveryConflictError,
    );
    expect(() => acknowledgeConfig(next, "__proto__", 10, 9)).toThrow();
  });
});
