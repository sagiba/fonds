/**
 * Read-only, value-free structural audit of archived CAL responses.
 *
 *   TSX_DISABLE_CACHE=1 node --no-warnings --import tsx \
 *     tests/providers/cal/scripts/audit-cal-db.ts --db ARCHIVE.sqlite [--inventory]
 *
 * `TSX_DISABLE_CACHE=1` stops the tsx loader writing its compile cache, and
 * `--no-warnings` stops Node printing warning text; the script refuses to run
 * without both.
 *
 * The archive is never opened by SQLite: it is copied, with its write-ahead
 * log, into a new owner-only directory under the system temporary directory,
 * and the copy opens read-only (`mode=ro` URI plus `query_only`) and is removed
 * once read. Stdout is one JSON report of counts, allowlisted codes and field
 * paths. A path names only fields from a public vocabulary: the observed
 * schema, the committed CAL response fixtures and the containers this script
 * reads. Any other key, however harmless it looks, prints as `<unlisted>` and
 * is only counted. It never prints source values, identifiers, unlisted field
 * names, timestamps, raw warnings or exception messages. Monthly and
 * statement-catalog schemas remain unknown: their containers are counted and
 * inventoried, not validated.
 */
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isLosslessNumber, parse } from "lossless-json";

import { compileSchema, type InstancePath } from "./json-schema-subset.js";

const ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const AUDIT_VERSION = 3;
const MAX_KEYS = 2000;
const MAX_DEPTH = 32;
const SEARCH_ENDPOINT =
  "https://api.cal-online.co.il/Transactions/api/filteredTransactions/getFilteredTransactions";
const STATEMENTS_ENDPOINT =
  "https://api.cal-online.co.il/ReportList/api/digitalServices/reportListsSearch";
const EMPTY_SEARCH_DESCRIPTION = "לא נמצאו נתונים עבור הפרמטרים שהוזנו";
const SAFE_FIELD = /^[a-z][a-zA-Z0-9_]{0,63}$/;
/** Containers this script reads, named here so the vocabulary never depends on a fixture keeping them. */
const CONTAINER_FIELDS = [
  "bankAccounts",
  "debitDates",
  "debitDays",
  "immidiateDebits",
  "months",
  "reportList",
];
/** Public field names a report path may contain; filled before any archive is read. */
const fieldNames = new Set<string>();
const RUN_STATUSES = new Set(["started", "completed", "partial", "failed"]);
const WARNING_CODES = new Set([
  "invalid_json",
  "unsuccessful_or_invalid_envelope",
  "unsupported_pagination",
  "unsupported_monthly_projection",
  "unsupported_monthly_rows",
  "invalid_posted_partition",
  "invalid_pending_partition",
  "invalid_posted_row",
  "invalid_pending_row",
  "ambiguous_posted_identity",
  "ambiguous_pending_identity",
  "invalid_extracted_posted_row",
  "invalid_extracted_pending_row",
  "network_error",
  "authentication_failed",
  "authentication_challenge",
  "invalid_response",
  "rate_limited",
  "empty_search_result",
]);
const ERROR_TYPES = new Set([
  "ArchiveSidecarError",
  "CleanupError",
  "Error",
  "RangeError",
  "SyntaxError",
  "TypeError",
]);

type SourceObject = Record<string, unknown>;

type Shape =
  | "legacy"
  | "monthly"
  | "recent"
  | "search_empty"
  | "statement_catalog"
  | "statement_empty"
  | "unknown";

/** Bounded counts; a new key past the limit is counted as `<overflow>`. */
class Counter {
  readonly #counts = new Map<string, number>();

  add(key: string, by = 1): void {
    const target =
      this.#counts.has(key) || this.#counts.size < MAX_KEYS
        ? key
        : "<overflow>";
    this.#counts.set(target, (this.#counts.get(target) ?? 0) + by);
  }

  has(key: string): boolean {
    return this.#counts.has(key);
  }

  entries(): IterableIterator<[string, number]> {
    return this.#counts.entries();
  }

