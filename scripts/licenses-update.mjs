import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { root } from "./build-targets.mjs";
import {
  bundledMetafile,
  embeddedLibraries,
  licenseAudit,
  repositoryOf,
  reviewedLicenses,
} from "./npm-package.mjs";

const run = promisify(execFile);
// Names and versions come from dependency manifests, which are untrusted: they
// become registry paths and file names, so only npm's own forms are accepted.
// Legacy names may hold capitals; one optional scope, never another "/".
const packageName = /^(?:@[A-Za-z0-9][\w.~-]*\/)?[A-Za-z0-9][\w.~-]*$/;
// An exact version, never a tag such as "latest" that moves: semver.org's
// pattern for a valid version.
const packageVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function validIdentifier(name, version) {
  return (
    typeof name === "string" &&
    typeof version === "string" &&
    packageName.test(name) &&
    packageVersion.test(version)
  );
}

const registry = "https://registry.npmjs.org";
// npm archives hold one enclosing directory, usually but not always package/.
// Names are untrusted: one starting with "-" could be read as a tar option.
const legalMember = /^[^/-][^/]*\/(?:licen[cs]e|copying)(?:[.-][^/]*)?$/i;

/**
 * Candidate license texts from a version's published npm archive. The
 * archive is untrusted data: it must match the registry's integrity, it is
 * never unpacked or executed, and only its top-level license files are read.
 */
