import { eq } from "drizzle-orm";

import type { Transaction } from "../../src/domain/records.js";
import {
  transactionObservations,
  transactionPostingLinks,
  transactionReconciliation,
  transactions,
} from "../../src/storage/sqlite/schema.js";
import {
  type Executor,
  transaction,
} from "../../src/storage/sqlite/statements.js";
import {
  encodeObservation,
  encodeReconciliation,
  encodeTransaction,
} from "../../src/storage/transaction-codec.js";

export async function insertTransaction(
  db: Executor,
  row: Transaction,
): Promise<Transaction> {
  await insertTransactions(db, [row]);
  return row;
}

export async function insertTransactions(
  db: Executor,
  rows: Transaction[],
): Promise<void> {
  await db.insert(transactions).values(rows.map(encodeTransaction));
  await db.insert(transactionObservations).values(rows.map(encodeObservation));
  await db
    .insert(transactionReconciliation)
    .values(rows.map(encodeReconciliation));
  await db.insert(transactionPostingLinks).values(
    rows.map((row) => ({
      transactionId: row.id,
      postingLink: row.details.postingLink ?? null,
    })),
  );
}

export async function readTransactions(db: Executor): Promise<Transaction[]> {
  const ids = await db.select({ id: transactions.id }).from(transactions);
  return (await Promise.all(ids.map(({ id }) => transaction(db, id)))).flat();
}

export async function updateTransaction(
  db: Executor,
  id: string,
  change: Partial<Transaction>,
): Promise<void> {
  const row = (await transaction(db, id))[0];
  if (!row) {
    throw new Error("Synthetic transaction fixture missing");
  }
  const updated = { ...row, ...change };
  await db
    .update(transactions)
    .set(encodeTransaction(updated))
    .where(eq(transactions.id, id));
  await db
    .update(transactionObservations)
    .set(encodeObservation(updated))
    .where(eq(transactionObservations.transactionId, id));
  await db
    .update(transactionReconciliation)
    .set(encodeReconciliation(updated))
    .where(eq(transactionReconciliation.transactionId, id));
  await db
    .update(transactionPostingLinks)
    .set({ postingLink: updated.details.postingLink ?? null })
    .where(eq(transactionPostingLinks.transactionId, id));
}
