import "../helpers/run-history-differential.js";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  emptyDetails,
  type JsonObject,
  type TransactionInput,
} from "../../src/domain/model.js";
import type { CollectionScope } from "../../src/domain/records.js";
import type { Run } from "../../src/domain/records.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import { extractCal } from "../../src/providers/cal/extract.js";
import {
  CAL_EMPTY_SEARCH_DESCRIPTION,
  normalizeCalSearchFilters,
} from "../../src/providers/cal/search.js";
import { CAL_ENDPOINTS } from "../../src/providers/cal/transport.js";
import { backends, type Harness, open } from "../helpers/storage-harness.js";

const accountKey = "synthetic-account";
const endpoint = "synthetic:cal/recent";
const baseline = JSON.parse(
  readFileSync(
    new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
    "utf8",
  ),
);
const regular = baseline.result.transactions.find(
  (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-REGULAR",
);
const installment = baseline.result.transactions.find(
  (row: { trnIntId: string }) => row.trnIntId === "SYNTHETIC-TXN-INSTALLMENTS",
);

function response(rows: unknown[], pending: unknown[] = []): string {
  return JSON.stringify({
    statusCode: 1,
    result: { transactions: rows, clearanceRequests: pending },
  });
}

function history(
  month = "2040-05",
  cardKey = "SYNTHETIC-CARD-A",
): CollectionScope {
  return { kind: "history", month, cardKey };
}

for (const backend of backends) {
  describe(`historical capture reconciliation: ${backend}`, () => {
    let db: Harness;
    let connectionId: string;
    beforeEach(async () => {
      db = await open(backend);
      connectionId = `historical-sync-${randomUUID()}`;
      await db.ensureConnection({ id: connectionId, provider: "cal" });
    });
    afterEach(() => db?.close());

    // Triggers fail after earlier writes so rollback is exercised by the actual driver.
    async function failEvents(
      name: string,
      message: string,
      condition = "true",
    ) {
      if (backend !== "postgres") {
        await db.raw(
          `CREATE TRIGGER ${name} BEFORE INSERT ON events WHEN ${condition} BEGIN SELECT RAISE(ABORT, '${message}'); END`,
        );
        return;
      }
      await db.raw(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${message}'; END; $$`,
      );
      await db.raw(
        `CREATE TRIGGER ${name} BEFORE INSERT ON events FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION ${name}()`,
      );
    }

    async function readRuns(id?: string) {
      const rows = await db.raw(
        `SELECT * FROM sync_runs ${id === undefined ? "" : "WHERE id = ?"} ORDER BY ${backend === "postgres" ? "ingestion_order" : "rowid"}`,
        id === undefined ? [] : [id],
      );
      return rows.map((row) => ({
        ...row,
        id: String(row.id),
        status: String(row.status),
        appliedAt: row.applied_at,
        parserVersion: String(row.parser_version),
        collectorVersion: String(row.collector_version),
        snapshot: JSON.parse(String(row.metadata_json)) as Omit<
          Run["snapshot"],
          "responses"
        > & {
          responses: Omit<
            Run["snapshot"]["responses"][number],
            "responseText"
          >[];
        },
        coverage: JSON.parse(String(row.coverage_json)) as Run["coverage"],
        warnings: JSON.parse(String(row.warnings_json)) as string[],
      }));
    }

    async function readRun(id?: string) {
      return (await readRuns(id))[0];
    }

    async function capture(
      runId: string,
      responseText: string,
      scope?: CollectionScope,
      day = 1,
      context: {
        endpoint?: string;
        httpStatus?: number;
        debugArchiveDays?: number;
      } = {},
    ) {
      const { debugArchiveDays, ...captureContext } = context;
      return await db.ingestRun(
        {
          runId,
          connectionId,
          ...(debugArchiveDays !== undefined && { debugArchiveDays }),
          collectorVersion: "synthetic-stream-v1",
          responses: [
            {
              accountKey,
              endpoint,
              capturedAt: `2040-08-${String(day).padStart(2, "0")}T00:00:00Z`,
              responseText,
              ...(scope ? { scope } : {}),
              ...captureContext,
            },
          ],
        },
        calAdapter,
      );
    }

    function captureArchived(...args: Parameters<typeof capture>) {
      return capture(args[0], args[1], args[2], args[3], {
        ...args[4],
        debugArchiveDays: 2,
      });
    }

    async function archivedResponse(runId: string) {
      const [body] = await db.raw(
        "SELECT snapshot_json FROM sync_run_bodies WHERE run_id = ?",
        [runId],
      );
      return body
        ? (JSON.parse(String(body.snapshot_json)) as Run["snapshot"])
            .responses[0]?.responseText
        : undefined;
    }

    it("archives raw source, requested scope, and collector provenance without inferred completeness", async () => {
      const scope = { ...history(), from: "2040-05-03", to: "2040-05-31" };
      const raw = response([regular]);
      await captureArchived("historical", raw, scope);
      const run = (await readRun())!;
      expect(run.collectorVersion).toBe("synthetic-stream-v1");
      expect(run.snapshot.responses[0]).toMatchObject({ scope });
      expect(await archivedResponse("historical")).toBe(raw);
      expect(
        run.coverage.every(
          (part) =>
            !part.comparable &&
            !("completeness" in part) &&
            part.scope?.month === scope.month,
        ),
      ).toBe(true);
      await expect(
        captureArchived("historical", raw, history("2040-06")),
      ).rejects.toThrow(/different evidence/);
      expect((await captureArchived("historical", raw, scope)).replayed).toBe(
        true,
      );
    });

    it("does not let a later-collected old historical window overwrite or unlist current facts", async () => {
      await capture("recent", response([regular]), undefined, 2);
      const current = (await db.listTransactions())[0]!;
      await capture(
        "history-old",
        response([{ ...regular, amountForDisplay: 1, trnAmt: 1 }]),
        history(),
        3,
      );
      const after = (await db.getTransaction(current.id))!;
      expect(after).toMatchObject({
        amountMinor: current.amountMinor,
        version: 1,
        presence: "seen",
        lastSeenRunId: "recent",
        lastSeenAt: current.lastSeenAt,
      });
      expect(after.details.sourceRefs.map((ref) => ref.runId)).toEqual([
        "recent",
        "history-old",
      ]);
      expect(
        await capture("history-empty", response([]), history("2040-06"), 4),
      ).toMatchObject({
        created: 0,
        updated: 0,
        unlisted: 0,
        status: "completed",
      });
      expect((await db.getTransaction(current.id))?.presence).toBe("seen");
      expect((await db.listEvents()).map((change) => change.type)).toEqual([
        "transaction.imported",
        "sync.baseline",
      ]);
    });

    it("keeps one purchase and adds earlier billed lines in any window order without duplicate commitment money", async () => {
      const later = {
        ...installment,
        curPaymentNum: 4,
        debCrdDate: "2040-07-10T00:00:00",
      };
      const earlier = {
        ...installment,
        curPaymentNum: 2,
        debCrdDate: "2040-05-10T00:00:00",
      };
      await capture("recent", response([later]), undefined, 1);
      const before = (await db.listTransactions()).find(
        (row) => row.purchaseId === null,
      )!;
      const totals = await db.getTotals();
      await capture("history-may", response([earlier]), history("2040-05"), 3);
      await capture(
        "history-overlap",
        response([earlier, later]),
        history("2040-06"),
        2,
      );
      await capture(
        "history-repeat",
        response([earlier]),
        history("2040-05"),
        4,
      );
      const after = (await db.getTransaction(before.id))!;
      const rows = await db.listTransactions();
      expect(rows.filter((row) => row.purchaseId === null)).toHaveLength(1);
      expect(
        rows
          .filter((row) => row.purchaseId === before.id)
          .map((row) => row.installmentNumber)
          .sort(),
      ).toEqual([2, 4]);
      expect(after.details.sourceRefs.map((ref) => ref.runId).sort()).toEqual([
        "history-overlap",
        "history-overlap",
        "history-repeat",
        "recent",
      ]);
      expect(after).toMatchObject({
        amountMinor: before.amountMinor,
        lastSeenRunId: "recent",
        version: 1,
      });
      const commitments = (result: typeof totals) =>
        result.totals.filter(
          (group) => group.amountBasis === "purchase_commitment",
        );
      expect(commitments(await db.getTotals())).toEqual(commitments(totals));
      // Earlier lines arrive as historical imports; nothing is revised.
      expect(
        (await db.listEvents()).filter(
          (event) => event.type === "transaction.updated",
        ),
      ).toEqual([]);
    });

    it("lets current source facts supersede historical imports even if history was captured later", async () => {
      await capture(
        "history-first",
        response([{ ...regular, amountForDisplay: 1, trnAmt: 1 }]),
        history(),
        3,
      );
      const before = (await db.listTransactions())[0]!;
      expect(before.presence).toBe("not_returned");
      await capture("recent-after", response([regular]), undefined, 2);
      expect(await db.listTransactions()).toHaveLength(1);
      expect(await db.getTransaction(before.id)).toMatchObject({
        amountMinor: -8640,
        presence: "seen",
        lastSeenRunId: "recent-after",
      });
      await capture(
        "history-replay-window",
        response([{ ...regular, amountForDisplay: 2, trnAmt: 2 }]),
        history(),
        4,
      );
      expect((await db.getTransaction(before.id))?.amountMinor).toBe(-8640);
    });

    it("scopes failure recovery to the same requested month and card", async () => {
      await db.ingestRun(
        {
          runId: "failed-may",
          connectionId,
          failures: [
            { accountKey, endpoint, code: "network_error", scope: history() },
          ],
          responses: [],
        },
        calAdapter,
      );
      await capture("recent", response([]));
      await capture("other-month", response([]), history("2040-06"));
      await capture(
        "other-card",
        response([]),
        history("2040-05", "SYNTHETIC-CARD-B"),
      );
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toEqual([]);
      await capture("recovered-may", response([]), history());
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(1);
    });

    it("recovers a historical extraction failure without leaving an unrequested pending partition failed", async () => {
      const scope = history();
      const bad = JSON.stringify({ statusCode: 2, result: null });
      expect(
        (await capture("historical-envelope-failed", bad, scope, 1)).status,
      ).toBe("failed");
      const failureRun = (await readRun("historical-envelope-failed"))!;
      expect(failureRun.coverage).toEqual([
        expect.objectContaining({
          status: "posted",
          success: false,
          comparable: false,
        }),
      ]);
      const valid = JSON.stringify({ statusCode: 1, result: { transArr: [] } });
      expect(
        (await capture("historical-envelope-recovered", valid, scope, 2))
          .status,
      ).toBe("completed");
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toEqual([
        expect.objectContaining({
          runId: "historical-envelope-recovered",
          after: expect.objectContaining({ failedScopes: [] }),
        }),
      ]);
    });

    it.each([false, true])(
      "does not heal a later collection failure with a stale offline response (unknown account %s)",
      async (unknownAccount) => {
        const scope = history();
        await db.ingestRun(
          {
            runId: "later-live-failure",
            connectionId,
            startedAt: "2030-01-02T00:00:00Z",
            responses: [],
            failures: [
              {
                accountKey: unknownAccount ? null : accountKey,
                endpoint,
                code: "network_error",
                scope,
              },
            ],
          },
          calAdapter,
        );
        const valid = JSON.stringify({
          statusCode: 1,
          result: { transArr: [] },
        });
        await db.ingestRun(
          {
            runId: "stale-offline",
            connectionId,
            responses: [
              {
                accountKey,
                endpoint,
                capturedAt: "2000-01-01T00:00:00Z",
                responseText: valid,
                scope,
              },
            ],
          },
          calAdapter,
        );
        expect(
          (await db.listEvents()).filter(
            (change) => change.type === "sync.recovered",
          ),
        ).toHaveLength(0);
        await db.ingestRun(
          {
            runId: "fresh-response",
            connectionId,
            responses: [
              {
                accountKey,
                endpoint,
                capturedAt: "2030-01-03T00:00:00Z",
                responseText: valid,
                scope,
              },
            ],
          },
          calAdapter,
        );
        expect(
          (await db.listEvents()).filter(
            (change) => change.type === "sync.recovered",
          ),
        ).toEqual([
          expect.objectContaining({
            runId: "fresh-response",
            after: expect.objectContaining({ failedScopes: [] }),
          }),
        ]);
      },
    );

    it("uses failed response capture time rather than import time when deciding scope recovery", async () => {
      const scope = history();
      await db.ingestRun(
        {
          runId: "late-failed-capture",
          connectionId,
          startedAt: "2000-01-01T00:00:00Z",
          responses: [
            {
              accountKey,
              endpoint,
              capturedAt: "2040-01-03T00:00:00Z",
              responseText: "{invalid-json",
              scope,
            },
          ],
        },
        calAdapter,
      );
      const valid = JSON.stringify({ statusCode: 1, result: { transArr: [] } });
      await db.ingestRun(
        {
          runId: "earlier-valid-capture",
          connectionId,
          responses: [
            {
              accountKey,
              endpoint,
              capturedAt: "2040-01-02T00:00:00Z",
              responseText: valid,
              scope,
            },
          ],
        },
        calAdapter,
      );
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(0);
      await db.ingestRun(
        {
          runId: "later-valid-capture",
          connectionId,
          responses: [
            {
              accountKey,
              endpoint,
              capturedAt: "2040-01-04T00:00:00Z",
              responseText: valid,
              scope,
            },
          ],
        },
        calAdapter,
      );
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toEqual([
        expect.objectContaining({
          runId: "later-valid-capture",
          after: expect.objectContaining({ failedScopes: [] }),
        }),
      ]);
    });

    it("preserves original transport-failure chronology when applying archives later", async () => {
      const scope = history();
      await db.ingestRun(
        {
          runId: "archived-transport-failure",
          connectionId,
          startedAt: "2000-01-02T00:00:00Z",
          responses: [],
          failures: [{ accountKey, endpoint, code: "network_error", scope }],
        },
        calAdapter,
      );
      await db.raw("UPDATE sync_runs SET completed_at = ? WHERE id = ?", [
        "2090-01-01T00:00:00Z",
        "archived-transport-failure",
      ]);
      const valid = JSON.stringify({ statusCode: 1, result: { transArr: [] } });
      await db.ingestRun(
        {
          runId: "archived-later-success",
          connectionId,
          responses: [
            {
              accountKey,
              endpoint,
              capturedAt: "2000-01-03T00:00:00Z",
              responseText: valid,
              scope,
            },
          ],
        },
        calAdapter,
      );
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toEqual([
        expect.objectContaining({
          runId: "archived-later-success",
          after: expect.objectContaining({ failedScopes: [] }),
        }),
      ]);
    });

    it("does not let an older failed capture reopen a scope already proven healthy by newer evidence", async () => {
      const scope = history();
      const valid = JSON.stringify({ statusCode: 1, result: { transArr: [] } });
      expect(
        (await capture("newer-success-first", valid, scope, 4)).status,
      ).toBe("completed");
      const bad = JSON.stringify({ statusCode: 2, result: null });
      expect(
        (await captureArchived("older-failure-later", bad, scope, 3)).status,
      ).toBe("failed");
      expect(
        (await capture("newer-success-repeat", valid, scope, 4)).status,
      ).toBe("completed");
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(0);
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.failed",
        ),
      ).toEqual([expect.objectContaining({ runId: "older-failure-later" })]);
      expect(await archivedResponse("older-failure-later")).toBe(bad);
      expect((await capture("later-real-failure", bad, scope, 5)).status).toBe(
        "failed",
      );
      await capture("stale-success-repeat", valid, scope, 4);
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(0);
      await capture("later-real-recovery", valid, scope, 6);
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toEqual([expect.objectContaining({ runId: "later-real-recovery" })]);
    });

    it("allows a newly applied failure at the same capture time to remain conservative", async () => {
      const scope = history();
      const valid = JSON.stringify({ statusCode: 1, result: { transArr: [] } });
      await capture("same-time-good", valid, scope, 4);
      await capture(
        "same-time-bad",
        JSON.stringify({ statusCode: 2, result: null }),
        scope,
        4,
      );
      await capture("older-good-after-tie", valid, scope, 3);
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(0);
      await capture("fresh-good-after-tie", valid, scope, 5);
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toEqual([expect.objectContaining({ runId: "fresh-good-after-tie" })]);
    });

    it.each([
      { cardKey: "SYNTHETIC-CARD-A" },
      { cardKeys: ["SYNTHETIC-CARD-A"] },
    ])(
      "archives but does not ingest financial rows for cards outside the requested scope %j",
      async (selection) => {
        const scope: CollectionScope = { kind: "history", ...selection };
        const wrong = {
          ...regular,
          cardUniqueId: "SYNTHETIC-OUTSIDE-CARD",
          trnIntId: "SYNTHETIC-OUTSIDE-TRANSACTION",
        };
        const raw = JSON.stringify({
          statusCode: 1,
          result: { transArr: [regular, wrong] },
        });
        expect(
          await captureArchived("scope-card-mismatch", raw, scope),
        ).toMatchObject({
          status: "partial",
          created: 1,
          unlisted: 0,
        });
        expect(await db.listTransactions()).toHaveLength(1);
        const [card] = await db.raw(
          'SELECT id, provider_key AS "providerKey" FROM cards',
        );
        expect(card?.providerKey).toBe("SYNTHETIC-CARD-A");
        expect((await db.listTransactions())[0]?.cardId).toBe(card?.id);
        const run = (await readRun())!;
        expect(await archivedResponse(run.id)).toBe(raw);
        expect(run.warnings).toEqual(["out_of_scope_card"]);
        expect(run.coverage[0]).toMatchObject({
          success: false,
          comparable: false,
        });
        expect(
          JSON.parse((await archivedResponse(run.id))!).result.transArr,
        ).toHaveLength(2);
      },
    );

    it("compares grouped-card scope membership independent of request order and preserves raw order", async () => {
      const scope: CollectionScope = {
        kind: "history",
        from: "2040-01-01",
        to: "2040-12-31",
        cardKeys: ["SYNTHETIC-CARD-B", "SYNTHETIC-CARD-A"],
      };
      await db.ingestRun(
        {
          runId: "group-failed",
          connectionId,
          responses: [],
          failures: [{ accountKey, endpoint, code: "network_error", scope }],
        },
        calAdapter,
      );
      await capture("other-group", response([]), {
        ...scope,
        cardKeys: ["SYNTHETIC-CARD-A"],
      });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(0);
      await capture("same-group", response([]), {
        ...scope,
        cardKeys: [...scope.cardKeys!].reverse(),
      });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(1);
      expect(
        (await readRun("group-failed"))?.snapshot.failures?.[0]?.scope
          ?.cardKeys,
      ).toEqual(scope.cardKeys);
      await expect(
        capture("empty-group", response([]), { ...scope, cardKeys: [] }),
      ).rejects.toThrow();
    });

    it("recovers the same failed monthly unit when the retry narrows the caller date range", async () => {
      const originalScope = {
        ...history(),
        from: "2019-01-01",
        to: "2040-12-31",
      };
      await db.ingestRun(
        {
          runId: "failed-wide",
          connectionId,
          responses: [],
          failures: [
            {
              accountKey,
              endpoint,
              code: "network_error",
              scope: originalScope,
            },
          ],
        },
        calAdapter,
      );
      const narrower = { ...history(), from: "2040-05-01", to: "2040-05-31" };
      await capture("recovered-narrow", response([]), narrower);
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(1);
      expect(
        (await readRun("failed-wide"))?.snapshot.failures?.[0]?.scope,
      ).toEqual(originalScope);
      expect(
        (await readRun("recovered-narrow"))?.snapshot.responses[0]?.scope,
      ).toEqual(narrower);
    });

    it("reports recent recovery independently while unsupported historical scopes remain failed", async () => {
      const monthly = JSON.stringify({
        statusCode: 1,
        result: { bankAccounts: [] },
      });
      await capture("unsupported-history", monthly, history());
      await db.ingestRun(
        {
          runId: "recent-failed",
          connectionId,
          responses: [],
          failures: [{ accountKey, endpoint, code: "network_error" }],
        },
        calAdapter,
      );
      await capture("recent-recovered", response([]), undefined, 2);
      const recovery = (await db.listEvents()).filter(
        (change) => change.type === "sync.recovered",
      );
      expect(recovery).toHaveLength(1);
      expect(recovery[0]).toMatchObject({
        runId: "recent-recovered",
        after: {
          status: "completed",
          recoveredScopes: expect.arrayContaining([expect.any(String)]),
          failedScopes: expect.arrayContaining([expect.any(String)]),
        },
      });
      const details = recovery[0]!.after as {
        recoveredScopes: string[];
        failedScopes: string[];
      };
      expect(details.recoveredScopes).toHaveLength(2);
      expect(details.failedScopes).toHaveLength(1);
      expect(details.failedScopes[0]).toContain("2040-05");
      expect(
        details.recoveredScopes.some((scope) => scope.includes("2040-05")),
      ).toBe(false);
      await capture("other-history", response([]), history("2040-06"));
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(1);
      await capture("history-recovered", response([]), history());
      const finalRecovery = (await db.listEvents())
        .filter((change) => change.type === "sync.recovered")
        .at(-1)!;
      expect(finalRecovery).toMatchObject({
        runId: "history-recovered",
        after: { recoveredScopes: details.failedScopes, failedScopes: [] },
      });
    });

    it("reads only prior-run metadata while retaining full large raw archives", async () => {
      const sentinel = "SYNTHETIC_LARGE_RAW_BODY".repeat(10000);
      const large = JSON.stringify({
        statusCode: 1,
        result: { transactions: [], clearanceRequests: [] },
        unknownSourceField: sentinel,
      });
      await captureArchived("large-prior", large, history());
      const statements: string[] = [];
      if (db.driver.kind === "postgres") {
        const client = await db.driver.pool.connect();
        const query = vi.spyOn(client, "query");
        client.release();
        try {
          await capture("next-window", response([]), history("2040-06"));
          for (const [statement] of query.mock.calls) {
            statements.push(
              typeof statement === "string"
                ? statement
                : (statement as { text: string }).text,
            );
          }
        } finally {
          query.mockRestore();
        }
      } else if (db.driver.kind === "d1") {
        const prepare = vi.spyOn(db.driver.binding, "prepare");
        try {
          await capture("next-window", response([]), history("2040-06"));
          statements.push(...prepare.mock.calls.map(([query]) => query));
        } finally {
          prepare.mockRestore();
        }
      } else {
        const client = db.driver.client;
        const begin = client.transaction.bind(client);
        const spy = vi
          .spyOn(client, "transaction")
          .mockImplementation(async (...args: Parameters<typeof begin>) => {
            const tx = await begin(...args);
            const execute = tx.execute.bind(tx);
            tx.execute = async (statement) => {
              statements.push(
                typeof statement === "string" ? statement : statement.sql,
              );
              return execute(statement);
            };
            return tx;
          });
        try {
          await capture("next-window", response([]), history("2040-06"));
        } finally {
          spy.mockRestore();
        }
      }
      // The latest applied run, read with the stored run-history summary.
      const metadataQuery = statements.find(
        (query) =>
          query.includes('from "sync_runs"') && query.includes("over ()"),
      );
      expect(metadataQuery).toBeDefined();
      const priorMetadata = JSON.stringify(
        await db.raw(metadataQuery!.replace(/\$\d+/g, "?"), [connectionId, 1]),
      );
      expect(priorMetadata).not.toContain("SYNTHETIC_LARGE_RAW_BODY");
      expect(priorMetadata.length).toBeLessThan(5000);
      expect(await archivedResponse("large-prior")).toBe(large);
    });

    it("does not treat source-code-only monthly fields as validated purchase commitments", async () => {
      await capture("recent", response([regular]));
      const current = (await db.listTransactions())[0]!;
      const raw = JSON.stringify({
        statusCode: 1,
        result: {
          bankAccounts: [
            {
              debitDates: [
                {
                  transactions: [
                    {
                      trnIntId: "SYNTHETIC-MONTHLY",
                      amtBeforeConvAndIndex: 12.34,
                    },
                  ],
                },
              ],
              immidiateDebits: {
                debitDays: [
                  {
                    transactions: [
                      { trnIntId: "SYNTHETIC-IMMEDIATE", trnAmt: 12.34 },
                    ],
                  },
                ],
              },
            },
          ],
        },
      });
      expect(await captureArchived("monthly", raw, history())).toMatchObject({
        status: "failed",
        created: 0,
        updated: 0,
        unlisted: 0,
      });
      const run = (await readRun("monthly"))!;
      expect(await archivedResponse(run.id)).toBe(raw);
      expect(run.warnings).toEqual([
        "unsupported_monthly_projection",
        "unsupported_monthly_rows:2",
      ]);
      expect(await db.getTransaction(current.id)).toEqual(current);
    });

    it("keeps empty unsupported monthly envelopes explicit and does not report successful history", async () => {
      const raw = JSON.stringify({
        statusCode: 1,
        result: { bankAccounts: [] },
      });
      expect((await capture("empty-monthly", raw, history())).status).toBe(
        "failed",
      );
      expect((await readRun())?.warnings).toContain(
        "unsupported_monthly_rows:0",
      );
    });

    it.each([
      { nextCursor: "synthetic-continuation" },
      { hasMore: true },
      { totalPages: 2 },
    ])(
      "retains known current rows when a capture advertises unsupported pagination %j",
      async (pagination) => {
        const recentRegular = {
          ...regular,
          trnPurchaseDate: "2040-07-01T14:30:00",
        };
        await capture(
          "recent",
          response([
            recentRegular,
            { ...recentRegular, trnIntId: "SYNTHETIC-OTHER" },
          ]),
        );
        const before = await db.listTransactions();
        const totalsBefore = await db.getTotals();
        const paged = JSON.stringify({
          statusCode: 1,
          result: {
            transactions: [recentRegular],
            clearanceRequests: [],
            ...pagination,
          },
        });
        expect(await capture("incomplete", paged, undefined, 2)).toMatchObject({
          status: "partial",
          created: 0,
          unlisted: 0,
        });
        expect(
          (await db.listTransactions()).every((row) => row.presence === "seen"),
        ).toBe(true);
        expect(
          (await db.listTransactions()).map((row) => row.id).sort(),
        ).toEqual(before.map((row) => row.id).sort());
        const run = (await readRun("incomplete"))!;
        expect(run.warnings).toContain("unsupported_pagination");
        expect(
          run.coverage.every((part) => !part.success && !part.comparable),
        ).toBe(true);
        await capture("complete", response([recentRegular]), undefined, 3);
        expect(
          (await db.listEvents()).filter(
            (change) => change.type === "sync.recovered",
          ),
        ).toHaveLength(1);
        const recovered = await db.listTransactions();
        expect(recovered.map((row) => row.id).sort()).toEqual(
          before.map((row) => row.id).sort(),
        );
        expect(
          recovered.every(
            (row) => row.presence === "seen" && !row.sourceAbsence,
          ),
        ).toBe(true);
        expect((await db.getTotals()).includedCount).toBe(2);
        expect(await db.getTotals()).toEqual(totalsBefore);
      },
    );

    it("records later historical discoveries as historical baselines instead of new purchase arrivals", async () => {
      await capture("recent", response([regular]));
      const result = await capture(
        "history-new",
        response([{ ...regular, trnIntId: "SYNTHETIC-HISTORICAL-OTHER" }]),
        history(),
        2,
      );
      expect(result.created).toBe(1);
      const events = (await db.listEvents()).filter(
        (change) => change.runId === "history-new",
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "transaction.imported",
        transactionId: expect.any(String),
      });
      expect(await db.getTransaction(events[0]!.transactionId!)).toMatchObject({
        presence: "not_returned",
      });
      expect(events[1]).toMatchObject({
        type: "sync.baseline",
        after: {
          historical: true,
          transactionCount: 1,
          accountKeys: [accountKey],
        },
      });
    });

    it("rejects invalid requested dates before creating a run", async () => {
      await expect(
        capture("invalid-range", response([]), {
          kind: "history",
          from: "2040-02-30",
          to: "2040-03-01",
        }),
      ).rejects.toThrow();
      await expect(
        capture("reversed-range", response([]), {
          kind: "history",
          from: "2040-03-02",
          to: "2040-03-01",
        }),
      ).rejects.toThrow();
      expect(await readRuns()).toEqual([]);
    });

    it("retains observed empty search evidence without claiming historical completeness", async () => {
      await capture("recent", response([regular]));
      const before = await db.listTransactions();
      const raw = JSON.stringify({
        statusCode: 93,
        statusTitle: null,
        statusDescription: CAL_EMPTY_SEARCH_DESCRIPTION,
        result: null,
      });
      const searchEndpoint =
        "https://api.cal-online.co.il/Transactions/api/filteredTransactions/getFilteredTransactions";
      expect(
        await captureArchived(
          "empty-search",
          raw,
          { kind: "history", from: "2010-01-01", to: "2010-12-31" },
          2,
          { endpoint: searchEndpoint },
        ),
      ).toMatchObject({
        status: "completed",
        created: 0,
        updated: 0,
        unlisted: 0,
      });
      expect(await db.listTransactions()).toEqual(before);
      const run = (await readRun("empty-search"))!;
      expect(await archivedResponse(run.id)).toBe(raw);
      expect(run.warnings).toEqual(["empty_search_result"]);
      expect(run.coverage).toEqual([
        expect.objectContaining({
          status: "posted",
          success: true,
          comparable: false,
        }),
      ]);
      expect(
        (
          await capture("wrong-resource", raw, history(), 2, {
            endpoint: endpoint,
          })
        ).status,
      ).toBe("failed");
      expect(
        (
          await capture(
            "wrong-description",
            JSON.stringify({
              statusCode: 93,
              result: null,
              statusDescription: "Synthetic unrelated error",
            }),
            history(),
            2,
            { endpoint: searchEndpoint },
          )
        ).status,
      ).toBe("failed");
    });

    it("does not let successful filtered history recover a failed unfiltered scope", async () => {
      const scope: CollectionScope = {
        kind: "history",
        from: "2040-01-01",
        to: "2040-12-31",
        cardKeys: ["SYNTHETIC-CARD-A"],
      };
      await db.ingestRun(
        {
          runId: "full-search-failed",
          connectionId,
          responses: [],
          failures: [{ accountKey, endpoint, code: "network_error", scope }],
        },
        calAdapter,
      );
      const defaults = normalizeCalSearchFilters().recorded;
      await capture("filtered-success", response([]), {
        ...scope,
        filters: {
          cal: {
            ...defaults,
            merchantHebName: "Synthetic Merchant",
            fromTrnAmt: "10.00",
          },
        },
      });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(0);
      await capture("full-search-recovered", response([]), {
        ...scope,
        filters: { cal: defaults },
      });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(1);
      expect(
        (await readRun("filtered-success"))?.snapshot.responses[0]?.scope
          ?.filters?.cal,
      ).toMatchObject({
        merchantHebName: "Synthetic Merchant",
        fromTrnAmt: "10.00",
      });
    });

    it("deduplicates native purchases across overlapping month-edge searches while preserving distinct lookalikes and annotations", async () => {
      const searchEndpoint =
        "https://api.cal-online.co.il/Transactions/api/filteredTransactions/getFilteredTransactions";
      const common = { ...regular, trnPurchaseDate: "2040-02-29T23:59:59" };
      const boundary = { ...common, trnIntId: "SYNTHETIC-MONTH-BOUNDARY" };
      const firstLookalike = { ...common, trnIntId: "SYNTHETIC-LOOKALIKE-A" };
      const secondLookalike = { ...common, trnIntId: "SYNTHETIC-LOOKALIKE-B" };
      const firstRaw = JSON.stringify({
        statusCode: 1,
        result: { transArr: [boundary, firstLookalike] },
      });
      const secondRaw = JSON.stringify({
        statusCode: 1,
        result: { transArr: [boundary, secondLookalike] },
      });
      const filters = { cal: normalizeCalSearchFilters().recorded };
      const firstScope: CollectionScope = {
        kind: "history",
        from: "2040-01-31",
        to: "2040-03-01",
        windowFrom: "2040-02-01",
        windowTo: "2040-02-29",
        cardKeys: ["SYNTHETIC-CARD-A"],
        filters,
      };
      const secondScope: CollectionScope = {
        kind: "history",
        from: "2040-02-29",
        to: "2040-04-01",
        windowFrom: "2040-03-01",
        windowTo: "2040-03-31",
        cardKeys: ["SYNTHETIC-CARD-A"],
        filters,
      };
      expect(
        (
          await captureArchived("edge-february", firstRaw, firstScope, 1, {
            endpoint: searchEndpoint,
          })
        ).created,
      ).toBe(2);
      const existing = (await db.listTransactions()).find((row) =>
        row.sourceKey.includes("SYNTHETIC-MONTH-BOUNDARY"),
      )!;
      const annotation = await db.editAnnotation({
        transactionId: existing.id,
        expectedVersion: 0,
        expectedTransactionVersion: existing.version,
        notes: "Synthetic note for a boundary purchase",
        category: "Synthetic category",
        review: { status: "approved" },
      });
      expect(
        await captureArchived("edge-march", secondRaw, secondScope, 2, {
          endpoint: searchEndpoint,
        }),
      ).toMatchObject({ created: 1, updated: 0, unlisted: 0 });
      const current = (await db.getTransaction(existing.id))!;
      expect(current).toMatchObject({
        version: existing.version,
        amountMinor: -8640,
        reviewStale: false,
      });
      expect(current.annotation).toEqual(annotation);
      expect(
        current.details.sourceRefs.map((reference) => reference.runId),
      ).toEqual(["edge-february", "edge-march"]);
      const rows = await db.listTransactions();
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.id)).size).toBe(3);
      expect(
        rows.every(
          (row) =>
            row.amountMinor === existing.amountMinor &&
            row.merchantName === existing.merchantName,
        ),
      ).toBe(true);
      expect(await db.getTotals()).toMatchObject({
        includedCount: 3,
        totals: [
          {
            currency: "ILS",
            amountBasis: "purchase_commitment",
            amountMinor: -25920,
          },
        ],
      });
      const runs = await readRuns();
      expect(
        await Promise.all(runs.map((run) => archivedResponse(run.id))),
      ).toEqual([firstRaw, secondRaw]);
      expect(
        await Promise.all(
          runs.map(
            async (run) =>
              JSON.parse((await archivedResponse(run.id))!).result.transArr
                .length,
          ),
        ),
      ).toEqual([2, 2]);
      expect(runs.map((run) => run.snapshot.responses[0]?.scope)).toEqual([
        firstScope,
        secondScope,
      ]);
    });

    it("recovers an unpadded failed window through padded retry only with matching cards and filters", async () => {
      const originalScope: CollectionScope = {
        kind: "history",
        from: "2040-02-01",
        to: "2040-02-29",
        cardKeys: ["SYNTHETIC-CARD-A"],
        filters: { cal: normalizeCalSearchFilters().recorded },
      };
      await db.ingestRun(
        {
          runId: "nominal-failed",
          connectionId,
          responses: [],
          failures: [
            {
              accountKey,
              endpoint,
              code: "network_error",
              scope: originalScope,
            },
          ],
        },
        calAdapter,
      );
      const padded: CollectionScope = {
        ...originalScope,
        from: "2040-01-31",
        to: "2040-03-01",
        windowFrom: "2040-02-01",
        windowTo: "2040-02-29",
      };
      await capture("padded-other-card", response([]), {
        ...padded,
        cardKeys: ["SYNTHETIC-CARD-B"],
      });
      await capture("padded-filtered", response([]), {
        ...padded,
        filters: {
          cal: {
            ...(originalScope.filters!.cal as JsonObject),
            merchantHebName: "Synthetic Merchant",
          },
        },
      });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(0);
      await capture("padded-same-window", response([]), padded);
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(1);
      expect(
        (await readRun("padded-same-window"))?.snapshot.responses[0]?.scope,
      ).toEqual(padded);
    });

    it.each([
      { from: "2040-01-31", to: "2040-03-01", windowFrom: "2040-02-01" },
      { from: "2040-01-31", to: "2040-03-01", windowTo: "2040-02-29" },
      {
        from: "2040-01-31",
        to: "2040-03-01",
        windowFrom: "2040-02-29",
        windowTo: "2040-02-01",
      },
      {
        from: "2040-02-02",
        to: "2040-03-01",
        windowFrom: "2040-02-01",
        windowTo: "2040-02-29",
      },
      {
        from: "2040-01-31",
        to: "2040-02-28",
        windowFrom: "2040-02-01",
        windowTo: "2040-02-29",
      },
      { windowFrom: "2040-02-01", windowTo: "2040-02-29" },
    ])(
      "rejects incomplete, reversed, or uncontained nominal request windows %j",
      async (bounds) => {
        await expect(
          capture("invalid-window", response([]), {
            kind: "history",
            ...bounds,
          }),
        ).rejects.toThrow();
        expect(await readRuns()).toEqual([]);
      },
    );

    it("does not recover an empty-search scope while its envelope still advertises pagination", async () => {
      const searchEndpoint =
        "https://api.cal-online.co.il/Transactions/api/filteredTransactions/getFilteredTransactions";
      const scope: CollectionScope = {
        kind: "history",
        from: "2010-01-01",
        to: "2010-12-31",
      };
      await db.ingestRun(
        {
          runId: "empty-search-failed",
          connectionId,
          responses: [],
          failures: [
            {
              accountKey,
              endpoint: searchEndpoint,
              code: "network_error",
              scope,
            },
          ],
        },
        calAdapter,
      );
      const envelope = {
        statusCode: 93,
        statusTitle: null,
        statusDescription: CAL_EMPTY_SEARCH_DESCRIPTION,
        result: null,
      };
      const paged = JSON.stringify({
        ...envelope,
        nextCursor: "synthetic-next-cursor",
      });
      expect(
        (
          await captureArchived("empty-search-paged", paged, scope, 1, {
            endpoint: searchEndpoint,
          })
        ).status,
      ).toBe("failed");
      const run = (await readRun("empty-search-paged"))!;
      expect(await archivedResponse(run.id)).toBe(paged);
      expect(run.warnings).toEqual([
        "unsupported_pagination",
        "empty_search_result",
      ]);
      expect(run.coverage[0]).toMatchObject({
        success: false,
        comparable: false,
      });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(0);
      expect(
        (
          await capture(
            "empty-search-complete",
            JSON.stringify(envelope),
            scope,
            2,
            {
              endpoint: searchEndpoint,
            },
          )
        ).status,
      ).toBe("completed");
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(1);
    });

    it("compares documented CAL recent aliases for freshness while preserving their original endpoint", async () => {
      await capture(
        "live-current",
        response([regular]),
        { kind: "recent" },
        3,
        {
          endpoint: CAL_ENDPOINTS.recent,
        },
      );
      const current = (await db.listTransactions())[0]!;
      const older = response([
        regular,
        { ...regular, trnIntId: "SYNTHETIC-OLDER-OTHER" },
      ]);
      expect(
        await capture("offline-old", older, undefined, 1, {
          endpoint: "synthetic:cal/recent",
        }),
      ).toMatchObject({ created: 1, updated: 0, unlisted: 0 });
      expect(await db.getTransaction(current.id)).toEqual(current);
      expect(
        (await db.listTransactions()).find((row) => row.id !== current.id)
          ?.presence,
      ).toBe("not_returned");
      const run = (await readRun("offline-old"))!;
      expect(run.coverage.every((part) => part.resource === "cal:recent")).toBe(
        true,
      );
      expect(run.snapshot.responses[0]?.endpoint).toBe("synthetic:cal/recent");
    });

    it("recovers failed recent collection across documented aliases without merging custom resources", async () => {
      await db.ingestRun(
        {
          runId: "offline-failed",
          connectionId,
          responses: [],
          failures: [
            {
              accountKey,
              endpoint: "synthetic:cal/recent",
              code: "network_error",
            },
          ],
        },
        calAdapter,
      );
      await capture("custom-unrelated", response([]), undefined, 1, {
        endpoint: `${CAL_ENDPOINTS.recent}?custom=1`,
      });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(0);
      await capture("live-recovered", response([]), undefined, 2, {
        endpoint: CAL_ENDPOINTS.recent,
      });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(1);
    });

    it.each([400, 429, 500])(
      "archives HTTP %i evidence without applying its apparently valid source rows",
      async (httpStatus) => {
        await capture("recent", response([regular]));
        const before = await db.listTransactions();
        const raw = response([
          { ...regular, amountForDisplay: 999, trnAmt: 999 },
          { ...regular, trnIntId: "SYNTHETIC-HTTP-ERROR-OTHER" },
        ]);
        expect(
          await captureArchived("http-error", raw, undefined, 2, {
            httpStatus,
          }),
        ).toMatchObject({
          status: "failed",
          created: 0,
          updated: 0,
          unlisted: 0,
        });
        expect(await db.listTransactions()).toEqual(before);
        const run = (await readRun("http-error"))!;
        expect(run.snapshot.responses[0]).toMatchObject({ httpStatus });
        expect(await archivedResponse(run.id)).toBe(raw);
        expect(run.warnings).toEqual(["unexpected_http_status"]);
        expect(
          run.coverage.every((part) => !part.success && !part.comparable),
        ).toBe(true);
      },
    );

    it("archives a terminal rate limit as a bounded collection failure", async () => {
      expect(
        (
          await db.ingestRun(
            {
              runId: "rate-limited",
              connectionId,
              responses: [],
              failures: [{ accountKey, endpoint, code: "rate_limited" }],
            },
            calAdapter,
          )
        ).status,
      ).toBe("failed");
      expect((await readRun())?.warnings).toEqual(["rate_limited"]);
    });

    it("rejects a parser change for an unapplied run while keeping completed replay a no-op", async () => {
      await failEvents("synthetic_failure", "synthetic failure");
      await expect(
        capture("unapplied", response([regular])),
      ).rejects.toMatchObject({
        cause: { message: expect.stringContaining("synthetic failure") },
      });
      await db.raw(
        `DROP TRIGGER synthetic_failure${backend === "postgres" ? " ON events" : ""}`,
      );
      const archived = (await readRun("unapplied"))!;
      const changed: SourceAdapter = {
        provider: "cal",
        parserVersion: "cal-next-test",
        retainProviderEvidence: () => ({}),
        extract() {
          throw new Error("Extraction should not run");
        },
      };
      await expect(db.applyRun("unapplied", changed)).rejects.toThrow(
        /parser version/,
      );
      expect(await readRun("unapplied")).toEqual(archived);
      expect(await db.listTransactions()).toEqual([]);
      const unchanged: SourceAdapter = {
        ...changed,
        parserVersion: archived.parserVersion,
        extract(raw, context) {
          return extractCal(raw, context);
        },
      };
      expect(await db.applyRun("unapplied", unchanged)).toMatchObject({
        created: 1,
        status: "completed",
      });
      expect((await db.applyRun("unapplied", changed)).replayed).toBe(true);
    });

    it("uses the same archive and reconciliation path for a second small adapter", async () => {
      await db.ensureConnection({
        id: `${connectionId}-bank`,
        provider: "synthetic-bank",
      });
      const bank: TransactionInput = {
        sourceScope: "bank-account",
        cardKey: null,
        sourceKey: "bank-entry",
        sourceAliases: [],
        identityStrength: "native",
        status: "posted",
        description: "Synthetic income",
        counterpartyName: "Synthetic employer",
        kind: "income",
        merchantName: null,
        merchantProviderId: null,
        merchantCategoryCode: null,
        transactionDate: "2040-01-01",
        bookingDate: "2040-01-02",
        billingDate: null,
        amountMinor: 10000,
        currency: "EUR",
        amountBasis: "booked_entry",
        originalAmountMinor: null,
        originalCurrency: null,
        installmentCount: null,
        details: emptyDetails(),
      };
      const adapter: SourceAdapter = {
        provider: "synthetic-bank",
        parserVersion: "bank-test-v1",
        retainProviderEvidence: () => ({}),
        extract(raw, context) {
          return {
            transactions: [
              {
                ...bank,
                ...JSON.parse(raw),
                sourceScope: context.accountKey,
                details: {
                  ...emptyDetails(),
                  sourceRefs: [{ runId: context.runId, path: "/entry" }],
                },
              },
            ],
            partitions: [
              {
                accountKey: context.accountKey,
                status: "posted",
                success: true,
                comparable: true,
              },
            ],
            warnings: [],
            historical: false,
          };
        },
      };
      const input = {
        runId: "bank-run",
        connectionId: `${connectionId}-bank`,
        responses: [
          {
            accountKey: "bank-account",
            endpoint: "/bank-entry",
            capturedAt: "2040-02-01T00:00:00Z",
            responseText: '{"amountMinor":10000}',
          },
        ],
      };
      expect(await db.ingestRun(input, adapter)).toMatchObject({
        created: 1,
        status: "completed",
      });
      const row = (
        await db.listTransactions({ connectionId: `${connectionId}-bank` })
      )[0]!;
      expect(row).toMatchObject({
        cardId: null,
        merchantName: null,
        amountBasis: "booked_entry",
        amountMinor: 10000,
      });
      expect((await db.applyRun(input.runId, adapter)).replayed).toBe(true);
      await expect(
        db.applyRun(input.runId, { ...adapter, provider: "cal" }),
      ).rejects.toThrow("Connection provider mismatch");
    });
  });
}
