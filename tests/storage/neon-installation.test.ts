import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyNeonDatabase } from "../../deploy/neon/function.js";
import { generateCredentialsKey } from "../../src/runtime/credential-vault.js";
import { runPostgresCommand } from "../../src/runtime/postgres-cli.js";
import {
  bindPostgresInstallation,
  financialPoolConfig,
  neonInstallation,
} from "../../src/runtime/postgres-environment.js";
import { readInstallation } from "../../src/storage/postgres/installation.js";
import { dropWhenIdle } from "../helpers/postgres-database.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;

/** What Neon's private env file holds; the Function and `--env-file` see it as the environment. */
const neonEnvironment = () => ({
  FONDS_NEON_GOOGLE_AUTH_URL: "https://synthetic.neonauth.invalid.neon.tech",
  FONDS_AUTH_SECRET: "synthetic-neon-auth-secret-000000000000000",
  FONDS_OWNER_ID: "synthetic-neon-owner",
  FONDS_CREDENTIALS_KEY: generateCredentialsKey(),
});

describe.skipIf(!postgresUrl)("Neon installation binding", () => {
  let admin: Pool;
  let databaseName: string;
  let connectionString: string;
  let pool: Pool;

  beforeEach(async () => {
    admin = new Pool({ connectionString: postgresUrl });
    databaseName = `fonds_neon_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${databaseName}`;
    connectionString = url.href;
    pool = new Pool(financialPoolConfig(connectionString));
    // As production pools do: an idle client's error never goes unhandled.
    pool.on("error", () => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.end();
    await dropWhenIdle(admin, databaseName);
    await admin.end();
  });

  /** What `neon:setup` does first on a database. */
  const setupBind = (env: NodeJS.ProcessEnv) =>
    bindPostgresInstallation(pool, neonInstallation(env).fingerprint);

  it("binds a fresh database in setup, then requires its secrets everywhere", async () => {
    const env = neonEnvironment();
    // The Function never binds: a fresh database is refused until setup.
    await expect(verifyNeonDatabase(pool, env)).rejects.toThrow(
      /no installation record/,
    );
    await setupBind(env);
    expect(await readInstallation(pool)).toEqual(
      neonInstallation(env).fingerprint,
    );
    // Setup again, the Function, and the operator's --env-file commands match.
    await setupBind(env);
    await verifyNeonDatabase(pool, env);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(
      await runPostgresCommand(
        ["init"],
        { ...env, FONDS_DATABASE_URL: connectionString },
        undefined,
      ),
    ).toBe(0);
    for (const other of [
      { FONDS_AUTH_SECRET: "another-neon-auth-secret-0000000000000000" },
      { FONDS_OWNER_ID: "another-owner" },
      { FONDS_CREDENTIALS_KEY: generateCredentialsKey() },
    ]) {
      const changed = { ...env, ...other };
      await expect(setupBind(changed)).rejects.toThrow(
        /do not match the database's installation/,
      );
      await expect(verifyNeonDatabase(pool, changed)).rejects.toThrow(
        /do not match the database's installation/,
      );
      expect(
        await runPostgresCommand(
          ["list-connections"],
          { ...changed, FONDS_DATABASE_URL: connectionString },
          undefined,
        ),
      ).toBe(1);
    }
  });

  it("refuses an existing schema that was never bound, even without rows", async () => {
    const legacy = new Pool({ connectionString });
    legacy.on("error", () => {});
    try {
      await legacy.query(
        "CREATE SCHEMA financial; CREATE TABLE financial.connections (id text)",
      );
    } finally {
      await legacy.end();
    }
    await expect(setupBind(neonEnvironment())).rejects.toThrow(
      /has a Fonds schema but no installation record/,
    );
    expect(await readInstallation(pool)).toBeUndefined();
  });
});
