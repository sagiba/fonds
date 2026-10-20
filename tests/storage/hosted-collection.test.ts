import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createCredentialVault,
  generateCredentialsKey,
  parseCredentialsKey,
} from "../../src/runtime/credential-vault.js";
import {
  hostedCollectionTargets,
  hostedConfiguration,
} from "../../src/runtime/hosted-service.js";
import { financialPoolConfig } from "../../src/runtime/postgres-environment.js";
import { runtimeProvider } from "../../src/runtime/providers.js";
import { createPostgresCredentialStore } from "../../src/storage/postgres/credentials.js";
import {
  initializePostgresDatabase,
  openPostgresDatabase,
} from "../../src/storage/postgres/store.js";
import { dropWhenIdle } from "../helpers/postgres-database.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)("hosted PostgreSQL collection targets", () => {
  let admin: Pool;
  let databaseName: string;
  let store: ReturnType<typeof openPostgresDatabase>;

  beforeEach(async () => {
    admin = new Pool({ connectionString: postgresUrl });
    databaseName = `fonds_targets_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${databaseName}`;
    store = openPostgresDatabase(financialPoolConfig(url.href));
    await initializePostgresDatabase(store.pool);
  });

  afterEach(async () => {
    await store.close();
    await dropWhenIdle(admin, databaseName);
    await admin.end();
  });

  it("collects the env-configured connection and every connection with stored credentials", async () => {
    const key = generateCredentialsKey();
    const vault = createCredentialVault(
      createPostgresCredentialStore(store.pool),
      parseCredentialsKey(key),
    );
    for (const connection of [
      { id: "env-cal", provider: "cal" },
      { id: "stored-cal", provider: "cal" },
      { id: "stored-isracard", provider: "isracard" },
      { id: "no-credentials", provider: "cal" },
    ]) {
      await store.ensureConnection(connection);
    }
    await vault.save(
      { id: "stored-cal", provider: "cal" },
      { username: "synthetic-cal-user", password: "synthetic-password" },
    );
    await vault.save(
      { id: "stored-isracard", provider: "isracard" },
      {
        username: "synthetic-isracard-user",
        password: "synthetic-password",
        cardSuffix: "001234",
      },
    );
    const config = hostedConfiguration({
      FONDS_PUBLIC_ORIGIN: "https://fonds.synthetic.invalid",
      FONDS_AUTH_SECRET: "synthetic-auth-secret-00000000000000000000",
      FONDS_OWNER_ID: "synthetic-owner",
      FONDS_REFRESH_SECRET: "synthetic-collection-secret-000000000000000",
      FONDS_CONNECTION_ID: "env-cal",
      FONDS_CONNECTION_PROVIDER: "cal",
      FONDS_CONNECTION_CREDENTIALS: JSON.stringify({
        username: "synthetic-env-user",
        password: "synthetic-env-password",
      }),
      FONDS_CREDENTIALS_KEY: key,
    });
    const received = new Map<string, unknown>();
    const providerFor = ((name: string) => {
      const real = runtimeProvider(name);
      return {
        ...real,
        createCollector: (credentials: Record<string, string>) => {
          received.set(credentials.username!, credentials);
          return real.createCollector(credentials);
        },
      };
    }) as typeof runtimeProvider;
    const { targets, failures } = await hostedCollectionTargets(
      config,
      store,
      store.pool,
      providerFor,
    )();
    expect(failures).toBe(0);
    expect(
      targets.map(({ connectionId, adapter }) => [
        connectionId,
        adapter.provider,
      ]),
    ).toEqual([
      ["env-cal", "cal"],
      ["stored-cal", "cal"],
      ["stored-isracard", "isracard"],
    ]);
    // Collectors are built from each connection's own credentials, per run.
    for (const target of targets) {
      expect((await target.collector()).provider).toBe(target.adapter.provider);
    }
    // Each collector got its own connection's decrypted credentials.
    expect([...received.values()]).toEqual([
      { username: "synthetic-env-user", password: "synthetic-env-password" },
      { username: "synthetic-cal-user", password: "synthetic-password" },
      {
        username: "synthetic-isracard-user",
        password: "synthetic-password",
        cardSuffix: "001234",
      },
    ]);
  });

  it("never hides a connection when discovery reads fail", async () => {
    const key = generateCredentialsKey();
    for (const id of ["env-cal", "stored-cal"]) {
      await store.ensureConnection({ id, provider: "cal" });
    }
    const config = hostedConfiguration({
      FONDS_PUBLIC_ORIGIN: "https://fonds.synthetic.invalid",
      FONDS_AUTH_SECRET: "synthetic-auth-secret-00000000000000000000",
      FONDS_OWNER_ID: "synthetic-owner",
      FONDS_REFRESH_SECRET: "synthetic-collection-secret-000000000000000",
      FONDS_CONNECTION_ID: "env-cal",
      FONDS_CONNECTION_PROVIDER: "cal",
      FONDS_CONNECTION_CREDENTIALS: JSON.stringify({
        username: "synthetic-env-user",
        password: "synthetic-env-password",
      }),
      FONDS_CREDENTIALS_KEY: key,
    });
    const discover = hostedCollectionTargets(config, store, store.pool);
    // Unreadable credentials: the connection fails inside its own job.
    await store.pool.query("DROP TABLE operations.provider_credentials");
    const unreadable = await discover();
    expect(unreadable.failures).toBe(0);
    expect(unreadable.targets.map((target) => target.connectionId)).toEqual([
      "env-cal",
      "stored-cal",
    ]);
    await expect(unreadable.targets[1]!.collector()).rejects.toThrow();
    // Unreadable connections: the env target survives and the run fails.
    await store.pool.query("DROP TABLE financial.connections CASCADE");
    const lost = await discover();
    expect(lost.failures).toBe(1);
    expect(lost.targets.map((target) => target.connectionId)).toEqual([
      "env-cal",
    ]);
  });

  it("collects only the env-configured connection without a credentials key", async () => {
    await store.ensureConnection({ id: "env-cal", provider: "cal" });
    const config = hostedConfiguration({
      FONDS_PUBLIC_ORIGIN: "https://fonds.synthetic.invalid",
      FONDS_AUTH_SECRET: "synthetic-auth-secret-00000000000000000000",
      FONDS_OWNER_ID: "synthetic-owner",
      FONDS_REFRESH_SECRET: "synthetic-collection-secret-000000000000000",
      FONDS_CONNECTION_ID: "env-cal",
      FONDS_CONNECTION_PROVIDER: "cal",
      FONDS_CONNECTION_CREDENTIALS: JSON.stringify({
        username: "synthetic-env-user",
        password: "synthetic-env-password",
      }),
    });
    expect(
      (await hostedCollectionTargets(config, store, store.pool)()).targets.map(
        (target) => target.connectionId,
      ),
    ).toEqual(["env-cal"]);
  });
});
