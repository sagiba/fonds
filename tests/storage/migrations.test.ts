import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client/node";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  migrate,
  type Migration,
  type MigrationTarget,
} from "../../src/storage/migrations.js";
import {
  checkDeclarations,
  initializePostgresDatabase,
  migratePostgresSchema,
} from "../../src/storage/postgres/initialize.js";
import { postgresMigrations } from "../../src/storage/postgres/migration.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import {
  appliedMigration,
  checkSqliteSchema,
  migrateSqliteSchema,
} from "../../src/storage/sqlite/migrate.js";
import { sqliteMigrations } from "../../src/storage/sqlite/migration.js";
import { initializeTursoDatabase } from "../../src/storage/turso.js";
import { disposableDatabase } from "../helpers/postgres-database.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;

/** One backend: its production initializer and its runner with a test-only list. */
interface Subject {
  migrations: readonly Migration[];
  initialize(): Promise<void>;
  /** Runs a list with an optional check in place of the declaration check. */
  migrate(
    migrations: readonly Migration[],
    check?: (from: number) => Promise<void>,
  ): Promise<void>;
  /** The production declaration check, counted per call. */
  checks: number;
  version(): Promise<number>;
  query(sql: string): Promise<Record<string, unknown>[]>;
  /** Runs `work`, failing on any DDL it executes. */
  withoutDdl(work: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

async function sqlite(libsql: boolean): Promise<Subject> {
  const directory = mkdtempSync(join(tmpdir(), "fonds-migrations-"));
  const path = join(directory, "ledger.sqlite");
  const client = createClient({ url: `file:${path}`, intMode: "number" });
  await client.execute("PRAGMA foreign_keys = ON");
  const query = async (sql: string) =>
    (await client.execute(sql)).rows as unknown as Record<string, unknown>[];
  const initialize = libsql
    ? () => initializeTursoDatabase(client)
    : async () => {
        // Concurrent first opens of one file, as several processes would.
        // Every opened handle closes, even when another open is refused.
        const opened = await Promise.allSettled(
          [1, 2, 3].map(() => openDatabase(path)),
        );
        await Promise.all(
          opened.map((result) =>
            result.status === "fulfilled" ? result.value.close() : undefined,
          ),
        );
        const refused = opened.find((result) => result.status === "rejected");
        if (refused) {
          throw refused.reason;
        }
      };
  const subject: Subject = {
    migrations: sqliteMigrations,
    initialize,
    checks: 0,
    migrate: (migrations, check) =>
      migrateSqliteSchema(
        client,
        migrations,
        check
          ? async (tx, from) => {
              if (migrations === sqliteMigrations) {
                subject.checks++;
                await checkSqliteSchema(tx);
              }
              await check(from);
            }
          : null,
      ),
    version: () => appliedMigration(client),
    query,
    async withoutDdl(work) {
      // SQLite increments schema_version on every schema change.
      const before = await query("PRAGMA schema_version");
      await work();
      expect(await query("PRAGMA schema_version")).toEqual(before);
    },
    close: async () => {
      client.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return subject;
}

async function postgres(): Promise<Subject> {
  const database = await disposableDatabase(postgresUrl!, "fonds_migrations");
  const pool = new Pool({
    connectionString: database.url,
    options: database.options,
    max: 3,
  });
  const query = async (sql: string) => (await pool.query(sql)).rows;
  const subject: Subject = {
    migrations: postgresMigrations,
    // Concurrent first starts on one database.
    initialize: async () => {
      await Promise.all([1, 2, 3].map(() => initializePostgresDatabase(pool)));
    },
    checks: 0,
    migrate: (migrations, check) =>
      migratePostgresSchema(
        pool,
        migrations,
        check
          ? async (client, from) => {
              if (migrations === postgresMigrations) {
                subject.checks++;
                await checkDeclarations(client);
              }
              await check(from);
            }
          : null,
      ),
    version: async () =>
      Number(
        (await query("SELECT max(version) AS v FROM schema_migrations"))[0]?.v,
      ),
    query,
    async withoutDdl(work) {
      await query(`
        CREATE FUNCTION public.refuse_ddl() RETURNS event_trigger LANGUAGE plpgsql
          AS $$ BEGIN RAISE EXCEPTION 'DDL: %', tg_tag; END $$;
        CREATE EVENT TRIGGER refuse_ddl ON ddl_command_start
          EXECUTE FUNCTION public.refuse_ddl();
      `);
      try {
        await expect(query("CREATE TABLE probe (id text)")).rejects.toThrow(
          "DDL",
        );
        await work();
      } finally {
        await query("DROP EVENT TRIGGER refuse_ddl");
      }
    },
    close: async () => {
      await pool.end();
      await database.drop();
    },
  };
  return subject;
}

/** Test-only migrations after the current ones; the second needs the first's table. */
function pending(latest: readonly Migration[], second: string): Migration[] {
  const next = latest.length + 1;
  return [
    ...latest,
    {
      version: next,
      name: `${next}_probe`,
      sql: "CREATE TABLE probe (id TEXT);\nINSERT INTO probe(id) VALUES ('first');\n",
    },
    { version: next + 1, name: `${next + 1}_probe_rows`, sql: second },
  ];
}

const followUp = "INSERT INTO probe(id) VALUES ('second');\n";
const failing = `${followUp}INSERT INTO missing_relation VALUES (1);\n`;
const sentinel =
  "INSERT INTO connections(id,provider,display_name,config_json,created_at) VALUES ('kept','cal','Kept','{\"schemaVersion\":1}','2040-01-01T00:00:00Z')";

describe("shared migration sequencing", () => {
  /** An in-memory target that records every version it writes. */
  function recording(version: number) {
    const writes: number[] = [];
    const target: MigrationTarget<null> = {
      transaction: (work) => work(null),
      version: async () => version,
      async apply(_, migration) {
        writes.push(migration.version);
      },
    };
    return { target, writes };
  }

  const list = [1, 2].map((version) => ({
    version,
    name: `${version}_synthetic`,
    sql: "",
  }));

  it("writes no version and checks declarations once on an up-to-date database", async () => {
    const { target, writes } = recording(2);
    const checks: number[] = [];
    await migrate(target, list, async (_, from) => {
      checks.push(from);
    });
    expect(writes).toEqual([]);
    expect(checks).toEqual([2]);
  });

  it("applies only pending migrations, then checks once", async () => {
    const { target, writes } = recording(1);
    const checks: number[] = [];
    await migrate(target, list, async (_, from) => {
      checks.push(from);
    });
    expect(writes).toEqual([2]);
    expect(checks).toEqual([1]);
  });
});

const subjects: [string, () => Promise<Subject>, boolean][] = [
  ["sqlite", () => sqlite(false), true],
  ["libsql-local", () => sqlite(true), true],
  ["postgres", postgres, Boolean(postgresUrl)],
];

for (const [backend, open, enabled] of subjects) {
  describe.skipIf(!enabled)(`numbered migrations: ${backend}`, () => {
    async function current() {
      const subject = await open();
      await subject.initialize();
      await subject.query(sentinel);
      return subject;
    }

    const kept = async (subject: Subject) =>
      expect(await subject.query("SELECT id FROM connections")).toEqual([
        { id: "kept" },
      ]);

    it("initializes a fresh database to the latest migration", async () => {
      const subject = await current();
      try {
        expect(await subject.version()).toBe(subject.migrations.length);
      } finally {
        await subject.close();
      }
    });

    it("applies pending migrations in order, keeping existing rows", async () => {
      const subject = await current();
      try {
        await subject.migrate(pending(subject.migrations, followUp));
        expect(await subject.version()).toBe(subject.migrations.length + 2);
        expect(await subject.query("SELECT id FROM probe ORDER BY id")).toEqual(
          [{ id: "first" }, { id: "second" }],
        );
        await kept(subject);
      } finally {
        await subject.close();
      }
    });

    it("rolls back an interrupted migration with its version; a retry succeeds", async () => {
      const subject = await current();
      try {
        await expect(
          subject.migrate(pending(subject.migrations, failing)),
        ).rejects.toThrow("missing_relation");
        expect(await subject.version()).toBe(subject.migrations.length);
        await expect(subject.query("SELECT id FROM probe")).rejects.toThrow();
        await subject.migrate(pending(subject.migrations, followUp));
        expect(await subject.version()).toBe(subject.migrations.length + 2);
      } finally {
        await subject.close();
      }
    });

    it.each([1, 2])(
      "refuses a database %i migrations newer than the code without changing it",
      async (ahead) => {
        const subject = await current();
        const newer = subject.migrations.length + ahead;
        try {
          await subject.query(
            backend === "postgres"
              ? `INSERT INTO schema_migrations(version) VALUES (${newer})`
              : `PRAGMA user_version = ${newer}`,
          );
          await expect(subject.initialize()).rejects.toThrow(
            `Database schema is at migration ${newer}, newer than this Fonds release (migration ${subject.migrations.length})`,
          );
          expect(await subject.version()).toBe(newer);
          await kept(subject);
        } finally {
          await subject.close();
        }
      },
    );

    it("refuses an incompatible database at the initial version without resetting its data", async () => {
      const subject = await open();
      try {
        const connection =
          /CREATE TABLE connections \([\s\S]*?\n\)(?: STRICT)?;/.exec(
            subject.migrations[0]!.sql,
          )![0];
        const marker =
          backend === "postgres"
            ? "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());"
            : "";
        await subject.migrate([
          { version: 1, name: "0001_initial", sql: `${connection}\n${marker}` },
        ]);
        await subject.query(sentinel);
        await subject.withoutDdl(async () => {
          await expect(subject.initialize()).rejects.toThrow("Unsupported");
        });
        expect(await subject.version()).toBe(1);
        await kept(subject);
        await expect(
          subject.query("SELECT id FROM transactions"),
        ).rejects.toThrow();
      } finally {
        await subject.close();
      }
    });

    it("runs no migration on an up-to-date database, still checking declarations", async () => {
      const subject = await current();
      try {
        await subject.withoutDdl(() => subject.initialize());
        expect(await subject.version()).toBe(subject.migrations.length);
        await subject.query(
          backend === "postgres"
            ? "CREATE TABLE operations.extra (id text)"
            : "CREATE TABLE extra (id TEXT)",
        );
        await expect(subject.initialize()).rejects.toThrow("Unsupported");
      } finally {
        await subject.close();
      }
    });

    it("checks the declarations of an up-to-date database exactly once, writing no version", async () => {
      const subject = await current();
      try {
        const versions = () =>
          subject.query(
            backend === "postgres"
              ? "SELECT version, applied_at FROM schema_migrations ORDER BY version"
              : "PRAGMA user_version",
          );
        const before = await versions();
        const from: number[] = [];
        await subject.withoutDdl(() =>
          subject.migrate(subject.migrations, async (version) => {
            from.push(version);
          }),
        );
        expect(subject.checks).toBe(1);
        expect(from).toEqual([subject.migrations.length]);
        expect(await versions()).toEqual(before);
      } finally {
        await subject.close();
      }
    });

    it("rolls back pending migrations when the declaration check fails", async () => {
      const subject = await current();
      try {
        await expect(
          subject.migrate(pending(subject.migrations, followUp), async () => {
            throw new Error("Unsupported synthetic declarations");
          }),
        ).rejects.toThrow("Unsupported synthetic declarations");
        expect(await subject.version()).toBe(subject.migrations.length);
        await expect(subject.query("SELECT id FROM probe")).rejects.toThrow();
        await kept(subject);
      } finally {
        await subject.close();
      }
    });
  });
}

describe.skipIf(!postgresUrl)("numbered migrations: postgres", () => {
  it("creates the financial namespace in the migration transaction, so a refused start leaves none", async () => {
    const database = await disposableDatabase(postgresUrl!, "fonds_namespace");
    const pool = new Pool({
      connectionString: database.url,
      options: database.options,
    });
    const namespace = async () =>
      (await pool.query("SELECT to_regnamespace('financial') AS name")).rows[0]
        ?.name;
    try {
      await expect(
        migratePostgresSchema(pool, postgresMigrations, async () => {
          throw new Error("Unsupported synthetic declarations");
        }),
      ).rejects.toThrow("Unsupported synthetic declarations");
      expect(await namespace()).toBeNull();
      await initializePostgresDatabase(pool);
      expect(await namespace()).toBe("financial");
    } finally {
      await pool.end();
      await database.drop();
    }
  });

  it("refuses a session whose dates would not read back as ISO text, creating nothing", async () => {
    const database = await disposableDatabase(postgresUrl!, "fonds_datestyle");
    const pool = new Pool({
      connectionString: database.url,
      options: `${database.options} -c DateStyle=SQL,DMY`,
    });
    try {
      await expect(initializePostgresDatabase(pool)).rejects.toThrow(
        "DateStyle ISO",
      );
      expect(
        (await pool.query("SELECT to_regnamespace('financial') AS name"))
          .rows[0]?.name,
      ).toBeNull();
    } finally {
      await pool.end();
      await database.drop();
    }
  });
});
