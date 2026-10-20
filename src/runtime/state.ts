import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseEnv } from "node:util";

/** The generated secrets file inside every Node target's state directory. */
export const STATE_FILE = "fonds.env";

/** Fixed, value-free messages; they name paths and variables, never secrets. */
export class StateError extends Error {}

/** Every installation's secrets, generated together once into its state file. */
const GENERATED = {
  FONDS_AUTH_SECRET: () => randomBytes(48).toString("base64url"),
  FONDS_OWNER_ID: () => randomUUID(),
  // 32 random bytes in unpadded base64url, as parseCredentialsKey requires.
  FONDS_CREDENTIALS_KEY: () => randomBytes(32).toString("base64url"),
  FONDS_SCHEDULE_SECRET: () => randomBytes(48).toString("base64url"),
  // Enables collection over stored credentials and the operator endpoint.
  FONDS_COLLECTION_SECRET: () => randomBytes(48).toString("base64url"),
  // The bearer of a loopback HTTP server.
  FONDS_API_TOKEN: () => randomBytes(32).toString("base64url"),
} as const;

/** Every variable the state file owns. */
export const STATE_SECRETS = Object.keys(
  GENERATED,
) as (keyof typeof GENERATED)[];

/** The identity a database is bound to; an operator may remove the others. */
export const REQUIRED_SECRETS = [
  "FONDS_AUTH_SECRET",
  "FONDS_OWNER_ID",
  "FONDS_CREDENTIALS_KEY",
] as const;

function isPrivate(stat: { mode: number; uid: number }) {
  return (
    (stat.mode & 0o077) === 0 &&
    (!process.getuid || stat.uid === process.getuid())
  );
}

/** Owned by another non-root account, or writable by others without the sticky bit. */
function anotherAccountCanChange(stat: { mode: number; uid: number }) {
  return (
    (process.getuid && stat.uid !== 0 && stat.uid !== process.getuid()) ||
    ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
  );
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Creates `fonds.env` under an exclusive lock directory, renaming a complete
 * temporary file into place so readers never see a partial or doubly linked
 * file. A concurrent creator waits for the holder's file instead.
 */
async function createState(
  stateDir: string,
  path: string,
  lockWaitMs: number,
  shown: string,
) {
  const lock = join(stateDir, `${STATE_FILE}.lock`);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    for (const deadline = Date.now() + lockWaitMs; Date.now() < deadline;) {
      if (await exists(path)) {
        return;
      }
      await setTimeout(50);
    }
    throw new StateError(
      `${shown} has a stale ${STATE_FILE}.lock; remove it if no Fonds process is starting`,
    );
  }
  try {
    if (await exists(path)) {
      return;
    }
    const temporary = join(stateDir, `.fonds-${process.pid}-${randomUUID()}`);
    try {
      await writeFile(
        temporary,
        Object.entries(GENERATED)
          .map(([name, generate]) => `${name}=${generate()}\n`)
          .join(""),
        { mode: 0o600, flag: "wx" },
      );
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  } finally {
    await rmdir(lock);
  }
}

/**
 * The state file's text, checked and read through one descriptor opened
 * without following a link, so the file read is the file checked.
 */
async function readPrivateFile(path: string, shown: string) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new StateError(
      `The state file ${shown} must be an owned regular 0600 file`,
    );
  }
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.nlink !== 1 || !isPrivate(file)) {
      throw new StateError(
        `The state file ${shown} must be an owned regular 0600 file`,
      );
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Every directory above the state directory must belong to its user or root,
 * and none may be writable by others unless sticky (as /tmp is), so no other
 * account can replace the path to the secrets.
 */
async function refuseWritableAncestors(stateDir: string, canonical: string) {
  const own = await lstat(canonical);
  if (!own.isDirectory() || !isPrivate(own)) {
    throw new StateError(
      `The state directory ${stateDir} must be an owned 0700 directory`,
    );
  }
  let directory = dirname(canonical);
  for (;;) {
    if (anotherAccountCanChange(await lstat(directory))) {
      throw new StateError(
        `The state directory ${stateDir} is inside ${directory}, which another account can change`,
      );
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return;
    }
    directory = parent;
  }
}

/**
 * Reads `<stateDir>/fonds.env`, which holds every secret of one installation.
 * With `create`, a missing file is generated once; an existing one is only
 * validated, never completed or regenerated. Permissions are never changed.
 */
export async function loadState(
  stateDir: string,
  options: { create: boolean; lockWaitMs?: number },
): Promise<Readonly<Record<string, string | undefined>>> {
  // Resolved once: every later step uses this canonical path, whose
  // directories refuseWritableAncestors shows no other account can change.
  let directory;
  let canonical: string;
  try {
    directory = await lstat(stateDir);
    canonical = await realpath(stateDir);
  } catch {
    throw new StateError(`The state directory ${stateDir} does not exist`);
  }
  if (!directory.isDirectory() || !isPrivate(directory)) {
    throw new StateError(
      `The state directory ${stateDir} must be an owned 0700 directory`,
    );
  }
  await refuseWritableAncestors(stateDir, canonical);
  const path = join(canonical, STATE_FILE);
  const shown = join(stateDir, STATE_FILE);
  if (!(await exists(path))) {
    if (!options.create) {
      throw new StateError(
        `${stateDir} has no ${STATE_FILE}; restore the state directory backed up with this database, or start the service once first`,
      );
    }
    await createState(canonical, path, options.lockWaitMs ?? 10_000, stateDir);
  }
  const state = parseEnv(await readPrivateFile(path, shown));
  const absent = REQUIRED_SECRETS.filter((name) => !state[name]);
  if (absent.length) {
    throw new StateError(
      `The state file ${shown} lacks ${absent.join(", ")}; restore it from the backup made with this database`,
    );
  }
  return state;
}
