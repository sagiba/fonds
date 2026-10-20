import { readFileSync } from "node:fs";

import { createClient, type InValue } from "@libsql/client/node";
import { drizzle as d1Drizzle } from "drizzle-orm/d1";
import { drizzle as sqliteDrizzle } from "drizzle-orm/libsql";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/domain/model.js";
import { emptyDetails, unknownLedgerFacts } from "../../src/domain/model.js";
import { FinancialPlan } from "../../src/domain/plans/state.js";
import type { Transaction } from "../../src/domain/records.js";
import { migratePostgresSchema } from "../../src/storage/postgres/initialize.js";
import { postgresMigrations } from "../../src/storage/postgres/migration.js";
import * as postgresStatements from "../../src/storage/postgres/statements.js";
import { migrateSqliteSchema } from "../../src/storage/sqlite/migrate.js";
import { sqliteMigrations } from "../../src/storage/sqlite/migration.js";
import * as sqliteStatements from "../../src/storage/sqlite/statements.js";
import type { DeferredEvidenceWrite } from "../../src/storage/statements.js";
import { encodeScalarText } from "../../src/storage/transaction-codec.js";
import { disposableDatabase } from "../helpers/postgres-database.js";
import { d1Enabled, loadMiniflare } from "../helpers/storage-harness.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;
const instant = "2040-07-01T00:00:00.000Z";
const values = [
  "ordinary",
  "\\j",
  "actual\u0000nul",
  "adjacent\u0000\u0000nuls",
  "backslash\\\u0000nul",
  "double\\\\\u0000nul",
  '\\j"prefixed"',
  "literal\\u0000",
  "back\\slash",
  "new\nline",
  "🚀",
  "\ud800",
  "\udfff",
  'quoted"value',
  "\u0001\tcontrol",
];

function transaction(id: string, value: string): Transaction {
  return {
    ...unknownLedgerFacts(null),
    id,
    connectionId: "synthetic",
    sourceScope: "account",
    sourceKey: id,
    sourceAliases: [],
    identityStrength: "native",
    status: "pending",
    presence: "seen",
    description: "Synthetic",
    counterpartyName: null,
    kind: "purchase",
    merchantName: "Merchant",
    merchantProviderId: null,
    merchantCategoryCode: null,
    transactionDate: "2040-07-01",
    bookingDate: null,
    billingDate: null,
    amountMinor: -100,
    currency: "ILS",
    amountBasis: "authorization",
    originalAmountMinor: null,
    originalCurrency: null,
    installmentCount: null,
    details: {
      ...emptyDetails(),
      merchant: {
        address: value,
        phone: value,
        city: value,
        countryCode: "ISR",
      },
      transactionDateTime: "2040-07-01T03:04:05+03:00",
      additionalInformation: [value, value],
      currencyExchange: [
        {
          sourceCurrency: "USD",
          targetCurrency: "ILS",
          unitCurrency: "USD",
          exchangeRate: "3.123456789012345678",
          quotationDate: null,
        },
      ],
      sourceRefs: [{ runId: "run", path: "$.invented" }],
      issues: ["synthetic_issue"],
      paymentContextConflicts: ["wallet"],
      pendingPostingCandidates: ["other"],
      rejectedPostingKeys: ["rejected"],
      provider: {
        cal: {
          rows: [
            {
              merchantName: "a\u0000b",
              merchantAddress: "\\u0000",
              transactionID: "9007199254740993",
              merchantPhoneNo: value,
            },
          ],
          retained: { comments: [{ text: value }], paymentHistory: [] },
          identity: { baseKey: id, occurrenceCount: 1 },
          currencyMapping: "synthetic convention",
        },
      },
    },
    firstSeenAt: instant,
    lastSeenAt: instant,
    lastSeenRunId: "run",
    version: 1,
    supersededById: null,
  };
}

function legacyDetails(
  details: Transaction["details"],
): Transaction["details"] {
  const legacy = structuredClone(details);
  const cal = legacy.provider.cal!;
  cal.undeclared = { noise: ["discard"] };
  (cal.rows as Record<string, unknown>[])[0]!.undeclared = { noise: "discard" };
  (cal.identity as Record<string, unknown>).undeclared = "discard";
  (
    (cal.retained as Record<string, unknown>).comments as Record<
      string,
      unknown
    >[]
  )[0]!.undeclared = "discard";
  if (legacy.postingLink) {
    legacy.postingLink.pending.details = legacyDetails(
      legacy.postingLink.pending.details,
    );
  }
  return legacy;
}

