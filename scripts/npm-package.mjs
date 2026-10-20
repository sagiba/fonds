import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";

import { buildTarget, root, targets } from "./build-targets.mjs";

const run = promisify(execFile);
const destination = resolve(root, "dist/npm");

/** Licenses whose terms bundled redistribution meets by carrying their text. */
const permittedLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "Unlicense",
]);
const licenseFile = /^(?:licen[cs]e|copying)(?:[.-].*)?$/i;
const noticeFile = /^notice(?:[.-].*)?$/i;
const registry = "https://registry.npmjs.org";
/**
 * Reviewed upstream license texts, kept in deploy/npm/licenses/<name>@<version>,
 * for code whose npm archive does not carry them: packages that omit their
 * license file, and libraries another package compiled into its own files.
 * A new version needs its text reviewed and added again.
 */
const reviewedLicenses = {
  "drizzle-orm@0.45.4": {
    license: "Apache-2.0",
    source: "https://github.com/drizzle-team/drizzle-orm/blob/0.45.4/LICENSE",
  },
  // The repository root is the spec's Apache-2.0; the libraries are MIT.
  "standardwebhooks@1.1.1": {
    license: "MIT",
    source:
      "https://github.com/standard-webhooks/standard-webhooks/blob/a7d19b4574ae62221042e76240648d0688a8c420/libraries/LICENSE",
  },
  "ajv@8.18.0": { license: "MIT", source: `${registry}/ajv/-/ajv-8.18.0.tgz` },
  "ajv-formats@3.0.1": {
    license: "MIT",
    source: `${registry}/ajv-formats/-/ajv-formats-3.0.1.tgz`,
  },
  "content-type@1.0.5": {
    license: "MIT",
    source: `${registry}/content-type/-/content-type-1.0.5.tgz`,
  },
  "fast-deep-equal@3.1.3": {
    license: "MIT",
    source: `${registry}/fast-deep-equal/-/fast-deep-equal-3.1.3.tgz`,
  },
  "fast-uri@3.1.0": {
    license: "BSD-3-Clause",
    source: `${registry}/fast-uri/-/fast-uri-3.1.0.tgz`,
  },
  "json-schema-traverse@1.0.0": {
    license: "MIT",
    source: `${registry}/json-schema-traverse/-/json-schema-traverse-1.0.0.tgz`,
  },
};
/**
 * Libraries a package compiled into its published files without their
 * license texts, as its source maps reveal; versions come from that release's
 * lockfile (for the MCP server, pnpm-lock.yaml at its 2.3.1 tag).
 */
const embeddedLibraries = {
  "@modelcontextprotocol/server@2.3.1": [
    "ajv@8.18.0",
    "ajv-formats@3.0.1",
    "content-type@1.0.5",
    "fast-deep-equal@3.1.3",
    "fast-uri@3.1.0",
    "json-schema-traverse@1.0.0",
  ],
};

/** The npm package names a path or source map entry lies in, outermost last. */
function packageNameIn(path) {
  const segments = path.split("node_modules/").at(-1).split("/");
  return segments[0].startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
}

async function reviewedText(id) {
  const reviewed = reviewedLicenses[id];
  const text = reviewed
    ? (await readFile(resolve(root, "deploy/npm/licenses", id), "utf8")).trim()
    : "";
  return text && { license: reviewed.license, source: reviewed.source, text };
}

/**
 * Libraries compiled into a bundled package's files, found through the
 * source maps it publishes beside them. Files without maps cannot be
 * inspected; a package that embeds code that way needs a manual review.
 */
async function embeddedIn(base, files, ownName) {
  const names = new Set();
  for (const file of files) {
    let map;
    try {
      map = JSON.parse(await readFile(resolve(base, `${file}.map`), "utf8"));
    } catch {
      continue;
    }
    for (const source of map.sources ?? []) {
      if (
        source.includes("node_modules/") &&
        packageNameIn(source) !== ownName
      ) {
        names.add(packageNameIn(source));
      }
    }
  }
  return names;
}

