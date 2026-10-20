import assert from "node:assert/strict";

/**
 * Verifies a Vitest JSON report for one backend's CI job: every required group
 * ran at least its floor of cases and all of them passed, and nothing else was
 * skipped except cases the job declares optional. Floors are minimum existing
 * coverage, not exact totals, so new cases need no CI edit.
 */
export function checkStorageCoverage(report, { requiredGroups, isOptional }) {
  assert.equal(report.success, true, "Vitest run must succeed");
  assert.equal(report.numFailedTests, 0, "Vitest must report no failed tests");
  assert.ok(Array.isArray(report.testResults), "Missing Vitest test results");
  let requiredTests = 0;
  for (const [file, group, minimum] of requiredGroups) {
    const suite = report.testResults.find((result) =>
      result.name.replaceAll("\\", "/").endsWith(`/tests/storage/${file}`),
    );
    assert.ok(suite, `Missing required file: ${file}`);
    const cases = suite.assertionResults.filter((test) =>
      test.ancestorTitles.includes(group),
    );
    assert.ok(
      cases.length >= minimum,
      `${file}: expected at least ${minimum} tests in ${group}, got ${cases.length}`,
    );
    for (const test of cases) {
      assert.equal(test.status, "passed", `${group}: ${test.title} must pass`);
    }
    requiredTests += cases.length;
  }
  let optionalSkips = 0;
  for (const suite of report.testResults) {
    assert.equal(suite.status, "passed", `${suite.name} must pass`);
    const file = suite.name.replaceAll("\\", "/").split("/").at(-1);
    for (const test of suite.assertionResults) {
      if (test.status === "passed") {
        continue;
      }
      assert.ok(
        ["pending", "skipped"].includes(test.status) &&
          isOptional(file, test.ancestorTitles),
        `Unexpected ${test.status}: ${test.fullName}`,
      );
      optionalSkips++;
    }
  }
  return { requiredTests, optionalSkips };
}
