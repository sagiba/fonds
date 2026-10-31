/**
 * Read-only, value-free profile of archived Isracard collection runs.
 *
 *   TSX_DISABLE_CACHE=1 node --no-warnings --import tsx \
 *     tests/providers/isracard/scripts/audit-isracard-db.ts \
 *     --out NEW_PROFILE.json [--replay [--keep-replay NEW_TEMPORARY_DIRECTORY]] \
 *     ARCHIVE.sqlite...
 *
 * `TSX_DISABLE_CACHE=1` stops the tsx loader writing its compile cache under
 * the temporary directory before this script can check any destination, and
 * `--no-warnings` stops Node printing warning text; the script refuses to run
 * without both.
 *
 * Archives are never opened by SQLite: each is copied, with its write-ahead
 * log, into a new owner-only directory under the system temporary directory,
 * and the copy opens read-only (`mode=ro` URI plus `query_only`) and is removed
 * once read. The profile file (created owner-only, never overwritten) holds
 * counts, codes from explicit allowlists, field paths built only from field
 * names in the invented fixtures and a fixed list of known fields (other keys are reported
 * by shape), value classes, opaque archive, connection and card aliases and
 * billing months (YYYY-MM). It never holds source values, identifiers, amounts,
 * dates, names, unlisted codes, raw warnings or exception messages; an unlisted
 * code is only counted. Stdout prints totals only, without months. Errors
 * report a static stage label and an allowlisted exception class.
 *
 * `--replay` ingests each archive's captures through the current adapter into
 * its own fresh ledger in that directory, after projecting raw card lists as the
 * provider guide requires. The directory is removed afterwards unless
 * `--keep-replay NEW_TEMPORARY_DIRECTORY` (inside the system temporary
 * directory) names the work directory instead, and only the replay ledgers are
 * kept there. No destination may lie inside the repository
 * or a directory holding an archive.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isLosslessNumber, parse } from "lossless-json";

import { transactionInputSchema } from "../../../../src/domain/model.js";
import type { RunInput } from "../../../../src/domain/plans/sync.js";
import type { CollectionScope } from "../../../../src/domain/records.js";
import type { ExtractionResult } from "../../../../src/domain/source-adapter.js";
import { isracardAdapter } from "../../../../src/providers/isracard/adapter.js";
import {
  ISRACARD_CAPTURE_ENDPOINT,
  type IsracardCapture,
  isracardCaptureSchema,
  isracardCardKey,
  projectIsracardCardList,
  serializeIsracardCapture,
} from "../../../../src/providers/isracard/capture.js";
import {
  extractIsracard,
  isracardPendingSummary,
} from "../../../../src/providers/isracard/extract.js";
import { ISRACARD_ENDPOINTS } from "../../../../src/providers/isracard/transport.js";
import { openDatabase } from "../../../../src/storage/sqlite/database.js";

const ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const PROFILE_VERSION = 1;
const MAX_KEYS = 5000;
const MAX_DEPTH = 32;
const SYNTHETIC_CAPTURE_ENDPOINT = "synthetic:isracard/card-month";

type SourceRow = Record<string, unknown>;

/** Bounded counts whose keys are composed only of allowlisted or normalized parts. */
class Counter {
  readonly #counts = new Map<string, number>();

  add(key: string, by = 1): void {
    const target =
      this.#counts.has(key) || this.#counts.size < MAX_KEYS
        ? key
        : "<overflow>";
    this.#counts.set(target, (this.#counts.get(target) ?? 0) + by);
  }

  get(key: string): number {
    return this.#counts.get(key) ?? 0;
  }