  total(): number {
    let sum = 0;
    for (const count of this.#counts.values()) {
      sum += count;
    }
    return sum;
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries([...this.#counts].sort(byKey));
  }
}

function byKey([left]: [string, unknown], [right]: [string, unknown]): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

let stage = "arguments";

/**
 * Process warnings can carry dependency or driver text. `--no-warnings` stops
 * Node printing them from process start, and any listener left is replaced.
 */
process.removeAllListeners("warning");
process.on("warning", () => {});

/** Launched as documented: no warning printer and no tsx compile cache. */
function launchedSafely(): boolean {
  const nodeOptions = (process.env.NODE_OPTIONS ?? "").split(/\s+/);
  return (
    (process.execArgv.includes("--no-warnings") ||
      nodeOptions.includes("--no-warnings")) &&
    process.env.TSX_DISABLE_CACHE === "1"
  );
}

class LaunchError extends Error {}

class UsageError extends Error {}

/** A hot rollback journal needs a write to read the archive consistently. */
class ArchiveSidecarError extends Error {}

/** Removal failed for at least one file; each one was still attempted. */
class CleanupError extends Error {}

/** A fixed error category: an allowlisted class name, never a message. */
function errorType(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : "";
  return ERROR_TYPES.has(name) ? name : "<other-error>";
}

function object(value: unknown): value is SourceObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isLosslessNumber(value)
  );
}

/** Strict JSON with exact numbers; non-text cells are decoded as UTF-8. */
function decode(cell: unknown): unknown {
  const text =
    cell instanceof Uint8Array
      ? new TextDecoder("utf-8", { fatal: true }).decode(cell)
      : cell;
  if (typeof text !== "string") {
    throw new TypeError();
  }
  return parse(text);
}

function numberEquals(value: unknown, expected: number): boolean {
  return isLosslessNumber(value) && Number(value.value) === expected;
}

/** An unlisted key may be an identifier, a name or other source text. */
function safeField(key: string): string {
  return fieldNames.has(key) ? key : "<unlisted>";
}

/**
 * Field names from the observed schema's properties, the committed CAL
 * response fixtures and `CONTAINER_FIELDS`, kept only when they look like
 * ordinary field names.
 */
function loadFieldNames(schema: unknown): void {
  const names = new Set(CONTAINER_FIELDS);
  /** Every object key, or with `propertiesOnly` only the keys of `properties` maps. */
  const collect = (value: unknown, propertiesOnly: boolean): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => collect(item, propertiesOnly));
    } else if (object(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (!propertiesOnly) {
          names.add(key);
        } else if (key === "properties" && object(item)) {
          Object.keys(item).forEach((name) => names.add(name));
        }
        collect(item, propertiesOnly);
      }
    }
  };
  collect(schema, true);
  const directory = join(ROOT, "tests/providers/cal/fixtures");
  for (const name of readdirSync(directory).sort()) {
    if (name.endsWith(".json") && name !== "scenarios.json") {
      collect(parse(readFileSync(join(directory, name), "utf8")), false);
    }
  }
  for (const name of names) {
    if (SAFE_FIELD.test(name) && !/\d{5}|__/.test(name)) {
      fieldNames.add(name);
    }
  }
}

function valueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (isLosslessNumber(value)) {
    // A literal without a fraction or exponent is an integer, as JSON spells it.
    return /^-?\d+$/.test(value.value) ? "integer" : "number";
  }
  if (typeof value === "string") {
    return "string";
  }
  return Array.isArray(value) ? "array" : "object";
}

function inventory(value: unknown, counter: Counter, path = "$", depth = 0) {
  counter.add(`${path}|${valueType(value)}`);
  if (depth >= MAX_DEPTH) {
    counter.add("<depth-limit>");
  } else if (Array.isArray(value)) {
    for (const item of value) {
      inventory(item, counter, `${path}[]`, depth + 1);
    }
  } else if (object(value)) {
    for (const [key, item] of Object.entries(value)) {
      inventory(item, counter, `${path}.${safeField(key)}`, depth + 1);
    }
  }
}

