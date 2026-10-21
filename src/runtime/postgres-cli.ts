import { enclosingCheckout } from "./checkout.js";
import { issueHostedLoginLink } from "./hosted-node.js";
import { HostedConfigurationError } from "./hosted-service.js";
import {
  type OperatorBackend,
  operatorUsage,
  runOperatorCli,
} from "./operator-cli.js";
import {
  openPostgresSession,
  postgresInstallation,
} from "./postgres-environment.js";
import { StateError } from "./state.js";

/** The PostgreSQL database and state of `node server.js <command>`. */
export function postgresBackend(
  processEnv: NodeJS.ProcessEnv = process.env,
  forbiddenDirectory = enclosingCheckout(import.meta.url),
): OperatorBackend {
  // Resolved at most once per process, and only by a command that needs it;
  // a command that may create the database (init) may create the state too.
  let resolved: ReturnType<typeof postgresInstallation> | undefined;
  const installation = (create: boolean) =>
    (resolved ??= postgresInstallation(processEnv, { create }));
  return {
    name: "postgres",
    title: "PostgreSQL target",
    invocation: "fonds",
    // The package and image launcher; PostgreSQL has no source-only CLI path.
    command: "fonds",
    description: `fonds serve runs the loopback HTTP/MCP API, --transport stdio serves MCP over stdio
to a trusted local client, and --hosted runs the hosted service at FONDS_PUBLIC_ORIGIN.
The database is FONDS_DATABASE_URL; without it, fonds uses SQLite. Secrets come only
from FONDS_STATE_DIR/fonds.env, the service's state, and a database bound to other
secrets is refused.`,
    globalOptions: {},
    forbiddenDirectory,
    async open(_globals, mode) {
      const { env, installation: current } = await installation(mode.create);
      return openPostgresSession(env, current, { initialize: mode.create });
    },
    unavailable: {
      "mcp-config":
        "mcp-config is not available on PostgreSQL: configure the server as described in docs/guides/storage-backends.md.",
      demo: "demo is not available on PostgreSQL: unset FONDS_DATABASE_URL to run fonds demo on SQLite.",
      backup:
        "backup is not available on PostgreSQL: back up with pg_dump plus the state directory's fonds.env (docs/database.md#state-directory-and-backup).",
    },
    async loginLink() {
      const { env, installation: current } = await installation(false);
      try {
        return await issueHostedLoginLink(env, current);
      } catch (error) {
        throw error instanceof HostedConfigurationError ||
          error instanceof StateError
          ? error
          : new HostedConfigurationError(
              "Could not issue a login link; start the hosted service once first.",
            );
      }
    },
    describeError: (error) =>
      error instanceof HostedConfigurationError ? error.message : undefined,
  };
}

export const postgresUsage = operatorUsage(postgresBackend({}, undefined));

/** `node server.js <command>`: the shared operator CLI on PostgreSQL. */
export function runPostgresCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  forbiddenDirectory = enclosingCheckout(import.meta.url),
): Promise<number> {
  return runOperatorCli(postgresBackend(env, forbiddenDirectory), args);
}
