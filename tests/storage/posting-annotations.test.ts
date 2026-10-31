import "../helpers/run-history-differential.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "../../src/domain/errors.js";
import { authorization, postingHarness } from "../helpers/posting.js";
import {
  backends,
  type Harness,
  open,
  row,
} from "../helpers/storage-harness.js";

describe.each(backends)("%s link and unlink with annotations", (backend) => {
  let db: Harness;
  let harness: ReturnType<typeof postingHarness>;
  beforeEach(async () => {
    db = await open(backend);
    harness = postingHarness(db);
    await db.ensureConnection({ id: harness.connectionId, provider: "cal" });
  });
  afterEach(() => db.close());

  async function pair() {
    await harness.capture(1, [authorization("auth"), row("posted")]);
    return {
      pending: await harness.byKey("auth"),
      posted: await harness.byKey("posted"),
    };
  }

  it("carries a metadata-only posted annotation to the survivor and keeps both documents on unlink", async () => {
    const { pending, posted } = await pair();
    const metadata = { project: "kitchen", receipt: { pages: 2 } };
    await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: 0,
      metadata,
    });
    await db.linkPendingTransaction(
      await harness.command(pending.id, posted.id),
    );
    const survivor = (await db.getTransaction(pending.id))!;
    expect(survivor.annotation).toMatchObject({
      version: 1,
      data: { metadata, notes: null, tags: [], review: null },
    });
    const copied = (await db.listEvents()).find(
      (event) =>
        event.type === "annotation.updated" &&
        event.transactionId === pending.id,
    );
    expect(copied?.after).toMatchObject({ linkedFromId: posted.id });

    await db.unlinkPendingTransaction(
      await harness.command(pending.id, posted.id),
    );
    expect((await db.getTransaction(pending.id))!.annotation?.data).toEqual(
      survivor.annotation!.data,
    );
    expect((await db.getTransaction(posted.id))!.annotation).toMatchObject({
      version: 1,
      data: { metadata },
    });
  });

  it("refuses to link when both sides hold different metadata", async () => {
    const { pending, posted } = await pair();
    for (const [transactionId, project] of [
      [pending.id, "kitchen"],
      [posted.id, "garden"],
    ] as const) {
      await db.editAnnotation({
        transactionId,
        expectedVersion: 0,
        metadata: { project },
      });
    }
    await expect(
      db.linkPendingTransaction(await harness.command(pending.id, posted.id)),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("treats reordered or repeated tags as no change", async () => {
    const { posted } = await pair();
    const first = await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: 0,
      tags: ["travel", "shared"],
    });
    const before = (await db.listEvents()).length;
    const second = await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: 1,
      tags: ["shared", "travel", "shared"],
    });
    expect(second).toEqual(first);
    expect((await db.listEvents()).length).toBe(before);
    expect((await db.getTransaction(posted.id))!.annotation).toMatchObject({
      version: 1,
      data: { tags: ["shared", "travel"] },
    });
  });

  // Annotations written before tags were a set may hold any tag order.
  async function storeUnsortedTags(transactionId: string) {
    await db.editAnnotation({
      transactionId,
      expectedVersion: 0,
      tags: ["shared", "travel"],
    });
    const [stored] = await db.raw(
      `SELECT data_json FROM annotations WHERE transaction_id = '${transactionId}'`,
    );
    const data = JSON.parse(String(stored!.data_json)) as { tags: string[] };
    data.tags = ["travel", "shared"];
    await db.raw(
      `UPDATE annotations SET data_json = '${JSON.stringify(data)}' WHERE transaction_id = '${transactionId}'`,
    );
  }

  it("treats tags stored in another order as the same set", async () => {
    const { pending, posted } = await pair();
    await storeUnsortedTags(posted.id);
    const before = (await db.listEvents()).length;
    const unchanged = await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: 1,
      tags: ["shared", "travel", "shared"],
    });
    expect(unchanged.version).toBe(1);
    expect((await db.listEvents()).length).toBe(before);

    const edited = await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: 1,
      notes: "split with a friend",
    });
    expect(edited).toMatchObject({
      version: 2,
      data: { tags: ["shared", "travel"] },
    });
    const undo = (await db.listEvents()).findLast(
      (event) =>
        event.type === "annotation.updated" &&
        event.transactionId === posted.id,
    )!;
    const undone = await db.undoAnnotation({
      eventId: undo.id,
      expectedVersion: 2,
    });
    expect(undone).toMatchObject({
      version: 3,
      data: { notes: null, tags: ["shared", "travel"] },
    });

    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      tags: ["shared", "travel"],
    });
    await db.linkPendingTransaction(
      await harness.command(pending.id, posted.id),
    );
    expect(
      (await db.getTransaction(pending.id))!.annotation?.data.tags,
    ).toEqual(["shared", "travel"]);
  });

  it("links a stored unsorted annotation to an equal sorted one", async () => {
    const { pending, posted } = await pair();
    await storeUnsortedTags(pending.id);
    await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: 0,
      tags: ["shared", "travel"],
    });
    await db.linkPendingTransaction(
      await harness.command(pending.id, posted.id),
    );
    // Equal as sets, so linking succeeds and leaves the stored document alone.
    const survivor = (await db.getTransaction(pending.id))!.annotation!;
    expect(survivor.version).toBe(1);
    expect([...survivor.data.tags].sort()).toEqual(["shared", "travel"]);
  });

  it("writes canonical tags when linking copies an older annotation", async () => {
    const { pending, posted } = await pair();
    await storeUnsortedTags(posted.id);
    await db.linkPendingTransaction(
      await harness.command(pending.id, posted.id),
    );
    expect((await db.getTransaction(pending.id))!.annotation).toMatchObject({
      version: 1,
      data: { tags: ["shared", "travel"] },
    });
    const copied = (await db.listEvents()).find(
      (event) =>
        event.type === "annotation.updated" &&
        event.transactionId === pending.id,
    );
    expect(copied?.after).toMatchObject({
      data: { tags: ["shared", "travel"] },
    });
  });

  it("keeps a historical review basis stale through link and unlink", async () => {
    await harness.capture(1, [authorization("auth")]);
    const approved = await harness.byKey("auth");
    await db.editAnnotation({
      transactionId: approved.id,
      expectedVersion: 0,
      expectedTransactionVersion: approved.version,
      review: { status: "approved" },
      metadata: { project: "kitchen" },
    });
    // The authorization changes after approval: its stamped basis is now historical.
    await harness.capture(2, [authorization("auth", { amountMinor: -120 })]);
    const pending = await harness.byKey("auth");
    expect(pending).toMatchObject({ version: 2, reviewStatus: "stale" });
    const basis = pending.annotation!.data.review!.basis;
    expect(basis.amountMinor).toBe(-100);

    await harness.capture(3, [
      authorization("auth", { amountMinor: -120 }),
      row("posted", { amountMinor: -120 }),
    ]);
    const posted = await harness.byKey("posted");
    await db.linkPendingTransaction(
      await harness.command(pending.id, posted.id),
    );
    const survivor = (await db.getTransaction(pending.id))!;
    // The approval is never restamped onto facts it did not cover.
    expect(survivor.annotation!.data.review).toMatchObject({
      status: "approved",
      basis,
    });
    expect(survivor).toMatchObject({
      reviewStatus: "stale",
      reviewStale: true,
    });
    expect(survivor.reviewReasons).toContain("review_stale");

    await db.unlinkPendingTransaction(
      await harness.command(pending.id, posted.id),
    );
    const restored = (await db.getTransaction(pending.id))!;
    expect(restored.annotation!.data).toEqual(survivor.annotation!.data);
    expect(restored.reviewStatus).toBe("stale");
    expect((await db.getTransaction(posted.id))!.annotation).toBeNull();
  });
});
