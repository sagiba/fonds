// Idempotent Neon setup: private env file and its refresh schedule,
// financial/operational/auth schemas, the configured connection row and the
// Better Auth owner. Never calls providers and never prints secrets,
// connection strings or driver diagnostics. Deployment itself is
// `npm run neon:deploy` (see docs/guides/neon-deployment.md).
import { execFile } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv, promisify } from "node:util";

import {
  CollectionScheduleError,
  parseCollectionSchedule,
} from "../../src/runtime/collection-schedule.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const NEON_CLI = "neon@8.4.3";
/** The env file's schedule settings, named once here; the runtime reads them too. */
const SCHEDULE = {
  schedule: "FONDS_REFRESH_SCHEDULE",
  timeZone: "FONDS_REFRESH_TIMEZONE",
  time: "FONDS_REFRESH_TIME",
};
const REQUIRED = [
  "FONDS_PUBLIC_ORIGIN",
  "FONDS_NEON_GOOGLE_AUTH_URL",
  "FONDS_GOOGLE_OWNER_EMAIL",
  "FONDS_CONNECTION_ID",
  "FONDS_CONNECTION_PROVIDER",
];
const GENERATED = {
  FONDS_AUTH_SECRET: () => randomBytes(48).toString("base64url"),
  FONDS_OWNER_ID: () => randomUUID(),
  // Decrypts the credentials `connect` stores; part of the installation's binding.
  FONDS_CREDENTIALS_KEY: () => randomBytes(32).toString("base64url"),
  FONDS_REFRESH_SECRET: () => randomBytes(48).toString("base64url"),
  // This installation's random refresh time (UTC unless the time zone
  // setting says otherwise), so installations do not all reach a provider at
  // the same minute.
  [SCHEDULE.time]: () =>
    [randomInt(24), randomInt(60)]
      .map((value) => String(value).padStart(2, "0"))
      .join(":"),
};
/** Values the env file holds unquoted: single-line and comment-free. */
const UNQUOTED = /^[A-Za-z0-9_.:/@+=,-]+$/;
/** Generated settings a login link does not need. */
const SETTINGS = new Set([SCHEDULE.time]);

export class SetupError extends Error {}

function fail(message) {
  throw new SetupError(message);
}

/** The runtime's own parser, so setup accepts exactly what a deploy accepts. */
function parsedSchedule(settings) {
  try {
    return parseCollectionSchedule(
      { [SCHEDULE.time]: "00:00", ...settings },
      `${SCHEDULE.time} must be a 24-hour HH:MM time`,
    );
  } catch (error) {
    if (error instanceof CollectionScheduleError) {
      fail(`${error.message}.`);
    }
    throw error;
  }
}

/**
 * Each schedule answer's canonical, env-safe value. `off` is the one word
 * accepted for off: the runtime reads any other word as off too, so a typo
 * such as `dialy` is refused here rather than silently disabling refreshes.
 */
const ANSWERS = {
  schedule(text) {
    if (text === "off") {
      return "off";
    }
    const schedule = parsedSchedule({ [SCHEDULE.schedule]: text });
    if (!schedule) {
      fail(
        `${SCHEDULE.schedule} must be off, daily, hourly or hours 0-23 such as 9,13,18.`,
      );
    }
    return schedule.mode === "hours" ? schedule.hours.join(",") : schedule.mode;
  },
  timeZone(text) {
    return parsedSchedule({
      [SCHEDULE.schedule]: "daily",
      [SCHEDULE.timeZone]: text,
    }).timeZone;
  },
  time(text) {
    parsedSchedule({ [SCHEDULE.schedule]: "daily", [SCHEDULE.time]: text });
    return text;
  },
};

/** The canonical value of one schedule answer; flags and prompts share it. */
export function scheduleAnswer(kind, text) {
  return ANSWERS[kind](text.trim());
}

