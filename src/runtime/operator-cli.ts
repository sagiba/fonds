import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { z } from "zod";

import { deliverFromStore } from "../application/change-delivery.js";
import type { CollectionLock } from "../application/collection-lock.js";
import type { CredentialStore } from "../application/credential-store.js";
import type { EventSubscriptionStore } from "../application/events.js";
import type { InternalStore } from "../application/financial-store.js";
import {
  createApplication,
  inProcessInvoker,
  type OperationDefinition,
} from "../application/operations.js";
import { isActive } from "../application/refreshes.js";
import {
  createSyncDiagnosticReport,
  syncDiagnosticSchema,
} from "../application/sync-diagnostics.js";
import { FONDS_VERSION } from "../application/version.js";
import { CredentialInputError } from "../domain/credentials.js";
import { refreshFailureCodeSchema } from "../domain/model.js";
import { ProviderConfigurationError } from "../domain/source-adapter.js";
import { NewerSchemaError } from "../storage/migrations.js";
import { collectionControls } from "./collection-controls.js";
import type {
  CollectionDiscovery,
  CollectionTarget,
} from "./collection-routes.js";
import { collectionTargets } from "./collection-service.js";
import {
  connectCredentials,
  ConnectError,
  disconnectCredentials,
} from "./connect.js";
import {
  createCredentialVault,
  type CredentialsKey,
  CredentialVaultError,
} from "./credential-vault.js";
import { loadCredentials } from "./credentials.js";
import { jsonOutput } from "./json-output.js";
import {
  CommandInputError,
  operationForCommand,
  operationUsage,
  remoteInvoker,
  runOperationCli,
} from "./operation-cli.js";
import { runtimeProvider, supportedProviders } from "./providers.js";
import { runOperatorRefresh } from "./refresh-service.js";
import { StateError } from "./state.js";

/** Every entry point's exit codes. */
export const EXIT_CODES = {
  ok: 0,
  failed: 1,
  partial: 2,
  unavailable: 3,
} as const;

/**
 * The backend an environment selects: PostgreSQL when its connection URL is
 * configured, otherwise SQLite with --db or the default path.
 */
export function selectedBackend(env: NodeJS.ProcessEnv) {
  return /^postgres(?:ql)?:/i.test(env.FONDS_DATABASE_URL ?? "")
    ? "postgres"
    : "sqlite";
}

export type BackendName = ReturnType<typeof selectedBackend>;

type Globals = Readonly<Record<string, string | undefined>>;

/**
 * One backend's database with everything that runs on it: what each backend
 * opens for its CLI and its servers alike.
 */
export interface BackendSession {
  store: InternalStore & CollectionLock;
  credentials: CredentialStore;
  eventSubscriptions: EventSubscriptionStore;
  credentialsKey: CredentialsKey;
  close(): Promise<void>;
}

/** A session for the CLI, which may also recheck file safety afterwards. */
export interface OperatorSession extends BackendSession {
  /** Rechecks file safety after a command that handled credentials. */
  verify?(): void;
}

/** What a backend supplies; the commands, flags, output and exit codes are shared. */
export interface OperatorBackend {
  readonly name: BackendName;
  /** The usage title, such as "local SQLite CLI". */
  readonly title: string;
  /** How the operator invokes it, such as "node dist/cli.js". */
  readonly invocation: string;
  /** Where the database and state come from on this backend. */
  readonly description: string;
  /** Options every command accepts here, such as SQLite's --db. */
  readonly globalOptions: Readonly<Record<string, { type: "string" }>>;
  /** Credential files are refused inside it (the checkout). */
  readonly forbiddenDirectory: string | undefined;
  /**
   * `create` may create the database or its schema; `credentials` also
   * provisions the credential store and requires private storage.
   */
  open(
    globals: Globals,
    mode: { create: boolean; credentials: boolean },
  ): Promise<OperatorSession>;
  /** The one-line reason for each command this backend lacks. */
  readonly unavailable: Readonly<Partial<Record<OptionalCommand, string>>>;
  loginLink?(): Promise<string>;
  demo?(globals: Globals): Promise<string>;
  backup?(globals: Globals, out: string): Promise<object>;
  /** The fixed message of a backend-specific error, safe to print. */
  describeError?(error: unknown): string | undefined;
}

