import { expect, it } from "vitest";

import { unknownLedgerFacts } from "../../src/domain/model.js";
import { FinancialPlan } from "../../src/domain/plans/state.js";
import type { Transaction } from "../../src/domain/records.js";
import { row } from "../helpers/storage-harness.js";

function transaction(id: string, purchaseId: string | null): Transaction {
  const { cardKey: _cardKey, ...facts } = row(id);
  return {
    ...facts,
    ...unknownLedgerFacts(null),
    purchaseId,
    installmentNumber: purchaseId === null ? null : 1,
    id,
    connectionId: "synthetic",
    presence: "seen",
    firstSeenAt: "2040-07-01T00:00:00Z",
    lastSeenAt: "2040-07-01T00:00:00Z",
    lastSeenRunId: "run",
    version: 1,
    supersededById: null,
  };
}

it("writes purchases before the billed lines that reference them, whatever the plan order", () => {
  const plan = new FinancialPlan({
    connection: {
      id: "synthetic",
      provider: "cal",
      displayName: "synthetic",
      config: { schemaVersion: 1 },
      createdAt: "2040-07-01T00:00:00Z",
    },
    rows: [],
    annotations: [],
    priorRuns: [],
    removals: [],
  });
  plan.insertTransaction(transaction("line-1", "purchase"));
  plan.insertTransaction(transaction("line-2", "purchase"));
  plan.insertTransaction(transaction("purchase", null));
  plan.insertTransaction(transaction("single", null));
  expect(plan.orderedTransactionWrites().map((item) => item.id)).toEqual([
    "purchase",
    "single",
    "line-1",
    "line-2",
  ]);
});
