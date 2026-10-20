import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Runs the audit as documented: no warning printer and no tsx compile cache. */
function audit(args: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      "tests/providers/cal/scripts/audit-cal-db.ts",
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, TSX_DISABLE_CACHE: "1" },
    },
  );
}

function createArchive(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE sync_runs (id INTEGER PRIMARY KEY, status TEXT, metadata_json TEXT, warnings_json TEXT);
    CREATE TABLE sync_run_bodies (run_id INTEGER PRIMARY KEY, snapshot_json TEXT);
  `);
}

function archiveRun(
  db: DatabaseSync,
  status: string,
  snapshot: string,
  warnings: string,
) {
  const decoded = JSON.parse(snapshot) as {
    responses: Record<string, unknown>[];
  };
  const metadata = JSON.stringify({
    ...decoded,
    responses: decoded.responses.map(
      ({ responseText: _body, ...response }) => response,
    ),
  });
  const result = db
    .prepare(
      "INSERT INTO sync_runs (status,metadata_json,warnings_json) VALUES (?,?,?)",
    )
    .run(status, metadata, warnings);
  db.prepare("INSERT INTO sync_run_bodies VALUES (?,?)").run(
    result.lastInsertRowid,
    snapshot,
  );
}

/** Invented key text in any letter case, so a plausible field name cannot leak. */
function expectNoSecrets(stdout: string): void {
  expect(stdout).not.toContain("SYNTHETIC_SECRET");
  expect(stdout.toLowerCase()).not.toContain("syntheticsecret");
  expect(stdout).not.toContain("987654321");
}

describe("value-free read-only CAL source audit", () => {
  let directory: string;
  let path: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "fonds-audit-"));
    path = join(directory, "invented.sqlite");
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("counts recent/legacy/monthly occurrences and reports structure without source values", () => {
    const db = new DatabaseSync(path);
    createArchive(db);
    const recent = JSON.parse(
      readFileSync(
        new URL("./fixtures/recent-01.json", import.meta.url),
        "utf8",
      ),
    );
    const legacy = JSON.parse(
      readFileSync(
        new URL("./fixtures/legacy-history.json", import.meta.url),
        "utf8",
      ),
    );
    recent.result.transactions[0].merchantName = "SYNTHETIC_SECRET_MERCHANT";
    // Unlisted keys that pass any naming filter are still never printed.
    recent.result.transactions[0].syntheticSecretMerchant = {
      syntheticSecretAccount: true,
    };
    recent.result.transactions[0]["SYNTHETIC_SECRET_MERCHANT"] =
      "SYNTHETIC_SECRET_ID";
    recent.result.transactions[0].amountForDisplay = "SYNTHETIC_SECRET_AMOUNT";
    const monthly = {
      statusCode: 1,
      result: {
        bankAccounts: [
          {
            debitDates: [
              {
                transactions: [
                  {
                    trnAmt: 987654321,
                    merchantName: "SYNTHETIC_SECRET_MERCHANT",
                  },
                ],
              },
            ],
            immidiateDebits: {
              debitDays: [
                {
                  transactions: [
                    {
                      trnAmt: 987654321,
                      merchantName: "SYNTHETIC_SECRET_MERCHANT",
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    for (const [value, kind] of [
      [recent, "recent"],
      [legacy, "history"],
      [monthly, "history"],
    ]) {
      archiveRun(
        db,
        "partial",
        JSON.stringify({
          responses: [
            {
              accountKey: "SYNTHETIC_SECRET_ID",
              scope: { kind },
              responseText: JSON.stringify(value),
            },
          ],
        }),
        JSON.stringify([
          "unsupported_monthly_rows:987654321",
          "SYNTHETIC_SECRET_MERCHANT:private-warning",
        ]),
      );
    }
    db.close();
    const before = readFileSync(path);
    const summary = audit(["--db", path]);
    expect(summary.status).toBe(0);
    expect(summary.stderr).toBe("");
    expectNoSecrets(summary.stdout);
    expect(JSON.parse(summary.stdout).fieldTypes).toBeUndefined();
    const result = audit(["--db", path, "--inventory"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expectNoSecrets(result.stdout);
    const report = JSON.parse(result.stdout);
    expect(JSON.parse(summary.stdout)).toEqual({
      ...report,
      fieldTypes: undefined,
    });
    expect(report.shapes).toEqual({ recent: 1, legacy: 1, monthly: 1 });
    expect(report.counts).toMatchObject({
      runs: 3,
      responses: 3,
      schema_checked: 2,
      schema_invalid: 1,
      schema_valid: 1,
      monthly_schema_unvalidated: 1,
    });
    expect(report.sourceRowOccurrences).toMatchObject({
      recent_posted: recent.result.transactions.length,
      recent_pending: recent.result.clearanceRequests.length,
      legacy_posted: legacy.result.transArr.length,
      monthly_billed: 1,
      monthly_immediate: 1,
    });
    expect(report.schemaViolations).toMatchObject({
      "type|$.result.transactions[].amountForDisplay": 1,
    });
    expect(report.unexpectedFieldTypesVsFixtures).toMatchObject({
      "$.postedRows[].<unlisted>|object": 1,
      "$.postedRows[].<unlisted>.<unlisted>|boolean": 1,
      "$.postedRows[].<unlisted>|string": 1,
    });
    expect(
      report.fieldTypes[
        "$.result.bankAccounts[].debitDates[].transactions[]|object"
      ],
    ).toBe(1);
    expect(report.extractionWarningCodes).toEqual({
      unknown: 3,
      unsupported_monthly_rows: 3,
    });
    expect(readFileSync(path)).toEqual(before);
  });

  it("separates catalog/no-data contracts and shares posted fixture types across envelopes", () => {
    const db = new DatabaseSync(path);
    createArchive(db);
    const searchEndpoint =
      "https://api.cal-online.co.il/Transactions/api/filteredTransactions/getFilteredTransactions";
    const statementEndpoint =
      "https://api.cal-online.co.il/ReportList/api/digitalServices/reportListsSearch";
    const legacy = JSON.parse(
      readFileSync(
        new URL("./fixtures/legacy-history.json", import.meta.url),
        "utf8",
      ),
    );
    legacy.result.transArr[0].cashAccountTrnAmt = 123.4567;
    legacy.result.transArr[0].comments = [
      { key: "SYNTHETIC_SECRET_KEY", value: "SYNTHETIC_SECRET_VALUE" },
    ];
    legacy.result.transArr[0].newOpaqueCode = true;
    const sources = [
      { endpoint: searchEndpoint, value: legacy },
      {
        endpoint: searchEndpoint,
        value: {
          statusCode: 93,
          result: null,
          statusDescription: "לא נמצאו נתונים עבור הפרמטרים שהוזנו",
        },
      },
      {
        endpoint: statementEndpoint,
        value: { statusCode: 26, statusDescription: null },
      },
      {
        endpoint: statementEndpoint,
        value: { statusCode: 55, result: null, statusDescription: null },
      },
      {
        endpoint: statementEndpoint,
        value: {
          statusCode: 1,
          result: {
            months: [
              {
                reportList: [
                  { envelopeId: "SYNTHETIC_SECRET_ID" },
                  { envelopeId: "SYNTHETIC_SECRET_ID_TWO" },
                ],
              },
            ],
          },
        },
      },
    ];
    for (const source of sources) {
      archiveRun(
        db,
        "completed",
        JSON.stringify({
          responses: [
            {
              endpoint: source.endpoint,
              scope: { kind: "history" },
              responseText: JSON.stringify(source.value),
            },
          ],
        }),
        "[]",
      );
    }
    db.close();
    const result = audit(["--db", path, "--inventory"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expectNoSecrets(result.stdout);
    const report = JSON.parse(result.stdout);
    expect(report.shapes).toEqual({
      legacy: 1,
      search_empty: 1,
      statement_empty: 2,
      statement_catalog: 1,
    });
    expect(report.counts).toMatchObject({
      schema_checked: 1,
      schema_valid: 1,
      search_empty_expected_shape: 1,
      statement_empty_expected_shape: 2,
      statement_catalog_schema_unvalidated: 1,
      statement_document_occurrences: 2,
      financial_row_occurrences: legacy.result.transArr.length,
    });
    expect(report.schemaViolations).toEqual({});
    expect(report.counts.schema_invalid).toBeUndefined();
    expect(
      report.unexpectedFieldTypesVsFixtures[
        "$.postedRows[].<unlisted>|boolean"
      ],
    ).toBe(1);
    expect(
      report.unexpectedFieldTypesVsFixtures[
        "$.postedRows[].comments[].key|string"
      ],
    ).toBeUndefined();
    expect(
      report.unexpectedFieldTypesVsFixtures[
        "$.postedRows[].cashAccountTrnAmt|number"
      ],
    ).toBeUndefined();
    expect(
      report.fieldTypes["$.result.transArr[].cashAccountTrnAmt|number"],
    ).toBe(1);
    expect(report.fieldTypes["$.statusDescription|null"]).toBe(2);
  });

  it("reads released capture receipts without inventing source bodies", () => {
    const db = new DatabaseSync(path);
    createArchive(db);
    db.prepare(
      "INSERT INTO sync_runs (status,metadata_json,warnings_json) VALUES (?,?,?)",
    ).run(
      "completed",
      JSON.stringify({
        schemaVersion: 1,
        responses: [
          { accountKey: "SYNTHETIC_SECRET_ID", scope: { kind: "recent" } },
        ],
      }),
      "[]",
    );
    db.close();
    const result = audit(["--db", path]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expectNoSecrets(result.stdout);
    const report = JSON.parse(result.stdout);
    expect(report.counts.runs).toBe(1);
    expect(report.counts.invalid_run_metadata).toBeUndefined();
    expect(report.counts.response_bodies_unavailable).toBe(1);
    expect(report.counts.invalid_response_json_or_structure).toBeUndefined();
    expect(report.counts.financial_row_occurrences).toBe(0);
    expect(report.sourceRowOccurrences).toEqual({});
  });

  it("rejects missing databases and malformed arguments with value-free errors", () => {
    const result = audit([
      "--db",
      join(directory, "SYNTHETIC_SECRET_ID.sqlite"),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("SYNTHETIC_SECRET");
    const argument = audit(["--private", "SYNTHETIC_SECRET_MERCHANT"]);
    expect(argument.status).toBe(1);
    expect(argument.stderr).not.toContain("SYNTHETIC_SECRET");
  });
});
