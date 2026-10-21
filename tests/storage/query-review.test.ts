import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "../../src/domain/errors.js";
import { emptyDetails, unknownLedgerFacts } from "../../src/domain/model.js";
import { reviewState } from "../../src/domain/plans/annotation.js";
import type { Transaction } from "../../src/domain/records.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  backends,
  type Harness,
  insertTransactionFixture,
  open,
} from "../helpers/storage-harness.js";

for (const backend of backends) {
  describe(`public review state and scalar totals: ${backend}`, () => {
    let db: Harness;
    let connectionId: string;
    beforeEach(async () => {
      db = await open(backend);
      connectionId = `query-review-${randomUUID()}`;
      await db.ensureConnection({ id: connectionId, provider: "cal" });
      await db.raw(
        "INSERT INTO sync_runs (id, connection_id, started_at, status, collector_version, parser_version, metadata_json, evidence_digest, coverage_json, warnings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "run",
          connectionId,
          "2040-08-01T00:00:00Z",
          "completed",
          "synthetic",
          "synthetic",
          JSON.stringify({ schemaVersion: 1, responses: [] }),
          "0".repeat(64),
          "[]",
          "[]",
        ],
      );
    });
    afterEach(() => db?.close());

    async function insertTransaction(row: Transaction) {
      await insertTransactionFixture(db, [row]);
      return row;
    }

    async function insert(
      id = "purchase",
      overrides: Partial<Transaction> = {},
    ) {
      return await insertTransaction({
        id,
        connectionId,
        sourceScope: "account",
        sourceKey: id,
        sourceAliases: [],
        identityStrength: "native",
        status: "posted",
        presence: "seen",
        description: null,
        counterpartyName: null,
        kind: "purchase",
        merchantName: "Synthetic merchant",
        merchantProviderId: null,
        merchantCategoryCode: null,
        transactionDate: "2040-07-01",
        bookingDate: null,
        billingDate: null,
        amountMinor: -12345,
        currency: "ILS",
        amountBasis: "purchase_commitment",
        originalAmountMinor: null,
        originalCurrency: null,
        installmentCount: null,
        ...unknownLedgerFacts(null),
        details: emptyDetails(),
        firstSeenAt: "2040-08-01T00:00:00Z",
        lastSeenAt: "2040-08-01T00:00:00Z",
        lastSeenRunId: "run",
        version: 1,
        supersededById: null,
        ...overrides,
      });
    }

    it("honors an explicit needs_review instruction without manufacturing a parser issue", async () => {
      const row = await insert();
      await db.editAnnotation({
        transactionId: row.id,
        expectedVersion: 0,
        expectedTransactionVersion: row.version,
        review: { status: "needs_review" },
      });
      expect((await db.getTransaction(row.id))?.reviewRequired).toBe(true);
      expect(
        reviewState(row, (await db.getTransaction(row.id))!.annotation!.data),
      ).toEqual({
        required: true,
        reasons: ["user_needs_review"],
        candidates: [],
      });
      expect((await db.getTransaction(row.id))!.details.issues).toEqual([]);
      expect((await db.listEvents()).map((change) => change.type)).toEqual([
        "annotation.updated",
        "transaction.review_required",
      ]);
    });

    async function annotate(
      row: Transaction,
      status: "approved" | "needs_review",
    ) {
      return await db.editAnnotation({
        transactionId: row.id,
        expectedVersion: 0,
        expectedTransactionVersion: row.version,
        review: { status },
      });
    }

    it("distinguishes clean unreviewed, notes-only and approved purchases without changing spending eligibility", async () => {
      const clean = await insert("clean");
      const notes = await insert("notes");
      const approved = await insert("approved");
      await db.editAnnotation({
        transactionId: notes.id,
        expectedVersion: 0,
        notes: "A note is not an approval",
      });
      await annotate(approved, "approved");
      expect(await db.getTransaction(clean.id)).toMatchObject({
        reviewStatus: "unreviewed",
        reviewRequired: false,
        sourceIssues: [],
        reviewReasons: [],
      });
      expect(await db.getTransaction(notes.id)).toMatchObject({
        reviewStatus: "unreviewed",
        reviewRequired: false,
      });
      expect(await db.getTransaction(approved.id)).toMatchObject({
        reviewStatus: "approved",
        reviewRequired: false,
      });
      expect((await db.listEvents()).map((event) => event.type)).toEqual([
        "annotation.updated",
        "annotation.updated",
      ]);
      expect(await db.getTotals()).toMatchObject({
        includedCount: 3,
        excludedCount: 0,
      });
    });

    it.each(["approved", "needs_review"] as const)(
      "reports stale %s decisions after basis changes but not version-only changes",
      async (status) => {
        const row = await insert();
        const annotation = await annotate(row, status);
        await db.raw(
          "UPDATE transactions SET version = ?, merchant_name = ? WHERE id = ?",
          [2, "Corrected merchant", row.id],
        );
        expect(await db.getTransaction(row.id)).toMatchObject({
          reviewStatus: status,
          reviewStale: false,
        });
        await db.raw(
          "UPDATE transactions SET version = ?, amount_minor = ? WHERE id = ?",
          [3, -12346, row.id],
        );
        expect(await db.getTransaction(row.id)).toMatchObject({
          reviewStatus: "stale",
          reviewStale: true,
          reviewRequired: true,
          reviewReasons:
            status === "needs_review"
              ? ["review_stale", "user_needs_review"]
              : ["review_stale"],
          sourceIssues: [],
          annotation,
        });
      },
    );

    it("keeps source problems visible alongside approval", async () => {
      const row = await insert("source-issue", {
        details: { ...emptyDetails(), issues: ["unknown_installment_count"] },
      });
      await annotate(row, "approved");
      expect(await db.getTransaction(row.id)).toMatchObject({
        reviewStatus: "approved",
        reviewRequired: true,
        reviewStale: false,
        sourceIssues: ["unknown_installment_count"],
        reviewReasons: ["unknown_installment_count"],
      });
      const instructed = await insert("instructed");
      await annotate(instructed, "needs_review");
      expect((await db.getTransaction(instructed.id))?.reviewReasons).toEqual([
        "user_needs_review",
      ]);
      // Neither a parser issue nor a user instruction alone changes money inclusion policy.
      expect(await db.getTotals()).toMatchObject({
        includedCount: 2,
        excludedCount: 0,
      });
    });

    it("does not stale an approval on a non-basis version bump but does on a money change", async () => {
      const row = await insert();
      await db.editAnnotation({
        transactionId: row.id,
        expectedVersion: 0,
        expectedTransactionVersion: 1,
        review: { status: "approved" },
      });
      await db.raw(
        "UPDATE transactions SET description = ?, version = ? WHERE id = ?",
        ["Corrected description", 2, row.id],
      );
      expect(await db.getTransaction(row.id)).toMatchObject({
        version: 2,
        reviewStatus: "approved",
        reviewStale: false,
        reviewRequired: false,
        reviewReasons: [],
      });
      await db.raw(
        "UPDATE transactions SET amount_minor = ?, version = ? WHERE id = ?",
        [-13000, 3, row.id],
      );
      expect(await db.getTransaction(row.id)).toMatchObject({
        reviewStatus: "stale",
        reviewStale: true,
        reviewRequired: true,
        reviewReasons: ["review_stale"],
      });
    });

    it("keeps pending/posting candidates independent of approval and source issues", async () => {
      const row = await insert("candidates", {
        status: "pending",
        details: {
          ...emptyDetails(),
          pendingPostingCandidates: ["b", "a", "b"],
        },
      });
      await annotate(row, "approved");
      expect(await db.getTransaction(row.id)).toMatchObject({
        reviewStatus: "approved",
        reviewRequired: true,
        sourceIssues: [],
        reviewReasons: [],
        pendingPostingCandidates: ["a", "b"],
      });
      expect(await db.getTotals()).toMatchObject({
        includedCount: 0,
        excluded: { pending: 1 },
      });
    });

    it.each(["removed", "superseded"] as const)(
      "preserves user decisions for %s rows while retiring actionable review",
      async (state) => {
        const row = await insert();
        await annotate(row, "needs_review");
        if (state === "removed") {
          await db.raw("UPDATE transactions SET presence = ? WHERE id = ?", [
            "removed",
            row.id,
          ]);
        } else {
          await insert("survivor");
          await db.raw(
            "UPDATE transactions SET superseded_by_id = ? WHERE id = ?",
            ["survivor", row.id],
          );
        }
        expect(await db.getTransaction(row.id)).toMatchObject({
          reviewStatus: "needs_review",
          reviewRequired: false,
          reviewReasons: [],
        });
      },
    );

    it("persists required/resolved transitions atomically through edit and undo", async () => {
      const row = await insert();
      const first = await annotate(row, "needs_review");
      const second = await db.editAnnotation({
        transactionId: row.id,
        expectedVersion: first.version,
        expectedTransactionVersion: row.version,
        review: { status: "approved" },
      });
      const approvedChange = (await db.listEvents()).find(
        (change) =>
          change.type === "annotation.updated" &&
          (change.after as { version: number }).version === second.version,
      )!;
      await db.undoAnnotation({
        eventId: approvedChange.id,
        expectedVersion: second.version,
      });
      expect(await db.getTransaction(row.id)).toMatchObject({
        reviewStatus: "needs_review",
        reviewRequired: true,
        annotation: { version: 3 },
      });
      expect((await db.listEvents()).map((change) => change.type)).toEqual([
        "annotation.updated",
        "transaction.review_required",
        "annotation.updated",
        "transaction.review_resolved",
        "annotation.updated",
        "transaction.review_required",
      ]);
      expect((await db.listEvents()).at(-1)).toMatchObject({
        actor: "user:undo",
        after: {
          required: true,
          reasons: ["user_needs_review"],
          candidates: [],
        },
      });
    });

    it("applies every PATCH rule to the annotation document", async () => {
      const row = await insert();
      const patch = (
        expectedVersion: number,
        fields: Record<string, unknown>,
      ) =>
        db.editAnnotation({
          transactionId: row.id,
          expectedVersion,
          ...fields,
        } as Parameters<typeof db.editAnnotation>[0]);
      const first = await patch(0, {
        notes: "note",
        category: "cat",
        tags: [" a ", "b", "a"],
        metadata: { keep: 1, drop: "x", nested: { deep: [1, null] } },
      });
      expect(first.data).toEqual({
        schemaVersion: 1,
        notes: "note",
        category: "cat",
        tags: ["a", "b"],
        metadata: { keep: 1, drop: "x", nested: { deep: [1, null] } },
        review: null,
      });
      // Omitted fields stay; metadata merges key-wise and null deletes a key.
      const second = await patch(1, { metadata: { drop: null, added: true } });
      expect(second.data).toEqual({
        ...first.data,
        metadata: { keep: 1, nested: { deep: [1, null] }, added: true },
      });
      // An identical patch is a no-op: no version bump, no event.
      const eventCount = (await db.listEvents()).length;
      expect((await patch(2, { notes: "note" })).version).toBe(2);
      expect((await db.listEvents()).length).toBe(eventCount);
      // Tags are replaced as a whole set; [] clears; null clears notes/category.
      const third = await patch(2, {
        tags: ["z"],
        notes: null,
        category: null,
      });
      expect(third.data).toMatchObject({
        notes: null,
        category: null,
        tags: ["z"],
      });
      expect((await patch(3, { tags: [] })).data.tags).toEqual([]);
      // metadata: null clears everything.
      const cleared = await patch(4, { metadata: null });
      expect(cleared.data.metadata).toEqual({});
      expect(cleared.version).toBe(5);
      await expect(patch(4, { notes: "late" })).rejects.toThrow(ConflictError);
    });

    it("requires expectedTransactionVersion for review and stamps the current basis", async () => {
      const row = await insert();
      await expect(
        db.editAnnotation({
          transactionId: row.id,
          expectedVersion: 0,
          review: { status: "approved" },
        }),
      ).rejects.toThrow();
      await expect(
        db.editAnnotation({
          transactionId: row.id,
          expectedVersion: 0,
          expectedTransactionVersion: row.version + 1,
          review: { status: "approved" },
        }),
      ).rejects.toThrow(ConflictError);
      const approved = await annotate(row, "approved");
      expect(approved.data.review).toEqual({
        status: "approved",
        financialVersion: row.version,
        basis: {
          amountMinor: -12345,
          currency: "ILS",
          amountBasis: "purchase_commitment",
          kind: "purchase",
        },
      });
      const removed = await db.editAnnotation({
        transactionId: row.id,
        expectedVersion: approved.version,
        expectedTransactionVersion: row.version,
        review: null,
      });
      expect(removed.data.review).toBeNull();
    });

    it("undo restores the historical review basis without restamping", async () => {
      const row = await insert();
      const first = await annotate(row, "approved");
      await db.raw(
        "UPDATE transactions SET amount_minor = ?, version = ? WHERE id = ?",
        [-13000, 2, row.id],
      );
      expect(await db.getTransaction(row.id)).toMatchObject({
        reviewStatus: "stale",
      });
      const second = await db.editAnnotation({
        transactionId: row.id,
        expectedVersion: first.version,
        expectedTransactionVersion: 2,
        review: { status: "approved" },
      });
      expect(second.data.review).toMatchObject({
        financialVersion: 2,
        basis: { amountMinor: -13000 },
      });
      expect(await db.getTransaction(row.id)).toMatchObject({
        reviewStatus: "approved",
        reviewStale: false,
      });
      const change = (await db.listEvents()).filter(
        (event) => event.type === "annotation.updated",
      )[1]!;
      const undone = await db.undoAnnotation({
        eventId: change.id,
        expectedVersion: second.version,
      });
      expect(undone.data).toEqual(first.data);
      expect(undone.data.review).toMatchObject({
        financialVersion: 1,
        basis: { amountMinor: row.amountMinor },
      });
      expect(await db.getTransaction(row.id)).toMatchObject({
        reviewStatus: "stale",
        reviewStale: true,
      });
    });

    it("keeps paged and unpaged derived review signals consistent under existing filters", async () => {
      const manual = await insert("manual");
      await annotate(manual, "needs_review");
      await insert("clean");
      await insert("pending", { status: "pending" });
      const filters = {
        connectionId,
        status: "posted" as const,
        presence: "seen" as const,
        merchantName: "Synthetic merchant",
      };
      const full = await db.listTransactions(filters);
      const page = await db.listTransactionPage({ ...filters, limit: 1 });
      const second = await db.listTransactionPage({
        ...filters,
        limit: 1,
        after: {
          transactionDate: page.transactions[0]!.transactionDate,
          id: page.transactions[0]!.id,
        },
      });
      expect([...page.transactions, ...second.transactions]).toEqual(full);
      expect(full.filter((row) => row.reviewRequired)).toHaveLength(1);
      expect(
        full.filter((row) => row.reviewStatus === "needs_review"),
      ).toHaveLength(1);
      expect(full).toHaveLength(2);
      expect(await db.getTotals({ connectionId })).toMatchObject({
        includedCount: full.length,
        excluded: { pending: 1 },
      });
    });

    it("undoes the first review instruction back to unreviewed with a durable resolution", async () => {
      const row = await insert();
      await annotate(row, "needs_review");
      const edit = (await db.listEvents()).find(
        (change) => change.type === "annotation.updated",
      )!;
      await db.undoAnnotation({
        eventId: edit.id,
        expectedVersion: 1,
      });
      expect(await db.getTransaction(row.id)).toMatchObject({
        reviewStatus: "unreviewed",
        reviewRequired: false,
      });
      expect((await db.listEvents()).map((change) => change.type)).toEqual([
        "annotation.updated",
        "transaction.review_required",
        "annotation.updated",
        "transaction.review_resolved",
      ]);
    });

    it("resolves actionable review on confirmed removal while preserving explicit user intent", async () => {
      const row = await insert();
      const annotation = await annotate(row, "needs_review");
      const result = await db.confirmRemoval({
        transactionId: row.id,
        expectedVersion: row.version,
        reason: "Owner confirmed removal of this synthetic purchase",
      });
      expect(result).toMatchObject({ presence: "removed" });
      expect(await db.getTransaction(row.id)).toMatchObject({
        annotation,
        reviewStatus: "needs_review",
        reviewRequired: false,
        reviewReasons: [],
      });
      expect((await db.listEvents()).map((change) => change.type)).toEqual([
        "annotation.updated",
        "transaction.review_required",
        "transaction.removed",
        "transaction.review_resolved",
      ]);
      expect((await db.listEvents()).at(-1)).toMatchObject({
        transactionId: row.id,
        before: { required: true, reasons: ["user_needs_review"] },
        after: { required: false, reasons: [] },
      });
    });

    it("carries explicit review onto the surviving pending ID after confirmed posting and retires the duplicate", async () => {
      const pending = await insert("pending", {
        status: "pending",
        amountBasis: "authorization",
      });
      const posted = await insert("posted");
      const annotation = await annotate(pending, "needs_review");
      const result = await db.linkPendingTransaction({
        pendingId: pending.id,
        postedId: posted.id,
        expectedPendingVersion: pending.version,
        expectedPostedVersion: posted.version,
        expectedPendingAnnotationVersion: annotation.version,
        expectedPostedAnnotationVersion: 0,
        reason: "Owner confirmed these synthetic rows are one purchase",
      });
      expect(result).toMatchObject({
        id: pending.id,
        status: "posted",
      });
      expect(await db.getTransaction(pending.id)).toMatchObject({
        reviewStatus: "needs_review",
        reviewStale: false,
        reviewRequired: true,
        reviewReasons: ["user_needs_review"],
        annotation: {
          data: {
            review: {
              status: "needs_review",
              financialVersion: result.version,
              basis: {
                amountMinor: -12345,
                currency: "ILS",
                amountBasis: "purchase_commitment",
                kind: "purchase",
              },
            },
          },
        },
      });
      expect(await db.getTransaction(posted.id)).toMatchObject({
        supersededById: pending.id,
        reviewRequired: false,
        reviewReasons: [],
      });
      expect(await db.listTransactions()).toHaveLength(1);
      expect(await db.getTotals({ includeSuperseded: true })).toMatchObject({
        includedCount: 1,
        excluded: { retiredOrRemoved: 1 },
      });
    });

    it("keeps every existing v1 wire field explicitly projected", async () => {
      const row = await insert();
      const projected = (await db.getTransaction(row.id))!;
      expect(projected).toMatchObject({
        ...row,
        annotation: null,
        reviewRequired: false,
        reviewStale: false,
      });
      expect(Object.keys(projected).sort()).toEqual(
        [
          ...Object.keys(row),
          "annotation",
          "reviewRequired",
          "reviewStale",
          "reviewStatus",
          "reviewReasons",
          "sourceIssues",
          "pendingPostingCandidates",
        ].sort(),
      );
    });

    it.each(["approved", "needs_review"] as const)(
      "retains %s intent through sync and emits staleness transitions only when needed",
      async (status) => {
        async function capture(name: string, day: number) {
          return await db.ingestRun(
            {
              connectionId,
              runId: `capture-${day}`,
              responses: [
                {
                  accountKey: "cal-account",
                  endpoint: "/synthetic-financial-response",
                  capturedAt: `2040-08-${String(day).padStart(2, "0")}T00:00:00Z`,
                  responseText: readFileSync(
                    new URL(
                      `../providers/cal/fixtures/${name}.json`,
                      import.meta.url,
                    ),
                    "utf8",
                  ),
                },
              ],
            },
            calAdapter,
          );
        }

        await capture("recent-01", 1);
        const row = (await db.listTransactions()).find((item) =>
          item.sourceKey.includes('"SYNTHETIC-TXN-CORRECTED"'),
        )!;
        const annotation = await annotate(row, status);
        await capture("recent-02", 2);
        expect(await db.getTransaction(row.id)).toMatchObject({
          annotation,
          reviewStatus: "stale",
          reviewReasons:
            status === "needs_review"
              ? ["review_stale", "user_needs_review"]
              : ["review_stale"],
        });
        const events = (await db.listEvents()).filter(
          (change) => change.transactionId === row.id,
        );
        expect(
          events.filter(
            (change) => change.type === "transaction.review_required",
          ),
        ).toHaveLength(status === "needs_review" ? 2 : 1);
        await capture("recent-02", 3);
        expect(
          (await db.listEvents()).filter(
            (change) => change.transactionId === row.id,
          ),
        ).toEqual(events);
      },
    );

    it("preserves exact totals and exclusion precedence across currency, basis and connection", async () => {
      await insert("large", { amountMinor: Number.MAX_SAFE_INTEGER });
      await insert("small", { amountMinor: 1 });
      await insert("cancel", {
        amountMinor: -Number.MAX_SAFE_INTEGER,
        kind: "refund",
        presence: "not_returned",
      });
      await insert("euro", { currency: "EUR", amountMinor: -12 });
      await insert("booked", { amountBasis: "booked_entry", amountMinor: -13 });
      await insert("pending", { status: "pending", kind: "unknown" });
      await insert("income", { kind: "income" });
      await insert("transfer", { kind: "transfer" });
      await insert("removed", { presence: "removed", status: "pending" });
      await insert("superseded", { supersededById: "large" });
      await insert("missing-money", { amountMinor: null, currency: null });
      await insert("unknown-basis", { amountBasis: "unknown" });
      await insert("unknown-kind", { kind: "unknown" });
      await insert("ambiguous", { identityStrength: "ambiguous" });
      await db.ensureConnection({
        id: `${connectionId}-other`,
        provider: "cal",
      });
      await insert("other", {
        connectionId: `${connectionId}-other`,
        amountMinor: -100,
      });
      expect(
        await db.getTotals({
          connectionId,
          includeSuperseded: true,
        }),
      ).toEqual({
        totals: [
          { currency: "ILS", amountBasis: "booked_entry", amountMinor: -13 },
          {
            currency: "EUR",
            amountBasis: "purchase_commitment",
            amountMinor: -12,
          },
          {
            currency: "ILS",
            amountBasis: "purchase_commitment",
            amountMinor: 1,
          },
        ],
        fxFees: [],
        fxFeeUnknownCount: 0,
        includedCount: 5,
        excludedCount: 9,
        excluded: {
          pending: 1,
          authorization: 0,
          transferOrIncome: 2,
          retiredOrRemoved: 2,
          unresolved: 4,
        },
      });
      expect(
        (await db.getTotals()).totals.find(
          (group) =>
            group.currency === "ILS" &&
            group.amountBasis === "purchase_commitment",
        )?.amountMinor,
      ).toBe(-99);
      await expect(db.getTotals({ connectionId: "missing" })).rejects.toThrow(
        "Connection not found",
      );
    });

    it.each([1, -1])(
      "rejects final totals beyond the safe integer range in direction %s",
      async (direction) => {
        await insert("large", {
          amountMinor: direction * Number.MAX_SAFE_INTEGER,
        });
        await insert("small", { amountMinor: direction });
        await expect(db.getTotals()).rejects.toThrow(
          /safe integer minor-unit range/,
        );
      },
    );

    // The libSQL HTTP server refuses PRAGMA, so it cannot store corrupt JSON;
    // local libSQL runs the same statements.
    if (backend !== "libsql-http") {
      it("computes totals without decoding transaction or annotation JSON", async () => {
        const row = await insert();
        await db.editAnnotation({ transactionId: row.id, expectedVersion: 0 });
        // Deliberately corrupt only this synthetic database: any JSON projection must fail.
        const corruptions = [
          {
            sql: "UPDATE transactions SET provider_json = ?, source_aliases_json = ?",
            args: ["invalid details JSON", "invalid aliases JSON"],
          },
          {
            sql: "UPDATE annotations SET data_json = ?",
            args: ["invalid annotation JSON"],
          },
        ];
        if (db.driver.kind === "postgres") {
          // PostgreSQL stores these JSON documents as text without json_valid checks.
          for (const { sql, args } of corruptions) {
            await db.raw(sql, args);
          }
        } else if (db.driver.kind === "libsql") {
          const tx = await db.driver.client.transaction("write");
          try {
            await tx.execute("PRAGMA ignore_check_constraints = ON");
            for (const statement of corruptions) {
              await tx.execute(statement);
            }
            await tx.execute("PRAGMA ignore_check_constraints = OFF");
            await tx.commit();
          } finally {
            tx.close();
          }
        } else {
          const binding = db.driver.binding;
          await binding.batch([
            binding.prepare("PRAGMA ignore_check_constraints = ON"),
            ...corruptions.map(({ sql, args }) =>
              binding.prepare(sql).bind(...args),
            ),
            binding.prepare("PRAGMA ignore_check_constraints = OFF"),
          ]);
        }
        await expect(db.getTransaction(row.id)).rejects.toThrow();
        expect(await db.getTotals()).toEqual({
          totals: [
            {
              currency: "ILS",
              amountBasis: "purchase_commitment",
              amountMinor: -12345,
            },
          ],
          fxFees: [],
          fxFeeUnknownCount: 0,
          includedCount: 1,
          excludedCount: 0,
          excluded: {
            pending: 0,
            authorization: 0,
            transferOrIncome: 0,
            retiredOrRemoved: 0,
            unresolved: 0,
          },
        });
      });
    }
  });
}
