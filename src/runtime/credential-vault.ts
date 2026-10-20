import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import type {
  CredentialStore,
  EncryptedCredentials,
} from "../application/credential-store.js";
import {
  parseCredentials,
  type ProviderCredentials,
} from "../domain/credentials.js";
import { runtimeProvider } from "./providers.js";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Messages are fixed: they never include keys, ciphertext or credential values. */
export class CredentialVaultError extends Error {}

const unreadable = () =>
  new CredentialVaultError(
    "Stored provider credentials could not be decrypted with the configured key.",
  );

export interface CredentialsKey {
  /** Stable, non-secret identifier stored beside each ciphertext. */
  id: string;
  bytes: Buffer;
}

export function generateCredentialsKey(): string {
  return randomBytes(32).toString("base64url");
}

/** Exactly 32 bytes in canonical unpadded base64url. */
export function parseCredentialsKey(text: string): CredentialsKey {
  const bytes = /^[A-Za-z0-9_-]{43}$/.test(text)
    ? Buffer.from(text, "base64url")
    : undefined;
  if (bytes?.length !== 32 || bytes.toString("base64url") !== text) {
    throw new CredentialVaultError("Invalid credentials key.");
  }
  const id = createHash("sha256")
    .update("fonds-credentials-key-id-v1\0")
    .update(bytes)
    .digest("base64url")
    .slice(0, 16);
  return { id, bytes };
}

/** Binds a ciphertext to one connection and provider; rows cannot be swapped. */
function additionalData(connectionId: string, provider: string) {
  return Buffer.from(
    JSON.stringify(["fonds-credentials-v1", provider, connectionId]),
  );
}

export function encryptCredentials(
  key: CredentialsKey,
  connection: { id: string; provider: string },
  credentials: ProviderCredentials,
): EncryptedCredentials {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.bytes, nonce);
  cipher.setAAD(additionalData(connection.id, connection.provider));
  const plaintext = Buffer.from(JSON.stringify(credentials));
  try {
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      connectionId: connection.id,
      provider: connection.provider,
      version: 1,
      keyId: key.id,
      nonce,
      ciphertext,
    };
  } finally {
    plaintext.fill(0);
  }
}

export function decryptCredentials(
  key: CredentialsKey,
  connection: { id: string; provider: string },
  stored: EncryptedCredentials,
): unknown {
  if (
    stored.version !== 1 ||
    stored.keyId !== key.id ||
    stored.connectionId !== connection.id ||
    stored.provider !== connection.provider ||
    stored.nonce.byteLength !== NONCE_BYTES ||
    stored.ciphertext.byteLength <= TAG_BYTES
  ) {
    throw unreadable();
  }
  const ciphertext = Buffer.from(stored.ciphertext);
  const decipher = createDecipheriv(
    ALGORITHM,
    key.bytes,
    Buffer.from(stored.nonce),
    { authTagLength: TAG_BYTES },
  );
  decipher.setAAD(additionalData(connection.id, connection.provider));
  decipher.setAuthTag(ciphertext.subarray(-TAG_BYTES));
  // Wipe every plaintext chunk, including output released before a tag failure.
  const chunks: Buffer[] = [];
  try {
    chunks.push(decipher.update(ciphertext.subarray(0, -TAG_BYTES)));
    chunks.push(decipher.final());
    chunks.push(Buffer.concat(chunks));
    return JSON.parse(chunks.at(-1)!.toString("utf8"));
  } catch {
    throw unreadable();
  } finally {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  }
}

/** Plaintext is validated against the provider's credential fields both ways. */
export function createCredentialVault(
  store: CredentialStore,
  key: CredentialsKey,
) {
  return {
    async save(
      connection: { id: string; provider: string },
      credentials: ProviderCredentials,
    ): Promise<void> {
      const input = runtimeProvider(connection.provider).credentials;
      await store.saveCredentials(
        encryptCredentials(
          key,
          connection,
          parseCredentials(credentials, input),
        ),
      );
    },
    async load(connection: {
      id: string;
      provider: string;
    }): Promise<ProviderCredentials | undefined> {
      const stored = await store.getCredentials(connection.id);
      if (!stored) {
        return undefined;
      }
      const input = runtimeProvider(connection.provider).credentials;
      try {
        return parseCredentials(
          decryptCredentials(key, connection, stored),
          input,
        );
      } catch {
        throw unreadable();
      }
    },
  };
}

export type CredentialVault = ReturnType<typeof createCredentialVault>;
