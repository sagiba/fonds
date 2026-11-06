import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { parseArgs } from "node:util";

import type { z } from "zod";

import type { FinancialStore } from "../application/financial-store.js";
import {
  createApplication,
  inProcessInvoker,
  type OperationDefinition,
  operationDefinitions,
  type OperationInvoker,
  OperationUnavailableError,
  publicError,
} from "../application/operations.js";
import { NewerSchemaError } from "../storage/migrations.js";
import {
  createRestClient,
  RemoteOperationError,
  remoteOrigin,
} from "../transport/rest-client.js";
import { commandLine } from "./cli-invocation.js";
import { jsonOutput } from "./json-output.js";
import { StateError } from "./state.js";

/** Fixed, value-free messages for invalid command lines. */
export class CommandInputError extends Error {}

/**
 * How help presents each operation: a summary, an example that is valid as it
 * stands, and the short alias where one exists. Flags stay schema-derived.
 */
const presentations: Readonly<
  Record<string, { alias?: string; summary: string; example: string[] }>
> = {
  list_connections: {
    summary: "List connections and their latest refresh",
    example: [],
  },
  get_connection: {
    summary: "Show one connection",
    example: ["--connection-id", "cal"],
  },
  get_connection_coverage: {
    alias: "coverage",
    summary: "Show which months a connection's history covers",
    example: ["--connection-id", "cal"],
  },
  list_cards: {
    summary: "List a connection's cards",
    example: ["--connection-id", "cal"],
  },
  get_card: { summary: "Show one card", example: ["--card-id", "CARD_ID"] },
  list_accounts: {
    summary: "List a connection's accounts",
    example: ["--connection-id", "cal"],
  },
  get_account: {
    summary: "Show one account",
    example: ["--account-id", "ACCOUNT_ID"],
  },
  list_transactions: {
    alias: "list",
    summary: "Browse transactions",
    example: ["--limit", "5"],
  },
  get_transaction: {
    alias: "get",
    summary: "Show one transaction",
    example: ["--transaction-id", "TRANSACTION_ID"],
  },
  get_transactions: {
    summary: "Show several transactions by ID",
    example: ["--ids", '["TRANSACTION_ID"]', "--view", "summary"],
  },
  get_transaction_totals: {
    alias: "totals",
    summary: "Sum amounts by currency and amount basis",
    example: ["--perspective", "billing"],
  },
  list_events: {
    alias: "events",
    summary: "Read a connection's change feed",
    example: ["--connection-id", "cal", "--limit", "20"],
  },
  list_sync_runs: {
    summary: "List a connection's recent sync runs",
    example: ["--connection-id", "cal"],
  },
  update_annotation: {
    alias: "annotate",
    summary: "Add notes, a category or tags to a transaction",
    example: [
      "--transaction-id",
      "TRANSACTION_ID",
      "--expected-version",
      "0",
      "--notes",
      "Team lunch",
    ],
  },
  refresh_connection: {
    summary: "Ask a running service to refresh a connection",
    example: ["--connection-id", "cal"],
  },
  resume_refresh: {
    summary: "Ask a running service to continue an unfinished refresh",
    example: ["--refresh-id", "REFRESH_ID"],
  },
  get_refresh: {
    summary: "Show one refresh and its windows",
    example: ["--refresh-id", "REFRESH_ID"],
  },
  list_refreshes: {
    summary: "List a connection's refreshes",
    example: ["--connection-id", "cal"],
  },
  undo_annotation: {
    summary: "Undo one annotation change",
    example: ["--event-id", "42", "--expected-version", "3"],
  },
  link_pending_transaction: {
    alias: "link",
    summary: "Confirm that a pending and a posted transaction are one purchase",
    example: postingExample("Same purchase"),
  },
  unlink_pending_transaction: {
    summary: "Undo a pending-to-posted link",
    example: postingExample("Different purchases"),
  },
  confirm_removal: {
    alias: "remove",
    summary: "Mark a transaction removed",
    example: [
      "--transaction-id",
      "TRANSACTION_ID",
      "--expected-transaction-version",
      "1",
      "--reason",
      "Cancelled by the merchant",
    ],
  },
};

