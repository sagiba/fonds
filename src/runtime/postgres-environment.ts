import { resolve } from "node:path";

import type { Pool, PoolConfig } from "pg";

import {
  type InstallationFingerprint,
  sameInstallation,
} from "../application/installation.js";
import { createPostgresCredentialStore } from "../storage/postgres/credentials.js";
import { createPostgresEventStore } from "../storage/postgres/events.js";
import {
  hasFondsSchema,
  readInstallation,
} from "../storage/postgres/installation.js";
import {
  FINANCIAL_SCHEMA,
  initializePostgresDatabase,
  openPostgresDatabase,
} from "../storage/postgres/store.js";
import { HostedConfigurationError } from "./hosted-service.js";
import {
  type Installation,
  INSTALLATION_MISMATCH,
  INSTALLATION_UNBOUND,
  installationFromSecrets,
  resolveInstallation,
} from "./installation.js";
import { CommandInputError } from "./operation-cli.js";
import type { BackendSession } from "./operator-cli.js";
import { STATE_SECRETS, StateError } from "./state.js";

export { FINANCIAL_SCHEMA } from "../storage/postgres/store.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The sslmode values that refuse a plaintext connection. */
const ENCRYPTED_SSL_MODES = ["require", "verify-ca", "verify-full"];

/**
 * A PostgreSQL URL whose host and TLS are what they appear to be. `pg` lets URL
 * parameters override everything (host, options, TLS), so only one `sslmode`
 * parameter is accepted. A non-loopback host needs TLS unless the operator
 * explicitly states a private network.
 */
export function databaseUrl(
  value: string,
  options: { allowPlaintextRemote?: boolean } = {},
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HostedConfigurationError("FONDS_DATABASE_URL is not a URL");
  }
  const names = [...url.searchParams.keys()];
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    names.some((name) => name !== "sslmode") ||
    names.length > 1
  ) {
    throw new HostedConfigurationError(
      "FONDS_DATABASE_URL must be postgresql://… with at most one sslmode parameter",
    );
  }
  if (
    !LOOPBACK_HOSTS.has(url.hostname) &&
    !options.allowPlaintextRemote &&
    !ENCRYPTED_SSL_MODES.includes(url.searchParams.get("sslmode") ?? "")
  ) {
    throw new HostedConfigurationError(
      "FONDS_DATABASE_URL needs sslmode=verify-full for a non-loopback host, or FONDS_DATABASE_TLS=disable on a private network",
    );
  }
  return url.href;
}

/** A pool configuration whose schema selection the URL cannot override. */
export function financialPoolConfig(connectionString: string): PoolConfig {
  return {
    connectionString: databaseUrl(connectionString, {
      allowPlaintextRemote: true,
    }),
    options: `-c search_path=${FINANCIAL_SCHEMA}`,
  };
}

/**
 * Every PostgreSQL entry point's installation and environment, resolved once
 * per process. Node hosts keep their secrets in FONDS_STATE_DIR/fonds.env,
 * the only source of secrets there. Neon keeps them in its private env file,
 * which reaches the process as its environment (identified by Neon's own
 * FONDS_NEON_GOOGLE_AUTH_URL): there the environment is the state.
 */
export async function postgresInstallation(
  env: NodeJS.ProcessEnv,
  options: { create: boolean; lockWaitMs?: number },
): Promise<{ installation: Installation; env: NodeJS.ProcessEnv }> {
  if (env.FONDS_STATE_DIR) {
    const installation = await resolveInstallation(
      resolve(env.FONDS_STATE_DIR),
      options,
    );
    // Every installation secret comes from the file or is absent; none is
    // inherited from the environment.
    const resolved = { ...env };
    for (const name of STATE_SECRETS) {
      const value = installation.secrets[name];
      if (value) {
        resolved[name] = value;
      } else {
        delete resolved[name];
      }
    }
    return { installation, env: resolved };
  }
  if (env.FONDS_NEON_GOOGLE_AUTH_URL) {
    return { installation: neonInstallation(env), env };
  }
  throw new StateError(
    "FONDS_STATE_DIR is required: it holds this installation's secrets",
  );
}

/** Neon's installation: its private env file, delivered as the environment. */
export function neonInstallation(env: NodeJS.ProcessEnv) {
  return installationFromSecrets(env, {
    description: "The Neon private env file",
  });
}

/**
 * Provisions the database and binds it to the installation: a fresh database
 * is migrated and bound in one transaction, and an existing one must already
 * be bound to these secrets before its pending migrations run. A database
 * whose Fonds schema exists without a binding is refused, untouched.
 */
export async function bindPostgresInstallation(
  pool: Pool,
  fingerprint: InstallationFingerprint,
) {
  const recorded = await readInstallation(pool);
  if (recorded && !sameInstallation(recorded, fingerprint)) {
    throw new StateError(INSTALLATION_MISMATCH);
  }
  // Only provisioning that creates the schemas binds; an existing schema
  // without a binding is never adopted, even with no rows.
  if (!recorded && (await hasFondsSchema(pool))) {
    throw new StateError(
      "This database has a Fonds schema but no installation record; restore its original secrets and installation",
    );
  }
  const bound = await initializePostgresDatabase(pool, {
    installation: fingerprint,
  });
  // A concurrent first start may have bound other secrets first.
  if (!bound || !sameInstallation(bound, fingerprint)) {
    throw new StateError(INSTALLATION_MISMATCH);
  }
}

/** Requires the database's binding to match, without writing anything. */
export async function verifyPostgresInstallation(
  pool: Pool,
  fingerprint: InstallationFingerprint,
) {
  const recorded = await readInstallation(pool);
  if (!recorded) {
    throw new StateError(INSTALLATION_UNBOUND);
  }
  if (!sameInstallation(recorded, fingerprint)) {
    throw new StateError(INSTALLATION_MISMATCH);
  }
}

/**
 * The database with its credential and Events stores. `initialize` binds a
 * fresh database and provisions it, as servers and `init` do; otherwise the
 * binding must already match. Either way the schema is migrated and checked:
 * pending migrations apply, and a newer or altered schema is refused.
 */
export async function openPostgresSession(
  env: NodeJS.ProcessEnv,
  installation: Installation,
  options: { initialize: boolean },
): Promise<BackendSession> {
  if (!env.FONDS_DATABASE_URL) {
    throw new CommandInputError(
      "FONDS_DATABASE_URL is required; without it, use the SQLite CLI (node dist/cli.js).",
    );
  }
  const store = openPostgresDatabase(
    financialPoolConfig(env.FONDS_DATABASE_URL),
  );
  try {
    if (options.initialize) {
      await bindPostgresInstallation(store.pool, installation.fingerprint);
    } else {
      await verifyPostgresInstallation(store.pool, installation.fingerprint);
      await initializePostgresDatabase(store.pool);
    }
    return {
      store,
      credentials: createPostgresCredentialStore(store.pool),
      eventSubscriptions: createPostgresEventStore(store.pool, store),
      credentialsKey: installation.credentialsKey,
      close: () => store.close(),
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
