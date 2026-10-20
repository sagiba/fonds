import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/targets/postgres.js";

/** Runs `fonds …` on PostgreSQL and returns what it printed and its exit code. */
async function fonds(args: string[], env: NodeJS.ProcessEnv) {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  process.exitCode = undefined;
  try {
    await main(args, env);
    return { status: process.exitCode ?? 0, stdout, stderr };
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  }
}

const database = {
  FONDS_DATABASE_URL: "postgresql://synthetic@127.0.0.1:1/unused",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fonds serve on PostgreSQL", () => {
  it.each([
    [
      "hosted without a public origin",
      ["serve", "--hosted"],
      database,
      "--hosted needs FONDS_PUBLIC_ORIGIN",
    ],
    [
      "hosted over stdio",
      ["serve", "--hosted", "--transport", "stdio"],
      { ...database, FONDS_PUBLIC_ORIGIN: "https://fonds.example" },
      "stdio is always local",
    ],
    [
      "a public origin without --hosted",
      ["serve"],
      { ...database, FONDS_PUBLIC_ORIGIN: "https://fonds.example" },
      "use fonds serve --hosted",
    ],
    [
      "an HTTP transport flag",
      ["serve", "--transport", "http"],
      database,
      "The transport is stdio, or omitted for HTTP.",
    ],
    [
      "an unknown flag",
      ["serve", "--db", "ledger.sqlite"],
      database,
      "Invalid arguments",
    ],
  ])("refuses %s before starting anything", async (_, args, env, message) => {
    const result = await fonds(args, env);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  });

  it("prints the serve usage", async () => {
    const result = await fonds(["serve", "--help"], database);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("fonds serve --hosted");
  });

  it("runs other arguments as operator commands", async () => {
    const result = await fonds(["--version"], database);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
});
