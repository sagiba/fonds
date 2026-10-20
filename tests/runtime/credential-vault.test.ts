import { describe, expect, it, vi } from "vitest";

import type {
  CredentialStore,
  EncryptedCredentials,
} from "../../src/application/credential-store.js";
import {
  createCredentialVault,
  decryptCredentials,
  encryptCredentials,
  generateCredentialsKey,
  parseCredentialsKey,
} from "../../src/runtime/credential-vault.js";

const unreadable =
  "Stored provider credentials could not be decrypted with the configured key.";
const cal = { id: "cal-connection", provider: "cal" };
const calCredentials = {
  username: "INVENTED-PRIVATE-USER",
  password: "INVENTED-PRIVATE-PASSWORD",
};

function memoryStore(): CredentialStore & {
  rows: Map<string, EncryptedCredentials>;
} {
  const rows = new Map<string, EncryptedCredentials>();
  return {
    rows,
    getCredentials: async (connectionId) => rows.get(connectionId),
    saveCredentials: async (credentials) => {
      rows.set(credentials.connectionId, credentials);
    },
  };
}

describe("credentials key", () => {
  it("accepts only canonical 32-byte base64url keys with a stable non-secret id", () => {
    const text = generateCredentialsKey();
    const key = parseCredentialsKey(text);
    expect(key.bytes).toHaveLength(32);
    expect(parseCredentialsKey(text).id).toBe(key.id);
    expect(key.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(text).not.toContain(key.id);
    expect(parseCredentialsKey(generateCredentialsKey()).id).not.toBe(key.id);
    for (const invalid of [
      "",
      "short",
      `${text}=`,
      `${text}A`,
      text.slice(0, -1),
      `${text.slice(0, -1)}+`,
      // Same decoded bytes, non-canonical final character.
      `${"A".repeat(42)}B`,
    ]) {
      expect(() => parseCredentialsKey(invalid)).toThrow(
        /^Invalid credentials key\.$/,
      );
    }
  });
});

describe("credential encryption", () => {
  const key = parseCredentialsKey(generateCredentialsKey());

  it("round-trips without storing plaintext", () => {
    const stored = encryptCredentials(key, cal, calCredentials);
    expect(stored).toMatchObject({
      connectionId: cal.id,
      provider: "cal",
      version: 1,
      keyId: key.id,
    });
    expect(stored.nonce).toHaveLength(12);
    const bytes = Buffer.from(stored.ciphertext);
    for (const value of Object.values(calCredentials)) {
      expect(bytes.includes(value)).toBe(false);
    }
    expect(decryptCredentials(key, cal, stored)).toEqual(calCredentials);
    expect(
      Buffer.from(encryptCredentials(key, cal, calCredentials).nonce),
    ).not.toEqual(Buffer.from(stored.nonce));
  });

  it("rejects tampering, another key, another connection or provider, and other versions with one fixed error", () => {
    const stored = encryptCredentials(key, cal, calCredentials);
    const flipped = (index: number) => {
      const ciphertext = new Uint8Array(stored.ciphertext);
      ciphertext[index]! ^= 1;
      return { ...stored, ciphertext };
    };
    const otherKey = parseCredentialsKey(generateCredentialsKey());
    const cases: [typeof key, typeof cal, EncryptedCredentials][] = [
      [key, cal, flipped(0)],
      [key, cal, flipped(stored.ciphertext.length - 1)],
      [key, cal, { ...stored, nonce: new Uint8Array(12) }],
      [otherKey, cal, stored],
      [{ ...otherKey, id: key.id }, cal, stored],
      [key, { ...cal, id: "other-connection" }, stored],
      [
        key,
        { ...cal, id: "other-connection" },
        { ...stored, connectionId: "other-connection" },
      ],
      [
        key,
        { ...cal, provider: "isracard" },
        { ...stored, provider: "isracard" },
      ],
      [key, cal, { ...stored, version: 2 as unknown as 1 }],
      [key, cal, { ...stored, ciphertext: stored.ciphertext.slice(0, 16) }],
    ];
    for (const [candidateKey, connection, candidate] of cases) {
      expect(() =>
        decryptCredentials(candidateKey, connection, candidate),
      ).toThrow(new RegExp(`^${unreadable}$`));
    }
  });

  it("wipes plaintext released before a failed authentication tag", () => {
    const stored = encryptCredentials(key, cal, calCredentials);
    const ciphertext = new Uint8Array(stored.ciphertext);
    ciphertext[ciphertext.length - 1]! ^= 1;
    const fill = vi.spyOn(Buffer.prototype, "fill");
    try {
      expect(() =>
        decryptCredentials(key, cal, { ...stored, ciphertext }),
      ).toThrow(new RegExp(`^${unreadable}$`));
      expect(
        fill.mock.contexts.some(
          (buffer) =>
            (buffer as Buffer).length > 0 &&
            (buffer as Buffer).every((byte) => byte === 0),
        ),
      ).toBe(true);
    } finally {
      fill.mockRestore();
    }
  });
});

describe("credential vault", () => {
  const key = parseCredentialsKey(generateCredentialsKey());

  it("stores and loads CAL and Isracard credentials through each provider's fields", async () => {
    const store = memoryStore();
    const vault = createCredentialVault(store, key);
    const isracard = { id: "isracard-connection", provider: "isracard" };
    const isracardCredentials = { ...calCredentials, cardSuffix: "123456" };
    await vault.save(cal, calCredentials);
    await vault.save(isracard, isracardCredentials);
    expect(await vault.load(cal)).toEqual(calCredentials);
    expect(await vault.load(isracard)).toEqual(isracardCredentials);
    expect(await vault.load({ id: "absent", provider: "cal" })).toBeUndefined();
    await expect(vault.save(isracard, calCredentials)).rejects.toThrow();
    await expect(
      vault.save(cal, { ...calCredentials, cardSuffix: "123456" }),
    ).rejects.toThrow();
    expect(await vault.load(isracard)).toEqual(isracardCredentials);
    await vault.save(cal, { ...calCredentials, password: "INVENTED-NEXT" });
    expect(await vault.load(cal)).toMatchObject({ password: "INVENTED-NEXT" });
  });

  it("refuses a row moved to another connection or read with another key", async () => {
    const store = memoryStore();
    await createCredentialVault(store, key).save(cal, calCredentials);
    store.rows.set("moved", {
      ...store.rows.get(cal.id)!,
      connectionId: "moved",
    });
    await expect(
      createCredentialVault(store, key).load({ id: "moved", provider: "cal" }),
    ).rejects.toThrow(new RegExp(`^${unreadable}$`));
    await expect(
      createCredentialVault(
        store,
        parseCredentialsKey(generateCredentialsKey()),
      ).load(cal),
    ).rejects.toThrow(new RegExp(`^${unreadable}$`));
    await expect(
      createCredentialVault(store, key).load({ ...cal, provider: "isracard" }),
    ).rejects.toThrow(new RegExp(`^${unreadable}$`));
  });
});
