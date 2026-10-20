import type { PoolClient } from "pg";

import type { InstallationFingerprint } from "../../application/installation.js";

/** A pool or one of its clients, inside a transaction. */
type Queryable = Pick<PoolClient, "query">;

type InstallationRow = {
  owner_id: string;
  auth_secret_digest: string;
  credentials_key_id: string | null;
};

/** The recorded installation, read without DDL; undefined when none is recorded. */
export async function readInstallation(
  db: Queryable,
): Promise<InstallationFingerprint | undefined> {
  const { rows: present } = await db.query<{ table: string | null }>(
    "SELECT to_regclass('operations.installation')::text AS table",
  );
  if (!present[0]?.table) {
    return undefined;
  }
  const row = (
    await db.query<InstallationRow>(
      "SELECT owner_id, auth_secret_digest, credentials_key_id FROM operations.installation",
    )
  ).rows[0];
  return (
    row && {
      ownerId: row.owner_id,
      authSecretDigest: row.auth_secret_digest,
      credentialsKeyId: row.credentials_key_id,
    }
  );
}

/**
 * Whether any Fonds schema already exists: the ledger, stored credentials or
 * the owner. Only a database with none of them is fresh, whether or not those
 * tables hold rows.
 */
export async function hasFondsSchema(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    `SELECT bool_or(to_regclass(name) IS NOT NULL) AS present FROM unnest(ARRAY[
       'identity."user"', 'financial.connections',
       'operations.provider_credentials'
     ]) AS name`,
  );
  return rows[0]?.present === true;
}

/**
 * Records the installation unless one is recorded, then returns the recorded
 * one: a concurrent first start may have recorded other secrets first.
 */
export async function recordInstallation(
  db: Queryable,
  fingerprint: InstallationFingerprint,
): Promise<InstallationFingerprint | undefined> {
  await db.query(
    `INSERT INTO operations.installation (owner_id, auth_secret_digest, credentials_key_id)
     VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [
      fingerprint.ownerId,
      fingerprint.authSecretDigest,
      fingerprint.credentialsKeyId,
    ],
  );
  return readInstallation(db);
}
