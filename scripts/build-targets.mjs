import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

export const root = fileURLToPath(new URL("..", import.meta.url));

export const targets = {
  sqlite: {
    entry: "src/server.ts",
    // The owner CLI ships beside the server and obeys the same graph rules.
    cli: "src/cli.ts",
    driver: "@libsql/client/sqlite3",
    // Compiled code npm installs per platform; never bundled.
    native: ["@libsql/client"],
    // Ships in the npm package and image (deploy/npm), dependencies bundled.
    recipe: "deploy/npm",
    bundle: true,
    // The synthetic captures src/runtime/demo.ts replays, so the package and
    // image can run `fonds demo`.
    files: {
      "demo/recent-01.json": "tests/providers/cal/fixtures/recent-01.json",
      "demo/recent-02.json": "tests/providers/cal/fixtures/recent-02.json",
    },
  },
  postgres: {
    entry: "src/targets/postgres.ts",
    driver: "pg",
    recipe: "deploy/npm",
    bundle: true,
  },
  turso: { entry: "src/targets/turso.ts", driver: "@libsql/client" },
  "turso-web": {
    entry: "src/targets/turso-web.ts",
    driver: "@libsql/client",
    web: true,
    exports: ["createApplication", "databaseForClient"],
  },
  // Experimental: built and checked only when named explicitly.
  "d1-web": {
    entry: "src/targets/d1-web.ts",
    driver: "d1",
    web: true,
    exports: ["createApplication", "openD1Database"],
    optIn: true,
  },
};

export const defaultTargets = Object.keys(targets).filter(
  (name) => !targets[name].optIn,
);

const remoteLibsqlEntryPattern =
  /(?:@libsql\/client\/(?:web|http|ws)|drizzle-orm\/libsql\/web)/;
const nativeLibsqlEntryPattern =
  /(?:^@libsql\/client$|@libsql\/client\/(?:node|sqlite3)$|\.node$)/;
const nodeOrNativeModulePattern =
  /^node:|\.node$|libsql\/lib-esm\/sqlite3|@libsql\/client\/lib-esm\/node/;

export function assertGraph(name, metafile) {
  const target = targets[name];
  const paths = [
    ...Object.keys(metafile.inputs),
    ...Object.values(metafile.inputs).flatMap((input) =>
      input.imports.map((item) => item.path),
    ),
  ];
  const unrelatedDriverPattern =
    target.driver === "pg"
      ? /better-sqlite3|@libsql|\/libsql\//
      : target.driver === "d1"
        ? /better-sqlite3|@libsql|\/libsql\/|(?:^|\/)pg(?:\/|$)|node-postgres/
        : /better-sqlite3|(?:^|\/)pg(?:\/|$)|node-postgres/;
  if (
    name === "sqlite" &&
    paths.some((path) => remoteLibsqlEntryPattern.test(path))
  ) {
    throw new Error("sqlite: remote libSQL entry reachable");
  }
  for (const path of paths) {
    if (target.web && /(?:^|\/)src\/providers\//.test(path)) {
      throw new Error(
        `${name}: storage/application target includes a concrete provider: ${path}`,
      );
    }
    if (unrelatedDriverPattern.test(path)) {
      throw new Error(`${name}: unrelated driver reachable: ${path}`);
    }
    if (
      target.driver === "@libsql/client" &&
      nativeLibsqlEntryPattern.test(path)
    ) {
      throw new Error(`${name}: native libSQL entry reachable: ${path}`);
    }
    if (target.web && nodeOrNativeModulePattern.test(path)) {
      throw new Error(`${name}: Node/native module reachable: ${path}`);
    }
  }
  const unrelatedDialectPattern =
    target.driver === "pg"
      ? /(?:drizzle-orm\/(?:sqlite-core|better-sqlite3|libsql|d1)|(?:^|\/)src\/storage\/sqlite\/schema\.ts$)/
      : target.driver === "d1"
        ? /drizzle-orm\/(?:pg-core|node-postgres|postgres-js|neon|pglite|libsql|better-sqlite3)/
        : /drizzle-orm\/(?:pg-core|node-postgres|postgres-js|neon|pglite|d1)/;
  for (const [path, input] of Object.entries(metafile.inputs)) {
    if (path.includes("node_modules/")) {
      continue;
    }
    for (const item of input.imports) {
      if (unrelatedDialectPattern.test(item.path)) {
        throw new Error(
          `${name}: unrelated first-party SQL dialect import: ${item.path}`,
        );
      }
    }
  }
  // Drizzle's shared relations implementation imports PgPrimaryKeyBuilder even
  // for SQLite. Permit its small schema-metadata closure, never PG execution.
  const allowedRelationMetadata = new Set([
    "foreign-keys.js",
    "unique-constraint.js",
    "utils/array.js",
    "columns/common.js",
    "columns/enum.js",
    "table.js",
    "primary-keys.js",
  ]);
  for (const output of Object.values(metafile.outputs)) {
    for (const [path, contribution] of Object.entries(output.inputs)) {
      if (!contribution.bytesInOutput || target.driver === "pg") {
        continue;
      }
      const prefix = "node_modules/drizzle-orm/pg-core/";
      const index = path.indexOf(prefix);
      if (
        index !== -1 &&
        !allowedRelationMetadata.has(path.slice(index + prefix.length))
      ) {
        throw new Error(
          `${name}: unrelated PostgreSQL implementation emitted: ${path}`,
        );
      }
    }
  }
}