function postingExample(reason: string): string[] {
  return [
    "--transaction-id",
    "PENDING_ID",
    "--posted-id",
    "POSTED_ID",
    "--expected-pending-transaction-version",
    "1",
    "--expected-posted-transaction-version",
    "1",
    "--expected-pending-annotation-version",
    "0",
    "--expected-posted-annotation-version",
    "0",
    "--reason",
    reason,
  ];
}

const kebab = (name: string) =>
  name
    .replace(/_/g, "-")
    .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

const aliases = new Map(
  Object.entries(presentations).flatMap(([operation, { alias }]) =>
    alias ? [[alias, operation] as const] : [],
  ),
);

/** A command is an operation name in kebab case (`list-transactions`) or an alias. */
export function operationForCommand(
  command: string,
): OperationDefinition | undefined {
  const name = aliases.get(command) ?? command.replace(/-/g, "_");
  const definition = operationDefinitions.find((entry) => entry.name === name);
  return definition && (aliases.has(command) || kebab(name) === command)
    ? definition
    : undefined;
}

/** An operation's help presentation; every operation has one. */
export function operationPresentation(definition: OperationDefinition) {
  const presentation = presentations[definition.name];
  if (!presentation) {
    throw new Error(`Operation ${definition.name} has no help presentation.`);
  }
  return presentation;
}

/** The one-line summary help gives an alias, such as `list`. */
export function aliasSummary(command: string): string | undefined {
  const operation = aliases.get(command);
  return operation && presentations[operation]?.summary;
}

/** Every alias, as `help --all` lists them. */
export function aliasNames(): string[] {
  return [...aliases.keys()];
}

/** Every operation command name and alias. */
export function operationCommandNames(): string[] {
  return [
    ...operationDefinitions.map((definition) => kebab(definition.name)),
    ...aliases.keys(),
  ];
}

type FieldKind = "string" | "number" | "boolean" | "json";

interface Field {
  key: string;
  flag: string;
  kind: FieldKind;
  required: boolean;
  nullable: boolean;
  choices?: string[];
  /** The value an omitted flag takes, as help shows it. */
  default?: string;
}

/** Zod's published union of its schema kinds, discriminated by `def.type`. */
type Schema = z.core.$ZodTypes;

/**
 * The schema kinds a flag can carry. A field may wrap its value in `optional`,
 * `default` or `nullable`; the value kind decides how the flag's text is read.
 * Any other kind throws while flags are derived, before input is read, so a new
 * schema shape cannot be parsed the wrong way.
 */
function fieldOf(key: string, schema: Schema): Field {
  let required = true;
  let nullable = false;
  let fallback: string | undefined;
  let current = schema;
  for (;;) {
    const { def } = current._zod;
    if (def.type === "default") {
      const value: unknown = def.defaultValue;
      if (["string", "number", "boolean"].includes(typeof value)) {
        fallback ??= String(value);
      }
    }
    if (def.type === "optional" || def.type === "default") {
      required = false;
    } else if (def.type === "nullable") {
      nullable = true;
    } else {
      break;
    }
    current = def.innerType as Schema;
  }
  return {
    key,
    flag: kebab(key),
    kind: valueKind(key, current),
    required,
    nullable,
    ...(fallback !== undefined && { default: fallback }),
    ...(current._zod.def.type === "enum" && {
      choices: Object.values(current._zod.def.entries).map(String),
    }),
  };
}

function valueKind(key: string, schema: Schema): FieldKind {
  const { def } = schema._zod;
  switch (def.type) {
    case "string":
    case "enum":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "literal":
      if (def.values.every((value) => typeof value === "number")) {
        return "number";
      }
      break;
    case "union": {
      const kinds = new Set(
        def.options.map((option) => valueKind(key, option as Schema)),
      );
      return kinds.size === 1 ? [...kinds][0]! : "json";
    }
    case "array":
    case "object":
    case "record":
      return "json";
  }
  throw new Error(
    `Input field ${key} uses a schema kind the command line does not support (${def.type}).`,
  );
}

