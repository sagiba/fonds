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
import { jsonOutput } from "./json-output.js";
import { StateError } from "./state.js";

/** Fixed, value-free messages for invalid command lines. */
export class CommandInputError extends Error {}

/** Short command names, each an alias of one operation. */
const aliases: Readonly<Record<string, string>> = {
  list: "list_transactions",
  get: "get_transaction",
  totals: "get_transaction_totals",
  events: "list_events",
  annotate: "update_annotation",
  link: "link_pending_transaction",
  remove: "confirm_removal",
};

const kebab = (name: string) =>
  name
    .replace(/_/g, "-")
    .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** A command is an operation name in kebab case (`list-transactions`) or an alias. */
export function operationForCommand(
  command: string,
): OperationDefinition | undefined {
  const name = aliases[command] ?? command.replace(/-/g, "_");
  const definition = operationDefinitions.find((entry) => entry.name === name);
  return definition && (aliases[command] || kebab(name) === command)
    ? definition
    : undefined;
}

type FieldKind = "string" | "number" | "boolean" | "json";

interface Field {
  key: string;
  flag: string;
  kind: FieldKind;
  required: boolean;
  nullable: boolean;
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
  let current = schema;
  for (;;) {
    const { def } = current._zod;
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
  const flags = new Map(
    operationFields(definition).map((field) => [field.key, field.flag]),
  );
  const messages = error.issues.map((issue) => {
    const key = issue.path[0];
    const flag = typeof key === "string" ? flags.get(key) : undefined;
    if (issue.code === "custom") {
      return flag ? `--${flag}: ${issue.message}` : issue.message;
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
  const input: Record<string, unknown> = {};
  for (const field of operationFields(definition)) {
    const text = values[field.flag];
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
  return Object.fromEntries(
    operationFields(definition).map((field) => [
      field.flag,
      { type: "string" as const },
    ]),
  );
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

export function operationHelp(definition: OperationDefinition): string {
  const fields = operationFields(definition)
    .map(
      (field) =>
        `  --${field.flag} <${field.kind === "json" ? "JSON" : field.kind}>${
          field.required ? " (required)" : ""
        }${field.nullable ? " (empty text or JSON null clears)" : ""}`,
    )
    .join("\n");
  return `${kebab(definition.name)}${
    definition.readOnly ? "" : " (changes data)"
  }\n${definition.description}\n${fields}\n`;
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
) {
  // Derived outside the try: an unsupported schema is not an argument error.
  const options = { ...operationOptions(definition), ...globalOptions };
  try {
    return parseArgs({ args, allowPositionals: false, strict: true, options })
      .values as Record<string, string | boolean | undefined>;
  } catch {
    throw new CommandInputError(
      `Invalid arguments. Use ${kebab(definition.name)} --help for its flags.`,
    );
  }
}

type GlobalOptions = Readonly<Record<string, { type: "string" | "boolean" }>>;

/**
 * Runs one operation command and prints only its JSON output. Each entry point
 * supplies the invoker: an embedded store of its own driver, or a remote client.
 * Global option values are passed to `connect`; operation flags never are.
 */
export async function runOperationCli(options: {
  definition: OperationDefinition;
  args: string[];
  globalOptions?: GlobalOptions;
  connect: (
    globals: Readonly<Record<string, string | boolean | undefined>>,
  ) => Promise<{ invoker: OperationInvoker; close?: () => Promise<void> }>;
}): Promise<number> {
  const { definition } = options;
  let close: (() => Promise<void>) | undefined;
  let status = 0;
  try {
    const values = parseOperationArgs(definition, options.args, {
      help: { type: "boolean" },
      ...options.globalOptions,
    });
    if (values.help) {
      process.stdout.write(operationHelp(definition));
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
    process.stdout.write(jsonOutput(output));
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
  const [command, ...rest] = args;
  const definition = command ? operationForCommand(command) : undefined;
  if (!definition) {
    process.stderr.write("Unknown command. Use --help for usage.\n");
    return 1;
  }
  return runOperationCli({
    definition,
    args: rest,
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
