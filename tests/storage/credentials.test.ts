import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CredentialStore,
  EncryptedCredentials,
} from "../../src/application/credential-store.js";
import { createCredentialVault } from "../../src/runtime/credential-vault.js";
import { resolveInstallation } from "../../src/runtime/installation.js";
import { financialPoolConfig } from "../../src/runtime/postgres-environment.js";
import { createPostgresCredentialStore } from "../../src/storage/postgres/credentials.js";
import { initializePostgresDatabase } from "../../src/storage/postgres/store.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import { runPostgresCommand } from "../../src/targets/postgres.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;

function encrypted(
  connectionId: string,
  overrides: Partial<EncryptedCredentials> = {},
): EncryptedCredentials {
  return {
    connectionId,
    provider: "cal",
    version: 1,
    keyId: "synthetic-key-id",
    nonce: new Uint8Array(12).fill(7),
    ciphertext: new Uint8Array(40).fill(9),
    ...overrides,
  };
}

function storeContract(open: () => CredentialStore) {
  it("returns nothing for a connection without credentials", async () => {
    expect(await open().getCredentials("synthetic-connection")).toBeUndefined();
  });

  it("round-trips encrypted bytes and replaces them on save", async () => {
    const store = open();
    await store.saveCredentials(encrypted("synthetic-connection"));
    expect(await store.getCredentials("synthetic-connection")).toEqual(
      encrypted("synthetic-connection"),
    );
    const next = encrypted("synthetic-connection", {
      keyId: "synthetic-next-key",
      nonce: new Uint8Array(12).fill(1),
      ciphertext: new Uint8Array(17).fill(2),
    });
    await store.saveCredentials(next);
    expect(await store.getCredentials("synthetic-connection")).toEqual(next);
  });

  it("deletes one connection's credentials and reports whether any existed", async () => {
    const store = open();
    await store.saveCredentials(encrypted("synthetic-connection"));
    await store.saveCredentials(encrypted("synthetic-other"));
    expect(await store.deleteCredentials("synthetic-connection")).toBe(true);
    expect(await store.getCredentials("synthetic-connection")).toBeUndefined();
    expect(await store.deleteCredentials("synthetic-connection")).toBe(false);
    expect(await store.getCredentials("synthetic-other")).toEqual(
      encrypted("synthetic-other"),
    );
  });

  it("rejects malformed envelopes", async () => {
    const store = open();
    for (const invalid of [
      { version: 2 as unknown as 1 },
      { nonce: new Uint8Array(11) },
      { ciphertext: new Uint8Array(16) },
      { keyId: "" },
    ]) {
      await expect(
        store.saveCredentials(encrypted("synthetic-connection", invalid)),
      ).rejects.toThrow();
    }
    expect(await store.getCredentials("synthetic-connection")).toBeUndefined();
  });
}

describe("SQLite provider credentials", () => {
  let db: Database;

  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.ensureConnection({ id: "synthetic-connection", provider: "cal" });
    await db.ensureConnection({ id: "synthetic-other", provider: "cal" });
  });

  afterEach(async () => {
    await db.close();
  });

  storeContract(() => db.credentials);

  it("belongs to an existing connection", async () => {
    await expect(
      db.credentials.saveCredentials(encrypted("unknown-connection")),
    ).rejects.toThrow();
  });
});

describe.skipIf(!postgresUrl)("PostgreSQL provider credentials", () => {
  let admin: Pool;
  let pool: Pool;
  let databaseName: string;
  let databaseUrl: string;

  beforeEach(async () => {
    admin = new Pool({ connectionString: postgresUrl });
    databaseName = `fonds_credentials_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const connection = new URL(postgresUrl!);
    connection.pathname = `/${databaseName}`;
    databaseUrl = connection.href;
    pool = new Pool({ ...financialPoolConfig(databaseUrl) });
    await initializePostgresDatabase(pool);
    await initializePostgresDatabase(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      if (databaseName) {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      }
      await admin.end();
    }
  });

  storeContract(() => createPostgresCredentialStore(pool));

  it("keeps credentials in the operations schema", async () => {
    const tables = await pool.query<{ schemaname: string }>(
      "SELECT schemaname FROM pg_tables WHERE tablename='provider_credentials'",
    );
    expect(tables.rows).toEqual([{ schemaname: "operations" }]);
  });

  it("stores credentials from the connect command for an existing connection only", async () => {
    // `init` binds only a database whose schemas it creates.
    await pool.end();
    await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new Pool({ ...financialPoolConfig(databaseUrl) });
    const directory = mkdtempSync(join(tmpdir(), "fonds-pg-connect-"));
    const stateDir = join(directory, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    const { credentialsKey } = await resolveInstallation(stateDir, {
      create: true,
    });
    const env = { FONDS_DATABASE_URL: databaseUrl, FONDS_STATE_DIR: stateDir };
    const credentials = {
      username: "INVENTED-PRIVATE-USER",
      password: "INVENTED-PRIVATE-PASSWORD",
      cardSuffix: "123456",
    };
    const path = join(directory, "invented.json");
    writeFileSync(path, JSON.stringify(credentials), { mode: 0o600 });
    const fd = openSync(path, "r");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((text) => {
      output.push(String(text));
      return true;
    });
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      errors.push(String(text));
      return true;
    });
    const otherState = join(directory, "other");
    mkdirSync(otherState, { mode: 0o700 });
    await resolveInstallation(otherState, { create: true });
    try {
      expect(
        await runPostgresCommand(
          ["init", "--connection", "isracard-pg", "--provider", "isracard"],
          env,
        ),
      ).toBe(0);
      output.length = 0;
      expect(
        await runPostgresCommand(
          [
            "connect",
            "--connection",
            "isracard-pg",
            "--credentials-fd",
            String(fd),
          ],
          env,
        ),
      ).toBe(0);
      expect(
        await runPostgresCommand(
          [
            "connect",
            "--connection",
            "isracard-pg",
            "--credentials-fd",
            String(fd),
          ],
          env,
          directory,
        ),
      ).toBe(1);
      expect(
        await runPostgresCommand(["connect", "--connection", "missing"], env),
      ).toBe(1);
      expect(
        await runPostgresCommand(["connect", "--connection", "isracard-pg"], {
          ...env,
          FONDS_STATE_DIR: otherState,
        }),
      ).toBe(1);
    } finally {
      closeSync(fd);
      rmSync(directory, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
    expect(output.map((line) => JSON.parse(line))).toEqual([
      {
        connectionId: "isracard-pg",
        provider: "isracard",
        credentials: "stored",
      },
    ]);
    expect(errors).toEqual([
      // Only the successful connect explains how scheduled collection starts.
      "Scheduled collection runs only when the service sets FONDS_COLLECTION_SCHEDULE=daily (or hourly, or hours such as 9,13,18).\n",
      "Could not read credentials: use a private current-owner file outside the repository through a descriptor of at least 3.\n",
      "Connection not found; initialize it first.\n",
      "These secrets do not match the database's installation; restore the state directory (fonds.env) backed up with this database\n",
    ]);
    expect(
      await createCredentialVault(
        createPostgresCredentialStore(pool),
        credentialsKey,
      ).load({ id: "isracard-pg", provider: "isracard" }),
    ).toEqual(credentials);
  });
});
