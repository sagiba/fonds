import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv, promisify } from "node:util";

import { buildTarget, root, targets } from "./build-targets.mjs";

const run = promisify(execFile);
const destination = resolve(root, "dist/npm");

/**
 * Packs the SQLite target as the npm package. The authored manifest stays
 * private, so this is the only way to produce a publishable tarball; the
 * target's lockfile ships as npm-shrinkwrap.json, which npm honours for
 * installed packages, so users get the dependency graph CI tested.
 */
async function pack(stage) {
  await buildTarget("sqlite", { output: stage });
  const manifestPath = join(stage, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.private;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await rename(
    join(stage, "package-lock.json"),
    join(stage, "npm-shrinkwrap.json"),
  );
  await mkdir(destination, { recursive: true });
  const { stdout } = await run(
    "npm",
    ["pack", "--json", "--pack-destination", destination],
    { cwd: stage },
  );
  const [packed] = JSON.parse(stdout);
  const expected = [
    "LICENSE",
    "NOTICE",
    "package.json",
    "npm-shrinkwrap.json",
    "cli.js",
    "server.js",
    ...Object.keys(targets.sqlite.files),
  ].sort();
  const actual = packed.files.map((file) => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Unexpected package contents:\n  packed   ${actual.join(", ")}\n  expected ${expected.join(", ")}`,
    );
  }
  return {
    name: packed.name,
    version: packed.version,
    tarball: join(destination, packed.filename),
    integrity: packed.integrity,
  };
}

/** Synthetic runs only: no inherited Fonds configuration reaches the package. */
function isolatedEnv(home) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("FONDS_")),
  );
  return { ...env, NODE_PATH: "", FONDS_HOME: home };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`npm package check: ${message}`);
  }
}

/** Requests over the stdio transport's newline-delimited JSON-RPC. */
async function stdioSession(command, args, env, requests) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const responses = new Map();
  let buffer = "";
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += data;
  });
  const done = new Promise((resolveDone, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`stdio MCP timed out: ${errors}`));
    }, 20_000);
    child.stdout.on("data", (data) => {
      buffer += data;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.id !== undefined) {
          responses.set(message.id, message);
        }
        if (responses.size === requests.filter((r) => "id" in r).length) {
          clearTimeout(timeout);
          child.stdin.end();
          resolveDone();
        }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`stdio MCP exited (${code}) early: ${errors}`));
    });
  });
  for (const request of requests) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...request }) + "\n");
  }
  await done;
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) {
      resolveExit();
    } else {
      child.once("exit", resolveExit);
    }
  });
  return responses;
}

/** Starts `fonds serve` on a free loopback port and returns its URL. */
function startHttp(command, args, env) {
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const url = new Promise((resolveUrl, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`HTTP server did not start: ${output}`)),
      20_000,
    );
    const collect = (data) => {
      output += data;
      const match = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolveUrl(match[1]);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`HTTP server exited (${code}): ${output}`));
    });
  });
  return { child, url };
}

/** Installs the tarball as a user would and runs the `fonds` command. */
async function checkInstalled(packed, scratch) {
  const prefix = join(scratch, "prefix");
  const home = join(scratch, "home");
  await mkdir(home, { mode: 0o700 });
  await run(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      packed.tarball,
    ],
    { cwd: scratch },
  );
  const fonds = join(prefix, "bin", "fonds");
  const env = isolatedEnv(home);
  const fondsOutput = async (...args) =>
    (await run(fonds, args, { cwd: scratch, env })).stdout;

  assert(
    (await fondsOutput("--version")) === `${packed.version}\n`,
    "--version",
  );
  assert(
    (await fondsOutput("serve", "--help")).includes("local SQLite HTTP/MCP"),
    "serve --help",
  );
  const demo = await fondsOutput("demo");
  const database = demo.match(/^ {2}Database: +(.+)$/m)?.[1];
  assert(database, `demo output: ${demo}`);

  const responses = await stdioSession(
    fonds,
    ["serve", "--transport", "stdio", "--db", database],
    env,
    [
      {
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "npm-package-check", version: "1" },
        },
      },
      { method: "notifications/initialized" },
      {
        id: 2,
        method: "tools/call",
        params: {
          name: "list_transactions",
          arguments: { connectionId: "demo", limit: 1 },
        },
      },
    ],
  );
  assert(
    responses.get(1)?.result?.serverInfo?.version === packed.version,
    "stdio MCP serverInfo version",
  );
  assert(
    responses.get(2)?.result?.structuredContent?.data?.length === 1,
    "stdio MCP list_transactions on the demo ledger",
  );

  const server = startHttp(
    fonds,
    ["serve", "--db", database, "--port", "0"],
    env,
  );
  try {
    const url = await server.url;
    const { FONDS_API_TOKEN: token } = parseEnv(
      await readFile(join(home, "fonds.env"), "utf8"),
    );
    const health = await fetch(`${url}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(health.status === 200, `HTTP /health returned ${health.status}`);
    assert((await health.json()).storage === "sqlite", "HTTP storage");
  } finally {
    server.child.kill("SIGTERM");
  }
  return { installed: true, demo: true, stdioMcp: true, http: true };
}

const scratch = await mkdtemp(join(tmpdir(), "fonds-npm-package-"));
try {
  const packed = await pack(join(scratch, "stage"));
  const checked = process.argv.includes("--check")
    ? await checkInstalled(packed, scratch)
    : {};
  console.log(JSON.stringify({ ...packed, ...checked }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
