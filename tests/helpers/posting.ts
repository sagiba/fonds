import type { InternalStore } from "../../src/application/financial-store.js";
import type { TransactionInput } from "../../src/domain/model.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { postingEvidence } from "./posting-evidence.js";
import { row, synthetic } from "./storage-harness.js";

export const postingAdapter: SourceAdapter = {
  ...synthetic,
  automaticPosting: {
    evidence: postingEvidence,
    pendingAmountBasis: "authorization",
    postedAmountBasis: "purchase_commitment",
  },
  pendingPostingCandidates: true,
  recentComparableDays: 60,
  rejectEmptyRecentPosted: true,
  extract(text, context) {
    const result = synthetic.extract(text, context);
    result.transactions.forEach((row, index) => {
      row.details.sourceRefs = [
        { runId: context.runId, path: `rows[${index}]` },
      ];
    });
    return result;
  },
};

export function authorization(
  key = "pending",
  fields: Partial<TransactionInput> = {},
) {
  return row(key, {
    status: "pending",
    amountBasis: "authorization",
    ...fields,
  });
}

export function postingHarness(db: InternalStore) {
  const connectionId = "posting";

  async function capture(
    day: number,
    rows: TransactionInput[],
    adapter = postingAdapter,
    options: { runId?: string; history?: boolean; hour?: string } = {},
  ) {
    return db.ingestRun(
      {
        connectionId,
        runId: options.runId ?? `posting-${day}`,
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:cal/recent",
            capturedAt: `2040-07-${String(day).padStart(2, "0")}T${options.hour ?? "12"}:00:00Z`,
            responseText: JSON.stringify(rows),
            ...(options.history ? { scope: { kind: "history" as const } } : {}),
          },
        ],
      },
      adapter,
    );
  }

  async function byKey(key: string) {
    const transaction = (
      await db.listTransactions({ includeSuperseded: true })
    ).find((row) => row.sourceKey === key && !row.supersededById);
    if (!transaction) {
      throw new Error(`Missing synthetic key ${key}`);
    }
    return transaction;
  }

  async function command(pendingId: string, postedId: string) {
    const pending = (await db.getTransaction(pendingId))!;
    const posted = (await db.getTransaction(postedId))!;
    return {
      pendingId,
      postedId,
      expectedPendingVersion: pending.version,
      expectedPostedVersion: posted.version,
      expectedPendingAnnotationVersion: pending.annotation?.version ?? 0,
      expectedPostedAnnotationVersion: posted.annotation?.version ?? 0,
      actor: "owner",
      reason: "Owner verified separate purchases",
    };
  }

  async function state() {
    return {
      rows: await db.listTransactions({ includeSuperseded: true }),
      changes: await db.listEvents(),
    };
  }

  return { capture, byKey, command, state, connectionId };
}
