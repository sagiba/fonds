import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { D1Database } from "@cloudflare/workers-types";
import { createClient } from "@libsql/client/node";
import type { Pool } from "pg";

import type {
  CollectionLockAttempt,
  LockedCollectionStore,
} from "../../src/application/collection-lock.js";
import type { EventSubscriptionStore } from "../../src/application/events.js";
import type { InternalStore } from "../../src/application/financial-store.js";
import { emptyDetails, type TransactionInput } from "../../src/domain/model.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { createPostgresEventStore } from "../../src/storage/postgres/events.js";
import {
  initializePostgresDatabase,
  openPostgresDatabase,
} from "../../src/storage/postgres/store.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import {
  databaseForClient,
  initializeTursoDatabase,
} from "../../src/storage/turso.js";
import { disposableDatabase } from "./postgres-database.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;
/** Cloudflare tooling loads only when FONDS_TEST_D1=1 enables local D1. */
export const d1Enabled = process.env.FONDS_TEST_D1 === "1";
const httpUrl = process.env.FONDS_TEST_LIBSQL_HTTP_URL;

/** Every backend's collection lock; SQLite-dialect leases also take a duration. */
interface TestCollectionLock {
  withCollectionLock<T>(
    connectionId: string,
    work: (store: LockedCollectionStore, signal: AbortSignal) => Promise<T>,
    options?: { leaseMs?: number },
  ): Promise<CollectionLockAttempt<T>>;
}

interface OperationsState {
  eventSubscriptions: EventSubscriptionStore;
}

/** Another handle on the same database, as a second process would open it. */
export type Peer = InternalStore &
  TestCollectionLock &
  OperationsState & { close(): Promise<void> };

export type Harness = InternalStore &
  TestCollectionLock &
  OperationsState & {
    /** Opens a Peer; the harness does not close it. */
    peer(): Promise<Peer>;
    driver:
      | { kind: "postgres"; pool: Pool }
      | { kind: "libsql"; client: ReturnType<typeof createClient> }
      | { kind: "d1"; binding: D1Database };
    raw(
      statement: string,
      args?: unknown[],
    ): Promise<Record<string, unknown>[]>;
    close(): Promise<void>;
  };

export type Backend =
  "sqlite" | "libsql-local" | "libsql-http" | "postgres" | "d1-local";

const d1Migrations = new URL("../../migrations/d1/", import.meta.url);