/**
 * The canonical value the runtime reads from a setting's stored text, which
 * is parsed exactly as stored; text the runtime refuses is returned as is,
 * so no valid answer equals it.
 */
function effectiveSetting(kind, values) {
  const stored = values[SCHEDULE[kind]];
  try {
    if (kind === "schedule") {
      const schedule =
        stored === undefined
          ? undefined
          : parsedSchedule({ [SCHEDULE.schedule]: stored });
      if (!schedule) {
        return "off";
      }
      return schedule.mode === "hours"
        ? schedule.hours.join(",")
        : schedule.mode;
    }
    if (kind === "timeZone") {
      return ANSWERS.timeZone(stored ?? "");
    }
    return ANSWERS.time(stored ?? "");
  } catch (error) {
    if (error instanceof SetupError) {
      return stored ?? "";
    }
    throw error;
  }
}

/**
 * Sets each answer the file does not already hold and returns the changed
 * names. Stored text is kept only when the runtime reads it as the answer and
 * the file can hold it unquoted, so an unchanged rerun writes nothing.
 */
function applySchedule(values, answers) {
  const changed = [];
  for (const [kind, text] of Object.entries(answers)) {
    const answer = scheduleAnswer(kind, text);
    const stored = values[SCHEDULE[kind]];
    if (
      answer !== effectiveSetting(kind, values) ||
      (stored !== undefined && !UNQUOTED.test(stored))
    ) {
      values[SCHEDULE[kind]] = answer;
      changed.push(SCHEDULE[kind]);
    }
  }
  return changed;
}

