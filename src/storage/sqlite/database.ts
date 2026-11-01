import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { type Client, createClient, LibsqlError } from "@libsql/client/sqlite3";
import { drizzle } from "drizzle-orm/libsql/sqlite3";

import type { StoreOptions } from "../store.js";
import { storeForDatabase } from "./client.js";
import { checkSqliteSchema, migrateSqliteSchema } from "./migrate.js";
import { sqliteMigrations } from "./migration.js";
import * as schema from "./schema.js";

export type Database = Awaited<ReturnType<typeof openDatabase>>;

/** How long a connection waits for another connection's lock. */
const BUSY_TIMEOUT_MS = 5_000;

/** As long as the connection's busy timeout waits for other locks. */
const WAL_SWITCH_WAIT_MS = BUSY_TIMEOUT_MS;

/**
 * Switches the file to WAL, which persists in the file. The switch needs an
 * exclusive lock; while another connection opens the same file, SQLite can
 * answer SQLITE_BUSY at once rather than wait, since each connection may hold
 * the lock the other waits for. A busy switch is therefore retried.
 */
async function enableWal(client: Client) {
  for (const deadline = Date.now() + WAL_SWITCH_WAIT_MS; ;) {
    try {
      await client.execute("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (
        !(error instanceof LibsqlError && error.code === "SQLITE_BUSY") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await setTimeout(25);
    }
  }
}

/**
 * Opens or initializes a local ledger. `settings` are written in the same
 * transaction that initializes a new file, so no process ever sees the file
 * without them; an existing file is never given them.
 */
export async function openDatabase(
  filename: string,
  options: { settings?: Readonly<Record<string, string>> } & StoreOptions = {},
) {
  if (filename !== ":memory:") {
    try {
      await (await open(filename, "wx", 0o600)).close();
    } catch (error) {
      const alreadyExists =
        error instanceof Error && "code" in error && error.code === "EEXIST";
      if (!alreadyExists) {
        throw error;
      }
    }
  }
  const client = createClient({
    url:
      filename === ":memory:"
        ? "file::memory:"
        : pathToFileURL(resolve(filename)).href,
    intMode: "number",
    // Keep connection-scoped pragmas and in-memory state on the same connection.
    concurrency: 1,
    timeout: BUSY_TIMEOUT_MS,
  });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    await enableWal(client);
    // A negative cache_size counts KiB rather than pages.
    await client.execute("PRAGMA synchronous = NORMAL");
    await client.execute("PRAGMA cache_size = -16000");
    await migrateSqliteSchema(client, sqliteMigrations, async (tx, from) => {
      await checkSqliteSchema(tx);
      if (from === 0) {
        for (const [name, value] of Object.entries(options.settings ?? {})) {
          await tx.execute({
            sql: "INSERT INTO settings(name,value) VALUES(?,?)",
            args: [name, value],
          });
        }
      }
    });
    let pending = Promise.resolve();
    let closed = false;
    let closing: Promise<void> | undefined;

    function schedule<T>(work: () => Promise<T>): Promise<T> {
      if (closed) {
        return Promise.reject(new Error("Database is closed"));
      }
      const result = pending.then(work);
      pending = result.then(
        () => {},
        () => {},
      );
      return result;
    }

    const orm = drizzle(client, { schema });
    const database = storeForDatabase(orm, client, "sqlite", schedule, {
      ...(options.syncScopeDays !== undefined && {
        syncScopeDays: options.syncScopeDays,
      }),
    });
    return {
      ...database,
      close: (): Promise<void> => {
        closing ??= (async () => {
          closed = true;
          await pending;
          await database.close();
        })();
        return closing;
      },
      backup: (destination: string): Promise<void> =>
        schedule(async () => {
          await (await open(destination, "wx", 0o600)).close();
          try {
            await client.execute({
              sql: "VACUUM INTO ?",
              args: [resolve(destination)],
            });
            const backup = await open(destination, "r+");
            try {
              await backup.sync();
            } finally {
              await backup.close();
            }
          } catch (error) {
            await unlink(destination).catch(() => {});
            throw error;
          }
        }),
    };
  } catch (error) {
    client.close();
    throw error;
  }
}