/** Flags are the operation's input fields in kebab case; the schema stays the authority. */
export function operationFields(definition: OperationDefinition): Field[] {
  return Object.entries(definition.inputSchema.shape).map(([key, schema]) =>
    fieldOf(key, schema as Schema),
  );
}

function fieldValue(field: Field, text: string): unknown {
  if (field.nullable && field.kind !== "json" && text === "") {
    return null;
  }
  switch (field.kind) {
    case "string":
      return text;
    case "number":
      if (!/^-?(0|[1-9][0-9]*)$/.test(text)) {
        throw new CommandInputError(`--${field.flag} must be an integer.`);
      }
      return Number(text);
    case "boolean":
      if (text !== "true" && text !== "false") {
        throw new CommandInputError(`--${field.flag} must be true or false.`);
      }
      return text === "true";
    case "json":
      try {
        return JSON.parse(text);
      } catch {
        throw new CommandInputError(`--${field.flag} must be JSON.`);
      }
  }
}

/** Fixed text per validation issue; validator messages can quote supplied keys. */
const issueText: Readonly<Record<string, string>> = {
  invalid_type: "has the wrong type",
  too_small: "is too small or too short",
  too_big: "is too large or too long",
  invalid_value: "is not an allowed value",
  invalid_format: "has an invalid format",
  unrecognized_keys: "has an unknown field",
};

/**
 * Names only the operation's own flags. Refinement messages are the schema's
 * fixed text; nested paths and other messages are never shown.
 */
function inputIssues(
  definition: OperationDefinition,
  error: z.ZodError,
): string {
  const fields = new Map(
    operationFields(definition).map((field) => [field.key, field]),
  );
  const messages = error.issues.map((issue) => {
    const key = issue.path[0];
    const field = typeof key === "string" ? fields.get(key) : undefined;
    const flag = field?.flag;
    if (issue.code === "custom") {
      return flag ? `--${flag}: ${issue.message}` : issue.message;
    }
    if (issue.code === "invalid_value" && field?.choices) {
      return `--${flag} must be one of ${field.choices.join(", ")}`;
    }
    const text = issueText[issue.code] ?? "is invalid";
    return flag ? `--${flag} ${text}` : `The input ${text}`;
  });
  return [...new Set(messages)].slice(0, 5).join("; ");
}

/** Parses an operation command's flags into its input, validated before any call. */
export function operationInput(
  definition: OperationDefinition,
  values: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  if (
    values.connection !== undefined &&
    values["connection-id"] !== undefined
  ) {
    throw new CommandInputError(
      "Use either --connection or --connection-id, not both.",
    );
  }
  const input: Record<string, unknown> = {};
  for (const field of operationFields(definition)) {
    const text =
      field.key === "connectionId"
        ? (values.connection ?? values[field.flag])
        : values[field.flag];
    if (text !== undefined) {
      input[field.key] = fieldValue(field, text);
    } else if (field.required) {
      throw new CommandInputError(`--${field.flag} is required.`);
    }
  }
  const parsed = definition.inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandInputError(
      `Invalid input: ${inputIssues(definition, parsed.error)}.`,
    );
  }
  return input;
}

export function operationOptions(definition: OperationDefinition) {
  const options = Object.fromEntries(
    operationFields(definition).map((field) => [
      field.flag,
      { type: "string" as const },
    ]),
  );
  if ("connectionId" in definition.inputSchema.shape) {
    options.connection = { type: "string" };
  }
  return options;
}

/** One line per operation command, derived from the contract. */
export function operationUsage(): string {
  return operationDefinitions
    .map((definition) => {
      const flags = operationFields(definition).map((field) =>
        field.required ? `--${field.flag}` : `[--${field.flag}]`,
      );
      return `  ${[kebab(definition.name), ...flags].join(" ")}`;
    })
    .join("\n");
}

function flagHelp(field: Field): string {
  const value =
    field.choices?.join("|") ?? (field.kind === "json" ? "JSON" : field.kind);
  return `  --${field.flag} <${value}>${
    field.default !== undefined ? ` (default ${field.default})` : ""
  }${field.nullable ? " (empty text or JSON null clears)" : ""}`;
}

