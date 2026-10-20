import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
