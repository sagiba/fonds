import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectFromStore } from "../../src/application/collection.js";
import {
  createEventService,
  type EventSubscription,
} from "../../src/application/events.js";
import type { CollectionScope } from "../../src/domain/records.js";
import type { CollectionEvent } from "../../src/domain/source-adapter.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

type SourceRow = Record<string, unknown>;

interface Envelope {
  statusCode: number;
  result: { transactions: SourceRow[]; clearanceRequests: SourceRow[] };
  [key: string]: unknown;
}

const connectionId = "synthetic-cal";
const accountKey = "synthetic-account";
const endpoint = "/synthetic-financial-response";
const cardA = "SYNTHETIC-CARD-A";
const legacyPendingMerchant = "בית עסק סינתטי LEGACY-PENDING";

function fixture(): Envelope {
  return JSON.parse(
    readFileSync(
      new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
      "utf8",
    ),
  ) as Envelope;
}

function postedKey(nativeId: string, card = cardA) {
  return `cal:posted:purchase:${JSON.stringify([card, nativeId])}`;
}

function postedSource(envelope: Envelope, nativeId: string, card = cardA) {
  const row = envelope.result.transactions.find(
    (item) => item.trnIntId === nativeId && item.cardUniqueId === card,
  );
  if (!row) {
    throw new Error(`Missing synthetic source row ${nativeId}`);
  }
  return row;
}

