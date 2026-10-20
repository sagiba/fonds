import { resolve } from "node:path";

import {
  type InstallationFingerprint,
  sameInstallation,
} from "../application/installation.js";
import { openDatabase } from "../storage/sqlite/database.js";
import { outsideDirectory } from "./checkout.js";
import { dataHome, ensureDataHome } from "./data-home.js";
import {
  type Installation,
  INSTALLATION_MISMATCH,
  INSTALLATION_UNBOUND,
} from "./installation.js";
import type { BackendSession } from "./operator-cli.js";
import { StateError } from "./state.js";

/** The `settings` entry that binds a SQLite ledger to its installation. */
export const INSTALLATION_SETTING = "installation";

/**
 * The SQLite state directory: `FONDS_STATE_DIR`, otherwise the data home that
 * holds the default database, created 0700 on first use. It is refused inside
 * `protectedRoot` (the repository), even through a symlinked parent.
 */
export function localStateDirectory(
  env: NodeJS.ProcessEnv,
  protectedRoot?: string,
) {
  const path = resolve(env.FONDS_STATE_DIR || dataHome(env));
  if (protectedRoot && !outsideDirectory(protectedRoot, path)) {
    throw new StateError("The state directory must be outside the repository.");
  }
  return env.FONDS_STATE_DIR ? path : ensureDataHome(path);
}

function recordedFingerprint(text: string | undefined) {
  if (text === undefined) {
    throw new StateError(INSTALLATION_UNBOUND);
  }
  try {
    return JSON.parse(text) as InstallationFingerprint;
  } catch {
    throw new StateError(INSTALLATION_MISMATCH);
  }
}

/**
 * Opens a local SQLite ledger bound to the installation: a new file records
 * its fingerprint as it is initialized, and any other file must hold the same
 * one. An in-memory database has no state.
 */
export async function openLocalLedger(
  databasePath: string,
  installation: Installation,
) {
  if (databasePath === ":memory:") {
    return openDatabase(databasePath);
  }
  const database = await openDatabase(databasePath, {
    settings: {
      [INSTALLATION_SETTING]: JSON.stringify(installation.fingerprint),
    },
  });
  try {
    if (
      !sameInstallation(
        recordedFingerprint(await database.getSetting(INSTALLATION_SETTING)),
        installation.fingerprint,
      )
    ) {
      throw new StateError(INSTALLATION_MISMATCH);
    }
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

/** A ledger with its credential and Events stores, for the CLI and server. */
export async function openSqliteSession(
  databasePath: string,
  installation: Installation,
): Promise<BackendSession> {
  const database = await openLocalLedger(databasePath, installation);
  return {
    store: database,
    credentials: database.credentials,
    eventSubscriptions: database.eventSubscriptions,
    credentialsKey: installation.credentialsKey,
    close: () => database.close(),
  };
}
