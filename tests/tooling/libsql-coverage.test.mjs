import { describe, expect, it } from "vitest";

import {
  checkLibsqlTests,
  requiredGroups,
} from "../../scripts/check-libsql-tests.mjs";

function passingReport() {
  return {
    success: true,
    numFailedTests: 0,
    testResults: requiredGroups.map(([file, group, count]) => ({
      name: `/checkout/tests/storage/${file}`,
      status: "passed",
      assertionResults: Array.from({ length: count }, (_, index) => ({
        title: `synthetic case ${index}`,
        ancestorTitles: [group],
        fullName: `${group} synthetic case ${index}`,
        status: "passed",
      })),
    })),
  };
}

function skipped(file, group) {
  return {
    name: `/checkout/tests/storage/${file}`,
    status: "passed",
    assertionResults: [
      {
        title: "synthetic case",
        fullName: `${group} synthetic case`,
        ancestorTitles: [group],
        status: "skipped",
      },
    ],
  };
}

describe("libSQL CI coverage gate", () => {
  it("accepts passing required groups and PostgreSQL or D1 skips", () => {
    const report = passingReport();
    report.testResults.push(
      skipped("events.test.ts", "durable PostgreSQL event subscriptions"),
      skipped("d1.test.ts", "guarded D1 write batches"),
    );
    expect(checkLibsqlTests(report)).toEqual({
      libsqlTests: requiredGroups.reduce((sum, group) => sum + group[2], 0),
      optionalSkips: 2,
    });
  });

  it("rejects a skipped libSQL HTTP group", () => {
    const report = passingReport();
    report.testResults[0].assertionResults[0].status = "skipped";
    expect(() => checkLibsqlTests(report)).toThrow("must pass");
  });

  it("rejects a missing libSQL backend even when SQLite passes", () => {
    const report = passingReport();
    for (const test of report.testResults[0].assertionResults) {
      test.ancestorTitles = ["storage contract: sqlite"];
    }
    expect(() => checkLibsqlTests(report)).toThrow("got 0");
  });

  it.each([
    ["contract.test.ts", "comparison with postgres"],
    ["contract.test.ts", "guarded D1 write batches"],
    ["events.test.ts", "PostgreSQL extras"],
  ])(
    "rejects an incidental PostgreSQL or misplaced D1 skip in %s: %s",
    (file, group) => {
      const report = passingReport();
      report.testResults.push(skipped(file, group));
      expect(() => checkLibsqlTests(report)).toThrow("Unexpected skipped");
    },
  );

  it("rejects a skip outside the PostgreSQL and D1 groups", () => {
    const report = passingReport();
    report.testResults.push(
      skipped("contract.test.ts", "shared storage behavior: sqlite"),
    );
    expect(() => checkLibsqlTests(report)).toThrow("Unexpected skipped");
  });
});