/**
 * Builds one target from its recipe's manifest and lockfile (`deploy/<name>`
 * unless the target names one). A bundled target folds every dependency except
 * its native modules into the output, for a recipe that depends on those alone.
 */
export async function buildTarget(
  name,
  { sourceRoot = root, output = resolve(root, "dist/targets", name) } = {},
) {
  const target = targets[name];
  if (!target) {
    throw new Error(`Unknown target: ${name}`);
  }
  const recipe = target.recipe ?? `deploy/${name}`;
  const bundleDependencies = target.bundle ?? false;
  const readJson = async (path) =>
    JSON.parse(await readFile(resolve(root, path), "utf8"));
  // Recipes carry no version of their own; every artifact takes the root's.
  const { version } = await readJson("package.json");
  const manifest = { ...(await readJson(`${recipe}/package.json`)), version };
  const lock = await readJson(`${recipe}/package-lock.json`);
  lock.version = version;
  lock.packages[""].version = version;
  await mkdir(output, { recursive: true });
  const result = await build({
    absWorkingDir: sourceRoot,
    entryPoints: target.web
      ? { application: target.entry }
      : { server: target.entry, ...(target.cli && { cli: target.cli }) },
    bundle: true,
    platform: target.web ? "browser" : "node",
    format: "esm",
    target: target.web ? "es2024" : "node24",
    packages: target.web || bundleDependencies ? "bundle" : "external",
    conditions: target.web ? ["workerd", "browser"] : ["node"],
    outdir: output,
    metafile: true,
    // A bundled build's maps would be mostly dependency code; skip them.
    sourcemap: !bundleDependencies,
    ...(bundleDependencies && {
      external: target.native ?? [],
      // The entries share their dependencies through chunks.
      splitting: true,
      chunkNames: "chunks/[name]-[hash]",
      // Bundled CommonJS dependencies still require Node built-ins.
      banner: {
        js: 'import { createRequire as fondsCreateRequire } from "node:module"; const require = fondsCreateRequire(import.meta.url);',
      },
    }),
  });
  assertGraph(name, result.metafile);
  const bytes = Object.values(result.metafile.outputs).reduce(
    (total, item) => total + (item.entryPoint ? item.bytes : 0),
    0,
  );
  // A project regression budget, not a claim about any hosted platform's limits.
  if (target.web && bytes > 2_000_000) {
    throw new Error(`${name}: application exceeds 2 MB project budget`);
  }
  await writeFile(
    resolve(output, "metafile.json"),
    JSON.stringify(result.metafile, null, 2) + "\n",
  );
  await writeFile(
    resolve(output, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await writeFile(
    resolve(output, "package-lock.json"),
    JSON.stringify(lock, null, 2) + "\n",
  );
  // Apache-2.0 redistribution carries the license and notice with every artifact.
  for (const file of ["LICENSE", "NOTICE"]) {
    await cp(resolve(root, file), resolve(output, file));
  }
  for (const [file, source] of Object.entries(target.files ?? {})) {
    await cp(resolve(root, source), resolve(output, file));
  }
  return {
    target: name,
    bytes,
    modules: Object.keys(result.metafile.inputs).length,
    output: relative(root, output),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  for (const name of process.argv.slice(2).length
    ? process.argv.slice(2)
    : defaultTargets) {
    console.log(JSON.stringify(await buildTarget(name)));
  }
}