/**
 * Prose wrapped at spaces to 80 columns, for entry points without terminal
 * libraries; help prose is plain text, one column per character.
 */
function wrapWords(text: string, width = 80): string {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= width) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines.join("\n");
}

/** Purpose, example, then the schema's own flags: required first. */
export function operationHelp(
  definition: OperationDefinition,
  globals: GlobalOptions = {},
  options: {
    name?: string;
    invocation?: string;
    wrap?: (text: string) => string;
    /** False where output is always JSON, so --json selects nothing. */
    json?: boolean;
  } = {},
): string {
  const { alias, summary, example } = operationPresentation(definition);
  const name = options.name ?? kebab(definition.name);
  const command = [options.invocation, name].filter(Boolean).join(" ");
  const fields = operationFields(definition);
  const required = fields.filter((field) => field.required);
  const optional = [
    ...fields.filter((field) => !field.required).map(flagHelp),
    ...("connectionId" in definition.inputSchema.shape
      ? ["  --connection <string> (alias for --connection-id)"]
      : []),
  ];
  const section = (title: string, lines: readonly string[]) =>
    lines.length ? ["", title, ...lines] : [];
  return [
    `${command} — ${summary}${definition.readOnly ? "" : " (changes data)"}`,
    ...(alias
      ? [
          name === alias
            ? `Alias of ${kebab(definition.name)}.`
            : `Alias: ${alias}.`,
        ]
      : []),
    ...section("Usage:", [
      `  ${[command, ...required.map((field) => `--${field.flag} <${field.flag}>`), "[options]"].join(" ")}`,
    ]),
    ...section("Example:", [`  ${commandLine(command, example)}`]),
    "",
    (options.wrap ?? wrapWords)(definition.description),
    ...section("Required:", required.map(flagHelp)),
    ...section("Options:", optional),
    ...section("Global options:", [
      ...globalHelp(globals).split("\n").filter(Boolean),
      ...(options.json === false ? [] : [JSON_HELP]),
      "  -h, --help",
    ]),
    "",
  ].join("\n");
}

export const JSON_HELP =
  "  --json  Print the JSON result, the default when output is redirected";

export function globalHelp(globals: GlobalOptions): string {
  return Object.entries(globals)
    .map(
      ([name, { type }]) =>
        `  --${name}${type === "string" ? " <string>" : ""}\n`,
    )
    .join("");
}

/** Remote callers present a bearer from a private file, never from arguments. */
export function readTokenFile(path: string): string {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 257 ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      ) {
        throw new Error();
      }
      const token = readFileSync(fd, "utf8").trim();
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
        throw new Error();
      }
      return token;
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new CommandInputError(
      "Could not read the API token: use a private current-owner 0600 file.",
    );
  }
}

/**
 * The remote invoker. Its bearer comes only from the explicit --token-file,
 * so no token is ever sent where the operator did not name one.
 */
export function remoteInvoker(options: {
  remote: string;
  tokenFile?: string | undefined;
  fetch?: typeof fetch;
}): OperationInvoker {
  let origin: string;
  try {
    origin = remoteOrigin(options.remote);
  } catch (error) {
    throw new CommandInputError((error as Error).message);
  }
  if (options.tokenFile === undefined) {
    throw new CommandInputError(
      "--remote needs --token-file <a private 0600 file holding the API token>.",
    );
  }
  return createRestClient({
    origin,
    token: readTokenFile(options.tokenFile),
    ...(options.fetch && { fetch: options.fetch }),
  });
}

/** Parses `<command> [flags]` for an operation, with extra global options. */
function parseOperationArgs(
  definition: OperationDefinition,
  args: string[],
  globalOptions: Readonly<Record<string, { type: "string" | "boolean" }>>,
  name = kebab(definition.name),
) {
  // Derived outside the try: an unsupported schema is not an argument error.
  const options = {
    ...operationOptions(definition),
    ...globalOptions,
    // Presentation only: never operation input or a connection setting.
    json: { type: "boolean" as const },
    help: { type: "boolean" as const, short: "h" },
  };
  try {
    return parseArgs({ args, allowPositionals: false, strict: true, options })
      .values as Record<string, string | boolean | undefined>;
  } catch {
    throw new CommandInputError(
      `Invalid arguments. Use ${name} --help for its flags.`,
    );
  }
}

