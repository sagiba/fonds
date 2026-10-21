import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTarget, root } from "../../scripts/build-targets.mjs";

const outsideRepository =
  "Database and backup files must be outside the repository.\n";

/** A bundled cli.js in a temporary tree; packages resolve through a link. */
async function bundle(directory, data) {
  const output = join(directory, "app");
  mkdirSync(join(data, "owner's state"), { mode: 0o700 });
  await buildTarget("sqlite", { output });
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
  return (...args) =>
    spawnSync(process.execPath, [join(output, "cli.js"), ...args], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("FONDS_"),
          ),
        ),
        FONDS_HOME: data,
        FONDS_STATE_DIR: join(data, "owner's state"),
      },
    });
}

describe("bundled SQLite CLI", () => {
  let directory;
  let data;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "fonds-bundled-cli-"));
    data = mkdtempSync(join(tmpdir(), "fonds-bundled-data-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });

  it("protects the enclosing checkout from its bundled depth", async () => {
    mkdirSync(join(directory, ".git"));
    writeFileSync(join(directory, ".git/HEAD"), "ref: refs/heads/main\n");
    const cli = await bundle(directory, data);
    for (const args of [
      ["list", "--db", join(directory, "inside.sqlite")],
      [
        "backup",
        "--db",
        join(data, "service.sqlite"),
        "--out",
        join(directory, "docs/inside.sqlite"),
      ],
    ]) {
      expect(cli(...args)).toMatchObject({
        status: 1,
        stderr: outsideRepository,
      });
    }
    expect(existsSync(join(directory, "inside.sqlite"))).toBe(false);
  });

  it("protects only its own application directory when installed", async () => {
    const cli = await bundle(directory, data);
    expect(
      cli("init", "--db", join(directory, "app", "service.sqlite")),
    ).toMatchObject({ status: 1, stderr: outsideRepository });
    // A sibling of the installed application, inside its parent, stays usable.
    const sibling = join(directory, "data");
    mkdirSync(sibling, { mode: 0o700 });
    const created = cli("init", "--db", join(sibling, "service.sqlite"));
    expect(created).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(created.stdout)).toEqual({
      initialized: true,
    });
  });

  it("launches the emitted MCP configuration without the shell environment and sees every login", async () => {
    const cli = await bundle(directory, data);
    expect(cli("mcp-config")).toMatchObject({ status: 1, stdout: "" });
    const demo = cli("demo");
    expect(demo.status, demo.stderr).toBe(0);
    const parseConfig = (output, name) =>
      JSON.parse(
        output
          .split("\n")
          .find((line) => line.trimStart().startsWith('{"mcpServers"')),
      ).mcpServers[name];
    const check = async (config, expected) => {
      expect(config.command).toBe(process.execPath);
      expect(config.env).toEqual({
        FONDS_STATE_DIR: join(data, "owner's state"),
      });
      const client = new Client({ name: "setup-check", version: "1" });
      try {
        await client.connect(
          new StdioClientTransport({
            ...config,
            cwd: data,
            env: { PATH: "", ...config.env },
            stderr: "pipe",
          }),
        );
        const result = await client.callTool({
          name: "list_connections",
          arguments: {},
        });
        expect(
          result.structuredContent.data.map(({ id, provider }) => ({
            id,
            provider,
          })),
        ).toEqual(expected);
      } finally {
        await client.close();
      }
    };
    await check(parseConfig(demo.stdout, "fonds-demo"), [
      { id: "demo", provider: "cal" },
    ]);
    const connections = [
      { id: "cal-one", provider: "cal" },
      { id: "cal-two", provider: "cal" },
      { id: "isracard-one", provider: "isracard" },
    ];
    expect(cli("init").status).toBe(0);
    for (const { id, provider } of connections) {
      expect(cli("connect", provider, "--name", id, "--offline").status).toBe(
        0,
      );
    }
    const setup = cli("mcp-config");
    expect(setup.status, setup.stderr).toBe(0);
    await check(parseConfig(setup.stdout, "fonds"), connections);
  });
});
