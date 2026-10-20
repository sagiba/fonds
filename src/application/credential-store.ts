/**
 * One connection's provider credentials as stored: an authenticated ciphertext
 * whose key never enters the database. Plaintext exists only in the runtime.
 */
export interface EncryptedCredentials {
  connectionId: string;
  provider: string;
  /** Envelope format; decryption rejects any other value. */
  version: 1;
  /** Digest of the encrypting key, so a key change is detected before use. */
  keyId: string;
  nonce: Uint8Array;
  /** AES-256-GCM output followed by its 16-byte authentication tag. */
  ciphertext: Uint8Array;
}

/** Operational storage for encrypted credentials, separate from the ledger. */
export interface CredentialStore {
  getCredentials(
    connectionId: string,
  ): Promise<EncryptedCredentials | undefined>;
  /** Replaces any previous credentials for the connection. */
  saveCredentials(credentials: EncryptedCredentials): Promise<void>;
}
