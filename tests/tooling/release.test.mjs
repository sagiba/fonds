import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertChannelForward,
  compareVersions,
  distTag,
  releaseCompose,
  rollingTags,
} from "../../scripts/release.mjs";

describe("release version order", () => {
  it.each([
    ["0.1.0", "0.1.0", 0],
    ["0.1.1", "0.1.0", 1],
    ["0.2.0", "0.10.0", -1],
    ["1.0.0", "0.99.99", 1],
    ["0.1.0-rc.1", "0.1.0", -1],
    ["0.1.0-rc.2", "0.1.0-rc.10", -1],
    ["0.1.1-rc.1", "0.1.0", 1],
  ])("compares %s with %s", (left, right, order) => {
    expect(compareVersions(left, right)).toBe(order);
    expect(compareVersions(right, left)).toBe(-order || 0);
  });

  it.each([
    "v0.1.0",
    "0.1",
    "0.1.0-alpha.1",
    "0.1.0-rc.0",
    "01.0.0",
    "",
    "latest",
  ])("rejects %j", (version) => {
    expect(() => compareVersions(version, "0.1.0")).toThrow(
      /Not a release version/,
    );
  });
});

describe("npm channels", () => {
  it("publishes releases on latest and candidates on next", () => {
    expect(distTag("0.2.0")).toBe("latest");
    expect(distTag("0.2.0-rc.3")).toBe("next");
  });

  it("refuses to move a channel back", () => {
    expect(() => assertChannelForward("0.1.1", "0.2.0")).toThrow(
      /move the channel back/,
    );
    expect(() => assertChannelForward("0.2.0", "0.2.0")).not.toThrow();
    expect(() => assertChannelForward("0.2.1", "0.2.0")).not.toThrow();
    expect(() => assertChannelForward("0.1.0", undefined)).not.toThrow();
  });
});

describe("rolling image tags", () => {
  it("never moves for a release candidate", () => {
    expect(rollingTags("0.3.0-rc.1", {})).toEqual([]);
  });

  it("moves X.Y and latest when they are absent, older or equal", () => {
    expect(rollingTags("0.3.0", { 0.3: null, latest: null })).toEqual([
      "0.3",
      "latest",
    ]);
    expect(rollingTags("0.3.1", { 0.3: "0.3.0", latest: "0.3.1" })).toEqual([
      "0.3",
      "latest",
    ]);
  });

  it("keeps each alias that already points to a newer version", () => {
    // A patch for an older line after a newer minor shipped.
    expect(rollingTags("0.2.5", { 0.2: "0.2.4", latest: "0.3.0" })).toEqual([
      "0.2",
    ]);
    expect(rollingTags("0.2.5", { 0.2: "0.2.6", latest: "0.3.0" })).toEqual([]);
  });

  it("stops on an unreadable or unchecked current version", () => {
    expect(() =>
      rollingTags("0.3.0", { 0.3: "garbage", latest: null }),
    ).toThrow(/Not a release version/);
    expect(() => rollingTags("0.3.0", { latest: null })).toThrow(
      /was not checked/,
    );
  });
});

describe("release compose asset", () => {
  const source = readFileSync(
    new URL("../../compose.yaml", import.meta.url),
    "utf8",
  );

  it("runs the published image with no build", () => {
    const compose = releaseCompose(source, "ghcr.io/example/fonds:0.1.0");
    expect(compose).toContain("    image: ghcr.io/example/fonds:0.1.0\n");
    expect(compose).not.toMatch(/build:|--build|image: fonds\n/);
    expect(compose).toContain('command: ["serve", "--hosted"]');
  });

  it("fails rather than ship a stack that would still build", () => {
    expect(() =>
      releaseCompose(source.replace("image: fonds\n", "image: other\n"), "x:1"),
    ).toThrow(/no longer contains exactly one/);
  });
});
