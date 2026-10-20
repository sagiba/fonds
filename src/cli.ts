import { existsSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { outsideDirectory, protectedDirectory } from "./runtime/checkout.js";
import {
  DEFAULT_DATABASE,
  defaultDatabasePath,
  DEMO_DATABASE,
} from "./runtime/data-home.js";
import { demoSummary, loadDemo } from "./runtime/demo.js";
import {
  type Installation,
  resolveInstallation,
} from "./runtime/installation.js";
import {
  localStateDirectory,
  openLocalLedger,
  openSqliteSession,
} from "./runtime/local-ledger.js";
import { CommandInputError } from "./runtime/operation-cli.js";
import {
  type OperatorBackend,
  runOperatorCli,
  selectedBackend,
} from "./runtime/operator-cli.js";
import { STATE_FILE } from "./runtime/state.js";

const repositoryRoot = protectedDirectory(import.meta.url);

/** Fixed command-line messages; safe to print as they are. */
class CliError extends CommandInputError {}

/**
 * Resolve existing parents too, so a symlink cannot direct runtime data into Git.
 * The file itself must not be a symlink, even a dangling one.
 */
function runtimePath(optionValue: string): string {
  const path = resolve(optionValue);
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new CliError("Database and backup paths must not be symlinks.");
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
  }
  const actual = outsideDirectory(repositoryRoot, path);
  if (!actual) {
    throw new CliError(
      "Database and backup files must be outside the repository.",
    );
  }
  return actual;
}

function requireExistingDatabase(path: string): void {
  if (path !== ":memory:" && !existsSync(path)) {
    throw new CliError(
      `No Fonds database at ${path}; create it with init, or try demo.`,
    );
  }
}

/** Never change permissions on existing files supplied by the user. */
function validatePrivateDatabase(path: string): void {
  if (path === ":memory:") {
    throw new CliError(
      "Live collection requires a persistent database outside the repository.",
    );
  }
  const isPrivate = (target: string, directory: boolean): boolean => {
    const stat = lstatSync(target);
    return (
      !stat.isSymbolicLink() &&
      (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) &&
      (stat.mode & 0o077) === 0 &&
      (!process.getuid || stat.uid === process.getuid())
    );
  };
  try {
    if (!isPrivate(dirname(path), true)) {
      throw new Error();
    }
    for (const file of [
      path,
      `${path}-wal`,
      `${path}-shm`,
      `${path}-journal`,
    ]) {
      // lstat rather than exists follows dangling symlinks safely.
      try {
        lstatSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (!isPrivate(file, false)) {
        throw new Error();
      }
    }
  } catch {
    throw new CliError(
      "Live collection requires a private current-owner directory (0700) and regular database files (0600) without links.",
    );
  }
}

/** The SQLite ledger and state: --db or the data directory's default ledger. */
export function sqliteBackend(
  env: NodeJS.ProcessEnv = process.env,
): OperatorBackend {
  const stateDirectory = () => localStateDirectory(env, repositoryRoot);
  const databasePath = (db: string | undefined, name = DEFAULT_DATABASE) => {
    if (db === ":memory:") {
      return db;
    }
    return db === undefined
      ? defaultDatabasePath(name, runtimePath)
      : runtimePath(db);
  };
  // Resolved at most once per process, and only by a command that needs it;
  // a command that may create the database (init, ingest, demo) may create the
  // state too.
  let resolved: Promise<Installation> | undefined;
  const installation = (create: boolean) =>
    (resolved ??= resolveInstallation(stateDirectory(), { create }));
  return {
    name: "sqlite",
    title: "local SQLite CLI",
    invocation: "node dist/cli.js",
    description: `Run as node dist/cli.js from a checkout, or fonds in the Docker image. Every command takes
[--db <path outside this repository>]; without it, commands use ${DEFAULT_DATABASE} in the
private data directory: $FONDS_HOME, otherwise the platform's per-user data directory
(~/.local/share/fonds on Linux, ~/Library/Application Support/Fonds on macOS), created
0700 on first use. The state directory, FONDS_STATE_DIR or else the data directory,
holds ${STATE_FILE}, the installation's secrets, generated once. A database is bound to
the state it was created with and refused with any other; back up the database and the
state directory together (docs/database.md#state-directory-and-backup). With
FONDS_DATABASE_URL set to a PostgreSQL URL, use the PostgreSQL target's node server.js.`,
    globalOptions: { db: { type: "string" } },
    forbiddenDirectory: repositoryRoot,
    async open(globals, mode) {
      const path = databasePath(globals.db);
      if (mode.credentials) {
        validatePrivateDatabase(path);
      }
      if (!mode.create) {
        requireExistingDatabase(path);
      }
      return {
        ...(await openSqliteSession(path, await installation(mode.create))),
        // Journal files a collection created must be as private as the ledger.
        verify: () => validatePrivateDatabase(path),
      };
    },
    unavailable: {
      "login-link":
        "login-link is not available on SQLite: owner sign-in belongs to the hosted service on PostgreSQL.",
    },
    async demo(globals) {
      const path = databasePath(globals.db, DEMO_DATABASE);
      const database = await openLocalLedger(path, await installation(true));
      try {
        await loadDemo(database);
        return await demoSummary(database, path, import.meta.url);
      } finally {
        await database.close();
      }
    },
    async backup(globals, out) {
      const path = databasePath(globals.db);
      const backupPath = runtimePath(out);
      if (backupPath === path) {
        throw new CliError("Backup destination must differ from the database.");
      }
      requireExistingDatabase(path);
      const current = await installation(false);
      const database = await openLocalLedger(path, current);
      try {
        await database.backup(backupPath);
      } finally {
        await database.close();
      }
      // The secrets stay out of the copy; the state directory holds them.
      return { backupPath, stateDirectory: current.stateDirectory };
    },
  };
}

/** Return an exit code so callers can close resources. */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const asksForHelp =
    ["--help", "help", "--version"].includes(argv[0] ?? "") ||
    argv.includes("--help");
  if (selectedBackend(env) === "postgres" && !asksForHelp) {
    process.stderr.write(
      "FONDS_DATABASE_URL selects PostgreSQL: run this command with the PostgreSQL target's node server.js, or unset it to use SQLite.\n",
    );
    return 1;
  }
  return runOperatorCli(sqliteBackend(env), argv);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
