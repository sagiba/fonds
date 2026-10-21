import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { FINANCIAL_SESSION_OPTIONS } from "../../src/storage/postgres/store.js";

/**
 * Drops a disposable test database once every session to it has closed.
 * DROP … WITH (FORCE) could kill a pool connection that is mid-shutdown and has
 * no error listener, which Vitest then reports as an unhandled error.
 */
export async function dropWhenIdle(admin: Pool, name: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await admin.query<{ sessions: number }>(
      "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname = $1",
      [name],
    );
    if (!rows[0]?.sessions) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
}

/**
 * A disposable database for one case: Fonds owns every schema of its database
 * (`financial` and `operations`), so cases never share one.
 */
export async function disposableDatabase(url: string, prefix = "fonds_test") {
  const admin = new Pool({ connectionString: url });
  const name = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  return {
    name,
    url: target.href,
    /** Pool options that select the financial schema, as every entry point does. */
    options: FINANCIAL_SESSION_OPTIONS,
    drop: async () => {
      try {
        await dropWhenIdle(admin, name);
      } finally {
        await admin.end();
      }
    },
  };
}
