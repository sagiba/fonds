import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  createLocalService,
  localSchedule,
  stdoutLog,
} from "../runtime/collection-service.js";
import { runHostedNodeService } from "../runtime/hosted-node.js";
import { runNodeService } from "../runtime/node-service.js";
import type { BackendSession } from "../runtime/operator-cli.js";
import { runPostgresCommand } from "../runtime/postgres-cli.js";
import {
  openPostgresSession,
  postgresInstallation,
} from "../runtime/postgres-environment.js";
import { runPostgresStdio } from "../runtime/postgres-stdio.js";
import { StateError } from "../runtime/state.js";

export { startNodeService } from "../runtime/node-service.js";
export { runPostgresCommand } from "../runtime/postgres-cli.js";
export {
  initializePostgresDatabase,
  openPostgresDatabase,
} from "../storage/postgres/store.js";

/**
 * Serving takes no arguments or only `--transport http|stdio`; anything else
 * is a command (including `--help`, which the operator CLI prints).
 */
function serverTransport(args: string[]): "http" | "stdio" | undefined {
  if (args.length === 0) {
    return "http";
  }
  const inline = "--transport=";
  const [flag, value, ...rest] =
    args.length === 1 && args[0]!.startsWith(inline)
      ? ["--transport", args[0]!.slice(inline.length)]
      : args;
  if (flag !== "--transport" || rest.length !== 0) {
    return undefined;
  }
  return value === "http" || value === "stdio" ? value : undefined;
}

/** The loopback bearer launcher, on the same state directory as the CLI. */
async function runLoopbackService(processEnv: NodeJS.ProcessEnv) {
  let resolved: Awaited<ReturnType<typeof postgresInstallation>>;
  try {
    resolved = await postgresInstallation(processEnv, { create: true });
  } catch (error) {
    process.stderr.write(
      error instanceof StateError
        ? `${error.message}\n`
        : "Could not read FONDS_STATE_DIR.\n",
    );
    process.exitCode = 1;
    return;
  }
  const { env, installation } = resolved;
  let session: BackendSession | undefined;
  await runNodeService(
    async () => {
      session = await openPostgresSession(env, installation, {
        initialize: true,
      });
      return { ...session.store, close: session.close };
    },
    async (store, signal) =>
      createLocalService(
        {
          ...session!,
          // Refresh uses credentials stored by `connect`, decrypted with this key.
          credentialsKey: () => installation.credentialsKey,
        },
        { log: stdoutLog, schedule: await localSchedule(store, env), signal },
      ),
    env,
  );
}

const serveUsage = `Usage: fonds serve [--port 8787] [--transport stdio]
       fonds serve --hosted [--port 8787]

With FONDS_DATABASE_URL (postgresql://…) and FONDS_STATE_DIR. Without --hosted, HTTP
binds only 127.0.0.1 and requires the bearer token FONDS_API_TOKEN from the state, and
stdio serves a trusted local MCP host. --hosted runs the hosted service at
FONDS_PUBLIC_ORIGIN for remote clients: OAuth, Events and scheduled collection.
`;

/** Fixed messages for `fonds serve` arguments the PostgreSQL backend rejects. */
function serveConflict(
  values: { hosted?: boolean; transport?: string },
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (values.transport !== undefined && values.transport !== "stdio") {
    return "The transport is stdio, or omitted for HTTP.";
  }
  if (values.hosted && values.transport) {
    return "--hosted serves HTTP; stdio is always local.";
  }
  if (values.hosted && !env.FONDS_PUBLIC_ORIGIN) {
    return "--hosted needs FONDS_PUBLIC_ORIGIN, the service's public origin.";
  }
  // An origin without --hosted is ambiguous: refuse rather than guess the mode.
  if (!values.hosted && !values.transport && env.FONDS_PUBLIC_ORIGIN) {
    return "FONDS_PUBLIC_ORIGIN is set: use fonds serve --hosted for the hosted service, or unset it for loopback HTTP.";
  }
  return undefined;
}

/**
 * The `fonds` command on PostgreSQL: `serve` starts a service, with the
 * hosted one only when asked for explicitly; anything else is a command.
 */
export async function main(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (args[0] !== "serve") {
    process.exitCode = await runPostgresCommand(args, env);
    return;
  }
  let values: {
    hosted?: boolean;
    transport?: string;
    port?: string;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: args.slice(1),
      strict: true,
      allowPositionals: false,
      options: {
        hosted: { type: "boolean" },
        transport: { type: "string" },
        port: { type: "string" },
        help: { type: "boolean" },
      },
    }));
  } catch {
    process.stderr.write("Invalid arguments. Use fonds serve --help.\n");
    process.exitCode = 1;
    return;
  }
  if (values.help) {
    process.stdout.write(serveUsage);
    return;
  }
  // The same flag as the SQLite server; the services read PORT.
  const serveEnv =
    values.port === undefined ? env : { ...env, PORT: values.port };
  const conflict = serveConflict(values, env);
  if (conflict) {
    process.stderr.write(`${conflict}\n`);
    process.exitCode = 1;
  } else if (values.transport === "stdio") {
    await runPostgresStdio(env);
  } else if (values.hosted) {
    await runHostedNodeService(serveEnv);
  } else {
    await runLoopbackService(serveEnv);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  const args = process.argv.slice(2);
  const transport = serverTransport(args);
  if (transport === undefined) {
    process.exitCode = await runPostgresCommand(args);
  } else if (transport === "stdio") {
    await runPostgresStdio(process.env);
  } else if (process.env.FONDS_PUBLIC_ORIGIN) {
    // A public origin selects the hosted service: OAuth, Events and collection.
    await runHostedNodeService(process.env);
  } else {
    await runLoopbackService(process.env);
  }
}
