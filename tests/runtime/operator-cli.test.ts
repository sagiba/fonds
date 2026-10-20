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
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { operationDefinitions } from "../../src/application/operations.js";
import { main, sqliteBackend } from "../../src/cli.js";
import { resolveInstallation } from "../../src/runtime/installation.js";
import {
  collectionSummarySchema,
  EXIT_CODES,
  type OperatorBackend,
  operatorCommandFlags,
  runOperatorCli,
  selectedBackend,
} from "../../src/runtime/operator-cli.js";
import {
  postgresBackend,
  runPostgresCommand,
} from "../../src/runtime/postgres-cli.js";

const collected = vi.hoisted(() => ({ connections: [] as unknown[] }));

vi.mock("../../src/providers/cal/collect.js", () => ({
  CAL_COLLECTOR_VERSION: "synthetic-operator-cli-v1",
  async *collectCal(options: { credentials: unknown }) {
    collected.connections.push(options.credentials);
    yield {
      type: "capture",
      capture: {
        accountKey: "SYNTHETIC-ACCOUNT",
        endpoint: "synthetic:cal/recent",
        capturedAt: "2040-06-01T00:00:00Z",
        responseText: readFileSync(
          new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
          "utf8",
        ),
        scope: { kind: "recent" },
      },
    };
  },
}));

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs one entry point in process, capturing its output. */
async function capture(work: () => Promise<number>): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const out = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      stdout += String(chunk);
      (
        rest.find((entry) => typeof entry === "function") as
          (() => void) | undefined
      )?.();
      return true;
    });
  const err = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
  try {
    return { status: await work(), stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

/** The two entry points; these cases need no PostgreSQL database. */
const entryPoints = {
  sqlite: (args: string[]) => capture(() => main(args)),
  postgres: (args: string[]) =>
    capture(() => runPostgresCommand(args, {}, undefined)),
};

const commands = Object.keys(operatorCommandFlags());

/** What each backend genuinely lacks; everything else must run on both. */
const lacking = { sqlite: ["login-link"], postgres: ["demo", "backup"] };

describe("one operator CLI for every backend", () => {
  it("prints the same usage on every entry point, apart from its own paragraph", async () => {
    const usages = await Promise.all([
      entryPoints.sqlite(["--help"]),
      entryPoints.postgres(["--help"]),
    ]);
    const shared = (text: string) =>
      text.slice(text.indexOf("Operation commands run"));
    for (const usage of usages) {
      expect(usage).toMatchObject({ status: EXIT_CODES.ok, stderr: "" });
      for (const name of commands) {
        expect(usage.stdout).toMatch(new RegExp(`^  ${name}( |$)`, "m"));
      }
    }
    expect(shared(usages[1]!.stdout)).toBe(shared(usages[0]!.stdout));
  });

  it("reports the package version on every entry point", async () => {
    const { version } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    for (const result of await Promise.all([
      entryPoints.sqlite(["--version"]),
      entryPoints.postgres(["--version"]),
    ])) {
      expect(result).toEqual({
        status: EXIT_CODES.ok,
        stdout: `${version}\n`,
        stderr: "",
      });
    }
  });

  it.each([
    ...commands,
    ...operationDefinitions.map((definition) =>
      definition.name.replace(/_/g, "-"),
    ),
  ])(
    "offers %s with the same flags and help on every backend",
    async (name) => {
      const sqlite = await entryPoints.sqlite([name, "--help"]);
      expect(sqlite).toMatchObject({ status: EXIT_CODES.ok, stderr: "" });
      expect(await entryPoints.postgres([name, "--help"])).toEqual(sqlite);
    },
  );

  it.each(Object.entries(lacking))(
    "names each command %s lacks in one line with its own exit code",
    async (name, missing) => {
      const backend =
        name === "sqlite" ? sqliteBackend() : postgresBackend({}, undefined);
      const label = name === "sqlite" ? "SQLite" : "PostgreSQL";
      for (const command of commands) {
        expect(
          backend.unavailable[command as keyof typeof backend.unavailable] !==
            undefined,
        ).toBe(missing.includes(command));
      }
      for (const command of missing) {
        const result = await entryPoints[name as keyof typeof entryPoints](
          command === "backup" ? [command, "--out", "/unused"] : [command],
        );
        expect(result.status).toBe(EXIT_CODES.unavailable);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(
          new RegExp(`^${command} is not available on ${label}: [^\\n]+\\n$`),
        );
      }
    },
  );

  it("selects PostgreSQL by its connection URL, otherwise SQLite", async () => {
    expect(selectedBackend({})).toBe("sqlite");
    expect(
      selectedBackend({ FONDS_DATABASE_URL: "postgresql://localhost/x" }),
    ).toBe("postgres");
    expect(selectedBackend({ FONDS_DATABASE_URL: "libsql://x.invalid" })).toBe(
      "sqlite",
    );
    vi.stubEnv("FONDS_DATABASE_URL", "postgresql://127.0.0.1:1/unused");
    try {
      expect(await entryPoints.sqlite(["list-connections"])).toEqual({
        status: EXIT_CODES.failed,
        stdout: "",
        stderr:
          "FONDS_DATABASE_URL selects PostgreSQL: run this command with the PostgreSQL target's node server.js, or unset it to use SQLite.\n",
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await entryPoints.postgres(["list-connections"])).toEqual({
      status: EXIT_CODES.failed,
      stdout: "",
      stderr:
        "FONDS_STATE_DIR is required: it holds this installation's secrets\n",
    });
    const stateDir = mkdtempSync(join(tmpdir(), "fonds-operator-state-"));
    try {
      await resolveInstallation(stateDir, { create: true });
      expect(
        await capture(() =>
          runPostgresCommand(
            ["list-connections"],
            { FONDS_STATE_DIR: stateDir },
            undefined,
          ),
        ),
      ).toEqual({
        status: EXIT_CODES.failed,
        stdout: "",
        stderr:
          "FONDS_DATABASE_URL is required; without it, use the SQLite CLI (node dist/cli.js).\n",
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("collect on SQLite", () => {
  let directory: string;
  let dbPath: string;

  beforeEach(() => {
    collected.connections = [];
    directory = mkdtempSync(join(tmpdir(), "fonds-operator-cli-"));
    dbPath = join(directory, "ledger.sqlite");
    const stateDir = join(directory, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    vi.stubEnv("FONDS_STATE_DIR", stateDir);
    vi.stubEnv("FONDS_CREDENTIALS_KEY", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  const run = (...args: string[]) =>
    entryPoints.sqlite([...args, "--db", dbPath]);

  async function connect(connection: string, username: string) {
    const path = join(directory, `${connection}.json`);
    writeFileSync(
      path,
      JSON.stringify({ username, password: "INVENTED-PASSWORD" }),
      { mode: 0o600 },
    );
    const fd = openSync(path, "r");
    try {
      expect(
        (
          await run(
            "connect",
            "--connection",
            connection,
            "--credentials-fd",
            String(fd),
          )
        ).status,
      ).toBe(0);
    } finally {
      closeSync(fd);
    }
  }

  it("reports a failed discovery of stored connections as a failed run", async () => {
    expect(
      (await run("init", "--connection", "first", "--provider", "cal")).status,
    ).toBe(0);
    const base = sqliteBackend();
    const failing: OperatorBackend = {
      ...base,
      async open(globals, mode) {
        const session = await base.open(globals, mode);
        return {
          ...session,
          store: {
            ...session.store,
            listConnections: async () => {
              throw new Error("synthetic discovery failure");
            },
          },
        };
      },
    };
    const result = await capture(() =>
      runOperatorCli(failing, ["refresh", "--db", dbPath]),
    );
    expect(result.status).toBe(EXIT_CODES.failed);
    expect(collectionSummarySchema.parse(JSON.parse(result.stdout))).toEqual({
      type: "refresh_summary",
      status: "failed",
      captures: 0,
      unchanged: 0,
      observed: 0,
      unchangedTransactions: 0,
      unlisted: 0,
      failures: 1,
      created: 0,
      updated: 0,
    });
    expect(result.stderr).not.toContain("synthetic discovery failure");
  });

  it("offers bounded sync diagnostics only when requested and validates archive duration", async () => {
    await run("init", "--connection", "diagnostic", "--provider", "cal");
    await connect("diagnostic", "INVENTED-DIAGNOSTIC");
    const first = await run("refresh", "--connection", "diagnostic");
    expect(first.status).toBe(EXIT_CODES.ok);
    expect(
      collectionSummarySchema.parse(JSON.parse(first.stdout)),
    ).not.toHaveProperty("diagnostics");
    const second = await run(
      "refresh",
      "--connection",
      "diagnostic",
      "--diagnostics",
      "--archive-days",
      "2",
    );
    expect(second.status).toBe(EXIT_CODES.ok);
    const summary = collectionSummarySchema.parse(JSON.parse(second.stdout));
    expect(summary).toMatchObject({
      observed: 21,
      unchangedTransactions: 21,
      created: 0,
      updated: 0,
      unlisted: 0,
      diagnostics: { dropped: 0, truncated: false },
    });
    expect(summary.diagnostics!.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "ingest",
          outcome: "completed",
          counts: expect.objectContaining({
            observed: 21,
            unchangedTransactions: 21,
            changed: 0,
          }),
        }),
      ]),
    );
    expect(
      new Set(summary.diagnostics!.entries.map((entry) => entry.stage)),
    ).toEqual(
      new Set([
        "refresh",
        "recovery",
        "collection",
        "capture",
        "ingest",
        "archive",
        "extraction",
        "reconciliation",
        "commit",
        "purge",
        "observation",
      ]),
    );
    const entries = summary.diagnostics!.entries;
    const extracted = entries.find(
      (entry) => entry.stage === "extraction" && entry.outcome === "completed",
    )!;
    expect(extracted.counts).toMatchObject({ extracted: 21 });
    expect(extracted.counts).not.toHaveProperty("observed");
    expect(
      entries.every((entry) => entry.refreshId === entries[0]!.refreshId),
    ).toBe(true);
    expect(second.stdout).not.toContain("INVENTED-");
    expect(second.stdout).not.toContain("SYNTHETIC-ACCOUNT");
    for (const days of ["0", "31", "1.5", "-1", "secret"]) {
      expect(await run("refresh", `--archive-days=${days}`)).toEqual({
        status: EXIT_CODES.failed,
        stdout: "",
        stderr: "--archive-days must be an integer from 1 through 30.\n",
      });
    }
  });

  it("prints one summary shape for every stored connection and for one", async () => {
    for (const connection of ["first", "second", "without-credentials"]) {
      expect(
        (await run("init", "--connection", connection, "--provider", "cal"))
          .status,
      ).toBe(0);
    }
    await connect("first", "INVENTED-FIRST");
    await connect("second", "INVENTED-SECOND");
    const all = await run("refresh");
    expect(all).toMatchObject({ status: EXIT_CODES.ok, stderr: "" });
    const summary = collectionSummarySchema.parse(JSON.parse(all.stdout));
    expect(summary).toMatchObject({
      type: "refresh_summary",
      status: "completed",
      captures: 2,
      failures: 0,
    });
    expect(collected.connections).toEqual([
      { username: "INVENTED-FIRST", password: "INVENTED-PASSWORD" },
      { username: "INVENTED-SECOND", password: "INVENTED-PASSWORD" },
    ]);
    expect(all.stdout).not.toContain("INVENTED");
    const one = await run(
      "refresh",
      "--connection",
      "second",
      "--from",
      "2040-05-01",
      "--to",
      "2040-05-31",
    );
    expect(one.status).toBe(EXIT_CODES.ok);
    expect(collectionSummarySchema.parse(JSON.parse(one.stdout))).toMatchObject(
      {
        status: "completed",
        captures: 1,
        requestedRange: { from: "2040-05-01", to: "2040-05-31" },
      },
    );
    expect(await run("refresh", "--call-budget", "5")).toEqual({
      status: EXIT_CODES.failed,
      stdout: "",
      stderr: "--credentials-fd and the provider options need --connection.\n",
    });
    expect(await run("refresh", "--max-details", "0")).toEqual({
      status: EXIT_CODES.failed,
      stdout: "",
      stderr: "--credentials-fd and the provider options need --connection.\n",
    });
  });
});
