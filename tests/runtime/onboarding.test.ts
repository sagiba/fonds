import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

const cli = resolve("src/cli.ts");
let directory: string;
let home: string;
let state: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fonds-onboarding-"));
  home = join(directory, "data");
  state = join(directory, "state");
  mkdirSync(state, { mode: 0o700 });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run(args: string[], credentials?: object) {
  let fd: number | undefined;
  if (credentials) {
    const file = join(directory, "invented.json");
    writeFileSync(file, JSON.stringify(credentials), { mode: 0o600 });
    fd = openSync(file, "r");
  }
  try {
    return spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        cli,
        ...args,
        ...(fd !== undefined ? ["--credentials-fd", "3"] : []),
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !key.startsWith("FONDS_"),
            ),
          ),
          FONDS_HOME: home,
          FONDS_STATE_DIR: state,
        },
        stdio: fd === undefined ? "pipe" : ["pipe", "pipe", "pipe", fd],
      },
    );
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

const credentials = {
  username: "INVENTED-LOGIN",
  password: "INVENTED-PASSWORD",
};
const connections = () =>
  JSON.parse(run(["list-connections"]).stdout).data as {
    id: string;
    provider: string;
  }[];

it("requires storage initialization before connect or offline ingestion", () => {
  for (const args of [
    ["connect", "cal"],
    ["connect", "isracard", "--offline"],
    [
      "ingest",
      "--connection",
      "cal",
      "--account",
      "synthetic",
      "--run",
      "synthetic",
      "--file",
      resolve("tests/providers/cal/fixtures/recent-01.json"),
    ],
  ]) {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("run fonds init first");
    expect(existsSync(join(home, "fonds.sqlite"))).toBe(false);
    expect(existsSync(join(state, "fonds.env"))).toBe(false);
  }
});

it("initializes only storage, then adds default and named logins without overwriting existing credentials", () => {
  expect(run(["init"]).status).toBe(0);
  const originalState = readFileSync(join(state, "fonds.env"), "utf8");
  expect(connections()).toEqual([]);
  for (const [args, input] of [
    [["connect", "cal"], credentials],
    [["connect", "isracard"], { ...credentials, cardSuffix: "123456" }],
    [
      ["connect", "cal", "--name", "cal-other"],
      { ...credentials, username: "INVENTED-OTHER" },
    ],
  ] as const) {
    const result = run([...args], input);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).credentials).toBe("stored");
    expect(result.stdout + result.stderr).not.toContain("INVENTED-");
  }
  expect(
    connections()
      .map(({ id, provider }) => ({ id, provider }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  ).toEqual([
    { id: "cal", provider: "cal" },
    { id: "cal-other", provider: "cal" },
    { id: "isracard", provider: "isracard" },
  ]);
  const before = readFileSync(join(home, "fonds.sqlite"));
  for (const args of [
    ["connect", "cal"],
    ["connect", "isracard", "--name", "cal"],
    ["connect", "cal", "--name", "cal-other", "--offline"],
  ]) {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(result.stderr).not.toContain("interactive terminal");
  }
  expect(readFileSync(join(home, "fonds.sqlite"))).toEqual(before);
  expect(run(["init"]).status).toBe(0);
  expect(connections()).toHaveLength(3);
  expect(readFileSync(join(state, "fonds.env"), "utf8")).toBe(originalState);
  expect(
    run(["connect", "--connection", "cal-other"], credentials).status,
  ).toBe(0);
}, 30_000);

it("leaves no new login after missing or invalid credentials and refuses mixed targeting flags", () => {
  expect(run(["init"]).status).toBe(0);
  expect(run(["connect", "cal"]).stderr).toContain("interactive terminal");
  expect(run(["connect", "isracard"], credentials).status).toBe(1);
  for (const args of [
    ["connect", "cal", "--connection", "cal"],
    ["connect", "cal", "extra"],
    ["connect", "--name", "cal"],
    ["connect", "cal", "--name", "..", "--offline"],
    ["connect", "cal", "--offline", "--credentials-fd", "3"],
    ["init", "--provider", "cal"],
  ]) {
    expect(run(args).status).toBe(1);
  }
  expect(connections()).toEqual([]);
  expect(run(["connect", "cal", "--offline"]).status).toBe(0);
  const refresh = run(["refresh"]);
  expect(refresh.status).toBe(0);
  expect(refresh.stderr).toContain("No connections have saved credentials");
}, 30_000);

it("accepts the connection filter alias and exposes choices and global flags in help", () => {
  expect(run(["init"]).status).toBe(0);
  expect(run(["connect", "cal", "--offline"]).status).toBe(0);
  expect(run(["totals", "--connection", "cal"]).stdout).toEqual(
    run(["totals", "--connection-id", "cal"]).stdout,
  );
  expect(
    run(["list", "--connection", "cal", "--connection-id", "cal"]).stderr,
  ).toContain("not both");
  const help = run(["help", "list"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("--status <posted|pending>");
  expect(help.stdout).toContain("--db");
  expect(help.stdout).toContain("--remote");
  expect(help.stdout).toContain("--token-file");
});

it("does not regenerate lost state for an existing SQLite ledger", () => {
  expect(run(["init"]).status).toBe(0);
  rmSync(join(state, "fonds.env"));
  expect(run(["init"]).status).toBe(1);
  expect(existsSync(join(state, "fonds.env"))).toBe(false);
});
