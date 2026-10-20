import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkDocBudget,
  countTokens,
} from "../../scripts/check-doc-budget.mjs";
import { repositoryFiles } from "../../scripts/check-public-text.mjs";

const roots = [];

function write(files) {
  const root = mkdtempSync(join(tmpdir(), "fonds-doc-budget-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function check(files, budget) {
  return checkDocBudget(write(files), Object.keys(files), budget);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("documentation budget check", () => {
  it("counts every whitespace-separated token, tables and code included", () => {
    const page = [
      "# Title",
      "",
      "| Column | Other |",
      "| ------ | ----- |",
      "| a      | b     |",
      "",
      "```sh",
      "npm run check",
      "```",
      "<!-- comment -->",
      "",
    ].join("\n");
    expect(countTokens(page)).toBe(25);
    expect(check({ "docs/page.md": page }, { "docs/page.md": 25 })).toEqual([]);
    expect(check({ "docs/page.md": page }, { "docs/page.md": 24 })).toEqual([
      "docs/page.md: 25 tokens exceed the ceiling of 24",
    ]);
  });

  it("fails a Markdown file without a ceiling and a ceiling without a file", () => {
    expect(
      check(
        { "README.md": "one two\n", "docs/new.md": "three\n" },
        { "README.md": 2, "docs/removed.md": 10 },
      ),
    ).toEqual([
      "docs/new.md: 1 tokens and no ceiling in docs/doc-budget.json",
      "docs/removed.md: ceiling for a Markdown file that does not exist",
    ]);
  });

  it("rejects a ceiling that is not a positive integer", () => {
    expect(
      check(
        { "a.md": "x\n", "b.md": "x\n", "c.md": "x\n" },
        { "a.md": 1.5, "b.md": 0, "c.md": "9" },
      ),
    ).toEqual([
      "a.md: ceiling must be a positive integer",
      "b.md: ceiling must be a positive integer",
      "c.md: ceiling must be a positive integer",
    ]);
  });

  it("measures only Markdown outside dependency trees", () => {
    expect(
      check(
        {
          LICENSE: "many words that are not budgeted\n",
          NOTICE: "attribution text\n",
          "src/module.ts": "export const value = 1;\n",
          "deploy/node_modules/pkg/README.md": "dependency readme\n",
        },
        {},
      ),
    ).toEqual([]);
  });

  it("rejects every other Markdown extension and capitalization", () => {
    expect(
      check(
        {
          "docs/a.MD": "x\n",
          "docs/b.markdown": "x\n",
          "docs/c.mdown": "x\n",
          "docs/d.mdx": "x\n",
          "docs/e.md": "x\n",
        },
        { "docs/e.md": 1 },
      ),
    ).toEqual([
      "docs/a.MD: Markdown must use the .md extension",
      "docs/b.markdown: Markdown must use the .md extension",
      "docs/c.mdown: Markdown must use the .md extension",
      "docs/d.mdx: Markdown must use the .md extension",
    ]);
  });

  it("finds tracked and untracked Markdown through git, skipping ignored files", () => {
    const root = write({
      ".gitignore": "ignored.md\n",
      "tracked.md": "one two\n",
      "docs/untracked.md": "three\n",
      "ignored.md": "four\n",
    });
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "tracked.md"], { cwd: root });
    expect(
      checkDocBudget(root, repositoryFiles(root), { "tracked.md": 2 }),
    ).toEqual([
      "docs/untracked.md: 1 tokens and no ceiling in docs/doc-budget.json",
    ]);
  });
});