function shape(value: unknown, endpoint: unknown): Shape {
  if (!object(value)) {
    return "unknown";
  }
  if (
    endpoint === SEARCH_ENDPOINT &&
    numberEquals(value.statusCode, 93) &&
    Object.hasOwn(value, "result") &&
    value.result === null &&
    value.statusDescription === EMPTY_SEARCH_DESCRIPTION
  ) {
    return "search_empty";
  }
  if (
    endpoint === STATEMENTS_ENDPOINT &&
    (numberEquals(value.statusCode, 26) ||
      numberEquals(value.statusCode, 55)) &&
    (value.result ?? null) === null
  ) {
    return "statement_empty";
  }
  const result = value.result;
  if (!object(result)) {
    return "unknown";
  }
  if ("bankAccounts" in result) {
    return "monthly";
  }
  if (
    Array.isArray(result.months) &&
    result.months.every(
      (month) => object(month) && Array.isArray(month.reportList),
    )
  ) {
    return "statement_catalog";
  }
  if ("transactions" in result || "clearanceRequests" in result) {
    return "recent";
  }
  return "transArr" in result ? "legacy" : "unknown";
}

/** Posted rows share one path prefix, so recent and legacy envelopes compare. */
function normalizedInventory(counter: Counter): Counter {
  const normalized = new Counter();
  for (const [key, count] of counter.entries()) {
    const prefix = ["$.result.transactions[]", "$.result.transArr[]"].find(
      (candidate) => key.startsWith(candidate),
    );
    normalized.add(
      prefix ? `$.postedRows[]${key.slice(prefix.length)}` : key,
      count,
    );
  }
  return normalized;
}

function countRows(value: unknown, rows: Counter): void {
  const result = object(value) ? value.result : null;
  if (!object(result)) {
    return;
  }
  for (const [key, label] of [
    ["transactions", "recent_posted"],
    ["clearanceRequests", "recent_pending"],
    ["transArr", "legacy_posted"],
  ] as const) {
    const list = result[key];
    if (Array.isArray(list)) {
      rows.add(label, list.length);
    }
  }
  const accounts = result.bankAccounts;
  if (!Array.isArray(accounts)) {
    return;
  }
  for (const account of accounts) {
    if (!object(account)) {
      continue;
    }
    const immediate = account.immidiateDebits;
    for (const [days, label] of [
      [account.debitDates ?? [], "monthly_billed"],
      [
        object(immediate) ? (immediate.debitDays ?? []) : [],
        "monthly_immediate",
      ],
    ] as const) {
      if (!Array.isArray(days)) {
        continue;
      }
      for (const day of days) {
        if (object(day) && Array.isArray(day.transactions)) {
          rows.add(label, day.transactions.length);
        }
      }
    }
  }
}

function schemaPath(parts: InstancePath): string {
  return parts
    .map((part) => (typeof part === "number" ? "[]" : `.${safeField(part)}`))
    .reduce((path, part) => path + part, "$");
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function parseOptions(argv: string[]): {
  database: string;
  includeInventory: boolean;
  temporaryRoot: string;
} {
  let database = "";
  let includeInventory = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--db") {
      database = argv[++index] ?? "";
    } else if (argument === "--inventory") {
      includeInventory = true;
    } else {
      throw new UsageError();
    }
  }
  if (!database) {
    throw new UsageError();
  }
  stage = "resolve_archive";
  const path = realpathSync(resolve(database));
  if (inside(path, ROOT) || !statSync(path).isFile()) {
    throw new UsageError();
  }
  // The archive copy holds raw evidence: it stays in temporary storage.
  const temporaryRoot = realpathSync(tmpdir());
  if ([ROOT, dirname(path)].some((root) => inside(temporaryRoot, root))) {
    throw new UsageError();
  }
  return { database: path, includeInventory, temporaryRoot };
}

/** Cleanup state for the failure and signal handlers. */
const resources: { workDirectory: string | null } = { workDirectory: null };

function releaseResources(): boolean {
  const directory = resources.workDirectory;
  if (directory === null) {
    return true;
  }
  try {
    rmSync(directory, { recursive: true, force: true });
    resources.workDirectory = null;
    return true;
  } catch {
    return false;
  }
}

