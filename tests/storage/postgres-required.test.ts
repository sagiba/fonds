import { Pool } from "pg";
import { describe, expect, it } from "vitest";

describe("required PostgreSQL integration", () => {
  it.skipIf(process.env.FONDS_TEST_REQUIRE_POSTGRES !== "1")(
    "requires an explicit reachable test database",
    async () => {
      const connectionString = process.env.FONDS_TEST_POSTGRES_URL;
      if (!connectionString?.trim()) {
        throw new Error(
          "FONDS_TEST_REQUIRE_POSTGRES=1 requires FONDS_TEST_POSTGRES_URL",
        );
      }
      // These suites create and drop schemas and databases.
      expect([
        "localhost",
        "127.0.0.1",
        "[::1]",
        "host.docker.internal",
      ]).toContain(new URL(connectionString).hostname);
      const pool = new Pool({
        connectionString,
        connectionTimeoutMillis: 3000,
      });
      try {
        expect((await pool.query("SELECT 1 AS connected")).rows).toEqual([
          { connected: 1 },
        ]);
      } finally {
        await pool.end();
      }
    },
  );
});
