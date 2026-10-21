import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { root, targets } from "./build-targets.mjs";

/** `X.Y.Z` or a release candidate `X.Y.Z-rc.N`; the release workflow publishes no other form. */
const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.[1-9]\d*)?$/;
const versionModule = "src/application/version.ts";
const versionDeclaration = /export const FONDS_VERSION = "([^"]*)";/;

/** Every manifest and lockfile that repeats the root package.json version. */
const manifests = [
  "package.json",
  ...new Set(
    Object.entries(targets).map(
      ([name, target]) => `${target.recipe ?? `deploy/${name}`}/package.json`,
    ),
  ),
];
const lockfiles = manifests.map((path) =>
  path.replace(/package\.json$/, "package-lock.json"),
);

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

async function writeJson(path, value) {
  await writeFile(resolve(root, path), JSON.stringify(value, null, 2) + "\n");
}

/** Each place's recorded version, keyed by a readable location. */
async function recordedVersions() {
  const found = {};
  for (const path of manifests) {
    found[path] = (await readJson(path)).version;
  }
  for (const path of lockfiles) {
    const lock = await readJson(path);
    found[path] = lock.version;
    found[`${path} packages[""]`] = lock.packages[""].version;
  }
  const declared = (await readFile(resolve(root, versionModule), "utf8")).match(
    versionDeclaration,
  );
  found[versionModule] = declared?.[1];
  return found;
}

async function setVersion(version) {
  for (const path of manifests) {
    await writeJson(path, { ...(await readJson(path)), version });
  }
  for (const path of lockfiles) {
    const lock = await readJson(path);
    lock.version = version;
    lock.packages[""].version = version;
    await writeJson(path, lock);
  }
  const path = resolve(root, versionModule);
  const source = await readFile(path, "utf8");
  if (!versionDeclaration.test(source)) {
    throw new Error(`${versionModule}: FONDS_VERSION declaration not found`);
  }
  await writeFile(
    path,
    source.replace(
      versionDeclaration,
      `export const FONDS_VERSION = "${version}";`,
    ),
  );
}

async function checkVersion(tag) {
  const { version } = await readJson("package.json");
  if (!versionPattern.test(version)) {
    throw new Error(
      `package.json version ${version} is not X.Y.Z or X.Y.Z-rc.N`,
    );
  }
  const mismatched = Object.entries(await recordedVersions()).filter(
    ([, recorded]) => recorded !== version,
  );
  if (mismatched.length) {
    throw new Error(
      `Versions differ from package.json ${version}:\n` +
        mismatched
          .map(([path, recorded]) => `  ${path}: ${recorded}`)
          .join("\n"),
    );
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Tag ${tag} does not name package.json version ${version}`);
  }
  return version;
}

const [command, argument] = process.argv.slice(2);
if (command === "--check") {
  console.log(await checkVersion(argument));
} else if (command && versionPattern.test(command) && argument === undefined) {
  await setVersion(command);
  console.log(await checkVersion());
} else {
  console.error(
    "Usage: node scripts/release-version.mjs <X.Y.Z | X.Y.Z-rc.N>\n" +
      "       node scripts/release-version.mjs --check [vX.Y.Z]",
  );
  process.exitCode = 2;
}
