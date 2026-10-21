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

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import { createCredentialVault } from "../../src/runtime/credential-vault.js";
import { resolveInstallation } from "../../src/runtime/installation.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";

const cli = resolve("src/cli.ts");
let directory: string;
let home: string;
let state: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fonds-onboarding-"));
  home = join(directory, "data");
  state = join(directory, "state");
  mkdirSync(state, { mode: 0o700 });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("FONDS_")) {
      vi.stubEnv(key, undefined);
    }
  }
  vi.stubEnv("FONDS_HOME", home);
  vi.stubEnv("FONDS_STATE_DIR", state);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function credentialFile(credentials: object | undefined) {
  if (!credentials) {
    return undefined;
  }
  const file = join(directory, "invented.json");
  writeFileSync(file, JSON.stringify(credentials), { mode: 0o600 });
  return openSync(file, "r");
}

/** Exercise the real parser, storage and vault without paying for a cold CLI per assertion. */
async function run(args: string[], credentials?: object) {
  const fd = credentialFile(credentials);
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const status = await main([
      ...args,
      ...(fd !== undefined ? ["--credentials-fd", String(fd)] : []),
    ]);
    return { status, stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/** The separate-process smoke retains executable startup and inherited-fd coverage. */
function executable(args: string[], credentials?: object) {
  const fd = credentialFile(credentials);
  try {
    const result = spawnSync(
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
        stdio: fd === undefined ? "pipe" : ["pipe", "pipe", "pipe", fd],
      },
    );
    if (result.error) {
      throw result.error;
    }
    expect(result.signal).toBeNull();
    return result;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

async function json(args: string[]) {
  const result = await run(args);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const credentials = {
  username: "INVENTED-LOGIN",
  password: "INVENTED-PASSWORD",
};
const connections = async () =>
  (await json(["list-connections"])).data as { id: string; provider: string }[];

async function savedCredentials(id: string) {
  const { credentialsKey } = await resolveInstallation(state, {
    create: false,
  });
  const database = await openDatabase(join(home, "fonds.sqlite"));
  try {
    return await createCredentialVault(
      database.credentials,
      credentialsKey,
    ).load({ id, provider: "cal" });
  } finally {
    await database.close();
  }
}

it("requires storage initialization before connect or offline ingestion", async () => {
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
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("run fonds init first");
    expect(existsSync(join(home, "fonds.sqlite"))).toBe(false);
    expect(existsSync(join(state, "fonds.env"))).toBe(false);
  }
});

it("initializes only storage, then adds default and named logins without overwriting existing credentials", async () => {
  expect((await run(["init"])).status).toBe(0);
  const originalState = readFileSync(join(state, "fonds.env"), "utf8");
  expect(await connections()).toEqual([]);
  for (const [args, input] of [
    [["connect", "cal"], credentials],
    [["connect", "isracard"], { ...credentials, cardSuffix: "123456" }],
    [
      ["connect", "cal", "--name", "cal-other"],
      { ...credentials, username: "INVENTED-OTHER" },
    ],
  ] as const) {
    const result = await run([...args], input);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).credentials).toBe("stored");
    expect(result.stdout + result.stderr).not.toContain("INVENTED-");
  }
  expect(
    (await connections())
      .map(({ id, provider }) => ({ id, provider }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  ).toEqual([
    { id: "cal", provider: "cal" },
    { id: "cal-other", provider: "cal" },
    { id: "isracard", provider: "isracard" },
  ]);
  expect(await savedCredentials("cal")).toEqual(credentials);
  const other = { ...credentials, username: "INVENTED-OTHER" };
  expect(await savedCredentials("cal-other")).toEqual(other);
  for (const args of [
    ["connect", "cal"],
    ["connect", "isracard", "--name", "cal"],
    ["connect", "cal", "--name", "cal-other", "--offline"],
  ]) {
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(result.stderr).not.toContain("interactive terminal");
  }
  expect(await savedCredentials("cal")).toEqual(credentials);
  expect(await savedCredentials("cal-other")).toEqual(other);
  expect((await run(["init"])).status).toBe(0);
  expect(await connections()).toHaveLength(3);
  expect(readFileSync(join(state, "fonds.env"), "utf8")).toBe(originalState);
  expect(
    (await run(["connect", "--connection", "cal-other"], credentials)).status,
  ).toBe(0);
  expect(await savedCredentials("cal-other")).toEqual(credentials);
});

it("leaves no new login after missing or invalid credentials and refuses mixed targeting flags", async () => {
  expect((await run(["init"])).status).toBe(0);
  expect((await run(["connect", "cal"])).stderr).toContain(
    "interactive terminal",
  );
  expect((await run(["connect", "isracard"], credentials)).status).toBe(1);
  for (const args of [
    ["connect", "cal", "--connection", "cal"],
    ["connect", "cal", "extra"],
    ["connect", "--name", "cal"],
    ["connect", "cal", "--name", "..", "--offline"],
    ["connect", "cal", "--offline", "--credentials-fd", "3"],
    ["init", "--provider", "cal"],
  ]) {
    expect((await run(args)).status).toBe(1);
  }
  expect(await connections()).toEqual([]);
  expect((await run(["connect", "cal", "--offline"])).status).toBe(0);
  const refresh = await run(["refresh"]);
  expect(refresh.status).toBe(0);
  expect(refresh.stderr).toContain("No connections have saved credentials");
});

it("accepts the connection filter alias and exposes choices and global flags in help", async () => {
  expect((await run(["init"])).status).toBe(0);
  expect((await run(["connect", "cal", "--offline"])).status).toBe(0);
  expect(await json(["totals", "--connection", "cal"])).toEqual(
    await json(["totals", "--connection-id", "cal"]),
  );
  expect(
    (await run(["list", "--connection", "cal", "--connection-id", "cal"]))
      .stderr,
  ).toContain("not both");
  const help = await run(["help", "list"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("--status <posted|pending>");
  expect(help.stdout).toContain("--db");
  expect(help.stdout).toContain("--remote");
  expect(help.stdout).toContain("--token-file");
});

it("does not regenerate lost state for an existing SQLite ledger", async () => {
  expect((await run(["init"])).status).toBe(0);
  rmSync(join(state, "fonds.env"));
  expect((await run(["init"])).status).toBe(1);
  expect(existsSync(join(state, "fonds.env"))).toBe(false);
});

// Cold starts on a loaded runner need more time than the in-process behavior cases.
it("persists a login across executable invocations using a private inherited descriptor", async () => {
  const initialized = executable(["init"]);
  expect(initialized.status, initialized.stderr).toBe(0);
  const connected = executable(["connect", "cal"], credentials);
  expect(connected.status, connected.stderr).toBe(0);
  expect(JSON.parse(connected.stdout)).toEqual({
    connectionId: "cal",
    provider: "cal",
    credentials: "stored",
  });
  expect(connected.stdout + connected.stderr).not.toContain("INVENTED-");
  const listed = executable(["list-connections"]);
  expect(listed.status, listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout).data).toMatchObject([
    { id: "cal", provider: "cal" },
  ]);
  const duplicate = executable(["connect", "cal"]);
  expect(duplicate.status).toBe(1);
  expect(duplicate.stderr).toContain("already exists");
  expect(await savedCredentials("cal")).toEqual(credentials);
}, 30_000);