/** The parts of Miniflare the D1 suites use. */
interface LocalD1Runtime {
  getD1Database(name: string): Promise<D1Database>;
  dispatchFetch(url: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

/**
 * Miniflare is installed separately in tests/d1-local, so the root install never
 * fetches workerd or its dependencies.
 */
export async function loadMiniflare() {
  const require = createRequire(
    new URL("../d1-local/package.json", import.meta.url),
  );
  let entry: string;
  try {
    entry = require.resolve("miniflare");
  } catch (error) {
    throw new Error(
      "FONDS_TEST_D1=1 requires `npm ci --prefix tests/d1-local` first",
      { cause: error },
    );
  }
  const { Miniflare } = (await import(pathToFileURL(entry).href)) as {
    Miniflare: new (options: Record<string, unknown>) => LocalD1Runtime;
  };
  return Miniflare;
}

/** Applies the Wrangler migration directory in order, as `wrangler d1 migrations apply` does. */
export async function migrateD1(binding: D1Database) {
  for (const file of readdirSync(d1Migrations).sort()) {
    const statements = readFileSync(new URL(file, d1Migrations), "utf8")
      .split(/;\s*$/m)
      .map((statement) => statement.trim())
      .filter((statement) => statement && !/^(--[^\n]*\n?)*$/.test(statement));
    await binding.batch(
      statements.map((statement) => binding.prepare(statement)),
    );
  }
}

export async function open(backend: Backend): Promise<Harness> {
  if (backend === "postgres") {
    const database = await disposableDatabase(postgresUrl!);
    const config = {
      connectionString: database.url,
      options: database.options,
    };
    const db = openPostgresDatabase({ ...config, max: 1 });
    await initializePostgresDatabase(db.pool);
    return {
      ...db,
      eventSubscriptions: createPostgresEventStore(db.pool, db),
      peer: async () => {
        const peer = openPostgresDatabase({ ...config, max: 2 });
        return {
          ...peer,
          eventSubscriptions: createPostgresEventStore(peer.pool, peer),
        };
      },
      driver: { kind: "postgres", pool: db.pool },
      raw: async (statement, args = []) => {
        let index = 0;
        return (
          await db.pool.query(
            statement.replaceAll("?", () => `$${++index}`),
            args,
          )
        ).rows;
      },
      close: async () => {
        await db.close();
        await database.drop();
      },
    };
  }
  if (backend === "d1-local") {
    const [Miniflare, { openD1Database }] = await Promise.all([
      loadMiniflare(),
      import("../../src/storage/d1.js"),
    ]);
    const miniflare = new Miniflare({
      modules: true,
      script: "export default {}",
      d1Databases: ["DB"],
    });
    // Miniflare returns a proxy; a plain binding lets tests observe its statements.
    const local = await miniflare.getD1Database("DB");
    const binding = {
      prepare: (query: string) => local.prepare(query),
      batch: (statements: Parameters<typeof local.batch>[0]) =>
        local.batch(statements),
      exec: (query: string) => local.exec(query),
    } as unknown as D1Database;
    await migrateD1(binding);
    const db = openD1Database(binding);
    return {
      ...db,
      peer: async () => ({
        ...openD1Database(binding),
        close: async () => {},
      }),
      driver: { kind: "d1", binding },
      raw: async (statement, args = []) =>
        (
          await binding
            .prepare(statement)
            .bind(...args)
            .all<Record<string, unknown>>()
        ).results,
      close: () => miniflare.dispose(),
    };
  }
  if (backend === "sqlite") {
    const directory = await mkdtemp(join(tmpdir(), "fonds-sqlite-contract-"));
    const path = join(directory, "database.sqlite");
    const db = await openDatabase(path);
    return {
      ...db,
      peer: () => openDatabase(path),
      driver: { kind: "libsql", client: db.client },
      raw: async (statement, args = []) => {
        const result = await db.client.execute({
          sql: statement,
          args: args as (string | number | null)[],
        });
        return result.rows.map((row) =>
          Object.fromEntries(Object.keys(row).map((key) => [key, row[key]])),
        );
      },
      close: async () => {
        await db.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const client = createClient({
    url: backend === "libsql-local" ? "file::memory:" : httpUrl!,
    intMode: "number",
  });
  if (backend === "libsql-http") {
    await resetServerDatabase(client);
  }
  await client.execute("PRAGMA foreign_keys=ON");
  await initializeTursoDatabase(client);
  const db = databaseForClient(client);
  return {
    ...db,
    // An in-memory database has one connection; over HTTP each client is independent.
    peer: async () =>
      backend === "libsql-local"
        ? { ...databaseForClient(client), close: async () => {} }
        : databaseForClient(createClient({ url: httpUrl!, intMode: "number" })),
    driver: { kind: "libsql", client },
    raw: async (statement, args = []) => {
      const result = await client.execute({
        sql: statement,
        args: args as (string | number | null)[],
      });
      return result.rows.map((row) =>
        Object.fromEntries(Object.keys(row).map((key) => [key, row[key]])),
      );
    },
    close: () => db.close(),
  };
}

/**
 * Every case starts from an empty database, as the PostgreSQL harness does with
 * its per-case schema. The disposable test server has one database, and the
 * storage suites run serially, so clearing it before a case is safe.
 */
async function resetServerDatabase(client: ReturnType<typeof createClient>) {
  const { rows } = await client.execute(
    "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view')",
  );
  // Over HTTP each request is its own stream, so the pragma and the drops must
  // travel together for foreign keys to stay off while parents are dropped.
  // The schema version goes with the tables it described.
  await client.executeMultiple(
    [
      "PRAGMA foreign_keys=OFF",
      "PRAGMA user_version=0",
      ...rows.map(
        (row) =>
          `DROP ${String(row.type).toUpperCase()} IF EXISTS "${String(row.name).replaceAll('"', '""')}"`,
      ),
    ].join(";\n"),
  );
}

export function fixture(name: string) {
  return readFileSync(
    new URL(`../providers/cal/fixtures/${name}.json`, import.meta.url),
    "utf8",
  );
}

export function row(
  sourceKey: string,
  fields: Partial<TransactionInput> = {},
): TransactionInput {
  return {
    sourceScope: "account",
    cardKey: "card",
    sourceKey,
    sourceAliases: [],
    identityStrength: "native",
    status: "posted",
    description: "Synthetic",
    counterpartyName: null,
    kind: "purchase",
    merchantName: "Merchant",
    merchantProviderId: null,
    merchantCategoryCode: null,
    transactionDate: "2040-07-01",
    bookingDate: null,
    billingDate: null,
    amountMinor: -100,
    currency: "ILS",
    amountBasis: "purchase_commitment",
    originalAmountMinor: null,
    originalCurrency: null,
    installmentCount: null,
    details: emptyDetails(),
    ...fields,
  };
}

export const synthetic: SourceAdapter = {
  provider: "cal",
  parserVersion: "synthetic-v1",
  extract: (text) => ({
    transactions: JSON.parse(text) as TransactionInput[],
    partitions: [
      {
        accountKey: "account",
        status: "posted",
        success: true,
        comparable: true,
      },
      {
        accountKey: "account",
        status: "pending",
        success: true,
        comparable: true,
      },
    ],
    historical: false,
    warnings: [],
  }),
};

export const backends: Backend[] = [
  "sqlite",
  "libsql-local",
  ...(d1Enabled ? (["d1-local"] as const) : []),
  ...(httpUrl ? (["libsql-http"] as const) : []),
  ...(postgresUrl ? (["postgres"] as const) : []),
];
