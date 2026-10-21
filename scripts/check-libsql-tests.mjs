import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { checkStorageCoverage } from "./storage-coverage.mjs";

// Minimum existing coverage, not an exact total: additions need no CI edit.
// Update these floors only when deliberately removing/reorganizing coverage.
export const requiredGroups = [
  ["backends.test.ts", "storage contract: libsql-http", 21],
  ["contract.test.ts", "shared storage behavior: libsql-http", 17],
  ["statement-counts.test.ts", "statement budgets: libsql-http", 9],
  ["auto-posting.test.ts", "libsql-http automatic posting and split", 67],
  ["billed-lines.test.ts", "libsql-http billed lines", 9],
  [
    "financial-corrections.test.ts",
    "compact financial corrections: libsql-http",
    2,
  ],
  ["financial-filters.test.ts", "financial read scopes: libsql-http", 5],
  ["perspectives.test.ts", "libsql-http continuation and perspectives", 6],
  [
    "posting-annotations.test.ts",
    "libsql-http link and unlink with annotations",
    3,
  ],
  [
    "reconciliation-scenarios.test.ts",
    "libsql-http reconciliation scenarios across successive recent captures",
    19,
  ],
  ["drivers.test.ts", "libSQL over actual HTTP", 3],
  ["delivery-concurrency.test.ts", "libSQL HTTP independent delivery", 1],
  ["http-uncertain.test.ts", "uncertain user writes over libSQL HTTP", 1],
];

// PostgreSQL-only groups (the postgres job runs them) and local D1 (the d1 job).
const optionalGroups = new Map([
  ["credentials.test.ts", "PostgreSQL provider credentials"],
  [
    "delivery-concurrency.test.ts",
    "PostgreSQL independent delivery and schema behavior",
  ],
  ["drivers.test.ts", "PostgreSQL transaction and schema guarantees"],
  ["migrations.test.ts", "numbered migrations: postgres"],
  ["events.test.ts", "durable PostgreSQL event subscriptions"],
  ["hosted-bootstrap.test.ts", "hosted PostgreSQL bootstrap"],
  ["hosted-collection.test.ts", "hosted PostgreSQL collection targets"],
  ["neon-installation.test.ts", "Neon installation binding"],
  ["neon-login-link.test.mjs", "Neon setup login link"],
  ["operator-parity.test.ts", "one operator CLI behavior"],
  ["postgres-cli.test.ts", "PostgreSQL operator CLI"],
  ["postgres-required.test.ts", "required PostgreSQL integration"],
  ["d1.test.ts", "guarded D1 write batches"],
]);

/** The libSQL job may skip only the exact PostgreSQL-only and local D1 groups. */
export function checkLibsqlTests(report) {
  const { requiredTests, optionalSkips } = checkStorageCoverage(report, {
    requiredGroups,
    isOptional: (file, titles) =>
      optionalGroups.has(file) && titles.includes(optionalGroups.get(file)),
  });
  return { libsqlTests: requiredTests, optionalSkips };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert.equal(
    process.argv.length,
    3,
    "Usage: node scripts/check-libsql-tests.mjs REPORT.json",
  );
  const result = checkLibsqlTests(
    JSON.parse(readFileSync(process.argv[2], "utf8")),
  );
  console.info(
    `libSQL coverage verified: ${result.libsqlTests} passed; ${result.optionalSkips} optional PostgreSQL/D1 skips`,
  );
}