/** Asks for the schedule on a terminal, re-asking until an answer is valid. */
async function askSchedule(values, { input, output }) {
  const lines = createInterface({ input, output });
  const stop = new AbortController();
  lines.on("SIGINT", () => stop.abort());
  lines.on("close", () => stop.abort());

  async function ask(question, fallback, kind) {
    for (;;) {
      let text;
      try {
        text = await lines.question(`${question} [${fallback}]: `, {
          signal: stop.signal,
        });
      } catch {
        fail("Setup stopped; the env file was not changed.");
      }
      try {
        return scheduleAnswer(kind, text.trim() || fallback);
      } catch (error) {
        if (!(error instanceof SetupError)) {
          throw error;
        }
        output.write(`${error.message}\n`);
      }
    }
  }

  try {
    const current = effectiveSetting("schedule", values);
    const schedule = await ask(
      "Scheduled refreshes: off, daily (recommended once a manual refresh works), hourly, or hours such as 9,13,18",
      current,
      "schedule",
    );
    const answers = { schedule };
    if (schedule !== "off" && schedule !== "hourly") {
      // A named zone, or an active schedule (which runs in UTC when none is
      // named), is kept on Enter; only a fresh choice suggests this machine's.
      answers.timeZone = await ask(
        "Time zone (IANA)",
        values[SCHEDULE.timeZone]?.trim() || current !== "off"
          ? effectiveSetting("timeZone", values)
          : (Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"),
        "timeZone",
      );
    }
    if (schedule !== "off") {
      answers.time = await ask(
        "Refresh time, HH:MM (Enter keeps this installation's random time)",
        values[SCHEDULE.time],
        "time",
      );
    }
    return answers;
  } finally {
    lines.close();
  }
}

/**
 * How setup obtains schedule answers: from flags when any is given (blank
 * keeps the file's value), from prompts when stdin and stdout are a terminal,
 * and otherwise none. Flags are validated before the env file is touched.
 */
export function scheduleSource(flags, io) {
  const given = Object.entries(flags).filter(([, text]) => text !== undefined);
  if (given.length) {
    const answers = Object.fromEntries(
      given
        .filter(([, text]) => text.trim())
        .map(([kind, text]) => [kind, scheduleAnswer(kind, text)]),
    );
    return () => answers;
  }
  if (io.input?.isTTY && io.output?.isTTY) {
    return (values) => askSchedule(values, io);
  }
  return () => ({});
}

/** A secret-free line describing the schedule the env file declares. */
export function scheduleSummary(values) {
  let schedule;
  try {
    schedule = parsedSchedule({
      [SCHEDULE.schedule]: values[SCHEDULE.schedule],
      [SCHEDULE.timeZone]: values[SCHEDULE.timeZone],
      [SCHEDULE.time]: values[SCHEDULE.time],
    });
  } catch (error) {
    if (error instanceof SetupError) {
      return `Scheduled refreshes cannot deploy: ${error.message}`;
    }
    throw error;
  }
  if (!schedule) {
    return "Scheduled refreshes: off.";
  }
  const pad = (value) => String(value).padStart(2, "0");
  const minute = pad(schedule.minute);
  const when =
    schedule.mode === "hourly"
      ? `hourly at minute ${minute}`
      : `${schedule.mode === "daily" ? "daily" : "every day"} at ${schedule.hours
          .map((hour) => `${pad(hour)}:${minute}`)
          .join(", ")}`;
  return `Scheduled refreshes: ${when} (${schedule.timeZone}).`;
}

/** Canonical env file path in an owned private directory outside the repository. */
async function privateEnvironmentPath(path) {
  let directory;
  try {
    directory = await realpath(dirname(path));
  } catch {
    fail("The private env file's directory does not exist.");
  }
  const canonical = resolve(directory, basename(path));
  const fromRoot = relative(await realpath(root), canonical);
  const insideRepository =
    fromRoot !== ".." && !fromRoot.startsWith("../") && !isAbsolute(fromRoot);
  if (!isAbsolute(path) || insideRepository) {
    fail(
      "The private env file must be an absolute path outside the repository.",
    );
  }
  const owner = await stat(directory);
  if (owner.uid !== process.getuid?.() || (owner.mode & 0o077) !== 0) {
    fail("The private env file must be in an owned 0700 directory.");
  }
  return canonical;
}

/** Serializes setup so concurrent runs cannot generate different identities. */
async function withSetupLock(path, run) {
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    fail(
      `Another setup holds ${lockPath}; remove it only if no setup is running.`,
    );
  }
  try {
    return await run();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

/**
 * Reads the private env file, adds missing generated secrets, applies the
 * answers `schedule` returns for the values so far, and saves it 0600 only
 * when something changed.
 */
export async function prepareEnvironmentFile(
  requestedPath,
  { generate = true, schedule } = {},
) {
  const path = await privateEnvironmentPath(requestedPath);
  let values = {};
  try {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    ) {
      fail("The private env file must be an owned regular 0600 file.");
    }
    values = parseEnv(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SetupError) {
      throw error;
    }
    if (error.code !== "ENOENT") {
      fail("The private env file could not be read.");
    }
  }
  const missing = REQUIRED.filter((name) => !values[name]);
  if (missing.length) {
    fail(`Add ${missing.join(", ")} to the private env file.`);
  }
  let generated = Object.keys(GENERATED).filter((name) => !values[name]);
  if (!generate) {
    if (generated.some((name) => !SETTINGS.has(name))) {
      fail("Run setup first: the private env file lacks generated secrets.");
    }
    generated = [];
  }
  for (const name of generated) {
    values[name] = GENERATED[name]();
  }
  const changed = schedule ? applySchedule(values, await schedule(values)) : [];
  for (const [name, value] of Object.entries(values)) {
    if (!UNQUOTED.test(value)) {
      fail(`${name} contains characters the env file cannot hold unquoted.`);
    }
  }
  if (generated.length || changed.length) {
    const temporary = resolve(dirname(path), `.neon-setup-${process.pid}.tmp`);
    try {
      await writeFile(
        temporary,
        Object.entries(values)
          .map(([name, value]) => `${name}=${value}\n`)
          .join(""),
        { mode: 0o600, flag: "wx" },
      );
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { values, generated, changed };
}

async function directConnectionString(projectId, branchId, profile) {
  // Captured in memory: the CLI response contains the database password.
  const { stdout } = await promisify(execFile)(
    "npx",
    [
      "--yes",
      NEON_CLI,
      "connection-string",
      branchId,
      "--project-id",
      projectId,
      "--profile",
      profile,
      "--database-name",
      "neondb",
      "--ssl",
      "verify-full",
    ],
    { timeout: 60_000, maxBuffer: 64 * 1024 },
  );
  const url = new URL(stdout.trim());
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname.endsWith(".neon.tech") ||
    url.hostname.includes("-pooler.")
  ) {
    throw new Error("Unexpected connection string");
  }
  return url.href;
}

function identityPool(Pool, connectionString) {
  const created = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
    options: "-c search_path=identity",
  });
  created.on("error", () => {});
  return created;
}

