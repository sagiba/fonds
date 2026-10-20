import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareEnvironmentFile, setup } from "../../../deploy/neon/setup.mjs";
import { smokeChecks } from "../../../deploy/neon/smoke.mjs";
import { assertGraph, root } from "../../../scripts/build-targets.mjs";

const required = [
  "FONDS_PUBLIC_ORIGIN=https://fonds.synthetic.invalid",
  "FONDS_NEON_GOOGLE_AUTH_URL=https://ep-synthetic.neonauth.neon.tech/auth",
  "FONDS_GOOGLE_OWNER_EMAIL=owner@synthetic.invalid",
  "FONDS_COLLECTION_CONNECTION_ID=primary",
  "FONDS_COLLECTION_PROVIDER=cal",
].join("\n");

describe("Neon setup env file", () => {
  let directory;
  let path;

  beforeEach(async () => {
    directory = await mkdtemp(resolve(tmpdir(), "fonds-neon-setup-"));
    path = resolve(directory, "neon.env");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("generates missing secrets once and keeps the file private", async () => {
    await writeFile(path, `${required}\n`, { mode: 0o600 });
    const first = await prepareEnvironmentFile(path);
    expect(first.generated).toEqual([
      "FONDS_AUTH_SECRET",
      "FONDS_OWNER_ID",
      "FONDS_CREDENTIALS_KEY",
      "FONDS_COLLECTION_SECRET",
      "FONDS_COLLECTION_TIME",
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const saved = parseEnv(await readFile(path, "utf8"));
    expect(saved.FONDS_AUTH_SECRET?.length).toBeGreaterThanOrEqual(32);
    expect(saved.FONDS_COLLECTION_SECRET).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    expect(saved.FONDS_COLLECTION_TIME).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);

    const second = await prepareEnvironmentFile(path);
    expect(second.generated).toEqual([]);
    expect(second.values).toEqual(saved);
  });

  it("keeps an operator's schedule and pinned time, and adds a missing time only in setup", async () => {
    const secrets = [
      "FONDS_AUTH_SECRET=synthetic-auth-secret-00000000000000000000",
      "FONDS_OWNER_ID=synthetic-owner",
      `FONDS_CREDENTIALS_KEY=${"A".repeat(43)}`,
      "FONDS_COLLECTION_SECRET=synthetic-collection-secret-000000000000",
      "FONDS_COLLECTION_SCHEDULE=9,13,18",
      "FONDS_COLLECTION_TIMEZONE=Asia/Jerusalem",
    ].join("\n");
    await writeFile(path, `${required}\n${secrets}\n`, { mode: 0o600 });
    // A login link needs no collection time and never writes the file.
    const linkOnly = await prepareEnvironmentFile(path, { generate: false });
    expect(linkOnly.generated).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(`${required}\n${secrets}\n`);
    const added = await prepareEnvironmentFile(path);
    expect(added.generated).toEqual(["FONDS_COLLECTION_TIME"]);
    expect(added.values.FONDS_COLLECTION_SCHEDULE).toBe("9,13,18");

    await writeFile(
      path,
      `${required}\n${secrets}\nFONDS_COLLECTION_TIME=07:45\n`,
      {
        mode: 0o600,
      },
    );
    const pinned = await prepareEnvironmentFile(path);
    expect(pinned.generated).toEqual([]);
    expect(pinned.values.FONDS_COLLECTION_TIME).toBe("07:45");
  });

  it("names missing required settings without generating anything", async () => {
    await writeFile(
      path,
      "FONDS_PUBLIC_ORIGIN=https://fonds.synthetic.invalid\n",
      {
        mode: 0o600,
      },
    );
    await expect(prepareEnvironmentFile(path)).rejects.toThrow(
      "Add FONDS_NEON_GOOGLE_AUTH_URL, FONDS_GOOGLE_OWNER_EMAIL, FONDS_COLLECTION_CONNECTION_ID, FONDS_COLLECTION_PROVIDER",
    );
    expect(await readFile(path, "utf8")).not.toContain("FONDS_AUTH_SECRET");
  });

  it("rejects in-repository names, shared directories and concurrent setup", async () => {
    await expect(
      prepareEnvironmentFile(resolve(root, "..private.env")),
    ).rejects.toThrow("outside the repository");
    await writeFile(path, `${required}\n`, { mode: 0o600 });
    await chmod(directory, 0o755);
    await expect(prepareEnvironmentFile(path)).rejects.toThrow("0700");
    await chmod(directory, 0o700);
    const options = [
      "--env-file",
      path,
      "--project-id",
      "synthetic-project",
      "--branch-id",
      "synthetic-branch",
    ];
    await expect(setup(options)).rejects.toThrow("--profile is required.");
    await writeFile(`${path}.lock`, "", { mode: 0o600 });
    await expect(
      setup([...options, "--profile", "synthetic-profile"]),
    ).rejects.toThrow("Another setup holds");
    expect(await readFile(path, "utf8")).not.toContain("FONDS_AUTH_SECRET");
  });

  it("issues login links only after setup generated the secrets, without changing the file", async () => {
    await writeFile(path, `${required}\n`, { mode: 0o600 });
    const args = [
      "--env-file",
      path,
      "--project-id",
      "synthetic-project",
      "--branch-id",
      "synthetic-branch",
      "--profile",
      "synthetic-profile",
    ];
    await expect(setup(["login-link", ...args])).rejects.toThrow(
      "Run setup first",
    );
    expect(await readFile(path, "utf8")).toBe(`${required}\n`);
    await expect(setup(["rotate", ...args])).rejects.toThrow("Unknown action");
  });

  it("rejects readable files and paths inside the repository", async () => {
    await writeFile(path, `${required}\n`, { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(prepareEnvironmentFile(path)).rejects.toThrow("0600");
    await expect(
      prepareEnvironmentFile(resolve(root, "neon.env")),
    ).rejects.toThrow("outside the repository");
  });
});

describe("Neon Function bundle", () => {
  it("reaches only the PostgreSQL driver", async () => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: ["deploy/neon/function.ts"],
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      metafile: true,
      write: false,
      logLevel: "silent",
    });
    expect(() => assertGraph("postgres", result.metafile)).not.toThrow();
  }, 60_000);
});

describe("Neon smoke checks", () => {
  it("targets only the configured public origin", () => {
    const origin = "https://fonds.synthetic.invalid";
    for (const [, request] of smokeChecks(origin)) {
      expect(new URL(request.url).origin).toBe(origin);
    }
  });
});
