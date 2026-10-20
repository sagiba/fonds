import type { Pool } from "pg";

import type {
  CredentialStore,
  EncryptedCredentials,
} from "../../application/credential-store.js";

interface CredentialRow {
  connection_id: string;
  provider: string;
  version: number;
  key_id: string;
  nonce: Buffer;
  ciphertext: Buffer;
}

export function createPostgresCredentialStore(pool: Pool): CredentialStore {
  return {
    async getCredentials(connectionId) {
      const result = await pool.query<CredentialRow>(
        `SELECT connection_id,provider,version,key_id,nonce,ciphertext
         FROM operations.provider_credentials WHERE connection_id=$1`,
        [connectionId],
      );
      const row = result.rows[0];
      if (!row) {
        return undefined;
      }
      return {
        connectionId: row.connection_id,
        provider: row.provider,
        version: row.version as EncryptedCredentials["version"],
        keyId: row.key_id,
        nonce: new Uint8Array(row.nonce),
        ciphertext: new Uint8Array(row.ciphertext),
      };
    },
    async saveCredentials(credentials) {
      await pool.query(
        `INSERT INTO operations.provider_credentials
          (connection_id,provider,version,key_id,nonce,ciphertext,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now(),now())
         ON CONFLICT (connection_id) DO UPDATE SET
          provider=EXCLUDED.provider,version=EXCLUDED.version,key_id=EXCLUDED.key_id,
          nonce=EXCLUDED.nonce,ciphertext=EXCLUDED.ciphertext,updated_at=EXCLUDED.updated_at`,
        [
          credentials.connectionId,
          credentials.provider,
          credentials.version,
          credentials.keyId,
          Buffer.from(credentials.nonce),
          Buffer.from(credentials.ciphertext),
        ],
      );
    },
  };
}
