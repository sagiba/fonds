import { createClient, type InValue } from "@libsql/client/node";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { InternalStore } from "../../src/application/financial-store.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import { isracardAdapter } from "../../src/providers/isracard/adapter.js";
import { migratePostgresSchema } from "../../src/storage/postgres/initialize.js";
import { postgresMigrations } from "../../src/storage/postgres/migration.js";
import { openPostgresDatabase } from "../../src/storage/postgres/store.js";
import { migrateSqliteSchema } from "../../src/storage/sqlite/migrate.js";
import { sqliteMigrations } from "../../src/storage/sqlite/migration.js";
import { databaseForClient } from "../../src/storage/turso.js";
import { disposableDatabase } from "../helpers/postgres-database.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;
const instant = "2040-07-01T00:00:00.000Z";

interface Subject {
  query(sql: string, args?: unknown[]): Promise<Record<string, unknown>[]>;
  migrate(): Promise<InternalStore>;
  close(): Promise<void>;
}

async function subject(postgres: boolean): Promise<Subject> {
  if (postgres) {
    const database = await disposableDatabase(
      postgresUrl!,
      "fonds_migration_content",
    );
    const pool = new Pool({
      connectionString: database.url,
      options: database.options,
    });
    await migratePostgresSchema(pool, postgresMigrations.slice(0, 2), null);
    let store: ReturnType<typeof openPostgresDatabase> | undefined;
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
      migrate: async () => {
        await migratePostgresSchema(pool);
        return (store = openPostgresDatabase({
          connectionString: database.url,
          options: database.options,
        }));
      },
      close: async () => {
        await store?.close();
        await pool.end();
        await database.drop();
      },
    };
  }
  const client = createClient({ url: "file::memory:" });
  await client.execute("PRAGMA foreign_keys=ON");
  await migrateSqliteSchema(client, sqliteMigrations.slice(0, 2), null);
  return {
    query: async (sql, args = []) =>
      (await client.execute({ sql, args: args as InValue[] }))
        .rows as unknown as Record<string, unknown>[],
    migrate: async () => {
      await migrateSqliteSchema(client);
      return databaseForClient(client);
    },
    close: async () => client.close(),
  };
}

