import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { root } from "./build-targets.mjs";
import { versionPattern } from "./release-version.mjs";

/** A release version's parts; release candidates order before their release. */
export function parseVersion(version) {
  if (typeof version !== "string" || !versionPattern.test(version)) {
    throw new Error(`Not a release version: ${JSON.stringify(version)}`);
  }
  const [core, candidate] = version.split("-rc.");
  const [major, minor, patch] = core.split(".").map(Number);
  return {
    major,
    minor,
    patch,
    candidate: candidate === undefined ? undefined : Number(candidate),
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const part of ["major", "minor", "patch"]) {
    if (a[part] !== b[part]) {
      return Math.sign(a[part] - b[part]);
    }
  }
  if (a.candidate === b.candidate) {
    return 0;
  }
  if (a.candidate === undefined || b.candidate === undefined) {
    return a.candidate === undefined ? 1 : -1;
  }
  return Math.sign(a.candidate - b.candidate);
}

/**
 * npm's channel for a version: `next` for candidates; `latest` for the newest
 * stable version; `release-X.Y` for a stable backport below it, so `latest`
 * never moves back. `highestStable` is the newest stable version npm already
 * has, or undefined before the first.
 */
export function distTag(version, highestStable) {
  const { major, minor, candidate } = parseVersion(version);
  if (candidate !== undefined) {
    return "next";
  }
  return highestStable === undefined ||
    compareVersions(version, highestStable) >= 0
    ? "latest"
    : `release-${major}.${minor}`;
}

/** The highest of some release versions, or undefined when there are none. */
export function highest(versions) {
  return versions.reduce(
    (best, version) =>
      best === undefined || compareVersions(version, best) > 0 ? version : best,
    undefined,
  );
}

/**
 * Refuses to publish a version older than the one its npm channel points to,
 * which would move the channel backwards. `current` is that channel's version,
 * or undefined before the first publication.
 */
export function assertChannelForward(version, current) {
  // npm's staged publishing points a new package's channel at a 0.0.0-*
  // placeholder, below every release.
  if (current !== undefined && /^0\.0\.0-[a-z]+$/.test(current)) {
    return;
  }
  if (current !== undefined && compareVersions(version, current) < 0) {
    throw new Error(
      `${version} is older than its channel's ${current}; publishing it would move the channel back`,
    );
  }
}

/**
 * The rolling image tags a version may move: none for a candidate; for a
 * release `X.Y` and `latest`, each only when it points to an older or equal
 * version or does not exist yet. `current` maps each alias to the version in
 * its OCI label, or null when the alias does not exist; an unreadable label
 * stops the release rather than counting as absent.
 */
export function rollingTags(version, current) {
  const { major, minor, candidate } = parseVersion(version);
  if (candidate !== undefined) {
    return [];
  }
  return [`${major}.${minor}`, "latest"].filter((alias) => {
    const existing = current[alias];
    if (existing === undefined) {
      throw new Error(`The current version of ${alias} was not checked`);
    }
    return existing === null || compareVersions(version, existing) >= 0;
  });
}

/**
 * The repository's compose stack, pointed at a published image instead of a
 * local build, so the release asset needs no checkout.
 */
export function releaseCompose(source, image) {
  const replacements = [
    ["#   docker compose up -d --build\n", "#   docker compose up -d\n"],
    [
      "    build:\n      context: .\n    image: fonds\n",
      `    image: ${image}\n`,
    ],
  ];
  let compose = source;
  for (const [from, to] of replacements) {
    if (compose.split(from).length !== 2) {
      throw new Error(
        `compose.yaml no longer contains exactly one ${JSON.stringify(from)}`,
      );
    }
    compose = compose.replace(from, to);
  }
  return compose;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, ...args] = process.argv.slice(2);
  const optional = (value) => (value === "-" ? null : value);
  if (command === "compose" && args.length === 1) {
    process.stdout.write(
      releaseCompose(
        await readFile(resolve(root, "compose.yaml"), "utf8"),
        args[0],
      ),
    );
  } else if (command === "dist-tag" && args.length === 2) {
    // The newest stable version npm has, or "-" before the first.
    console.log(distTag(args[0], optional(args[1]) ?? undefined));
  } else if (command === "forward" && args.length === 2) {
    // The channel's current version, or "-" when the channel does not exist.
    assertChannelForward(args[0], optional(args[1]) ?? undefined);
  } else if (command === "highest") {
    // With --stable, only X.Y.Z versions count: npm's version list also holds
    // registry placeholders such as 0.0.0-stage. "-" when none remain.
    const stable = args[0] === "--stable";
    const versions = stable
      ? args.slice(1).filter((version) => /^\d+\.\d+\.\d+$/.test(version))
      : args;
    console.log(highest(versions) ?? "-");
  } else if (command === "rolling-tags" && args.length === 3) {
    const [version, minorAlias, latest] = args;
    const { major, minor } = parseVersion(version);
    for (const alias of rollingTags(version, {
      [`${major}.${minor}`]: optional(minorAlias),
      latest: optional(latest),
    })) {
      console.log(alias);
    }
  } else if (command === "compare" && args.length === 2) {
    console.log(compareVersions(args[0], args[1]));
  } else {
    console.error(
      "Usage: node scripts/release.mjs compose <image:version>\n" +
        "       node scripts/release.mjs dist-tag <version> <highest stable|->\n" +
        "       node scripts/release.mjs forward <version> <channel version|->\n" +
        "       node scripts/release.mjs highest [--stable] <version>...\n" +
        "       node scripts/release.mjs rolling-tags <version> <X.Y version|-> <latest version|->\n" +
        "       node scripts/release.mjs compare <version> <version>",
    );
    process.exitCode = 2;
  }
}
