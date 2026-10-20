import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTarget, root } from "../../scripts/build-targets.mjs";

const outsideRepository =
  "Database and backup files must be outside the repository.\n";

/** A bundled cli.js in a temporary tree; packages resolve through a link. */
async function bundle(directory) {
  const output = join(directory, "app");
  await buildTarget("sqlite", { output });
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
  return (...args) =>
    spawnSync(process.execPath, [join(output, "cli.js"), ...args], {
      encoding: "utf8",
      timeout: 15_000,
    });
}

describe("bundled SQLite CLI", () => {
  let directory;
  let data;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "fonds-bundled-cli-"));
    data = mkdtempSync(join(tmpdir(), "fonds-bundled-data-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });

  it("protects the enclosing checkout from its bundled depth", async () => {
    mkdirSync(join(directory, ".git"));
    writeFileSync(join(directory, ".git/HEAD"), "ref: refs/heads/main\n");
    const cli = await bundle(directory);
    for (const args of [
      ["list", "--db", join(directory, "inside.sqlite")],
      [
        "backup",
        "--db",
        join(data, "service.sqlite"),
        "--out",
        join(directory, "docs/inside.sqlite"),
      ],
    ]) {
      expect(cli(...args)).toMatchObject({
        status: 1,
        stderr: outsideRepository,
      });
    }
    expect(existsSync(join(directory, "inside.sqlite"))).toBe(false);
  });

  it("protects only its own application directory when installed", async () => {
    const cli = await bundle(directory);
    expect(
      cli(
        "init",
        "--db",
        join(directory, "app", "service.sqlite"),
        "--connection",
        "synthetic",
        "--provider",
        "cal",
      ),
    ).toMatchObject({ status: 1, stderr: outsideRepository });
    // A sibling of the installed application, inside its parent, stays usable.
    const sibling = join(directory, "data");
    mkdirSync(sibling, { mode: 0o700 });
    const created = cli(
      "init",
      "--db",
      join(sibling, "service.sqlite"),
      "--connection",
      "synthetic",
      "--provider",
      "cal",
    );
    expect(created).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(created.stdout)).toEqual({
      connectionId: "synthetic",
      provider: "cal",
    });
  });
});
