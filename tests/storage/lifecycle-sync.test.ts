import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "../../src/domain/errors.js";
import type { RunInput as CalRunInput } from "../../src/domain/plans/sync.js";
import type { Run } from "../../src/domain/records.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import { retained } from "../helpers/provider-evidence.js";
import { backends, type Harness, open } from "../helpers/storage-harness.js";

type SourceRow = Record<string, unknown>;

interface Envelope {
  result: { transactions: SourceRow[]; clearanceRequests: SourceRow[] };
  [key: string]: unknown;
}

// Invented completeness exercises lifecycle mechanics, not CAL provider guarantees.
const completeCalShape = {
  ...calAdapter,
  sourceCoverage: {
    kind: "account_window" as const,
    resources: ["cal:recent"],
    dateField: "transactionDate" as const,
    days: 60,
  },
  rejectEmptyRecentPosted: true,
};

const accountKey = "synthetic-account";
const endpoint = "synthetic:cal/recent";
const pendingKey = "SYNTHETIC-AUTH-PENDING-POSTED";
const postedKey = "SYNTHETIC-TXN-PENDING-POSTED";

function fixture(name = "recent-01"): Envelope {
  return JSON.parse(
    readFileSync(
      new URL(`../providers/cal/fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Envelope;
}

function response(envelope: Envelope, day: number, account = accountKey) {
  return {
    accountKey: account,
    endpoint,
    capturedAt: `2040-08-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    responseText: JSON.stringify(envelope),
  };
}

function singlePosted(): Envelope {
  const envelope = fixture();
  envelope.result.transactions = envelope.result.transactions
    .filter((row) => row.trnIntId === "SYNTHETIC-TXN-REGULAR")
    .slice(0, 1);
  envelope.result.clearanceRequests = [];
  return envelope;
}

function comparablePostedPair(): Envelope {
  const envelope = singlePosted();
  const row = envelope.result.transactions[0]!;
  row.trnPurchaseDate = "2040-07-01T14:30:00";
  envelope.result.transactions.push({ ...row, trnIntId: "SYNTHETIC-RETAINED" });
  return envelope;
}

for (const backend of backends) {
  describe(`synthetic complete-source collection and owner lifecycle integration: ${backend}`, () => {
    let db: Harness;
    let connectionId: string;
    beforeEach(async () => {
      db = await open(backend);
      connectionId = `lifecycle-sync-${randomUUID()}`;
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
      envelope: Envelope,
      day: number,
      runId = `synthetic-run-${day}`,
    ) {
      return await db.ingestRun(
        {
          connectionId,
          runId,
          responses: [response(envelope, day)],
        },
        completeCalShape,
      );
    }

    it("treats the first transaction after a successful empty account capture as new activity", async () => {
      const empty = singlePosted();
      empty.result.transactions = [];
      await capture(empty, 1);
      expect(await db.listEvents()).toEqual([]);
      await capture(singlePosted(), 2);
      expect((await db.listEvents()).map((change) => change.type)).toEqual([
        "transaction.created",
      ]);
    });

    async function byKey(key: string) {
      const row = (await db.listTransactions()).find((row) =>
        row.sourceKey.includes(`"${key}"`),
      );
      if (!row) {
        throw new Error(`Missing synthetic transaction ${key}`);
      }
      return row;
    }

    async function linkedPurchase() {
      await capture(fixture(), 1);
      const pending = await byKey(pendingKey);
      await db.editAnnotation({
        transactionId: pending.id,
        expectedVersion: 0,
        notes: "Owner's authorization note",
      });
      await capture(fixture("recent-02"), 2);
      const posted = await byKey(postedKey);
      const survivor = await db.linkPendingTransaction({
        pendingId: pending.id,
        postedId: posted.id,
        expectedPendingVersion: (await db.getTransaction(pending.id))!.version,
        expectedPostedVersion: posted.version,
        expectedPendingAnnotationVersion: 1,
        expectedPostedAnnotationVersion: 0,
        reason: "Owner confirmed matching purchase on synthetic statement",
      });
      return { pending, posted, survivor };
    }

    async function state() {
      return {
        rows: await db.raw("SELECT * FROM transactions ORDER BY id"),
        annotations: await db.raw(
          "SELECT * FROM annotations ORDER BY transaction_id",
        ),
        changes: await db.listEvents(),
      };
    }

    it("updates a linked survivor after replay and a posted correction without resurrecting its retired row", async () => {
      const { pending, posted, survivor } = await linkedPurchase();
      const count = (await db.listTransactions()).length;
      const retired = (await db.getTransaction(posted.id))!;
      expect(await capture(fixture("recent-02"), 2)).toMatchObject({
        replayed: true,
      });
      await capture(fixture("recent-02"), 3);
      expect((await byKey(postedKey)).id).toBe(pending.id);
      expect(await db.getTransaction(posted.id)).toEqual(retired);
      const corrected = fixture("recent-02");
      const source = corrected.result.transactions.find(
        (row) => row.trnIntId === postedKey,
      )!;
      source.amountForDisplay = 60.25;
      source.trnAmt = 60.25;
      await capture(corrected, 4);
      expect(await db.getTransaction(survivor.id)).toMatchObject({
        status: "posted",
        amountMinor: -6025,
        version: survivor.version + 1,
        annotation: { data: { notes: "Owner's authorization note" } },
      });
      expect(await db.getTransaction(posted.id)).toEqual(retired);
      expect(await db.listTransactions()).toHaveLength(count);
      expect(
        (await db.listEvents())
          .filter(
            (change) =>
              change.type === "transaction.updated" &&
              change.transactionId === survivor.id,
          )
          .at(-1),
      ).toMatchObject({ after: { amountMinor: -6025 } });
    });

    it("keeps linked authorizations returned beside posted rows as evidence without downgrading or duplicating", async () => {
      const { pending, posted, survivor } = await linkedPurchase();
      const envelope = fixture("recent-02");
      envelope.result.clearanceRequests.push(
        fixture().result.clearanceRequests.find(
          (row) => row.transactionID === pendingKey,
        )!,
      );
      const count = (await db.listTransactions()).length;
      await capture(envelope, 3);
      expect(await db.getTransaction(pending.id)).toMatchObject({
        status: "posted",
        sourceKey: survivor.sourceKey,
        presence: "seen",
        version: survivor.version + 1,
      });
      expect(
        (await db.getTransaction(pending.id))!.details.sourceRefs.some(
          (ref) =>
            ref.runId === "synthetic-run-3" &&
            ref.path.includes("clearanceRequests"),
        ),
      ).toBe(true);
      expect((await db.getTransaction(posted.id))!.supersededById).toBe(
        pending.id,
      );
      expect(await db.listTransactions()).toHaveLength(count);
      expect(
        (await db.listTransactions()).filter((row) =>
          row.sourceAliases.includes(pending.sourceKey),
        ),
      ).toHaveLength(1);
    });

    it("does not treat an authorization alone as a returned posted purchase", async () => {
      const { survivor } = await linkedPurchase();
      const envelope = fixture("recent-02");
      envelope.result.transactions = envelope.result.transactions.filter(
        (row) => row.trnIntId !== postedKey,
      );
      envelope.result.clearanceRequests.push(
        fixture().result.clearanceRequests.find(
          (row) => row.transactionID === pendingKey,
        )!,
      );
      await capture(envelope, 3);
      expect(await db.getTransaction(survivor.id)).toMatchObject({
        status: "posted",
        presence: "not_returned",
        annotation: { data: { notes: "Owner's authorization note" } },
      });
      expect(
        (await db.listEvents()).filter(
          (change) =>
            change.type === "transaction.unlisted" &&
            change.transactionId === survivor.id &&
            change.runId === "synthetic-run-3",
        ),
      ).toHaveLength(1);
    });

    it("keeps explicit removal on the same capture and restores the same ID and note only from newer evidence", async () => {
      const envelope = singlePosted();
      await capture(envelope, 1);
      const row = (await db.listTransactions())[0]!;
      await db.editAnnotation({
        transactionId: row.id,
        expectedVersion: 0,
        notes: "Retain the evidence note",
      });
      await db.confirmRemoval({
        transactionId: row.id,
        expectedVersion: row.version,
        reason: "Owner verified duplicate",
      });
      await capture(envelope, 1, "synthetic-same-capture");
      expect(await db.getTransaction(row.id)).toMatchObject({
        presence: "removed",
        annotation: { data: { notes: "Retain the evidence note" } },
      });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "transaction.restored",
        ),
      ).toHaveLength(0);
      await capture(envelope, 2);
      expect(await db.getTransaction(row.id)).toMatchObject({
        presence: "seen",
        annotation: { data: { notes: "Retain the evidence note" } },
      });
      expect(await db.listTransactions()).toHaveLength(1);
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "transaction.restored",
        ),
      ).toEqual([
        expect.objectContaining({
          transactionId: row.id,
          before: { presence: "removed", sourceAbsence: null },
          after: { presence: "seen", sourceAbsence: null },
        }),
      ]);
    });

    it("invalidates stale lifecycle commands after removal restoration and ordinary presence transitions", async () => {
      const envelope = comparablePostedPair();
      await capture(envelope, 1);
      const row = (await db.listTransactions()).find((row) =>
        row.sourceKey.includes("SYNTHETIC-TXN-REGULAR"),
      )!;
      const removed = await db.confirmRemoval({
        transactionId: row.id,
        expectedVersion: row.version,
        reason: "Owner verified duplicate",
      });
      expect(removed.version).toBe(2);
      await capture(envelope, 2);
      expect(await db.getTransaction(row.id)).toMatchObject({
        version: 3,
        presence: "seen",
      });
      await expect(
        db.confirmRemoval({
          transactionId: row.id,
          expectedVersion: removed.version,
          reason: "Stale removal request",
        }),
      ).rejects.toThrow(ConflictError);
      const without = structuredClone(envelope);
      without.result.transactions.shift();
      await capture(without, 3);
      expect(await db.getTransaction(row.id)).toMatchObject({
        version: 4,
        presence: "not_returned",
      });
      await capture(envelope, 4);
      expect(await db.getTransaction(row.id)).toMatchObject({
        version: 5,
        presence: "seen",
      });
    });

    it("rejects a removal command based on a not-returned view after reappearance without making approval stale", async () => {
      const envelope = comparablePostedPair();
      await capture(envelope, 1);
      const row = (await db.listTransactions()).find((row) =>
        row.sourceKey.includes("SYNTHETIC-TXN-REGULAR"),
      )!;
      await db.editAnnotation({
        transactionId: row.id,
        expectedVersion: 0,
        expectedTransactionVersion: row.version,
        review: { status: "approved" },
      });
      const without = structuredClone(envelope);
      without.result.transactions.shift();
      await capture(without, 2);
      const missing = (await db.getTransaction(row.id))!;
      expect(missing).toMatchObject({
        presence: "not_returned",
        version: row.version + 1,
        reviewStale: false,
      });
      await capture(envelope, 3);
      expect(await db.getTransaction(row.id)).toMatchObject({
        presence: "seen",
        version: missing.version + 1,
        reviewStale: false,
      });
      await expect(
        db.confirmRemoval({
          transactionId: row.id,
          expectedVersion: missing.version,
          reason: "Command based on old absence view",
        }),
      ).rejects.toThrow(ConflictError);
      expect((await db.getTransaction(row.id))!.presence).toBe("seen");
    });

    it("baselines an account's first successful response after another account succeeded and it failed", async () => {
      expect(
        await db.ingestRun(
          {
            connectionId,
            runId: "synthetic-first-account-only",
            responses: [response(singlePosted(), 1)],
            failures: [
              { accountKey: "other-account", endpoint, code: "network_error" },
            ],
          },
          completeCalShape,
        ),
      ).toMatchObject({ status: "partial" });
      expect(
        await db.ingestRun(
          {
            connectionId,
            runId: "synthetic-first-other-account",
            responses: [response(fixture(), 2, "other-account")],
          },
          completeCalShape,
        ),
      ).toMatchObject({ status: "completed", created: 21 });
      const secondRunEvents = (await db.listEvents()).filter(
        (change) => change.runId === "synthetic-first-other-account",
      );
      expect(
        secondRunEvents.filter((change) => change.type === "sync.baseline"),
      ).toEqual([
        expect.objectContaining({
          transactionId: null,
          after: expect.objectContaining({ transactionCount: 21 }),
        }),
      ]);
      expect(
        secondRunEvents.filter((change) =>
          ["transaction.created", "transaction.review_required"].includes(
            change.type,
          ),
        ),
      ).toHaveLength(0);
      expect(
        secondRunEvents.filter((change) => change.type === "sync.recovered"),
      ).toHaveLength(1);
    });

    it("preserves two ambiguous authorizations when a confirmed weak posting's source returns duplicate weak rows", async () => {
      const pendingEnvelope = fixture();
      const pending = pendingEnvelope.result.clearanceRequests.find(
        (row) => row.transactionID === undefined,
      )!;
      const postedEnvelope = fixture("recent-02");
      const postedSource = postedEnvelope.result.transactions.find(
        (row) => row.trnIntId === postedKey,
      )!;
      pending.cardUniqueID = postedSource.cardUniqueId;
      pending.merchantName = postedSource.merchantName;
      pending.trnAmt = postedSource.amountForDisplay;
      pending.trnPurchaseDate = postedSource.trnPurchaseDate;
      pendingEnvelope.result.transactions = [];
      pendingEnvelope.result.clearanceRequests = [pending];
      await capture(pendingEnvelope, 1);
      const weak = (await db.listTransactions())[0]!;
      expect(weak.identityStrength).toBe("weak");
      postedEnvelope.result.transactions = [postedSource];
      postedEnvelope.result.clearanceRequests = [pending];
      await capture(postedEnvelope, 2);
      const posted = await byKey(postedKey);
      const survivor = await db.linkPendingTransaction({
        pendingId: weak.id,
        postedId: posted.id,
        expectedPendingVersion: (await db.getTransaction(weak.id))!.version,
        expectedPostedVersion: posted.version,
        expectedPendingAnnotationVersion: 0,
        expectedPostedAnnotationVersion: 0,
        reason: "Owner explicitly confirmed the synthetic singleton",
      });
      postedEnvelope.result.clearanceRequests = [
        pending,
        structuredClone(pending),
      ];
      await capture(postedEnvelope, 3);
      expect(await db.getTransaction(survivor.id)).toMatchObject({
        status: "posted",
        presence: "seen",
      });
      const ambiguous = await db.listTransactions({
        status: "pending",
        presence: "seen",
      });
      expect(ambiguous).toHaveLength(2);
      expect(
        ambiguous.every(
          (row) => row.identityStrength === "ambiguous" && row.reviewRequired,
        ),
      ).toBe(true);
      expect(new Set(ambiguous.map((row) => row.id)).size).toBe(2);
      for (const row of ambiguous) {
        expect(
          (await db.listEvents()).some(
            (change) =>
              change.runId === "synthetic-run-3" &&
              change.transactionId === row.id &&
              change.type === "transaction.review_required",
          ),
        ).toBe(true);
      }
    });

    it("retains authorization comments merged during confirmation through a later posted resync", async () => {
      const envelope = fixture();
      const comments = [
        {
          key: "synthetic-authorization-context",
          value: "Synthetic authorization-only comment",
        },
      ];
      envelope.result.clearanceRequests.find(
        (row) => row.transactionID === pendingKey,
      )!.transTypeCommentDetails = comments;
      await capture(envelope, 1);
      const pending = await byKey(pendingKey);
      await capture(fixture("recent-02"), 2);
      const posted = await byKey(postedKey);
      const survivor = await db.linkPendingTransaction({
        pendingId: pending.id,
        postedId: posted.id,
        expectedPendingVersion: (await db.getTransaction(pending.id))!.version,
        expectedPostedVersion: posted.version,
        expectedPendingAnnotationVersion: 0,
        expectedPostedAnnotationVersion: 0,
        reason: "Owner confirmed the synthetic purchase",
      });
      expect(retained(survivor.details, "comments")).toEqual(
        expect.arrayContaining(comments),
      );
      await capture(fixture("recent-02"), 3);
      expect(
        retained((await db.getTransaction(survivor.id))!.details, "comments"),
      ).toEqual(expect.arrayContaining(comments));
    });

    it("emits review candidates once and keeps unchanged captures quiet", async () => {
      await capture(fixture(), 1);
      const pending = await byKey(pendingKey);
      await capture(fixture("recent-02"), 2);
      const posted = await byKey(postedKey);
      const reviewEvents = (await db.listEvents()).filter(
        (change) => change.type === "transaction.review_required",
      );
      expect(
        reviewEvents.filter((change) => change.transactionId === pending.id),
      ).toEqual([
        expect.objectContaining({
          after: {
            required: true,
            reasons: ["possible_pending_posted_match"],
            candidates: [posted.id],
          },
        }),
      ]);
      expect(
        reviewEvents.filter((change) => change.transactionId === posted.id),
      ).toEqual([
        expect.objectContaining({
          after: {
            required: true,
            reasons: ["possible_pending_posted_match"],
            candidates: [pending.id],
          },
        }),
      ]);
      await capture(fixture("recent-02"), 3);
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "transaction.review_required",
        ),
      ).toEqual(reviewEvents);
      expect(
        (await db.getTransaction(pending.id))!.details.pendingPostingCandidates,
      ).toEqual([posted.id]);
      expect(
        (await db.getTransaction(posted.id))!.details.pendingPostingCandidates,
      ).toEqual([pending.id]);
    });

    it("resolves unknown currency review when a later response supplies valid currency", async () => {
      const unknown = singlePosted();
      unknown.result.transactions[0]!.debCrdCurrencyCode = 999;
      await capture(unknown, 1);
      const row = (await db.listTransactions())[0]!;
      expect(row).toMatchObject({ currency: null, reviewRequired: true });
      await capture(singlePosted(), 2);
      expect(await db.getTransaction(row.id)).toMatchObject({
        currency: "ILS",
        reviewRequired: false,
      });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "transaction.review_resolved",
        ),
      ).toEqual([
        expect.objectContaining({
          transactionId: row.id,
          after: { required: false, reasons: [], candidates: [] },
        }),
      ]);
    });

    it("emits an annotation review staleness event atomically with a financial correction", async () => {
      const envelope = singlePosted();
      await capture(envelope, 1);
      const row = (await db.listTransactions())[0]!;
      const annotation = await db.editAnnotation({
        transactionId: row.id,
        expectedVersion: 0,
        expectedTransactionVersion: row.version,
        notes: "Approved original amount",
        review: { status: "approved" },
      });
      envelope.result.transactions[0]!.amountForDisplay = 90;
      envelope.result.transactions[0]!.trnAmt = 90;
      await capture(envelope, 2);
      expect(await db.getTransaction(row.id)).toMatchObject({
        amountMinor: -9000,
        reviewStale: true,
        annotation,
      });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "transaction.review_required",
        ),
      ).toEqual([
        expect.objectContaining({
          transactionId: row.id,
          after: { required: true, reasons: ["review_stale"], candidates: [] },
        }),
      ]);
    });

    it.each([
      "network_error",
      "authentication_failed",
      "authentication_challenge",
      "budget_exhausted",
      "invalid_response",
    ] as const)(
      "archives and emits explicit %s failure and a later recovery without changing financial rows",
      async (code) => {
        await capture(singlePosted(), 1);
        const rows = await db.listTransactions();
        const input: CalRunInput = {
          connectionId,
          runId: `synthetic-failure-${code}`,
          startedAt: "2040-08-01T12:00:00Z",
          responses: [],
          failures: [
            {
              accountKey: code === "authentication_failed" ? null : accountKey,
              endpoint,
              code,
            },
          ],
        };
        expect(await db.ingestRun(input, completeCalShape)).toMatchObject({
          status: "failed",
          created: 0,
          updated: 0,
          unlisted: 0,
        });
        expect(await db.listTransactions()).toEqual(rows);
        expect(await readRun(input.runId)).toMatchObject({
          snapshot: { responses: [], failures: input.failures },
          warnings: [code],
          status: "failed",
        });
        const failureEvent = (await db.listEvents()).filter(
          (change) => change.type === "sync.failed",
        );
        expect(failureEvent).toEqual([
          expect.objectContaining({
            runId: input.runId,
            transactionId: null,
            after: {
              status: "failed",
              warnings: [code],
              coverage: expect.any(Array),
            },
          }),
        ]);
        expect(await db.ingestRun(input, completeCalShape)).toMatchObject({
          replayed: true,
        });
        expect(
          (await db.listEvents()).filter(
            (change) => change.type === "sync.failed",
          ),
        ).toEqual(failureEvent);
        await capture(singlePosted(), 2);
        expect(
          (await db.listEvents()).filter(
            (change) => change.type === "sync.recovered",
          ),
        ).toEqual([
          expect.objectContaining({
            before: {
              status: "failed",
              failedScopes: expect.arrayContaining([expect.any(String)]),
            },
            after: {
              status: "completed",
              recoveredScopes: expect.any(Array),
              failedScopes: [],
            },
          }),
        ]);
      },
    );

    it("preserves a failed account while another account applies and emits partial then recovery", async () => {
      const envelope = comparablePostedPair();
      await db.ingestRun(
        {
          connectionId,
          runId: "synthetic-two-accounts",
          responses: [
            response(envelope, 1),
            response(envelope, 1, "other-account"),
          ],
        },
        completeCalShape,
      );
      const otherBefore = (await db.listTransactions()).find(
        (row) => row.sourceScope === "other-account",
      )!;
      const without = structuredClone(envelope);
      without.result.transactions.shift();
      const result = await db.ingestRun(
        {
          connectionId,
          runId: "synthetic-partial",
          startedAt: "2040-08-02T00:00:00Z",
          responses: [response(without, 2)],
          failures: [
            { accountKey: "other-account", endpoint, code: "network_error" },
          ],
        },
        completeCalShape,
      );
      expect(result).toMatchObject({ status: "partial", unlisted: 1 });
      expect(await db.getTransaction(otherBefore.id)).toEqual(otherBefore);
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.partial",
        ),
      ).toEqual([
        expect.objectContaining({
          runId: "synthetic-partial",
          after: {
            status: "partial",
            coverage: expect.any(Array),
            warnings: ["network_error"],
          },
        }),
      ]);
      await db.ingestRun(
        {
          connectionId,
          runId: "synthetic-two-accounts-recovered",
          responses: [
            response(envelope, 3),
            response(envelope, 3, "other-account"),
          ],
        },
        completeCalShape,
      );
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(1);
      expect(
        (await db.listTransactions()).every((row) => row.presence === "seen"),
      ).toBe(true);
    });

    it("recovers a failed account only when that account succeeds after unrelated successful runs", async () => {
      const envelope = singlePosted();
      await db.ingestRun(
        {
          connectionId,
          runId: "synthetic-accounts-baseline",
          responses: [
            response(envelope, 1),
            response(envelope, 1, "other-account"),
          ],
        },
        completeCalShape,
      );
      expect(
        await db.ingestRun(
          {
            connectionId,
            runId: "synthetic-other-account-failed",
            startedAt: "2040-08-02T00:00:00Z",
            responses: [response(envelope, 2)],
            failures: [
              { accountKey: "other-account", endpoint, code: "network_error" },
            ],
          },
          completeCalShape,
        ),
      ).toMatchObject({ status: "partial" });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.partial",
        ),
      ).toHaveLength(1);
      expect(
        await db.ingestRun(
          {
            connectionId,
            runId: "synthetic-unrelated-success",
            responses: [response(envelope, 3)],
          },
          completeCalShape,
        ),
      ).toMatchObject({ status: "completed" });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toHaveLength(0);
      expect(
        await db.ingestRun(
          {
            connectionId,
            runId: "synthetic-other-account-recovered",
            responses: [response(envelope, 4, "other-account")],
          },
          completeCalShape,
        ),
      ).toMatchObject({ status: "completed" });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "sync.recovered",
        ),
      ).toEqual([
        expect.objectContaining({ runId: "synthetic-other-account-recovered" }),
      ]);
    });

    it.each(["transaction.review_required", "sync.partial", "sync.failed"])(
      "rolls back financial and run state when %s event insertion fails while retaining the archive",
      async (kind) => {
        const envelope = singlePosted();
        await capture(envelope, 1);
        if (kind === "transaction.review_required") {
          const row = (await db.listTransactions())[0]!;
          await db.editAnnotation({
            transactionId: row.id,
            expectedVersion: 0,
            expectedTransactionVersion: row.version,
            review: { status: "approved" },
          });
        }
        const before = await state();
        await failEvents(
          "synthetic_event_failure",
          "synthetic event failure",
          `NEW.type = '${kind}'`,
        );
        envelope.result.transactions[0]!.amountForDisplay = 90;
        envelope.result.transactions[0]!.trnAmt = 90;
        const input: CalRunInput = {
          connectionId,
          runId: `synthetic-rollback-${kind}`,
          responses: kind === "sync.failed" ? [] : [response(envelope, 2)],
          ...(kind === "transaction.review_required"
            ? {}
            : {
                failures: [
                  {
                    accountKey: "other-account",
                    endpoint,
                    code: "network_error" as const,
                  },
                ],
              }),
        };
        await expect(
          db.ingestRun(input, completeCalShape),
        ).rejects.toMatchObject({
          cause: {
            message: expect.stringContaining("synthetic event failure"),
          },
        });
        expect(await state()).toEqual(before);
        expect(await readRun(input.runId)).toMatchObject({
          status: "started",
          appliedAt: null,
        });
        expect({
          snapshot: JSON.parse(
            String(
              (
                await db.raw(
                  "SELECT snapshot_json FROM sync_run_bodies WHERE run_id = ?",
                  [input.runId],
                )
              )[0]!.snapshot_json,
            ),
          ),
        }).toMatchObject({
          snapshot: { responses: input.responses },
        });
        await db.raw(
          `DROP TRIGGER synthetic_event_failure${backend === "postgres" ? " ON events" : ""}`,
        );
        expect(await db.applyRun(input.runId, completeCalShape)).toMatchObject({
          replayed: false,
          status:
            kind === "sync.failed"
              ? "failed"
              : kind === "sync.partial"
                ? "partial"
                : "completed",
        });
        expect(
          (await db.listEvents()).filter((change) => change.type === kind),
        ).toHaveLength(1);
      },
    );
  });
}
