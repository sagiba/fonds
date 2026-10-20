import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryFiles } from "./check-public-text.mjs";

// Offline check that every authored Markdown file stays within its ceiling of
// whitespace-separated tokens, counted on the formatted file with tables, code
// and comments included. Only Markdown is measured, so legal texts (LICENSE,
// NOTICE) and generated artifacts are outside the budget. Every Markdown file
// needs a ceiling, and every ceiling needs its file; ceilings change only by
// editing the budget file.

export const budgetPath = "docs/doc-budget.json";

// Any other Markdown extension or capitalization would escape the budget, so
// it is rejected.
const markdownPattern = /\.(?:md|markdown|mdown|mdwn|mkd|mkdn|mdx)$/i;

/** Whitespace-separated tokens in a text. */
export function countTokens(text) {
  return text.split(/\s+/u).filter((token) => token !== "").length;
}

/** `file: problem` for every file over, or missing from, the budget. */
export function checkDocBudget(root, files, budget) {
  const problems = [];
  const authored = files.filter(
    (file) => !file.split("/").includes("node_modules"),
  );
  for (const file of authored) {
    if (markdownPattern.test(file) && !file.endsWith(".md")) {
      problems.push(`${file}: Markdown must use the .md extension`);
    }
  }
  const markdown = authored.filter((file) => file.endsWith(".md"));
  for (const file of markdown) {
    const tokens = countTokens(readFileSync(join(root, file), "utf8"));
    const ceiling = budget[file];
    if (ceiling === undefined) {
      problems.push(
        `${file}: ${tokens} tokens and no ceiling in ${budgetPath}`,
      );
    } else if (!Number.isSafeInteger(ceiling) || ceiling <= 0) {
      problems.push(`${file}: ceiling must be a positive integer`);
    } else if (tokens > ceiling) {
      problems.push(
        `${file}: ${tokens} tokens exceed the ceiling of ${ceiling}`,
      );
    }
  }
  for (const file of Object.keys(budget)) {
    if (!markdown.includes(file)) {
      problems.push(`${file}: ceiling for a Markdown file that does not exist`);
    }
  }
  return problems;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = process.cwd();
  const budget = JSON.parse(readFileSync(join(root, budgetPath), "utf8"));
  const problems = checkDocBudget(root, repositoryFiles(root), budget);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    process.exitCode = 1;
  } else {
    console.info(
      `Documentation budget verified for ${Object.keys(budget).length} files`,
    );
  }
}
