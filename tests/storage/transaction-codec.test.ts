import { readFileSync } from "node:fs";

import { createClient, type InValue } from "@libsql/client/node";
import { drizzle as d1Drizzle } from "drizzle-orm/d1";
import { drizzle as sqliteDrizzle } from "drizzle-orm/libsql";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

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

interface Subject {
  query(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
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
    await migrate(sqliteMigrations);
    const db = d1Drizzle(binding);
    return {
      query: async (sql, args = []) =>
        (
          await binding
            .prepare(sql)
            .bind(...args)
            .all<Record<string, unknown>>()
        ).results,
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
    await migratePostgresSchema(pool, postgresMigrations, null);
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
  await migrateSqliteSchema(client, sqliteMigrations, null);
  const db = sqliteDrizzle(client);
  return {
    query: async (sql, args = []) =>
      (await client.execute({ sql, args: args as InValue[] }))
        .rows as unknown as Record<string, unknown>[],
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
    `${backend} transaction storage codec`,
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
            "INSERT INTO sync_runs(id,connection_id,started_at,status,collector_version,parser_version,metadata_json,coverage_json,warnings_json,evidence_digest) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
              "run",
              "synthetic",
              instant,
              "completed",
              "synthetic",
              "synthetic",
              JSON.stringify({ schemaVersion: 1, responses: [], failures: [] }),
              "[]",
              "[]",
              "a".repeat(64),
            ],
          );
          await db.query(
            "INSERT INTO sync_run_bodies(run_id,snapshot_json,retention,expires_at) VALUES (?,?,?,?)",
            ["run", snapshot, "staged", null],
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
            await db.write(row);
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
          expect(
            (
              await db.query(
                "SELECT snapshot_json,retention,expires_at FROM sync_run_bodies WHERE run_id = ?",
                ["run"],
              )
            )[0],
          ).toEqual({
            snapshot_json: snapshot,
            retention: "staged",
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
            const stored = (await db.read(row.id))[0]!;
            expect(stored.details).toEqual(row.details);
            expect(stored.lastSeenRunId).toBe("run");
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
          await expect(
            db.query(
              "INSERT INTO sync_runs(id,connection_id,started_at,status,collector_version,parser_version,metadata_json,coverage_json,warnings_json) VALUES (?,?,?,?,?,?,?,?,?)",
              [
                "missing-digest",
                "synthetic",
                instant,
                "completed",
                "synthetic",
                "synthetic",
                '{"schemaVersion":1,"responses":[]}',
                "[]",
                "[]",
              ],
            ),
          ).rejects.toThrow();
          await expect(
            db.query(
              "UPDATE sync_run_bodies SET retention = 'legacy' WHERE run_id = ?",
              ["run"],
            ),
          ).rejects.toThrow();
        } finally {
          await db.close();
        }
      }, 20_000);
      it("writes freshness and operational state without updating transaction content", async () => {
        const db = await subject(postgres, d1);
        try {
          await db.query(
            "INSERT INTO connections(id,provider,display_name,config_json,created_at) VALUES (?,?,?,?,?)",
            ["synthetic", "cal", "Synthetic", '{"schemaVersion":1}', instant],
          );
          await db.query(
            "INSERT INTO sync_runs(id,connection_id,started_at,status,collector_version,parser_version,metadata_json,coverage_json,warnings_json,evidence_digest) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
              "run",
              "synthetic",
              instant,
              "completed",
              "synthetic",
              "synthetic",
              '{"schemaVersion":1,"responses":[],"failures":[]}',
              "[]",
              "[]",
              "a".repeat(64),
            ],
          );
          await db.query(
            "INSERT INTO sync_runs(id,connection_id,started_at,status,collector_version,parser_version,metadata_json,coverage_json,warnings_json,evidence_digest) VALUES (?,?,?,?,?,?,?,?,?,?)",
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
              "a".repeat(64),
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
