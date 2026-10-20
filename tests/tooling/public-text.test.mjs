import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkPublicText,
  localPatternsFile,
} from "../../scripts/check-public-text.mjs";

// Built from parts so this file itself passes the check without an exception.
const containerPath = ["", "workspaces", "project"].join("/");
const linuxHome = ["", "home", "alex", "project"].join("/");
const macHome = ["", "Users", "alex", "project"].join("/");
const windowsHome = ["C:", "Users", "alex", "project"].join("\\");

const roots = [];

function check(files, { allowed, localPatterns } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fonds-public-text-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (localPatterns !== undefined) {
    writeFileSync(join(root, localPatternsFile), localPatterns.join("\n"));
  }
  return checkPublicText(root, Object.keys(files), allowed);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("public text check", () => {
  it("reports each developer path and local pattern with its file and line", () => {
    expect(
      check(
        {
          "docs/guide.md": [
            "# Guide",
            `Open ${containerPath} or ${linuxHome}.`,
            `On other machines: ${macHome} and ${windowsHome}.`,
            "See https://github.com/example/acme-internal/issues/1.",
            "Kept in Widget-Vault, not in widgets.",
          ].join("\n"),
          "src/clean.ts": "export const value = 1;\n",
        },
        {
          localPatterns: [
            "# Private names for this machine",
            "",
            "acme-internal",
            "(?i:widget-vault)",
          ],
        },
      ),
    ).toEqual([
      "docs/guide.md:2: development container path",
      "docs/guide.md:2: Linux home directory",
      "docs/guide.md:3: macOS home directory",
      "docs/guide.md:3: Windows home directory",
      "docs/guide.md:4: local pattern 3",
      "docs/guide.md:5: local pattern 4",
    ]);
  });

  it("exempts only the allowed literals of a file", () => {
    const allowed = new Map([["scripts/patterns.mjs", ["/acme-internal/"]]]);
    expect(
      check(
        {
          "scripts/patterns.mjs": [
            "export const pattern = /acme-internal/;",
            `// Also mentions acme-internal and ${containerPath}.`,
          ].join("\n"),
          "docs/other.md": "/acme-internal/\n",
        },
        { allowed, localPatterns: ["acme-internal"] },
      ),
    ).toEqual([
      "scripts/patterns.mjs:2: development container path",
      "scripts/patterns.mjs:2: local pattern 1",
      "docs/other.md:1: local pattern 1",
    ]);
  });

  it("skips binary files, dependency trees and an absent local patterns file", () => {
    expect(
      check({
        "fixtures/image.bin": Buffer.from([0, ...Buffer.from(linuxHome)]),
        "deploy/node_modules/pkg/index.js": `// ${linuxHome}\n`,
        "docs/public.md": "Fonds keeps acme-internal notes in docs/.\n",
      }),
    ).toEqual([]);
  });
});
