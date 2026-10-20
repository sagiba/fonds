import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { issueLoginLink } from "../../deploy/neon/setup.mjs";
import { generateCredentialsKey } from "../../src/runtime/credential-vault.js";
import {
  bindPostgresInstallation,
  financialPoolConfig,
  neonInstallation,
} from "../../src/runtime/postgres-environment.js";
import { dropWhenIdle } from "../helpers/postgres-database.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)("Neon setup login link", () => {
  let admin;
  let databaseName;
  let connectionString;

  beforeEach(async () => {
    admin = new Pool({ connectionString: postgresUrl });
    databaseName = `fonds_neon_link_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(postgresUrl);
    url.pathname = `/${databaseName}`;
    connectionString = url.href;
  });

  afterEach(async () => {
    await dropWhenIdle(admin, databaseName);
    await admin.end();
  });

  it("issues a link only for the database bound to the env file", async () => {
    const env = {
      FONDS_NEON_GOOGLE_AUTH_URL:
        "https://synthetic.neonauth.invalid.neon.tech",
      FONDS_AUTH_SECRET: "synthetic-neon-auth-secret-000000000000000",
      FONDS_OWNER_ID: "synthetic-neon-owner",
      FONDS_CREDENTIALS_KEY: generateCredentialsKey(),
    };
    await expect(issueLoginLink(connectionString, env)).rejects.toThrow(
      /no installation record/,
    );
    const pool = new Pool(financialPoolConfig(connectionString));
    pool.on("error", () => {});
    try {
      await bindPostgresInstallation(pool, neonInstallation(env).fingerprint);
    } finally {
      await pool.end();
    }
    for (const other of [
      { FONDS_AUTH_SECRET: "another-neon-auth-secret-0000000000000000" },
      { FONDS_OWNER_ID: "another-owner" },
      { FONDS_CREDENTIALS_KEY: generateCredentialsKey() },
    ]) {
      await expect(
        issueLoginLink(connectionString, { ...env, ...other }),
      ).rejects.toThrow(/do not match the database's installation/);
    }
  });
});
