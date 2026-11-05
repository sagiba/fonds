import "../helpers/application-loading-differential.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonObject, TransactionInput } from "../../src/domain/model.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { calInstallmentSource } from "../../src/providers/cal/posting-evidence.js";
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

const providerVeto: SourceAdapter = {
  ...postingAdapter,
  automaticPosting: {
    ...postingAdapter.automaticPosting!,
    compatibleGroups: () => false,
  },
};

describe.each(backends)("%s unique exact posting", (backend) => {
  let db: Harness;
  let h: ReturnType<typeof postingHarness>;
  beforeEach(async () => {
    db = await open(backend);
    h = postingHarness(db);
    await db.ensureConnection({ id: h.connectionId, provider: "cal" });
  });
  afterEach(async () => db.close());

  it("links a unique first arrival when the authorization disappears, preserving its annotation", async () => {
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    const annotation = await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "Synthetic note",
    });
    await h.capture(3, [row("posted")], providerVeto);
    const survivor = await h.byKey("posted");
    expect(survivor).toMatchObject({
      id: pending.id,
      status: "posted",
      annotation,
      details: {
        postingLink: { automatic: true, policyVersion: "exact-unique-v1" },
      },
    });
    await h.capture(4, [row("posted")], providerVeto);
    expect(
      (await db.listEvents()).filter((e) => e.type === "transaction.linked"),
    ).toHaveLength(1);
  });

  it("does not link while the authorization is still returned", async () => {
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    await h.capture(3, [authorization(), row("posted")], providerVeto);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
  });

  it("does not apply the heuristic without provider opt-in", async () => {
    const noOptIn: SourceAdapter = {
      ...providerVeto,
      automaticPosting: {
        ...providerVeto.automaticPosting!,
        exactNameHeuristic: false,
      },
    };
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    await h.capture(3, [row("posted")], noOptIn);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
  });

  it("accepts a unique CAL pair despite differing source wallet metadata", async () => {
    const differingWallet: SourceAdapter = {
      ...postingAdapter,
      extract(text, context) {
        const result = postingAdapter.extract(text, context);
        for (const transaction of result.transactions) {
          if (transaction.status === "posted") {
            const evidence = transaction.details.provider.cal!;
            const rows = evidence.rows as { walletTranInd: string }[];
            rows[0]!.walletTranInd = "2";
          }
        }
        return result;
      },
    };
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    await h.capture(3, [row("posted")], differingWallet);
    expect(await h.byKey("posted")).toMatchObject({
      id: pending.id,
      details: {
        postingLink: { automatic: true, policyVersion: "exact-unique-v1" },
      },
    });
  });

  it("keeps a stated CAL installment contradiction from linking", async () => {
    const installment: SourceAdapter = {
      ...providerVeto,
      automaticPosting: {
        ...providerVeto.automaticPosting!,
        exactNameHeuristic: true,
        exactNameContradiction: calInstallmentSource,
      },
      extract(text, context) {
        const result = postingAdapter.extract(text, context);
        for (const input of result.transactions) {
          if (input.status === "pending") {
            const [source] = input.details.provider.cal!.rows as JsonObject[];
            source!.trnTypeCode = "8";
          }
        }
        return result;
      },
    };
    await h.capture(2, [authorization()], installment);
    const pending = await h.byKey("pending");
    await h.capture(3, [row("posted")], installment);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
  });
  it("does not apply the exact heuristic to twins, equal or distinct", async () => {
    await h.capture(2, [authorization("a"), authorization("b")]);
    const first = await h.byKey("a");
    await h.capture(3, [row("c"), row("d")], providerVeto);
    expect((await db.getTransaction(first.id))!.status).toBe("pending");
    expect(
      (await db.listEvents()).filter((e) => e.type === "transaction.linked"),
    ).toHaveLength(0);
  });
  it("labels only the heuristic pair as heuristic", async () => {
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    await h.capture(3, [row("posted")]);
    const link = (await db.getTransaction(pending.id))!.details.postingLink!;
    expect(link.policyVersion).not.toBe("exact-unique-v1");
  });
  it("does not infer a match with contradictory financial evidence", async () => {
    const details = row("posted").details;
    details.issues.push("conflicting_original_amount");
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    await h.capture(3, [row("posted", { details })], providerVeto);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
  });

  it.each([
    ["merchant", { merchantName: "Different merchant" }],
    ["date", { transactionDate: "2040-07-02" }],
    ["amount", { amountMinor: -125 }],
    ["card", { cardKey: "another-card" }],
    ["installment ordinal", { installmentNumber: 1 }],
  ] satisfies [string, Partial<TransactionInput>][])(
    "does not match when %s differs or is unsupported",
    async (_name, fields) => {
      await h.capture(2, [authorization()]);
      const pending = await h.byKey("pending");
      await h.capture(3, [row("posted", fields)], providerVeto);
      expect((await db.getTransaction(pending.id))!.status).toBe("pending");
    },
  );

  it("leaves competing same-day purchases for review", async () => {
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    await h.capture(3, [row("posted"), row("other")], providerVeto);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
  });

  it("does not relink a pair after an explicit unlink", async () => {
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    await h.capture(3, [row("posted")], providerVeto);
    const retired = (
      await db.listTransactions({ includeSuperseded: true })
    ).find((r) => r.supersededById === pending.id)!;
    await db.unlinkPendingTransaction(await h.command(pending.id, retired.id));
    await h.capture(4, [authorization(), row("posted")], providerVeto);
    await h.capture(5, [row("posted")], providerVeto);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
  });
  it.each([
    "conflicting_original_amount",
    "conflicting_original_currency",
    "ambiguous_identity",
    "unverified_amount_basis",
  ])("blocks %s despite matching visible fields", async (issue) => {
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    const posted = row("posted");
    posted.details.issues.push(issue);
    await h.capture(3, [posted], providerVeto);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
  });
  it("keeps a financially ineligible same-key competitor as a uniqueness blocker", async () => {
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    await h.capture(
      3,
      [
        row("posted"),
        row("competitor", { kind: "unknown", amountBasis: "unknown" }),
      ],
      providerVeto,
    );
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
  });
  it("normalizes whitespace but never treats punctuation-only names as identity", async () => {
    await h.capture(2, [
      authorization("pending", { merchantName: "  Synthetic   Merchant " }),
    ]);
    const pending = await h.byKey("pending");
    await h.capture(
      3,
      [row("posted", { merchantName: "Synthetic Merchant" })],
      providerVeto,
    );
    expect((await h.byKey("posted")).id).toBe(pending.id);
    await h.capture(4, [
      row("posted", { merchantName: "Synthetic Merchant" }),
      authorization("punctuation", { merchantName: "---", amountMinor: -200 }),
    ]);
    const other = await h.byKey("punctuation");
    await h.capture(
      5,
      [
        row("posted", { merchantName: "Synthetic Merchant" }),
        row("punctuation-posted", { merchantName: "---", amountMinor: -200 }),
      ],
      providerVeto,
    );
    expect((await db.getTransaction(other.id))!.status).toBe("pending");
  });
  it("does not backfill an existing posted identity through first-arrival policy", async () => {
    const { automaticPosting: _, ...manual } = postingAdapter;
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    await h.capture(3, [row("posted")], manual);
    await h.capture(4, [row("posted")], providerVeto);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
  });
  it("rolls back exact linking and its source application, then recovers once", async () => {
    await h.capture(2, [authorization()]);
    const pending = await h.byKey("pending");
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "Retain on rollback",
    });
    const before = await h.state();
    if (backend === "postgres") {
      await db.raw(
        "CREATE FUNCTION reject_exact_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'transaction.linked' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$",
      );
      await db.raw(
        "CREATE TRIGGER reject_exact_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_exact_audit()",
      );
    } else {
      await db.raw(
        "CREATE TRIGGER reject_exact_audit BEFORE INSERT ON events WHEN NEW.type = 'transaction.linked' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END",
      );
    }
    await expect(h.capture(3, [row("posted")], providerVeto)).rejects.toThrow();
    expect(await h.state()).toEqual(before);
    await db.raw(
      backend === "postgres"
        ? "DROP TRIGGER reject_exact_audit ON events"
        : "DROP TRIGGER reject_exact_audit",
    );
    await db.applyRun("posting-3", providerVeto);
    expect((await h.byKey("posted")).id).toBe(pending.id);
    const recovered = await h.state();
    await db.applyRun("posting-3", providerVeto);
    expect(await h.state()).toEqual(recovered);
  });
});