type OptionalCommand = "login-link" | "demo" | "backup";

type Values = Readonly<Record<string, string | boolean | undefined>>;

interface CommandContext {
  backend: OperatorBackend;
  values: Values;
  globals: Globals;
}

interface OperatorCommand {
  name: string;
  synopsis: string;
  description: string;
  options: Readonly<Record<string, { type: "string" | "boolean" }>>;
  run(context: CommandContext): Promise<number>;
}

/** The `refresh` result on every backend. */
export const collectionSummarySchema = z
  .object({
    type: z.literal("refresh_summary"),
    status: z.enum(["completed", "partial", "failed", "busy", "blocked"]),
    captures: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    observed: z.number().int().nonnegative(),
    unchangedTransactions: z.number().int().nonnegative(),
    unlisted: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    failureCodes: z.array(refreshFailureCodeSchema).optional(),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    requestedRange: z.object({ from: z.string(), to: z.string() }).optional(),
    diagnostics: z
      .object({
        entries: z.array(syncDiagnosticSchema).max(200),
        dropped: z.number().int().nonnegative(),
        truncated: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

function text(values: Values, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

function required(values: Values, name: string): string {
  const value = text(values, name);
  if (!value?.trim()) {
    throw new CommandInputError(`--${name} is required.`);
  }
  return value;
}

function optionalNonEmpty(values: Values, name: string) {
  return text(values, name) === undefined ? undefined : required(values, name);
}

function print(result: unknown) {
  process.stdout.write(jsonOutput(result));
}

/** A delivery is acknowledged only after stdout accepts its complete envelope. */
function writeDelivery(message: unknown): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        rejectWrite(error);
      } else {
        resolveWrite();
      }
    });
  });
}

