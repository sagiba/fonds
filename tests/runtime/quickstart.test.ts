import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli.js";
import { dataHome, ensureDataHome } from "../../src/runtime/data-home.js";
import { jsonOutput } from "../../src/runtime/json-output.js";

const cliPath = resolve("src/cli.ts");
const serverPath = resolve("src/server.ts");

/** Runs the CLI as a newcomer would, with an isolated data directory. */
function cli(home: string, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, FONDS_HOME: home },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function stdioClient(home: string, args: string[]) {
  const client = new Client({ name: "quickstart-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", serverPath, "--transport", "stdio", ...args],
      env: { ...(process.env as Record<string, string>), FONDS_HOME: home },
      stderr: "pipe",
    }),
  );
  return client;
}

describe("default data directory", () => {
  it("prefers FONDS_HOME, then the platform's per-user data directory", () => {
    const linuxHome = "/home/u";
    const macHome = "/Users/u";
    expect(dataHome({ FONDS_HOME: "/srv/fonds" }, "linux", linuxHome)).toBe(
      "/srv/fonds",
    );
    expect(dataHome({}, "linux", linuxHome)).toBe(
      `${linuxHome}/.local/share/fonds`,
    );
    expect(dataHome({ XDG_DATA_HOME: "/data" }, "linux", linuxHome)).toBe(
      "/data/fonds",
    );
    expect(dataHome({}, "darwin", macHome)).toBe(
      `${macHome}/Library/Application Support/Fonds`,
    );
    expect(
      dataHome({ APPDATA: "C:\\AppData" }, "win32", "C:\\Users\\u"),
    ).toMatch(/Fonds$/);
  });

  it("creates a private directory and refuses a shared one", () => {
    const root = mkdtempSync(join(tmpdir(), "fonds-home-"));
    try {
      const home = ensureDataHome(join(root, "nested", "fonds"));
      expect(statSync(home).mode & 0o777).toBe(0o700);
      chmodSync(home, 0o755);
      expect(() => ensureDataHome(home)).toThrow(/private directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never resolves a default database inside the repository", () => {
    const inside = resolve("tests/fixtures-scratch-never-created");
    const result = cli(inside, "list-connections");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/outside the repository/);
  });
});

describe("default database path", () => {
  it("refuses a dangling symlink instead of creating its target", () => {
    const root = mkdtempSync(join(tmpdir(), "fonds-link-home-"));
    const home = join(root, "fonds");
    const target = resolve("tests/never-created-by-symlink.sqlite");
    try {
      mkdirSync(home, { mode: 0o700 });
      symlinkSync(target, join(home, "fonds.sqlite"));
      const result = cli(home, "init");
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/must not be symlinks/);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("terminal output", () => {
  it("indents for a terminal and keeps one compact line when piped", () => {
    const value = { data: [{ amount: { currency: "ILS", amount: "-1.20" } }] };
    expect(jsonOutput(value, { isTTY: false })).toBe(
      `${JSON.stringify(value)}\n`,
    );
    expect(jsonOutput(value, { isTTY: true })).toBe(
      `${JSON.stringify(value, null, 2)}\n`,
    );
    expect(JSON.parse(jsonOutput(value, { isTTY: true }))).toEqual(value);
  });
});

describe("quickstart", () => {
  let home: string;

  beforeEach(() => {
    home = join(mkdtempSync(join(tmpdir(), "fonds-quickstart-")), "home");
    vi.stubEnv("FONDS_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(resolve(home, ".."), { recursive: true, force: true });
  });

  it.each([
    ["xterm", "✓", "·"],
    ["dumb", "ok", "|"],
  ])(
    "runs demo idempotently and labels it synthetic with TERM=%s",
    async (term, mark, separator) => {
      vi.stubEnv("TERM", term);
      vi.stubEnv("NO_COLOR", "1");
      vi.stubEnv("FORCE_COLOR", undefined);
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const events = async () => {
        write.mockClear();
        expect(
          await main([
            "list-events",
            "--db",
            join(home, "demo.sqlite"),
            "--connection-id",
            "demo",
          ]),
        ).toBe(0);
        return String(write.mock.calls.at(-1)?.[0]);
      };
      try {
        expect(await main(["demo"])).toBe(0);
        const first = String(write.mock.calls.map((call) => call[0]).join(""));
        expect(first.split("\n")[0]).toBe(
          `${mark} Demo ready: synthetic CAL data, no real accounts`,
        );
        expect(first).toContain(`  21 transactions ${separator} ledger `);
        // A demo, not an installation manual: client setup is mcp-config's.
        expect(first).not.toMatch(/mcp add|mcpServers|ChatGPT|Claude/);
        const before = await events();
        write.mockClear();
        expect(await main(["demo"])).toBe(0);
        expect(String(write.mock.calls.map((call) => call[0]).join(""))).toBe(
          first,
        );
        expect(await events()).toBe(before);
      } finally {
        write.mockRestore();
      }
    },
  );

  it("keeps consume a stream of compact JSON lines in a terminal", async () => {
    // consume waits for each line's write callback before advancing its cursor.
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((_chunk: unknown, ...rest: unknown[]) => {
        const callback = rest.find((value) => typeof value === "function");
        (callback as (() => void) | undefined)?.();
        return true;
      });
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    try {
      expect(await main(["demo"])).toBe(0);
      write.mockClear();
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        configurable: true,
      });
      const db = join(home, "demo.sqlite");
      // --json is accepted and changes nothing: consume is always a stream.
      for (const flags of [[], ["--json"]]) {
        write.mockClear();
        expect(
          await main([
            "consume",
            "--db",
            db,
            "--connection",
            "demo",
            "--consumer",
            `tty${flags.length}`,
            ...flags,
          ]),
        ).toBe(0);
        const lines = write.mock.calls.map((call) => String(call[0]));
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) {
          expect(line.endsWith("\n") && !line.slice(0, -1).includes("\n")).toBe(
            true,
          );
          JSON.parse(line);
        }
        expect(JSON.parse(lines.at(-1)!).type).toBe("delivery_summary");
      }
    } finally {
      if (tty) {
        Object.defineProperty(process.stdout, "isTTY", tty);
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
      write.mockRestore();
    }
  });

  it("prints the installed fonds command for the package and its MCP hosts", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const launcher = join(home, "..", "prefix", "bin", "fonds");
    const entry = process.argv[1];
    process.argv[1] = launcher;
    vi.stubEnv("PATH", dirname(launcher));
    try {
      expect(await main(["demo"])).toBe(0);
      const demo = String(write.mock.calls.map((call) => call[0]).join(""));
      const demoDb = join(home, "demo.sqlite");
      expect(demo).toContain(`  fonds totals --db ${demoDb}`);
      expect(demo).toContain(
        `  fonds mcp-config --db ${demoDb} --name fonds-demo`,
      );
      write.mockClear();
      expect(
        await main(["mcp-config", "--db", demoDb, "--name", "fonds-demo"]),
      ).toBe(0);
      const chooser = String(write.mock.calls.map((call) => call[0]).join(""));
      for (const client of [
        "chatgpt-desktop",
        "claude-desktop",
        "claude-code",
        "codex",
      ]) {
        expect(chooser).toContain(
          `  fonds mcp-config --client ${client} --name fonds-demo --db ${demoDb}\n`,
        );
      }
      write.mockClear();
      expect(
        await main([
          "mcp-config",
          "--db",
          demoDb,
          "--name",
          "fonds-demo",
          "--all",
        ]),
      ).toBe(0);
      const output = String(write.mock.calls.map((call) => call[0]).join(""));
      expect(output).toContain(
        `claude mcp add fonds-demo --scope local --transport stdio --env FONDS_STATE_DIR=${home} -- ${process.execPath}`,
      );
      expect(output).toContain(
        `codex mcp add fonds-demo --env FONDS_STATE_DIR=${home}`,
      );
      expect(output).toContain(
        JSON.stringify({
          command: process.execPath,
          args: [
            resolve("dist/server.js"),
            "--transport",
            "stdio",
            "--db",
            demoDb,
          ],
          env: { FONDS_STATE_DIR: home },
        }),
      );
    } finally {
      process.argv[1] = entry!;
      write.mockRestore();
    }
  });

  it(
    "takes a newcomer from demo to an agent, then to their own ledger",
    { timeout: 60_000 },
    async () => {
      const demo = cli(home, "demo");
      expect(demo.status, demo.stderr).toBe(0);
      const demoDb = join(home, "demo.sqlite");
      expect(demo.stdout).toContain(
        `mcp-config --db ${demoDb} --name fonds-demo`,
      );
      const setup = cli(
        home,
        "mcp-config",
        "--db",
        demoDb,
        "--name",
        "fonds-demo",
        "--client",
        "claude-code",
      );
      expect(setup.status, setup.stderr).toBe(0);
      expect(setup.stdout).toMatch(
        /claude mcp add fonds-demo .*--transport stdio .*--db/,
      );
      expect(setup.stdout).not.toMatch(/codex|mcpServers/);

      const list = cli(home, "list", "--db", demoDb, "--limit", "5");
      expect(list.status, list.stderr).toBe(0);
      // Piped output is the compact wire format.
      expect(list.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(list.stdout).data).toHaveLength(5);
      const totals = cli(home, "totals", "--db", demoDb);
      expect(JSON.parse(totals.stdout).totals.length).toBeGreaterThan(0);

      const client = await stdioClient(home, ["--db", demoDb]);
      try {
        const { tools } = await client.listTools();
        expect(
          tools.some((tool) => tool.name === "get_transaction_totals"),
        ).toBe(true);
        const result = await client.callTool({
          name: "get_transaction_totals",
          arguments: {},
        });
        expect(result.structuredContent).toEqual(JSON.parse(totals.stdout));
      } finally {
        await client.close();
      }

      // Own data: the default ledger, no --db anywhere.
      const missing = cli(home, "list-connections");
      expect(missing.stderr).toMatch(/No Fonds database at .*fonds\.sqlite/);
      expect(cli(home, "init").status).toBe(0);
      expect(statSync(join(home, "fonds.sqlite")).mode & 0o777).toBe(0o600);
      expect(
        cli(home, "connect", "cal", "--name", "my-cal", "--offline").status,
      ).toBe(0);
      expect(
        JSON.parse(cli(home, "list-connections").stdout).data,
      ).toMatchObject([{ id: "my-cal" }]);
      const own = await stdioClient(home, []);
      try {
        const connections = await own.callTool({
          name: "list_connections",
          arguments: {},
        });
        expect(connections.structuredContent).toMatchObject({
          data: [{ id: "my-cal" }],
        });
      } finally {
        await own.close();
      }
    },
  );
});
