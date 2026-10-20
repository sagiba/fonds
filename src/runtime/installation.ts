import { createHash } from "node:crypto";

import type { InstallationFingerprint } from "../application/installation.js";
import {
  type CredentialsKey,
  parseCredentialsKey,
} from "./credential-vault.js";
import {
  loadState,
  REQUIRED_SECRETS,
  STATE_FILE,
  StateError,
} from "./state.js";

/** A non-secret, stable digest identifying the auth secret. */
function authSecretDigest(secret: string) {
  return createHash("sha256")
    .update("fonds-auth-secret-digest-v1\0")
    .update(secret)
    .digest("base64url");
}

/** The fingerprint of an installation's secrets; the owner ID as parsed, trimmed. */
export function installationFingerprint(secrets: {
  ownerId: string;
  secret: string;
  credentialsKeyId: string | null;
}): InstallationFingerprint {
  return {
    ownerId: secrets.ownerId.trim(),
    authSecretDigest: authSecretDigest(secrets.secret),
    credentialsKeyId: secrets.credentialsKeyId,
  };
}

/** One installation's secrets, resolved once per process. */
export interface Installation {
  /** Undefined when the Neon env file is the state. */
  stateDirectory: string | undefined;
  /** The state's variables, such as FONDS_API_TOKEN. */
  secrets: Readonly<Record<string, string | undefined>>;
  credentialsKey: CredentialsKey;
  fingerprint: InstallationFingerprint;
}

/**
 * An installation from its secrets, wherever they are kept: the state file on
 * Node targets, the private env file Neon delivers as its environment.
 */
export function installationFromSecrets(
  secrets: Readonly<Record<string, string | undefined>>,
  source: { stateDirectory?: string; description: string },
): Installation {
  const absent = REQUIRED_SECRETS.filter((name) => !secrets[name]);
  if (absent.length) {
    throw new StateError(`${source.description} lacks ${absent.join(", ")}`);
  }
  let credentialsKey: CredentialsKey;
  try {
    credentialsKey = parseCredentialsKey(secrets.FONDS_CREDENTIALS_KEY!);
  } catch {
    throw new StateError(
      `${source.description} has an invalid FONDS_CREDENTIALS_KEY`,
    );
  }
  return {
    stateDirectory: source.stateDirectory,
    secrets,
    credentialsKey,
    fingerprint: installationFingerprint({
      ownerId: secrets.FONDS_OWNER_ID!,
      secret: secrets.FONDS_AUTH_SECRET!,
      credentialsKeyId: credentialsKey.id,
    }),
  };
}

export async function resolveInstallation(
  stateDirectory: string,
  options: { create: boolean; lockWaitMs?: number },
): Promise<Installation> {
  return installationFromSecrets(await loadState(stateDirectory, options), {
    stateDirectory,
    description: `The state file in ${stateDirectory}`,
  });
}

/** The refusal for a database bound to other secrets. */
export const INSTALLATION_MISMATCH = `These secrets do not match the database's installation; restore the state directory (${STATE_FILE}) backed up with this database`;

/** The refusal for an existing database that was never bound. */
export const INSTALLATION_UNBOUND =
  "This database has no installation record; open it with the state directory it was created with, or initialize a new database";