async function setupAuth(authPool, values) {
  const { createBetterAuth } =
    await import("../../src/runtime/auth/better-auth.js");
  const { neonGoogleLogin } = await import("./neon-login.js");
  return createBetterAuth(
    authPool,
    {
      publicOrigin: values.FONDS_PUBLIC_ORIGIN,
      secret: values.FONDS_AUTH_SECRET,
      ownerId: values.FONDS_OWNER_ID,
      ownerEmail: "owner@fonds.invalid",
      googleLogin: neonGoogleLogin({
        upstreamURL: values.FONDS_NEON_GOOGLE_AUTH_URL.replace(/\/$/, ""),
        allowedEmail: values.FONDS_GOOGLE_OWNER_EMAIL.toLowerCase(),
      }),
    },
    { forSetup: true },
  );
}

async function initializeDatabase(connectionString, values) {
  const { runtimeProvider } = await import("../../src/runtime/providers.js");
  runtimeProvider(values.FONDS_CONNECTION_PROVIDER);
  const { Pool } = await import("pg");
  const {
    ensurePostgresSchema,
    FINANCIAL_SESSION_OPTIONS,
    openPostgresDatabase,
  } = await import("../../src/storage/postgres/store.js");
  const { bindPostgresInstallation, neonInstallation } =
    await import("../../src/runtime/postgres-environment.js");
  const financialPool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
    options: FINANCIAL_SESSION_OPTIONS,
  });
  financialPool.on("error", () => {});
  const authPool = identityPool(Pool, connectionString);
  try {
    // A fresh database is migrated and bound to this env file's secrets in
    // one transaction; any other must already be bound to them.
    await bindPostgresInstallation(
      financialPool,
      neonInstallation(values).fingerprint,
    );
    const store = openPostgresDatabase(financialPool);
    await store.ensureConnection({
      id: values.FONDS_CONNECTION_ID,
      provider: values.FONDS_CONNECTION_PROVIDER,
    });
    await ensurePostgresSchema(authPool, "identity");
    const auth = await setupAuth(authPool, values);
    await auth.migrate();
    // Password sign-in stays disabled; this unrecorded password only creates the owner row.
    await auth.bootstrapOwner(randomBytes(32).toString("base64url"));
  } finally {
    await Promise.allSettled([financialPool.end(), authPool.end()]);
  }
}

/**
 * A one-time owner sign-in link, printed only to the operator who asked, and
 * only for the database bound to this env file's secrets.
 */
export async function issueLoginLink(connectionString, values) {
  const { Pool } = await import("pg");
  const { neonInstallation, verifyPostgresInstallation } =
    await import("../../src/runtime/postgres-environment.js");
  const authPool = identityPool(Pool, connectionString);
  try {
    await verifyPostgresInstallation(
      authPool,
      neonInstallation(values).fingerprint,
    );
    return await (await setupAuth(authPool, values)).issueOwnerLoginLink();
  } finally {
    await authPool.end();
  }
}

