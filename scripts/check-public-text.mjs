import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Offline check that repository text names no absolute developer path and
// nothing a maintainer's local patterns file blocks. Every authored file is
// read; binary files (any NUL byte) and dependency trees are skipped. Names
// that are themselves private, such as other repositories, belong in the
// git-ignored local file, never in this tracked one.

// Each pattern is written so that its own source text does not match it, so
// this file needs no exception.
export const developerPathPatterns = [
  ["development container path", /\/workspaces\//],
  ["Linux home directory", /\/home\/[^/\s]+\//],
  ["macOS home directory", /\/Users\/[^/\s]+\//],
  ["Windows home directory", /[A-Za-z]:\\Users\\/],
];

// Optional, git-ignored, at the repository root: one regular expression per
// line. Blank lines and lines starting with `#` are ignored.
export const localPatternsFile = ".public-text-patterns";

/** The patterns in the root's local patterns file, or none when it is absent. */
export function localPatterns(root) {
  const path = join(root, localPatternsFile);
  if (!existsSync(path)) {
    return [];
  }
  const patterns = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const source = line.trim();
      if (source === "" || source.startsWith("#")) {
        return;
      }
      try {
        patterns.push([`local pattern ${index + 1}`, new RegExp(source)]);
      } catch (error) {
        throw new Error(
          `${localPatternsFile}:${index + 1}: invalid regular expression`,
          { cause: error },
        );
      }
    });
  return patterns;
}

// Exact literals a file may contain, keyed by file path, each with its reason.
// Only those literals are exempt: any other match in the same file still
// fails. Prefer fixing the text over adding an entry here; none is needed now.
export const allowedLiterals = new Map();

/** The line with every allowed literal for its file removed. */
function withoutAllowed(line, literals) {
  return literals.reduce((text, literal) => text.replaceAll(literal, ""), line);
}

/** `file:line: label` for every pattern match not covered by an allowed literal. */
export function checkPublicText(
  root,
  files,
  allowed = allowedLiterals,
  patterns = [...developerPathPatterns, ...localPatterns(root)],
) {
  const problems = [];
  for (const file of files) {
    if (file.split("/").includes("node_modules")) {
      continue;
    }
    const path = join(root, file);
    if (!statSync(path).isFile()) {
      continue;
    }
    const content = readFileSync(path);
    if (content.includes(0)) {
      continue;
    }
    const lines = content.toString("utf8").split("\n");
    const literals = allowed.get(file) ?? [];
    lines.forEach((line, index) => {
      const checked = withoutAllowed(line, literals);
      for (const [label, pattern] of patterns) {
        if (pattern.test(checked)) {
          problems.push(`${file}:${index + 1}: ${label}`);
        }
      }
    });
  }
  return problems;
}

/** Tracked and untracked files that git does not ignore. */
export function repositoryFiles(root) {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => file !== "" && existsSync(join(root, file)));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = process.cwd();
  const files = repositoryFiles(root);
  const problems = checkPublicText(root, files);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    process.exitCode = 1;
  } else {
    console.info(`Public text verified in ${files.length} files`);
  }
}