/**
 * The license and notice texts of every dependency esbuild copied into the
 * bundle, and of libraries those packages embed. Native modules stay
 * installed packages and carry their own. Paths in the metafile are relative
 * to `base`, the build's working directory.
 */
export async function thirdPartyNotices(metafile, base = root) {
  const packages = new Map();
  for (const output of Object.values(metafile.outputs)) {
    for (const [path, contribution] of Object.entries(output.inputs)) {
      const match = path.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
      if (match && contribution.bytesInOutput > 0) {
        const directory = resolve(base, match[1]);
        packages.set(directory, [...(packages.get(directory) ?? []), path]);
      }
    }
  }
  const sections = [];
  for (const [directory, files] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    if (!permittedLicenses.has(manifest.license)) {
      throw new Error(
        `${manifest.name}@${manifest.version}: license ${manifest.license} needs review before bundling`,
      );
    }
    const id = `${manifest.name}@${manifest.version}`;
    const licenses = [];
    const notices = [];
    for (const file of (await readdir(directory)).sort()) {
      const kind = licenseFile.test(file)
        ? licenses
        : noticeFile.test(file)
          ? notices
          : undefined;
      const text = kind && (await readFile(join(directory, file), "utf8"));
      if (text?.trim()) {
        kind.push(text.trim());
      }
    }
    if (!licenses.length) {
      const reviewed = await reviewedText(id);
      if (reviewed) {
        licenses.push(`Source: ${reviewed.source}`, reviewed.text);
      }
    }
    // A notice never stands in for the license text itself.
    if (!licenses.length) {
      throw new Error(
        `${id} ships no license text; review its upstream text and add it to deploy/npm/licenses`,
      );
    }
    sections.push(
      [`${id} (${manifest.license})`, ...licenses, ...notices].join("\n\n"),
    );
    const recorded = embeddedLibraries[id] ?? [];
    const unrecorded = [
      ...(await embeddedIn(base, files, manifest.name)),
    ].filter(
      (name) => !recorded.some((library) => library.startsWith(`${name}@`)),
    );
    if (unrecorded.length) {
      throw new Error(
        `${id} embeds ${unrecorded.join(", ")}; review their licenses and record them in embeddedLibraries`,
      );
    }
    for (const library of recorded) {
      const reviewed = await reviewedText(library);
      if (!reviewed || !permittedLicenses.has(reviewed.license)) {
        throw new Error(
          `${library}, embedded in ${id}, has no reviewed license text`,
        );
      }
      sections.push(
        [
          `${library} (${reviewed.license}), embedded in ${id}`,
          `Source: ${reviewed.source}`,
          reviewed.text,
        ].join("\n\n"),
      );
    }
  }
  return {
    count: sections.length,
    text:
      "Fonds bundles the following third-party packages. Their license and notice texts follow.\n\n" +
      sections.join(`\n\n${"-".repeat(72)}\n\n`) +
      "\n",
  };
}

async function directorySize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory()
      ? await directorySize(child)
      : (await stat(child)).size;
  }
  return total;
}

/**
 * The bundle is built from the root installation the test suite runs, while
 * the native modules install from the recipe's lockfile. Every package the
 * recipe installs must be a version the root installation also has; lockfiles
 * place packages differently, so versions are compared by package name.
 */
