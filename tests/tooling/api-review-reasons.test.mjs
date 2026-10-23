import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

const api = readFileSync(new URL("../../docs/api.md", import.meta.url), "utf8");

it.each(["unverified_legacy_identity", "unresolved_installment_role"])(
  "documents the public review reason %s",
  (reason) => {
    const entry = api
      .split("\n")
      .find((line) => line.startsWith("|") && line.includes(`\`${reason}\``));
    expect(entry).toBeDefined();
    expect(entry?.split("|")[2]?.trim().length).toBeGreaterThan(0);
  },
);
