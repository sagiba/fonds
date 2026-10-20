// Declarative Neon deployment: `neon deploy --env <private file> --no-env-pull`.
// Values come from the private env file (see docs/guides/neon-deployment.md); this file
// holds names and policy only. Never add secret values or `.env` files to Git.
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

import { defineConfig } from "@neon/config/v1";

import { parseCredentials } from "./src/domain/credentials.js";
import {
  parseCollectionSchedule,
  utcCron,
} from "./src/runtime/collection-schedule.js";
import { parseCredentialsKey } from "./src/runtime/credential-vault.js";
import { runtimeProvider } from "./src/runtime/providers.js";

const REQUIRED = [
  "FONDS_PUBLIC_ORIGIN",
  "FONDS_OWNER_ID",
  "FONDS_AUTH_SECRET",
  "FONDS_REFRESH_SECRET",
  "FONDS_CONNECTION_ID",
  "FONDS_CONNECTION_PROVIDER",
  "FONDS_NEON_GOOGLE_AUTH_URL",
  "FONDS_GOOGLE_OWNER_EMAIL",
] as const;

/** An owned, unlinked 0600 regular file; never a symlink, FIFO or large file. */
function readPrivateFile(path: string): string {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 16_384
    ) {
      throw new Error("Provider credentials file must be a private 0600 file");
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

const env: Record<string, string> = {};
for (const name of REQUIRED) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is missing; deploy with --env <private file>`);
  }
  env[name] = value;
}

// Optional: decrypts credentials stored by `connect`, so every such connection
// is refreshed, not only the env-configured one.
const credentialsKey = process.env.FONDS_CREDENTIALS_KEY;
if (credentialsKey) {
  try {
    parseCredentialsKey(credentialsKey);
  } catch {
    throw new Error("FONDS_CREDENTIALS_KEY is not a valid credentials key");
  }
  env.FONDS_CREDENTIALS_KEY = credentialsKey;
}

// Provider credentials are uploaded only when explicitly supplied. Neon merges
// omitted Function variables, so ordinary deploys keep stored credentials.
const credentialsFile = process.env.FONDS_CONNECTION_CREDENTIALS_FILE;
if (credentialsFile) {
  const text = readPrivateFile(credentialsFile);
  try {
    const provider = runtimeProvider(env.FONDS_CONNECTION_PROVIDER!);
    const credentials = parseCredentials(
      JSON.parse(text),
      provider.credentials,
    );
    env.FONDS_CONNECTION_CREDENTIALS = JSON.stringify(credentials);
  } catch {
    throw new Error(
      "Provider credentials file does not match the configured provider",
    );
  }
}

// Schedule state lives in the private env file so a deploy never flips it;
// when absent (fresh environments) scheduled refresh stays off. Neon cron is UTC
// only: local hours convert with the zone's offset at deploy time.
const schedule = parseCollectionSchedule(
  process.env,
  "FONDS_REFRESH_SCHEDULE is on but FONDS_REFRESH_TIME is missing; rerun npm run neon:setup",
);

export default defineConfig({
  functions: {
    fonds: {
      name: "Fonds",
      source: "deploy/neon/function.ts",
      env,
    },
  },
  triggers: {
    // The name is the trigger's identity: renaming it adds a second trigger
    // instead of updating this one.
    "scheduled-refresh": {
      type: "schedule",
      function: "fonds",
      // A disabled trigger keeps the cron it was declared with.
      cron: schedule ? utcCron(schedule, Date.now()) : "12 * * * *",
      functionPath: "/internal/triggers/recent",
      enabled: schedule !== undefined,
    },
  },
});
