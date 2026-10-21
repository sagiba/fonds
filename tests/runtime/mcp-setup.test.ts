import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { localMcpSetup } from "../../src/runtime/mcp-setup.js";

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
