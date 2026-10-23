import { existsSync, lstatSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { serve, type ServerType } from "@hono/node-server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { protectedDirectory } from "./runtime/checkout.js";
import { CollectionScheduleError } from "./runtime/collection-schedule.js";
import {
  createLocalService,
  localSchedule,
  type LocalServiceOptions,
  stderrLog,
} from "./runtime/collection-service.js";
import { CredentialVaultError } from "./runtime/credential-vault.js";
import { dataHome, DEFAULT_DATABASE } from "./runtime/data-home.js";
import { resolveInstallation } from "./runtime/installation.js";
import {
  localStateDirectory,
  openSqliteSession,
} from "./runtime/local-ledger.js";
import { CommandInputError } from "./runtime/operation-cli.js";
import { STATE_FILE, StateError } from "./runtime/state.js";
import { createHttpService } from "./transport/http.js";
import { createMcpServer } from "./transport/mcp.js";

const repositoryRoot = protectedDirectory(import.meta.url);
const usage = `Fonds — local SQLite HTTP/MCP
Usage: fonds serve [--db <existing private SQLite file outside the repository>]
       [--transport http|stdio] [--port 8787]

Without --db, the server uses ${DEFAULT_DATABASE} in the private data directory ($FONDS_HOME,
otherwise the platform's per-user data directory); create it first with the CLI's init or demo.

HTTP binds only 127.0.0.1. API and /mcp require the bearer token FONDS_API_TOKEN from
${STATE_FILE} in the state directory (FONDS_STATE_DIR, otherwise the data directory),
generated once with mode 0600. Token values are never printed.
Stdio is for a trusted local MCP host and needs no HTTP token; stdout is protocol-only.
refresh_connection starts a refresh of a connection whose credentials the CLI's connect
stored, with the state's FONDS_CREDENTIALS_KEY; it shares the CLI refresh lease and
continues in the server after the response. Reads never refresh. HTTP also serves MCP
Events webhooks, delivered after each refresh and every minute. FONDS_REFRESH_SCHEDULE
(daily, hourly or hours such as
9,13,18; off by default), FONDS_REFRESH_TIME (HH:MM; otherwise a random time kept in
the database) and FONDS_REFRESH_TIMEZONE schedule refreshes. Operational events are
count-only JSON lines on stderr.
`;

/** No group or other permission bits, and owned by the current user where the platform has user IDs. */
function isOwnerOnly(stat: Stats): boolean {
  return (
    (stat.mode & 0o077) === 0 &&
    (!process.getuid || stat.uid === process.getuid())
  );
}

/** Resolve parent symlinks; runtime files must stay out of source control. */
function runtimePath(value: string) {
  const path = resolve(value);
  const parent = realpathSync(dirname(path));
  const actual = resolve(parent, relative(dirname(path), path));
  const fromRepository = relative(repositoryRoot, actual);
  const insideRepository =
    fromRepository === "" ||
    (!isAbsolute(fromRepository) &&
      fromRepository !== ".." &&
      !fromRepository.startsWith(`..${sep}`));
  if (insideRepository) {
    throw new Error("Runtime path in repository");
  }
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || !isOwnerOnly(stat)) {
    throw new Error("Private directory required");
  }
  return actual;
}

function validateFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || !isOwnerOnly(stat)) {
    throw new Error("Private file required");
  }
}

/** Bounds a stalled body: open connections are cut after this on close. */
const FORCE_CLOSE_MS = 5_000;

/** End subscription streams before awaiting HTTP drain. */
async function closeHttpServer(
  server: ServerType,
  service: ReturnType<typeof createHttpService>,
): Promise<void> {
  const drained = new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  const forceClose = setTimeout(() => {
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
    }
  }, FORCE_CLOSE_MS);
  forceClose.unref();
  try {
    await service.stop();
    if ("closeIdleConnections" in server) {
      server.closeIdleConnections();
    }
    await drained;
  } finally {
    clearTimeout(forceClose);
    await service.close();
  }
}

/** Test seams for the collection composition; production passes none. */
export type ServerSeams = Partial<
  Pick<LocalServiceOptions, "providerFor" | "webhooks" | "log" | "scheduler">
> & {
  /** Variables over the process environment, such as a schedule. */
  env?: NodeJS.ProcessEnv;
};