async function assertRecipeMatchesRoot() {
  const lockPackages = async (path) =>
    Object.entries(
      JSON.parse(await readFile(resolve(root, path), "utf8")).packages,
    ).filter(([path]) => path);
  const packageName = (path) => packageNameIn(path);
  const rootVersions = new Map();
  for (const [path, entry] of await lockPackages("package-lock.json")) {
    if (!entry.dev) {
      const versions = rootVersions.get(packageName(path)) ?? new Set();
      rootVersions.set(packageName(path), versions.add(entry.version));
    }
  }
  const recipe = await lockPackages("deploy/npm/package-lock.json");
  const drifted = recipe
    .map(([path, entry]) => [packageName(path), entry.version])
    .filter(([name, version]) => !rootVersions.get(name)?.has(version));
  // The tests run what Node resolves from node_modules, which a stale
  // installation can make differ from the lockfile; npm ls reports that tree,
  // nested copies included, and fails on missing, invalid or extraneous ones.
  const tree = await run("npm", ["ls", "--all", "--omit=dev", "--json"], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  }).catch(() => {
    throw new Error("node_modules differs from package-lock.json; run npm ci");
  });
  const recipeVersions = new Map();
  for (const [path, entry] of recipe) {
    const versions = recipeVersions.get(packageName(path)) ?? new Set();
    recipeVersions.set(packageName(path), versions.add(entry.version));
  }
  const resolved = [];
  const walk = (name, node) => {
    // Absent optional packages, such as other platforms' binaries, have no version.
    if (node.version) {
      resolved.push([name, node.version]);
    }
    for (const [child, dependency] of Object.entries(node.dependencies ?? {})) {
      walk(child, dependency);
    }
  };
  for (const name of Object.keys(
    JSON.parse(await readFile(resolve(root, "deploy/npm/package.json"), "utf8"))
      .dependencies,
  )) {
    walk(name, JSON.parse(tree.stdout).dependencies?.[name] ?? {});
  }
  const unpublished = resolved.filter(
    ([name, version]) => !recipeVersions.get(name)?.has(version),
  );
  if (unpublished.length) {
    throw new Error(
      "The tested installation resolves versions the npm package does not install; run npm ci or update deploy/npm:\n" +
        unpublished.map(([name, version]) => `  ${name}@${version}`).join("\n"),
    );
  }
  if (drifted.length) {
    throw new Error(
      "deploy/npm/package-lock.json installs versions the root lockfile does not:\n" +
        drifted
          .map(
            ([name, version]) =>
              `  ${name}@${version} (root ${[...(rootVersions.get(name) ?? [])].join(", ") || "none"})`,
          )
          .join("\n"),
    );
  }
}

/**
 * Packs the SQLite target as the npm package from the `deploy/npm` recipe:
 * dependencies are bundled, so the package installs only native modules. The
 * recipe manifest stays private, so this is the only way to produce a
 * publishable tarball; its lockfile ships as npm-shrinkwrap.json, which npm
 * honours for installed packages, so users get the graph CI tested.
 */
async function pack(stage) {
  await assertRecipeMatchesRoot();
  await buildTarget("sqlite", {
    output: stage,
    recipe: "deploy/npm",
    bundleDependencies: true,
  });
  const manifestPath = join(stage, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.private;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await rename(
    join(stage, "package-lock.json"),
    join(stage, "npm-shrinkwrap.json"),
  );
  const notices = await thirdPartyNotices(
    JSON.parse(await readFile(join(stage, "metafile.json"), "utf8")),
  );
  await writeFile(join(stage, "THIRD_PARTY_NOTICES"), notices.text);
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
    "THIRD_PARTY_NOTICES",
    "package.json",
    "npm-shrinkwrap.json",
    "cli.js",
    "server.js",
    ...Object.keys(targets.sqlite.files),
  ].sort();
  const paths = packed.files.map((file) => file.path);
  const actual = paths.filter((path) => !path.startsWith("chunks/")).sort();
  const strayChunks = paths.filter(
    (path) => path.startsWith("chunks/") && !/^chunks\/[^/]+\.js$/.test(path),
  );
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    strayChunks.length
  ) {
    throw new Error(
      `Unexpected package contents:\n  packed   ${paths.sort().join(", ")}\n  expected ${expected.join(", ")} and chunks/*.js`,
    );
  }
  return {
    name: packed.name,
    version: packed.version,
    tarball: join(destination, packed.filename),
    integrity: packed.integrity,
    packedBytes: packed.size,
    bundledPackages: notices.count,
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
  const installedBytes = await directorySize(
    join(prefix, "lib", "node_modules", packed.name),
  );
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
  return {
    installed: true,
    installedBytes,
    demo: true,
    stdioMcp: true,
    http: true,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
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
}