export async function registryCandidate(
  name,
  version,
  { fetch: fetcher = fetch } = {},
) {
  if (!validIdentifier(name, version)) {
    throw new Error(`refusing to fetch an invalid package identifier`);
  }
  const fetched = async (url) => {
    const response = await fetcher(url);
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }
    return response;
  };
  const metadata = await (
    await fetched(`${registry}/${name.replace("/", "%2f")}/${version}`)
  ).json();
  const archive = Buffer.from(
    await (await fetched(metadata.dist.tarball)).arrayBuffer(),
  );
  const [algorithm, digest] = metadata.dist.integrity.split("-");
  if (createHash(algorithm).update(archive).digest("base64") !== digest) {
    throw new Error(`${name}@${version}: archive does not match its integrity`);
  }
  const directory = await mkdtemp(join(tmpdir(), "fonds-license-archive-"));
  try {
    const path = join(directory, "package.tgz");
    await writeFile(path, archive);
    // The plain and verbose listings name the same members in the same order;
    // the verbose one's first character is the member's type.
    const names = (await run("tar", ["-tzf", path])).stdout.split("\n");
    const types = (await run("tar", ["-tvzf", path])).stdout
      .split("\n")
      .map((line) => line[0]);
    // tar returns every occurrence of a repeated name, whatever its type, so
    // a repeat is refused before anything is read.
    const legal = names.filter((member) => legalMember.test(member));
    if (new Set(legal).size !== legal.length) {
      throw new Error(`${name}@${version}: archive repeats a license file`);
    }
    const members = names.filter(
      (member, index) => types[index] === "-" && legalMember.test(member),
    );
    const texts = [];
    let size = 0;
    for (const member of members) {
      // Without --no-recursion, tar also reads entries nested under the name.
      const { stdout: text } = await run(
        "tar",
        ["--no-recursion", "-xzOf", path, "--", member],
        { maxBuffer: 1024 * 1024 },
      );
      size += Buffer.byteLength(text);
      if (size > 1024 * 1024) {
        throw new Error(`${name}@${version}: license files exceed 1 MB`);
      }
      if (text.trim()) {
        texts.push(text.trim());
      }
    }
    return {
      source: metadata.dist.tarball,
      license: metadata.license,
      repository: repositoryOf(metadata),
      text: texts.join("\n\n"),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** SemVer precedence: build metadata ignored, a release above its prereleases. */
export function newer(a, b) {
  const numeric = /^\d+$/;
  // BigInt keeps identifiers beyond Number's safe range exact.
  const above = (m, n) =>
    numeric.test(m) && numeric.test(n)
      ? BigInt(m) > BigInt(n)
      : numeric.test(n) || (!numeric.test(m) && m > n);
  const parts = (version) => {
    const [core, prerelease] = version.split("+")[0].split(/-(.*)/s);
    return { core: core.split("."), prerelease };
  };
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index += 1) {
    if (BigInt(x.core[index]) !== BigInt(y.core[index])) {
      return BigInt(x.core[index]) > BigInt(y.core[index]);
    }
  }
  if (!x.prerelease || !y.prerelease) {
    return !x.prerelease && Boolean(y.prerelease);
  }
  const [p, q] = [x.prerelease.split("."), y.prerelease.split(".")];
  for (let index = 0; index < Math.max(p.length, q.length); index += 1) {
    if (p[index] === undefined || q[index] === undefined) {
      return q[index] === undefined;
    }
    if (p[index] !== q[index]) {
      return above(p[index], q[index]);
    }
  }
  return false;
}

/** The latest reviewed version of a package other than `version`. */
function previousReviewed(name, version) {
  let latest;
  for (const id of Object.keys(reviewedLicenses)) {
    const at = id.lastIndexOf("@");
    const candidate = id.slice(at + 1);
    if (
      id.slice(0, at) === name &&
      candidate !== version &&
      (!latest || newer(candidate, latest))
    ) {
      latest = candidate;
    }
  }
  return latest && `${name}@${latest}`;
}

async function difference(previous, next) {
  try {
    await run("git", ["diff", "--no-index", "--no-color", previous, next]);
    return "identical to the previous reviewed text";
  } catch (error) {
    // git diff exits 1 when the files differ.
    return error.code === 1 ? error.stdout.trim() : "diff unavailable";
  }
}

/**
 * Lists every bundled package or embedded library the notices lack a
 * reviewed license text for, fetches a candidate for each, and prints what a
 * reviewer must check and record. It never edits the reviewed records;
 * `write` places candidates beside the reviewed texts instead of in
 * `candidates`. Returns the number of entries that still need review.
 */
export async function licensesUpdate({
  metafile,
  base = root,
  fetchCandidate = registryCandidate,
  write = false,
  reviewed = resolve(root, "deploy/npm/licenses"),
  candidates,
  print = (line) => console.log(line),
}) {
  const { problems } = await licenseAudit(metafile, base, reviewed);
  for (const problem of problems) {
    print(`\n${problem.message}`);
    if (!validIdentifier(problem.name, problem.version)) {
      print(
        "  Its name or version is not a valid npm identifier; inspect it by hand.",
      );
      continue;
    }
    if (problem.repository) {
      print(
        problem.embeddedIn
          ? `  embedding package's repository: ${problem.repository}`
          : `  repository: ${problem.repository}`,
      );
    }
    if (problem.kind === "refused") {
      print("  A license outside the permitted list needs a human decision.");
      continue;
    }
    if (problem.kind === "unreadable") {
      print(
        "  Inspect the installed package; reinstalling with npm ci may help.",
      );
      continue;
    }
    if (problem.kind === "embedded") {
      if (!problem.repository) {
        try {
          const { repository } =
            (await fetchCandidate(problem.name, problem.version)) ?? {};
          if (repository) {
            print(`  repository: ${repository}`);
          }
        } catch (error) {
          print(`  Could not fetch its repository: ${error.message}`);
        }
      }
      print(
        "  Embedded versions come from that release's lockfile in its repository.",
      );
      for (const [embedder, libraries] of Object.entries(embeddedLibraries)) {
        if (embedder.slice(0, embedder.lastIndexOf("@")) === problem.name) {
          print(
            `  previously recorded for ${embedder}: ${libraries.join(", ")}`,
          );
        }
      }
      print(
        `  Record them in embeddedLibraries as ${JSON.stringify(problem.id)}: ["name@version", …], then rerun.`,
      );
      continue;
    }
    let candidate;
    try {
      candidate = await fetchCandidate(problem.name, problem.version);
    } catch (error) {
      print(`  Could not fetch a candidate: ${error.message}`);
      continue;
    }
    const previous = previousReviewed(problem.name, problem.version);
    if ((problem.embeddedIn || !problem.repository) && candidate?.repository) {
      print(`  repository: ${candidate.repository}`);
    }
    if (!candidate?.text) {
      print(
        "  Its npm archive has no license text: find it upstream at the release tag.",
      );
      if (previous) {
        print(
          `  Previous reviewed text: deploy/npm/licenses/${previous}; confirm upstream is unchanged before reusing it.`,
        );
      }
      continue;
    }
    // An existing record already names a reviewed source; its text is
    // replaced only by hand after comparing, never by --write.
    const recorded = Object.hasOwn(reviewedLicenses, problem.id);
    const directory = resolve(write && !recorded ? reviewed : candidates);
    const target = resolve(directory, problem.id);
    if (!target.startsWith(`${directory}${sep}`)) {
      print("  Its identifier would leave the candidate directory; skipped.");
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${candidate.text}\n`);
    print(`  candidate: ${target}`);
    if (recorded) {
      print(
        `  ${problem.id} is already recorded; compare with its source before restoring its text.`,
      );
    }
    print(`  from: ${candidate.source}`);
    if (previous) {
      print(`  against ${previous}:`);
      print(
        (await difference(join(reviewed, previous), target))
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n"),
      );
    }
    // Registry fields are untrusted: serialized, never pasted as code.
    print(
      `  After reviewing it, add to reviewedLicenses in scripts/npm-package.mjs:\n` +
        `    ${JSON.stringify(problem.id)}: { license: ${JSON.stringify(candidate.license ?? problem.license)}, source: ${JSON.stringify(candidate.source)} },`,
    );
  }
  if (problems.length) {
    print(`\n${problems.length} entries need review.`);
  } else {
    print("Every bundled package has a reviewed license text.");
  }
  return problems.length;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const scratch = await mkdtemp(join(tmpdir(), "fonds-licenses-update-"));
  const candidates = join(scratch, "candidates");
  try {
    const unreviewed = await licensesUpdate({
      metafile: await bundledMetafile(join(scratch, "stage")),
      write: process.argv.includes("--write"),
      candidates,
    });
    process.exitCode = unreviewed ? 1 : 0;
  } finally {
    // Candidates written here stay for review; the build stage goes.
    const kept = await readdir(candidates).then(
      (entries) => entries.length > 0,
      () => false,
    );
    await rm(kept ? join(scratch, "stage") : scratch, {
      recursive: true,
      force: true,
    });
    if (kept) {
      console.log(`Candidates are in ${candidates}.`);
    }
  }
}
