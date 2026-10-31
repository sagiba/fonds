import { emptyDetails, unknownLedgerFacts } from "../../src/domain/model.js";
import type { Transaction } from "../../src/domain/records.js";
import { type Harness, synthetic } from "./storage-harness.js";

/** The run every synthetic stored row names as its last observation. */
export const SEED_RUN = "seed-run";

/** Records the run that stored ledger rows reference. */
export async function seedRun(db: Harness, connectionId: string) {
  await db.ingestRun(
    {
      runId: SEED_RUN,
      connectionId,
      responses: [
        {
          accountKey: "account",
          endpoint: "synthetic",
          capturedAt: "2040-07-02T12:00:00Z",
          responseText: "[]",
        },
      ],
    },
    synthetic,
  );
}

/** A stored canonical row with invented facts; overrides set what a test needs. */
export function storedRow(
  connectionId: string,
  id: string,
  overrides: Partial<Transaction> = {},
): Transaction {
  return {
    id,
    connectionId,
    sourceScope: "account",
    sourceKey: id,
    sourceAliases: [],
    identityStrength: "native",
    status: "posted",
    presence: "seen",
    description: null,
    counterpartyName: null,
    kind: "purchase",
    merchantName: "Synthetic merchant",
    merchantProviderId: null,
    merchantCategoryCode: null,
    transactionDate: "2040-06-01",
    bookingDate: null,
    billingDate: null,
    amountMinor: -1000,
    currency: "ILS",
    amountBasis: "purchase_commitment",
    originalAmountMinor: null,
    originalCurrency: null,
    installmentCount: null,
    ...unknownLedgerFacts(null),
    details: {
      ...emptyDetails(),
      sourceRefs: [{ runId: SEED_RUN, path: `/${id}` }],
      provider: { synthetic: { retained: "r".repeat(512) } },
    },
    firstSeenAt: "2040-07-02T12:00:00Z",
    lastSeenAt: "2040-07-02T12:00:00Z",
    lastSeenRunId: SEED_RUN,
    version: 1,
    supersededById: null,
    ...overrides,
  };
}
