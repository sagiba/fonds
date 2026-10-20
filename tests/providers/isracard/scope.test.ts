import { describe, expect, it } from "vitest";

import {
  normalizeIsracardScope,
  validateIsracardScope,
} from "../../../src/providers/isracard/scope.js";

const scope = {
  kind: "recent" as const,
  month: "2040-07",
  cardKey: 'isracard:card:["11","1234"]',
};

describe("Isracard collection scopes", () => {
  it("retains month and card while removing equivalent purchase-date request bounds", () => {
    expect(
      normalizeIsracardScope({
        ...scope,
        from: "2040-06-01",
        to: "2040-06-30",
        windowFrom: "2040-06-01",
        windowTo: "2040-06-30",
      }),
    ).toEqual(scope);
  });

  it("distinguishes historical collection from fresh incremental rereads", () => {
    expect(normalizeIsracardScope({ ...scope, kind: "history" })).not.toEqual(
      normalizeIsracardScope(scope),
    );
  });

  it("retains broad failure ranges before card discovery without conflating recovery scopes", () => {
    const broad = {
      kind: "history" as const,
      from: "2040-01-01",
      to: "2040-07-31",
    };
    expect(validateIsracardScope(broad)).toEqual(broad);
    expect(normalizeIsracardScope(broad)).toEqual(broad);
    expect(normalizeIsracardScope({ ...broad, to: "2040-08-31" })).not.toEqual(
      normalizeIsracardScope(broad),
    );
    expect(validateIsracardScope({ kind: "recent" })).toEqual({
      kind: "recent",
    });
  });

  it("rejects malformed or unsupported scope criteria", () => {
    for (const patch of [
      { month: "2040-13" },
      { month: "0000-01" },
      { cardKey: "" },
      { cardKeys: [scope.cardKey] },
      { filters: { speculative: true } },
      { from: "2040-07-31", to: "2040-07-01" },
      { from: "2040-02-30" },
    ]) {
      expect(() => validateIsracardScope({ ...scope, ...patch })).toThrow();
    }
  });

  it("normalizes archived unknown scope criteria without throwing while ingest validation remains strict", () => {
    const prior = {
      ...scope,
      cardKeys: [scope.cardKey],
      filters: { future: true },
    };
    expect(() => validateIsracardScope(prior)).toThrow();
    expect(normalizeIsracardScope(prior)).toEqual(prior);
  });
});
