import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { postgresInstallation } from "../../src/runtime/postgres-environment.js";
import { loadState } from "../../src/runtime/state.js";

describe("state directory", () => {
  let root: string;
  let stateDir: string;
  let path: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fonds-state-"));
    stateDir = join(root, "state");
    path = join(stateDir, "fonds.env");
    await mkdir(stateDir, { mode: 0o700 });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("generates every secret once, privately, and reuses the file", async () => {
    await expect(loadState(stateDir, { create: false })).rejects.toThrow(
      `${stateDir} has no fonds.env`,
    );
    const first = await loadState(stateDir, { create: true });
    expect(Object.keys(first).sort()).toEqual([
      "FONDS_API_TOKEN",
      "FONDS_AUTH_SECRET",
      "FONDS_CREDENTIALS_KEY",
      "FONDS_OWNER_ID",
      "FONDS_REFRESH_SECRET",
      "FONDS_SCHEDULE_SECRET",
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadState(stateDir, { create: true })).toEqual(first);
    expect(await loadState(stateDir, { create: false })).toEqual(first);
  });

  it("generates one file for concurrent first starts", async () => {
    const states = await Promise.all(
      Array.from({ length: 8 }, () => loadState(stateDir, { create: true })),
    );
    for (const state of states) {
      expect(state).toEqual(states[0]);
    }
  });

  it("waits for a lock holder's file and reports a stale lock", async () => {
    await mkdir(join(stateDir, "fonds.env.lock"));
    const waiting = loadState(stateDir, { create: true, lockWaitMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const winner =
      "FONDS_AUTH_SECRET=winner-secret-0000000000000000000000000\nFONDS_OWNER_ID=winner\nFONDS_CREDENTIALS_KEY=winner-key\n";
    // A lock holder renames a complete file into place; a direct write would
    // let the waiter read the file between its creation and its contents.
    const temporary = join(stateDir, ".fonds-winner");
    await writeFile(temporary, winner, { mode: 0o600 });
    await rename(temporary, path);
    expect((await waiting).FONDS_OWNER_ID).toBe("winner");
    await rm(path);
    await expect(
      loadState(stateDir, { create: true, lockWaitMs: 100 }),
    ).rejects.toThrow(
      `${stateDir} has a stale fonds.env.lock; remove it if no Fonds process is starting`,
    );
  });

  it("validates an existing file and never completes or regenerates it", async () => {
    await writeFile(path, "FONDS_OWNER_ID=kept\n", { mode: 0o600 });
    await expect(loadState(stateDir, { create: true })).rejects.toThrow(
      `The state file ${path} lacks FONDS_AUTH_SECRET, FONDS_CREDENTIALS_KEY`,
    );
    expect(await readFile(path, "utf8")).toBe("FONDS_OWNER_ID=kept\n");
  });

  it("refuses shared, missing or linked state and never changes permissions", async () => {
    await chmod(stateDir, 0o755);
    await expect(loadState(stateDir, { create: true })).rejects.toThrow(
      `The state directory ${stateDir} must be an owned 0700 directory`,
    );
    expect((await stat(stateDir)).mode & 0o777).toBe(0o755);
    await chmod(stateDir, 0o700);
    await expect(
      loadState(join(root, "absent"), { create: true }),
    ).rejects.toThrow(
      `The state directory ${join(root, "absent")} does not exist`,
    );
    const linkedDir = join(root, "linked");
    await symlink(stateDir, linkedDir);
    await expect(loadState(linkedDir, { create: true })).rejects.toThrow(
      /owned 0700 directory/,
    );

    await loadState(stateDir, { create: true });
    await chmod(path, 0o644);
    await expect(loadState(stateDir, { create: false })).rejects.toThrow(
      `The state file ${path} must be an owned regular 0600 file`,
    );
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await chmod(path, 0o600);
    await link(path, join(root, "second-link"));
    await expect(loadState(stateDir, { create: false })).rejects.toThrow(
      /owned regular 0600/,
    );
    await rm(join(root, "second-link"));
    const elsewhere = join(root, "elsewhere.env");
    await writeFile(elsewhere, await readFile(path), { mode: 0o600 });
    await rm(path);
    await symlink(elsewhere, path);
    await expect(loadState(stateDir, { create: false })).rejects.toThrow(
      /owned regular 0600/,
    );
  });

  it("refuses a state directory below one another account can change", async () => {
    const shared = join(root, "shared");
    await mkdir(shared);
    await chmod(shared, 0o777);
    const inside = join(shared, "state");
    await mkdir(inside, { mode: 0o700 });
    await expect(loadState(inside, { create: true })).rejects.toThrow(
      `The state directory ${inside} is inside ${shared}, which another account can change`,
    );
    await chmod(shared, 0o1777);
    await expect(loadState(inside, { create: true })).resolves.toBeDefined();
  });

  it("gives PostgreSQL entry points secrets only from the state file", async () => {
    await expect(postgresInstallation({}, { create: true })).rejects.toThrow(
      "FONDS_STATE_DIR is required",
    );
    await loadState(stateDir, { create: true });
    // An operator removed the optional collection secret: it stays absent.
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(/^FONDS_REFRESH_SECRET=.*\n/m, ""),
    );
    const { env, installation } = await postgresInstallation(
      {
        FONDS_STATE_DIR: stateDir,
        FONDS_OWNER_ID: "from-env",
        FONDS_REFRESH_SECRET: "inherited-collection-secret-000000000000",
        PORT: "1",
      },
      { create: true },
    );
    expect(env.FONDS_OWNER_ID).toBe(installation.secrets.FONDS_OWNER_ID);
    expect(env.FONDS_OWNER_ID).not.toBe("from-env");
    expect("FONDS_REFRESH_SECRET" in env).toBe(false);
    expect(env.PORT).toBe("1");
  });
});