export async function startServer(args: string[], seams: ServerSeams = {}) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      db: { type: "string" },
      transport: { type: "string", default: "http" },
      port: { type: "string", default: "8787" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(usage);
    return undefined;
  }
  if (
    positionals.length ||
    values.db === "" ||
    !["http", "stdio"].includes(values.transport)
  ) {
    throw new Error("Invalid arguments");
  }
  if (!/^[0-9]+$/.test(values.port) || Number(values.port) > 65535) {
    throw new Error("Invalid port");
  }
  if (
    values.transport === "stdio" &&
    args.some((value) => value === "--port" || value.startsWith("--port="))
  ) {
    throw new Error("HTTP options on stdio");
  }
  // The server only opens an existing ledger, so it never creates the directory.
  const defaultPath = join(dataHome(), DEFAULT_DATABASE);
  if (values.db === undefined && !existsSync(defaultPath)) {
    throw new CommandInputError(
      `No Fonds database at ${defaultPath}; create it with the CLI's init, or pass --db.`,
    );
  }
  const databasePath = runtimePath(values.db ?? defaultPath);
  validateFile(databasePath);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      validateFile(databasePath + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  const env = { ...process.env, ...seams.env };
  const stateDirectory = localStateDirectory(env, repositoryRoot);
  const installation = await resolveInstallation(stateDirectory, {
    create: true,
  });
  const token = installation.secrets.FONDS_API_TOKEN;
  if (
    values.transport === "http" &&
    !/^[A-Za-z0-9_-]{32,256}$/.test(token ?? "")
  ) {
    throw new CommandInputError(
      `The state file's FONDS_API_TOKEN must be 32 to 256 base64url characters: ${join(stateDirectory, STATE_FILE)}`,
    );
  }
  const session = await openSqliteSession(databasePath, installation);
  let schedule: LocalServiceOptions["schedule"];
  try {
    schedule = await localSchedule(session.store, env);
  } catch (error) {
    await session.close();
    throw error instanceof CollectionScheduleError
      ? new CommandInputError(error.message)
      : error;
  }
  const { env: _env, ...serviceSeams } = seams;
  // Ends refreshes in progress on close; they stay active and resume on restart.
  const collections = new AbortController();
  const { application, events, scheduler } = createLocalService(
    { ...session, credentialsKey: () => session.credentialsKey },
    { log: stderrLog, ...serviceSeams, schedule, signal: collections.signal },
  );
  let closed = false;
  let closeTransport: () => Promise<void>;
  let url: string | undefined;
  try {
    if (values.transport === "stdio") {
      const server = serveStdio(() => createMcpServer(application), {
        onerror: () => process.stderr.write("MCP transport error.\n"),
      });
      closeTransport = () => server.close();
    } else {
      const service = createHttpService(application, {
        token: token!,
        events,
      });
      const server = serve({
        fetch: service.app.fetch,
        hostname: "127.0.0.1",
        port: Number(values.port),
      });
      await new Promise<void>((resolveStart, reject) => {
        server.once("listening", resolveStart);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing server address");
      }
      url = `http://127.0.0.1:${address.port}`;
      process.stderr.write(
        `Fonds listening at ${url}; MCP at /mcp.\nToken: FONDS_API_TOKEN in ${join(stateDirectory, STATE_FILE)}\n`,
      );
      closeTransport = () => closeHttpServer(server, service);
    }
  } catch (error) {
    await session.close();
    throw error;
  }
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    process.stdin.off("end", shutdown);
    // No new scheduled run starts; a running refresh stops and resumes later.
    scheduler.stop();
    collections.abort();
    try {
      await closeTransport();
    } finally {
      try {
        // A scheduled run records its outcome before the database closes.
        await scheduler.settled();
      } finally {
        await session.close();
      }
    }
  };
  const shutdown = () => {
    void close().catch(() => {
      process.stderr.write("Server shutdown failed.\n");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // Ticks deliver due Events and, with a schedule, collect.
  scheduler.start();
  if (values.transport === "stdio") {
    process.stdin.once("end", shutdown);
  }
  return { close, url };
}

/** Starts the server; a failure prints only a fixed message and sets the exit code. */
export async function main(args: string[]): Promise<void> {
  try {
    await startServer(args);
  } catch (error) {
    // These errors carry fixed messages that are safe to print.
    const printable =
      error instanceof CommandInputError ||
      error instanceof StateError ||
      error instanceof CredentialVaultError;
    process.stderr.write(
      printable
        ? `${error.message}\n`
        : "Could not start service. Check arguments, the private database and state directory outside the repository, and port availability. Use --help for usage.\n",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main(process.argv.slice(2));
}
