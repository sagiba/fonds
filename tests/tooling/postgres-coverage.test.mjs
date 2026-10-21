import { describe, expect, it } from "vitest";

import {
  checkPostgresTests,
  requiredGroups,
} from "../../scripts/check-postgres-tests.mjs";

/** One suite per file, holding every required group of that file. */
function passingReport() {
  const files = new Map();
  for (const [file, group, count] of requiredGroups) {
    files.set(file, [
      ...(files.get(file) ?? []),
      ...Array.from({ length: count }, (_, index) => ({
        title: `synthetic case ${index}`,
        ancestorTitles: [group],
        fullName: `${group} synthetic case ${index}`,
        status: "passed",
      })),
    ]);
  }
  return {
    success: true,
    numFailedTests: 0,
    testResults: [...files].map(([file, assertionResults]) => ({
      name: `/checkout/tests/storage/${file}`,
      status: "passed",
      assertionResults,
    })),
  };
}

describe("PostgreSQL CI coverage gate", () => {
  it("accepts passing required groups and documented optional skips", () => {
    const report = passingReport();
    report.testResults.push({
      name: "/checkout/tests/storage/d1.test.ts",
      status: "passed",
      assertionResults: [
        {
          title: "synthetic D1 case",
          fullName: "guarded D1 write batches synthetic D1 case",
          ancestorTitles: ["guarded D1 write batches"],
          status: "pending",
        },
      ],
    });
    expect(checkPostgresTests(report)).toEqual({
      postgresTests: requiredGroups.reduce((sum, group) => sum + group[2], 0),
      optionalSkips: 1,
    });
  });

  it("rejects an unsuccessful run even when its individual cases passed", () => {
    const report = passingReport();
    report.success = false;
    expect(() => checkPostgresTests(report)).toThrow("Vitest run must succeed");
  });

  it("rejects a missing required file", () => {
    const report = passingReport();
    report.testResults.pop();
    expect(() => checkPostgresTests(report)).toThrow("Missing required file");
  });

  it("rejects a missing PostgreSQL backend even when SQLite passes", () => {
    const report = passingReport();
    for (const test of report.testResults[0].assertionResults) {
      test.ancestorTitles = ["storage contract: sqlite"];
    }
    expect(() => checkPostgresTests(report)).toThrow("got 0");
  });

  it.each(["pending", "skipped", "todo", "failed"])(
    "rejects a %s PostgreSQL case even if the report claims success",
    (status) => {
      const report = passingReport();
      report.testResults[0].assertionResults[0].status = status;
      expect(() => checkPostgresTests(report)).toThrow("must pass");
    },
  );

  it("rejects a disappearing case below the coverage floor", () => {
    const report = passingReport();
    report.testResults[0].assertionResults.pop();
    expect(() => checkPostgresTests(report)).toThrow("got 33");
  });

  it("rejects unrelated skipped cases", () => {
    const report = passingReport();
    report.testResults[0].assertionResults.push({
      title: "unrelated case",
      fullName: "unrelated case",
      ancestorTitles: [],
      status: "pending",
    });
    expect(() => checkPostgresTests(report)).toThrow("Unexpected pending");
  });
});
