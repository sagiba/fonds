import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTarget,
  defaultTargets,
  root,
  targets,
} from "./build-targets.mjs";

function runCommand(command, args, cwd, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NODE_PATH: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolveRun(output)
        : reject(new Error(`${command} failed (${code}):\n${output}`)),
    );
  });
}

async function findNativeModules(path) {
  const result = [];
  const entries = await readdir(path, { withFileTypes: true }).catch(
    (error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    },
  );
  for (const item of entries) {
    const child = join(path, item.name);
    if (item.isDirectory()) {
      result.push(...(await findNativeModules(child)));
    } else if (item.name.endsWith(".node")) {
      result.push(child);
    }
  }
  return result;
}

function checkInstalled(name, tree) {
  const installedPackages = new Set();

  function visit(node) {
    for (const [dependency, value] of Object.entries(node.dependencies ?? {})) {
      if (value.version) {
        installedPackages.add(dependency);
      }
      visit(value);
    }
  }

  visit(tree);
  for (const dependency of installedPackages) {
    const unrelated =
      name === "sqlite"
        ? /^(better-sqlite3|pg|pg-.*)$/
        : name === "postgres"
          ? /^(better-sqlite3|@libsql\/.*|libsql)$/
          : /^(better-sqlite3|pg|pg-.*)$/;
    if (unrelated.test(dependency)) {
      throw new Error(`${name}: unrelated installed dependency ${dependency}`);
    }
  }
  return [...installedPackages].sort();
}

const requestedTargets = process.argv
  .slice(2)
  .filter((arg) => arg !== "--runtime");
const verifyRuntime = process.argv.includes("--runtime");
/** Hosts of a disposable server on this machine or its container host. */
const localTestHosts = [
  "localhost",
  "127.0.0.1",
  "[::1]",
  "host.docker.internal",
];
if (verifyRuntime) {
  for (const key of ["FONDS_TEST_POSTGRES_URL", "FONDS_TEST_LIBSQL_HTTP_URL"]) {
    const value = process.env[key];
    if (value && !localTestHosts.includes(new URL(value).hostname)) {
      throw new Error(`${key} must identify a disposable local test server`);
    }
  }
}
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "fonds-target-isolation-"),
);
try {
  for (const name of requestedTargets.length
    ? requestedTargets
    : defaultTargets) {
    const target = targets[name];
    if (!target) {
      throw new Error(`Unknown target: ${name}`);
    }
    const isolatedDirectory = join(temporaryDirectory, name);
    await mkdir(isolatedDirectory);
    await cp(join(root, "src"), join(isolatedDirectory, "src"), {
      recursive: true,
    });
    await cp(
      join(root, "deploy", name, "package.json"),
      join(isolatedDirectory, "package.json"),
    );
    await cp(
      join(root, "deploy", name, "package-lock.json"),
      join(isolatedDirectory, "package-lock.json"),
    );
    await runCommand(
      "npm",
      ["ci", "--no-audit", "--no-fund"],
      isolatedDirectory,
    );
    await writeFile(
      join(isolatedDirectory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          esModuleInterop: true,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
          types: ["node"],
          declaration: true,
          emitDeclarationOnly: true,
          outDir: "types",
          rootDir: "src",
        },
        include: [target.entry, ...(target.cli ? [target.cli] : [])],
      }),
    );
    await runCommand(
      "node",
      ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
      isolatedDirectory,
    );
    const artifactDirectory = join(isolatedDirectory, "artifact");
    const built = await buildTarget(name, {
      sourceRoot: isolatedDirectory,
      output: artifactDirectory,
    });
    await runCommand(
      "npm",
      [
        "ci",
        "--omit=dev",
        ...(name === "sqlite" ? [] : ["--omit=optional"]),
        "--no-audit",
        "--no-fund",
      ],
      artifactDirectory,
    );
    const installed = checkInstalled(
      name,
      JSON.parse(
        await runCommand(
          "npm",
          [
            "ls",
            "--all",
            "--omit=dev",
            ...(name === "sqlite" ? [] : ["--omit=optional"]),
            "--json",
          ],
          artifactDirectory,
        ),
      ),
    );
    const binaries = await findNativeModules(
      join(artifactDirectory, "node_modules"),
    );
    if (name !== "sqlite" && binaries.length) {
      throw new Error(`${name}: unexpected native modules installed`);
    }
    let runtimeVerified = false;
    let runtimeProof = {};
    if (target.web) {
      await runCommand(
        "node",
        [
          "--input-type=module",
          "-e",
          `const api=await import('./application.js'); for (const name of ${JSON.stringify(target.exports)}) if (typeof api[name] !== 'function') throw Error('Missing export ' + name)`,
        ],
        artifactDirectory,
      );
    } else if (verifyRuntime) {
      if (name === "postgres" && !process.env.FONDS_TEST_POSTGRES_URL) {
        throw new Error("--runtime requires FONDS_TEST_POSTGRES_URL");
      }
      if (name === "turso" && !process.env.FONDS_TEST_LIBSQL_HTTP_URL) {
        throw new Error("--runtime requires FONDS_TEST_LIBSQL_HTTP_URL");
      }
      await cp(
        join(root, "scripts/target-smoke.mjs"),
        join(artifactDirectory, "smoke.mjs"),
      );
      const result = await runCommand(
        "node",
        ["smoke.mjs"],
        artifactDirectory,
        {
          FONDS_SMOKE_TARGET: name,
          FONDS_SMOKE_RUNTIME: join(temporaryDirectory, "runtime", name),
        },
      );
      runtimeProof = JSON.parse(
        result
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .at(-1),
      );
      runtimeVerified = true;
    } else {
      await runCommand(
        "node",
        ["--input-type=module", "-e", "await import('./server.js')"],
        artifactDirectory,
      );
    }
    console.log(
      JSON.stringify({
        ...built,
        output: undefined,
        isolatedTypes: true,
        isolatedImport: true,
        runtime: runtimeVerified,
        ...runtimeProof,
        installed,
        nativeModules: binaries.length,
      }),
    );
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
