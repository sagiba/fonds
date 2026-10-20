import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createApplication } from "../application/operations.js";
import { createMcpServer } from "../transport/mcp.js";
import { createCollectionService, stderrLog } from "./collection-service.js";
import { HostedConfigurationError } from "./hosted-service.js";
import { CommandInputError } from "./operation-cli.js";
import {
  openPostgresSession,
  postgresInstallation,
} from "./postgres-environment.js";
import { ownerRefreshes } from "./refresh-service.js";
import { StateError } from "./state.js";

/**
 * MCP over stdio on PostgreSQL for a trusted local client: the operations and
 * refresh of connections with stored credentials. Events and scheduling stay
 * with the HTTP service, whose clients own the subscriptions; stdout carries
 * only the protocol.
 */
export async function startPostgresStdio(processEnv: NodeJS.ProcessEnv) {
  const { env, installation } = await postgresInstallation(processEnv, {
    create: true,
  });
  const session = await openPostgresSession(env, installation, {
    initialize: true,
  });
  // Ends refreshes in progress on close; they stay active and resume later.
  const collections = new AbortController();
  const refreshes = createCollectionService({
    store: session.store,
    credentials: session.credentials,
    credentialsKey: () => session.credentialsKey,
    signal: collections.signal,
    log: stderrLog,
  });
  const application = createApplication(session.store, {
    refreshes: ownerRefreshes(refreshes),
  });
  const server = serveStdio(() => createMcpServer(application), {
    onerror: () => process.stderr.write("MCP transport error.\n"),
  });
  let closing: Promise<void> | undefined;
  return {
    close: () => {
      closing ??= (async () => {
        collections.abort();
        try {
          await server.close();
          await refreshes.settled();
        } finally {
          await session.close();
        }
      })();
      return closing;
    },
  };
}

/** Process entry: fixed, secret-free diagnostics; ends with its input. */
export async function runPostgresStdio(env: NodeJS.ProcessEnv) {
  try {
    const running = await startPostgresStdio(env);
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      process.stdin.off("end", shutdown);
      void running.close().catch(() => {
        process.stderr.write("Server shutdown failed.\n");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.stdin.once("end", shutdown);
  } catch (error) {
    process.stderr.write(
      error instanceof CommandInputError ||
        error instanceof StateError ||
        error instanceof HostedConfigurationError
        ? `${error.message}\n`
        : "Could not start the stdio server. Check the database and state directory.\n",
    );
    process.exitCode = 1;
  }
}