describe.each(backends)(
  "%s reconciliation scenarios across successive recent captures",
  (backend) => {
    let db: Harness;
    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({ id: connectionId, provider: "cal" });
    });
    afterEach(() => db.close());

    function capture(envelope: Envelope, day: number, scope?: CollectionScope) {
      return db.ingestRun(
        {
          debugArchiveDays: 2,
          connectionId,
          runId: `synthetic-run-${day}`,
          responses: [
            {
              accountKey,
              endpoint,
              capturedAt: `2040-07-${String(day).padStart(2, "0")}T00:00:00.000Z`,
              responseText: JSON.stringify(envelope),
              ...(scope ? { scope } : {}),
            },
          ],
        },
        calAdapter,
      );
    }

    async function bySourceKey(sourceKey: string) {
      const rows = (await db.listTransactions()).filter(
        (row) => row.sourceKey === sourceKey,
      );
      expect(rows).toHaveLength(1);
      return rows[0]!;
    }

    async function changesForRun(day: number) {
      return (await db.listEvents({ limit: 1000 })).filter(
        (change) => change.runId === `synthetic-run-${day}`,
      );
    }

    async function baseline() {
      const result = await capture(fixture(), 1);
      const rowCount = (await db.listTransactions()).length;
      // Baseline discoveries have addressable import events and one bounded summary.
      expect(result).toMatchObject({ created: rowCount, updated: 0 });
      expect((await changesForRun(1)).map((change) => change.type)).toEqual([
        ...Array<string>(rowCount).fill("transaction.imported"),
        "sync.baseline",
      ]);
      expect((await changesForRun(1)).at(-1)).toMatchObject({
        transactionId: null,
        after: { transactionCount: rowCount, accountKeys: [accountKey] },
      });
      return rowCount;
    }

    it("keeps the ID and records an updated change when a posted merchant name changes", async () => {
      const rowCount = await baseline();
      const original = await bySourceKey(postedKey("SYNTHETIC-TXN-REGULAR"));
      const later = fixture();
      postedSource(later, "SYNTHETIC-TXN-REGULAR").merchantName =
        "בית עסק סינתטי RENAMED";
      expect(await capture(later, 2)).toMatchObject({
        created: 0,
        updated: 1,
        unlisted: 0,
      });

      const renamed = await bySourceKey(postedKey("SYNTHETIC-TXN-REGULAR"));
      expect(renamed).toMatchObject({
        id: original.id,
        merchantName: "בית עסק סינתטי RENAMED",
        counterpartyName: null,
        version: original.version + 1,
        presence: "seen",
      });
      expect(await db.listTransactions()).toHaveLength(rowCount);
      // The same native ID on card B is a distinct transaction and stays untouched.
      expect(
        await bySourceKey(
          postedKey("SYNTHETIC-TXN-REGULAR", "SYNTHETIC-CARD-B"),
        ),
      ).toMatchObject({
        merchantName: original.merchantName,
        version: 1,
      });
      const changes = await changesForRun(2);
      expect(changes.map((change) => change.type)).toEqual([
        "transaction.updated",
      ]);
      expect(changes[0]).toMatchObject({
        transactionId: original.id,
        before: { merchantName: original.merchantName },
        after: { merchantName: "בית עסק סינתטי RENAMED" },
      });
    });

    it("keeps the ID and records an updated change when a posted purchase date changes", async () => {
      await baseline();
      const original = await bySourceKey(postedKey("SYNTHETIC-TXN-CONTEXT"));
      expect(original.transactionDate).toBe("2040-05-20");
      const later = fixture();
      postedSource(later, "SYNTHETIC-TXN-CONTEXT").trnPurchaseDate =
        "2040-05-18T09:15:00";
      expect(await capture(later, 2)).toMatchObject({ created: 0, updated: 1 });

      expect(
        await bySourceKey(postedKey("SYNTHETIC-TXN-CONTEXT")),
      ).toMatchObject({
        id: original.id,
        transactionDate: "2040-05-18",
        version: original.version + 1,
      });
      const changes = await changesForRun(2);
      expect(changes.map((change) => change.type)).toEqual([
        "transaction.updated",
      ]);
      expect(changes[0]).toMatchObject({
        transactionId: original.id,
        before: { transactionDate: "2040-05-20" },
        after: { transactionDate: "2040-05-18" },
      });
    });

    it("creates a later refund as a separate credit row without altering the original purchase", async () => {
      const rowCount = await baseline();
      const purchase = await bySourceKey(postedKey("SYNTHETIC-TXN-REGULAR"));
      expect(purchase).toMatchObject({ kind: "purchase", amountMinor: -8640 });
      const later = fixture();
      const template = postedSource(later, "SYNTHETIC-TXN-REFUND");
      later.result.transactions.push({
        ...template,
        trnIntId: "SYNTHETIC-TXN-LATER-REFUND",
        merchantName: purchase.merchantName,
        merchantId: purchase.merchantProviderId,
        amountForDisplay: -86.4,
        amtBeforeConvAndIndex: -86.4,
        // The original amount is unsigned in the reviewed refund shape.
        trnAmt: 86.4,
      });
      expect(await capture(later, 2)).toMatchObject({ created: 1, updated: 0 });

      const refund = await bySourceKey(postedKey("SYNTHETIC-TXN-LATER-REFUND"));
      // Source code 6 with refundInd=true and a negative display amount is a credit.
      expect(refund).toMatchObject({
        kind: "refund",
        status: "posted",
        presence: "seen",
        amountMinor: 8640,
        currency: "ILS",
        originalAmountMinor: 8640,
        originalCurrency: "ILS",
        merchantName: purchase.merchantName,
        reviewRequired: false,
        pendingPostingCandidates: [],
        sourceAliases: [],
        supersededById: null,
        version: 1,
      });
      expect(refund.id).not.toBe(purchase.id);
      // Re-observation refreshes evidence only; facts, version and links are unchanged.
      expect(await db.getTransaction(purchase.id)).toEqual({
        ...purchase,
        lastSeenAt: "2040-07-02T00:00:00.000Z",
        lastSeenRunId: "synthetic-run-2",
        details: {
          ...purchase.details,
          provider: {
            ...purchase.details.provider,
            cal: {
              ...purchase.details.provider.cal,
              identity: { currentRows: [0] },
            },
          },
          sourceRefs: [
            { runId: "synthetic-run-2", path: "/result/transactions/0" },
          ],
        },
      });
      expect(await db.listTransactions()).toHaveLength(rowCount + 1);
      const changes = await changesForRun(2);
      expect(changes.map((change) => change.type)).toEqual([
        "transaction.created",
      ]);
      expect(changes[0]).toMatchObject({
        transactionId: refund.id,
        before: null,
        after: { kind: "refund", amountMinor: 8640, currency: "ILS" },
      });
    });

    it("creates a new row when a pending authorization without a native ID reappears, leaving the old one not_returned", async () => {
      const rowCount = await baseline();
      const pendingRows = async () =>
        (await db.listTransactions({ status: "pending" })).filter(
          (row) => row.merchantName === legacyPendingMerchant,
        );
      const [original] = await pendingRows();
      expect(original).toMatchObject({
        identityStrength: "weak",
        presence: "seen",
      });
      const without = fixture();
      without.result.clearanceRequests =
        without.result.clearanceRequests.filter(
          (row) => row.merchantName !== legacyPendingMerchant,
        );
      expect(await capture(without, 2)).toMatchObject({
        unlisted: 1,
        created: 0,
      });
      expect(await db.getTransaction(original!.id)).toMatchObject({
        presence: "not_returned",
        version: original!.version + 1,
      });
      expect(await changesForRun(2)).toMatchObject([
        {
          type: "transaction.unlisted",
          transactionId: original!.id,
          before: { presence: "seen" },
          after: { presence: "not_returned" },
        },
      ]);

      expect(await capture(fixture(), 3)).toMatchObject({
        created: 1,
        unlisted: 0,
      });
      // Current behavior: a weak authorization's reappearance is not proof of the same purchase.
      const rows = await pendingRows();
      expect(rows).toHaveLength(2);
      const reappeared = rows.find((row) => row.id !== original!.id)!;
      expect(reappeared).toMatchObject({
        sourceKey: original!.sourceKey,
        presence: "seen",
        version: 1,
      });
      expect(await db.getTransaction(original!.id)).toMatchObject({
        presence: "not_returned",
        version: original!.version + 1,
      });
      expect(await db.listTransactions()).toHaveLength(rowCount + 1);
      // The new weak row needs review in its own right; the old row gets no event.
      expect(await changesForRun(3)).toMatchObject([
        {
          type: "transaction.created",
          transactionId: reappeared.id,
          after: { status: "pending", merchantName: legacyPendingMerchant },
        },
        {
          type: "transaction.review_required",
          transactionId: reappeared.id,
          after: { required: true, reasons: ["weak_source_identity"] },
        },
      ]);
    });

    it("never deletes a disappeared native transaction, keeps counting it and restores the same ID on reappearance", async () => {
      const rowCount = await baseline();
      const vanish = await bySourceKey(postedKey("SYNTHETIC-TXN-VANISH"));
      const totalsBefore = await db.getTotals({ connectionId });
      const without = fixture();
      without.result.transactions = without.result.transactions.filter(
        (row) => row.trnIntId !== "SYNTHETIC-TXN-VANISH",
      );
      expect(await capture(without, 2)).toMatchObject({
        unlisted: 1,
        created: 0,
      });

      expect(await db.listTransactions()).toHaveLength(rowCount);
      expect(await db.getTransaction(vanish.id)).toMatchObject({
        presence: "not_returned",
        amountMinor: -6480,
        version: vanish.version + 1,
      });
      expect(
        await db.listTransactions({ presence: "not_returned" }),
      ).toMatchObject([{ id: vanish.id }]);
      // Totals exclude only removed/superseded rows; not_returned is still counted.
      expect(await db.getTotals({ connectionId })).toEqual(totalsBefore);
      expect(await changesForRun(2)).toMatchObject([
        { type: "transaction.unlisted", transactionId: vanish.id },
      ]);

      expect(await capture(fixture(), 3)).toMatchObject({
        created: 0,
        updated: 0,
        unlisted: 0,
      });
      expect(
        await bySourceKey(postedKey("SYNTHETIC-TXN-VANISH")),
      ).toMatchObject({
        id: vanish.id,
        presence: "seen",
        version: vanish.version + 2,
      });
      expect(await db.listTransactions()).toHaveLength(rowCount);
      expect(await changesForRun(3)).toMatchObject([
        {
          type: "transaction.restored",
          transactionId: vanish.id,
          before: { presence: "not_returned" },
          after: { presence: "seen" },
        },
      ]);
    });

    it.each([false, true])(
      "rejects empty posted evidence atomically (pending changed: %s), including replay and retries",
      async (changePending) => {
        await baseline();
        const [annotated] = await db.listTransactions({ status: "posted" });
        await db.editAnnotation({
          transactionId: annotated!.id,
          expectedVersion: 0,
          notes: "Synthetic owner note",
        });
        const ledger = async () => ({
          transactions: await db.raw("SELECT * FROM transactions ORDER BY id"),
          annotations: await db.raw(
            "SELECT * FROM annotations ORDER BY transaction_id",
          ),
          changes: await db.listEvents({ limit: 1000 }),
          revision: await db.ledgerRevision(connectionId),
        });
        const before = await ledger();
        const now = Date.now();
        let subscription: EventSubscription = {
          id: "synthetic-subscription",
          ownerId: "owner",
          clientId: "client",
          connectionId,
          url: "https://synthetic.invalid/events",
          secret: `whsec_${btoa("s".repeat(32))}`,
          previousSecret: null,
          rotationUntil: null,
          verifiedUntil: now + 300_000,
          expiresAt: now + 86_400_000,
          status: "active",
          cursor: await db.latestEventId(connectionId),
          pendingBatch: null,
          attempts: 0,
          nextAttemptAt: now,
          generation: 1,
          reason: null,
        };
        const sendSignedWebhook = vi.fn(
          async () => new Response(null, { status: 200 }),
        );
        const events = createEventService({
          source: db,
          store: {
            get: async () => subscription,
            save: async (value) => {
              subscription = value;
              return value;
            },
            listDue: async () => [subscription],
            latestEventId: (id) => db.latestEventId(id),
          },
          sendSignedWebhook,
          verifyWebhookCallback: async () => {},
          grantCheck: async () => true,
        });
        const empty = fixture();
        empty.result.transactions = [];
        if (changePending) {
          empty.result.clearanceRequests = [];
        }
        for (const day of [2, 3]) {
          expect(await capture(empty, day)).toMatchObject({
            status: "failed",
            failureCode: "implausible_empty",
            created: 0,
            updated: 0,
            unlisted: 0,
          });
          expect(await ledger()).toEqual(before);
          const [archived] = await db.raw(
            "SELECT r.*, b.snapshot_json FROM sync_runs r LEFT JOIN sync_run_bodies b ON b.run_id=r.id WHERE r.id = ?",
            [`synthetic-run-${day}`],
          );
          expect(archived).toMatchObject({
            status: "failed",
            parser_version: calAdapter.parserVersion,
          });
          expect(archived!.applied_at).toBeTruthy();
          expect(archived!.completed_at).toBeTruthy();
          expect(
            JSON.parse(archived!.snapshot_json as string).responses,
          ).toEqual([
            {
              accountKey,
              endpoint,
              capturedAt: `2040-07-0${day}T00:00:00.000Z`,
              responseText: JSON.stringify(empty),
            },
          ]);
          expect(JSON.parse(archived!.warnings_json as string)).toContain(
            "implausible_empty",
          );
          expect(JSON.parse(archived!.coverage_json as string)).toEqual([]);
          expect(
            await db.applyRun(`synthetic-run-${day}`, calAdapter),
          ).toMatchObject({
            replayed: true,
            status: "failed",
            failureCode: "implausible_empty",
          });
          expect(await ledger()).toEqual(before);
          await events.deliver();
          expect(sendSignedWebhook).not.toHaveBeenCalled();
        }
        expect(await capture(fixture(), 4)).toMatchObject({
          status: "completed",
          created: 0,
          updated: 0,
          unlisted: 0,
        });
        expect(await changesForRun(4)).toEqual([]);
      },
    );

    it("evaluates a pending archive against the current ledger, including concurrent PostgreSQL recovery, then makes the rejection terminal", async () => {
      const empty = fixture();
      empty.result.transactions = [];
      empty.result.clearanceRequests = [];
      await expect(
        db.ingestRun(
          {
            debugArchiveDays: 2,
            connectionId,
            runId: "pending-archive",
            responses: [
              {
                accountKey,
                endpoint,
                capturedAt: "2040-07-02T00:00:00Z",
                responseText: JSON.stringify(empty),
              },
            ],
          },
          {
            ...calAdapter,
            extract() {
              throw new Error("Synthetic interruption after archival");
            },
          },
        ),
      ).rejects.toThrow("Synthetic interruption");
      await baseline();
      const revision = await db.ledgerRevision(connectionId);
      const apply = () => db.applyRun("pending-archive", calAdapter);
      const results =
        backend === "postgres"
          ? await Promise.all([apply(), apply()])
          : [await apply(), await apply()];
      for (const result of results) {
        expect(result).toMatchObject({
          status: "failed",
          failureCode: "implausible_empty",
        });
      }
      expect(results.map((result) => result.replayed).sort()).toEqual([
        false,
        true,
      ]);
      expect(
        await db.applyRun("pending-archive", {
          ...calAdapter,
          parserVersion: "future-parser",
          rejectEmptyRecentPosted: false,
          extract() {
            throw new Error("Terminal archives must not be parsed");
          },
        }),
      ).toMatchObject({
        replayed: true,
        status: "failed",
        failureCode: "implausible_empty",
      });
      expect(await db.ledgerRevision(connectionId)).toBe(revision);
    });

    it.each([false, true])(
      "reports a mixed-account refresh as partial (rejection first: %s)",
      async (rejectionFirst) => {
        await baseline();
        const empty = fixture();
        empty.result.transactions = [];
        const responses: CollectionEvent[] = [
          {
            type: "capture",
            capture: {
              accountKey,
              endpoint,
              capturedAt: "2040-07-02T00:00:00Z",
              responseText: JSON.stringify(empty),
            },
          },
          {
            type: "capture",
            capture: {
              accountKey: "synthetic-other",
              endpoint,
              capturedAt: "2040-07-02T00:00:00Z",
              responseText: JSON.stringify(fixture()),
            },
          },
        ];
        if (!rejectionFirst) {
          responses.reverse();
        }
        expect(
          await collectFromStore(
            db,
            { connectionId },
            {
              provider: "cal",
              collectorVersion: "synthetic-v1",
              async *collect() {
                yield* responses;
              },
            },
            calAdapter,
          ),
        ).toMatchObject({
          status: "partial",
          captures: 2,
          failures: 1,
          failureCodes: ["implausible_empty"],
          created: 21,
          updated: 0,
          unlisted: 0,
        });
        expect(
          (await db.listEvents({ limit: 1000 }))
            .filter((change) => change.type !== "transaction.imported")
            .map((change) => change.type),
        ).toEqual(["sync.baseline", "sync.baseline"]);
        expect(
          (await db.listEvents({ limit: 1000 })).filter(
            (change) => change.type === "transaction.imported",
          ),
        ).toHaveLength(42);
      },
    );

    it("accepts an empty pending list while reconciling posted rows", async () => {
      await baseline();
      const emptyPending = fixture();
      emptyPending.result.clearanceRequests = [];
      expect(await capture(emptyPending, 2)).toMatchObject({
        status: "completed",
        unlisted: 2,
      });
      expect((await changesForRun(2)).map((change) => change.type)).toEqual([
        "transaction.unlisted",
        "transaction.unlisted",
      ]);
    });

    it("accepts empty recent lists for a new or pending-only account", async () => {
      const empty = fixture();
      empty.result.transactions = [];
      expect(await capture(empty, 1)).toMatchObject({ status: "completed" });
      empty.result.clearanceRequests = [];
      expect(await capture(empty, 2)).toMatchObject({
        status: "completed",
        unlisted: 2,
      });
    });

    it("accepts a dormant account's empty list and leaves aged rows seen", async () => {
      const postedOnly = fixture();
      postedOnly.result.clearanceRequests = [];
      await capture(postedOnly, 1);
      const before = await db.listTransactions();
      postedOnly.result.transactions = [];
      expect(await capture(postedOnly, 31)).toMatchObject({
        status: "completed",
        unlisted: 0,
      });
      expect(await db.listTransactions()).toEqual(before);
      expect(await changesForRun(31)).toEqual([]);
    });

    it("accepts a new account's empty posted list while another account has recent posted rows", async () => {
      await baseline();
      const before = await db.listTransactions();
      const empty = fixture();
      empty.result.transactions = [];
      empty.result.clearanceRequests = [];
      expect(
        await db.ingestRun(
          {
            debugArchiveDays: 2,
            connectionId,
            runId: "synthetic-other-account",
            responses: [
              {
                accountKey: "synthetic-other",
                endpoint,
                capturedAt: "2040-07-02T00:00:00Z",
                responseText: JSON.stringify(empty),
              },
            ],
          },
          calAdapter,
        ),
      ).toMatchObject({ status: "completed", unlisted: 0 });
      expect(await db.listTransactions()).toEqual(before);
    });

    it("accepts an empty posted list when every recent posted row is already not_returned", async () => {
      const postedOnly = fixture();
      postedOnly.result.clearanceRequests = [];
      await capture(postedOnly, 1);
      postedOnly.result.transactions = [];
      // Build the state an absence policy without the empty-list guard produces.
      await db.ingestRun(
        {
          debugArchiveDays: 2,
          connectionId,
          runId: "synthetic-unguarded",
          responses: [
            {
              accountKey,
              endpoint,
              capturedAt: "2040-07-02T00:00:00Z",
              responseText: JSON.stringify(postedOnly),
            },
          ],
        },
        { ...calAdapter, rejectEmptyRecentPosted: false },
      );
      const before = await db.listTransactions();
      expect(before.length).toBeGreaterThan(0);
      // Billed lines are non-comparable for absence and stay seen.
      expect(
        before.every(
          (row) =>
            row.presence ===
            (row.installmentNumber === null ? "not_returned" : "seen"),
        ),
      ).toBe(true);
      expect(await capture(postedOnly, 3)).toMatchObject({
        status: "completed",
        unlisted: 0,
      });
      expect(await db.listTransactions()).toEqual(before);
      expect(await changesForRun(3)).toEqual([]);
    });

    it("accepts an empty posted list when the only recent posted row is superseded", async () => {
      const singlePurchase = fixture();
      const source = postedSource(singlePurchase, "SYNTHETIC-TXN-REGULAR");
      singlePurchase.result.transactions = [source];
      singlePurchase.result.clearanceRequests = [
        singlePurchase.result.clearanceRequests[0]!,
      ];
      await capture(singlePurchase, 1);
      const [posted] = await db.listTransactions({ status: "posted" });
      const [pending] = await db.listTransactions({ status: "pending" });
      const survivor = await db.linkPendingTransaction({
        pendingId: pending!.id,
        postedId: posted!.id,
        expectedPendingVersion: pending!.version,
        expectedPostedVersion: posted!.version,
        expectedPendingAnnotationVersion: 0,
        expectedPostedAnnotationVersion: 0,
        reason: "Synthetic owner-confirmed posting",
      });
      // A later date correction ages out the survivor; its retired row keeps the recent date.
      source.trnPurchaseDate = "2040-01-01T00:00:00";
      singlePurchase.result.clearanceRequests = [];
      await capture(singlePurchase, 2);
      expect(await db.getTransaction(posted!.id)).toMatchObject({
        status: "posted",
        transactionDate: "2040-05-20",
        presence: "seen",
        supersededById: survivor.id,
      });
      expect(await db.getTransaction(survivor.id)).toMatchObject({
        transactionDate: "2040-01-01",
        supersededById: null,
      });
      const before = await db.listTransactions({ includeSuperseded: true });
      singlePurchase.result.transactions = [];
      expect(await capture(singlePurchase, 3)).toMatchObject({
        status: "completed",
        unlisted: 0,
      });
      expect(await db.listTransactions({ includeSuperseded: true })).toEqual(
        before,
      );
      expect(await changesForRun(3)).toEqual([]);
    });

    it.each([undefined, 60])(
      "compares recent absence only within an optional UTC horizon (%s days)",
      async (days) => {
        const source = {
          ...synthetic,
          ...(days === undefined ? {} : { recentComparableDays: days }),
        };
        const inputs = [
          row("aged", {
            transactionDate: "2040-06-01",
            bookingDate: "2040-08-01",
          }),
          row("boundary", { transactionDate: "2040-06-03" }),
          row("booking", { transactionDate: null, bookingDate: "2040-07-15" }),
          row("undated", { transactionDate: null }),
        ];
        for (const [index, transactions] of [inputs, []].entries()) {
          await db.ingestRun(
            {
              debugArchiveDays: 2,
              connectionId,
              runId: `horizon-${index}`,
              responses: [
                {
                  accountKey: "account",
                  endpoint,
                  capturedAt: `2040-08-0${index + 1}T23:59:00Z`,
                  responseText: JSON.stringify(transactions),
                },
              ],
            },
            source,
          );
        }
        expect(
          (await db.listTransactions({ presence: "not_returned" }))
            .map((row) => row.sourceKey)
            .sort(),
        ).toEqual(
          days === undefined
            ? ["aged", "booking", "boundary", "undated"]
            : ["booking", "boundary"],
        );
        expect(
          (await db.listTransactions({ presence: "seen" }))
            .map((row) => row.sourceKey)
            .sort(),
        ).toEqual(days === undefined ? [] : ["aged", "undated"]);
      },
    );

    it("does not reject an empty historical capture", async () => {
      await baseline();
      const empty = fixture();
      empty.result.transactions = [];
      empty.result.clearanceRequests = [];
      expect(
        await capture(empty, 2, {
          kind: "history",
          from: "2040-01-01",
          to: "2040-07-02",
        }),
      ).toMatchObject({ status: "completed", unlisted: 0 });
      expect(await changesForRun(2)).toEqual([]);
    });
  },
);
