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
import { commandLine } from "./cli-invocation.js";
import {
  present,
  type Presentation,
  presentation,
  wrap,
} from "./cli-output.js";
import {
  backupView,
  connectView,
  disconnectView,
  ingestView,
  initView,
  operationViews,
  refreshView,
  type View,
} from "./cli-views.js";
import { collectionControls } from "./collection-controls.js";
import type {
  CollectionDiscovery,
  CollectionTarget,
} from "./collection-routes.js";
import { collectionTargets } from "./collection-service.js";
import {
  addConnection,
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
import { MCP_CLIENTS, MCP_SERVER_NAME, type McpClient } from "./mcp-setup.js";
import {
  aliasNames,
  aliasSummary,
  CommandInputError,
  globalHelp,
  JSON_HELP,
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
  /** Where the ledger is, when printing it reveals no secret (a file path). */
  location?: string;
}

/** What a backend supplies; the commands, flags, output and exit codes are shared. */
export interface OperatorBackend {
  readonly name: BackendName;
  /** The usage title, such as "local SQLite CLI". */
  readonly title: string;
  /** How help names the command, such as "fonds". */
  readonly invocation: string;
  /** How this process is rerun, for runnable next steps in its output. */
  readonly command: string;
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
  demo?(globals: Globals, p: Presentation): Promise<string>;
  /** Without a client, a chooser of `command` lines; `all` is every setup. */
  mcpConfig?(
    globals: Globals,
    options: { client: McpClient | "all" | undefined; name: string },
    command: (args: string[]) => string,
  ): Promise<string>;
  backup?(
    globals: Globals,
    out: string,
  ): Promise<{ backupPath: string; stateDirectory?: string | undefined }>;
  /** The fixed message of a backend-specific error, safe to print. */
  describeError?(error: unknown): string | undefined;
}

type OptionalCommand = "login-link" | "demo" | "backup" | "mcp-config";

type Values = Readonly<Record<string, string | boolean | undefined>>;

interface CommandContext {
  backend: OperatorBackend;
  values: Values;
  globals: Globals;
  positionals: string[];
  p: Presentation;
  /** A runnable follow-up command on the same database. */
  next(args: string[]): string;
}

interface OperatorCommand {
  name: string;
  /** One line for the help overview. */
  summary: string;
  /** Usage lines after the command name. */
  synopsis: readonly string[];
  /** Arguments after the command name, valid as they stand. */
  example: readonly string[];
  description: string;
  options: Readonly<Record<string, { type: "string" | "boolean" }>>;
  /**
   * A result has a terminal view and --json; a stream is always JSON lines,
   * where --json changes nothing; text is the whole output.
   */
  stdout: "result" | "stream" | "text";
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

/** The result's JSON, or in a terminal its view. */
function emit<T>(
  context: CommandContext,
  result: T,
  view: (value: T) => string,
) {
  process.stdout.write(present(context.p, result, view));
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

/** Help text wraps for an 80-column terminal on every backend alike. */
const HELP_WIDTH = 80;

const SCHEDULE_NOTE =
  "Scheduled refresh runs only when the service sets FONDS_REFRESH_SCHEDULE=daily (or hourly, or hours such as 9,13,18).\n";

function summaryStatus(
  statuses: readonly string[],
): "completed" | "failed" | "busy" | "partial" {
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

export const operatorCommands: readonly OperatorCommand[] = [
  {
    name: "init",
    summary: "Set up your private ledger",
    synopsis: [],
    example: [],
    description:
      "Initialize the ledger and its private state without adding provider logins. Safe to repeat. Next, use connect <provider>.",
    options: {},
    stdout: "result",
    async run(context) {
      const location = await withSession(
        context,
        { create: true, credentials: false },
        async (session) => session.location,
      );
      emit(context, { initialized: true }, () =>
        initView(context.p, location, context.next, supportedProviders),
      );
      return EXIT_CODES.ok;
    },
  },
  {
    name: "connect",
    summary: `Add a ${supportedProviders.join(" or ")} login`,
    synopsis: [
      `<${supportedProviders.join("|")}> [--name <id>] [--offline] [--credentials-fd <number>]`,
      "--connection <existing id> [--credentials-fd <number>]",
    ],
    example: [supportedProviders[0]!],
    description:
      "Add a provider login to an initialized ledger; --name defaults to the provider. Prompts privately and saves credentials encrypted without testing the login. Use --offline to register an import-only connection without credentials. Existing names are refused; --connection explicitly updates credentials for an existing login. Run init first.",
    options: {
      name: { type: "string" },
      offline: { type: "boolean" },
      connection: { type: "string" },
      "credentials-fd": { type: "string" },
    },
    stdout: "result",
    async run(context) {
      const provider = context.positionals[0];
      const existing = optionalNonEmpty(context.values, "connection");
      const name = optionalNonEmpty(context.values, "name");
      const offline = context.values.offline === true;
      if (
        (provider && existing !== undefined) ||
        (!provider && existing === undefined) ||
        (existing !== undefined && (name !== undefined || offline))
      ) {
        throw new CommandInputError(
          "Use connect <provider> [--name <id>] to add a login, or connect --connection <id> to update one.",
        );
      }
      if (offline && context.values["credentials-fd"] !== undefined) {
        throw new CommandInputError(
          "--offline cannot be combined with --credentials-fd.",
        );
      }
      if (provider) {
        runtimeProvider(provider);
      }
      const { credentialFd } = collectionControls({
        "credentials-fd": text(context.values, "credentials-fd"),
      });
      const stored = await withSession(
        context,
        { create: false, credentials: !offline },
        async (session) => {
          const options = {
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
          };
          const result = provider
            ? await addConnection({
                ...options,
                connectionId: name ?? provider,
                provider,
                offline,
              })
            : await connectCredentials({ ...options, connectionId: existing! });
          if (!offline) {
            session.verify?.();
          }
          return result;
        },
      );
      // The schedule may live where this command cannot see it (Neon's env file).
      if (!offline) {
        process.stderr.write(SCHEDULE_NOTE);
      }
      emit(context, stored, (result) =>
        connectView(context.p, result, context.next),
      );
      return EXIT_CODES.ok;
    },
  },
  {
    name: "disconnect",
    summary: "Remove a connection's saved credentials",
    synopsis: ["--connection <id>"],
    example: ["--connection", supportedProviders[0]!],
    description:
      "Remove the connection's stored provider credentials, so refreshes that start later skip it; one already running finishes. Credentials from FONDS_CONNECTION_CREDENTIALS are unaffected. Its transactions, annotations and events are kept; repeating it changes nothing.",
    options: { connection: { type: "string" } },
    stdout: "result",
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
      emit(context, removed, (result) => disconnectView(context.p, result));
      return EXIT_CODES.ok;
    },
  },
  {
    name: "refresh",
    summary: "Fetch transactions from your providers",
    synopsis: [
      "[--connection <id>] [--from YYYY-MM-DD --to YYYY-MM-DD] [--credentials-fd <number>]",
      "[--history-mode monthly|search] [--search-window-months 1|3|6|12] [--call-budget 1-100]",
      "[--max-details 0-20] [--diagnostics] [--archive-days 1-30]",
    ],
    example: ["--connection", supportedProviders[0]!],
    description:
      "Refresh from the provider now, under the same lease as the server's. Without --connection, every connection with stored credentials, in turn; the provider options and --credentials-fd need --connection. Credentials come from --credentials-fd, then the connection's stored credentials (see connect), then hidden terminal input. Without dates it rereads the provider's recent window; requested windows do not prove complete history. Prints counts only; each refresh (list-refreshes) records its own result. Another refresh of a connection in progress makes it busy. --diagnostics adds a bounded stage/count report without source values. --archive-days retains redacted raw response bodies temporarily for trusted local investigation.",
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
    stdout: "result",
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
      let nothingToRefresh = false;
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
          if (!discovery.targets.length && !discovery.failures) {
            nothingToRefresh = true;
            process.stderr.write(
              "No connections have saved credentials; run fonds connect <provider> first.\n",
            );
          }
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
      emit(
        context,
        {
          type: "refresh_summary" as const,
          ...summary,
          ...(range && { requestedRange: range }),
          ...(diagnostics && { diagnostics: diagnostics.report() }),
        },
        (result) =>
          refreshView(context.p, result, context.next, {
            connectionId,
            nothingToRefresh,
          }),
      );
      return collectionExitCode(summary.status);
    },
  },
  {
    name: "consume",
    summary: "Deliver the change feed as JSON lines",
    synopsis: ["--connection <id> --consumer <id> [--limit <count>]"],
    example: [
      "--connection",
      supportedProviders[0]!,
      "--consumer",
      "my-script",
    ],
    description:
      "Deliver JSON lines to local stdout and advance the durable consumer cursor. Ends with a delivery_summary line; this sink sends no external notifications.",
    options: {
      connection: { type: "string" },
      consumer: { type: "string" },
      limit: { type: "string" },
    },
    stdout: "stream",
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
    summary: "Apply one captured provider response offline",
    synopsis: [
      "--connection <id> --account <key> --run <id> --file <JSON file>",
      "[--captured-at <ISO timestamp>] [--endpoint <name>]",
    ],
    example: [
      "--connection",
      "imported",
      "--account",
      "ACCOUNT_KEY",
      "--run",
      "import-1",
      "--file",
      "response.json",
    ],
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
    stdout: "result",
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
        { create: false, credentials: false },
        async (session) => {
          const connection = await session.store.getConnection(connectionId);
          if (!connection) {
            throw new CommandInputError(
              "Connection not found; add it with connect <provider> --offline first.",
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
      emit(context, result, (value) => ingestView(context.p, value));
      return EXIT_CODES.ok;
    },
  },
  {
    name: "backup",
    summary: "Copy the ledger to a new private file",
    synopsis: ["--out <path outside this repository>"],
    example: ["--out", "fonds-backup.sqlite"],
    description:
      "Write a coherent copy of the database as a new private file. Back up the state directory with it.",
    options: { out: { type: "string" } },
    stdout: "result",
    async run(context) {
      emit(
        context,
        await context.backend.backup!(
          context.globals,
          required(context.values, "out"),
        ),
        (result) => backupView(context.p, result),
      );
      return EXIT_CODES.ok;
    },
  },
  {
    name: "login-link",
    summary: "Print a one-time owner sign-in link",
    synopsis: [],
    example: [],
    description:
      "Print a one-time owner sign-in link (10 minutes, single use) for the hosted service; open it, then add a passkey on the account page.",
    options: {},
    stdout: "text",
    async run({ backend }) {
      process.stdout.write(`${await backend.loginLink!()}\n`);
      return EXIT_CODES.ok;
    },
  },
  {
    name: "mcp-config",
    summary: "Set up a local AI assistant",
    synopsis: [
      `[--client ${MCP_CLIENTS.join("|")}] [--name <server name>]`,
      "--all [--name <server name>]",
    ],
    example: ["--client", "claude-code"],
    description:
      "Print local SQLite MCP setup with absolute runtime, database and state paths; it does not change client configuration. Without --client, lists the command for each client; --all prints every client's setup. --name sets the MCP server name, fonds by default. Initialize the ledger first; use --db for a demo or another ledger.",
    options: {
      client: { type: "string" },
      all: { type: "boolean" },
      name: { type: "string" },
    },
    stdout: "text",
    async run(context) {
      const client = text(context.values, "client");
      const all = context.values.all === true;
      const name = text(context.values, "name") ?? "fonds";
      if (client !== undefined && all) {
        throw new CommandInputError("Use --client or --all, not both.");
      }
      if (
        client !== undefined &&
        !(MCP_CLIENTS as readonly string[]).includes(client)
      ) {
        throw new CommandInputError(
          `--client must be one of ${MCP_CLIENTS.join(", ")}.`,
        );
      }
      if (!MCP_SERVER_NAME.test(name)) {
        throw new CommandInputError(
          "--name must start with a letter or digit and use only letters, digits, - and _ (at most 64).",
        );
      }
      const named = name === "fonds" ? [] : ["--name", name];
      process.stdout.write(
        await context.backend.mcpConfig!(
          context.globals,
          { client: all ? "all" : (client as McpClient | undefined), name },
          (args) => context.next(["mcp-config", ...args, ...named]),
        ),
      );
      return EXIT_CODES.ok;
    },
  },
  {
    name: "demo",
    summary: "Try Fonds with invented transactions",
    synopsis: [],
    example: [],
    description:
      "Create or refresh a separate ledger of synthetic CAL data and print what to run next. Repeating it changes nothing.",
    options: {},
    stdout: "text",
    async run(context) {
      process.stdout.write(
        await context.backend.demo!(context.globals, context.p),
      );
      return EXIT_CODES.ok;
    },
  },
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
    throw new ConnectError(
      "Connection not found; add it with connect <provider> first.",
    );
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
    connection,
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
  const [first = "", ...rest] = command.synopsis;
  return [
    `  ${command.name.padEnd(NAME_WIDTH)}${first}`.trimEnd(),
    ...rest.map((line) => `${" ".repeat(2 + NAME_WIDTH)}${line}`),
  ].join("\n");
}

/** `serve` belongs to the server entry point; the overview still names it. */
const SERVE_SUMMARY = "Run the HTTP or MCP server";

/** The short overview's tasks; every command is in `help --all`. */
const OVERVIEW = [
  ["Getting started", ["demo", "init", "connect", "refresh"]],
  ["Explore", ["list", "totals", "get"]],
  ["Assistants", ["mcp-config", "login-link", "serve"]],
] as const;

/** One summary per overview name; the overview test checks each resolves. */
export function overviewSummary(name: string): string | undefined {
  return name === "serve"
    ? SERVE_SUMMARY
    : (commandsByName.get(name)?.summary ?? aliasSummary(name));
}

/** `fonds`, `fonds --help`: the first steps by task, without unavailable commands. */
export function operatorOverview(backend: OperatorBackend): string {
  const run = backend.invocation;
  const groups = OVERVIEW.map(([title, names]) => {
    const lines = names
      .filter((name) => !backend.unavailable[name as OptionalCommand])
      .map((name) => `  ${name.padEnd(NAME_WIDTH)}${overviewSummary(name)}`);
    return [title, ...lines].join("\n");
  });
  return `Fonds — your card transactions, in a ledger your AI assistant can read

Usage: ${run} <command> [options]

${groups.join("\n\n")}

Run '${run} help <command>' for its options and an example.
Run '${run} help --all' for every command, remote use and exit codes.
`;
}

/** `help --all`: every command and option, the same commands on every backend. */
export function operatorUsage(backend: OperatorBackend): string {
  const unavailable = Object.entries(backend.unavailable).map(
    ([, reason]) => `  ${reason}`,
  );
  return `Fonds — ${backend.title}
Usage: ${backend.invocation} <command> [options]
       ${backend.invocation} <operation command> --remote <url> --token-file <private file> [options]
       ${backend.invocation} help <command>
       ${backend.invocation} --version

${backend.description}
${unavailable.length ? `\nNot available here:\n${unavailable.join("\n")}\n` : ""}
Operation commands run the same operations as the HTTP API and MCP tools, with the same
input fields as kebab-case flags and the same JSON output. Booleans take true or false,
integers are decimal, and object or list fields take JSON. --remote calls a Fonds
deployment's /v1 API (https, or http on this machine) with a bearer from --token-file,
which --remote requires; it never comes from the environment or the local state.
In a terminal, list, get, totals, list-connections and operator results print as text;
--json, or redirected output, prints the JSON result. consume always prints JSON lines.
Aliases: ${aliasNames().join(", ")}.
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

function commandHelp(command: OperatorCommand, backend: OperatorBackend) {
  const run = `${backend.invocation} ${command.name}`;
  const [first, ...rest] = command.synopsis;
  return [
    `${run} — ${command.summary}`,
    "",
    "Usage:",
    `  ${[run, first].filter(Boolean).join(" ")}`,
    ...rest.map((line) => `${" ".repeat(3 + run.length)}${line}`),
    "",
    "Example:",
    `  ${commandLine(run, command.example)}`,
    "",
    wrap(command.description, HELP_WIDTH),
    "",
    "Global options:",
    ...globalHelp(backend.globalOptions).split("\n").filter(Boolean),
    ...(command.stdout === "result" ? [JSON_HELP] : []),
    ...(command.stdout === "stream"
      ? ["  --json  Accepted; output is always JSON lines"]
      : []),
    "  -h, --help",
    "",
  ].join("\n");
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
  options: Readonly<
    Record<string, { type: "string" | "boolean"; short?: string }>
  >,
  command: string,
): { values: Values; positionals: string[] } {
  try {
    const result = parseArgs({
      args,
      strict: true,
      allowPositionals: command === "connect",
      options,
    });
    if (result.positionals.length > 1) {
      throw new Error();
    }
    return result;
  } catch {
    throw new CommandInputError(
      `Invalid arguments. Use ${command} --help for its flags.`,
    );
  }
}

/** `--name value` for each global option given, so a next step targets the same database. */
function globalArgs(globals: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(globals).flatMap(([name, value]) =>
    typeof value === "string" ? [`--${name}`, value] : [],
  );
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
  name: string,
  args: string[],
) {
  return runOperationCli({
    definition,
    args,
    name,
    invocation: backend.invocation,
    wrap: (text) => wrap(text, HELP_WIDTH),
    render(output, { input, json, globals }) {
      const p = presentation(json);
      const view = operationViews[definition.name] as View<unknown> | undefined;
      // A remote result is unvalidated; one that fails its schema stays JSON.
      const shown =
        view && definition.outputSchema.safeParse(output).success
          ? view
          : undefined;
      return present(
        p,
        output,
        shown &&
          ((value) =>
            shown(value, p, {
              input,
              command: (args) =>
                commandLine(backend.command, [...args, ...globalArgs(globals)]),
            })),
      );
    },
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
  if (name === undefined) {
    process.stdout.write(operatorOverview(backend));
    return EXIT_CODES.ok;
  }
  if (name === "help" || name === "--help" || name === "-h") {
    if (args.length === 0) {
      process.stdout.write(operatorOverview(backend));
      return EXIT_CODES.ok;
    }
    if (args.length === 1 && args[0] === "--all") {
      process.stdout.write(operatorUsage(backend));
      return EXIT_CODES.ok;
    }
    if (name === "help" && !args[0]!.startsWith("-")) {
      return runOperatorCli(backend, [...args, "--help"]);
    }
    process.stderr.write("Use help, help --all or help <command>.\n");
    return EXIT_CODES.failed;
  }
  if (name === "--version") {
    process.stdout.write(`${FONDS_VERSION}\n`);
    return EXIT_CODES.ok;
  }
  const definition = operationForCommand(name);
  if (definition) {
    return runOperation(backend, definition, name, args);
  }
  const command = commandsByName.get(name);
  try {
    if (!command) {
      throw new CommandInputError(
        name.startsWith("-")
          ? "Specify one command. Use --help for usage."
          : "Unknown command. Use --help for usage.",
      );
    }
    if (args.some((value) => /^--remote(=|$)/.test(value))) {
      throw new CommandInputError(
        "Operator commands use a local database only; --remote runs operation commands.",
      );
    }
    const { values, positionals } = parseValues(
      args,
      {
        ...command.options,
        ...backend.globalOptions,
        ...(command.stdout !== "text" && { json: { type: "boolean" } }),
        help: { type: "boolean", short: "h" },
      },
      command.name,
    );
    if (values.help) {
      process.stdout.write(commandHelp(command, backend));
      return EXIT_CODES.ok;
    }
    const reason = backend.unavailable[command.name as OptionalCommand];
    if (reason) {
      process.stderr.write(`${reason}\n`);
      return EXIT_CODES.unavailable;
    }
    const globals = globalsOf(backend, values);
    return await command.run({
      backend,
      values,
      globals,
      positionals,
      p: presentation(values.json === true),
      next: (next) =>
        commandLine(backend.command, [...next, ...globalArgs(globals)]),
    });
  } catch (error) {
    process.stderr.write(`${errorMessage(error, backend)}\n`);
    return EXIT_CODES.failed;
  }
}
