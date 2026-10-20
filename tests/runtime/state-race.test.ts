import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  /** Runs once, right after the state directory is resolved. */
  afterResolve: undefined as (() => void) | undefined,
}));

// Retargets an intermediate symlink between the state directory's check and
// every later file operation, as another process could.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    realpath: async (...args: Parameters<typeof original.realpath>) => {
      const resolved = await original.realpath(...args);
      const after = race.afterResolve;
      race.afterResolve = undefined;
      after?.();
      return resolved;
    },
  };
});

const { loadState } = await import("../../src/runtime/state.js");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fonds-state-race-"));
});

afterEach(() => {
  race.afterResolve = undefined;
  rmSync(root, { recursive: true, force: true });
});

it("keeps using the checked directory when an intermediate symlink is retargeted", async () => {
  for (const name of ["checked", "other"]) {
    mkdirSync(join(root, name, "state"), { recursive: true, mode: 0o700 });
  }
  const checked = await loadState(join(root, "checked", "state"), {
    create: true,
  });
  const other = await loadState(join(root, "other", "state"), {
    create: true,
  });
  const link = join(root, "link");
  symlinkSync(join(root, "checked"), link);
  race.afterResolve = () => {
    unlinkSync(link);
    symlinkSync(join(root, "other"), link);
  };
  const loaded = await loadState(join(link, "state"), { create: false });
  expect(race.afterResolve).toBeUndefined();
  expect(loaded).toEqual(checked);
  expect(loaded).not.toEqual(other);
});
