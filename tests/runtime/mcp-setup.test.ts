import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import {
  localMcpSetup,
  MCP_CLIENTS,
  MCP_SERVER_NAME,
  mcpClientChooser,
} from "../../src/runtime/mcp-setup.js";

it("shell-parses both client commands without interpreting spaces, quotes or substitutions in paths", () => {
  const root = mkdtempSync(join(tmpdir(), "fonds-mcp-quoting-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const client of ["claude", "codex"]) {
      writeFileSync(
        join(bin, client),
        `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
        { mode: 0o700 },
      );
    }
    const directory = join(
      root,
      "owner's $(printf WRONG) Library/Application Support/Fonds",
    );
    const database = join(directory, "ledger.sqlite");
    const entry = join(directory, "app/cli.js");
    const setup = localMcpSetup(database, directory, pathToFileURL(entry).href);
    for (const client of ["claude", "codex"]) {
      const command = setup
        .split("\n")
        .find((line) => line.trimStart().startsWith(`${client} mcp add`))!;
      const result = spawnSync("/bin/sh", ["-c", command], {
        env: { PATH: bin },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        "mcp",
        "add",
        "fonds",
        ...(client === "claude"
          ? ["--scope", "local", "--transport", "stdio"]
          : []),
        "--env",
        `FONDS_STATE_DIR=${directory}`,
        "--",
        process.execPath,
        join(directory, "app/server.js"),
        "--transport",
        "stdio",
        "--db",
        database,
      ]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("prints only the chosen client's setup under the chosen name", () => {
  const url = pathToFileURL("/opt/fonds/cli.js").href;
  const only = (client: (typeof MCP_CLIENTS)[number]) =>
    localMcpSetup("/data/ledger.sqlite", "/data", url, {
      client,
      name: "fonds-demo",
    });
  expect(only("claude-code")).toMatch(/^ {2}claude mcp add fonds-demo /m);
  expect(only("claude-code")).not.toMatch(/codex mcp add|mcpServers/);
  expect(only("codex")).toMatch(/^ {2}codex mcp add fonds-demo /m);
  expect(only("codex")).not.toContain("claude mcp add");
  const desktop = JSON.parse(
    /^ {2}(\{"mcpServers".*)$/m.exec(only("claude-desktop"))![1]!,
  );
  expect(Object.keys(desktop.mcpServers)).toEqual(["fonds-demo"]);
  const chatgpt = JSON.parse(
    /^ {2}(\{.*)$/m.exec(only("chatgpt-desktop"))![1]!,
  );
  expect(chatgpt).toEqual({
    command: process.execPath,
    args: [
      "/opt/fonds/server.js",
      "--transport",
      "stdio",
      "--db",
      "/data/ledger.sqlite",
    ],
    env: { FONDS_STATE_DIR: "/data" },
  });
  const all = localMcpSetup("/data/ledger.sqlite", "/data", url);
  expect(all).toContain("claude mcp add fonds ");
  expect(all).toContain("codex mcp add fonds ");
  expect(all).toContain('{"mcpServers":{"fonds":');
});

it("accepts only server names that are one safe shell word", () => {
  for (const name of ["fonds", "fonds-demo", "Fonds_2"]) {
    expect(MCP_SERVER_NAME.test(name), name).toBe(true);
  }
  for (const name of [
    "",
    "-fonds",
    "a b",
    "x;y",
    "$(id)",
    "a'b",
    "x".repeat(65),
  ]) {
    expect(MCP_SERVER_NAME.test(name), name).toBe(false);
  }
});

it("refuses setup that would print control characters from any path", () => {
  const refused = /cannot print paths that contain control characters/;
  // The launcher's own path, not only the database's, reaches the chooser.
  expect(() =>
    mcpClientChooser("/data/ledger.sqlite", (args) =>
      ["/opt/\u001b[2Jbin/fonds", "mcp-config", ...args].join(" "),
    ),
  ).toThrow(refused);
  expect(() =>
    localMcpSetup(
      "/data/ledger.sqlite",
      "/data/\u202estate",
      pathToFileURL("/opt/fonds/cli.js").href,
    ),
  ).toThrow(refused);
});