  total(): number {
    let sum = 0;
    for (const count of this.#counts.values()) {
      sum += count;
    }
    return sum;
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(
      [...this.#counts].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  }
}

/** Counter maps keyed by fixed check or source names. */
class Groups {
  readonly #groups = new Map<string, Counter>();

  add(group: string, key: string, by = 1): void {
    let counter = this.#groups.get(group);
    if (!counter) {
      counter = new Counter();
      this.#groups.set(group, counter);
    }
    counter.add(key, by);
  }

  get(group: string): Counter | undefined {
    return this.#groups.get(group);
  }

  toJSON(): Record<string, Counter> {
    return Object.fromEntries(
      [...this.#groups].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  }
}

const ISO_CURRENCIES = [
  "AED",
  "ARS",
  "AUD",
  "BGN",
  "BRL",
  "CAD",
  "CHF",
  "CNY",
  "CZK",
  "DKK",
  "EGP",
  "EUR",
  "GBP",
  "HKD",
  "HUF",
  "ILS",
  "INR",
  "JOD",
  "JPY",
  "KRW",
  "MXN",
  "NOK",
  "NZD",
  "PLN",
  "RON",
  "RUB",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "UAH",
  "USD",
  "ZAR",
];
const LEGACY_CURRENCIES = [...ISO_CURRENCIES, "NIS", "₪", 'ש"ח', "ש״ח", "דולר"];

/** Explicit code allowlists; any other value is only counted as unlisted. */
const CODE_ALLOWLISTS: Record<string, readonly string[]> = {
  "cardList.companyCode": ["11", "77"],
  "detail.currencyId": LEGACY_CURRENCIES,
  "detail.currencyIdForCharge": LEGACY_CURRENCIES,
  "detail.currencyIdOutbound": LEGACY_CURRENCIES,
  "detail.table1.currencyId": LEGACY_CURRENCIES,
  "digital.billingAmountCurrency": ["0", "19", "100"],
  "digital.billingAmountCurrencySymbol": ["ILS", "USD", "₪", "$"],
  "digital.originalCurrency": ["0", "19"],
  "digital.originalCurrencyIso": ISO_CURRENCIES,
  "digital.transactionCode": ["1", "3", "7", "8", "10", "12", "20", "23"],
  "digital.tranzacCodeType": ["H", "R", "T", "U", "V"],
  "envelope.companyCode": ["11", "77"],
  "envelope.mode": ["history", "recent"],
  "legacy.currencyId": LEGACY_CURRENCIES,
  "legacy.currentPaymentCurrency": LEGACY_CURRENCIES,
  "legacy.dealSumType": ["0", "1"],
  "legacy.paymentSumSign": ["+", "-"],
};

/** Zod's fixed issue codes; a schema message is never reported. */
const ZOD_ISSUE_CODES = new Set<string>([
  "custom",
  "invalid_element",
  "invalid_format",
  "invalid_key",
  "invalid_type",
  "invalid_union",
  "invalid_value",
  "not_multiple_of",
  "too_big",
  "too_small",
  "unrecognized_keys",
]);
const RUN_STATUSES = ["started", "completed", "partial", "failed"];
const FAILURE_CODES = [
  "network_error",
  "authentication_failed",
  "authentication_challenge",
  "rate_limited",
  "budget_exhausted",
  "invalid_response",
];
const WARNING_CODES = new Set([
  ...FAILURE_CODES,
  "ambiguous_posted_identity",
  "digital_immediate_total_mismatch",
  "digital_statement_total_mismatch",
  "implausible_empty",
  "incomplete_posted_partition",
  "invalid_card_or_scope_binding",
  "invalid_digital_response",
  "invalid_digital_row",
  "invalid_digital_row_partition",
  "invalid_extracted_pending_row",
  "invalid_extracted_posted_row",
  "invalid_isracard_capture",
  "invalid_legacy_card_partition",
  "invalid_legacy_response",
  "legacy_card_binding_missing",
  "legacy_card_binding_missing_or_ambiguous",
  "legacy_statement_artifacts_preserved_raw",
  "legacy_total_mismatch",
  "missing_required_digital_response",
  "missing_required_legacy_response",
  "numeric_equivalent_voucher_mismatch",
  "unexpected_http_status",
  "unsupported_approvals_preserved_raw",
  "unsupported_current_transactions_preserved_raw",
  "unsupported_digital_empty_shape",
  "unsupported_pending_summary",
]);
/** Extractor issues plus the planner's identity, plan and payment-context issues. */
const ISSUE_CODES = new Set([
  "ambiguous_identity",
  "ambiguous_source_identity",
  "ambiguous_transaction_detail",
  "conflicting_generation_billing_amount",
  "conflicting_installment_facts",
  "conflicting_installment_plan",
  "conflicting_installment_total",
  "conflicting_original_amount",
  "conflicting_payment_context",
  "duplicate_installment_ordinal",
  "incomplete_source_identity",
  "informational_statement_row",
  "invalid_installment_ordinal",
  "invalid_installment_plan_voucher",
  "invalid_source_date",
  "invalid_source_time",
  "invalid_transaction_detail",
  "isracard_unverified_semantics",
  "possible_duplicate_plan",
  "possible_pending_posted_match",
  "review_stale",
  "source_derived_amount_direction",
  "unresolved_amount",
  "unresolved_billing_amount",
  "unresolved_companion_billing_amount",
  "unresolved_original_amount",
  "unresolved_purchase",
  "unsupported_amount_direction",
  "unsupported_transaction_type",
  "unverified_amount_basis",
  "unverified_converted_installments",
  "unverified_installment_amount_basis",
  "unverified_legacy_source_role",
  "user_needs_review",
]);
const KNOWN_TABLES = new Set([
  "accounts",
  "annotations",
  "cards",
  "collection_leases",
  "connections",
  "event_subscriptions",
  "events",
  "provider_credentials",
  "refresh_windows",
  "refreshes",
  "scheduled_collections",
  "settings",
  "sqlite_sequence",
  "sync_runs",
  "sync_run_bodies",
  "sync_run_history",
  "deferred_evidence",
  "transaction_observations",
  "transaction_reconciliation",
  "transaction_posting_links",
  "transactions",
]);
const RUN_COLUMNS = [
  "id",
  "connection_id",
  "started_at",
  "completed_at",
  "status",
  "collector_version",
  "parser_version",
  "snapshot_json",
  "metadata_json",
  "evidence_digest",
  "coverage_json",
  "warnings_json",
  "applied_at",
  "refresh_id",
];
const ENDPOINT_CLASSES = new Map<string, string>([
  [ISRACARD_CAPTURE_ENDPOINT, "capture"],
  [SYNTHETIC_CAPTURE_ENDPOINT, "synthetic_capture"],
  ...Object.entries(ISRACARD_ENDPOINTS).map(
    ([name, url]) => [url, name] as [string, string],
  ),
]);
/** Exact parser and collector versions this repository has used for Isracard. */
const KNOWN_VERSIONS = new Set([
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map(
    (version) => `isracard-v${version}`,
  ),
  "isracard-web-v1",
  "isracard-web-v2",
  "isracard-web-v3",
  "offline-v1",
]);
const KNOWN_USER_VERSIONS = new Set([0, 1, 2, 3, 4]);
const ERROR_TYPES = new Set([
  "$ZodError",
  "ArchiveSidecarError",
  "CleanupError",
  "Error",
  "LibsqlError",
  "RangeError",
  "SqliteError",
  "SyntaxError",
  "TypeError",
  "UsageError",
  "ZodError",
]);
const PROJECTED_CARD_FIELDS = new Set([
  "billingAccount",
  "cardGuid",
  "cardName",
  "cardSuffix",
  "companyCode",
]);

let stage = "arguments";
const errors = new Counter();

/**
 * Process warnings can carry dependency or driver text. `--no-warnings` stops
 * Node printing them from process start, before any import, so the audit
 * requires it; any listener left is replaced by a value-free count.
 */
const WARNING_TYPES = new Set([
  "DeprecationWarning",
  "ExperimentalWarning",
  "MaxListenersExceededWarning",
  "TimeoutOverflowWarning",
  "Warning",
]);
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  errors.add(
    `runtime_warning|${WARNING_TYPES.has(warning.name) ? warning.name : "<other-warning>"}`,
  );
});

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

/** A fixed error category: an allowlisted class name, never a message. */
function errorType(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : "";
  return ERROR_TYPES.has(name) ? name : "<other-error>";
}

/** Run one record's work; a failure is counted by static stage and type only. */
function attempt<T>(label: string, work: () => T, fallback: T): T {
  try {
    return work();
  } catch (error) {
    errors.add(`${label}|${errorType(error)}`);
    return fallback;
  }
}

async function attemptAsync<T>(
  label: string,
  work: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    errors.add(`${label}|${errorType(error)}`);
    return fallback;
  }
}

function digest(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

function object(value: unknown): value is SourceRow {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isLosslessNumber(value)
  );
}

function token(value: unknown): string | null {
  if (isLosslessNumber(value)) {
    return value.value;
  }
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decode(text: string | undefined): unknown {
  if (text === undefined) {
    return undefined;
  }
  try {
    return parse(text);
  } catch {
    return undefined;
  }
}

const CARD = "$.data.cardsList[]";
const LEGACY_ROWS = ["txnIsrael", "txnAbroad", "txnInfo"].map(
  (field) =>
    `$.CardsTransactionsListBean.Index<n>.CurrentCardTransactions[].${field}[]`,
);

/** Known fields at a fixed place, which fixtures may omit. */
const DOCUMENTED_FIELDS: [string, string[]][] = [
  [
    CARD,
    [
      "accountNumber",
      "bank",
      "billingAccount",
      "branch",
      "cardChargeLast",
      "cardChargeNext",
      "limitData",
    ],
  ],
  [`${CARD}.billingAccount`, ["mask", "providerKey"]],
  [`${CARD}.cardChargeNext`, ["billingDate"]],
  [`${CARD}.cardChargeLast`, ["billingDate"]],
  ...LEGACY_ROWS.map(
    (path) =>
      [
        path,
        [
          "currentId",
          "displayProperties",
          "holderId",
          "holderName",
          "selectedCardInfo",
          "userId",
        ],
      ] as [string, string[]],
  ),
  ["$.PirteyIska_204Bean", ["Table1"]],
];

function pathKey(parent: string, key: string): string {
  return `${parent}\u0000${key}`;
}

/** A key normalized only when it is an index or the holder-identity key. */
function indexedKey(key: string): string | null {
  return /^Index\d{1,4}$/.test(key)
    ? "Index<n>"
    : /^id\d+$/.test(key)
      ? "id<n>"
      : null;
}

/**
 * Every (parent path, field) pair in the invented fixtures, with paths
 * normalized as profiles are. Each response string starts its own `$` root.
 */
function fixtureFieldPaths(): Set<string> {
  const pairs = new Set<string>(
    DOCUMENTED_FIELDS.flatMap(([parent, fields]) =>
      fields.map((field) => pathKey(parent, field)),
    ),
  );
  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      return;
    }
    if (typeof value === "string" && /^\s*[[{]/.test(value)) {
      try {
        visit(JSON.parse(value), "$", depth + 1);
      } catch {
        // Not JSON text: an ordinary invented string.
      }
    } else if (Array.isArray(value)) {
      value.forEach((item) => visit(item, `${path}[]`, depth + 1));
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        const normalized = indexedKey(key) ?? key;
        pairs.add(pathKey(path, normalized));
        visit(item, `${path}.${normalized}`, depth + 1);
      }
    }
  };
  const directory = join(ROOT, "tests/providers/isracard/fixtures");
  for (const name of readdirSync(directory)) {
    if (name.endsWith(".json")) {
      visit(JSON.parse(readFileSync(join(directory, name), "utf8")), "$", 0);
    }
  }
  return pairs;
}

const KNOWN_FIELD_PATHS = fixtureFieldPaths();
const unlistedKeys = new Map<string, Set<string>>();

/** A Zod issue as its fixed code and contextually normalized path; never its message. */
function issueLabel(issue: {
  code: string;
  path: readonly PropertyKey[];
}): string {
  const path = issue.path.reduce<string>(
    (parent, part) =>
      typeof part === "number"
        ? `${parent}[]`
        : `${parent}.${safeKey(String(part), parent)}`,
    "$",
  );
  return `${ZOD_ISSUE_CODES.has(issue.code) ? issue.code : "<other>"}|${path}`;
}

/** A key's shape only, so an unlisted name is never reported. */
function keyShape(key: string): string {
  return /^[a-z][A-Za-z]*$/.test(key)
    ? "lower-camel"
    : /^[A-Z][A-Za-z]*$/.test(key)
      ? "upper-camel"
      : /^[\x21-\x7e]+$/.test(key)
        ? /\d/.test(key)
          ? "ascii-with-digits"
          : "ascii-other"
        : "non-ascii-or-space";
}

/**
 * A field name survives only where the invented fixtures or the known fields
 * place it, under the same normalized parent path; a known name inside an
 * unknown or dynamic container does not. Indexes and the `id<number>` holder
 * key normalize; every other key is reported by shape, and its distinct names
 * are only counted per parent path.
 */
function safeKey(key: string, parent: string): string {
  const indexed = indexedKey(key);
  if (indexed !== null) {
    return indexed;
  }
  if (KNOWN_FIELD_PATHS.has(pathKey(parent, key))) {
    return key;
  }
  const names = unlistedKeys.get(parent) ?? new Set<string>();
  names.add(key);
  unlistedKeys.set(parent, names);
  return `<unlisted-key:${keyShape(key)}>`;
}

function stringClass(value: string): string {
  if (value === "") {
    return "string-empty";
  }
  if (/^\s+$/.test(value)) {
    return "string-blank";
  }
  const trimmed = value.trim();
  const padded = trimmed === value ? "" : "-padded";
  if (/^\d+$/.test(trimmed)) {
    return `string-digits-${trimmed.length > 24 ? "long" : trimmed.length}${padded}`;
  }
  const patterns: [RegExp, string][] = [
    [/^[+-]?\d+\.\d+$/, "string-decimal"],
    [/^[+-]\d+$/, "string-signed-integer"],
    [/^\d{2}\/\d{2}\/\d{4}$/, "string-date-dd/mm/yyyy"],
    [/^\d{4}-\d{2}-\d{2}$/, "string-date-iso"],
    [/^\d{4}-\d{2}-\d{2}T/, "string-datetime-iso"],
    [/^\d{2}:\d{2}:\d{2}$/, "string-time-hh:mm:ss"],
    [/^\d{2}:\d{2}$/, "string-time-hh:mm"],
    [/^(?:true|false)$/i, "string-boolean"],
    [/^[+-]$/, "string-sign"],
    [/[֐-׿]/, "string-text-hebrew"],
    [/\d/, "string-text-with-digits"],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(trimmed)) {
      return `${label}${padded}`;
    }
  }
  return `string-text${padded}`;
}

function valueClass(value: unknown): string {
  if (value === undefined) {
    return "absent";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (isLosslessNumber(value)) {
    return /^-?\d+$/.test(value.value)
      ? "number-integer"
      : /^-?\d+\.\d+$/.test(value.value)
        ? "number-decimal"
        : "number-other";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "number-integer" : "number-decimal";
  }
  if (typeof value === "string") {
    return stringClass(value);
  }
  if (Array.isArray(value)) {
    return value.length ? "array" : "array-empty";
  }
  return "object";
}

/** Record each normalized path with its value class. */
function inventory(
  value: unknown,
  counter: Counter,
  path = "$",
  depth = 0,
): void {
  counter.add(`${path}|${valueClass(value)}`);
  if (depth >= MAX_DEPTH) {
    counter.add("<depth-limit>");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      inventory(item, counter, `${path}[]`, depth + 1);
    }
  } else if (object(value)) {
    for (const [key, item] of Object.entries(value)) {
      inventory(item, counter, `${path}.${safeKey(key, path)}`, depth + 1);
    }
  }
}

const codes = new Groups();
const unlistedCodes = new Map<string, Set<string>>();

/** An allowlisted code, or a fixed placeholder; unlisted values stay in memory only. */
function codeLabel(field: string, value: unknown, track = true): string {
  if (value === undefined) {
    return "<absent>";
  }
  if (value === null) {
    return "<null>";
  }
  if (typeof value === "boolean") {
    return value ? "<true>" : "<false>";
  }
  if (!isLosslessNumber(value) && typeof value !== "string") {
    return "<non-scalar>";
  }
  const lexeme = isLosslessNumber(value) ? value.value : value;
  if (CODE_ALLOWLISTS[field]?.includes(lexeme)) {
    return lexeme;
  }
  if (track) {
    const values = unlistedCodes.get(field) ?? new Set<string>();
    values.add(lexeme);
    unlistedCodes.set(field, values);
  }
  return /^\d{1,2}$/.test(lexeme) ? "<unlisted-small-integer>" : "<unlisted>";
}

function recordCode(field: string, value: unknown): string {
  const label = codeLabel(field, value);
  codes.add(field, label);
  return label;
}

interface Decimal {
  units: bigint;
  scale: number;
}

/** Exact decimal lexemes only; no floating-point conversion. */
function decimal(value: unknown): Decimal | null {
  const lexeme = isLosslessNumber(value)
    ? value.value
    : typeof value === "string"
      ? value.trim()
      : null;
  // JSON number grammar, with bounded digits and exponent so allocation stays small.
  const match = lexeme?.match(
    /^([+-]?)(\d{1,30})(?:\.(\d{1,30}))?(?:[eE]([+-]?\d{1,2}))?$/,
  );
  if (!match) {
    return null;
  }
  const fraction = match[3] ?? "";
  let units = BigInt(`${match[2]}${fraction}`);
  let scale = fraction.length - Number(match[4] ?? "0");
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { units: match[1] === "-" ? -units : units, scale };
}

function aligned(...values: Decimal[]): bigint[] {
  const scale = Math.max(...values.map((value) => value.scale));
  return values.map(
    (value) => value.units * 10n ** BigInt(scale - value.scale),
  );
}

function amountClass(value: unknown): string {
  if (value === undefined) {
    return "absent";
  }
  if (value === null) {
    return "null";
  }
  const parsed = decimal(value);
  if (!parsed) {
    return "unparseable";
  }
  return parsed.units < 0n
    ? "negative"
    : parsed.units === 0n
      ? "zero"
      : "positive";
}

/**
 * Exact comparison; a missing operand is labelled by its own name. Callers pass
 * operands in the order the check's name gives them.
 */
function compareAmounts(
  leftName: string,
  left: unknown,
  rightName: string,
  right: unknown,
): string {
  const a = decimal(left);
  const b = decimal(right);
  if (!a || !b) {
    return `${leftName}-${a ? "present" : amountClass(left)}~${rightName}-${b ? "present" : amountClass(right)}`;
  }
  const [x, y] = aligned(a, b) as [bigint, bigint];
  return x === y ? "equal" : x === -y ? "negated" : "different";
}

function booleanClass(value: unknown): string {
  if (value === undefined) {
    return "absent";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string" && /^(?:true|false)$/i.test(value)) {
    return `string-${value.toLowerCase()}`;
  }
  return "other";
}

function sourceInteger(value: unknown): number | null | "malformed" {
  if (value === null || value === undefined) {
    return null;
  }
  const lexeme = token(value);
  if (lexeme === null || !/^\d{1,6}$/.test(lexeme)) {
    return "malformed";
  }
  return Number(lexeme);
}

function installmentClass(row: SourceRow): string {
  const count = sourceInteger(row.numberOfInstallment);
  const ordinal = sourceInteger(row.currentInstallmentNum);
  if (count === "malformed" || ordinal === "malformed") {
    return "malformed";
  }
  if (count === null && ordinal === null) {
    return "none";
  }
  if (count !== null && ordinal !== null && ordinal > count) {
    return "ordinal-exceeds-count";
  }
  if (count !== null && count > 1) {
    return ordinal === null ? "plan-without-ordinal" : "plan";
  }
  if (ordinal !== null && ordinal > 1) {
    return "ordinal-without-plan-count";
  }
  return "single";
}

function digitalBillingCurrency(row: SourceRow): string | null {
  const code = token(row.billingAmountCurrency);
  return code === "0"
    ? "ILS"
    : code === "19"
      ? "USD"
      : code === "100"
        ? "EUR"
        : null;
}

function legacyCurrency(value: unknown): string | null {
  const lexeme = token(value);
  if (
    lexeme === "NIS" ||
    lexeme === "₪" ||
    lexeme === 'ש"ח' ||
    lexeme === "ש״ח"
  ) {
    return "ILS";
  }
  if (lexeme === "דולר") {
    return "USD";
  }
  return lexeme && ISO_CURRENCIES.includes(lexeme) ? lexeme : null;
}

function legacyInstallmentText(row: SourceRow): boolean {
  return typeof row.moreInfo === "string" && row.moreInfo.includes("תשלום");
}

interface ContainedRow {
  container: string;
  row: SourceRow;
}

function digitalData(value: unknown): SourceRow | null {
  return object(value) && value.isSuccess === true && object(value.data)
    ? value.data
    : null;
}

function legacyBean(value: unknown, bean: string): SourceRow | null {
  return object(value) &&
    object(value.Header) &&
    token(value.Header.Status) === "1" &&
    object(value[bean])
    ? value[bean]
    : null;
}

interface SourceRows {
  rows: ContainedRow[];
  /** False when any partition or row breaks the extractor's acceptance rules. */
  valid: boolean;
  shape: string;
}

/** Appends a partition's rows; a non-array partition or non-object row is invalid. */
function rowsOf(value: unknown, container: string, into: SourceRows): void {
  if (!Array.isArray(value)) {
    into.valid = false;
    return;
  }
  for (const row of value) {
    if (object(row)) {
      into.rows.push({ container, row });
    } else {
      into.valid = false;
    }
  }
}

/** DigitalV3 rows by container, following the extractor's acceptance rules. */
function digitalRows(data: SourceRow): SourceRows {
  const result: SourceRows = { rows: [], valid: true, shape: "vouchers" };
  if (data.israelAbroadVouchers === null) {
    const keys = Object.keys(data).sort().join();
    const accepted =
      keys === "approvals,currentTransactionsList,israelAbroadVouchers" &&
      data.approvals === null &&
      (data.currentTransactionsList === null ||
        isracardPendingSummary(data.currentTransactionsList));
    return {
      rows: [],
      valid: accepted,
      shape: accepted ? "accepted-empty" : "unsupported-null-vouchers",
    };
  }
  const base = data.israelAbroadVouchers;
  if (!object(base)) {
    return { rows: [], valid: false, shape: "invalid-vouchers" };
  }
  if (
    data.currentTransactionsList !== null &&
    data.currentTransactionsList !== undefined &&
    !isracardPendingSummary(data.currentTransactionsList)
  ) {
    result.valid = false;
  }
  if (object(base.vouchers)) {
    rowsOf(
      base.vouchers.israelAbroadVouchersList,
      "israelAbroadVouchersList",
      result,
    );
    if (base.vouchers.informativeOnlyVouchers !== undefined) {
      rowsOf(
        base.vouchers.informativeOnlyVouchers,
        "informativeOnlyVouchers",
        result,
      );
    }
  } else {
    result.valid = false;
    result.shape = "missing-vouchers";
  }
  if (Array.isArray(base.outOfStatementChargeDateVouchers)) {
    for (const group of base.outOfStatementChargeDateVouchers) {
      if (object(group)) {
        rowsOf(
          group.immediateVouchersCurrencyDate,
          "outOfStatementChargeDateVouchers",
          result,
        );
      } else {
        result.valid = false;
      }
    }
  } else {
    result.valid = false;
  }
  return result;
}

const LEGACY_PARTITIONS = ["txnIsrael", "txnAbroad", "txnInfo"];

/** One legacy card index's rows, following the extractor's acceptance rules. */
function legacyIndexRows(entry: unknown): SourceRows {
  const result: SourceRows = { rows: [], valid: true, shape: "index" };
  if (!object(entry) || !Array.isArray(entry.CurrentCardTransactions)) {
    return { rows: [], valid: false, shape: "invalid-index" };
  }
  for (const group of entry.CurrentCardTransactions) {
    if (!object(group)) {
      result.valid = false;
      continue;
    }
    if (
      !LEGACY_PARTITIONS.some((field) => group[field] !== undefined) ||
      Object.keys(group).some(
        (key) =>
          key !== "@cardTransactions" && !LEGACY_PARTITIONS.includes(key),
      )
    ) {
      result.valid = false;
    }
    for (const field of LEGACY_PARTITIONS) {
      if (group[field] !== undefined && group[field] !== null) {
        rowsOf(group[field], field, result);
      }
    }
  }
  return result;
}

/** The extractor's legacy binding: a company-11 card whose suffix is unique in the list. */
function legacyBound(bean: SourceRow, capture: IsracardCapture): boolean {
  const list = Array.isArray(bean.cardNumberList) ? bean.cardNumberList : null;
  if (capture.legacyCardIndex === undefined || !list) {
    return false;
  }
  return (
    capture.card.companyCode === "11" &&
    suffixOf(list[Number(capture.legacyCardIndex)]) ===
      capture.card.cardSuffix &&
    list.filter((entry) => suffixOf(entry) === capture.card.cardSuffix)
      .length === 1
  );
}

function legacyArtifact(container: string, row: SourceRow): boolean {
  const voucher =
    container === "txnAbroad"
      ? row.voucherNumberRatzOutbound
      : row.voucherNumberRatz;
  return token(row.dealSumType) === "1" || /^0+$/.test(token(voucher) ?? "");
}

function suffixOf(entry: unknown): string | null {
  return typeof entry === "string"
    ? (entry.trim().match(/(\d{4})$/)?.[1] ?? null)
    : null;
}

// ---------------------------------------------------------------------------
// Profile state

interface CoverageSource {
  outcomes: Counter;
  maxRows: number;
  rowsByContainer: Counter;
  distinctResponses: Set<string>;
}

interface CardInfo {
  alias: string;
  /** Opaque archive and connection aliases: cards never merge across them. */
  archive: string;
  connection: string;
  companyCode: string;
  legacyOnly: boolean;
  months: Map<string, Map<string, CoverageSource>>;
  cardListPresence: Counter;
}

const cards = new Map<string, CardInfo>();
const legacyMonthFailures = new Map<string, Counter>();

/** Archive and connection aliases that scope card identity and deduplication. */
interface Namespace {
  archive: string;
  connection: string;
}

function scoped(namespace: Namespace, key: string): string {
  return JSON.stringify([namespace.archive, namespace.connection, key]);
}

function cardFor(
  namespace: Namespace,
  key: string,
  companyCode: string,
  legacyOnly = false,
): CardInfo {
  let card = cards.get(scoped(namespace, key));
  if (!card) {
    const count = [...cards.values()].filter(
      (item) => item.legacyOnly === legacyOnly,
    ).length;
    card = {
      alias: `${legacyOnly ? "legacy-card" : "card"}-${count + 1}`,
      archive: namespace.archive,
      connection: namespace.connection,
      companyCode,
      legacyOnly,
      months: new Map(),
      cardListPresence: new Counter(),
    };
    cards.set(scoped(namespace, key), card);
  }
  return card;
}

function cell(card: CardInfo, month: string, source: string): CoverageSource {
  let months = card.months.get(month);
  if (!months) {
    months = new Map();
    card.months.set(month, months);
  }
  let entry = months.get(source);
  if (!entry) {
    entry = {
      outcomes: new Counter(),
      maxRows: 0,
      rowsByContainer: new Counter(),
      distinctResponses: new Set(),
    };
    months.set(source, entry);
  }
  return entry;
}

function recordRows(
  entry: CoverageSource,
  rows: ContainedRow[],
  hash: string,
): void {
  entry.maxRows = Math.max(entry.maxRows, rows.length);
  if (!entry.distinctResponses.has(hash)) {
    entry.distinctResponses.add(hash);
    for (const { container } of rows) {
      entry.rowsByContainer.add(container);
    }
  }
}

const fieldProfiles = new Groups();
const profiled = new Set<string>();
const relationships = new Groups();
const seenRows = new Set<string>();
const generations = new Counter();
const inventoryCounts = new Counter();
const envelopeIssues = new Counter();
const extraction = {
  captures: new Counter(),
  warnings: new Counter(),
  partitions: new Counter(),
  transactions: new Counter(),
  issues: new Counter(),
  fields: new Groups(),
  invalidRows: new Counter(),
};
const seenExtractions = new Set<string>();
const seenTransactions = new Set<string>();

/** Profile each distinct source text once per generation. */
function profileOnce(generation: string, text: string, value: unknown): void {
  const hash = digest(generation, text);
  inventoryCounts.add(`${generation}|occurrences`);
  if (profiled.has(hash)) {
    return;
  }
  profiled.add(hash);
  inventoryCounts.add(`${generation}|distinct`);
  const counter = new Counter();
  inventory(value, counter);
  for (const [key, count] of Object.entries(counter.toJSON())) {
    fieldProfiles.add(generation, key, count);
  }
}

/** An injective, type-tagged encoding: a number and a string never collide. */
function canonical(value: unknown): unknown {
  if (isLosslessNumber(value)) {
    return ["n", value.value];
  }
  if (typeof value === "number") {
    return ["n", String(value)];
  }
  if (typeof value === "string") {
    return ["s", value];
  }
  if (typeof value === "boolean") {
    return ["b", value];
  }
  if (value === null || value === undefined) {
    return [value === null ? "z" : "u"];
  }
  if (Array.isArray(value)) {
    return ["a", value.map(canonical)];
  }
  return [
    "o",
    Object.entries(value as SourceRow).map(([key, item]) => [
      key,
      canonical(item),
    ]),
  ];
}

function firstTime(scope: string, row: unknown): boolean {
  const hash = digest(scope, JSON.stringify(canonical(row)));
  if (seenRows.has(hash)) {
    return false;
  }
  seenRows.add(hash);
  return true;
}

function relate(check: string, outcome: string): void {
  relationships.add(check, outcome);
}

/** Whether original money differs from billing money, exactly. */
function deltaClass(billing: Decimal | null, original: Decimal | null): string {
  if (!billing || !original) {
    return "amount-missing";
  }
  const [b, o] = aligned(billing, original) as [bigint, bigint];
  return o === b ? "no-delta" : "delta";
}

function profileDigitalRow({ container, row }: ContainedRow): void {
  const code = recordCode("digital.transactionCode", row.transactionCode);
  const codeType = recordCode("digital.tranzacCodeType", row.tranzacCodeType);
  recordCode("digital.billingAmountCurrency", row.billingAmountCurrency);
  recordCode(
    "digital.billingAmountCurrencySymbol",
    row.billingAmountCurrencySymbol,
  );
  recordCode("digital.originalCurrency", row.originalCurrency);
  const originalIso = recordCode(
    "digital.originalCurrencyIso",
    row.originalCurrencyIso,
  );
  const sign = amountClass(row.billingAmount);
  const installment = installmentClass(row);
  relate("digital.billingSignByTransactionCode", `${code}|${sign}`);
  relate("digital.billingSignByContainer", `${container}|${sign}`);
  relate("digital.codeTypeByTransactionCode", `${code}|${codeType}`);
  relate(
    "digital.originalSignVsBillingSign",
    `original-${amountClass(row.originalAmount)}|billing-${sign}`,
  );
  relate("digital.installmentFields", installment);
  relate("digital.installmentByTransactionCode", `${code}|${installment}`);
  relate(
    "digital.directDebitByTransactionCode",
    `${code}|${booleanClass(row.isdirectDebit)}`,
  );
  relate(
    "digital.israelDealByBillingCurrency",
    `${codeLabel("digital.billingAmountCurrency", row.billingAmountCurrency, false)}|${booleanClass(row.isIsraelDeal)}`,
  );
  const billingCurrency = digitalBillingCurrency(row);
  const domestic =
    row.isIsraelDeal === true
      ? "domestic"
      : row.isIsraelDeal === false
        ? "foreign"
        : "deal-flag-unknown";
  if (billingCurrency === "ILS") {
    relate(
      "digital.ilsAmountVsBillingAmount",
      `${domestic}|${compareAmounts("ils", row.ilsAmount, "billing", row.billingAmount)}`,
    );
    relate(
      "digital.usdAmountPresenceOnIlsBill",
      `${domestic}|${amountClass(row.usdAmount)}`,
    );
  } else if (billingCurrency === "USD") {
    relate(
      "digital.usdAmountVsBillingAmount",
      compareAmounts("usd", row.usdAmount, "billing", row.billingAmount),
    );
    relate("digital.ilsAmountPresenceOnUsdBill", amountClass(row.ilsAmount));
  }
  const sameCurrency =
    billingCurrency !== null && originalIso === billingCurrency;
  relate(
    "digital.originalCurrencyVsBillingCurrency",
    billingCurrency === null
      ? "billing-unlisted"
      : originalIso.startsWith("<")
        ? `original-${originalIso.slice(1, -1)}`
        : sameCurrency
          ? "same"
          : "different",
  );
  const discount = amountClass(row.discountAmount);
  relate(
    "digital.discountAmountByIndication",
    `${discount}|${booleanClass(row.discountIndication)}`,
  );
  if (sameCurrency) {
    relate(
      "digital.originalVsBillingSameCurrency",
      `${installment}|discount-${discount}|${compareAmounts("original", row.originalAmount, "billing", row.billingAmount)}`,
    );
  }
  const billing = decimal(row.billingAmount);
  const original = decimal(row.originalAmount);
  const discountAmount = decimal(row.discountAmount);
  // Every same-currency row is classified, a zero discount included, so a
  // delta without a stated discount still shows up as a disagreement.
  if (sameCurrency) {
    if (!discountAmount) {
      relate(
        "digital.discountVsOriginalMinusBilling",
        `discount-${discount}|${deltaClass(billing, original)}`,
      );
    } else if (billing && original) {
      const [b, o, d] = aligned(billing, original, discountAmount) as [
        bigint,
        bigint,
        bigint,
      ];
      relate(
        "digital.discountVsOriginalMinusBilling",
        `discount-${d === 0n ? "zero" : "nonzero"}|${o - b === d ? "agree" : o - b === -d ? "agree-negated" : "disagree"}`,
      );
    } else {
      relate(
        "digital.discountVsOriginalMinusBilling",
        `discount-${discountAmount.units === 0n ? "zero" : "nonzero"}|amount-missing`,
      );
    }
  }
  if (installment === "plan" || installment === "plan-without-ordinal") {
    const count = sourceInteger(row.numberOfInstallment) as number;
    const ordinal = sourceInteger(row.currentInstallmentNum);
    relate(
      "digital.isLastInstallmentVsOrdinal",
      `${booleanClass(row.isLastInstallment)}|${ordinal === null ? "no-ordinal" : ordinal === count ? "final" : "not-final"}`,
    );
    if (sameCurrency && billing && original) {
      const [b, o] = aligned(billing, original) as [bigint, bigint];
      relate(
        "digital.installmentOriginalVsBilling",
        o === b
          ? "equal"
          : o === b * BigInt(count)
            ? "billing-times-count"
            : "other",
      );
    }
  }
}

function profileLegacyRow({ container, row }: ContainedRow): void {
  const foreign = container === "txnAbroad";
  const payment = foreign ? row.paymentSumOutbound : row.paymentSum;
  const other = foreign ? row.paymentSum : row.paymentSumOutbound;
  const deal = foreign ? row.dealSumOutbound : row.dealSum;
  const artifact = legacyArtifact(container, row) ? "artifact" : "row";
  const signCode = recordCode("legacy.paymentSumSign", row.paymentSumSign);
  recordCode("legacy.dealSumType", row.dealSumType);
  const billingCurrency = recordCode("legacy.currencyId", row.currencyId);
  const originalCurrency = recordCode(
    "legacy.currentPaymentCurrency",
    row.currentPaymentCurrency,
  );
  relate(
    "legacy.paymentSignByContainer",
    `${container}|${artifact}|${amountClass(payment)}|sign-${signCode}`,
  );
  relate(
    "legacy.otherGenerationAmountPresence",
    `${container}|${amountClass(other)}`,
  );
  const sameCurrency =
    legacyCurrency(row.currencyId) !== null &&
    legacyCurrency(row.currencyId) ===
      legacyCurrency(row.currentPaymentCurrency);
  relate(
    "legacy.dealSumVsPaymentSum",
    `${container}|${artifact}|${sameCurrency ? "same-currency" : `currency-${billingCurrency}~${originalCurrency}`}|${legacyInstallmentText(row) ? "payment-text" : "no-payment-text"}|${compareAmounts("deal", deal, "payment", payment)}`,
  );
  relate(
    "legacy.recurringFlagByContainer",
    `${container}|${booleanClass(row.isHoraatKeva)}`,
  );
}

/** Whether two resolved currencies agree; unresolved units are never assumed equal. */
function unitRelation(left: string | null, right: string | null): string {
  return left === null || right === null
    ? "unresolved"
    : left === right
      ? "agree"
      : "disagree";
}

function profileJoin(
  digital: SourceRow,
  legacy: SourceRow,
  container: string,
): void {
  const foreign = container === "txnAbroad";
  const payment = foreign ? legacy.paymentSumOutbound : legacy.paymentSum;
  const deal = foreign ? legacy.dealSumOutbound : legacy.dealSum;
  relate("join.containers", container);
  const digitalCurrency = digitalBillingCurrency(digital);
  const legacyBilling = legacyCurrency(legacy.currencyId);
  const billingUnits = unitRelation(digitalCurrency, legacyBilling);
  relate("join.billingCurrency", billingUnits);
  relate(
    "join.billingAmount",
    `currency-${billingUnits}|${compareAmounts("digital-billing", digital.billingAmount, "legacy-payment", payment)}`,
  );
  const originalIso = token(digital.originalCurrencyIso);
  const legacyOriginal = legacyCurrency(legacy.currentPaymentCurrency);
  const originalUnits = unitRelation(
    originalIso !== null && ISO_CURRENCIES.includes(originalIso)
      ? originalIso
      : null,
    legacyOriginal,
  );
  relate("join.originalCurrency", originalUnits);
  relate(
    "join.originalAmount",
    `currency-${originalUnits}|${compareAmounts("digital-original", digital.originalAmount, "legacy-deal", deal)}`,
  );
  const digitalVoucher = token(digital.voucherNumber);
  const legacyVoucher = token(legacy.voucherNumber);
  relate(
    "join.voucherNumberFields",
    digitalVoucher === null || legacyVoucher === null
      ? "missing"
      : digitalVoucher === legacyVoucher
        ? "equal"
        : "different",
  );
  relate(
    "join.installmentMarkers",
    `digital-${installmentClass(digital)}|legacy-${legacyInstallmentText(legacy) ? "payment-text" : "no-payment-text"}`,
  );
  relate(
    "join.recurringFlags",
    `digital-${booleanClass(digital.isdirectDebit)}|legacy-${booleanClass(legacy.isHoraatKeva)}`,
  );
}

/** Payment-table rows: distinct numbered ordinals versus unnumbered or repeated rows. */
function paymentTableClass(table: unknown[], count: unknown): string {
  const ordinals = new Set<number>();
  let repeated = 0;
  let unnumbered = 0;
  for (const row of table) {
    const ordinal = object(row) ? sourceInteger(row.paymentNumber) : null;
    if (typeof ordinal === "number") {
      if (ordinals.has(ordinal)) {
        repeated++;
      }
      ordinals.add(ordinal);
    } else {
      unnumbered++;
    }
  }
  const expected = sourceInteger(count);
  const comparison =
    typeof expected !== "number"
      ? "count-unavailable"
      : ordinals.size === expected
        ? "ordinals-equal-count"
        : "ordinals-differ-from-count";
  return `${comparison}|unnumbered-${unnumbered ? "present" : "none"}|repeated-${repeated ? "present" : "none"}`;
}

function profileDetail(
  bean: SourceRow,
  requested: string,
  digitalRowsByVoucher: Map<string, SourceRow[]>,
  namespace: Namespace,
  cardKey: string,
): void {
  const bound = token(bean.voucherNumberRatz);
  const binding =
    bound === null ? "missing" : bound === requested ? "equal" : "different";
  const matches =
    binding === "equal" ? (digitalRowsByVoucher.get(requested) ?? []) : [];
  const digital = matches.length === 1 ? matches[0]! : null;
  // Cross-response checks count once per request, binding outcome, match
  // multiplicity and compared DigitalV3 row.
  if (
    !firstTime(scoped(namespace, "detail"), [
      requested,
      cardKey,
      binding,
      matches.length,
      bean,
      digital,
    ])
  ) {
    return;
  }
  for (const field of [
    "currencyId",
    "currencyIdForCharge",
    "currencyIdOutbound",
  ]) {
    recordCode(`detail.${field}`, bean[field]);
  }
  relate("detail.voucherBinding", binding);
  // The detail's own currency fields; the discount equation needs one unit.
  const detailUnits = [
    ...new Set(
      ["currencyId", "currencyIdForCharge", "currencyIdOutbound"].flatMap(
        (field) =>
          bean[field] === null || bean[field] === undefined
            ? []
            : [legacyCurrency(bean[field]) ?? "<unresolved>"],
      ),
    ),
  ];
  const detailUnit =
    detailUnits.length === 1 && detailUnits[0] !== "<unresolved>"
      ? detailUnits[0]!
      : null;
  const detailUnitClass =
    detailUnits.length === 0
      ? "unstated"
      : detailUnit === null
        ? "mixed-or-unresolved"
        : "single";
  const before = decimal(bean.sumBeforeDiscount);
  const charge = decimal(bean.chargeSum);
  const discount = decimal(bean.discount);
  if (before && charge && discount) {
    const [b, c, d] = aligned(before, charge, discount) as [
      bigint,
      bigint,
      bigint,
    ];
    relate(
      "detail.discountVsSumBeforeDiscountMinusCharge",
      `currency-${detailUnitClass}|${discount.units === 0n ? "zero-discount" : "discount"}|${b - c === d ? "agree" : "disagree"}`,
    );
  } else {
    relate(
      "detail.discountVsSumBeforeDiscountMinusCharge",
      `missing|${amountClass(bean.sumBeforeDiscount)}|${amountClass(bean.chargeSum)}|${amountClass(bean.discount)}`,
    );
  }
  const table = Array.isArray(bean.Table1) ? bean.Table1 : null;
  for (const row of table ?? []) {
    if (object(row)) {
      recordCode("detail.table1.currencyId", row.currencyId);
    }
  }
  // Only a detail whose own voucher equals the request is compared with a row.
  relate(
    "detail.matchedDigitalRow",
    binding !== "equal"
      ? `binding-${binding}`
      : matches.length === 0
        ? "none"
        : matches.length === 1
          ? "unique"
          : "ambiguous",
  );
  if (digital) {
    // Units are compared first; an unstated detail unit stays unresolved.
    const originalIso = token(digital.originalCurrencyIso);
    relate(
      "detail.chargeSumVsDigitalBilling",
      `currency-${unitRelation(detailUnit, digitalBillingCurrency(digital))}|${compareAmounts("detail-charge", bean.chargeSum, "digital-billing", digital.billingAmount)}`,
    );
    relate(
      "detail.dealSumVsDigitalOriginal",
      `currency-${unitRelation(detailUnit, originalIso !== null && ISO_CURRENCIES.includes(originalIso) ? originalIso : null)}|${compareAmounts("detail-deal", bean.dealSum, "digital-original", digital.originalAmount)}`,
    );
    relate(
      "detail.paymentTableVsInstallmentCount",
      `${installmentClass(digital)}|${table === null ? "no-table" : paymentTableClass(table, digital.numberOfInstallment)}`,
    );
  }
}

/** Matches only the exact projection shape, recursively; anything else is raw. */
function cardListKind(value: unknown): string {
  if (!object(value)) {
    return "invalid";
  }
  const data = value.data;
  if (!object(data) || !Array.isArray(data.cardsList)) {
    return "invalid";
  }
  const scalar = (item: unknown) => item === null || typeof item === "string";
  const projected =
    Object.keys(value).every((key) => key === "isSuccess" || key === "data") &&
    typeof value.isSuccess === "boolean" &&
    Object.keys(data).every((key) => key === "cardsList") &&
    data.cardsList.every(
      (card) =>
        object(card) &&
        Object.entries(card).every(([key, item]) =>
          key === "billingAccount"
            ? object(item) &&
              Object.entries(item).every(
                ([field, part]) =>
                  (field === "providerKey" || field === "mask") && scalar(part),
              )
            : PROJECTED_CARD_FIELDS.has(key) && scalar(item),
        ),
    );
  return projected ? "projected" : "raw";
}

interface CaptureContext {
  namespace: Namespace;
  scope: CollectionScope | undefined;
  accountKey: unknown;
  httpStatus: unknown;
}

function scopeOf(value: unknown): CollectionScope | undefined {
  return object(value) ? (value as unknown as CollectionScope) : undefined;
}

/**
 * Replays always re-project the card list, whatever shape the archive holds,
 * so nothing outside the allowlisted projection can reach a replay ledger.
 */
function projectedCaptureText(capture: IsracardCapture): string {
  return serializeIsracardCapture({
    ...capture,
    responses: {
      ...capture.responses,
      cardList: projectIsracardCardList(capture.responses.cardList),
    },
  });
}

function profileCapture(responseText: string, context: CaptureContext): void {
  const { namespace } = context;
  const parsed = attempt(
    "parse_capture_envelope",
    () => isracardCaptureSchema.safeParse(JSON.parse(responseText)),
    null,
  );
  if (!parsed) {
    inventoryCounts.add("captures|invalid-json");
    return;
  }
  if (!parsed.success) {
    inventoryCounts.add("captures|invalid-envelope");
    for (const issue of parsed.error.issues) {
      envelopeIssues.add(issueLabel(issue));
    }
    return;
  }
  const capture = parsed.data;
  inventoryCounts.add("captures|valid");
  const cardKey = isracardCardKey(capture.card);
  const card = cardFor(namespace, cardKey, capture.card.companyCode);
  const month = capture.billingMonth;
  const company = recordCode("envelope.companyCode", capture.card.companyCode);
  recordCode("envelope.mode", capture.mode);
  const scope = context.scope;
  const scopeMatches =
    scope !== undefined &&
    scope.kind === capture.mode &&
    scope.month === month &&
    scope.cardKey === cardKey;
  inventoryCounts.add(
    `captures|scope-${!scope ? "missing" : scopeMatches ? "matches-envelope" : "differs-from-envelope"}`,
  );
  const accountMatches = context.accountKey === cardKey;
  inventoryCounts.add(
    `captures|account-key-${accountMatches ? "matches-card" : "differs-from-card"}`,
  );

  // Card list
  const cardListValue = decode(capture.responses.cardList);
  const listKind = cardListKind(cardListValue);
  profileOnce(
    `cardList-${listKind}`,
    capture.responses.cardList,
    cardListValue,
  );
  const listedCards =
    object(cardListValue) &&
    object(cardListValue.data) &&
    Array.isArray(cardListValue.data.cardsList)
      ? cardListValue.data.cardsList.filter(object)
      : [];
  if (firstTime(scoped(namespace, "cardList"), capture.responses.cardList)) {
    for (const listed of listedCards) {
      recordCode("cardList.companyCode", listed.companyCode);
    }
  }
  const bound = listedCards.filter(
    (listed) =>
      token(listed.companyCode) === capture.card.companyCode &&
      token(listed.cardSuffix) === capture.card.cardSuffix,
  );
  const discoveryBound =
    digitalData(cardListValue) !== null &&
    bound.length === 1 &&
    token(bound[0]!.cardGuid) === capture.card.cardGuid;
  card.cardListPresence.add(
    bound.length === 1
      ? discoveryBound
        ? `${listKind}|bound`
        : `${listKind}|guid-or-envelope-differs`
      : bound.length === 0
        ? `${listKind}|absent`
        : `${listKind}|duplicate`,
  );
  if (listKind === "raw" && bound.length === 1) {
    for (const field of ["isActive", "isPartner"]) {
      card.cardListPresence.add(
        `raw|${field}-${booleanClass(bound[0]![field])}`,
      );
    }
  }
  // The extractor projects nothing from a capture whose card, account or scope
  // binding fails, so such a capture never counts as successful coverage.
  const bindingValid = discoveryBound && accountMatches && scopeMatches;
  // Ingestion rejects a capture archived with a non-2xx status before extraction.
  const httpOk =
    context.httpStatus === undefined ||
    (typeof context.httpStatus === "number" &&
      context.httpStatus >= 200 &&
      context.httpStatus <= 299);
  const attributable = bindingValid && httpOk;

  generations.add(
    [
      `mode-${capture.mode}`,
      `company-${company}`,
      `cardList-${listKind}`,
      `digital-${capture.responses.digital === undefined ? "absent" : "present"}`,
      `legacy-${capture.responses.legacy === undefined ? "absent" : "present"}`,
      `legacyIndex-${capture.legacyCardIndex === undefined ? "absent" : "present"}`,
      `details-${capture.responses.details?.length ? "present" : "absent"}`,
    ].join("|"),
  );

  function outcome(result: SourceRows): string {
    return !httpOk
      ? "http_error"
      : !bindingValid
        ? "invalid_binding"
        : !result.valid
          ? "invalid_partial"
          : result.rows.length
            ? "success_rows"
            : "success_empty";
  }

  // DigitalV3
  const digitalCell = cell(card, month, "digital");
  const digitalRowsByVoucher = new Map<string, SourceRow[]>();
  if (capture.responses.digital === undefined) {
    digitalCell.outcomes.add("absent");
  } else {
    const value = decode(capture.responses.digital);
    const data = digitalData(value);
    profileOnce("digital", capture.responses.digital, value);
    if (!data) {
      digitalCell.outcomes.add(httpOk ? "invalid" : "http_error");
    } else {
      const result = digitalRows(data);
      relate("digital.responseShape", result.shape);
      relate(
        "digital.approvals",
        data.approvals !== null && data.approvals !== undefined
          ? `non-null-${valueClass(data.approvals)}`
          : valueClass(data.approvals),
      );
      digitalCell.outcomes.add(outcome(result));
      // The extractor fails the pending partition for non-null approvals, so
      // the card-month's coverage is partial however complete the vouchers are.
      if (
        attributable &&
        data.approvals !== null &&
        data.approvals !== undefined
      ) {
        digitalCell.outcomes.add("pending_unsupported");
      }
      if (attributable) {
        recordRows(digitalCell, result.rows, digest(capture.responses.digital));
      }
      for (const item of result.rows) {
        const voucher = token(item.row.seqVoucherNumber);
        if (voucher) {
          digitalRowsByVoucher.set(voucher, [
            ...(digitalRowsByVoucher.get(voucher) ?? []),
            item.row,
          ]);
        }
        if (
          firstTime(
            scoped(namespace, `digital|${cardKey}|${item.container}`),
            item.row,
          )
        ) {
          profileDigitalRow(item);
        }
      }
    }
  }

  // Legacy (one monthly response shared by every company-11 card)
  const legacyCell = cell(card, month, "legacy");
  if (capture.responses.legacy === undefined) {
    legacyCell.outcomes.add(
      capture.card.companyCode === "77" ? "unsupported" : "absent",
    );
  } else {
    const value = decode(capture.responses.legacy);
    const bean = legacyBean(value, "CardsTransactionsListBean");
    profileOnce("legacy", capture.responses.legacy, value);
    if (!bean) {
      legacyCell.outcomes.add(httpOk ? "invalid" : "http_error");
    } else {
      const list = Array.isArray(bean.cardNumberList)
        ? bean.cardNumberList
        : [];
      if (!legacyBound(bean, capture)) {
        // Rows of an unproven index are never attributed to this card.
        legacyCell.outcomes.add(httpOk ? "unbound" : "http_error");
      } else {
        const index = capture.legacyCardIndex!;
        const result = legacyIndexRows(bean[`Index${index}`]);
        legacyCell.outcomes.add(outcome(result));
        if (attributable) {
          recordRows(
            legacyCell,
            result.rows,
            digest(capture.responses.legacy, index),
          );
        }
      }
      // Legacy indexes that no discovered card claims: legacy-only history.
      const discovered = new Set(
        listedCards
          .filter((listed) => token(listed.companyCode) === "11")
          .map((listed) => token(listed.cardSuffix)),
      );
      if (
        // A body archived with an HTTP error establishes nothing, so it cannot
        // claim the deduplication slot of a later accepted copy. Otherwise once
        // per body, billing month and discovery context: each month needs its
        // own legacy-only coverage, and discovery decides which cards count.
        httpOk &&
        firstTime(
          scoped(
            namespace,
            `legacy-response|${month}|${JSON.stringify([...discovered].sort())}`,
          ),
          capture.responses.legacy,
        )
      ) {
        list.forEach((entry, position) => {
          const suffix = suffixOf(entry);
          const result = legacyIndexRows(bean[`Index${position}`]);
          const unique =
            suffix !== null &&
            list.filter((other) => suffixOf(other) === suffix).length === 1;
          relate(
            "legacy.cardIndexes",
            suffix === null
              ? "unparseable-suffix"
              : !unique
                ? "duplicate-suffix"
                : discovered.has(suffix)
                  ? "discovered"
                  : "not-in-card-list",
          );
          for (const item of result.rows) {
            if (
              firstTime(
                scoped(
                  namespace,
                  `legacy|${unique ? suffix : position}|${item.container}`,
                ),
                item.row,
              )
            ) {
              profileLegacyRow(item);
            }
          }
          if (unique && !discovered.has(suffix)) {
            const legacyCard = cardFor(
              namespace,
              `legacy-only:${suffix}`,
              "11",
              true,
            );
            const entryCell = cell(legacyCard, month, "legacy");
            entryCell.outcomes.add(
              !result.valid
                ? "undiscoverable_invalid_partial"
                : result.rows.length
                  ? "undiscoverable_rows"
                  : "undiscoverable_empty",
            );
            recordRows(
              entryCell,
              result.rows,
              digest(capture.responses.legacy!, String(position)),
            );
          }
        });
      }
    }
  }

  // Optional details
  const detailCell = cell(card, month, "details");
  if (!capture.responses.details?.length) {
    detailCell.outcomes.add("none");
  }
  for (const detail of capture.responses.details ?? []) {
    const value = decode(detail.responseText);
    const bean = legacyBean(value, "PirteyIska_204Bean");
    profileOnce("detail", detail.responseText, value);
    detailCell.outcomes.add(
      !httpOk
        ? "http_error"
        : !bindingValid
          ? "invalid_binding"
          : !bean
            ? "invalid"
            : // Only a detail bound to the requested voucher is coverage.
              token(bean.voucherNumberRatz) === detail.voucherNumber
              ? "fetched"
              : "unbound_detail",
    );
    detailCell.distinctResponses.add(digest(detail.responseText));
    if (bean) {
      profileDetail(
        bean,
        detail.voucherNumber,
        digitalRowsByVoucher,
        namespace,
        cardKey,
      );
    }
  }

  // Replay through the current extractor, once per distinct capture and context.
  const extractionKey = digest(
    scoped(namespace, responseText),
    JSON.stringify(scope ?? null),
    String(context.accountKey),
  );
  extraction.captures.add("occurrences");
  if (!httpOk) {
    extraction.captures.add("http-rejected");
    return;
  }
  if (seenExtractions.has(extractionKey)) {
    return;
  }
  seenExtractions.add(extractionKey);
  extraction.captures.add("distinct");
  const result = attempt(
    "extract_capture",
    () =>
      extractIsracard(projectedCaptureText(capture), {
        accountKey:
          typeof context.accountKey === "string" ? context.accountKey : "",
        runId: "profile",
        endpoint: ISRACARD_CAPTURE_ENDPOINT,
        ...(scope ? { scope } : {}),
      }),
    null,
  );
  if (result) {
    profileExtraction(result, scoped(namespace, cardKey));
  }
}

function listed(code: string, allowed: Set<string>): string {
  return allowed.has(code) ? code : "<unlisted>";
}

function profileExtraction(result: ExtractionResult, cardKey: string): void {
  for (const warning of result.warnings) {
    extraction.warnings.add(listed(warning, WARNING_CODES));
  }
  for (const partition of result.partitions) {
    extraction.partitions.add(
      `${partition.status}|success-${partition.success}|comparable-${partition.comparable}`,
    );
  }
  for (const transaction of result.transactions) {
    const provider = transaction.details.provider.isracard;
    const observations =
      object(provider) && Array.isArray(provider.observations)
        ? (provider.observations as unknown[])
            .filter(object)
            .map((item, index): SourceRow => ({
              ...item,
              row: Array.isArray(provider.rows)
                ? provider.rows[index]
                : item.row,
            }))
        : [];
    // Array indexes in observation paths change when rows reorder; the
    // generation, container and row content identify the observation.
    const hash = digest(
      cardKey,
      JSON.stringify(
        observations.map((item) => [
          item.generation,
          String(item.path).replace(/\[\d+\]/g, "[]"),
          item.row,
        ]),
      ),
    );
    extraction.transactions.add("occurrences");
    if (seenTransactions.has(hash)) {
      continue;
    }
    seenTransactions.add(hash);
    extraction.transactions.add("distinct");
    const shape = observations
      .map((item) => String(item.generation))
      .sort()
      .join("+");
    const containers = observations
      .map(
        (item) =>
          String(item.path).match(
            /(israelAbroadVouchersList|informativeOnlyVouchers|outOfStatementChargeDateVouchers|txnIsrael|txnAbroad|txnInfo)/,
          )?.[1] ?? "unknown",
      )
      .join("+");
    const fields = extraction.fields;
    fields.add(
      "observations",
      `${transaction.identityStrength}|${shape || "none"}`,
    );
    fields.add("containers", containers || "none");
    fields.add(
      "amount",
      `${transaction.amountMinor === null ? "null" : "present"}|currency-${transaction.currency === null ? "<null>" : codeLabel("digital.originalCurrencyIso", transaction.currency, false)}`,
    );
    fields.add("kind", transaction.kind);
    fields.add("amountBasis", transaction.amountBasis);
    fields.add(
      "providerTransactionCode",
      codeLabel(
        "digital.transactionCode",
        transaction.providerTransactionCode,
        false,
      ),
    );
    fields.add(
      "authorizationMethod",
      String(transaction.authorizationMethod ?? "<omitted>"),
    );
    fields.add("wallet", String(transaction.wallet ?? "<omitted-or-null>"));
    fields.add(
      "threeDSecureUsed",
      String(transaction.threeDSecureUsed ?? "<omitted>"),
    );
    fields.add("recurring", String(transaction.recurring ?? "<omitted>"));
    fields.add(
      "installmentCount",
      transaction.installmentCount === null ||
        transaction.installmentCount === undefined
        ? "null"
        : transaction.installmentCount <= 1
          ? String(transaction.installmentCount)
          : "more-than-1",
    );
    fields.add(
      "transactionDate",
      transaction.transactionDate === null ? "null" : "present",
    );
    fields.add(
      "billingDate",
      transaction.billingDate === null ? "null" : "present",
    );
    fields.add(
      "transactionDateTime",
      transaction.details.transactionDateTime === null ? "null" : "present",
    );
    for (const issue of new Set(transaction.details.issues)) {
      extraction.issues.add(listed(issue, ISSUE_CODES));
    }
    const validation = transactionInputSchema.safeParse(transaction);
    if (!validation.success) {
      for (const issue of validation.error.issues) {
        extraction.invalidRows.add(issueLabel(issue));
      }
    }
    const digital = observations.find((item) => item.generation === "digital");
    const legacy = observations.find((item) => item.generation === "legacy");
    if (digital && legacy && object(digital.row) && object(legacy.row)) {
      profileJoin(
        digital.row,
        legacy.row,
        String(legacy.path).match(/(txnIsrael|txnAbroad|txnInfo)/)?.[1] ??
          "unknown",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Archives

interface ArchiveRun {
  ordinal: number;
  id: string | null;
  connectionId: string | null;
  startedAt: string | null;
  collectorVersion: string | null;
  responses: unknown[];
  failures: unknown[];
}

function versionLabel(value: unknown): string {
  return typeof value === "string" && KNOWN_VERSIONS.has(value)
    ? value
    : value === null || value === undefined
      ? "<null>"
      : "<unlisted>";
}

/** A hot rollback journal needs a write to read the archive consistently. */
class ArchiveSidecarError extends Error {}

/**
 * SQLite readers of a WAL database write its shared-memory file and may create
 * it beside the archive. The archive and its write-ahead log are therefore
 * copied into the private work directory and only the copy is opened, with
 * `mode=ro` and `query_only`. The copy is removed once read.
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

/** Removal failed for at least one file; each one was still attempted. */
class CleanupError extends Error {}

/** Removes the copy and each sidecar independently; any failure is reported. */
function removeCopy(copy: string): void {
  let failed = false;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      rmSync(`${copy}${suffix}`, { force: true });
    } catch {
      failed = true;
    }
  }
  if (failed) {
    throw new CleanupError();
  }
}

function readArchive(
  path: string,
  alias: string,
  report: Record<string, unknown>,
  workDirectory: string,
): ArchiveRun[] {
  stage = "open_archive";
  const copy = join(workDirectory, `${alias}-copy.sqlite`);
  let database: DatabaseSync;
  try {
    database = openArchiveCopy(path, copy);
  } catch (error) {
    removeCopy(copy);
    throw error;
  }
  const runs: ArchiveRun[] = [];
  try {
    stage = "read_schema";
    const tables = (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: unknown }[]
    ).map((row) => String(row.name));
    const schema = {
      userVersion: ((version: number) =>
        KNOWN_USER_VERSIONS.has(version) ? version : "<unlisted>")(
        Number(
          (
            database.prepare("PRAGMA user_version").get() as {
              user_version: unknown;
            }
          ).user_version,
        ),
      ),
      tables: tables.filter((name) => KNOWN_TABLES.has(name)).sort(),
      unlistedTables: tables.filter((name) => !KNOWN_TABLES.has(name)).length,
      syncRunColumns: [] as string[],
      unlistedSyncRunColumns: 0,
    };
    report.schema = schema;
    if (!tables.includes("sync_runs")) {
      return runs;
    }
    const columns = (
      database.prepare("PRAGMA table_info(sync_runs)").all() as {
        name: unknown;
      }[]
    ).map((row) => String(row.name));
    schema.syncRunColumns = columns.filter((name) =>
      RUN_COLUMNS.includes(name),
    );
    schema.unlistedSyncRunColumns =
      columns.length - schema.syncRunColumns.length;
    const providers = new Map<string, string>();
    const connections = new Counter();
    if (tables.includes("connections")) {
      for (const row of database
        .prepare("SELECT id, provider FROM connections")
        .all() as { id: unknown; provider: unknown }[]) {
        providers.set(String(row.id), String(row.provider));
        connections.add(
          row.provider === "isracard" || row.provider === "cal"
            ? String(row.provider)
            : "<unlisted>",
        );
      }
    }
    report.connectionsByProvider = connections;
    if (tables.includes("transactions")) {
      report.archivedTransactionRows = Number(
        (
          database
            .prepare("SELECT count(*) AS count FROM transactions")
            .get() as {
            count: unknown;
          }
        ).count,
      );
    }
    if (
      !columns.includes("snapshot_json") &&
      !columns.includes("metadata_json")
    ) {
      return runs;
    }
    stage = "read_runs";
    const selected = RUN_COLUMNS.filter((name) => columns.includes(name)).map(
      (name) => `sync_runs.${name}`,
    );
    const separateBodies =
      !columns.includes("snapshot_json") && tables.includes("sync_run_bodies");
    if (!columns.includes("snapshot_json")) {
      selected.push(
        `${separateBodies ? "coalesce(sync_run_bodies.snapshot_json,sync_runs.metadata_json)" : "sync_runs.metadata_json"} AS snapshot_json`,
      );
    }
    const statuses = new Counter();
    const applied = new Counter();
    const versions = new Counter();
    const warnings = new Counter();
    const coverage = new Counter();
    const responses = new Counter();
    const failures = new Counter();
    const connectionAliases = new Map<string, string>();
    let otherProvider = 0;
    let invalidSnapshots = 0;
    let ordinal = 0;
    let previousStart: string | null = null;
    let outOfOrder = 0;
    const statement = database.prepare(
      `SELECT ${selected.join(", ")} FROM sync_runs ${separateBodies ? "LEFT JOIN sync_run_bodies ON sync_run_bodies.run_id=sync_runs.id" : ""} ORDER BY sync_runs.rowid`,
    );
    for (const row of statement.iterate() as Iterable<
      Record<string, unknown>
    >) {
      ordinal++;
      const connectionId =
        typeof row.connection_id === "string" ? row.connection_id : null;
      if (
        connectionId !== null &&
        providers.size > 0 &&
        providers.get(connectionId) !== "isracard"
      ) {
        otherProvider++;
        continue;
      }
      const connectionKey = connectionId ?? "<none>";
      if (!connectionAliases.has(connectionKey)) {
        connectionAliases.set(
          connectionKey,
          `connection-${connectionAliases.size + 1}`,
        );
      }
      const namespace: Namespace = {
        archive: alias,
        connection: connectionAliases.get(connectionKey)!,
      };
      statuses.add(
        RUN_STATUSES.includes(String(row.status))
          ? String(row.status)
          : "<unlisted>",
      );
      applied.add(
        row.applied_at === null || row.applied_at === undefined
          ? "unapplied"
          : "applied",
      );
      versions.add(`collector|${versionLabel(row.collector_version)}`);
      versions.add(`parser|${versionLabel(row.parser_version)}`);
      const startedAt =
        typeof row.started_at === "string" ? row.started_at : null;
      if (
        startedAt !== null &&
        previousStart !== null &&
        startedAt < previousStart
      ) {
        outOfOrder++;
      }
      previousStart = startedAt ?? previousStart;
      attempt(
        "parse_run_warnings",
        () => {
          const parsed: unknown = JSON.parse(String(row.warnings_json ?? "[]"));
          for (const warning of Array.isArray(parsed) ? parsed : []) {
            warnings.add(
              typeof warning === "string"
                ? listed(warning.split(":", 1)[0]!, WARNING_CODES)
                : "<non-string>",
            );
          }
        },
        undefined,
      );
      attempt(
        "parse_run_coverage",
        () => {
          const parsed: unknown = JSON.parse(String(row.coverage_json ?? "[]"));
          for (const partition of Array.isArray(parsed) ? parsed : []) {
            coverage.add(
              object(partition)
                ? `${partition.status === "posted" || partition.status === "pending" ? partition.status : "<unlisted>"}|success-${booleanClass(partition.success)}|comparable-${booleanClass(partition.comparable)}`
                : "<non-object>",
            );
          }
        },
        undefined,
      );
      const snapshot = attempt(
        "parse_run_snapshot",
        () => JSON.parse(String(row.snapshot_json)) as unknown,
        null,
      );
      if (!object(snapshot) || !Array.isArray(snapshot.responses)) {
        invalidSnapshots++;
        continue;
      }
      const runFailures = Array.isArray(snapshot.failures)
        ? snapshot.failures
        : [];
      runs.push({
        ordinal,
        id: typeof row.id === "string" ? row.id : null,
        connectionId,
        startedAt,
        collectorVersion:
          typeof row.collector_version === "string"
            ? row.collector_version
            : null,
        responses: snapshot.responses,
        failures: runFailures,
      });
      for (const response of snapshot.responses) {
        if (!object(response)) {
          responses.add("<non-object>");
          continue;
        }
        const endpointClass =
          ENDPOINT_CLASSES.get(String(response.endpoint)) ?? "<unlisted>";
        const scope = scopeOf(response.scope);
        responses.add(
          `${endpointClass}|scope-${scope ? (scope.kind === "recent" || scope.kind === "history" ? scope.kind : "<unlisted>") : "missing"}|http-${response.httpStatus === undefined ? "absent" : Number(response.httpStatus) >= 200 && Number(response.httpStatus) <= 299 ? "2xx" : "other"}`,
        );
        if (typeof response.responseText !== "string") {
          responses.add(`${endpointClass}|no-response-text`);
          continue;
        }
        if (
          endpointClass === "capture" ||
          endpointClass === "synthetic_capture"
        ) {
          stage = "profile_capture";
          attempt(
            "profile_capture",
            () =>
              profileCapture(response.responseText as string, {
                namespace,
                scope,
                accountKey: response.accountKey,
                httpStatus: response.httpStatus,
              }),
            undefined,
          );
          stage = "read_runs";
        } else {
          const value = decode(response.responseText);
          profileOnce(
            `unlisted-endpoint-${endpointClass}`,
            response.responseText,
            value,
          );
        }
      }
      for (const failure of runFailures) {
        recordFailure(failure, failures, namespace);
      }
    }
    report.runs = {
      isracardRuns: runs.length + invalidSnapshots,
      otherProviderRuns: otherProvider,
      invalidSnapshots,
      startedAtOutOfRowOrder: outOfOrder,
      statuses,
      applied,
      versions,
      warnings,
      coverage,
      responses,
      failures,
    };
  } finally {
    database.close();
    removeCopy(copy);
  }
  return runs;
}

function recordFailure(
  failure: unknown,
  failures: Counter,
  namespace: Namespace,
): void {
  if (!object(failure)) {
    failures.add("<non-object>");
    return;
  }
  const code = FAILURE_CODES.includes(String(failure.code))
    ? String(failure.code)
    : "<unlisted>";
  const endpointClass =
    ENDPOINT_CLASSES.get(String(failure.endpoint)) ?? "<unlisted>";
  const scope = scopeOf(failure.scope);
  const month =
    typeof scope?.month === "string" &&
    /^\d{4}-(?:0[1-9]|1[0-2])$/.test(scope.month)
      ? scope.month
      : null;
  failures.add(
    `${endpointClass}|${code}|scope-${scope ? String(scope.kind === "recent" || scope.kind === "history" ? scope.kind : "<unlisted>") : "missing"}|month-${month ? "present" : "absent"}|card-${typeof scope?.cardKey === "string" ? "present" : "absent"}`,
  );
  if (!month) {
    return;
  }
  const source =
    endpointClass === "transactions"
      ? "digital"
      : endpointClass === "legacy"
        ? "legacy"
        : endpointClass === "details"
          ? "details"
          : "other";
  const cardKey =
    typeof scope?.cardKey === "string"
      ? scope.cardKey
      : typeof failure.accountKey === "string"
        ? failure.accountKey
        : null;
  if (cardKey === null) {
    const key = scoped(namespace, month);
    const counter = legacyMonthFailures.get(key) ?? new Counter();
    counter.add(`${source}|${code}`);
    legacyMonthFailures.set(key, counter);
    return;
  }
  const company =
    cardKey.match(/^isracard:card:\["(11|77)",/)?.[1] ?? "<unknown>";
  cell(cardFor(namespace, cardKey, company), month, source).outcomes.add(
    `failed:${code}`,
  );
}

// ---------------------------------------------------------------------------
// Coverage matrix

function monthNumber(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthText(value: number): string {
  return `${String(Math.floor(value / 12)).padStart(4, "0")}-${String((value % 12) + 1).padStart(2, "0")}`;
}

/** A local budget stop means the request was never sent: unattempted, not failed. */
function failedAttempt(keys: string[], prefix: string): boolean {
  return keys.some(
    (key) => key.startsWith(prefix) && !key.endsWith("budget_exhausted"),
  );
}

function cellStatus(
  source: string,
  entry: CoverageSource | undefined,
  card: CardInfo,
  monthFailures: Counter | undefined,
): string {
  const outcomes = entry?.outcomes;
  if (card.legacyOnly) {
    return outcomes && outcomes.total() > 0 ? "undiscoverable" : "unattempted";
  }
  if (source === "details") {
    // Details are per-voucher requests: a fetched one cannot vouch for another
    // voucher's failed, invalid or unbound detail in the same cell.
    const failedDetail =
      !!outcomes &&
      (!!outcomes.get("invalid") ||
        !!outcomes.get("invalid_binding") ||
        !!outcomes.get("http_error") ||
        !!outcomes.get("unbound_detail") ||
        failedAttempt(Object.keys(outcomes.toJSON()), "failed:"));
    return outcomes?.get("fetched")
      ? failedDetail
        ? "partial"
        : "successful_nonempty"
      : failedDetail
        ? "failed"
        : "unattempted";
  }
  // Some partitions or rows broke the acceptance rules: evidence is incomplete,
  // and a complete response elsewhere cannot vouch for those rows. A failed
  // request later answered completely is a recovery, not partial evidence.
  if (
    outcomes?.get("invalid_partial") ||
    outcomes?.get("pending_unsupported")
  ) {
    return "partial";
  }
  if (outcomes?.get("success_rows")) {
    return "successful_nonempty";
  }
  if (outcomes?.get("success_empty")) {
    return "successful_empty";
  }
  if (
    outcomes &&
    (outcomes.get("invalid") ||
      outcomes.get("invalid_binding") ||
      outcomes.get("http_error") ||
      outcomes.get("unbound") ||
      failedAttempt(Object.keys(outcomes.toJSON()), "failed:"))
  ) {
    return "failed";
  }
  if (source === "legacy" && card.companyCode === "77") {
    return "unsupported";
  }
  if (
    source === "legacy" &&
    monthFailures &&
    failedAttempt(Object.keys(monthFailures.toJSON()), "legacy|")
  ) {
    return "failed";
  }
  return "unattempted";
}

function coverageMatrix(): {
  matrix: Record<string, unknown>;
  summary: Groups;
} {
  const matrix: Record<string, unknown> = {};
  const summary = new Groups();
  for (const card of cards.values()) {
    const namespace = { archive: card.archive, connection: card.connection };
    const months = [...card.months.keys()].map(monthNumber);
    if (!months.length) {
      continue;
    }
    const first = Math.min(...months);
    const last = Math.max(...months);
    const rows: Record<string, unknown> = {};
    for (let value = first; value <= last; value++) {
      const month = monthText(value);
      const sources = card.months.get(month);
      const row: Record<string, unknown> = {};
      for (const source of card.legacyOnly
        ? ["legacy"]
        : ["digital", "legacy", "details"]) {
        const entry = sources?.get(source);
        const status = cellStatus(
          source,
          entry,
          card,
          legacyMonthFailures.get(scoped(namespace, month)),
        );
        summary.add(source, status);
        row[source] = {
          status,
          outcomes: entry?.outcomes ?? {},
          maxRows: entry?.maxRows ?? 0,
          rowsByContainer: entry?.rowsByContainer ?? {},
          distinctResponses: entry?.distinctResponses.size ?? 0,
        };
      }
      const monthFailures = legacyMonthFailures.get(scoped(namespace, month));
      if (monthFailures && !card.legacyOnly) {
        row.monthLevelFailures = monthFailures;
      }
      rows[month] = row;
    }
    matrix[card.alias] = {
      archive: card.archive,
      connection: card.connection,
      companyCode: codeLabel("envelope.companyCode", card.companyCode, false),
      legacyOnly: card.legacyOnly,
      cardList: card.cardListPresence,
      months: rows,
    };
  }
  return { matrix, summary };
}

// ---------------------------------------------------------------------------
// Replay

async function replayArchive(
  runs: ArchiveRun[],
  directory: string,
  alias: string,
): Promise<Record<string, unknown>> {
  stage = "replay_open";
  const database = await openDatabase(join(directory, `${alias}.sqlite`));
  const results = new Counter();
  const skipped = new Counter();
  const connections = new Map<string, string>();
  try {
    for (const run of runs) {
      const original = run.connectionId ?? "<none>";
      let connectionId = connections.get(original);
      if (!connectionId) {
        connectionId = `replay-${connections.size + 1}`;
        connections.set(original, connectionId);
        await database.ensureConnection({
          id: connectionId,
          provider: "isracard",
        });
      }
      const responses = run.responses.flatMap((response) => {
        if (!object(response) || typeof response.responseText !== "string") {
          skipped.add("invalid-response");
          return [];
        }
        const endpointClass = ENDPOINT_CLASSES.get(String(response.endpoint));
        if (
          endpointClass !== "capture" &&
          endpointClass !== "synthetic_capture"
        ) {
          // Only capture envelopes are replayed; other bodies could hold raw card lists.
          skipped.add(`endpoint-${endpointClass ?? "<unlisted>"}`);
          return [];
        }
        const text = attempt(
          "replay_project_capture",
          () =>
            projectedCaptureText(
              isracardCaptureSchema.parse(
                JSON.parse(response.responseText as string),
              ),
            ),
          null,
        );
        if (text === null) {
          skipped.add("unprojectable-capture");
          return [];
        }
        return [{ ...response, responseText: text }];
      });
      if (responses.length + run.failures.length === 0) {
        skipped.add("empty-run");
        continue;
      }
      stage = "replay_ingest";
      const result = await attemptAsync(
        "replay_ingest",
        () =>
          database.ingestRun(
            {
              runId: run.id ?? `replay-run-${run.ordinal}`,
              connectionId: connectionId,
              ...(run.startedAt && !Number.isNaN(Date.parse(run.startedAt))
                ? { startedAt: run.startedAt }
                : {}),
              ...(run.collectorVersion
                ? { collectorVersion: run.collectorVersion }
                : {}),
              responses: responses as RunInput["responses"],
              failures: run.failures as RunInput["failures"],
            },
            isracardAdapter,
          ),
        null,
      );
      if (result) {
        results.add(`status|${result.status}`);
        results.add(`replayed|${result.replayed}`);
        results.add("created", result.created);
        results.add("updated", result.updated);
        results.add("unlisted", result.unlisted);
        if (result.failureCode) {
          results.add(
            `failureCode|${listed(result.failureCode, WARNING_CODES)}`,
          );
        }
      } else {
        results.add("status|error");
      }
    }
    stage = "replay_read";
    const ledger = new Groups();
    const totals: Record<string, unknown> = {};
    for (const connectionId of connections.values()) {
      const rows = await database.listTransactions({
        connectionId,
        includeSuperseded: true,
      });
      for (const row of rows) {
        ledger.add("transactions", "rows");
        ledger.add("presence", row.presence);
        ledger.add("superseded", row.supersededById === null ? "no" : "yes");
        ledger.add("identityStrength", row.identityStrength);
        ledger.add("kind", row.kind);
        ledger.add("amountBasis", row.amountBasis);
        ledger.add("status", row.status);
        ledger.add(
          "amount",
          `${row.amountMinor === null ? "null" : "present"}|currency-${row.currency === null ? "<null>" : codeLabel("digital.originalCurrencyIso", row.currency, false)}`,
        );
        ledger.add("reviewRequired", String(row.reviewRequired));
        for (const issue of row.sourceIssues) {
          ledger.add("sourceIssues", listed(issue, ISSUE_CODES));
        }
        for (const reason of row.reviewReasons) {
          ledger.add("reviewReasons", listed(reason, ISSUE_CODES));
        }
        const reasons = [
          row.amountMinor === null ? "amount-null" : null,
          row.currency === null ? "currency-null" : null,
          row.amountBasis !== "booked_entry" &&
          row.amountBasis !== "purchase_commitment"
            ? "basis-unresolved"
            : null,
          row.kind === "unknown" ? "kind-unknown" : null,
          row.identityStrength === "ambiguous" ? "identity-ambiguous" : null,
        ].filter((reason) => reason !== null);
        ledger.add("unresolvedReasons", reasons.join("+") || "none");
      }
      for (const perspective of ["spending", "billing"] as const) {
        const result = await attemptAsync(
          "replay_totals",
          () => database.getTotals({ connectionId, perspective }),
          null,
        );
        // Counts only: totals and fee sums are amounts and never leave the replay.
        totals[`${connectionId}|${perspective}`] = result
          ? {
              includedCount: result.includedCount,
              excludedCount: result.excludedCount,
              excluded: result.excluded,
            }
          : null;
      }
    }
    return { connections: connections.size, results, skipped, ledger, totals };
  } finally {
    await database.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point

interface Options {
  out: string;
  archives: string[];
  replay: boolean;
  /** A new directory to keep the replay ledgers in; null removes them. */
  keepReplay: string | null;
  /** Parent of the generated work directory when the replay is not kept. */
  temporaryRoot: string;
}

class UsageError extends Error {}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * Every destination is resolved and checked before anything is created: none
 * may lie inside the repository or inside a directory that holds an archive.
 */
function parseOptions(argv: string[]): Options {
  let out = "";
  let keep: string | null = null;
  let replay = false;
  const archives: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--out") {
      out = argv[++index] ?? "";
    } else if (argument === "--replay") {
      replay = true;
    } else if (argument === "--keep-replay") {
      keep = argv[++index] ?? "";
    } else if (argument.startsWith("-")) {
      throw new UsageError();
    } else {
      archives.push(argument);
    }
  }
  if (!out || !archives.length || keep === "" || (keep !== null && !replay)) {
    throw new UsageError();
  }
  const resolvedArchives = archives.map((archive) => {
    const path = realpathSync(resolve(archive));
    if (!statSync(path).isFile()) {
      throw new UsageError();
    }
    return path;
  });
  const protectedRoots = [
    ROOT,
    ...resolvedArchives.map((archive) => dirname(archive)),
  ];
  const allowed = (path: string) =>
    !protectedRoots.some((root) => inside(path, root));
  const destination = (path: string) => {
    const resolved = join(realpathSync(dirname(resolve(path))), basename(path));
    if (!allowed(resolved)) {
      throw new UsageError();
    }
    return resolved;
  };
  const newDirectory = (path: string) => {
    if (existsSync(path)) {
      throw new UsageError();
    }
    return path;
  };
  const temporaryRoot = realpathSync(tmpdir());
  if (!allowed(temporaryRoot)) {
    throw new UsageError();
  }
  // Archive copies and replay ledgers hold raw evidence: they stay in temporary storage.
  const temporary = (path: string) => {
    const resolved = destination(path);
    if (!inside(dirname(resolved), temporaryRoot)) {
      throw new UsageError();
    }
    return resolved;
  };
  return {
    out: destination(out),
    archives: resolvedArchives,
    replay,
    keepReplay: keep === null ? null : newDirectory(temporary(keep)),
    temporaryRoot,
  };
}

/** Cleanup state; each step runs independently so one failure cannot skip the rest. */
const resources: {
  output: number | null;
  out: string | null;
  written: boolean;
  workDirectory: string | null;
  keep: boolean;
  archiveCount: number;
} = {
  output: null,
  out: null,
  written: false,
  workDirectory: null,
  keep: false,
  archiveCount: 0,
};

/**
 * Releases every resource, each step independently, and returns the fixed
 * labels of the steps that failed so the run never reports success over them.
 */
function releaseResources(): string[] {
  const failed: string[] = [];
  const step = (label: string, work: () => void) => {
    try {
      work();
    } catch {
      failed.push(label);
    }
  };
  step("close_profile", () => {
    if (resources.output !== null) {
      const output = resources.output;
      resources.output = null;
      closeSync(output);
    }
  });
  step("remove_unfinished_profile", () => {
    if (resources.out !== null && !resources.written) {
      rmSync(resources.out, { force: true });
    }
  });
  const directory = resources.workDirectory;
  if (directory !== null) {
    if (resources.keep) {
      // Archive copies are raw evidence: they never outlive the run.
      for (let index = 1; index <= resources.archiveCount; index++) {
        step("remove_archive_copy", () =>
          removeCopy(join(directory, `archive-${index}-copy.sqlite`)),
        );
      }
    } else {
      step("remove_work_directory", () =>
        rmSync(directory, { recursive: true, force: true }),
      );
    }
    if (!failed.some((label) => label.startsWith("remove_"))) {
      resources.workDirectory = null;
    }
  }
  return [...new Set(failed)];
}

/** Releases resources on a failure path and names any step that also failed. */
function releaseAfterFailure(): void {
  const failed = releaseResources();
  if (failed.length) {
    process.stderr.write(
      `Isracard audit cleanup failed: ${failed.join(", ")}.\n`,
    );
  }
}

async function main(): Promise<number> {
  if (!launchedSafely()) {
    throw new LaunchError();
  }
  const options = parseOptions(process.argv.slice(2));
  stage = "create_output";
  // Fail before reading anything if the profile cannot be created privately.
  resources.output = openSync(options.out, "wx", 0o600);
  // Only a file this run created may be removed: never an existing one.
  resources.out = options.out;
  stage = "work_directory";
  // Archive copies and replay ledgers stay in one new owner-only directory.
  resources.keep = options.keepReplay !== null;
  resources.archiveCount = options.archives.length;
  let workDirectory: string;
  if (options.keepReplay !== null) {
    mkdirSync(options.keepReplay, { mode: 0o700 });
    workDirectory = options.keepReplay;
  } else {
    workDirectory = mkdtempSync(
      join(options.temporaryRoot, "fonds-isracard-audit-"),
    );
  }
  resources.workDirectory = workDirectory;
  chmodSync(workDirectory, 0o700);
  const output = resources.output;
  // Any failure from here reaches the top-level handler, which releases resources.
  const archives: Record<string, unknown>[] = [];
  const runsByArchive: [string, ArchiveRun[]][] = [];
  const runIds = new Map<string, Set<string>>();
  for (const [index, path] of options.archives.entries()) {
    const alias = `archive-${index + 1}`;
    const report: Record<string, unknown> = { alias };
    const runs = readArchive(path, alias, report, workDirectory);
    archives.push(report);
    runsByArchive.push([alias, runs]);
    for (const run of runs) {
      if (run.id) {
        const owners = runIds.get(run.id) ?? new Set<string>();
        owners.add(alias);
        runIds.set(run.id, owners);
      }
    }
  }
  let replay: Record<string, unknown> | null = null;
  if (options.replay) {
    replay = {};
    for (const [alias, runs] of runsByArchive) {
      replay[alias] = await attemptAsync(
        "replay_archive",
        () => replayArchive(runs, workDirectory, alias),
        null,
      );
    }
  }
  stage = "coverage";
  const { matrix, summary } = coverageMatrix();
  const profile = {
    profileVersion: PROFILE_VERSION,
    currentParserVersion: isracardAdapter.parserVersion,
    privacy:
      "Counts, allowlisted codes, normalized paths, value classes, opaque aliases and billing months only.",
    notes: [
      "Relationships compare source lexemes exactly in the source sign; extraction negates billing money. 'negated' means equal magnitude with the opposite sign.",
      "Field profiles count each distinct response text once; relationship rows are deduplicated by exact content per card, so repeated captures do not inflate them.",
      "Joins are the current extractor's own unique DigitalV3/legacy joins.",
      "Coverage spans each card's first to last month with any evidence, per archive and connection. A budget stop is unattempted; legacy-only cards are undiscoverable; a response breaking the extractor's acceptance rules is partial; a capture whose card, account or scope binding fails is failed.",
      "Keys outside the fixture and known field names appear as <unlisted-key:shape>; their names are never reported, only counted per parent path.",
    ],
    archives,
    crossArchive: {
      runIdsInMoreThanOneArchive: [...runIds.values()].filter(
        (owners) => owners.size > 1,
      ).length,
    },
    inventory: {
      counts: inventoryCounts,
      captureGenerations: generations,
      invalidEnvelopeIssues: envelopeIssues,
      cards: [...cards.values()].filter((card) => !card.legacyOnly).length,
      legacyOnlyCards: [...cards.values()].filter((card) => card.legacyOnly)
        .length,
    },
    coverage: { summary, matrix },
    fieldProfiles,
    codes: {
      counts: codes,
      unlistedDistinctValues: Object.fromEntries(
        [...unlistedCodes]
          .map(([field, values]) => [field, values.size])
          .sort(),
      ),
    },
    unlistedKeyNamesPerPath: Object.fromEntries(
      [...unlistedKeys].map(([path, names]) => [path, names.size]).sort(),
    ),
    relationships,
    extraction,
    replay,
    errors,
  };
  stage = "write_output";
  // With a descriptor, writeFileSync loops until every byte is written.
  writeFileSync(output, `${JSON.stringify(profile, null, 2)}\n`);
  resources.written = true;
  // Success is announced only once archive copies and work files are gone.
  stage = "cleanup";
  if (releaseResources().length) {
    throw new CleanupError();
  }
  const summaryLines = [
    `Isracard profile ${PROFILE_VERSION} (parser ${isracardAdapter.parserVersion}) written to the requested file.`,
    `archives ${archives.length}; captures ${inventoryCounts.get("captures|valid")} valid, ${inventoryCounts.get("captures|invalid-envelope") + inventoryCounts.get("captures|invalid-json")} invalid`,
    `cards ${profile.inventory.cards}; legacy-only cards ${profile.inventory.legacyOnlyCards}`,
    ...["digital", "legacy", "details"].map(
      (source) =>
        `coverage ${source}: ${Object.entries(
          summary.get(source)?.toJSON() ?? {},
        )
          .map(([status, count]) => `${status} ${count}`)
          .join(", ")}`,
    ),
    `distinct extracted transactions ${extraction.transactions.get("distinct")}`,
    `record errors ${errors.total()}`,
  ];
  if (options.keepReplay !== null) {
    summaryLines.push("replay ledgers kept in the requested directory");
  }
  process.stdout.write(`${summaryLines.join("\n")}\n`);
  return 0;
}

// Source values can appear in driver, parser and validator messages: report the stage and type only.
process.on("uncaughtException", (error) => {
  releaseAfterFailure();
  process.stderr.write(
    `Isracard audit failed at ${stage} (${errorType(error)}).\n`,
  );
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  releaseAfterFailure();
  process.stderr.write(
    `Isracard audit failed at ${stage} (${errorType(error)}).\n`,
  );
  process.exit(1);
});

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const) {
  process.on(signal, () => {
    releaseAfterFailure();
    process.stderr.write(`Isracard audit stopped at ${stage} (${signal}).\n`);
    process.exit(code);
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    releaseAfterFailure();
    process.stderr.write(
      error instanceof LaunchError
        ? "Run as: TSX_DISABLE_CACHE=1 node --no-warnings --import tsx tests/providers/isracard/scripts/audit-isracard-db.ts ...\n"
        : error instanceof UsageError
          ? "Usage: audit-isracard-db.ts --out NEW_PRIVATE_FILE [--replay [--keep-replay NEW_TEMPORARY_DIRECTORY]] ARCHIVE.sqlite... (destinations outside the repository and the archive directories)\n"
          : `Isracard audit failed at ${stage} (${errorType(error)}).\n`,
    );
    process.exitCode = 1;
  },
);