/** A POSIX shell word for a path. */
function shellWord(text) {
  return /^[A-Za-z0-9_./-]+$/.test(text)
    ? text
    : `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * `setup` initializes the deployment and its refresh schedule; `setup
 * login-link` prints a sign-in link and never asks anything.
 */
export async function setup(
  args,
  io = { input: process.stdin, output: process.stdout },
) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        "env-file": { type: "string" },
        "project-id": { type: "string" },
        "branch-id": { type: "string" },
        profile: { type: "string" },
        schedule: { type: "string" },
        timezone: { type: "string" },
        time: { type: "string" },
      },
    }));
  } catch {
    fail("Unknown or invalid option.");
  }
  const action = positionals[0] ?? "setup";
  if (positionals.length > 1 || !["setup", "login-link"].includes(action)) {
    fail("Unknown action; use setup or login-link.");
  }
  for (const name of ["project-id", "branch-id", "profile"]) {
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(values[name] ?? "")) {
      fail(`--${name} is required.`);
    }
  }
  const flags = {
    schedule: values.schedule,
    timeZone: values.timezone,
    time: values.time,
  };
  if (
    action === "login-link" &&
    Object.values(flags).some((text) => text !== undefined)
  ) {
    fail("--schedule, --timezone and --time apply only to setup.");
  }
  const schedule = scheduleSource(flags, io);
  const path = await privateEnvironmentPath(resolve(values["env-file"] ?? ""));
  if (action === "login-link") {
    const environment = await prepareEnvironmentFile(path, {
      generate: false,
    });
    try {
      return {
        loginLink: await issueLoginLink(
          await directConnectionString(
            values["project-id"],
            values["branch-id"],
            values.profile,
          ),
          environment.values,
        ),
      };
    } catch (error) {
      const { StateError } = await import("../../src/runtime/state.js");
      fail(
        error instanceof StateError
          ? error.message
          : "Login link failed. Run setup first; credentials and driver diagnostics were suppressed.",
      );
    }
  }
  return withSetupLock(path, async () => {
    const environment = await prepareEnvironmentFile(path, { schedule });
    try {
      await initializeDatabase(
        await directConnectionString(
          values["project-id"],
          values["branch-id"],
          values.profile,
        ),
        environment.values,
      );
    } catch (error) {
      const { StateError } = await import("../../src/runtime/state.js");
      fail(
        error instanceof StateError
          ? error.message
          : "Database setup failed; the env file was kept. Credentials and driver diagnostics were suppressed.",
      );
    }
    return {
      generated: environment.generated,
      changed: environment.changed,
      schedule: scheduleSummary(environment.values),
      deploy: [
        "npm run neon:deploy -- --env",
        shellWord(path),
        `--project-id ${values["project-id"]}`,
        `--branch ${values["branch-id"]}`,
        `--profile ${values.profile}`,
      ].join(" "),
    };
  });
}

/** What setup prints: setting names and the schedule, never a value of a secret. */
export function setupReport({ generated, changed, schedule, deploy }) {
  return [
    "Neon schemas, configured connection and owner are ready.",
    generated.length ? `Generated ${generated.join(", ")}.` : "",
    changed.length ? `Updated ${changed.join(", ")}.` : "",
    schedule,
    `Deploy to apply the env file:\n  ${deploy}`,
    generated.includes("FONDS_REFRESH_SECRET")
      ? "A new installation's first deploy also names its provider credentials file (FONDS_CONNECTION_CREDENTIALS_FILE)."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await setup(process.argv.slice(2));
    if (result.loginLink) {
      // Shown only in this terminal: it signs in as the owner once, within ten minutes.
      console.log(
        `Open this one-time owner sign-in link within ten minutes:\n${result.loginLink}`,
      );
    } else {
      console.log(setupReport(result));
    }
  } catch (error) {
    console.error(
      error instanceof SetupError ? error.message : "Setup failed.",
    );
    process.exitCode = 1;
  }
}
