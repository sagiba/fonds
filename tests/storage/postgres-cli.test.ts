import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplication } from "../../src/application/operations.js";
import { resolveInstallation } from "../../src/runtime/installation.js";
import { collectionSummarySchema } from "../../src/runtime/operator-cli.js";
import { runPostgresCommand } from "../../src/runtime/postgres-cli.js";
import { financialPoolConfig } from "../../src/runtime/postgres-environment.js";
import { openPostgresDatabase } from "../../src/storage/postgres/store.js";
import { dropWhenIdle } from "../helpers/postgres-database.js";

const collected = vi.hoisted(() => ({
  credentials: [] as unknown[],
  outcome: "completed" as "completed" | "partial" | "failed",
}));

vi.mock("../../src/providers/cal/collect.js", () => ({
  CAL_COLLECTOR_VERSION: "synthetic-postgres-cli-v1",
  async *collectCal(options: { credentials: unknown }) {
    collected.credentials.push(options.credentials);
    if (collected.outcome === "failed") {
      throw new Error("synthetic provider outage");
    }
    yield {
      type: "capture",
      capture: {
        accountKey: "SYNTHETIC-PRIVATE-ACCOUNT",
        endpoint: "synthetic:cal/recent",
        capturedAt: "2040-06-01T00:00:00Z",
        responseText: readFileSync(
          new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
          "utf8",
        ),
        scope: { kind: "recent" },
      },
    };
    if (collected.outcome === "partial") {
      yield {
        type: "failure",
        failure: {
          accountKey: null,
          endpoint: "synthetic:cal/history",
          code: "invalid_response",
        },
        fatal: false,
      };
    }
  },
}));

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)("PostgreSQL operator CLI", () => {
  let admin: Pool;
  let databaseName: string;
  let env: NodeJS.ProcessEnv;
  let directory: string;

  /** Runs one command in process, capturing its stdout lines and stderr. */
  async function command(...args: string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((text) => {
      stdout.push(String(text));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      stderr.push(String(text));
      return true;
    });
    try {
      const status = await runPostgresCommand(args, env, directory);
      return { status, stdout: stdout.join(""), stderr: stderr.join("") };
    } finally {
      vi.restoreAllMocks();
    }
  }

  beforeEach(async () => {
    collected.credentials = [];
    collected.outcome = "completed";
    admin = new Pool({ connectionString: postgresUrl });
    databaseName = `fonds_cli_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${databaseName}`;
    directory = mkdtempSync(join(tmpdir(), "fonds-pg-cli-"));
    const stateDir = join(directory, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    await resolveInstallation(stateDir, { create: true });
    env = { FONDS_DATABASE_URL: url.href, FONDS_STATE_DIR: stateDir };
    expect(
      await command("init", "--connection", "cal-pg", "--provider", "cal"),
    ).toMatchObject({ status: 0 });
    const path = join(directory, "invented.json");
    writeFileSync(
      path,
      JSON.stringify({
        username: "INVENTED-PRIVATE-USER",
        password: "INVENTED-PRIVATE-PASSWORD",
      }),
      { mode: 0o600 },
    );
    const fd = openSync(path, "r");
    const notes: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((text) => {
        notes.push(String(text));
        return true;
      });
    try {
      // The fd's file lives outside the injected checkout directory below.
      expect(
        await runPostgresCommand(
          ["connect", "--connection", "cal-pg", "--credentials-fd", String(fd)],
          env,
          undefined,
        ),
      ).toBe(0);
    } finally {
      stderr.mockRestore();
      closeSync(fd);
    }
    // A stored connection is collected only once a schedule is turned on.
    expect(notes.join("")).toBe(
      "Scheduled collection runs only when the service sets FONDS_COLLECTION_SCHEDULE=daily (or hourly, or hours such as 9,13,18).\n",
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
    // Every pool and store has ended; FORCE could kill one still ending.
    await dropWhenIdle(admin, databaseName);
    await admin.end();
  });

  it("collects with stored credentials under the poller's lock and job status", async () => {
    const first = await command("collect", "--connection", "cal-pg");
    expect(first.status).toBe(0);
    // The same summary schema as SQLite's (tests/runtime/operator-cli.test.ts).
    expect(
      collectionSummarySchema.parse(JSON.parse(first.stdout)),
    ).toMatchObject({
      type: "collection_summary",
      status: "completed",
      captures: 1,
      failures: 0,
    });
    expect(first.stdout).not.toContain("INVENTED-PRIVATE");
    expect(first.stderr).not.toContain("INVENTED-PRIVATE");
    expect(collected.credentials).toEqual([
      {
        username: "INVENTED-PRIVATE-USER",
        password: "INVENTED-PRIVATE-PASSWORD",
      },
    ]);

    // A lease another holder keeps (a crashed process's lasts a minute) is
    // retried with backoff: the run starts once it frees.
    const holder = openPostgresDatabase(
      financialPoolConfig(env.FONDS_DATABASE_URL!),
    );
    try {
      let collecting: ReturnType<typeof command> | undefined;
      await holder.withCollectionLock("cal-pg", async () => {
        collecting = command("collect", "--connection", "cal-pg");
        await new Promise((resolve) => setTimeout(resolve, 500));
      });
      const retried = await collecting!;
      expect(retried.status).toBe(0);
      expect(JSON.parse(retried.stdout)).toMatchObject({ status: "completed" });
    } finally {
      await holder.close();
    }
    expect(collected.credentials).toHaveLength(2);

    const connection = await command(
      "get-connection",
      "--connection-id",
      "cal-pg",
    );
    expect(connection.status).toBe(0);
    expect(
      JSON.parse(connection.stdout).connection.latestRefresh,
    ).toMatchObject({
      status: "completed",
      requiresAttention: false,
    });
  });

  it("refuses another state directory and an unbound database, reads included", async () => {
    const mismatch =
      "These secrets do not match the database's installation; restore the state directory (fonds.env) backed up with this database\n";
    const original = env;
    const otherState = join(directory, "other-state");
    mkdirSync(otherState, { mode: 0o700 });
    await resolveInstallation(otherState, { create: true });
    env = { ...original, FONDS_STATE_DIR: otherState };
    for (const args of [
      ["list-connections"],
      ["init", "--connection", "other", "--provider", "cal"],
      ["collect", "--connection", "cal-pg"],
    ]) {
      expect(await command(...args)).toEqual({
        status: 1,
        stdout: "",
        stderr: mismatch,
      });
    }
    env = { ...original, FONDS_STATE_DIR: join(directory, "missing") };
    expect(await command("list-connections")).toMatchObject({
      status: 1,
      stderr: `The state directory ${join(directory, "missing")} does not exist\n`,
    });
    env = original;
    const pool = new Pool({ connectionString: env.FONDS_DATABASE_URL });
    pool.on("error", () => {});
    try {
      await pool.query("DROP TABLE operations.installation");
      expect(await command("list-connections")).toEqual({
        status: 1,
        stdout: "",
        stderr:
          "This database has no installation record; open it with the state directory it was created with, or initialize a new database\n",
      });
      // Comparing writes nothing, not even the table.
      expect(
        (await pool.query("SELECT to_regclass('operations.installation') AS t"))
          .rows[0].t,
      ).toBeNull();
      // An existing schema is never bound again, even with no rows left.
      await pool.query("DELETE FROM operations.provider_credentials");
      await pool.query("DELETE FROM financial.connections");
      expect(
        await command("init", "--connection", "again", "--provider", "cal"),
      ).toEqual({
        status: 1,
        stdout: "",
        stderr:
          "This database has a Fonds schema but no installation record; restore its original secrets and installation\n",
      });
    } finally {
      await pool.end();
    }
    expect(collected.credentials).toEqual([]);
  });

  it("collects every connection with stored credentials without --connection", async () => {
    expect(
      (
        await command(
          "init",
          "--connection",
          "no-credentials",
          "--provider",
          "cal",
        )
      ).status,
    ).toBe(0);
    const all = await command("collect");
    expect(all.status).toBe(0);
    expect(collectionSummarySchema.parse(JSON.parse(all.stdout))).toEqual({
      type: "collection_summary",
      status: "completed",
      captures: 1,
      unchanged: 0,
      failures: 0,
      created: 21,
      updated: 0,
      observed: 21,
      unchangedTransactions: 0,
      unlisted: 0,
    });
    expect(collected.credentials).toHaveLength(1);
    expect(await command("demo")).toMatchObject({ status: 3, stdout: "" });
  });

  it("serves MCP over stdio with protocol-only stdout", async () => {
    const client = new Client({ name: "postgres-stdio-test", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          resolve("src/targets/postgres.ts"),
          "--transport",
          "stdio",
        ],
        env: {
          PATH: process.env.PATH ?? "",
          FONDS_DATABASE_URL: env.FONDS_DATABASE_URL!,
          FONDS_STATE_DIR: env.FONDS_STATE_DIR!,
        },
        stderr: "pipe",
      }),
    );
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain(
        "refresh_connection",
      );
      const result = await client.callTool({
        name: "list_connections",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        data: [expect.objectContaining({ id: "cal-pg" })],
      });
    } finally {
      await client.close();
    }
  });

  it("refuses a newer or altered schema in every command, changing nothing", async () => {
    const pool = new Pool(financialPoolConfig(env.FONDS_DATABASE_URL!));
    const commands = [
      ["list-connections"],
      ["connect", "--connection", "cal-pg"],
      ["collect", "--connection", "cal-pg"],
    ];
    const versions = async () =>
      (
        await pool.query(
          "SELECT version FROM schema_migrations ORDER BY version",
        )
      ).rows;
    try {
      const before = await versions();
      await pool.query("INSERT INTO schema_migrations(version) VALUES (99)");
      for (const args of commands) {
        const result = await command(...args);
        expect(result).toMatchObject({ status: 1, stdout: "" });
        expect(result.stderr).toMatch(/newer than this Fonds release/);
      }
      await pool.query("DELETE FROM schema_migrations WHERE version = 99");
      await pool.query("CREATE TABLE operations.extra (id text)");
      for (const args of commands) {
        expect(await command(...args)).toMatchObject({ status: 1, stdout: "" });
      }
      expect(await versions()).toEqual(before);
    } finally {
      await pool.end();
    }
    expect(collected.credentials).toEqual([]);
  });

  it("reports partial and failed collection with distinct exit codes", async () => {
    for (const [outcome, status, exitCode] of [
      ["partial", "partial", 2],
      ["failed", "failed", 1],
    ] as const) {
      collected.outcome = outcome;
      const result = await command("collect", "--connection", "cal-pg");
      expect(result.status).toBe(exitCode);
      expect(JSON.parse(result.stdout)).toMatchObject({ status });
      expect(result.stderr).not.toContain("synthetic provider outage");
    }
  });

  it("prefers an explicit credentials descriptor over stored credentials", async () => {
    // Outside the directory `command` guards as the checkout.
    const outside = mkdtempSync(join(tmpdir(), "fonds-pg-override-"));
    const path = join(outside, "override.json");
    writeFileSync(
      path,
      JSON.stringify({
        username: "INVENTED-OVERRIDE-USER",
        password: "INVENTED-OVERRIDE-PASSWORD",
      }),
      { mode: 0o600 },
    );
    const fd = openSync(path, "r");
    try {
      expect(
        await command(
          "collect",
          "--connection",
          "cal-pg",
          "--credentials-fd",
          String(fd),
        ),
      ).toMatchObject({ status: 0 });
    } finally {
      closeSync(fd);
      rmSync(outside, { recursive: true, force: true });
    }
    expect(collected.credentials).toEqual([
      {
        username: "INVENTED-OVERRIDE-USER",
        password: "INVENTED-OVERRIDE-PASSWORD",
      },
    ]);
  });

  it("runs operation commands with the same output as the application", async () => {
    expect((await command("collect", "--connection", "cal-pg")).status).toBe(0);
    const store = openPostgresDatabase(
      financialPoolConfig(env.FONDS_DATABASE_URL!),
    );
    try {
      const application = createApplication(store);
      const direct = (name: string, input: unknown) =>
        application.operations
          .find((operation) => operation.name === name)!
          .execute(input);
      for (const [args, name, input] of [
        [["list-connections"], "list_connections", {}],
        [
          ["list-transactions", "--perspective", "all", "--limit", "3"],
          "list_transactions",
          { perspective: "all", limit: 3 },
        ],
        [
          ["totals", "--connection-id", "cal-pg"],
          "get_transaction_totals",
          { connectionId: "cal-pg" },
        ],
        [
          ["list-sync-runs", "--connection-id", "cal-pg"],
          "list_sync_runs",
          { connectionId: "cal-pg" },
        ],
      ] as const) {
        const result = await command(...args);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual(await direct(name, input));
      }
    } finally {
      await store.close();
    }
    // An embedded mutation, then the same read through the application.
    const [target] = (
      JSON.parse(
        (await command("list", "--perspective", "all", "--limit", "1")).stdout,
      ) as { data: { id: string }[] }
    ).data;
    const annotated = await command(
      "annotate",
      "--transaction-id",
      target!.id,
      "--expected-version",
      "0",
      "--notes",
      "Synthetic PostgreSQL note",
      "--tags",
      '["synthetic"]',
    );
    expect(annotated.status).toBe(0);
    expect(JSON.parse(annotated.stdout)).toEqual({
      annotation: { transactionId: target!.id, version: 1 },
    });
    const read = await command("get", "--transaction-id", target!.id);
    const verifier = openPostgresDatabase(
      financialPoolConfig(env.FONDS_DATABASE_URL!),
    );
    try {
      expect(JSON.parse(read.stdout)).toEqual(
        await createApplication(verifier)
          .operations.find((operation) => operation.name === "get_transaction")!
          .execute({ transactionId: target!.id }),
      );
      expect(JSON.parse(read.stdout).transaction.annotation).toMatchObject({
        notes: "Synthetic PostgreSQL note",
        tags: ["synthetic"],
      });
    } finally {
      await verifier.close();
    }
    expect(
      await command("refresh-connection", "--connection-id", "cal-pg"),
    ).toMatchObject({
      status: 1,
      stderr: "This operation is not available on this backend.\n",
    });
    expect(await command("unknown-command")).toMatchObject({ status: 1 });
    expect(
      await command("list-connections", "--remote", "http://127.0.0.1:1"),
    ).toMatchObject({ status: 1, stdout: "" });
  });
});
