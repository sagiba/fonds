import {
  getTableColumns,
  getTableName,
  type InferSelectModel,
  type Table,
} from "drizzle-orm";

import * as postgresSchema from "../../src/storage/postgres/schema.js";
import * as sqliteSchema from "../../src/storage/sqlite/schema.js";
import type { Harness } from "./storage-harness.js";

async function readRecords<T extends Table>(
  db: Harness,
  table: T,
  idColumn: string,
  id?: string,
  orderBy = idColumn,
): Promise<InferSelectModel<T>[]> {
  const rows = await db.raw(
    `SELECT * FROM ${getTableName(table)} ${id === undefined ? "" : `WHERE ${idColumn} = ?`} ORDER BY ${orderBy}`,
    id === undefined ? [] : [id],
  );
  return rows.map(
    (row) =>
      Object.fromEntries(
        Object.entries(getTableColumns(table)).map(([key, column]) => [
          key,
          row[column.name] === null
            ? null
            : column.mapFromDriverValue(row[column.name]),
        ]),
      ) as InferSelectModel<T>,
  );
}

export function readRuns(db: Harness, id?: string) {
  const schema = db.driver.kind === "postgres" ? postgresSchema : sqliteSchema;
  return readRecords(
    db,
    schema.syncRuns,
    "id",
    id,
    db.driver.kind === "postgres" ? "ingestion_order" : "rowid",
  );
}

export function readRunBodies(db: Harness, id?: string) {
  const schema = db.driver.kind === "postgres" ? postgresSchema : sqliteSchema;
  return readRecords(db, schema.syncRunBodies, "run_id", id);
}

/** Fail actual SQL writes after preceding work, exercising driver rollback. */
export async function failWrites(
  db: Harness,
  name: string,
  table: string,
  operation: "INSERT" | "UPDATE",
  message: string,
) {
  if (db.driver.kind === "postgres") {
    await db.raw(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${message}'; END; $$`,
    );
    await db.raw(
      `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
  } else {
    await db.raw(
      `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, '${message}'); END`,
    );
  }
}

export async function dropFailure(db: Harness, name: string, table: string) {
  await db.raw(
    `DROP TRIGGER ${name}${db.driver.kind === "postgres" ? ` ON ${table}` : ""}`,
  );
  if (db.driver.kind === "postgres") {
    await db.raw(`DROP FUNCTION ${name}()`);
  }
}