/**
 * SQLite readers of a WAL database write its shared-memory file and may create
 * it beside the archive, so only a private copy is opened.
 */
function openArchiveCopy(path: string, copy: string): DatabaseSync {
  const journal = `${path}-journal`;
  if (existsSync(journal) && statSync(journal).size > 0) {
    throw new ArchiveSidecarError();
  }
  copyFileSync(path, copy, constants.COPYFILE_EXCL);
  chmodSync(copy, 0o600);
  if (existsSync(`${path}-wal`)) {
    copyFileSync(`${path}-wal`, `${copy}-wal`, constants.COPYFILE_EXCL);
    chmodSync(`${copy}-wal`, 0o600);
  }
  const database = new DatabaseSync(`${pathToFileURL(copy).href}?mode=ro`, {
    readOnly: true,
  });
  database.exec("PRAGMA query_only = ON");
  return database;
}

function audit(path: string, includeInventory: boolean, workDirectory: string) {
  stage = "load_schema";
  const schema = parse(
    readFileSync(
      join(ROOT, "tests/providers/cal/schemas/cal-observed.schema.json"),
      "utf8",
    ),
  ) as SourceObject;
  const variant = (definition: string) =>
    compileSchema({
      ...schema,
      properties: {
        ...(schema.properties as SourceObject),
        result: { $ref: `#/$defs/${definition}` },
      },
    });
  loadFieldNames(schema);
  const validators = {
    recent: variant("recentResult"),
    legacy: variant("legacyResult"),
    unknown: compileSchema(schema),
  };
  const baseline = new Counter();
  for (const name of [
    "recent-01.json",
    "recent-02.json",
    "recent-03.json",
    "legacy-history.json",
  ]) {
    inventory(
      parse(
        readFileSync(join(ROOT, "tests/providers/cal/fixtures", name), "utf8"),
      ),
      baseline,
    );
  }
  const counts = new Counter();
  const shapes = new Counter();
  const statuses = new Counter();
  const scopes = new Counter();
  const rows = new Counter();
  const warnings = new Counter();
  const violations = new Counter();
  const observed = new Counter();
  const compared = new Counter();

  stage = "open_archive";
  const copy = join(workDirectory, "archive-copy.sqlite");
  const database = openArchiveCopy(path, copy);
  try {
    stage = "read_runs";
    const runs = database
      .prepare("SELECT status, snapshot_json, warnings_json FROM sync_runs")
      .iterate() as Iterable<{
      status: unknown;
      snapshot_json: unknown;
      warnings_json: unknown;
    }>;
    for (const run of runs) {
      counts.add("runs");
      statuses.add(
        typeof run.status === "string" && RUN_STATUSES.has(run.status)
          ? run.status
          : "unknown",
      );
      let snapshot: SourceObject;
      try {
        const runWarnings = decode(run.warnings_json);
        if (!Array.isArray(runWarnings)) {
          throw new TypeError();
        }
        for (const warning of runWarnings) {
          const code =
            typeof warning === "string" ? warning.split(":", 1)[0]! : "";
          warnings.add(WARNING_CODES.has(code) ? code : "unknown");
        }
        const decoded = decode(run.snapshot_json);
        if (!object(decoded) || !Array.isArray(decoded.responses)) {
          throw new TypeError();
        }
        snapshot = decoded;
      } catch {
        counts.add("invalid_run_metadata");
        continue;
      }
      const failures = Object.hasOwn(snapshot, "failures")
        ? snapshot.failures
        : [];
      if (Array.isArray(failures)) {
        counts.add("collection_failures", failures.length);
      }
      for (const response of snapshot.responses as unknown[]) {
        counts.add("responses");
        try {
          if (!object(response) || typeof response.responseText !== "string") {
            throw new TypeError();
          }
          const value = decode(response.responseText);
          const category = shape(value, response.endpoint);
          shapes.add(category);
          const kind = object(response.scope) ? response.scope.kind : null;
          scopes.add(
            kind === "recent" || kind === "history" ? kind : "unspecified",
          );
          countRows(value, rows);
          inventory(value, observed);
          if (category === "search_empty" || category === "statement_empty") {
            counts.add(`${category}_expected_shape`);
            continue;
          }
          inventory(value, compared);
          if (category === "statement_catalog") {
            counts.add("statement_catalog_schema_unvalidated");
            const months = (value as { result: { months: SourceObject[] } })
              .result.months;
            counts.add(
              "statement_document_occurrences",
              months.reduce(
                (total, month) =>
                  total + (month.reportList as unknown[]).length,
                0,
              ),
            );
            continue;
          }
          if (category === "monthly") {
            counts.add("monthly_schema_unvalidated");
            continue;
          }
          counts.add("schema_checked");
          const errors = validators[category](value);
          for (const error of errors) {
            violations.add(`${error.keyword}|${schemaPath(error.path)}`);
          }
          counts.add(errors.length ? "schema_invalid" : "schema_valid");
        } catch {
          counts.add("invalid_response_json_or_structure");
        }
      }
    }
  } finally {
    database.close();
  }
  stage = "report";
  const normalizedBaseline = normalizedInventory(baseline);
  const unexpected = new Counter();
  for (const [key, count] of normalizedInventory(compared).entries()) {
    if (!normalizedBaseline.has(key)) {
      unexpected.add(key, count);
    }
  }
  counts.add("financial_row_occurrences", rows.total());
  return {
    auditVersion: AUDIT_VERSION,
    counts,
    runStatuses: statuses,
    shapes,
    scopeKinds: scopes,
    sourceRowOccurrences: rows,
    schemaViolations: violations,
    extractionWarningCodes: warnings,
    unexpectedFieldTypesVsFixtures: unexpected,
    fixtureComparisonPathMode: "shared_posted_rows",
    inventoryKeyLimit: MAX_KEYS,
    sourceRowCountsAreNotUniqueTransactions: true,
    monthlySchemaValidated: false,
    ...(includeInventory ? { fieldTypes: observed } : {}),
  };
}

