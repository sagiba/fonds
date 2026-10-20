import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

/** Minimal CBOR for WebAuthn attestation: integers, text, bytes and maps. */
function cbor(value: unknown): Buffer {
  const head = (major: number, length: number) =>
    length < 24
      ? Buffer.from([(major << 5) | length])
      : length < 256
        ? Buffer.from([(major << 5) | 24, length])
        : Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  if (typeof value === "number") {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  }
  const entries =
    value instanceof Map ? [...value] : Object.entries(value as object);
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)]),
  ]);
}

const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest();

/**
 * A synthetic platform authenticator: one P-256 credential with "none"
 * attestation. `userVerified` sets the WebAuthn UV flag on each ceremony.
 */
export function syntheticAuthenticator(rpId: string, origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(16);
  const id = credentialId.toString("base64url");
  let counter = 0;

  function authenticatorData(userVerified: boolean, attested: boolean) {
    const flags = 0x01 | (userVerified ? 0x04 : 0) | (attested ? 0x40 : 0);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++counter);
    const parts: Uint8Array[] = [sha256(rpId), Buffer.from([flags]), count];
    if (attested) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      parts.push(
        Buffer.alloc(16),
        length,
        credentialId,
        cbor(
          new Map<number, unknown>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, Buffer.from(jwk.x!, "base64url")],
            [-3, Buffer.from(jwk.y!, "base64url")],
          ]),
        ),
      );
    }
    return Buffer.concat(parts);
  }

  const clientData = (type: string, challenge: string) =>
    Buffer.from(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );

  return {
    id,
    register(challenge: string, userVerified = true) {
      return {
        id,
        rawId: id,
        type: "public-key",
        response: {
          clientDataJSON: clientData("webauthn.create", challenge).toString(
            "base64url",
          ),
          attestationObject: cbor({
            fmt: "none",
            attStmt: {},
            authData: authenticatorData(userVerified, true),
          }).toString("base64url"),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    authenticate(challenge: string, userVerified = true) {
      const data = authenticatorData(userVerified, false);
      const client = clientData("webauthn.get", challenge);
      return {
        id,
        rawId: id,
        type: "public-key",
        response: {
          clientDataJSON: client.toString("base64url"),
          authenticatorData: data.toString("base64url"),
          signature: sign(
            "sha256",
            Buffer.concat([data, sha256(client)]),
            privateKey,
          ).toString("base64url"),
        },
        clientExtensionResults: {},
      };
    },
  };
}
