import type { Client } from "@libsql/client/web";

import { migrateSqliteSchema } from "./migrate.js";

/**
 * Explicit provisioning for libSQL: the same migrations and user_version as
 * local SQLite, between foreign-key checks for a database that may have been
 * imported.
 */
export async function initializeTursoDatabase(client: Client): Promise<void> {
  if ((await client.execute("PRAGMA foreign_keys")).rows[0]?.[0] !== 1) {
    throw new Error("Foreign key enforcement is required");
  }
  await migrateSqliteSchema(client);
  if ((await client.execute("PRAGMA foreign_key_check")).rows.length) {
    throw new Error("Database contains foreign key violations");
  }
}
