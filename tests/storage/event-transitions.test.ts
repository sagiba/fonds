import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyCounts } from "../../src/application/refreshes.js";
import { EVENT_TYPES } from "../../src/domain/records.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import {
  authorization,
  postingAdapter,
  postingHarness,
} from "../helpers/posting.js";
import { type Harness, open, row } from "../helpers/storage-harness.js";

/** The posting adapter with the named partitions failed. */
function failing(...statuses: ("posted" | "pending")[]): SourceAdapter {
  return {
    ...postingAdapter,
    extract(text, context) {
      const result = postingAdapter.extract(text, context);
      for (const partition of result.partitions) {
        if (statuses.includes(partition.status)) {
          partition.success = false;
          partition.comparable = false;
        }
      }
      return result;
    },
  };
}

describe("ledger event transitions", () => {
  let db: Harness;
  let harness: ReturnType<typeof postingHarness>;
  beforeEach(async () => {
    db = await open("sqlite");
    harness = postingHarness(db);
    await db.ensureConnection({ id: harness.connectionId, provider: "cal" });
  });
  afterEach(() => db.close());

  it("emits every event type from the transition that owns it", async () => {
    const emitted = new Set<string>();

    async function typesOf(action: () => Promise<unknown>) {
      const after = await db.latestEventId();
      await action();
      const types = (await db.listEvents({ after })).map((event) => event.type);
      types.forEach((type) => emitted.add(type));
      return types;
    }

    const original = row("a");
    const corrected = row("a", { amountMinor: -200 });
    const other = row("b", { merchantName: "Other" });
    const pending = authorization("p", {
      merchantName: "Shop",
      amountMinor: -300,
    });
    const posted = row("q", { merchantName: "Shop", amountMinor: -300 });

    // Collection: discovery, correction, absence and return.
    expect(await typesOf(() => harness.capture(1, [original]))).toEqual([
      "transaction.imported",
      "sync.baseline",
    ]);
    expect(await typesOf(() => harness.capture(2, [corrected, other]))).toEqual(
      ["transaction.updated", "transaction.created"],
    );
    expect(await typesOf(() => harness.capture(3, [other]))).toEqual([
      "transaction.unlisted",
    ]);
    expect(await typesOf(() => harness.capture(4, [corrected, other]))).toEqual(
      ["transaction.restored"],
    );

    // Owner review through annotations.
    const reviewed = await harness.byKey("a");
    expect(
      await typesOf(() =>
        db.editAnnotation({
          transactionId: reviewed.id,
          expectedVersion: 0,
          expectedTransactionVersion: reviewed.version,
          review: { status: "needs_review" },
        }),
      ),
    ).toEqual(["annotation.updated", "transaction.review_required"]);
    expect(
      await typesOf(() =>
        db.editAnnotation({
          transactionId: reviewed.id,
          expectedVersion: 1,
          expectedTransactionVersion: reviewed.version,
          review: { status: "approved" },
        }),
      ),
    ).toEqual(["annotation.updated", "transaction.review_resolved"]);

    // Posting: an automatic continuation, then the owner's split.
    expect(
      await typesOf(() => harness.capture(5, [corrected, other, pending])),
    ).toEqual(["transaction.created"]);
    expect(
      await typesOf(() => harness.capture(6, [corrected, other, posted])),
    ).toEqual(["transaction.posted", "transaction.linked"]);
    const survivor = await harness.byKey("q");
    expect(
      await typesOf(async () =>
        db.unlinkPendingTransaction(
          await harness.command(
            survivor.id,
            survivor.details.postingLink!.postedId,
          ),
        ),
      ),
    ).toEqual(["transaction.unlinked", "transaction.unlinked"]);

    // Owner removal.
    const removed = await harness.byKey("b");
    expect(
      await typesOf(() =>
        db.confirmRemoval({
          transactionId: removed.id,
          expectedVersion: removed.version,
          reason: "Duplicate",
        }),
      ),
    ).toEqual(["transaction.removed"]);

    // Collection health: failure, partial recovery, full recovery.
    expect(
      await typesOf(() => harness.capture(7, [], failing("posted", "pending"))),
    ).toEqual(["sync.failed"]);
    expect(
      await typesOf(() =>
        harness.capture(8, [corrected, posted], failing("pending")),
      ),
    ).toEqual(["sync.partial", "sync.recovered"]);
    expect(
      await typesOf(() => harness.capture(9, [corrected, posted])),
    ).toEqual(["sync.recovered"]);

    // Refresh health: an attention block starts with a failure, then lifts.
    async function finishRefresh(
      id: string,
      status: "completed" | "failed",
      requiresAttention: boolean,
    ) {
      await db.admitRefresh(
        {
          id,
          connectionId: harness.connectionId,
          trigger: "manual",
          status: "running",
          skipReason: null,
          range: null,
          occurrence: null,
          scheduledAt: null,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: null,
          requiresAttention: false,
          counts: emptyCounts(),
          failureCodes: [],
          failureReason: null,
          missed: null,
          windows: [],
        },
        { operator: true, now: Date.now() },
      );
      await db.withCollectionLock(harness.connectionId, (locked) =>
        locked.updateRefresh(id, {
          status,
          requiresAttention,
          finishedAt: new Date().toISOString(),
        }),
      );
    }

    expect(
      await typesOf(() => finishRefresh("blocked", "failed", true)),
    ).toEqual(["refresh.failed", "refresh.attention_required"]);
    expect(
      await typesOf(() => finishRefresh("retried", "completed", false)),
    ).toEqual(["refresh.recovered"]);

    expect([...emitted].sort()).toEqual([...EVENT_TYPES].sort());
  });
});
