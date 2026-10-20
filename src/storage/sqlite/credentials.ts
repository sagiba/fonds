import type { InValue, ResultSet } from "@libsql/client/web";

import type {
  CredentialStore,
  EncryptedCredentials,
} from "../../application/credential-store.js";

type Execute = (sql: string, args: InValue[]) => Promise<ResultSet>;

/** Encrypted rows live in the ledger file; their key never does. */
export function createSqliteCredentialStore(execute: Execute): CredentialStore {
  return {
    async getCredentials(connectionId) {
      const result = await execute(
        "SELECT connection_id,provider,version,key_id,nonce,ciphertext FROM provider_credentials WHERE connection_id=?",
        [connectionId],
      );
      const row = result.rows[0];
      if (!row) {
        return undefined;
      }
      return {
        connectionId: String(row.connection_id),
        provider: String(row.provider),
        version: row.version as EncryptedCredentials["version"],
        keyId: String(row.key_id),
        nonce: new Uint8Array(row.nonce as ArrayBuffer),
        ciphertext: new Uint8Array(row.ciphertext as ArrayBuffer),
      };
    },
    async saveCredentials(credentials) {
      const now = new Date().toISOString();
      await execute(
        `INSERT INTO provider_credentials
          (connection_id,provider,version,key_id,nonce,ciphertext,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (connection_id) DO UPDATE SET
          provider=excluded.provider,version=excluded.version,key_id=excluded.key_id,
          nonce=excluded.nonce,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at`,
        [
          credentials.connectionId,
          credentials.provider,
          credentials.version,
          credentials.keyId,
          credentials.nonce,
          credentials.ciphertext,
          now,
          now,
        ],
      );
    },
  };
}
