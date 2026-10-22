import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";

import { calAdapter } from "../../src/providers/cal/adapter.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import {
  cards,
  events,
  transactions,
} from "../../src/storage/sqlite/schema.js";
import { transaction } from "../../src/storage/sqlite/statements.js";

// Invented completeness exercises lifecycle mechanics, not CAL provider guarantees.
const completeCalShape = {
  ...calAdapter,
  sourceCoverage: {
    kind: "account_window" as const,
    resources: ["cal:recent"],
    dateField: "transactionDate" as const,
    days: 60,
  },
  rejectEmptyRecentPosted: true,
};

afterEach(() => vi.useRealTimers());

it("preserves fixed fixture replay under explicitly synthetic completeness", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2040-08-31T00:00:00.000Z"));
  const db = await openDatabase(":memory:");
  try {
    await db.ensureConnection({ id: "golden-cal", provider: "cal" });
    const stages = [];
    for (const [index, fixture] of [
      "recent-01",
      "recent-02",
      "recent-03",
      "malformed-pending",
      "legacy-history",
      "recent-01",
    ].entries()) {
      const result = await db.ingestRun(
        {
          connectionId: "golden-cal",
          runId: `golden-${index}`,
          startedAt: `2040-08-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
          responses: [
            {
              accountKey: "golden-account",
              endpoint: "synthetic:cal/recent",
              capturedAt: `2040-08-${String(index === 5 ? 1 : index + 1).padStart(2, "0")}T00:00:00Z`,
              responseText: readFileSync(
                new URL(
                  `../providers/cal/fixtures/${fixture}.json`,
                  import.meta.url,
                ),
                "utf8",
              ),
            },
          ],
        },
        completeCalShape,
      );
      stages.push({ result, totals: await db.getTotals() });
    }
    const storedRows = await db.orm
      .select()
      .from(transactions)
      .orderBy(sql`transactions.rowid`)
      .all();
    const rows = (
      await Promise.all(storedRows.map((row) => transaction(db.orm, row.id)))
    ).flat();
    // The synthetic complete posted partition establishes absence even with malformed pending.
    // These two purchases total 15,245 ILS minor units; neither belongs in current spending.
    expect(
      rows
        .filter((row) => row.sourceAbsence && row.status === "posted")
        .map((row) => ({
          amountMinor: row.amountMinor,
          sourceKey: row.sourceKey,
          sourceAbsence: row.sourceAbsence,
        })),
    ).toEqual([
      {
        amountMinor: -5875,
        sourceKey:
          'cal:posted:purchase:["SYNTHETIC-CARD-A","SYNTHETIC-TXN-PENDING-POSTED"]',
        sourceAbsence: {
          capturedAt: "2040-08-04T00:00:00.000Z",
          runId: "golden-3",
        },
      },
      {
        amountMinor: -9370,
        sourceKey:
          'cal:posted:purchase:["SYNTHETIC-CARD-A","SYNTHETIC-TXN-NEW"]',
        sourceAbsence: {
          capturedAt: "2040-08-04T00:00:00.000Z",
          runId: "golden-3",
        },
      },
    ]);
    expect(await db.getTotals({ presence: "all" })).toMatchObject({
      includedCount: 19,
      excluded: { sourceAbsent: 3, pending: 1 },
      totals: [
        {
          amountBasis: "purchase_commitment",
          amountMinor: -3750,
          currency: "EUR",
        },
        {
          amountBasis: "purchase_commitment",
          amountMinor: -227390,
          currency: "ILS",
        },
        {
          amountBasis: "purchase_commitment",
          amountMinor: -4500,
          currency: "USD",
        },
      ],
    });
    const cardRows = await db.orm
      .select()
      .from(cards)
      .orderBy(sql`cards.rowid`)
      .all();
    // Database encounter order is stable; UUIDs and their sorted references are not.
    const ids = new Map([
      ...rows.map(
        (row, index) => [row.id, `transaction-${index + 1}`] as const,
      ),
      ...cardRows.map((card, index) => [card.id, `card-${index + 1}`] as const),
    ]);
    const mask = (value: unknown): unknown => {
      if (typeof value === "string") {
        return ids.get(value) ?? value;
      }
      if (Array.isArray(value)) {
        const masked = value.map(mask);
        return value.length > 0 &&
          value.every((entry) => typeof entry === "string" && ids.has(entry))
          ? masked.sort()
          : masked;
      }
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, mask(entry)]),
        );
      }
      return value;
    };
    expect(
      mask({
        stages,
        cards: cardRows,
        transactions: rows,
        events: await db.orm.select().from(events).orderBy(events.id).all(),
      }),
    ).toMatchSnapshot();
  } finally {
    await db.close();
  }
});
