import "../helpers/application-loading-differential.js";

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TransactionInput } from "../../src/domain/model.js";
import type { CollectionScope } from "../../src/domain/records.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  backends,
  type Harness,
  insertTransactionFixture,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

const connectionId = "synthetic-negative-coverage";
const complete: SourceAdapter = {
  ...synthetic,
  sourceCoverage: {
    kind: "account_window",
    statuses: ["pending", "posted"],
    resources: ["synthetic:recent"],
    dateField: "transactionDate",
    days: 60,
  },
  rejectEmptyRecentPosted: true,
};
const calFixture = JSON.parse(
  readFileSync(
    new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
    "utf8",
  ),
) as {
  result: {
    transactions: Record<string, unknown>[];
    clearanceRequests: Record<string, unknown>[];
  };
};
const purchase = {
  ...calFixture.result.transactions[0]!,
  trnPurchaseDate: "2040-06-20T12:00:00",
  debCrdDate: "2040-07-01T00:00:00",
};
const authorization = {
  ...calFixture.result.clearanceRequests[0]!,
  trnPurchaseDate: "2040-06-25T12:00:00",
};

describe.each(backends)("%s negative coverage guards", (backend) => {
  let db: Harness;
  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  });
  afterEach(() => db.close());

  function capture(
    runId: string,
    day: number,
    rows: TransactionInput[],
    adapter: SourceAdapter = complete,
    scope?: CollectionScope,
  ) {
    return db.ingestRun(
      {
        connectionId,
        runId,
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:recent",
            capturedAt: `2040-07-${String(day).padStart(2, "0")}T12:00:00Z`,
            responseText: JSON.stringify(rows),
            ...(scope ? { scope } : {}),
          },
        ],
      },
      adapter,
    );
  }

  function calCapture(
    runId: string,
    day: number,
    transactions: Record<string, unknown>[],
    clearanceRequests: Record<string, unknown>[] = [],
    options: {
      result?: Record<string, unknown>;
      httpStatus?: number;
      capturedAt?: string;
    } = {},
  ) {
    return db.ingestRun(
      {
        connectionId,
        runId,
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:cal/recent",
            capturedAt:
              options.capturedAt ??
              `2040-07-${String(day).padStart(2, "0")}T12:00:00Z`,
            responseText: JSON.stringify({
              statusCode: 1,
              result: {
                daysRange: 90,
                transactions,
                clearanceRequests,
                ...options.result,
              },
            }),
            ...(options.httpStatus === undefined
              ? {}
              : { httpStatus: options.httpStatus }),
          },
        ],
      },
      calAdapter,
    );
  }

  it.each([undefined, { kind: "same_origin", statuses: [] } as const])(
    "requires explicit posted authority rather than relying on coverage %j",
    async (sourceCoverage) => {
      const { sourceCoverage: _coverage, ...undeclared } = synthetic;
      const adapter: SourceAdapter = {
        ...undeclared,
        ...(sourceCoverage ? { sourceCoverage } : {}),
      };
      await capture(
        "initial",
        1,
        [row("posted", { amountMinor: -4321 })],
        adapter,
      );
      const [original] = await db.listTransactions();
      await capture("omitted", 2, [], adapter);
      expect(
        (await db.getTransaction(original!.id))!.sourceAbsence,
      ).toBeUndefined();
      expect(await db.getTotals({ connectionId })).toMatchObject({
        includedCount: 1,
        totals: [{ currency: "ILS", amountMinor: -4321 }],
      });
    },
  );

  it.each(["history", "legacy"] as const)(
    "rejects empty posted coverage while %s not_returned money remains current",
    async (origin) => {
      const adapter: SourceAdapter = {
        ...complete,
        extract(text, context) {
          const result = synthetic.extract(text, context);
          if (context.scope?.kind === "history") {
            result.historical = true;
            result.partitions.forEach((part) => {
              part.comparable = false;
            });
          }
          return result;
        },
      };
      await capture(
        "initial",
        1,
        [row("retained", { amountMinor: -4321 })],
        adapter,
        origin === "history" ? { kind: "history" } : undefined,
      );
      const [original] = await db.listTransactions();
      if (origin === "legacy") {
        await insertTransactionFixture(
          db,
          [
            {
              ...original!,
              presence: "not_returned",
              sourceAbsence: undefined,
            },
          ],
          "update",
        );
      }
      expect(await db.getTotals({ connectionId })).toMatchObject({
        includedCount: 1,
      });
      const cursor = await db.latestEventId();
      expect(await capture("empty", 2, [], adapter)).toMatchObject({
        status: "failed",
        failureCode: "implausible_empty",
        unlisted: 0,
      });
      expect(
        (await db.getTransaction(original!.id))!.sourceAbsence,
      ).toBeUndefined();
      expect(await db.getTotals({ connectionId })).toMatchObject({
        includedCount: 1,
        totals: [{ currency: "ILS", amountMinor: -4321 }],
      });
      expect(await db.latestEventId()).toBe(cursor);
      expect(await db.applyRun("empty", adapter)).toMatchObject({
        replayed: true,
        status: "failed",
      });
    },
  );

  it.each([false, true])(
    "rejects a wholly empty CAL glitch while covered pending remains (posted: %s)",
    async (withPosted) => {
      await calCapture("initial", 1, withPosted ? [purchase] : [], [
        authorization,
      ]);
      const before = await db.listTransactions();
      const cursor = await db.latestEventId();
      expect(await calCapture("empty", 2, [])).toMatchObject({
        status: "failed",
        failureCode: "implausible_empty",
        unlisted: 0,
      });
      expect(await db.listTransactions()).toEqual(before);
      expect(await db.latestEventId()).toBe(cursor);
    },
  );

  it("keeps quiet-card membership unproven through failed empties and window expiry until an owner decides", async () => {
    await calCapture("only-pending", 1, [], [authorization]);
    const original = (await db.listTransactions())[0]!;
    const annotation = await db.editAnnotation({
      transactionId: original.id,
      expectedVersion: 0,
      notes: "Keep this authorization's history",
    });
    for (const day of [2, 3]) {
      expect(await calCapture(`empty-${day}`, day, [])).toMatchObject({
        status: "failed",
        failureCode: "implausible_empty",
        unlisted: 0,
      });
    }
    // A later response is still admissible, but its rolling coverage cannot
    // turn the old rejected empty response into proof about an expired window.
    expect(
      await calCapture("outside-window", 4, [], [], {
        capturedAt: "2040-09-01T12:00:00Z",
      }),
    ).toMatchObject({ status: "completed", unlisted: 0 });
    const retained = (await db.getTransaction(original.id))!;
    expect(retained).toMatchObject({
      status: "pending",
      presence: "seen",
      version: original.version,
      lastSeenAt: original.lastSeenAt,
      annotation,
    });
    expect(retained.sourceAbsence).toBeUndefined();
    expect(await db.listTransactions({ presence: "current" })).toHaveLength(1);
    expect(await db.getTotals()).toMatchObject({
      includedCount: 0,
      totals: [],
    });
    await db.confirmRemoval({
      transactionId: original.id,
      expectedVersion: retained.version,
      reason:
        "Owner independently verified this invented authorization expired",
    });
    expect(await db.listTransactions({ presence: "current" })).toEqual([]);
    expect(await db.getTransaction(original.id)).toMatchObject({
      presence: "removed",
      annotation,
    });
    expect(
      (await db.getTransaction(original.id))!.sourceAbsence,
    ).toBeUndefined();
  });

  async function linkedCal() {
    await calCapture("initial", 1, [purchase], [authorization]);
    const pending = (await db.listTransactions({ status: "pending" }))[0]!;
    const posted = (await db.listTransactions({ status: "posted" }))[0]!;
    return db.linkPendingTransaction({
      pendingId: pending.id,
      postedId: posted.id,
      expectedPendingVersion: pending.version,
      expectedPostedVersion: posted.version,
      expectedPendingAnnotationVersion: 0,
      expectedPostedAnnotationVersion: 0,
      reason: "Owner confirmed synthetic continuation",
    });
  }

  it("rejects a wholly empty CAL capture while an active linked pending component remains", async () => {
    const survivor = await linkedCal();
    expect(survivor.details.postingLink!.pending).toMatchObject({
      presence: "seen",
    });
    const before = await db.getTransaction(survivor.id);
    expect(await calCapture("empty-linked", 2, [])).toMatchObject({
      status: "failed",
      failureCode: "implausible_empty",
      unlisted: 0,
    });
    expect(await db.getTransaction(survivor.id)).toEqual(before);
  });

  it.each([
    "removed_component",
    "source_absent",
    "removed_survivor",
    "split",
  ] as const)(
    "does not reject an empty CAL capture for a %s linked authorization",
    async (state) => {
      const survivor = await linkedCal();
      const link = survivor.details.postingLink!;
      if (state === "split") {
        const retired = (await db.getTransaction(link.postedId))!;
        const split = await db.unlinkPendingTransaction({
          pendingId: survivor.id,
          postedId: retired.id,
          expectedPendingVersion: survivor.version,
          expectedPostedVersion: retired.version,
          expectedPendingAnnotationVersion: 0,
          expectedPostedAnnotationVersion: 0,
          reason: "Owner rejected synthetic continuation",
        });
        await insertTransactionFixture(
          db,
          [{ ...split.pending, presence: "removed" }],
          "update",
        );
      } else {
        await insertTransactionFixture(
          db,
          [
            {
              ...survivor,
              ...(state === "removed_survivor"
                ? { presence: "removed" as const }
                : {}),
              details: {
                ...survivor.details,
                postingLink: {
                  ...link,
                  pending: {
                    ...link.pending,
                    ...(state === "removed_component"
                      ? { presence: "removed" as const }
                      : {}),
                    ...(state === "source_absent"
                      ? {
                          presence: "not_returned" as const,
                          sourceAbsence: {
                            runId: "initial",
                            capturedAt: link.pending.lastSeenAt,
                          },
                        }
                      : {}),
                  },
                },
              },
            },
          ],
          "update",
        );
      }
      expect(await calCapture("empty-inactive", 2, [])).toMatchObject({
        status: "completed",
        unlisted: 0,
      });
    },
  );

  it.each([
    "missing_pending",
    "invalid_pending",
    "http_failure",
    "stale",
  ] as const)(
    "does not infer pending absence or an empty-response failure from %s CAL evidence",
    async (state) => {
      await calCapture("initial", 3, [purchase], [authorization]);
      const before = await db.listTransactions();
      const options =
        state === "missing_pending"
          ? { result: { clearanceRequests: undefined } }
          : state === "invalid_pending"
            ? { result: { clearanceRequests: {} } }
            : state === "http_failure"
              ? { httpStatus: 503 }
              : {};
      const result = await calCapture(
        "uncertain",
        state === "stale" ? 2 : 4,
        [],
        [],
        options,
      );
      expect(result).toMatchObject({
        status:
          state === "stale"
            ? "completed"
            : state === "http_failure"
              ? "failed"
              : "partial",
        unlisted: 0,
      });
      expect(result.failureCode).not.toBe("implausible_empty");
      expect(await db.listTransactions()).toEqual(before);
    },
  );

  it("keeps CAL posted omission non-authoritative without changing observation state", async () => {
    await calCapture("initial", 1, [purchase], [authorization]);
    const original = (await db.listTransactions({ status: "posted" }))[0]!;
    const annotation = await db.editAnnotation({
      transactionId: original.id,
      expectedVersion: 0,
      notes: "Keep evidence",
    });
    const cursor = await db.latestEventId();
    expect(
      await calCapture("pending-only", 2, [], [authorization]),
    ).toMatchObject({ status: "completed", unlisted: 0 });
    expect(await db.getTransaction(original.id)).toMatchObject({
      presence: "seen",
      version: original.version,
      annotation,
    });
    expect(
      (await db.getTransaction(original.id))!.sourceAbsence,
    ).toBeUndefined();
    expect(await db.getTotals({ connectionId })).toMatchObject({
      includedCount: 1,
      totals: [{ currency: "ILS", amountMinor: -8640 }],
    });
    expect(
      (await db.listEvents({ after: cursor })).map((event) => event.type),
    ).toEqual([]);
    const missing = await db.getTransaction(original.id);
    const missingCursor = await db.latestEventId();
    await calCapture("still-pending-only", 3, [], [authorization]);
    expect(await db.getTransaction(original.id)).toEqual(missing);
    expect(await db.latestEventId()).toBe(missingCursor);
    await calCapture("returned", 4, [purchase], [authorization]);
    expect(await db.getTransaction(original.id)).toMatchObject({
      presence: "seen",
      version: original.version,
      annotation,
    });
  });

  it.each(["removed", "source_absent", "outside_window", "future"] as const)(
    "does not reject empty posted coverage for a %s row",
    async (state) => {
      await capture("initial", 1, [
        row("excluded", {
          transactionDate:
            state === "outside_window"
              ? "2039-01-01"
              : state === "future"
                ? "2040-07-10"
                : "2040-07-01",
        }),
      ]);
      const [original] = await db.listTransactions();
      if (state === "removed" || state === "source_absent") {
        await insertTransactionFixture(
          db,
          [
            {
              ...original!,
              presence: state === "removed" ? "removed" : "not_returned",
              ...(state === "source_absent"
                ? {
                    sourceAbsence: {
                      runId: "initial",
                      capturedAt: original!.lastSeenAt,
                    },
                  }
                : {}),
            },
          ],
          "update",
        );
      }
      expect(await capture("empty", 2, [])).toMatchObject({
        status: "completed",
        unlisted: 0,
      });
    },
  );

  it("accepts an empty CAL capture when no covered current pending rows exist", async () => {
    expect(await calCapture("new-empty", 1, [])).toMatchObject({
      status: "completed",
      unlisted: 0,
    });
    await calCapture("posted-only", 2, [purchase]);
    expect(await calCapture("posted-empty", 3, [])).toMatchObject({
      status: "completed",
    });
    expect(await db.getTotals({ connectionId })).toMatchObject({
      includedCount: 1,
      totals: [{ currency: "ILS", amountMinor: -8640 }],
    });
  });
});
