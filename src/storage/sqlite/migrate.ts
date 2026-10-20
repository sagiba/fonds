import type { Client, Transaction } from "@libsql/client/web";

import { migrate, type Migration } from "../migrations.js";
import { sqliteMigrations } from "./migration.js";
import { schemaInspectionSql, schemaMatchesManifest } from "./schema-check.js";

/** The last applied migration, which `PRAGMA user_version` records; 0 when empty. */
export async function appliedMigration(
  executor: Pick<Transaction, "execute">,
): Promise<number> {
  return Number((await executor.execute("PRAGMA user_version")).rows[0]?.[0]);
}

/** The live declarations must equal the generated manifest of the latest migration. */
export async function checkSqliteSchema(
  executor: Pick<Transaction, "execute">,
): Promise<void> {
  if (
    !schemaMatchesManifest((await executor.execute(schemaInspectionSql)).rows)
  ) {
    throw new Error("Unsupported database schema");
  }
}

/** Migrates in one write transaction, which also serializes concurrent opens. */
export async function migrateSqliteSchema(
  client: Client,
  migrations: readonly Migration[] = sqliteMigrations,
  /** Null skips the declaration check, for test or generation migration lists. */
  check:
    | ((tx: Transaction, from: number) => Promise<void>)
    | null = checkSqliteSchema,
): Promise<void> {
  await migrate<Transaction>(
    {
      async transaction(work) {
        const tx = await client.transaction("write");
        try {
          const result = await work(tx);
          await tx.commit();
          return result;
        } finally {
          tx.close();
        }
      },
      version: appliedMigration,
      async apply(tx, migration) {
        await tx.executeMultiple(migration.sql);
        await tx.execute(`PRAGMA user_version = ${migration.version}`);
      },
    },
    migrations,
    check ?? undefined,
  );
}