type GlobalOptions = Readonly<Record<string, { type: "string" | "boolean" }>>;

type Globals = Readonly<Record<string, string | boolean | undefined>>;

/**
 * Runs one operation command and prints only its result. Each entry point
 * supplies the invoker: an embedded store of its own driver, or a remote
 * client. Global option values are passed to `connect`; operation flags never
 * are. Terminal presentation is the caller's: without `render` the output is
 * JSON, so entry points that do not render need no terminal libraries.
 */
export async function runOperationCli(options: {
  definition: OperationDefinition;
  args: string[];
  globalOptions?: GlobalOptions;
  /** The command as typed, such as `list`, and how its CLI is invoked. */
  name?: string;
  invocation?: string;
  /** Wraps help prose; without it, prose prints as written. */
  wrap?: (text: string) => string;
  /** The result for stdout; `input` is validated, with defaults applied. */
  render?: (
    output: unknown,
    request: {
      input: Record<string, unknown>;
      json: boolean;
      globals: Globals;
      /** The arguments as typed after the command name. */
      args: readonly string[];
    },
  ) => string;
  connect: (
    globals: Globals,
  ) => Promise<{ invoker: OperationInvoker; close?: () => Promise<void> }>;
}): Promise<number> {
  const { definition } = options;
  let close: (() => Promise<void>) | undefined;
  let status = 0;
  try {
    const values = parseOperationArgs(
      definition,
      options.args,
      options.globalOptions ?? {},
      options.name,
    );
    if (values.help) {
      process.stdout.write(
        operationHelp(definition, options.globalOptions, {
          ...options,
          json: options.render !== undefined,
        }),
      );
      return 0;
    }
    const input = operationInput(
      definition,
      values as Record<string, string | undefined>,
    );
    const globals = Object.fromEntries(
      Object.keys(options.globalOptions ?? {}).map((name) => [
        name,
        values[name],
      ]),
    );
    const connection = await options.connect(globals);
    close = connection.close;
    const output = await connection.invoker.invoke(definition.name, input);
    process.stdout.write(
      options.render?.(output, {
        input: definition.inputSchema.parse(input) as Record<string, unknown>,
        json: values.json === true,
        globals,
        args: options.args,
      }) ?? jsonOutput(output),
    );
  } catch (error) {
    process.stderr.write(`${operationErrorMessage(error)}\n`);
    status = 1;
  }
  try {
    await close?.();
  } catch {
    // Driver errors can hold connection strings; never echo them.
    process.stderr.write("Could not close the database.\n");
    status = 1;
  }
  return status;
}

/** `<operation command> [flags]` on a store the entry point opens with its own driver. */
export async function runEmbeddedOperation(
  args: string[],
  open: () => Promise<FinancialStore & { close(): Promise<void> | void }>,
): Promise<number> {
  const [command = "", ...rest] = args;
  const definition = operationForCommand(command);
  if (!definition) {
    process.stderr.write("Unknown command. Use --help for usage.\n");
    return 1;
  }
  return runOperationCli({
    definition,
    args: rest,
    name: command,
    invocation: "node server.js",
    async connect() {
      const store = await open();
      return {
        invoker: inProcessInvoker(createApplication(store)),
        close: async () => {
          await store.close();
        },
      };
    },
  });
}

/** A secret-free message for a failed operation command. */
export function operationErrorMessage(error: unknown): string {
  if (
    error instanceof CommandInputError ||
    error instanceof OperationUnavailableError ||
    error instanceof StateError ||
    // Names only migration numbers, so the operator knows to upgrade.
    error instanceof NewerSchemaError
  ) {
    return error.message;
  }
  if (error instanceof RemoteOperationError) {
    return `${error.code}: ${error.message}`;
  }
  const result = publicError(error);
  return `${result.code}: ${result.message}`;
}
