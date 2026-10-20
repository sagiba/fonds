// Idempotent Neon setup: private env file, financial/operational/auth schemas,
// the configured connection row and the Better Auth owner. Never calls providers and never
// prints secrets, connection strings or driver diagnostics. Deployment itself is
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
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv, promisify } from "node:util";

const root = fileURLToPath(new URL("../..", import.meta.url));
const NEON_CLI = "neon@8.4.3";
const REQUIRED = [
  "FONDS_PUBLIC_ORIGIN",
  "FONDS_NEON_GOOGLE_AUTH_URL",
  "FONDS_GOOGLE_OWNER_EMAIL",
  "FONDS_COLLECTION_CONNECTION_ID",
  "FONDS_COLLECTION_PROVIDER",
];
const GENERATED = {
  FONDS_AUTH_SECRET: () => randomBytes(48).toString("base64url"),
  FONDS_OWNER_ID: () => randomUUID(),
  // Decrypts the credentials `connect` stores; part of the installation's binding.
  FONDS_CREDENTIALS_KEY: () => randomBytes(32).toString("base64url"),
  FONDS_COLLECTION_SECRET: () => randomBytes(48).toString("base64url"),
  // This installation's random collection time (UTC unless
  // FONDS_COLLECTION_TIMEZONE says otherwise), so installations do not all
  // reach a provider at the same minute.
  FONDS_COLLECTION_TIME: () =>
    [randomInt(24), randomInt(60)]
      .map((value) => String(value).padStart(2, "0"))
      .join(":"),
};
/** Generated settings a login link does not need. */
const SETTINGS = new Set(["FONDS_COLLECTION_TIME"]);

export class SetupError extends Error {}

function fail(message) {
  throw new SetupError(message);
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

/** Reads the private env file, adds missing generated secrets and saves it 0600. */
export async function prepareEnvironmentFile(
  requestedPath,
  { generate = true } = {},
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
  for (const [name, value] of Object.entries(values)) {
    // Unquoted dotenv values must stay single-line and comment-free.
    if (!/^[A-Za-z0-9_.:/@+=,-]+$/.test(value)) {
      fail(`${name} contains characters the env file cannot hold unquoted.`);
    }
  }
  if (generated.length) {
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
  return { values, generated };
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
  runtimeProvider(values.FONDS_COLLECTION_PROVIDER);
  const { Pool } = await import("pg");
  const { ensurePostgresSchema, openPostgresDatabase } =
    await import("../../src/storage/postgres/store.js");
  const { bindPostgresInstallation, neonInstallation } =
    await import("../../src/runtime/postgres-environment.js");
  const financialPool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
    options: "-c search_path=financial",
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
      id: values.FONDS_COLLECTION_CONNECTION_ID,
      provider: values.FONDS_COLLECTION_PROVIDER,
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

/** `setup` initializes the deployment; `setup login-link` prints a sign-in link. */
export async function setup(args) {
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
    const environment = await prepareEnvironmentFile(path);
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
    return { generated: environment.generated };
  });
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
      console.log(
        `Neon schemas, configured connection and owner are ready.${
          result.generated.length
            ? ` Generated ${result.generated.join(", ")}.`
            : ""
        }`,
      );
    }
  } catch (error) {
    console.error(
      error instanceof SetupError ? error.message : "Setup failed.",
    );
    process.exitCode = 1;
  }
}