for (const postgres of [false, true]) {
  describe.skipIf(postgres && !postgresUrl)(
    `${postgres ? "postgres" : "sqlite"} migrated content stability`,
    () => {
      it("projects legacy nested noise once and keeps repeated identical observations quiet", async () => {
        const db = await subject(postgres);
        try {
          const source = {
            cardUniqueId: "SYNTHETIC-CARD",
            trnIntId: "SYNTHETIC-TXN",
            merchantName: "Synthetic shop",
            merchantId: "SYNTHETIC-MERCHANT",
            internationalBranchID: "5411",
            trnPurchaseDate: "2040-06-11T12:30:00",
            debCrdDate: "2040-07-10T00:00:00",
            amountForDisplay: 10,
            trnAmt: 10,
            debCrdCurrencyCode: 3,
            debCrdCurrencySymbol: "₪",
            currencyForDisplay: "₪",
            trnCurrencyIsoCode: "376",
            transOriginalCurrencyCode: 3,
            trnCurrencySymbol: "₪",
            transactionTypeCode: 5,
            trnType: "רגילה",
            refundInd: false,
            numOfPayments: 0,
            curPaymentNum: 0,
            transCardPresentInd: true,
            trnExacWay: 0,
            comments: [
              {
                key: "Synthetic note",
                value: "retained",
                unknown: { nestedNoise: true },
              },
            ],
            future: { nestedNoise: true },
          };
          const responseText = JSON.stringify({
            statusCode: 1,
            result: { transactions: [source], clearanceRequests: [] },
          });
          const response = {
            accountKey: "synthetic-account",
            endpoint: "synthetic:cal/recent",
            capturedAt: instant,
            responseText,
          };
          const snapshot = JSON.stringify({
            schemaVersion: 1,
            responses: [response],
            failures: [],
          });
          await db.query(
            "INSERT INTO connections(id,provider,display_name,config_json,created_at) VALUES (?,?,?,?,?)",
            ["synthetic", "cal", "Synthetic", '{"schemaVersion":1}', instant],
          );
          await db.query(
            "INSERT INTO cards(id,connection_id,provider_key,created_at) VALUES (?,?,?,?)",
            ["synthetic-card-id", "synthetic", "SYNTHETIC-CARD", instant],
          );
          await db.query(
            `INSERT INTO sync_runs(id,connection_id,started_at,completed_at,status,collector_version,parser_version,snapshot_json,${postgres ? "metadata_json," : ""}coverage_json,warnings_json,applied_at) VALUES (?,?,?,?,?,?,?,?,${postgres ? "?," : ""}?,?,?)`,
            [
              "legacy",
              "synthetic",
              instant,
              instant,
              "completed",
              "offline-v1",
              "cal-v11",
              snapshot,
              ...(postgres
                ? [JSON.stringify({ responses: [response], failures: [] })]
                : []),
              "[]",
              "[]",
              instant,
            ],
          );
          const details = {
            schemaVersion: 1,
            merchant: { address: null, phone: null },
            transactionDateTime: "2040-06-11T12:30:00",
            additionalInformation: ["Synthetic note: retained"],
            issues: [],
            sourceRefs: [{ runId: "legacy", path: "/result/transactions/0" }],
            provider: {
              cal: {
                rows: [
                  Object.fromEntries(
                    Object.entries(source).map(([key, value]) => [
                      key,
                      typeof value === "number" ? String(value) : value,
                    ]),
                  ),
                ],
                retained: { comments: source.comments, paymentHistory: [] },
                unknown: { nestedNoise: true },
              },
            },
          };
          const legacy = {
            id: "synthetic-transaction-id",
            connection_id: "synthetic",
            source_scope: "synthetic-account",
            card_id: "synthetic-card-id",
            source_key:
              'cal:posted:purchase:["SYNTHETIC-CARD","SYNTHETIC-TXN"]',
            source_aliases_json: "[]",
            identity_strength: "native",
            status: "posted",
            presence: "seen",
            description: "רגילה",
            counterparty_name: null,
            kind: "purchase",
            merchant_name: "Synthetic shop",
            merchant_provider_id: "SYNTHETIC-MERCHANT",
            merchant_category_code: "5411",
            transaction_date: "2040-06-11",
            booking_date: null,
            billing_date: "2040-07-10",
            amount_minor: -1000,
            currency: "ILS",
            amount_basis: "purchase_commitment",
            original_amount_minor: -1000,
            original_currency: "ILS",
            installment_count: null,
            card_present: postgres ? true : 1,
            authorization_method: null,
            wallet: null,
            three_d_secure_used: null,
            recurring: null,
            purchase_id: null,
            installment_number: null,
            provider_transaction_code: "5",
            fx_fee_minor: null,
            fx_fee_currency: null,
            details_json: JSON.stringify(details),
            first_seen_at: instant,
            last_seen_at: instant,
            last_seen_run_id: "legacy",
            version: 7,
            superseded_by_id: null,
          };
          const columns = Object.keys(legacy);
          await db.query(
            `INSERT INTO transactions(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            Object.values(legacy),
          );
          const store = await db.migrate();
          const before = (await store.getTransaction(
            "synthetic-transaction-id",
          ))!;
          expect(before.version).toBe(7);
          expect(JSON.stringify(before.details.provider)).not.toContain(
            "nestedNoise",
          );
          const originalRows = await db.query(
            "SELECT * FROM transactions WHERE id=?",
            [before.id],
          );
          for (const day of [2, 3]) {
            const capturedAt = `2040-07-0${day}T00:00:00.000Z`;
            expect(
              await store.ingestRun(
                {
                  connectionId: "synthetic",
                  runId: `fresh-${day}`,
                  responses: [{ ...response, capturedAt }],
                },
                calAdapter,
              ),
            ).toMatchObject({
              observed: 1,
              created: 0,
              updated: 0,
              unchanged: 1,
              unlisted: 0,
            });
            expect(await store.getTransaction(before.id)).toMatchObject({
              version: 7,
              amountMinor: -1000,
              lastSeenAt: capturedAt,
              lastSeenRunId: `fresh-${day}`,
            });
            expect(
              await db.query("SELECT * FROM transactions WHERE id=?", [
                before.id,
              ]),
            ).toEqual(originalRows);
          }
          expect(
            (await store.listEvents()).filter(
              (event) => event.type === "transaction.updated",
            ),
          ).toEqual([]);
          expect(
            await db.query(
              "SELECT run_id FROM sync_run_bodies WHERE run_id IN (?,?)",
              ["fresh-2", "fresh-3"],
            ),
          ).toEqual([]);
        } finally {
          await db.close();
        }
      });
      it.each(["digital", "legacy"] as const)(
        "uses saved %s origin through cross-family source noise without content writes",
        async (generation) => {
          const db = await subject(postgres);
          try {
            const company = generation === "digital" ? "77" : "11";
            const accountKey = `isracard:card:${JSON.stringify([company, "1234"])}`;
            const scope = {
              kind: "recent" as const,
              month: "2040-07",
              cardKey: accountKey,
            };
            const card = {
              companyCode: company,
              cardGuid: "SYNTHETIC-ORIGIN-GUID",
              cardSuffix: "1234",
            };
            const source: Record<string, unknown> =
              generation === "digital"
                ? {
                    seqVoucherNumber: "SYNTHETIC-VOUCHER",
                    purchaseDate: "11/06/2040",
                    businessName: "Synthetic digital shop",
                    businessNumber: "SYNTHETIC-MERCHANT",
                    billingAmount: 86.4,
                    billingAmountCurrency: 0,
                    originalAmount: 86.4,
                    originalCurrencyIso: "ILS",
                    transactionCode: 1,
                    voucherNumberRatz: "UNDECLARED-LEGACY-VOUCHER",
                    future: { nestedNoise: true },
                    origin: "legacy",
                    generation: "legacy",
                  }
                : {
                    voucherNumberRatz: "SYNTHETIC-VOUCHER",
                    fullPurchaseDate: "11/06/2040",
                    fullPaymentDate: "10/07/2040",
                    fullSupplierNameHeb: "Synthetic legacy shop",
                    supplierId: "SYNTHETIC-MERCHANT",
                    paymentSum: 86.4,
                    dealSum: 86.4,
                    currencyId: "ILS",
                    currentPaymentCurrency: "ILS",
                    seqVoucherNumber: "UNDECLARED-DIGITAL-VOUCHER",
                    future: { nestedNoise: true },
                    origin: "digital",
                    generation: "digital",
                  };
            const rawRow =
              generation === "digital"
                ? {
                    ...source,
                    billingAmount: "86.4",
                    billingAmountCurrency: "0",
                    originalAmount: "86.4",
                    transactionCode: "1",
                  }
                : { ...source, paymentSum: "86.4", dealSum: "86.4" };
            const expectedRow =
              generation === "digital"
                ? {
                    seqVoucherNumber: "SYNTHETIC-VOUCHER",
                    purchaseDate: "11/06/2040",
                    businessName: "Synthetic digital shop",
                    businessNumber: "SYNTHETIC-MERCHANT",
                    billingAmount: "86.4",
                    billingAmountCurrency: "0",
                    originalAmount: "86.4",
                    originalCurrencyIso: "ILS",
                    transactionCode: "1",
                  }
                : {
                    voucherNumberRatz: "SYNTHETIC-VOUCHER",
                    fullPurchaseDate: "11/06/2040",
                    fullPaymentDate: "10/07/2040",
                    fullSupplierNameHeb: "Synthetic legacy shop",
                    supplierId: "SYNTHETIC-MERCHANT",
                    paymentSum: "86.4",
                    dealSum: "86.4",
                    currencyId: "ILS",
                    currentPaymentCurrency: "ILS",
                  };
            const path =
              generation === "digital"
                ? "$.responses.digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[0]"
                : "$.responses.legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0].txnIsrael[0]";
            const responses = {
              cardList: JSON.stringify({
                isSuccess: true,
                data: { cardsList: [card] },
              }),
              digital: JSON.stringify({
                isSuccess: true,
                errorCode: "0",
                errorDescription: null,
                data: {
                  approvals: null,
                  currentTransactionsList: null,
                  israelAbroadVouchers:
                    generation === "digital"
                      ? {
                          vouchers: {
                            israelAbroadVouchersList: [source],
                            informativeOnlyVouchers: [],
                          },
                          outOfStatementChargeDateVouchers: [],
                        }
                      : null,
                },
              }),
              ...(generation === "legacy"
                ? {
                    legacy: JSON.stringify({
                      Header: { Status: "1" },
                      CardsTransactionsListBean: {
                        cardNumberList: ["Synthetic card 1234"],
                        Index0: {
                          CurrentCardTransactions: [
                            { txnIsrael: [source], txnAbroad: [], txnInfo: [] },
                          ],
                        },
                      },
                    }),
                  }
                : {}),
            };
            const response = {
              accountKey,
              endpoint: "isracard:card-month",
              scope,
              capturedAt: instant,
              responseText: JSON.stringify({
                schemaVersion: 1,
                provider: "isracard",
                mode: "recent",
                billingMonth: "2040-07",
                isNextBillingDate: false,
                card,
                responses,
                ...(generation === "legacy" ? { legacyCardIndex: "0" } : {}),
              }),
            };
            const sourceKey = `isracard:posted:${JSON.stringify([accountKey, "2040-06-11", "SYNTHETIC-VOUCHER"])}`;
            const baseKey = `isracard:posted:voucher:${JSON.stringify([accountKey, "SYNTHETIC-VOUCHER"])}`;
            const insert = async (
              table: string,
              values: Record<string, unknown>,
            ) => {
              const columns = Object.keys(values);
              await db.query(
                `INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
                Object.values(values),
              );
            };
            await insert("connections", {
              id: "synthetic-origin",
              provider: "isracard",
              display_name: "Synthetic",
              config_json: '{"schemaVersion":1}',
              created_at: instant,
            });
            await insert("cards", {
              id: "synthetic-origin-card",
              connection_id: "synthetic-origin",
              provider_key: accountKey,
              created_at: instant,
            });
            await insert("sync_runs", {
              id: "legacy-origin",
              connection_id: "synthetic-origin",
              started_at: instant,
              completed_at: instant,
              status: "completed",
              collector_version: "offline-v1",
              parser_version: "isracard-v11",
              snapshot_json: JSON.stringify({
                schemaVersion: 1,
                responses: [response],
                failures: [],
              }),
              ...(postgres
                ? {
                    metadata_json: JSON.stringify({
                      responses: [
                        {
                          accountKey,
                          endpoint: response.endpoint,
                          capturedAt: instant,
                          scope,
                        },
                      ],
                      failures: [],
                    }),
                  }
                : {}),
              coverage_json: JSON.stringify([
                {
                  accountKey,
                  resource: "isracard:card-month",
                  scope,
                  status: "posted",
                  success: true,
                  comparable: false,
                },
              ]),
              warnings_json: "[]",
              applied_at: instant,
            });
            await insert("transactions", {
              id: "synthetic-origin-transaction",
              connection_id: "synthetic-origin",
              source_scope: accountKey,
              card_id: "synthetic-origin-card",
              source_key: sourceKey,
              source_aliases_json: "[]",
              identity_strength: "native",
              status: "posted",
              presence: "seen",
              description: null,
              counterparty_name: null,
              kind: generation === "digital" ? "purchase" : "unknown",
              merchant_name:
                generation === "digital"
                  ? "Synthetic digital shop"
                  : "Synthetic legacy shop",
              merchant_provider_id: "SYNTHETIC-MERCHANT",
              merchant_category_code: null,
              transaction_date: "2040-06-11",
              booking_date: null,
              billing_date: generation === "digital" ? null : "2040-07-10",
              amount_minor: -8640,
              currency: "ILS",
              amount_basis:
                generation === "digital" ? "purchase_commitment" : "unknown",
              original_amount_minor: generation === "digital" ? -8640 : null,
              original_currency: generation === "digital" ? "ILS" : null,
              installment_count: null,
              card_present: null,
              authorization_method: null,
              wallet: null,
              three_d_secure_used: null,
              recurring: null,
              purchase_id: null,
              installment_number: null,
              provider_transaction_code: generation === "digital" ? "1" : null,
              fx_fee_minor: null,
              fx_fee_currency: null,
              details_json: JSON.stringify({
                schemaVersion: 1,
                merchant: {
                  address: null,
                  phone: null,
                  city: null,
                  countryCode: null,
                },
                transactionDateTime: null,
                issues:
                  generation === "digital"
                    ? ["source_derived_amount_direction"]
                    : [
                        "isracard_unverified_semantics",
                        "unsupported_transaction_type",
                        "unverified_amount_basis",
                        "source_derived_amount_direction",
                      ],
                sourceRefs: [{ runId: "legacy-origin", path }],
                provider: {
                  isracard: {
                    rows: [rawRow],
                    observations: [
                      {
                        generation,
                        path,
                        row: Object.fromEntries(
                          Object.entries(rawRow).reverse(),
                        ),
                      },
                    ],
                    identity: { baseKey, occurrenceCount: 1 },
                    billingMonth: "2040-07",
                    monetaryEvidence: {
                      billingMinor: 8640,
                      billingCurrency: "ILS",
                      originalMinor: 8640,
                      originalCurrency: "ILS",
                      convention:
                        generation === "digital"
                          ? "upstream signed billing amounts negated; charged billingAmount of a same-currency posted charge; originalAmount = billingAmount + discountAmount"
                          : "upstream signed billing amounts negated; amount basis unverified; kind only from the DigitalV3 transactionCode and source sign",
                    },
                  },
                },
              }),
              first_seen_at: instant,
              last_seen_at: instant,
              last_seen_run_id: "legacy-origin",
              version: 9,
              superseded_by_id: null,
            });
            const store = await db.migrate();
            const before = (await store.getTransaction(
              "synthetic-origin-transaction",
            ))!;
            expect(before.details.provider.isracard!.rows).toEqual([
              expectedRow,
            ]);
            const physical = await db.query(
              "SELECT * FROM transactions WHERE id=?",
              [before.id],
            );
            if (postgres) {
              await db.query(
                "CREATE FUNCTION refuse_origin_content_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unexpected transaction content update'; END $$",
              );
              await db.query(
                "CREATE TRIGGER refuse_origin_content_update BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION refuse_origin_content_update()",
              );
            } else {
              await db.query(
                "CREATE TRIGGER refuse_origin_content_update BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT,'unexpected transaction content update'); END",
              );
            }
            for (const day of [2, 3]) {
              const capturedAt = `2040-07-0${day}T00:00:00.000Z`;
              expect(
                await store.ingestRun(
                  {
                    connectionId: "synthetic-origin",
                    runId: `origin-fresh-${day}`,
                    responses: [{ ...response, capturedAt }],
                  },
                  isracardAdapter,
                ),
              ).toMatchObject({
                observed: 1,
                created: 0,
                updated: 0,
                unchanged: 1,
                unlisted: 0,
                status: "completed",
              });
              expect(await store.getTransaction(before.id)).toMatchObject({
                version: 9,
                lastSeenAt: capturedAt,
                lastSeenRunId: `origin-fresh-${day}`,
              });
              expect(
                await db.query("SELECT * FROM transactions WHERE id=?", [
                  before.id,
                ]),
              ).toEqual(physical);
            }
            expect(
              (await store.listEvents()).filter(
                (event) => event.type === "transaction.updated",
              ),
            ).toEqual([]);
          } finally {
            await db.close();
          }
        },
      );
      it("preserves legacy approval identity and evidence without a first-refresh content rewrite", async () => {
        const db = await subject(postgres);
        try {
          const accountKey = 'isracard:card:["77","1234"]';
          const scope = {
            kind: "recent" as const,
            month: "2040-07",
            cardKey: accountKey,
          };
          const sourceKey = `isracard:pending:${JSON.stringify([accountKey, 17, "SYNTHETIC-SEQUENCE", "20400611:123000:001"])}`;
          const card = {
            companyCode: "77",
            cardGuid: "SYNTHETIC-PENDING-GUID",
            cardSuffix: "1234",
          };
          const approval = {
            confirmationLocation: 17,
            seqConfirmationNumber: "SYNTHETIC-SEQUENCE",
            confirmationTimeStamp: "20400611:123000:001",
            confirmationNumber: "SYNTHETIC-DISPLAY-REFERENCE",
            businessName: "Synthetic pending shop",
            purchaseDate: "11/06/2040",
            originalAmount: 86.4,
            originalCurrency: 0,
            currencyIso: "ILS",
            currencySimbol: "₪",
            ilsBillingAmount: 86.4,
            israelTransactionTime: "12:30",
            transactionCode: 901,
            transactionDescription: null,
            tranzacCodeType: "SYNTHETIC-APPROVAL-CHANNEL",
            isTransactionSecure: 7,
            isWalletTransaction: 9,
            branchCodeDescription: "Synthetic category",
            future: { nestedNoise: true },
          };
          const responseText = JSON.stringify({
            schemaVersion: 1,
            provider: "isracard",
            mode: "recent",
            billingMonth: "2040-07",
            isNextBillingDate: true,
            card,
            responses: {
              cardList: JSON.stringify({
                isSuccess: true,
                data: { cardsList: [card] },
              }),
              digital: JSON.stringify({
                isSuccess: true,
                errorCode: "0",
                errorDescription: null,
                data: {
                  approvals: {
                    approvedTransactions: [approval],
                    totalEstimatedAmount: 86.4,
                  },
                  israelAbroadVouchers: null,
                  currentTransactionsList: null,
                },
              }),
            },
          });
          const response = {
            accountKey,
            endpoint: "isracard:card-month",
            capturedAt: instant,
            scope,
            responseText,
          };
          const legacyApproval = {
            ...approval,
            confirmationLocation: "17",
            originalAmount: "86.4",
            originalCurrency: "0",
            ilsBillingAmount: "86.4",
            transactionCode: "901",
            isTransactionSecure: "7",
            isWalletTransaction: "9",
          };
          const expectedApproval = {
            confirmationLocation: "17",
            seqConfirmationNumber: "SYNTHETIC-SEQUENCE",
            confirmationTimeStamp: "20400611:123000:001",
            confirmationNumber: "SYNTHETIC-DISPLAY-REFERENCE",
            businessName: "Synthetic pending shop",
            purchaseDate: "11/06/2040",
            originalAmount: "86.4",
            originalCurrency: "0",
            currencyIso: "ILS",
            currencySimbol: "₪",
            ilsBillingAmount: "86.4",
            israelTransactionTime: "12:30",
            transactionCode: "901",
            transactionDescription: null,
            tranzacCodeType: "SYNTHETIC-APPROVAL-CHANNEL",
            isTransactionSecure: "7",
            isWalletTransaction: "9",
            branchCodeDescription: "Synthetic category",
          };
          const insert = async (
            table: string,
            values: Record<string, unknown>,
          ) => {
            const columns = Object.keys(values);
            await db.query(
              `INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
              Object.values(values),
            );
          };
          await insert("connections", {
            id: "synthetic-pending",
            provider: "isracard",
            display_name: "Synthetic",
            config_json: '{"schemaVersion":1}',
            created_at: instant,
          });
          await insert("cards", {
            id: "synthetic-pending-card",
            connection_id: "synthetic-pending",
            provider_key: accountKey,
            created_at: instant,
          });
          await insert("sync_runs", {
            id: "legacy-pending",
            connection_id: "synthetic-pending",
            started_at: instant,
            completed_at: instant,
            status: "completed",
            collector_version: "offline-v1",
            parser_version: "isracard-v11",
            snapshot_json: JSON.stringify({
              schemaVersion: 1,
              responses: [response],
              failures: [],
            }),
            ...(postgres
              ? {
                  metadata_json: JSON.stringify({
                    responses: [
                      {
                        accountKey,
                        endpoint: response.endpoint,
                        capturedAt: instant,
                        scope,
                      },
                    ],
                    failures: [],
                  }),
                }
              : {}),
            coverage_json: JSON.stringify(
              ["posted", "pending"].map((status) => ({
                accountKey,
                resource: "isracard:card-month",
                status,
                success: true,
                comparable: true,
                scope,
              })),
            ),
            warnings_json: "[]",
            applied_at: instant,
          });
          await insert("transactions", {
            id: "synthetic-pending-transaction",
            connection_id: "synthetic-pending",
            source_scope: accountKey,
            card_id: "synthetic-pending-card",
            source_key: sourceKey,
            source_aliases_json: "[]",
            identity_strength: "native",
            status: "pending",
            presence: "seen",
            description: null,
            counterparty_name: null,
            kind: "unknown",
            merchant_name: "Synthetic pending shop",
            merchant_provider_id: null,
            merchant_category_code: null,
            transaction_date: "2040-06-11",
            booking_date: null,
            billing_date: null,
            amount_minor: -8640,
            currency: "ILS",
            amount_basis: "authorization",
            original_amount_minor: null,
            original_currency: null,
            installment_count: null,
            card_present: null,
            authorization_method: null,
            wallet: null,
            three_d_secure_used: null,
            recurring: null,
            purchase_id: null,
            installment_number: null,
            provider_transaction_code: null,
            fx_fee_minor: null,
            fx_fee_currency: null,
            details_json: JSON.stringify({
              schemaVersion: 1,
              merchant: { address: null, phone: null },
              issues: ["source_derived_amount_direction"],
              sourceRefs: [
                {
                  runId: "legacy-pending",
                  path: "$.responses.digital.data.approvals.approvedTransactions[0]",
                },
              ],
              provider: {
                isracard: {
                  rows: [legacyApproval],
                  identity: { baseKey: sourceKey, occurrenceCount: 1 },
                  billingMonth: "2040-07",
                  monetaryEvidence: {
                    originalMinor: 8640,
                    originalCurrency: "ILS",
                    convention:
                      "upstream signed originalAmount negated; authorization currency from currencyIso; kind not stated",
                  },
                },
              },
            }),
            first_seen_at: instant,
            last_seen_at: instant,
            last_seen_run_id: "legacy-pending",
            version: 4,
            superseded_by_id: null,
          });
          const store = await db.migrate();
          const before = (await store.getTransaction(
            "synthetic-pending-transaction",
          ))!;
          expect(before.details.provider.isracard!.rows).toEqual([
            expectedApproval,
          ]);
          expect(before.details.provider.isracard!.identity).toMatchObject({
            baseKey: sourceKey,
            occurrenceCount: 1,
          });
          const originalRows = await db.query(
            "SELECT * FROM transactions WHERE id=?",
            [before.id],
          );
          for (const day of [2, 3]) {
            const capturedAt = `2040-07-0${day}T00:00:00.000Z`;
            expect(
              await store.ingestRun(
                {
                  connectionId: "synthetic-pending",
                  runId: `pending-fresh-${day}`,
                  responses: [{ ...response, capturedAt }],
                },
                isracardAdapter,
              ),
            ).toMatchObject({
              observed: 1,
              created: 0,
              updated: 0,
              unchanged: 1,
              unlisted: 0,
              status: "completed",
            });
            expect(await store.getTransaction(before.id)).toMatchObject({
              version: 4,
              status: "pending",
              amountMinor: -8640,
              lastSeenAt: capturedAt,
              lastSeenRunId: `pending-fresh-${day}`,
            });
            expect(
              await db.query("SELECT * FROM transactions WHERE id=?", [
                before.id,
              ]),
            ).toEqual(originalRows);
          }
          expect(
            (await store.listEvents()).filter(
              (event) => event.type === "transaction.updated",
            ),
          ).toEqual([]);
          expect(
            await db.query(
              "SELECT run_id FROM sync_run_bodies WHERE run_id IN (?,?)",
              ["pending-fresh-2", "pending-fresh-3"],
            ),
          ).toEqual([]);
        } finally {
          await db.close();
        }
      });
    },
  );
}
