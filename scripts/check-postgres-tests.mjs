import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { checkStorageCoverage } from "./storage-coverage.mjs";

// Minimum existing coverage, not an exact total: additions need no CI edit.
// Update these floors only when deliberately removing/reorganizing coverage.
export const requiredGroups = [
  ["service.test.ts", "service integration: postgres", 32],
  ["source-presence.test.ts", "postgres authoritative source presence", 27],
  ["posting-overlap.test.ts", "postgres delayed posting overlap", 55],
  ["source-identity.test.ts", "postgres captured source identity", 10],
  ["financial-authority.test.ts", "postgres row financial authority", 8],
  [
    "financial-posting-authority.test.ts",
    "postgres financial authority and posting",
    4,
  ],
  [
    "linked-component-current.test.ts",
    "postgres linked current pending component",
    13,
  ],
  ["installment-role.test.ts", "postgres installment role without count", 2],
  [
    "collection.test.ts",
    "streamed collection application boundary: postgres",
    25,
  ],
  ["notifications.test.ts", "durable change delivery: postgres", 11],
  ["lifecycle.test.ts", "owner-confirmed transaction lifecycle: postgres", 34],
  [
    "lifecycle-sync.test.ts",
    "collection and owner lifecycle integration: postgres",
    23,
  ],
  [
    "query-review.test.ts",
    "public review state and scalar totals: postgres",
    24,
  ],
  [
    "reconciliation-index.test.ts",
    "reconciliation indexes and provider boundaries: postgres",
    31,
  ],
  [
    "historical-sync.test.ts",
    "historical capture reconciliation: postgres",
    44,
  ],
  ["backends.test.ts", "storage contract: postgres", 34],
  ["contract.test.ts", "shared storage behavior: postgres", 22],
  ["statement-counts.test.ts", "statement budgets: postgres", 8],
  ["drivers.test.ts", "PostgreSQL transaction and schema guarantees", 7],
  ["migrations.test.ts", "numbered migrations: postgres", 5],
  [
    "delivery-concurrency.test.ts",
    "PostgreSQL independent delivery and schema behavior",
    5,
  ],
  ["events.test.ts", "durable PostgreSQL event subscriptions", 5],
  ["postgres-required.test.ts", "required PostgreSQL integration", 1],
  ["hosted-bootstrap.test.ts", "hosted PostgreSQL bootstrap", 6],
  ["hosted-collection.test.ts", "hosted PostgreSQL collection targets", 2],
  ["operations-parity.test.ts", "operations parity on postgres", 12],
  ["operations-parity.test.ts", "collection lease on postgres", 5],
];

const optionalGroups = new Map([
  ["drivers.test.ts", "libSQL over actual HTTP"],
  ["delivery-concurrency.test.ts", "libSQL HTTP independent delivery"],
  ["http-uncertain.test.ts", "uncertain user writes over libSQL HTTP"],
  ["d1.test.ts", "guarded D1 write batches"],
]);

/** The PostgreSQL job may skip only the libSQL HTTP and local D1 groups. */
export function checkPostgresTests(report) {
  const { requiredTests, optionalSkips } = checkStorageCoverage(report, {
    requiredGroups,
    isOptional: (file, titles) =>
      optionalGroups.has(file) && titles.includes(optionalGroups.get(file)),
  });
  return { postgresTests: requiredTests, optionalSkips };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert.equal(
    process.argv.length,
    3,
    "Usage: node scripts/check-postgres-tests.mjs REPORT.json",
  );
  const result = checkPostgresTests(
    JSON.parse(readFileSync(process.argv[2], "utf8")),
  );
  console.info(
    `PostgreSQL coverage verified: ${result.postgresTests} passed; ${result.optionalSkips} optional libSQL HTTP/D1 skips (their own jobs run them)`,
  );
}
