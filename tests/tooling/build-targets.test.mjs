import { describe, expect, it } from "vitest";

import { assertGraph } from "../../scripts/build-targets.mjs";

function graph(imports = [], emitted = {}) {
  return {
    inputs: { "src/target.ts": { imports: imports.map((path) => ({ path })) } },
    outputs: {
      "application.js": {
        inputs: Object.fromEntries(
          Object.entries(emitted).map(([path, bytesInOutput]) => [
            path,
            { bytesInOutput },
          ]),
        ),
      },
    },
  };
}

describe("deployment dependency graph gates", () => {
  it.each([
    ["postgres", "better-sqlite3"],
    ["postgres", "drizzle-orm/sqlite-core"],
    ["postgres", "src/storage/sqlite/schema.ts"],
    ["sqlite", "pg"],
    ["sqlite", "better-sqlite3"],
    ["sqlite", "@libsql/client/web"],
    ["sqlite", "drizzle-orm/libsql/web"],
    ["postgres", "@libsql/client/sqlite3"],
    ["turso", "@libsql/client/sqlite3"],
    ["sqlite", "drizzle-orm/pg-core"],
    ["turso", "@libsql/client/node"],
    ["turso", "@libsql/client"],
    ["turso-web", "src/providers/cal/adapter.ts"],
    ["d1-web", "src/providers/isracard/adapter.ts"],
    ["turso-web", "node:fs"],
    ["turso-web", "synthetic-driver.node"],
    ["turso-web", "drizzle-orm/d1"],
    ["d1-web", "node:fs"],
    ["d1-web", "@libsql/client"],
    ["d1-web", "drizzle-orm/libsql/web"],
    ["d1-web", "pg"],
  ])("rejects %s reaching %s", (target, path) => {
    expect(() => assertGraph(target, graph([path]))).toThrow();
  });

  it("allows the D1 target to reach Drizzle's D1 driver", () => {
    expect(() =>
      assertGraph("d1-web", graph(["drizzle-orm/d1"])),
    ).not.toThrow();
  });

  it("allows only the local SQLite target to reach its native libSQL driver", () => {
    expect(() =>
      assertGraph("sqlite", graph(["@libsql/client/sqlite3"])),
    ).not.toThrow();
  });

  it("permits Drizzle's shared relation metadata but rejects PostgreSQL execution code", () => {
    expect(() =>
      assertGraph(
        "turso-web",
        graph([], {
          "node_modules/drizzle-orm/pg-core/primary-keys.js": 250,
          "node_modules/drizzle-orm/pg-core/columns/common.js": 500,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertGraph(
        "turso-web",
        graph([], {
          "node_modules/drizzle-orm/pg-core/dialect.js": 10,
        }),
      ),
    ).toThrow(/PostgreSQL implementation/);
  });
});
