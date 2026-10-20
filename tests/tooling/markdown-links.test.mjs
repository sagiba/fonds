import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkMarkdownLinks,
  githubSlug,
  markdownAnchors,
} from "../../scripts/check-markdown-links.mjs";

const roots = [];

function repository(files) {
  const root = mkdtempSync(join(tmpdir(), "fonds-markdown-links-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return {
    root,
    files: Object.keys(files).filter((path) => path.endsWith(".md")),
  };
}

function check(files) {
  const { root, files: markdown } = repository(files);
  return checkMarkdownLinks(root, markdown);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const guide = [
  "# Guide",
  "",
  "## Money and `amount_basis`",
  "",
  "## Limits",
  "",
  "## Limits",
  "",
  '<a id="explicit-anchor"></a>',
  "",
  "```md",
  "## Fenced heading",
  "[ignored](missing.md)",
  "```",
  "",
].join("\n");

describe("Markdown link check", () => {
  it("accepts relative files, headings, duplicate and explicit anchors", () => {
    expect(
      check({
        "docs/guide.md": guide,
        "src/code.ts": "export {};\n",
        "README.md": [
          "See the [guide](docs/guide.md), [money](docs/guide.md#money-and-amount_basis),",
          "the [second limits](docs/guide.md#limits-1), the",
          "[explicit anchor](<docs/guide.md#explicit-anchor>), [code](src/code.ts#L1),",
          "[this file](#readme), the [site](https://example.com/missing#x)",
          "and `[code span](missing.md)`.",
          "",
          "# Readme",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("reports a relative link to a missing file", () => {
    expect(check({ "docs/guide.md": "Read [the API](api.md).\n" })).toEqual([
      "docs/guide.md:1: api.md does not exist",
    ]);
  });

  it("reports anchors that name no heading, same-file or cross-file", () => {
    expect(
      check({
        "docs/guide.md": guide,
        "README.md": [
          "# Readme",
          "",
          "See [limits](docs/guide.md#limit) and [fenced](docs/guide.md#fenced-heading).",
          "Jump to [nowhere](#missing).",
        ].join("\n"),
      }),
    ).toEqual([
      "README.md:3: docs/guide.md#limit names no heading or anchor",
      "README.md:3: docs/guide.md#fenced-heading names no heading or anchor",
      "README.md:4: #missing names no heading or anchor",
    ]);
  });

  it("finds links that code-like text and nesting could hide", () => {
    expect(
      check({
        "README.md": [
          "A ``` `` ``` run, an escaped \\`tick, then [unequal](missing-1.md) `.",
          "[nested parens](a(b(c)).md) and [![badge](missing-2.png)](missing-3.md).",
          "",
          "[reference]:",
          "  missing-4.md",
          "",
          "```inline``` [after an inline triple](missing-5.md)",
          "",
          "An unmatched ` tick",
          "## Heading",
          "[after the heading](missing-6.md) and a later ` tick.",
          "",
          "> [quoted][ref]",
          ">",
          "> [ref]: missing-7.md",
          "",
        ].join("\n"),
      }),
    ).toEqual([
      "README.md:1: missing-1.md does not exist",
      "README.md:2: a(b(c)).md does not exist",
      "README.md:2: missing-3.md does not exist",
      "README.md:2: missing-2.png does not exist",
      "README.md:4: missing-4.md does not exist",
      "README.md:7: missing-5.md does not exist",
      "README.md:11: missing-6.md does not exist",
      "README.md:15: missing-7.md does not exist",
    ]);
  });

  it("follows GitHub heading forms and ignores comments", () => {
    const anchors = markdownAnchors(
      [
        "Setext guide",
        "============",
        "",
        "> ## Quoted",
        "",
        "# Foo",
        "# Foo",
        "# Foo-1",
        "# Foo",
        "",
        "<!--",
        "## Commented",
        "-->",
        "",
        "- list item",
        "---",
        "",
        "> Quoted paragraph",
        "---",
        "",
        "# &copy; Notice",
      ].join("\n"),
    );
    expect([...anchors]).toEqual([
      "setext-guide",
      "quoted",
      "foo",
      "foo-1",
      "foo-1-1",
      "foo-2",
      "-notice",
    ]);
  });

  it("derives GitHub heading slugs", () => {
    expect(githubSlug("Pending to posted: **matching** (v2)")).toBe(
      "pending-to-posted-matching-v2",
    );
    expect(githubSlug("The `snake_case` [names](x.md)")).toBe(
      "the-snake_case-names",
    );
    expect(githubSlug("AT&amp;T and the [API][ref]")).toBe("att-and-the-api");
    expect(githubSlug("[API](README.md?q=(a)tail)")).toBe("api");
  });
});
