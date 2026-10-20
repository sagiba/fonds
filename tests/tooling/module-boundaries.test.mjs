import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();
const importExpressions = "fonds/no-restricted-import-expressions";

async function ruleIds(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath });
  expect(result.fatalErrorCount).toBe(0);
  return result.messages.map((message) => message.ruleId);
}

describe("module ownership", () => {
  it.each([
    ["src/domain/model.ts", "../storage/sqlite/database.js"],
    ["src/domain/plans/sync.ts", "../../application/operations.js"],
    ["src/domain/model.ts", "node:fs"],
    ["src/domain/model.ts", "fs"],
    ["src/application/operations.ts", "drizzle-orm"],
    ["src/application/operations.ts", "../storage/sqlite/database.js"],
    ["src/providers/cal/collect.ts", "../../application/collection.js"],
    ["src/storage/sqlite/database.ts", "../../providers/cal/adapter.js"],
    ["src/transport/http.ts", "../storage/sqlite/database.js"],
    ["src/storage/sqlite/schema.ts", "./database.js"],
    ["src/storage/sqlite/schema.ts", "better-sqlite3"],
    ["src/storage/sqlite/statements.ts", "./database.js"],
    ["src/storage/sqlite/statements.ts", "better-sqlite3"],
    ["src/storage/sqlite/statements.ts", "drizzle-orm/node-postgres"],
    ["src/storage/store.ts", "pg"],
    ["src/storage/store.ts", "./sqlite/database.js"],
    ["src/storage/run-evidence.ts", "./postgres/store.js"],
    ["src/storage/sql.ts", "./turso.js"],
    ["src/storage/run-evidence.ts", "node:fs"],
    ["src/storage/sql.ts", "drizzle-orm/node-postgres"],
    ["src/storage/postgres/statements.ts", "../sqlite/database.js"],
    ["src/runtime/collection-routes.ts", "@neon/functions/triggers"],
    ["src/runtime/hosted-service.ts", "@neon/functions"],
    ["src/runtime/auth/better-auth.ts", "../../../deploy/neon/neon-login.js"],
    ["src/runtime/auth/better-auth.ts", "@neondatabase/auth/server"],
    ["src/targets/postgres.ts", "../../deploy/neon/function.js"],
    ["src/transport/http.ts", "@neon/functions"],
    ["src/storage/postgres/events.ts", "@neon/functions"],
    ["src/providers/isracard/transport.ts", "./node-http.js"],
    ["src/providers/isracard/collect.ts", "node:http2"],
    ["src/providers/isracard/node-http.ts", "pg"],
    ["src/storage/sqlite/database.ts", "@neondatabase/auth/server"],
  ])("rejects %s importing %s in every import form", async (file, source) => {
    for (const code of [
      `import { value } from "${source}";\n`,
      `import type { Value } from "${source}";\n`,
      `export { value } from "${source}";\n`,
    ]) {
      expect(await ruleIds(file, code)).toContain("no-restricted-imports");
    }
    for (const code of [
      `await import("${source}");\n`,
      `await import(\`${source}\`);\n`,
      `type Value = import("${source}").Value;\n`,
    ]) {
      expect(await ruleIds(file, code)).toContain(importExpressions);
    }
  });

  it.each([
    ["src/domain/records.ts", "./model.js"],
    ["src/domain/plans/sync.ts", "../records.js"],
    ["src/application/operations.ts", "../domain/plans/annotation.js"],
    ["src/providers/cal/collect.ts", "../../domain/source-adapter.js"],
    ["src/storage/sqlite/database.ts", "../../application/financial-store.js"],
    ["src/storage/turso.ts", "./sqlite/schema.js"],
    ["src/storage/store.ts", "../application/financial-store.js"],
    ["src/storage/sql.ts", "drizzle-orm"],
    ["src/storage/postgres/statements.ts", "../store.js"],
    ["src/transport/http.ts", "../application/operations.js"],
    ["src/storage/sqlite/schema.ts", "../../domain/records.js"],
    ["src/storage/sqlite/schema.ts", "drizzle-orm/sqlite-core"],
    ["src/storage/sqlite/statements.ts", "./schema.js"],
    ["deploy/neon/function.ts", "@neon/functions/triggers"],
    ["deploy/neon/function.ts", "./neon-login.js"],
    ["deploy/neon/neon-login.ts", "@neondatabase/auth/server"],
    ["src/providers/isracard/node-http.ts", "node:http2"],
    ["src/providers/isracard/node-http.ts", "./transport.js"],
  ])("allows %s to use its dependency %s", async (file, source) => {
    for (const code of [
      `import { value } from "${source}";\n`,
      `await import("${source}");\n`,
      `type Value = import("${source}").Value;\n`,
    ]) {
      expect(await ruleIds(file, code)).toEqual([]);
    }
  });

  it("rejects a dynamic import whose specifier cannot be checked", async () => {
    expect(
      await ruleIds("src/application/operations.ts", "await import(name);\n"),
    ).toContain(importExpressions);
  });

  it.each([
    "src/storage/sqlite/database.ts",
    "src/storage/store.ts",
    "src/storage/turso.ts",
  ])("keeps Drizzle builders out of %s", async (file) => {
    for (const method of [
      "select",
      "insert",
      "update",
      "findFirst",
      "findMany",
    ]) {
      expect(await ruleIds(file, `db.${method}();\n`)).toContain(
        "no-restricted-syntax",
      );
    }
  });
  it.each([
    "src/storage/sqlite/statements.ts",
    "src/storage/postgres/statements.ts",
  ])("allows Drizzle builders in %s", async (file) => {
    expect(await ruleIds(file, "db.select();\n")).toEqual([]);
  });

  it("allows ordinary Map deletion in storage workflows", async () => {
    expect(await ruleIds("src/storage/store.ts", "rows.delete(id);\n")).toEqual(
      [],
    );
  });

  it("keeps Node globals out of portable modules", async () => {
    expect(await ruleIds("src/domain/model.ts", "process.cwd();\n")).toContain(
      "no-restricted-globals",
    );
  });

  it("keeps imports before declarations and exports", async () => {
    expect(
      await ruleIds(
        "src/domain/model.ts",
        'export const value = 1;\n\nimport { z } from "zod";\n',
      ),
    ).toContain("no-restricted-syntax");
  });
});