async function withSession<T>(
  context: CommandContext,
  mode: { create: boolean; credentials: boolean },
  work: (session: OperatorSession) => Promise<T>,
): Promise<T> {
  const session = await context.backend.open(context.globals, mode);
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

/** Usage column for synopses: wider than every command name. */
const NAME_WIDTH = 12;
const SYNOPSIS_CONTINUATION = " ".repeat(2 + NAME_WIDTH);

const SCHEDULE_NOTE =
  "Scheduled refresh runs only when the service sets FONDS_REFRESH_SCHEDULE=daily (or hourly, or hours such as 9,13,18).\n";

function summaryStatus(statuses: readonly string[]) {
  if (statuses.every((status) => status === "completed")) {
    return "completed";
  }
  if (
    statuses.some(
      (status) => !["completed", "partial", "busy"].includes(status),
    )
  ) {
    return "failed";
  }
  return statuses.includes("busy") ? "busy" : "partial";
}

/**
 * One summary of an operator's refreshes: counts summed, and the status
 * completed only when every refresh completed. A connection whose refresh
 * another process holds reports busy; one that could not be discovered fails.
 */
function collectionSummary(
  results: Awaited<ReturnType<typeof runOperatorRefresh>>,
  undiscovered: number,
) {
  const finished = results.flatMap((result) =>
    result.reason === null && result.refresh && !isActive(result.refresh)
      ? [result.refresh]
      : [],
  );
  const statuses = [
    ...finished.map((refresh) => refresh.status),
    ...(finished.length < results.length ? ["busy"] : []),
    ...(undiscovered ? ["failed"] : []),
  ];
  const sum = (
    key:
      | "captures"
      | "unchanged"
      | "failures"
      | "created"
      | "updated"
      | "observed"
      | "unchangedTransactions"
      | "unlisted",
  ) => finished.reduce((total, refresh) => total + refresh.counts[key], 0);
  const failureCodes = [
    ...new Set(finished.flatMap((refresh) => refresh.failureCodes)),
  ].sort();
  return {
    status: summaryStatus(statuses),
    captures: sum("captures"),
    unchanged: sum("unchanged"),
    observed: sum("observed"),
    unchangedTransactions: sum("unchangedTransactions"),
    unlisted: sum("unlisted"),
    failures: sum("failures") + undiscovered,
    ...(failureCodes.length && { failureCodes }),
    created: sum("created"),
    updated: sum("updated"),
  };
}

/** Status to exit code: partial is distinct; busy and blocked are failures. */
function collectionExitCode(status: string) {
  return status === "completed"
    ? EXIT_CODES.ok
    : status === "partial"
      ? EXIT_CODES.partial
      : EXIT_CODES.failed;
}

const optionalCommand = (
  name: OptionalCommand,
  synopsis: string,
  description: string,
  run: (context: CommandContext) => Promise<number>,
): OperatorCommand => ({
  name,
  synopsis,
  description,
  options: name === "backup" ? { out: { type: "string" } } : {},
  run,
});

export const operatorCommands: readonly OperatorCommand[] = [
  {
    name: "init",
    synopsis: `--connection <id> --provider <${supportedProviders.join("|")}>`,
    description:
      "Create the database if needed and the connection; repeating it changes nothing.",
    options: { connection: { type: "string" }, provider: { type: "string" } },
    async run(context) {
      const id = required(context.values, "connection");
      const provider = required(context.values, "provider");
      runtimeProvider(provider);
      await withSession(
        context,
        { create: true, credentials: false },
        (session) => session.store.ensureConnection({ id, provider }),
      );
      print({ connectionId: id, provider });
      return EXIT_CODES.ok;
    },
  },
  {
    name: "connect",
    synopsis:
      "--connection <existing connection id> [--credentials-fd <number>]",
    description:
      "Store the connection's provider credentials encrypted in the database, from hidden terminal input or an open fd. The key is the state's FONDS_CREDENTIALS_KEY. Values are never printed.",
    options: {
      connection: { type: "string" },
      "credentials-fd": { type: "string" },
    },
    async run(context) {
      const connectionId = required(context.values, "connection");
      const { credentialFd } = collectionControls({
        "credentials-fd": text(context.values, "credentials-fd"),
      });
      const stored = await withSession(
        context,
        { create: false, credentials: true },
        async (session) => {
          const result = await connectCredentials({
            connectionId,
            connections: session.store,
            openVault: () =>
              createCredentialVault(
                session.credentials,
                session.credentialsKey,
              ),
            ...(credentialFd !== undefined && { credentialFd }),
            ...(context.backend.forbiddenDirectory && {
              forbiddenDirectory: context.backend.forbiddenDirectory,
            }),
          });
          session.verify?.();
          return result;
        },
      );
      // The schedule may live where this command cannot see it (Neon's env file).
      process.stderr.write(SCHEDULE_NOTE);
      print(stored);
      return EXIT_CODES.ok;
    },
  },
  {
    name: "disconnect",
    synopsis: "--connection <id>",
    description:
      "Remove the connection's stored provider credentials, so refreshes that start later skip it; one already running finishes. Credentials from FONDS_CONNECTION_CREDENTIALS are unaffected. Its transactions, annotations and events are kept; repeating it changes nothing.",
    options: { connection: { type: "string" } },
    async run(context) {
      const connectionId = required(context.values, "connection");
      const removed = await withSession(
        context,
        { create: false, credentials: true },
        (session) =>
          disconnectCredentials({
            connectionId,
            connections: session.store,
            credentials: session.credentials,
          }),
      );
      print(removed);
      return EXIT_CODES.ok;
    },
  },
  {
    name: "refresh",
    synopsis:
      "[--connection <id>] [--from YYYY-MM-DD --to YYYY-MM-DD] [--credentials-fd <number>]\n" +
      `${SYNOPSIS_CONTINUATION}[--history-mode monthly|search] [--search-window-months 1|3|6|12] [--call-budget 1-100] [--max-details 0-20] [--diagnostics] [--archive-days 1-30]`,
    description: [
      "Refresh from the provider now, under the same lease as the server's.",
      "Without --connection, every connection with stored credentials, in turn; the provider",
      "options and --credentials-fd need --connection. Credentials come from --credentials-fd,",
      "then the connection's stored credentials (see connect), then hidden terminal input.",
      "Without dates it rereads the provider's recent window; requested windows do not prove",
      "complete history. Prints counts only; each refresh (list-refreshes) records its own",
      "result. Another refresh of a connection in progress makes it busy.",
      "--diagnostics adds a bounded stage/count report without source values. --archive-days",
      "retains redacted raw response bodies temporarily for trusted local investigation.",
    ].join("\n            "),
    options: {
      connection: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      "credentials-fd": { type: "string" },
      "history-mode": { type: "string" },
      "search-window-months": { type: "string" },
      "call-budget": { type: "string" },
      "max-details": { type: "string" },
      diagnostics: { type: "boolean" },
      "archive-days": { type: "string" },
    },
    async run(context) {
      const { values } = context;
      const diagnostics = values.diagnostics
        ? createSyncDiagnosticReport()
        : undefined;
      const archiveDaysText = text(values, "archive-days");
      let debugArchiveDays: number | undefined;
      if (archiveDaysText !== undefined) {
        if (!/^(?:[1-9]|[12][0-9]|30)$/.test(archiveDaysText)) {
          throw new CommandInputError(
            "--archive-days must be an integer from 1 through 30.",
          );
        }
        debugArchiveDays = Number(archiveDaysText);
      }
      const connectionId = optionalNonEmpty(values, "connection");
      const { range, options, credentialFd } = collectionControls({
        from: text(values, "from"),
        to: text(values, "to"),
        "history-mode": text(values, "history-mode"),
        "search-window-months": text(values, "search-window-months"),
        "call-budget": text(values, "call-budget"),
        "max-details": text(values, "max-details"),
        "credentials-fd": text(values, "credentials-fd"),
      });
      if (
        connectionId === undefined &&
        (credentialFd !== undefined || Object.keys(options).length)
      ) {
        throw new CommandInputError(
          "--credentials-fd and the provider options need --connection.",
        );
      }
      const summary = await withSession(
        context,
        { create: false, credentials: true },
        async (session) => {
          // Every stored connection is discovered by the poller, which reports a
          // failed discovery as a failed run; a named one is resolved first,
          // so a missing connection or credentials is the command's error.
          let targets: () => Promise<CollectionDiscovery>;
          if (connectionId === undefined) {
            targets = collectionTargets({
              store: session.store,
              credentials: session.credentials,
              credentialsKey: () => session.credentialsKey,
              log: () => {},
            });
          } else {
            const target = await connectionTarget(
              context,
              session,
              connectionId,
              {
                options,
                credentialFd,
              },
            );
            targets = async () => ({ targets: [target], failures: 0 });
          }
          // Discovered once: connections that could not be discovered fail the run.
          const discovery = await targets();
          const results = await runOperatorRefresh({
            store: session.store,
            targets: async () => discovery,
            connectionId,
            range,
            ...(diagnostics && { log: diagnostics.log }),
            ...(debugArchiveDays !== undefined && { debugArchiveDays }),
          });
          session.verify?.();
          return collectionSummary(results, discovery.failures);
        },
      );
      print({
        type: "refresh_summary",
        ...summary,
        ...(range && { requestedRange: range }),
        ...(diagnostics && { diagnostics: diagnostics.report() }),
      });
      return collectionExitCode(summary.status);
    },
  },
  {
    name: "consume",
    synopsis: "--connection <id> --consumer <id> [--limit <count>]",
    description:
      "Deliver JSON lines to local stdout and advance the durable consumer cursor. Ends with a delivery_summary line; this sink sends no external notifications.",
    options: {
      connection: { type: "string" },
      consumer: { type: "string" },
      limit: { type: "string" },
    },
    async run(context) {
      const connectionId = required(context.values, "connection");
      const consumerId = required(context.values, "consumer");
      const limitText = text(context.values, "limit");
      let limit: number | undefined;
      if (limitText !== undefined) {
        if (!/^\d+$/.test(limitText) || Number(limitText) < 1) {
          throw new CommandInputError(
            "--limit must be a safe integer of at least 1.",
          );
        }
        limit = Number(limitText);
        if (limit > 1000) {
          throw new CommandInputError("--limit must not exceed 1000.");
        }
      }
      const delivery = await withSession(
        context,
        { create: false, credentials: false },
        async (session) => {
          if (!(await session.store.getConnection(connectionId))) {
            throw new CommandInputError("Connection not found.");
          }
          return deliverFromStore(
            session.store,
            { connectionId, consumerId, ...(limit !== undefined && { limit }) },
            writeDelivery,
          );
        },
      );
      // consume is a JSON-lines stream, so its summary stays one compact line.
      process.stdout.write(
        `${JSON.stringify({ type: "delivery_summary", ...delivery })}\n`,
      );
      return EXIT_CODES.ok;
    },
  },
  {
    name: "ingest",
    synopsis:
      "--connection <id> --account <key> --run <id> --file <JSON file>\n" +
      `${SYNOPSIS_CONTINUATION}[--captured-at <ISO timestamp>] [--endpoint <name>]`,
    description:
      "Archive and apply one captured provider response offline. Retry with the same run ID, source file, endpoint and capture time.",
    options: {
      connection: { type: "string" },
      account: { type: "string" },
      run: { type: "string" },
      file: { type: "string" },
      "captured-at": { type: "string" },
      endpoint: { type: "string" },
    },
    async run(context) {
      const { values } = context;
      const connectionId = required(values, "connection");
      const accountKey = required(values, "account");
      const runId = required(values, "run");
      const capturedAt =
        text(values, "captured-at") ?? new Date().toISOString();
      if (!z.iso.datetime({ offset: true }).safeParse(capturedAt).success) {
        throw new CommandInputError(
          "--captured-at must be an ISO timestamp with a timezone.",
        );
      }
      const endpoint = optionalNonEmpty(values, "endpoint");
      let responseText: string;
      try {
        responseText = await readFile(required(values, "file"), "utf8");
      } catch (error) {
        if (error instanceof CommandInputError) {
          throw error;
        }
        throw new CommandInputError("Could not read the response file.");
      }
      const result = await withSession(
        context,
        { create: true, credentials: false },
        async (session) => {
          const connection = await session.store.getConnection(connectionId);
          if (!connection) {
            throw new CommandInputError(
              "Connection not found; initialize it first.",
            );
          }
          const provider = runtimeProvider(connection.provider);
          const captureContext = provider.prepareCapture(
            responseText,
            accountKey,
          );
          return session.store.ingestRun(
            {
              runId,
              connectionId,
              responses: [
                {
                  accountKey,
                  ...captureContext,
                  endpoint: endpoint ?? captureContext.endpoint,
                  capturedAt,
                  responseText,
                },
              ],
            },
            provider.adapter,
          );
        },
      );
      print(result);
      return EXIT_CODES.ok;
    },
  },
  optionalCommand(
    "backup",
    "--out <path outside this repository>",
    "Write a coherent copy of the database as a new private file. Back up the state directory with it.",
    async ({ backend, globals, values }) => {
      print(await backend.backup!(globals, required(values, "out")));
      return EXIT_CODES.ok;
    },
  ),
  optionalCommand(
    "login-link",
    "",
    "Print a one-time owner sign-in link (10 minutes, single use) for the hosted service; open it, then add a passkey on the account page.",
    async ({ backend }) => {
      process.stdout.write(`${await backend.loginLink!()}\n`);
      return EXIT_CODES.ok;
    },
  ),
  optionalCommand(
    "demo",
    "",
    "Create or refresh a separate ledger of synthetic CAL data and print what to run next. Repeating it changes nothing.",
    async ({ backend, globals }) => {
      process.stdout.write(await backend.demo!(globals));
      return EXIT_CODES.ok;
    },
  ),
];

/** One named connection, with explicit, stored or prompted credentials. */
async function connectionTarget(
  context: CommandContext,
  session: OperatorSession,
  connectionId: string,
  input: {
    options: ReturnType<typeof collectionControls>["options"];
    credentialFd: number | undefined;
  },
): Promise<CollectionTarget> {
  const connection = await session.store.getConnection(connectionId);
  if (!connection) {
    throw new ConnectError("Connection not found; initialize it first.");
  }
  const provider = runtimeProvider(connection.provider);
  provider.validateCollectionOptions(input.options);
  let credentials;
  if (
    input.credentialFd === undefined &&
    (await session.credentials.getCredentials(connection.id))
  ) {
    credentials = await createCredentialVault(
      session.credentials,
      session.credentialsKey,
    ).load(connection);
  }
  credentials ??= await loadCredentials({
    ...(input.credentialFd !== undefined && { fd: input.credentialFd }),
    ...(context.backend.forbiddenDirectory && {
      forbiddenDirectory: context.backend.forbiddenDirectory,
    }),
    input: provider.credentials,
  });
  const loaded = credentials;
  return {
    connectionId: connection.id,
    adapter: provider.adapter,
    collector: async () => provider.createCollector(loaded, input.options),
  };
}

const commandsByName = new Map(
  operatorCommands.map((command) => [command.name, command]),
);

function commandUsage(command: OperatorCommand) {
  return `  ${command.name.padEnd(NAME_WIDTH)}${command.synopsis}`.trimEnd();
}

/** Top-level usage: the same commands on every backend. */
export function operatorUsage(backend: OperatorBackend): string {
  return `Fonds — ${backend.title}
Usage: ${backend.invocation} <command> [options]
       ${backend.invocation} <operation command> --remote <url> --token-file <private file> [options]
       ${backend.invocation} --version

${backend.description}

Operation commands run the same operations as the HTTP API and MCP tools, with the same
input fields as kebab-case flags and the same JSON output. Booleans take true or false,
integers are decimal, and object or list fields take JSON. --remote calls a Fonds
deployment's /v1 API (https, or http on this machine) with a bearer from --token-file,
which --remote requires; it never comes from the environment or the local state.
Aliases: list, get, totals, events, annotate, link, remove.
${operationUsage()}

Operator commands run on this backend's database only:
${operatorCommands.map(commandUsage).join("\n")}

Use <command> --help for one command's description and flags. Supported providers:
${supportedProviders.join(", ")}; see docs/providers/ for credential fields, history
controls, request budgets and limits.
Exit codes: 0 success, 1 failure or busy, 2 partial refresh, 3 not available on
this backend.
`;
}

function commandHelp(command: OperatorCommand) {
  return `${commandUsage(command).trimStart()}\n${command.description}\n`;
}

/** The commands and their flags, as the parity test compares them. */
export function operatorCommandFlags(): Record<string, string[]> {
  return Object.fromEntries(
    operatorCommands.map((command) => [
      command.name,
      Object.keys(command.options).sort(),
    ]),
  );
}

/** Upstream parser and driver errors can hold source data or connection strings. */
function errorMessage(error: unknown, backend: OperatorBackend) {
  if (
    error instanceof CommandInputError ||
    error instanceof ProviderConfigurationError ||
    error instanceof CredentialInputError ||
    error instanceof CredentialVaultError ||
    error instanceof ConnectError ||
    error instanceof StateError ||
    // Names only migration numbers, so the operator knows to upgrade.
    error instanceof NewerSchemaError
  ) {
    return error.message;
  }
  return (
    backend.describeError?.(error) ??
    "Command failed; check the database configuration and input."
  );
}

function parseValues(
  args: string[],
  options: Readonly<Record<string, { type: "string" | "boolean" }>>,
  command: string,
): Values {
  try {
    return parseArgs({ args, strict: true, allowPositionals: false, options })
      .values;
  } catch {
    throw new CommandInputError(
      `Invalid arguments. Use ${command} --help for its flags.`,
    );
  }
}

function globalsOf(backend: OperatorBackend, values: Values): Globals {
  return Object.fromEntries(
    Object.keys(backend.globalOptions).map((name) => {
      const value = text(values, name);
      if (value !== undefined && !value.trim()) {
        throw new CommandInputError(`--${name} is required.`);
      }
      return [name, value];
    }),
  );
}

/** One operation, embedded on the backend's database or through --remote. */
function runOperation(
  backend: OperatorBackend,
  definition: OperationDefinition,
  args: string[],
) {
  return runOperationCli({
    definition,
    args,
    globalOptions: {
      ...backend.globalOptions,
      remote: { type: "string" },
      "token-file": { type: "string" },
    },
    async connect(values) {
      const remote = text(values, "remote");
      if (remote !== undefined) {
        const localOption = Object.keys(backend.globalOptions).find(
          (name) => values[name] !== undefined,
        );
        if (localOption !== undefined) {
          throw new CommandInputError(
            `--${localOption} does not apply with --remote.`,
          );
        }
        return {
          invoker: remoteInvoker({
            remote,
            tokenFile: text(values, "token-file"),
          }),
        };
      }
      if (values["token-file"] !== undefined) {
        throw new CommandInputError("--token-file requires --remote.");
      }
      const session = await backend.open(globalsOf(backend, values), {
        create: false,
        credentials: false,
      });
      return {
        invoker: inProcessInvoker(createApplication(session.store)),
        close: () => session.close(),
      };
    },
  });
}

/**
 * `<command> [options]` on one backend: an operation command or an operator
 * command, each with the same flags, output and exit codes everywhere.
 */
export async function runOperatorCli(
  backend: OperatorBackend,
  argv: string[],
): Promise<number> {
  const [name, ...args] = argv;
  if (name === "--help" || name === "help") {
    process.stdout.write(operatorUsage(backend));
    return EXIT_CODES.ok;
  }
  if (name === "--version") {
    process.stdout.write(`${FONDS_VERSION}\n`);
    return EXIT_CODES.ok;
  }
  const definition = name ? operationForCommand(name) : undefined;
  if (definition) {
    return runOperation(backend, definition, args);
  }
  const command = name ? commandsByName.get(name) : undefined;
  try {
    if (!command) {
      throw new CommandInputError(
        name && !name.startsWith("-")
          ? "Unknown command. Use --help for usage."
          : "Specify one command. Use --help for usage.",
      );
    }
    if (args.some((value) => /^--remote(=|$)/.test(value))) {
      throw new CommandInputError(
        "Operator commands use a local database only; --remote runs operation commands.",
      );
    }
    const values = parseValues(
      args,
      {
        ...command.options,
        ...backend.globalOptions,
        help: { type: "boolean" },
      },
      command.name,
    );
    if (values.help) {
      process.stdout.write(commandHelp(command));
      return EXIT_CODES.ok;
    }
    const reason = backend.unavailable[command.name as OptionalCommand];
    if (reason) {
      process.stderr.write(`${reason}\n`);
      return EXIT_CODES.unavailable;
    }
    return await command.run({
      backend,
      values,
      globals: globalsOf(backend, values),
    });
  } catch (error) {
    process.stderr.write(`${errorMessage(error, backend)}\n`);
    return EXIT_CODES.failed;
  }
}
