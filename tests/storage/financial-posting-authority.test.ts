import "../helpers/application-loading-differential.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TransactionInput } from "../../src/domain/model.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import {
  authorization,
  postingAdapter,
  postingHarness,
} from "../helpers/posting.js";
import {
  backends,
  type Harness,
  open,
  row,
} from "../helpers/storage-harness.js";

const missingComponent = "synthetic_required_component_missing";
const adapter: SourceAdapter = {
  ...postingAdapter,
  financialAuthority(input) {
    return input.details.issues.includes(missingComponent)
      ? {
          kind: "incomplete",
          reason: missingComponent,
          continuitySignature: "synthetic-ordinary-component",
        }
      : {
          kind: "asserted",
          continuitySignature: "synthetic-ordinary-component",
        };
  },
};

function incomplete(key = "posted"): TransactionInput {
  const input = row(key);
  input.details.issues.push(missingComponent);
  return input;
}

describe.each(backends)("%s financial authority and posting", (backend) => {
  let db: Harness;
  let h: ReturnType<typeof postingHarness>;
  beforeEach(async () => {
    db = await open(backend);
    h = postingHarness(db);
    await db.ensureConnection({ id: h.connectionId, provider: "cal" });
  });
  afterEach(() => db.close());

  it("keeps counted money without consuming overlap until current support returns", async () => {
    await h.capture(1, [authorization()], adapter);
    const pending = await h.byKey("pending");
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "Preserve the purchase note",
    });
    await h.capture(2, [authorization(), row("posted")], adapter);
    const posted = await h.byKey("posted");
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeDefined();
    await h.capture(3, [incomplete()], adapter);
    expect((await db.getTransaction(pending.id))!).toMatchObject({
      status: "pending",
      presence: "not_returned",
    });
    expect((await db.getTransaction(posted.id))!).toMatchObject({
      status: "posted",
      amountBasis: "purchase_commitment",
      supersededById: null,
    });
    expect(await db.getTotals()).toMatchObject({ includedCount: 1 });
    expect(
      (await db.getTransaction(pending.id))!.details.postingLink,
    ).toBeUndefined();
    await h.capture(4, [row("posted")], adapter);
    expect((await h.byKey("posted")).id).toBe(pending.id);
    expect((await db.getTransaction(pending.id))!.annotation?.data.notes).toBe(
      "Preserve the purchase note",
    );
    expect(await db.getTotals()).toMatchObject({ includedCount: 1 });
  });

  it("does not establish an overlap witness from incomplete current assertions", async () => {
    await h.capture(1, [authorization()], adapter);
    const pending = await h.byKey("pending");
    await h.capture(2, [authorization(), incomplete()], adapter);
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeUndefined();
    expect(await db.getTotals()).toMatchObject({ includedCount: 0 });
    await h.capture(3, [row("posted")], adapter);
    expect((await h.byKey("posted")).id).not.toBe(pending.id);
    expect((await db.getTransaction(pending.id))!).toMatchObject({
      status: "pending",
      presence: "not_returned",
    });
    expect(await db.getTotals()).toMatchObject({ includedCount: 1 });
  });

  it("does not continue directly from a newly incomplete posted identity", async () => {
    await h.capture(1, [authorization()], adapter);
    const pending = await h.byKey("pending");
    await h.capture(2, [incomplete()], adapter);
    expect((await h.byKey("posted")).id).not.toBe(pending.id);
    expect((await h.byKey("posted")).amountBasis).toBe("unknown");
    expect((await db.getTransaction(pending.id))!.sourceAbsence).toBeDefined();
    expect(await db.getTotals()).toMatchObject({ includedCount: 0 });
  });

  it("keeps an incomplete competing identity in the attribution component", async () => {
    await h.capture(1, [authorization()], adapter);
    const pending = await h.byKey("pending");
    await h.capture(
      2,
      [row("posted"), incomplete("competing-posted")],
      adapter,
    );
    expect((await h.byKey("posted")).id).not.toBe(pending.id);
    expect(
      (await db.getTransaction(pending.id))!.details.postingLink,
    ).toBeUndefined();
    expect(await db.getTotals()).toMatchObject({ includedCount: 1 });
  });
});