/**
 * One line of JSON with sorted keys, `, ` and `: ` separators and every
 * non-ASCII character escaped, so equal audits print byte-identical,
 * ASCII-only reports.
 */
function report(value: unknown): string {
  if (value instanceof Counter) {
    return report(value.toJSON());
  }
  if (Array.isArray(value)) {
    return `[${value.map(report).join(", ")}]`;
  }
  if (object(value)) {
    return `{${Object.entries(value)
      .sort(byKey)
      .map(([key, item]) => `${report(key)}: ${report(item)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function main(): void {
  if (!launchedSafely()) {
    throw new LaunchError();
  }
  const options = parseOptions(process.argv.slice(2));
  stage = "work_directory";
  const workDirectory = mkdtempSync(
    join(options.temporaryRoot, "fonds-cal-audit-"),
  );
  resources.workDirectory = workDirectory;
  chmodSync(workDirectory, 0o700);
  const text = report(
    audit(options.database, options.includeInventory, workDirectory),
  );
  stage = "cleanup";
  if (!releaseResources()) {
    throw new CleanupError();
  }
  process.stdout.write(`${text}\n`);
}

/** Source values can appear in driver and parser messages: report the stage and type only. */
function fail(error: unknown): never {
  const cleaned = releaseResources();
  process.stderr.write(
    error instanceof LaunchError
      ? "Run as: TSX_DISABLE_CACHE=1 node --no-warnings --import tsx tests/providers/cal/scripts/audit-cal-db.ts --db ARCHIVE.sqlite [--inventory]\n"
      : error instanceof UsageError
        ? "Usage: audit-cal-db.ts --db ARCHIVE.sqlite [--inventory] (an existing archive outside the repository)\n"
        : `CAL audit failed at ${stage} (${errorType(error)}).\n`,
  );
  if (!cleaned) {
    process.stderr.write("CAL audit cleanup failed: remove_work_directory.\n");
  }
  process.exit(1);
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const) {
  process.on(signal, () => {
    releaseResources();
    process.stderr.write(`CAL audit stopped at ${stage} (${signal}).\n`);
    process.exit(code);
  });
}

try {
  main();
} catch (error) {
  fail(error);
}
