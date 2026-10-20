import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { thirdPartyNotices } from "../../scripts/npm-package.mjs";

const roots = [];

/** Invented packages under a temporary node_modules, with their files. */
function installed(packages) {
  const base = mkdtempSync(join(tmpdir(), "fonds-npm-notices-"));
  roots.push(base);
  for (const [
    name,
    { version = "1.0.0", license = "MIT", files = {} },
  ] of Object.entries(packages)) {
    const directory = join(base, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name, version, license }),
    );
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(directory, file), text);
    }
  }
  return base;
}

/** A metafile in which each named package contributed the given bytes. */
function bundled(contributions) {
  return {
    outputs: {
      "cli.js": {
        inputs: Object.fromEntries(
          Object.entries(contributions).map(([name, bytesInOutput]) => [
            `node_modules/${name}/index.js`,
            { bytesInOutput },
          ]),
        ),
      },
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("third-party notices for bundled packages", () => {
  it("carries each license text, followed by its notice", async () => {
    const base = installed({
      "synthetic-lib": {
        license: "Apache-2.0",
        files: {
          LICENSE: "Synthetic license text",
          NOTICE: "Synthetic notice",
        },
      },
    });
    const { count, text } = await thirdPartyNotices(
      bundled({ "synthetic-lib": 10 }),
      base,
    );
    expect(count).toBe(1);
    expect(text).toMatch(
      /synthetic-lib@1\.0\.0 \(Apache-2\.0\)\n\nSynthetic license text\n\nSynthetic notice/,
    );
  });

  it.each([
    ["only a notice", { NOTICE: "Synthetic notice" }],
    ["an empty license file", { LICENSE: " \n" }],
    ["no legal files", {}],
  ])("refuses a package with %s", async (_, files) => {
    const base = installed({ "synthetic-lib": { files } });
    await expect(
      thirdPartyNotices(bundled({ "synthetic-lib": 10 }), base),
    ).rejects.toThrow(/synthetic-lib@1\.0\.0 ships no license text/);
  });

  it("refuses a license outside the reviewed list", async () => {
    const base = installed({
      "synthetic-lib": {
        license: "GPL-3.0-only",
        files: { LICENSE: "Synthetic license text" },
      },
    });
    await expect(
      thirdPartyNotices(bundled({ "synthetic-lib": 10 }), base),
    ).rejects.toThrow(/license GPL-3\.0-only needs review/);
  });

  it("uses a reviewed supplement only for its exact version", async () => {
    const base = installed({
      standardwebhooks: { version: "1.1.1" },
    });
    const { text } = await thirdPartyNotices(
      bundled({ standardwebhooks: 10 }),
      base,
    );
    expect(text).toMatch(
      /standardwebhooks@1\.1\.1 \(MIT\)\n\nSource: https:\/\/github\.com\/standard-webhooks\/.*\n\nThe MIT License/,
    );

    const next = installed({ standardwebhooks: { version: "1.1.2" } });
    await expect(
      thirdPartyNotices(bundled({ standardwebhooks: 10 }), next),
    ).rejects.toThrow(/standardwebhooks@1\.1\.2 ships no license text/);
  });

  it("refuses a package whose source maps reveal unrecorded embedded code", async () => {
    const base = installed({
      "synthetic-lib": {
        files: {
          LICENSE: "Synthetic license text",
          "index.js.map": JSON.stringify({
            sources: [
              "../../node_modules/synthetic-embedded/lib.js",
              "../src/own.ts",
            ],
          }),
        },
      },
    });
    await expect(
      thirdPartyNotices(bundled({ "synthetic-lib": 10 }), base),
    ).rejects.toThrow(/synthetic-lib@1\.0\.0 embeds synthetic-embedded/);
  });

  it("adds the reviewed texts of recorded embedded libraries", async () => {
    const base = installed({
      "@modelcontextprotocol/server": {
        version: "2.3.1",
        license: "Apache-2.0",
        files: {
          LICENSE: "Synthetic license text",
          "index.js.map": JSON.stringify({
            sources: ["../../node_modules/ajv/dist/core.js"],
          }),
        },
      },
    });
    const { count, text } = await thirdPartyNotices(
      bundled({ "@modelcontextprotocol/server": 10 }),
      base,
    );
    expect(count).toBe(7);
    expect(text).toMatch(
      /ajv@8\.18\.0 \(MIT\), embedded in @modelcontextprotocol\/server@2\.3\.1\n\nSource: https:\/\/registry\.npmjs\.org\/ajv\/-\/ajv-8\.18\.0\.tgz\n\nThe MIT License/,
    );
  });

  it("ignores packages that contributed no bytes", async () => {
    const base = installed({
      "synthetic-lib": { files: { LICENSE: "Synthetic license text" } },
      "synthetic-unused": {},
    });
    const { count, text } = await thirdPartyNotices(
      bundled({ "synthetic-lib": 10, "synthetic-unused": 0 }),
      base,
    );
    expect(count).toBe(1);
    expect(text).not.toContain("synthetic-unused");
  });
});
