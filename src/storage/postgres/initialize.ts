import type { Pool, PoolClient } from "pg";

import type { InstallationFingerprint } from "../../application/installation.js";
import { migrate, type Migration } from "../migrations.js";
import { readInstallation, recordInstallation } from "./installation.js";
import { postgresMigrations } from "./migration.js";
import {
  operationsInspectionSql,
  schemaInspectionSql,
} from "./schema-check.js";
import { operationsManifest, schemaManifest } from "./schema-manifest.js";

/** Every PostgreSQL entry point keeps the financial tables in this schema. */
export const FINANCIAL_SCHEMA = "financial";

async function declarations(client: PoolClient, sql: string) {
  const { rows } = await client.query<{
    kind: string;
    name: string;
    definition: string;
  }>(sql);
  return JSON.stringify(
    rows.map((row) => [row.kind, row.name, row.definition].join("\t")),
  );
}

/** Both schemas' actual declarations must equal the generated manifests. */
export async function checkDeclarations(client: PoolClient) {
  if (
    (await declarations(client, schemaInspectionSql)) !==
      JSON.stringify(schemaManifest) ||
    (await declarations(client, operationsInspectionSql)) !==
      JSON.stringify(operationsManifest)
  ) {
    throw new Error("Unsupported PostgreSQL schema declarations");
  }
}

/**
 * Migrates `financial` (the pool's `search_path`) and `operations` under one
 * transaction-scoped advisory lock; the version table is in `financial`. A
 * fresh database gets its `financial` namespace in that transaction too.
 */
export async function migratePostgresSchema(
  pool: Pool,
  migrations: readonly Migration[] = postgresMigrations,
  /** Null skips the declaration check, for test or generation migration lists. */
  check:
    | ((client: PoolClient, from: number) => Promise<void>)
    | null = checkDeclarations,
): Promise<void> {
  await migrate<PoolClient>(
    {
      async transaction(work) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          try {
            await client.query("SELECT pg_advisory_xact_lock(1178882896,1)");
            await createMissingSchema(client, FINANCIAL_SCHEMA);
            const result = await work(client);
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
          }
        } finally {
          client.release();
        }
      },
      async version(client) {
        const { rows } = await client.query<{
          schema: string | null;
          recorded: boolean;
        }>(
          "SELECT current_schema() AS schema, EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'schema_migrations') AS recorded",
        );
        if (rows[0]?.schema !== FINANCIAL_SCHEMA) {
          throw new Error(
            `PostgreSQL storage needs search_path=${FINANCIAL_SCHEMA}`,
          );
        }
        if (!rows[0].recorded) {
          return 0;
        }
        const versions = await client.query<{ version: number | null }>(
          "SELECT max(version)::integer AS version FROM schema_migrations",
        );
        return versions.rows[0]?.version ?? 0;
      },
      async apply(client, migration) {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations(version) VALUES ($1)",
          [migration.version],
        );
      },
    },
    migrations,
    check ?? undefined,
  );
}

/** Creates a schema only when it is missing, so an existing one sees no DDL. */
async function createMissingSchema(
  client: Pick<PoolClient, "query">,
  name: string,
) {
  // A catalog read, not a cached lookup, sees a schema another start just committed.
  const { rows } = await client.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present",
    [name],
  );
  if (rows[0]?.present !== true) {
    await client.query(`CREATE SCHEMA "${name.replaceAll('"', '""')}"`);
  }
}

/**
 * Creates a schema only when it is missing, under a lock, so an existing one
 * sees no DDL and concurrent first starts do not race.
 */
export async function ensurePostgresSchema(
  pool: Pool,
  name: string,
): Promise<void> {
  const { rows } = await pool.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present",
    [name],
  );
  if (rows[0]?.present === true) {
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock(1178882896,0)");
      await createMissingSchema(client, name);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Provisions or validates every Fonds schema of a dedicated UTF-8 database:
 * `financial` (the pool's `search_path`) and `operations`. With an
 * installation, it is recorded unless one is, in the transaction that creates
 * the schemas. Returns the recorded installation.
 */
export async function initializePostgresDatabase(
  pool: Pool,
  options: { installation?: InstallationFingerprint } = {},
): Promise<InstallationFingerprint | undefined> {
  if (
    (await pool.query("SHOW server_encoding")).rows[0]?.server_encoding !==
    "UTF8"
  ) {
    throw new Error("PostgreSQL storage requires UTF8");
  }
  let recorded: InstallationFingerprint | undefined;
  await migratePostgresSchema(pool, postgresMigrations, async (client) => {
    await checkDeclarations(client);
    recorded = options.installation
      ? await recordInstallation(client, options.installation)
      : await readInstallation(client);
  });
  return recorded;
}
