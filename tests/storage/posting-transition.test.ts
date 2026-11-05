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

describe.each(backends)("%s disappearance witness", (backend) => {
  let db: Harness;
  let h: ReturnType<typeof postingHarness>;
  beforeEach(async () => {
    db = await open(backend);
    h = postingHarness(db);
    await db.ensureConnection({ id: h.connectionId, provider: "cal" });
  });
  afterEach(async () => db.close());
  const unknown = () =>
    row("posted", { kind: "unknown", amountBasis: "unknown" });

  async function start() {
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    await h.capture(3, [unknown()]);
    const posted = await h.byKey("posted");
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeDefined();
    return { pending, posted };
  }

  async function noLink(id: string) {
    expect((await db.getTransaction(id))!.status).toBe("pending");
    expect(
      (await db.listEvents()).filter((e) => e.type === "transaction.linked"),
    ).toHaveLength(0);
  }

  it("permanently revokes after pending reappearance", async () => {
    const { pending } = await start();
    await h.capture(4, [authorization(), unknown()]);
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeUndefined();
    await h.capture(5, [row("posted")]);
    await noLink(pending.id);
  });
  it.each([
    ["money", { amountMinor: -150 }],
    ["date", { transactionDate: "2040-07-02" }],
    ["merchant", { merchantName: "Another Merchant" }],
    ["card", { cardKey: "different-card" }],
  ] satisfies [string, Partial<TransactionInput>][])(
    "permanently revokes after posted %s correction",
    async (_name, change) => {
      const { pending } = await start();
      await h.capture(4, [
        row("posted", { ...change, kind: "unknown", amountBasis: "unknown" }),
      ]);
      expect(
        (await db.getTransaction(pending.id))!.details.postingOverlap,
      ).toBeUndefined();
      await h.capture(5, [row("posted")]);
      await noLink(pending.id);
    },
  );
  it.each(["pending", "posted"] as const)(
    "permanently revokes after competing %s arrives",
    async (status) => {
      const { pending } = await start();
      const competitor =
        status === "pending"
          ? authorization("competitor")
          : row("competitor", { kind: "unknown", amountBasis: "unknown" });
      await h.capture(4, [unknown(), competitor]);
      expect(
        (await db.getTransaction(pending.id))!.details.postingOverlap,
      ).toBeUndefined();
      await h.capture(5, [row("posted"), { ...competitor, amountMinor: -150 }]);
      await noLink(pending.id);
    },
  );
  it("cannot retroactively witness an old posting", async () => {
    const { automaticPosting: _, ...manual } = postingAdapter;
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    await h.capture(3, [unknown()], manual);
    await h.capture(4, [row("posted")]);
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeUndefined();
    await noLink(pending.id);
  });
  it("does not spend a witness in the capture that created it", async () => {
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    // A shared base key makes same-capture continuation refuse the sibling group.
    const siblings: SourceAdapter = {
      ...postingAdapter,
      extract(text, context) {
        const result = postingAdapter.extract(text, context);
        for (const input of result.transactions) {
          input.details.provider.cal!.identity = { baseKey: "shared" };
        }
        return result;
      },
    };
    await h.capture(
      3,
      [row("posted"), row("sibling", { amountMinor: -150 })],
      siblings,
    );
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeDefined();
    await noLink(pending.id);
  });
  it("does not witness an authorization outside the comparable window", async () => {
    await h.capture(2, [
      authorization("pending", { transactionDate: "2039-12-01" }),
    ]);
    const pending = await h.byKey("pending");
    await h.capture(3, [
      row("posted", {
        transactionDate: "2039-12-01",
        kind: "unknown",
        amountBasis: "unknown",
      }),
    ]);
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeUndefined();
    await noLink(pending.id);
  });
  it("does not witness a posting that arrives after an earlier absence", async () => {
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    await h.capture(3, []);
    await h.capture(4, [unknown()]);
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeUndefined();
    await noLink(pending.id);
  });
  it("does not link with incompatible provider evidence", async () => {
    await h.capture(2, [
      authorization("pending", { merchantName: "Merchant A" }),
    ]);
    const pending = await h.byKey("pending");
    await h.capture(3, [
      row("posted", {
        merchantName: "Merchant B",
        kind: "unknown",
        amountBasis: "unknown",
      }),
    ]);
    await h.capture(4, [row("posted", { merchantName: "Merchant B" })]);
    await noLink(pending.id);
  });
  it("does not re-link after explicit owner unlink", async () => {
    const { pending, posted } = await start();
    await h.capture(4, [row("posted")]);
    const command = await h.command(pending.id, posted.id);
    await db.unlinkPendingTransaction(command);
    await h.capture(5, [row("posted")]);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
    expect((await db.getTransaction(posted.id))!.supersededById).toBeNull();
    expect(
      (await db.listEvents()).filter((e) => e.type === "transaction.linked"),
    ).toHaveLength(1);
  });
});