interface Subject {
  query(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
  migrate(): Promise<void>;
  read(id: string): Promise<Transaction[]>;
  write(
    row: Transaction,
    before?: Transaction,
    observationOnly?: boolean,
  ): Promise<void>;
  defer(row: DeferredEvidenceWrite): Promise<void>;
  close(): Promise<void>;
}

async function subject(postgres: boolean, d1 = false): Promise<Subject> {
  if (d1) {
    const Miniflare = await loadMiniflare();
    const runtime = new Miniflare({
      modules: true,
      script: "export default {}",
      d1Databases: ["DB"],
    });
    const binding = await runtime.getD1Database("DB");
    const migrate = async (migrations: typeof sqliteMigrations) => {
      for (const migration of migrations) {
        const sql = readFileSync(
          new URL(`../../migrations/d1/${migration.name}.sql`, import.meta.url),
          "utf8",
        );
        const statements = sql
          .split(/;\s*$/m)
          .map((value) => value.trim())
          .filter((value) => value && !/^(--[^\n]*\n?)*$/.test(value));
        await binding.batch(statements.map((sql) => binding.prepare(sql)));
      }
    };
    await migrate(sqliteMigrations.slice(0, 2));
    const db = d1Drizzle(binding);
    return {
      query: async (sql, args = []) =>
        (
          await binding
            .prepare(sql)
            .bind(...args)
            .all<Record<string, unknown>>()
        ).results,
      migrate: () => migrate(sqliteMigrations.slice(2)),
      read: (id) => sqliteStatements.transaction(db, id),
      write: async (row, before, observationOnly) => {
        const plan = new FinancialPlan({
          connection: {
            id: "synthetic",
            provider: "cal",
            displayName: "Synthetic",
            config: { schemaVersion: 1 },
            createdAt: instant,
          },
          rows: before ? [before] : [],
          annotations: [],
          priorRuns: [],
          removals: [],
        });
        if (observationOnly) {
          plan.observationWrites.set(row.id, row);
        } else if (before) {
          plan.updateTransaction(row.id, row);
        } else {
          plan.insertTransaction(row);
        }
        for (const statement of sqliteStatements.applyPlan(db, plan)) {
          await statement;
        }
      },
      defer: async (row) => {
        await sqliteStatements.upsertDeferredEvidence(db, row);
      },
      close: () => runtime.dispose(),
    };
  }

  if (postgres) {
    const database = await disposableDatabase(
      postgresUrl!,
      "fonds_refresh_migration",
    );
    const pool = new Pool({
      connectionString: database.url,
      options: database.options,
    });
    await migratePostgresSchema(pool, postgresMigrations.slice(0, 2), null);
    const db = postgresDrizzle(pool);
    return {
      query: async (sql, args = []) => {
        let index = 0;
        return (
          await pool.query(
            sql.replace(/\?/g, () => `$${++index}`),
            args,
          )
        ).rows;
      },
      migrate: () => migratePostgresSchema(pool),
      read: (id) => postgresStatements.transaction(db, id),
      write: async (row, before, observationOnly) => {
        const plan = new FinancialPlan({
          connection: {
            id: "synthetic",
            provider: "cal",
            displayName: "Synthetic",
            config: { schemaVersion: 1 },
            createdAt: instant,
          },
          rows: before ? [before] : [],
          annotations: [],
          priorRuns: [],
          removals: [],
        });
        if (observationOnly) {
          plan.observationWrites.set(row.id, row);
        } else if (before) {
          plan.updateTransaction(row.id, row);
        } else {
          plan.insertTransaction(row);
        }
        for (const statement of postgresStatements.applyPlan(db, plan)) {
          await statement;
        }
      },
      defer: async (row) => {
        await postgresStatements.upsertDeferredEvidence(db, row);
      },
      close: async () => {
        await pool.end();
        await database.drop();
      },
    };
  }
  const client = createClient({ url: "file::memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  await migrateSqliteSchema(client, sqliteMigrations.slice(0, 2), null);
  const db = sqliteDrizzle(client);
  return {
    query: async (sql, args = []) =>
      (await client.execute({ sql, args: args as InValue[] }))
        .rows as unknown as Record<string, unknown>[],
    migrate: () => migrateSqliteSchema(client),
    read: (id) => sqliteStatements.transaction(db, id),
    write: async (row, before, observationOnly) => {
      const plan = new FinancialPlan({
        connection: {
          id: "synthetic",
          provider: "cal",
          displayName: "Synthetic",
          config: { schemaVersion: 1 },
          createdAt: instant,
        },
        rows: before ? [before] : [],
        annotations: [],
        priorRuns: [],
        removals: [],
      });
      if (observationOnly) {
        plan.observationWrites.set(row.id, row);
      } else if (before) {
        plan.updateTransaction(row.id, row);
      } else {
        plan.insertTransaction(row);
      }
      for (const statement of sqliteStatements.applyPlan(db, plan)) {
        await statement;
      }
    },
    defer: async (row) => {
      await sqliteStatements.upsertDeferredEvidence(db, row);
    },
    close: async () => client.close(),
  };
}

for (const backend of [
  "sqlite",
  "postgres",
  ...(d1Enabled ? ["d1-local"] : []),
]) {
  const postgres = backend === "postgres";
  const d1 = backend === "d1-local";
  describe.skipIf(postgres && !postgresUrl)(
    `${backend} refresh storage migration`,
    () => {
      it("preserves exact evidence, scalar escapes, posting restoration, references and immutable events", async () => {
        const db = await subject(postgres, d1);
        try {
          await db.query(
            "INSERT INTO connections(id,provider,display_name,config_json,created_at) VALUES (?,?,?,?,?)",
            ["synthetic", "cal", "Synthetic", '{"schemaVersion":1}', instant],
          );
          const snapshot = JSON.stringify({
            schemaVersion: 1,
            responses: [
              {
                accountKey: "account",
                endpoint: "synthetic",
                capturedAt: instant,
                responseText: "actual\u0000literal\\u0000",
              },
            ],
            failures: [],
          });
          await db.query(
            `INSERT INTO sync_runs(id,connection_id,started_at,status,collector_version,parser_version,snapshot_json,${postgres ? "metadata_json," : ""}coverage_json,warnings_json) VALUES (?,?,?,?,?,?,?${postgres ? ",?" : ""},?,?)`,
            [
              "run",
              "synthetic",
              instant,
              "completed",
              "synthetic",
              "synthetic",
              snapshot,
              ...(postgres
                ? [JSON.stringify({ responses: [], failures: [] })]
                : []),
              "[]",
              "[]",
            ],
          );
          const expected = values.map((value, index) =>
            transaction(`tx-${index}`, value),
          );
          const pending = transaction(
            "pending-retained",
            "restored\u0000merchant",
          );
          expected[0]!.details.postingLink = {
            schemaVersion: 1,
            policyVersion: "synthetic",
            automatic: false,
            postedId: "retired",
            pending: { ...pending, status: "pending", supersededById: null },
            pendingKeys: ["pending-retained"],
            postedKeys: ["retired"],
            evidence: { runId: "run", capturedAt: instant },
          };
          for (const row of expected) {
            await db.query(
              "INSERT INTO transactions(id,connection_id,source_scope,source_key,source_aliases_json,identity_strength,status,presence,kind,amount_basis,details_json,first_seen_at,last_seen_at,last_seen_run_id,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              [
                row.id,
                row.connectionId,
                row.sourceScope,
                row.sourceKey,
                "[]",
                row.identityStrength,
                row.status,
                row.presence,
                row.kind,
                row.amountBasis,
                JSON.stringify(legacyDetails(row.details)),
                instant,
                instant,
                "run",
                1,
              ],
            );
          }
          const event = JSON.stringify({
            raw: "a\u0000b",
            sourceRefs: [{ runId: "run", path: "$.old" }],
          });
          await db.query(
            "INSERT INTO events(connection_id,transaction_id,run_id,type,created_at,actor,before_json,after_json) VALUES (?,?,?,?,?,?,?,?)",
            [
              "synthetic",
              "tx-0",
              "run",
              "transaction.updated",
              instant,
              "synthetic",
              event,
              event,
            ],
          );
          await db.query(
            "INSERT INTO annotations(transaction_id,version,data_json,updated_at) VALUES (?,?,?,?)",
            ["tx-0", 1, JSON.stringify({ notes: "owner\u0000note" }), instant],
          );
          await db.migrate();
          expect(
            (
              await db.query(
                "SELECT snapshot_json,retention,expires_at FROM sync_run_bodies WHERE run_id = ?",
                ["run"],
              )
            )[0],
          ).toEqual({
            snapshot_json: snapshot,
            retention: "legacy",
            expires_at: null,
          });
          expect(
            (await db.query("SELECT before_json,after_json FROM events"))[0],
          ).toEqual({ before_json: event, after_json: event });
          expect(
            JSON.parse(
              String(
                (await db.query("SELECT data_json FROM annotations"))[0]!
                  .data_json,
              ),
            ),
          ).toEqual({ notes: "owner\u0000note" });
          for (const row of expected) {
            const migrated = (await db.read(row.id))[0]!;
            expect(migrated.details).toEqual(row.details);
            expect(migrated.lastSeenRunId).toBe("run");
            expect(
              (
                await db.query(
                  "SELECT merchant_address_line,provider_json FROM transactions WHERE id = ?",
                  [row.id],
                )
              )[0]!.merchant_address_line,
            ).toBe(encodeScalarText(row.details.merchant.address!));
            const provider = JSON.parse(
              String(
                (
                  await db.query(
                    "SELECT provider_json FROM transactions WHERE id = ?",
                    [row.id],
                  )
                )[0]!.provider_json,
              ),
            );
            expect(provider.cal.identity).toBeUndefined();
            expect(provider.cal.currencyMapping).toBeUndefined();
            expect(provider.cal.retained).toEqual(
              row.details.provider.cal!.retained,
            );
            const written = {
              ...row,
              id: `new-${row.id}`,
              sourceKey: `new-${row.sourceKey}`,
            };
            await db.write(written);
            expect((await db.read(written.id))[0]).toEqual(written);
          }
          await expect(
            db.query("SELECT details_json FROM transactions"),
          ).rejects.toThrow();
          await expect(
            db.query("SELECT snapshot_json FROM sync_runs"),
          ).rejects.toThrow();
        } finally {
          await db.close();
        }
      }, 20_000);
      it("projects legacy nested slots and preserves declared list order, multiplicity and malformed types", async () => {
        const db = await subject(postgres, d1);
        try {
          await db.query(
            "INSERT INTO connections(id,provider,display_name,config_json,created_at) VALUES (?,?,?,?,?)",
            ["synthetic", "cal", "Synthetic", '{"schemaVersion":1}', instant],
          );
          await db.query(
            `INSERT INTO sync_runs(id,connection_id,started_at,status,collector_version,parser_version,snapshot_json,${postgres ? "metadata_json," : ""}coverage_json,warnings_json) VALUES (?,?,?,?,?,?,?${postgres ? ",?" : ""},?,?)`,
            [
              "run",
              "synthetic",
              instant,
              "completed",
              "synthetic",
              "synthetic",
              '{"schemaVersion":1,"responses":[]}',
              ...(postgres ? ['{"responses":[],"failures":[]}'] : []),
              "[]",
              "[]",
            ],
          );
          const commentRows = [
            { key: "\ue000", value: "tail", undeclared: "discard" },
            { key: "🚀", value: "astral", undeclared: "discard" },
            { key: "a", value: { undeclared: "discard" } },
            { key: "b", value: [{ undeclared: "discard" }] },
            { key: "a", value: { undeclared: "discard" } },
          ];
          const rawCal: JsonObject = {
            rows: [
              {
                transactionID: "b",
                comments: commentRows,
                forcedDebRate: { undeclared: "discard" },
                trnIntId: [{ undeclared: "discard" }],
                undeclared: "discard",
              },
              {
                transactionID: "a",
                comments: commentRows,
                forcedDebRate: { undeclared: "discard" },
                trnIntId: [{ undeclared: "discard" }],
                undeclared: "discard",
              },
              null,
              "row primitive",
              [{ undeclared: "discard" }],
              { merchantName: { undeclared: "discard" } },
            ],
            retained: {
              comments: [
                { text: "z", undeclared: "discard" },
                { text: "a" },
                { text: "a", undeclared: "discard" },
              ],
              paymentHistory: [
                { num: "2", amount: { undeclared: "discard" } },
                { num: "1", amount: { undeclared: "discard" } },
              ],
              undeclared: "discard",
            },
            identity: {
              baseKey: "cal-base",
              occurrenceCount: 2,
              undeclared: "discard",
            },
            currencyMapping: "convention",
            undeclared: "discard",
          };
          const legacySourceRow: JsonObject = {
            voucherNumberRatz: "legacy-2",
            dealSum: "2",
            currentPaymentCurrency: { undeclared: "discard" },
            seqVoucherNumber: "discard",
            currencyIso: "discard",
            undeclared: "discard",
            origin: "digital",
            generation: "digital",
          };
          const digitalSourceRow: JsonObject = {
            seqVoucherNumber: "digital-2",
            billingAmount: "1",
            voucherNumberRatz: "discard",
            currencyIso: "discard",
            undeclared: "discard",
            origin: "legacy",
            generation: "legacy",
          };
          const rawIsracard: JsonObject = {
            rows: [
              {
                businessName: "approved",
                purchaseDate: "11/06/2040",
                originalAmount: "86.4",
                currencyIso: "ILS",
                confirmationLocation: "17",
                seqConfirmationNumber: "SYNTHETIC-SEQUENCE",
                confirmationTimeStamp: "20400611:123000:001",
                confirmationNumber: "SYNTHETIC-DISPLAY",
                undeclared: "discard",
              },
              legacySourceRow,
              digitalSourceRow,
              { businessName: "digital-detection" },
            ],
            detail: {
              address: "nul\u0000literal\\u0000",
              dollarConversion: { undeclared: "discard" },
              Table1: [
                { paymentNumber: "2", undeclared: "discard" },
                { paymentNumber: "1" },
              ],
              undeclared: "discard",
            },
            identity: {
              baseKey: "isracard-base",
              occurrenceCount: 1,
              undeclared: "discard",
            },
            observations: [
              {
                generation: "digital",
                path: "$.second",
                row: Object.fromEntries(
                  Object.entries(digitalSourceRow).reverse(),
                ),
              },
              {
                generation: "legacy",
                path: "$.first",
                row: legacySourceRow,
              },
            ],
            monetaryEvidence: {
              billingMinor: -100,
              billingCurrency: "ILS",
              convention: "exact",
              statedTotals: [
                ["ILS", -100],
                ["USD", "9007199254740993"],
                ["ILS", -100],
              ],
              undeclared: "discard",
            },
            billingMonth: "2040-07",
            undeclared: "discard",
          };
          const projectedComments = [
            { key: "a", value: {} },
            { key: "a", value: {} },
            { key: "b", value: [] },
            { key: "🚀", value: "astral" },
            { key: "\ue000", value: "tail" },
          ];
          const calSource: JsonObject = {
            rows: [
              "row primitive",
              [],
              null,
              {
                transactionID: "a",
                comments: projectedComments,
                forcedDebRate: {},
                trnIntId: [],
              },
              {
                transactionID: "b",
                comments: projectedComments,
                forcedDebRate: {},
                trnIntId: [],
              },
              { merchantName: {} },
            ],
            retained: {
              comments: [{ text: "a" }, { text: "a" }, { text: "z" }],
              paymentHistory: [
                { num: "1", amount: {} },
                { num: "2", amount: {} },
              ],
            },
          };
          const isracardSource: JsonObject = {
            rows: [
              { seqVoucherNumber: "digital-2", billingAmount: "1" },
              {
                businessName: "approved",
                purchaseDate: "11/06/2040",
                originalAmount: "86.4",
                currencyIso: "ILS",
                confirmationLocation: "17",
                seqConfirmationNumber: "SYNTHETIC-SEQUENCE",
                confirmationTimeStamp: "20400611:123000:001",
                confirmationNumber: "SYNTHETIC-DISPLAY",
              },
              { businessName: "digital-detection" },
              {
                voucherNumberRatz: "legacy-2",
                dealSum: "2",
                currentPaymentCurrency: {},
              },
            ],
            detail: {
              address: "nul\u0000literal\\u0000",
              dollarConversion: {},
              Table1: [{ paymentNumber: "2" }, { paymentNumber: "1" }],
            },
          };
          const expectedProvider = {
            cal: {
              ...calSource,
              identity: { baseKey: "cal-base", occurrenceCount: 2 },
              currencyMapping: "convention",
            },
            isracard: {
              ...isracardSource,
              identity: { baseKey: "isracard-base", occurrenceCount: 1 },
              observations: [
                { generation: "digital", path: "$.second" },
                { generation: "legacy", path: "$.first" },
              ],
              monetaryEvidence: {
                billingMinor: -100,
                billingCurrency: "ILS",
                convention: "exact",
                statedTotals: [
                  ["ILS", -100],
                  ["USD", "9007199254740993"],
                  ["ILS", -100],
                ],
              },
              billingMonth: "2040-07",
            },
          };
          const row = transaction("projection", "ordinary");
          row.details.additionalInformation = [
            "z",
            "a",
            "\u0000",
            '"quoted"',
            "\\literal",
            "a",
            "\ue000",
            "🚀",
          ];
          const expectedAdditional = [
            '"quoted"',
            "\\literal",
            "\u0000",
            "a",
            "a",
            "z",
            "🚀",
            "\ue000",
          ];
          row.details.issues = [
            "z",
            "a",
            "\u0000",
            '"quoted"',
            "\\literal",
            "a",
            "\ue000",
            "🚀",
          ];
          const expectedIssues = [
            '"quoted"',
            "\\literal",
            "\u0000",
            "a",
            "z",
            "🚀",
            "\ue000",
          ];
          row.details.provider = { cal: rawCal, isracard: rawIsracard };
          const pending = structuredClone(row);
          pending.id = "retained-pending";
          row.details.postingLink = {
            schemaVersion: 1,
            policyVersion: "synthetic",
            automatic: false,
            postedId: "retired",
            pending: { ...pending, status: "pending", supersededById: null },
            pendingKeys: ["pending"],
            postedKeys: ["retired"],
            evidence: { runId: "run", capturedAt: instant },
          };
          await db.query(
            "INSERT INTO transactions(id,connection_id,source_scope,source_key,source_aliases_json,identity_strength,status,presence,kind,amount_basis,details_json,first_seen_at,last_seen_at,last_seen_run_id,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
              row.id,
              row.connectionId,
              row.sourceScope,
              row.sourceKey,
              "[]",
              row.identityStrength,
              row.status,
              row.presence,
              row.kind,
              row.amountBasis,
              JSON.stringify(row.details),
              instant,
              instant,
              "run",
              1,
            ],
          );
          await db.migrate();
          const migrated = (await db.read(row.id))[0]!;
          expect(migrated.details.provider).toEqual(expectedProvider);
          expect(migrated.details.issues).toEqual(expectedIssues);
          expect(migrated.details.postingLink!.pending.details.issues).toEqual(
            expectedIssues,
          );
          const sourceIssues = (
            await db.query(
              "SELECT source_issues_json FROM transactions WHERE id=?",
              [row.id],
            )
          )[0]!.source_issues_json;
          expect(JSON.parse(String(sourceIssues))).toEqual(expectedIssues);

          expect(migrated.details.additionalInformation).toEqual(
            expectedAdditional,
          );
          expect(
            migrated.details.postingLink!.pending.details.additionalInformation,
          ).toEqual(expectedAdditional);
          const additional = (
            await db.query(
              "SELECT additional_information_json FROM transactions WHERE id=?",
              [row.id],
            )
          )[0]!.additional_information_json;
          expect(JSON.parse(String(additional))).toEqual(expectedAdditional);

          expect(migrated.details.sourceRefs).toEqual(row.details.sourceRefs);
          expect(
            migrated.details.postingLink!.pending.details.provider,
          ).toEqual(expectedProvider);
          expect(
            migrated.details.postingLink!.pending.details.sourceRefs,
          ).toEqual(pending.details.sourceRefs);
          const source = (
            await db.query(
              "SELECT provider_json FROM transactions WHERE id=?",
              [row.id],
            )
          )[0]!.provider_json;
          expect(JSON.parse(String(source))).toEqual({
            cal: calSource,
            isracard: isracardSource,
          });
          expect(String(source)).not.toContain("undeclared");
          expect(String(source)).not.toContain("discard");
          const operational = await db.query(
            "SELECT provider_observations_json FROM transaction_reconciliation WHERE transaction_id=?",
            [row.id],
          );
          expect(
            String(operational[0]!.provider_observations_json),
          ).not.toContain('"row"');
        } finally {
          await db.close();
        }
      });
      it("pairs complete saved copies by value and consumes origin occurrences without merging statements", async () => {
        const db = await subject(postgres, d1);
        try {
          await db.query(
            "INSERT INTO connections(id,provider,display_name,config_json,created_at) VALUES (?,?,?,?,?)",
            [
              "synthetic",
              "isracard",
              "Synthetic",
              '{"schemaVersion":1}',
              instant,
            ],
          );
          await db.query(
            `INSERT INTO sync_runs(id,connection_id,started_at,status,collector_version,parser_version,snapshot_json,${postgres ? "metadata_json," : ""}coverage_json,warnings_json) VALUES (?,?,?,?,?,?,?${postgres ? ",?" : ""},?,?)`,
            [
              "run",
              "synthetic",
              instant,
              "completed",
              "synthetic",
              "synthetic",
              '{"schemaVersion":1,"responses":[]}',
              ...(postgres ? ['{"responses":[],"failures":[]}'] : []),
              "[]",
              "[]",
            ],
          );
          const source = {
            seqVoucherNumber: "DIGITAL",
            voucherNumberRatz: "LEGACY",
            billingAmount: "1",
            paymentSum: "2",
            businessName: "Digital\u0000literal\\u0000",
            fullSupplierNameHeb: "Legacy",
            origin: "legacy",
            generation: "legacy",
            undeclared: { noise: true },
          };
          const reversed = Object.fromEntries(Object.entries(source).reverse());
          const row = transaction("origins", "ordinary");
          row.details.provider = {
            isracard: {
              rows: [source, reversed, source, reversed],
              observations: [
                { generation: "legacy", row: reversed, path: "$.legacy" },
                { generation: "digital", row: source, path: "$.digital-1" },
                { generation: "unsupported", row: source, path: "$.ignored" },
                { generation: "digital", row: reversed, path: "$.digital-2" },
                null,
                "ignored",
                { generation: "legacy", row: [] },
                { generation: "legacy", row: { unmatched: true } },
              ],
            },
          };
          const pending = structuredClone(row);
          pending.id = "origin-pending";
          row.details.postingLink = {
            schemaVersion: 1,
            policyVersion: "synthetic",
            automatic: false,
            postedId: "retired",
            pending: { ...pending, status: "pending", supersededById: null },
            pendingKeys: ["origin-pending"],
            postedKeys: ["retired"],
            evidence: { runId: "run", capturedAt: instant },
          };
          await db.query(
            "INSERT INTO transactions(id,connection_id,source_scope,source_key,source_aliases_json,identity_strength,status,presence,kind,amount_basis,details_json,first_seen_at,last_seen_at,last_seen_run_id,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
              row.id,
              row.connectionId,
              row.sourceScope,
              row.sourceKey,
              "[]",
              row.identityStrength,
              row.status,
              row.presence,
              row.kind,
              row.amountBasis,
              JSON.stringify(row.details),
              instant,
              instant,
              "run",
              1,
            ],
          );
          await db.migrate();
          const expected = [
            {
              seqVoucherNumber: "DIGITAL",
              billingAmount: "1",
              businessName: "Digital\u0000literal\\u0000",
            },
            {
              seqVoucherNumber: "DIGITAL",
              billingAmount: "1",
              businessName: "Digital\u0000literal\\u0000",
            },
            {
              voucherNumberRatz: "LEGACY",
              paymentSum: "2",
              fullSupplierNameHeb: "Legacy",
            },
            {
              voucherNumberRatz: "LEGACY",
              paymentSum: "2",
              fullSupplierNameHeb: "Legacy",
            },
          ];
          const migrated = (await db.read(row.id))[0]!;
          expect(migrated.details.provider.isracard!.rows).toEqual(expected);
          expect(
            migrated.details.postingLink!.pending.details.provider.isracard!
              .rows,
          ).toEqual(expected);
        } finally {
          await db.close();
        }
      });
      it("writes freshness and operational state without updating transaction content", async () => {
        const db = await subject(postgres, d1);
        try {
          await db.query(
            "INSERT INTO connections(id,provider,display_name,config_json,created_at) VALUES (?,?,?,?,?)",
            ["synthetic", "cal", "Synthetic", '{"schemaVersion":1}', instant],
          );
          await db.query(
            `INSERT INTO sync_runs(id,connection_id,started_at,status,collector_version,parser_version,snapshot_json,${postgres ? "metadata_json," : ""}coverage_json,warnings_json) VALUES (?,?,?,?,?,?,?${postgres ? ",?" : ""},?,?)`,
            [
              "run",
              "synthetic",
              instant,
              "completed",
              "synthetic",
              "synthetic",
              '{"schemaVersion":1,"responses":[]}',
              ...(postgres ? ['{"responses":[],"failures":[]}'] : []),
              "[]",
              "[]",
            ],
          );
          await db.migrate();
          await db.query(
            "INSERT INTO sync_runs(id,connection_id,started_at,status,collector_version,parser_version,metadata_json,coverage_json,warnings_json) VALUES (?,?,?,?,?,?,?,?,?)",
            [
              "next-run",
              "synthetic",
              instant,
              "completed",
              "synthetic",
              "synthetic",
              '{"schemaVersion":1,"responses":[]}',
              "[]",
              "[]",
            ],
          );
          const deferred = {
            id: "a".repeat(64),
            connectionId: "synthetic",
            sourceScope: "account",
            sourceKey: "unowned",
            reason: "ambiguous_identity",
            content: {
              provider: { invented: { value: "nul\u0000literal\\u0000" } },
            },
            firstSeenRunId: "run",
            lastSeenRunId: "run",
          };
          await db.defer(deferred);
          await db.defer({
            ...deferred,
            firstSeenRunId: "next-run",
            lastSeenRunId: "next-run",
          });
          const retained = await db.query(
            "SELECT first_seen_run_id,last_seen_run_id,content_json FROM deferred_evidence",
          );
          expect(retained).toHaveLength(1);
          expect(retained[0]).toEqual({
            first_seen_run_id: "run",
            last_seen_run_id: "next-run",
            content_json: JSON.stringify(deferred.content),
          });
          const original = transaction("tx", "ordinary");
          await db.write(original);
          if (postgres) {
            await db.query(
              "CREATE FUNCTION refuse_transaction_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unexpected transaction update'; END $$",
            );
            await db.query(
              "CREATE TRIGGER refuse_transaction_update BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION refuse_transaction_update()",
            );
          } else {
            await db.query(
              "CREATE TRIGGER refuse_transaction_update BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT,'unexpected transaction update'); END",
            );
          }
          const observed = {
            ...original,
            lastSeenAt: "2040-07-02T00:00:00.000Z",
            details: {
              ...original.details,
              sourceRefs: [{ runId: "run", path: "$.current" }],
            },
          };
          await db.write(observed, original, true);
          expect((await db.read(original.id))[0]).toEqual(observed);
          const reconciled = structuredClone(observed);
          reconciled.details.rejectedPostingKeys = ["newly-rejected"];
          reconciled.details.provider.cal!.identity = {
            baseKey: "new-derived-base",
            occurrenceCount: 1,
          };
          await db.write(reconciled, observed);
          expect((await db.read(original.id))[0]).toEqual(reconciled);
          await expect(
            db.write(
              { ...reconciled, description: "Meaningful change" },
              reconciled,
            ),
          ).rejects.toMatchObject({
            cause: {
              message: expect.stringContaining("unexpected transaction update"),
            },
          });
        } finally {
          await db.close();
        }
      });
    },
  );
}
