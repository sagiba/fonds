import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { CommandInputError } from "./operation-cli.js";

/** The local ledger used when `--db` is omitted. */
export const DEFAULT_DATABASE = "fonds.sqlite";
/** The synthetic ledger `demo` creates, kept apart from real data. */
export const DEMO_DATABASE = "demo.sqlite";

/**
 * Where local databases live by default: `FONDS_HOME`, otherwise the platform's
 * per-user data directory.
 */
export function dataHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.FONDS_HOME) {
    return resolve(env.FONDS_HOME);
  }
  if (platform === "win32") {
    return join(env.APPDATA || join(home, "AppData", "Roaming"), "Fonds");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Fonds");
  }
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "fonds");
}

/**
 * Creates the data directory as a private 0700 directory on first use. An
 * existing directory must already be private to its owner; its permissions are
 * never changed.
 */
export function ensureDataHome(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new CommandInputError(
      `The Fonds data directory must be a private directory you own (chmod 700): ${directory}`,
    );
  }
  return directory;
}

/**
 * A default database path in the private data directory. `guard` checks the
 * path (for example, that it is outside the repository) before the directory
 * is created.
 */
export function defaultDatabasePath(
  name: string = DEFAULT_DATABASE,
  guard: (path: string) => string = (path) => path,
): string {
  const path = guard(join(dataHome(), name));
  ensureDataHome(dirname(path));
  return path;
}
