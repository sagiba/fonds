import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import { runPostgresCommand } from "../../src/runtime/postgres-cli.js";
import { dropWhenIdle } from "../helpers/postgres-database.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;

/** Runs one entry point in process; timestamps are the only expected difference. */
async function capture(work: () => Promise<number>) {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: unknown, ...rest: unknown[]) => {
      stdout += String(chunk);
      (
        rest.find((entry) => typeof entry === "function") as
          (() => void) | undefined
      )?.();
      return true;
    },
  );
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const status = await work();
    return {
      status,
      stdout: stdout.replace(
        /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g,
        "<time>",
      ),
      stderr,
    };
  } finally {
    vi.restoreAllMocks();
  }
}

// The same command sequence on both backends, from a fresh state directory and
// database each: every command's exit code, output and message must agree.
const scenario: string[][] = [
  ["init"],
  ["init"],
  ["connect", "cal", "--name", "parity", "--offline"],
  ["connect", "cal", "--name", "parity", "--offline"],
  ["connect", "unknown-provider", "--name", "other", "--offline"],
  ["list-connections"],
  ["get-connection", "--connection-id", "parity"],
  ["connect", "--connection", "missing"],
  ["refresh"],
  ["refresh", "--connection", "missing"],
  ["refresh", "--call-budget", "5"],
  ["refresh", "--live"],
  ["consume", "--connection", "parity", "--consumer", "parity-consumer"],
  ["consume", "--connection", "missing", "--consumer", "parity-consumer"],
  ["list-connections", "--remote", "http://127.0.0.1:1"],
  ["frobnicate"],
  // No command, only an option; bare `fonds` is the backend's own overview.
  ["--bogus"],
];

describe.skipIf(!postgresUrl)("one operator CLI behavior", () => {
  let admin: Pool;
  let databaseName: string;
  let directory: string;
  let sqlite: (args: string[]) => ReturnType<typeof capture>;
  let postgres: (args: string[]) => ReturnType<typeof capture>;

  beforeEach(async () => {
    admin = new Pool({ connectionString: postgresUrl });
    databaseName = `fonds_parity_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${databaseName}`;
    directory = mkdtempSync(join(tmpdir(), "fonds-operator-parity-"));
    const sqliteState = join(directory, "sqlite-state");
    const postgresState = join(directory, "postgres-state");
    mkdirSync(sqliteState, { mode: 0o700 });
    mkdirSync(postgresState, { mode: 0o700 });
    const dbPath = join(directory, "parity.sqlite");
    sqlite = (args) =>
      capture(() =>
        // SQLite's --db is its own global flag; --remote opens no database.
        main(
          args.length && !args.includes("--remote")
            ? [...args, "--db", dbPath]
            : args,
          {
            ...process.env,
            FONDS_STATE_DIR: sqliteState,
          },
        ),
      );
    postgres = (args) =>
      capture(() =>
        runPostgresCommand(
          args,
          {
            ...process.env,
            FONDS_STATE_DIR: postgresState,
            FONDS_DATABASE_URL: url.href,
          },
          undefined,
        ),
      );
  });

  afterEach(async () => {
    rmSync(directory, { recursive: true, force: true });
    // Every pool and store has ended; FORCE could kill one still ending.
    await dropWhenIdle(admin, databaseName);
    await admin.end();
  });

  it("gives every command the same exit code, output and message on both backends", async () => {
    for (const args of scenario) {
      const [onSqlite, onPostgres] = [await sqlite(args), await postgres(args)];
      expect(onPostgres, args.join(" ")).toEqual(onSqlite);
    }
  });
});
