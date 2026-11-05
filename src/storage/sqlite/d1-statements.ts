import { eq, getTableColumns, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { ConflictError } from "../../domain/errors.js";
import type { FinancialPlan } from "../../domain/plans/state.js";
import { repairColumns, repairOversized } from "../sql.js";
import * as schema from "./schema.js";
import {
  applyPlan as applySqlitePlan,
  connectionOfTransaction,
  type Executor,
} from "./statements.js";

/** D1 binds at most 100 parameters per statement. */
const maxParameters = 100;

// D1-only column in migrations/d1/0001_initial.sql. Local SQLite and
// Turso use interactive transactions, so the shared schema does not declare it.
// Explicit names: Drizzle caches key-derived names by table name, shared with the
// full connections table.
const revisions = sqliteTable("connections", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
});

const lockedColumns = {
  ...getTableColumns(schema.connections),
  revision: revisions.revision,
};

/** Reads the revision that this operation's write batch must still find. */
export const lockConnection = (db: Executor, id: string) =>
  db
    .select(lockedColumns)
    .from(schema.connections)
    .where(eq(schema.connections.id, id));
export const lockConnectionOf = (db: Executor, transactionId: string) =>
  db
    .select(lockedColumns)
    .from(schema.connections)
    .where(connectionOfTransaction(transactionId));

/** Repair reads only bounded connection facts plus the D1 revision. */
export const repairLockConnectionOf = async (db: Executor, id: string) => {
  const fields = {
    id: schema.connections.id,
    provider: schema.connections.provider,
    displayName: schema.connections.displayName,
    createdAt: schema.connections.createdAt,
  };
  const result = await db
    .select({
      ...repairColumns(fields, "sqlite", 2048),
      revision: revisions.revision,
      oversized: repairOversized([{ columns: fields, limit: 2048 }], "sqlite"),
    })
    .from(schema.connections)
    .where(connectionOfTransaction(id));
  if (result.some((row) => row.oversized)) {
    throw new ConflictError("Repair connection field exceeds byte limit");
  }
  return result.map(({ oversized: _oversized, ...row }) => ({
    ...row,
    config: { schemaVersion: 1 as const },
  }));
};
/** Advances an unchanged revision; otherwise the CHECK rolls back the whole batch. */
export const guardRevision = (db: Executor, id: string, revision: number) =>
  db
    .update(revisions)
    .set({
      revision: sql`case when ${revisions.revision} = ${revision} then ${revisions.revision} + 1 else -1 end`,
    })
    .where(eq(revisions.id, id));

export const applyPlan = (db: Executor, plan: FinancialPlan, runId?: string) =>
  applySqlitePlan(db, plan, runId, maxParameters);
