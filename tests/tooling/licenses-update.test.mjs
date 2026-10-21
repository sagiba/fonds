import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  licensesUpdate,
  newer,
  registryCandidate,
  validIdentifier,
} from "../../scripts/licenses-update.mjs";

const roots = [];

function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "fonds-licenses-update-"));
  roots.push(directory);
  return directory;
}

/** Invented packages under a temporary node_modules, with their files. */
function installed(packages) {
  const base = temporary();
  for (const [
    name,
    { version = "1.0.0", license = "MIT", files = {} },
  ] of Object.entries(packages)) {
    const directory = join(base, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name,
        version,
        license,
        repository: { url: `git+https://example.invalid/${name}.git` },
      }),
    );
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(directory, file), text);
    }
  }
  return base;
}

function bundled(names) {
  return {
    outputs: {
      "cli.js": {
        inputs: Object.fromEntries(
          names.map((name) => [
            `node_modules/${name}/index.js`,
            { bytesInOutput: 10 },
          ]),
        ),
      },
    },
  };
}

async function update(base, names, options = {}) {
  const lines = [];
  const unreviewed = await licensesUpdate({
    metafile: bundled(names),
    base,
    candidates: temporary(),
    print: (line) => lines.push(line),
    ...options,
  });
  return { unreviewed, output: lines.join("\n") };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("license update helper", () => {
  it("reports nothing to review when every text is present", async () => {
    const base = installed({
      "synthetic-lib": { files: { LICENSE: "Synthetic license text" } },
    });
    const fetchCandidate = vi.fn();
    expect(await update(base, ["synthetic-lib"], { fetchCandidate })).toEqual({
      unreviewed: 0,
      output: "Every bundled package has a reviewed license text.",
    });
    expect(fetchCandidate).not.toHaveBeenCalled();
  });

  it("writes a fetched candidate and prints the record to add", async () => {
    const base = installed({ "synthetic-lib": {} });
    const candidates = temporary();
    const { unreviewed, output } = await update(base, ["synthetic-lib"], {
      candidates,
      fetchCandidate: async () => ({
        source: "https://registry.example/synthetic-lib-1.0.0.tgz",
        license: "MIT",
        text: "Synthetic license text",
      }),
    });
    expect(unreviewed).toBe(1);
    expect(readFileSync(join(candidates, "synthetic-lib@1.0.0"), "utf8")).toBe(
      "Synthetic license text\n",
    );
    expect(output).toContain(
      '"synthetic-lib@1.0.0": { license: "MIT", source: "https://registry.example/synthetic-lib-1.0.0.tgz" },',
    );
  });

  it("writes beside the reviewed texts only when asked", async () => {
    const base = installed({ "@synthetic/lib": {} });
    const reviewed = temporary();
    await update(base, ["@synthetic/lib"], {
      write: true,
      reviewed,
      fetchCandidate: async () => ({
        source: "https://registry.example/lib.tgz",
        text: "Synthetic license text",
      }),
    });
    expect(existsSync(join(reviewed, "@synthetic/lib@1.0.0"))).toBe(true);
  });

  it("diffs a candidate against the previous reviewed version", async () => {
    const base = installed({ standardwebhooks: { version: "1.1.2" } });
    const { output } = await update(base, ["standardwebhooks"], {
      fetchCandidate: async () => ({
        source: "https://registry.example/standardwebhooks-1.1.2.tgz",
        text: "Synthetic replacement text",
      }),
    });
    expect(output).toContain("against standardwebhooks@1.1.1:");
    expect(output).toMatch(/^ +-The MIT License$/m);
    expect(output).toMatch(/^ +\+Synthetic replacement text$/m);
  });

  it("points to upstream when the archive has no license text", async () => {
    const base = installed({ standardwebhooks: { version: "1.1.2" } });
    const { unreviewed, output } = await update(base, ["standardwebhooks"], {
      fetchCandidate: async () => ({ source: "unused", text: "" }),
    });
    expect(unreviewed).toBe(1);
    expect(output).toContain("find it upstream at the release tag");
    expect(output).toContain(
      "repository: https://example.invalid/standardwebhooks",
    );
    expect(output).toContain(
      "Previous reviewed text: deploy/npm/licenses/standardwebhooks@1.1.1",
    );
  });

  it("reports a failed fetch and still counts the entry", async () => {
    const base = installed({ "synthetic-lib": {} });
    const { unreviewed, output } = await update(base, ["synthetic-lib"], {
      fetchCandidate: async () => {
        throw new Error("synthetic network failure");
      },
    });
    expect(unreviewed).toBe(1);
    expect(output).toContain(
      "Could not fetch a candidate: synthetic network failure",
    );
  });

  it("leaves a refused license to a human without fetching", async () => {
    const base = installed({
      "synthetic-lib": {
        license: "GPL-3.0-only",
        files: { LICENSE: "Synthetic license text" },
      },
    });
    const fetchCandidate = vi.fn();
    const { unreviewed, output } = await update(base, ["synthetic-lib"], {
      fetchCandidate,
    });
    expect(unreviewed).toBe(1);
    expect(output).toContain("needs a human decision");
    expect(fetchCandidate).not.toHaveBeenCalled();
  });

  it("asks for lockfile versions when a new release embeds libraries", async () => {
    const base = installed({
      "@modelcontextprotocol/server": {
        version: "2.4.0",
        license: "Apache-2.0",
        files: {
          LICENSE: "Synthetic license text",
          "index.js.map": JSON.stringify({
            sources: ["../../node_modules/ajv/dist/core.js"],
          }),
        },
      },
    });
    const fetchCandidate = vi.fn();
    const { unreviewed, output } = await update(
      base,
      ["@modelcontextprotocol/server"],
      { fetchCandidate },
    );
    expect(unreviewed).toBe(1);
    expect(output).toContain("that release's lockfile");
    expect(output).toContain(
      "previously recorded for @modelcontextprotocol/server@2.3.1: ajv@8.18.0",
    );
    expect(fetchCandidate).not.toHaveBeenCalled();
  });
});

describe("registry candidates", () => {
  /** A registry serving one invented archive, built with tar. */
  function registry(files, { tamper = false } = {}) {
    const directory = temporary();
    mkdirSync(join(directory, "package", "nested"), { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(directory, "package", file), text);
    }
    const archivePath = join(directory, "synthetic.tgz");
    execFileSync("tar", ["-czf", archivePath, "-C", directory, "package"]);
    const archive = readFileSync(archivePath);
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    return async (url) =>
      url.endsWith(".tgz")
        ? new Response(tamper ? Buffer.from("tampered") : archive)
        : Response.json({
            license: "MIT",
            dist: {
              tarball: "https://registry.example/synthetic.tgz",
              integrity,
            },
          });
  }

  it("reads only top-level license files from a verified archive", async () => {
    const candidate = await registryCandidate("synthetic-lib", "1.0.0", {
      fetch: registry({
        LICENSE: "Synthetic license text",
        NOTICE: "Synthetic notice",
        "nested/LICENSE": "Nested text",
        "index.js": "throw new Error('never run');",
      }),
    });
    expect(candidate).toEqual({
      source: "https://registry.example/synthetic.tgz",
      license: "MIT",
      text: "Synthetic license text",
    });
  });

  it("rejects an archive that does not match its integrity", async () => {
    await expect(
      registryCandidate("synthetic-lib", "1.0.0", {
        fetch: registry({ LICENSE: "Synthetic" }, { tamper: true }),
      }),
    ).rejects.toThrow(/does not match its integrity/);
  });

  it("reports a registry error status", async () => {
    await expect(
      registryCandidate("synthetic-lib", "1.0.0", {
        fetch: async () => new Response("", { status: 503 }),
      }),
    ).rejects.toThrow(/returned 503/);
  });
});

describe("license update helper edge cases", () => {
  it("keeps inspecting a refused package", async () => {
    const base = installed({
      "synthetic-lib": {
        license: "GPL-3.0-only",
        files: {
          "index.js.map": JSON.stringify({
            sources: ["../../node_modules/synthetic-embedded/lib.js"],
          }),
        },
      },
    });
    const fetchCandidate = vi.fn(async () => ({ source: "unused", text: "" }));
    const { unreviewed, output } = await update(base, ["synthetic-lib"], {
      fetchCandidate,
    });
    expect(unreviewed).toBe(3);
    expect(output).toContain("needs a human decision");
    expect(output).toContain("synthetic-lib@1.0.0 ships no license text");
    expect(output).toContain("embeds synthetic-embedded");
    expect(fetchCandidate).toHaveBeenCalledWith("synthetic-lib", "1.0.0");
  });

  it("reports every package when one has a directory named LICENSE", async () => {
    const base = installed({
      "synthetic-dir": {},
      "synthetic-lib": {},
    });
    mkdirSync(join(base, "node_modules", "synthetic-dir", "LICENSE"));
    const fetchCandidate = vi.fn(async () => ({ source: "unused", text: "" }));
    const { unreviewed, output } = await update(
      base,
      ["synthetic-dir", "synthetic-lib"],
      { fetchCandidate },
    );
    expect(unreviewed).toBe(3);
    expect(output).toContain(
      "synthetic-dir@1.0.0: LICENSE cannot be read as a file",
    );
    expect(output).toContain("synthetic-dir@1.0.0 ships no license text");
    expect(output).toContain("synthetic-lib@1.0.0 ships no license text");
  });

  it("follows a symlinked license file", async () => {
    const base = installed({ "synthetic-lib": {} });
    const directory = join(base, "node_modules", "synthetic-lib");
    writeFileSync(join(directory, "LICENSE.txt"), "Synthetic license text");
    symlinkSync("LICENSE.txt", join(directory, "LICENSE"));
    const { unreviewed } = await update(base, ["synthetic-lib"]);
    expect(unreviewed).toBe(0);
  });

  it("reports the registry's repository when the manifest has none", async () => {
    const base = temporary();
    const directory = join(base, "node_modules", "synthetic-lib");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "synthetic-lib",
        version: "1.0.0",
        license: "MIT",
      }),
    );
    const { output } = await update(base, ["synthetic-lib"], {
      fetchCandidate: async () => ({
        source: "unused",
        repository: "https://example.invalid/synthetic-lib",
        text: "",
      }),
    });
    expect(output).toContain(
      "  repository: https://example.invalid/synthetic-lib",
    );
  });

  it("reports a legal file that cannot be read", async () => {
    const base = installed({
      "synthetic-lib": { files: { LICENSE: "Synthetic license text" } },
    });
    symlinkSync(
      "missing-target",
      join(base, "node_modules", "synthetic-lib", "NOTICE"),
    );
    const { unreviewed, output } = await update(base, ["synthetic-lib"]);
    expect(unreviewed).toBe(1);
    expect(output).toContain(
      "synthetic-lib@1.0.0: NOTICE cannot be read as a file",
    );
  });

  it("serializes registry fields in the suggested record", async () => {
    const base = installed({ "synthetic-lib": {} });
    const { output } = await update(base, ["synthetic-lib"], {
      fetchCandidate: async () => ({
        source: "https://registry.example/a.tgz",
        license: 'MIT", x: process.exit(1), y: "',
        text: "Synthetic license text",
      }),
    });
    expect(output).toContain(
      '"synthetic-lib@1.0.0": { license: "MIT\\", x: process.exit(1), y: \\"", source: "https://registry.example/a.tgz" },',
    );
  });

  it("never writes over an existing record's text", async () => {
    const base = installed({ "drizzle-orm": { version: "0.45.4" } });
    const reviewed = temporary();
    const candidates = temporary();
    const { output } = await update(base, ["drizzle-orm"], {
      write: true,
      reviewed,
      candidates,
      fetchCandidate: async () => ({
        source: "https://registry.example/drizzle.tgz",
        text: "Synthetic license text",
      }),
    });
    expect(existsSync(join(reviewed, "drizzle-orm@0.45.4"))).toBe(false);
    expect(existsSync(join(candidates, "drizzle-orm@0.45.4"))).toBe(true);
    expect(output).toContain("drizzle-orm@0.45.4 is already recorded");
  });

  it("reports the registry's repository for an unrecorded embedder", async () => {
    const base = temporary();
    const directory = join(base, "node_modules", "synthetic-embedder");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "synthetic-embedder",
        version: "1.0.0",
        license: "MIT",
      }),
    );
    writeFileSync(join(directory, "LICENSE"), "Synthetic license text");
    writeFileSync(
      join(directory, "index.js.map"),
      JSON.stringify({ sources: ["../../node_modules/ajv/dist/core.js"] }),
    );
    const { output } = await update(base, ["synthetic-embedder"], {
      fetchCandidate: async () => ({
        source: "unused",
        repository: "https://example.invalid/synthetic-embedder",
        text: "",
      }),
    });
    expect(output).toContain(
      "  repository: https://example.invalid/synthetic-embedder",
    );
    expect(output).toContain("that release's lockfile");
  });

  it("reports a legal file that exists but cannot be read", async () => {
    const base = installed({
      "synthetic-lib": { files: { LICENSE: "Synthetic license text" } },
      "synthetic-other": {},
    });
    chmodSync(join(base, "node_modules", "synthetic-lib", "LICENSE"), 0o000);
    const { output } = await update(
      base,
      ["synthetic-lib", "synthetic-other"],
      {
        fetchCandidate: async () => ({ source: "unused", text: "" }),
      },
    );
    // Root reads any file regardless of mode; the case needs a normal user.
    if (process.getuid?.() !== 0) {
      expect(output).toContain(
        "synthetic-lib@1.0.0: LICENSE cannot be read as a file",
      );
    }
    expect(output).toContain("synthetic-other@1.0.0 ships no license text");
  });

  it("reports a failed repository lookup for an unrecorded embedder", async () => {
    const base = temporary();
    const directory = join(base, "node_modules", "synthetic-embedder");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "synthetic-embedder",
        version: "1.0.0",
        license: "MIT",
      }),
    );
    writeFileSync(join(directory, "LICENSE"), "Synthetic license text");
    writeFileSync(
      join(directory, "index.js.map"),
      JSON.stringify({ sources: ["../../node_modules/ajv/dist/core.js"] }),
    );
    const { output } = await update(base, ["synthetic-embedder"], {
      fetchCandidate: async () => {
        throw new Error("synthetic network failure");
      },
    });
    expect(output).toContain(
      "Could not fetch its repository: synthetic network failure",
    );
  });

  it("reports a refused license on a recorded embedded library", async () => {
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
    const reviewed = temporary();
    for (const library of [
      "ajv@8.18.0",
      "ajv-formats@3.0.1",
      "content-type@1.0.5",
      "fast-deep-equal@3.1.3",
      "fast-uri@3.1.0",
      "json-schema-traverse@1.0.0",
    ]) {
      writeFileSync(join(reviewed, library), "Synthetic license text");
    }
    const { reviewedLicenses } = await import("../../scripts/npm-package.mjs");
    const original = reviewedLicenses["ajv@8.18.0"];
    reviewedLicenses["ajv@8.18.0"] = { ...original, license: "GPL-3.0-only" };
    try {
      const fetchCandidate = vi.fn();
      const { unreviewed, output } = await update(
        base,
        ["@modelcontextprotocol/server"],
        { reviewed, fetchCandidate },
      );
      expect(unreviewed).toBe(1);
      expect(output).toContain(
        "ajv@8.18.0, embedded in @modelcontextprotocol/server@2.3.1: license GPL-3.0-only needs review",
      );
      expect(output).toContain("needs a human decision");
      expect(fetchCandidate).not.toHaveBeenCalled();
    } finally {
      reviewedLicenses["ajv@8.18.0"] = original;
    }
  });

  it("never fetches or writes for an invalid identifier", async () => {
    const base = temporary();
    const directory = join(base, "node_modules", "synthetic-lib");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "@synthetic/pkg/../../ajv",
        version: "8.18.0",
        license: "MIT",
      }),
    );
    const reviewed = temporary();
    const fetchCandidate = vi.fn(async () => ({
      source: "unused",
      text: "Synthetic license text",
    }));
    const { unreviewed, output } = await update(base, ["synthetic-lib"], {
      write: true,
      reviewed,
      fetchCandidate,
    });
    expect(unreviewed).toBe(1);
    expect(output).toContain("not a valid npm identifier");
    expect(fetchCandidate).not.toHaveBeenCalled();
    expect(existsSync(join(reviewed, "ajv@8.18.0"))).toBe(false);
  });

  it.each([
    ["../ajv", "8.18.0"],
    ["ajv", "latest"],
    ["ajv", undefined],
    ["ajv", "1.0.0-01"],
    ["ajv", "1.0.0-alpha."],
    ["ajv", "1.0.0+."],
  ])("refuses to fetch %s@%s", async (name, version) => {
    await expect(
      registryCandidate(name, version, { fetch: vi.fn() }),
    ).rejects.toThrow(/invalid package identifier/);
  });

  it("reports a reviewed record whose text file is missing", async () => {
    const base = installed({ "drizzle-orm": { version: "0.45.4" } });
    const fetchCandidate = vi.fn(async () => ({ source: "unused", text: "" }));
    const { unreviewed, output } = await update(base, ["drizzle-orm"], {
      reviewed: temporary(),
      fetchCandidate,
    });
    expect(unreviewed).toBe(1);
    expect(output).toContain("drizzle-orm@0.45.4 ships no license text");
    expect(fetchCandidate).toHaveBeenCalledWith("drizzle-orm", "0.45.4");
  });

  it("names an embedded library's own repository", async () => {
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
    const { output } = await update(base, ["@modelcontextprotocol/server"], {
      reviewed: temporary(),
      fetchCandidate: async (name) => ({
        source: "unused",
        repository: `https://example.invalid/${name}`,
        text: "",
      }),
    });
    expect(output).toContain(
      "embedding package's repository: https://example.invalid/@modelcontextprotocol/server",
    );
    expect(output).toContain("  repository: https://example.invalid/ajv");
  });

  it("reads license files under any enclosing archive directory", async () => {
    const directory = temporary();
    mkdirSync(join(directory, "release"));
    writeFileSync(
      join(directory, "release", "LICENSE"),
      "Synthetic license text",
    );
    const archivePath = join(directory, "synthetic.tgz");
    execFileSync("tar", ["-czf", archivePath, "-C", directory, "release"]);
    const archive = readFileSync(archivePath);
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    const candidate = await registryCandidate("synthetic-lib", "1.0.0", {
      fetch: async (url) =>
        url.endsWith(".tgz")
          ? new Response(archive)
          : Response.json({
              dist: { tarball: "https://registry.example/s.tgz", integrity },
            }),
    });
    expect(candidate.text).toBe("Synthetic license text");
  });

  it("never passes an archive member name to tar as an option", async () => {
    const directory = temporary();
    writeFileSync(join(directory, "license"), "Synthetic license text");
    writeFileSync(join(directory, "option"), "Option text");
    const archivePath = join(directory, "synthetic.tgz");
    execFileSync("tar", [
      "-czf",
      archivePath,
      "-C",
      directory,
      "--transform",
      "s,^license$,package/LICENSE,;s,^option$,--synthetic-option/LICENSE,",
      "license",
      "option",
    ]);
    const archive = readFileSync(archivePath);
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    const candidate = await registryCandidate("synthetic-lib", "1.0.0", {
      fetch: async (url) =>
        url.endsWith(".tgz")
          ? new Response(archive)
          : Response.json({
              dist: { tarball: "https://registry.example/s.tgz", integrity },
            }),
    });
    expect(candidate.text).toBe("Synthetic license text");
  });

  it("refuses an archive that repeats a license file", async () => {
    const directory = temporary();
    writeFileSync(join(directory, "a"), "Synthetic license text");
    writeFileSync(join(directory, "b"), "Synthetic repeat");
    const archivePath = join(directory, "synthetic.tgz");
    execFileSync("tar", [
      "-czf",
      archivePath,
      "-C",
      directory,
      "--transform",
      "s,^[ab]$,package/LICENSE,",
      "a",
      "b",
    ]);
    const archive = readFileSync(archivePath);
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    await expect(
      registryCandidate("synthetic-lib", "1.0.0", {
        fetch: async (url) =>
          url.endsWith(".tgz")
            ? new Response(archive)
            : Response.json({
                dist: { tarball: "https://registry.example/s.tgz", integrity },
              }),
      }),
    ).rejects.toThrow(/archive repeats a license file/);
  });

  it("reads no entries nested under a license file's name", async () => {
    const directory = temporary();
    writeFileSync(join(directory, "license"), "Synthetic license text");
    mkdirSync(join(directory, "hidden"));
    writeFileSync(join(directory, "hidden", "extra.txt"), "Nested text");
    const archivePath = join(directory, "synthetic.tgz");
    execFileSync("tar", [
      "-czf",
      archivePath,
      "-C",
      directory,
      "--transform",
      "s,^license$,package/LICENSE,;s,^hidden/,package/LICENSE/,",
      "license",
      "hidden/extra.txt",
    ]);
    const archive = readFileSync(archivePath);
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    const candidate = await registryCandidate("synthetic-lib", "1.0.0", {
      fetch: async (url) =>
        url.endsWith(".tgz")
          ? new Response(archive)
          : Response.json({
              dist: {
                tarball: "https://registry.example/synthetic.tgz",
                integrity,
              },
            }),
    });
    expect(candidate.text).toBe("Synthetic license text");
  });
});

describe("package identifiers and versions", () => {
  it.each([
    ["JSONStream", true],
    ["synthetic..lib", true],
    ["@scope/pkg", true],
    ["../ajv", false],
    ["@scope/a/b", false],
  ])("treats the name %s as valid: %s", (name, valid) => {
    expect(validIdentifier(name, "1.0.0")).toBe(valid);
  });

  it.each([
    ["1.0.3", "1.0.2+build", true],
    ["1.0.2+build", "1.0.1", true],
    ["1.0.0", "1.0.0-rc.1", true],
    ["1.0.0-rc.2", "1.0.0-rc.1", true],
    ["1.0.0-rc.10", "1.0.0-rc.9", true],
    ["1.0.0-alpha", "1.0.0-1", true],
    ["1.0.0-alpha.1", "1.0.0-alpha", true],
    ["1.0.0-rc.1", "1.0.0", false],
    ["1.0.0+a", "1.0.0+b", false],
    ["1.0.0-9007199254740993", "1.0.0-9007199254740992", true],
    ["9007199254740993.0.0", "9007199254740992.0.0", true],
  ])("orders %s above %s: %s", (a, b, expected) => {
    expect(newer(a, b)).toBe(expected);
  });
});
