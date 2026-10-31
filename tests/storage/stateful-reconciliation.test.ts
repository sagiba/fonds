import "../helpers/application-loading-differential.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyDetails } from "../../src/domain/model.js";
import {
  authorization,
  postingAdapter,
  postingHarness,
} from "../helpers/posting.js";
import { accounting, only, scenario } from "../helpers/scenario.js";
import {
  backends,
  type Harness,
  open,
  row,
} from "../helpers/storage-harness.js";

// Entirely invented evidence. A count is captured metadata, never inferred money.
const purchase = (count: number | null = null) =>
  row("purchase", {
    amountMinor: -18600,
    installmentCount: count,
    billingDate: "2040-07-10",
  });
const line = (ordinal = 1, count: number | null = 6) =>
  row(`line-${ordinal}`, {
    amountMinor: -3100,
    amountBasis: "booked_entry",
    installmentCount: count,
    installmentNumber: ordinal,
    purchaseKey: "purchase",
    billingDate: "2040-08-10",
  });

describe.each(backends)("%s stateful reconciliation scenarios", (backend) => {
  let db: Harness;
  let run: Awaited<ReturnType<typeof scenario>>;
  beforeEach(async () => {
    db = await open(backend);
    run = await scenario(db, backend);
  });
  afterEach(() => db.close());

  it("preserves multiplicity and associations when weak identity arrives after a native linked purchase", async () => {
    const details = {
      ...emptyDetails(),
      provider: { cal: { identity: { baseKey: "synthetic-group" } } },
    };
    const native = { ...purchase(), details };
    const initial = await run.capture(
      "native purchase and line",
      { rows: [native, line()] },
      (state) => {
        accounting(state, -18600, -3100, ["purchase"], ["line-1"]);
        expect(only(state, "line-1").purchaseId).toBe(
          only(state, "purchase").id,
        );
      },
    );
    const initialIds = initial.rows.map((row) => row.id);
    await run.capture(
      "weak member joins identity group",
      {
        rows: [
          native,
          row("weak", { identityStrength: "weak", amountMinor: -700, details }),
          line(),
        ],
      },
      (state) => {
        expect(state.rows).toHaveLength(3);
        expect(state.rows.map((row) => row.id)).toEqual(
          expect.arrayContaining(initialIds),
        );
        expect(only(state, "purchase").installmentCount).toBeNull();
        expect(only(state, "line-1").purchaseId).toBe(
          only(state, "purchase").id,
        );
        // Mixed identities legitimately require review; none may be silently counted.
        expect(state.spending).toMatchObject({
          totals: [],
          includedCount: 0,
          excludedCount: 2,
          excluded: { unresolved: 2 },
        });
        expect(state.billing).toMatchObject({
          includedCount: 1,
          excludedCount: 1,
          excluded: { unresolved: 1 },
        });
        for (const key of ["purchase", "weak"]) {
          expect(only(state, key)).toMatchObject({
            identityStrength: "ambiguous",
            reviewRequired: true,
          });
          expect(only(state, key).sourceIssues).toContain("ambiguous_identity");
        }
        expect(state.spendingMembers).toEqual(
          [only(state, "purchase").id, only(state, "weak").id].sort(),
        );
        expect(state.billingMembers).toEqual(
          [only(state, "line-1").id, only(state, "weak").id].sort(),
        );
        expect(state.billing.totals).toEqual([
          { currency: "ILS", amountBasis: null, amountMinor: -3100 },
        ]);
      },
    );
  });

  it.each(["parent first", "line first"])(
    "reconciles delayed evidence with %s and preserves newer annotations",
    async (order) => {
      const first = order === "parent first" ? [purchase()] : [line()];
      await run.capture("first observation", { rows: first }, (state) => {
        expect(state.rows).toHaveLength(1);
        if (order === "line first") {
          expect(only(state, "line-1").sourceIssues).toContain(
            "unresolved_purchase",
          );
        } else {
          accounting(state, -18600, -18600, ["purchase"], ["purchase"]);
        }
      });
      await run.capture(
        "complete association",
        { rows: [purchase(), line()] },
        (state) => {
          accounting(state, -18600, -3100, ["purchase"], ["line-1"]);
          expect(only(state, "line-1").purchaseId).toBe(
            only(state, "purchase").id,
          );
        },
      );
      const parent = await run.byKey("purchase");
      await run.step(
        "owner annotates purchase",
        { annotate: "purchase" },
        () =>
          db.editAnnotation({
            transactionId: parent.id,
            expectedVersion: 0,
            notes: "Synthetic owner note",
            category: "Test equipment",
          }),
        (state) => {
          expect(only(state, "purchase").annotation?.data.notes).toBe(
            "Synthetic owner note",
          );
        },
      );
      await run.capture(
        "historical backfill carries older parent facts",
        {
          history: true,
          rows: [
            {
              ...purchase(6),
              amountMinor: -18000,
              description: "Older synthetic description",
            },
            line(),
            line(2),
          ],
        },
        (state) => {
          expect(only(state, "purchase")).toMatchObject({
            id: parent.id,
            amountMinor: -18600,
            installmentCount: null,
            description: "Synthetic",
          });
          expect(only(state, "purchase").annotation?.data.notes).toBe(
            "Synthetic owner note",
          );
          accounting(state, -18600, -6200, ["purchase"], ["line-1", "line-2"]);
        },
      );
      await run.capture(
        "recent purchase omits historical lines",
        { rows: [purchase()] },
        (state) => {
          accounting(state, -18600, -6200, ["purchase"], ["line-1", "line-2"]);
          expect(only(state, "purchase").annotation?.data.notes).toBe(
            "Synthetic owner note",
          );
        },
      );
    },
  );

  it("distinguishes incomplete absence, not-returned retention, owner removal and fresh restoration", async () => {
    const extra = row("extra", { amountMinor: -500 });
    const both = (state: Parameters<typeof accounting>[0]) =>
      accounting(
        state,
        -19100,
        -3600,
        ["purchase", "extra"],
        ["line-1", "extra"],
      );
    await run.capture(
      "all rows observed",
      { rows: [purchase(), line(), extra] },
      both,
    );
    await run.capture(
      "incomplete response omits line and extra",
      { rows: [purchase()], incomplete: true },
      (state) => {
        both(state);
        expect(only(state, "extra").presence).toBe("seen");
      },
    );
    await run.capture(
      "comparable response omits line and extra",
      { rows: [purchase()] },
      (state) => {
        accounting(state, -18600, -3100, ["purchase"], ["line-1"]);
        expect(only(state, "extra").presence).toBe("not_returned");
        expect(only(state, "line-1").purchaseId).toBe(
          only(state, "purchase").id,
        );
      },
    );
    const child = await run.byKey("line-1");
    await run.step(
      "owner removes line",
      { remove: "line-1" },
      () =>
        db.confirmRemoval({
          transactionId: child.id,
          expectedVersion: child.version,
          reason: "Synthetic duplicate evidence removed",
        }),
      (state) => {
        expect(only(state, "line-1").presence).toBe("removed");
        expect(state.billing.totals).toEqual([
          { currency: "ILS", amountBasis: null, amountMinor: -18600 },
        ]);
      },
    );
    await run.capture(
      "absence does not restore removed line",
      { rows: [purchase()] },
      (state) => {
        expect(only(state, "line-1").presence).toBe("removed");
        expect(state.billing.totals).toEqual([
          { currency: "ILS", amountBasis: null, amountMinor: -18600 },
        ]);
      },
    );
    await run.capture(
      "fresh positive evidence restores line",
      { rows: [purchase(), line(), extra] },
      (state) => {
        both(state);
        expect(only(state, "line-1")).toMatchObject({
          id: child.id,
          presence: "seen",
        });
      },
    );
  });

  it("retains line conflict through incomplete captures and clears only that reason after owner removal", async () => {
    const parent = {
      ...purchase(6),
      details: { ...emptyDetails(), issues: ["conflicting_payment_context"] },
    };
    const good = line();
    const bad = line(2, 7);
    const conflict = (state: Parameters<typeof accounting>[0]) => {
      expect(only(state, "purchase").sourceIssues).toEqual(
        expect.arrayContaining([
          "conflicting_payment_context",
          "conflicting_installment_lines",
          "conflicting_installment_plan",
        ]),
      );
      accounting(state, -18600, -6200, ["purchase"], ["line-1", "line-2"]);
    };
    await run.capture(
      "conflicting line arrives",
      { rows: [parent, good, bad] },
      conflict,
    );
    await run.capture(
      "incomplete capture cannot resolve missing conflict",
      { rows: [parent, good], incomplete: true },
      conflict,
    );
    const child = await run.byKey("line-2");
    const resolved = (state: Parameters<typeof accounting>[0]) => {
      expect(only(state, "purchase").sourceIssues).toEqual([
        "conflicting_payment_context",
      ]);
      expect(only(state, "purchase").reviewRequired).toBe(true);
      expect(state.billing.totals).toEqual([
        { currency: "ILS", amountBasis: null, amountMinor: -3100 },
      ]);
    };
    await run.step(
      "owner removes conflicting line",
      { remove: "line-2" },
      () =>
        db.confirmRemoval({
          transactionId: child.id,
          expectedVersion: child.version,
          reason: "Synthetic conflicting evidence removed",
        }),
      (state, before) => {
        resolved(state);
        expect(
          state.events
            .slice(before.events.length)
            .filter(
              (event) =>
                event.type === "transaction.review_resolved" &&
                event.transactionId === only(state, "purchase").id,
            ),
        ).toHaveLength(0);
      },
    );
    await run.capture(
      "remaining line replays after owner decision",
      { rows: [parent, good] },
      resolved,
    );
  });

  it("keeps explicit restatement held until fresh source evidence after removal", async () => {
    await run.capture("known plan", { rows: [purchase(6), line()] }, (state) =>
      accounting(state, -18600, -3100, ["purchase"], ["line-1"]),
    );
    const restated = { ...purchase(1), amountMinor: -20100 };
    await run.capture(
      "single-payment contradiction",
      { rows: [restated] },
      (state) => {
        expect(only(state, "purchase").amountMinor).toBe(-18600);
        expect(only(state, "purchase").sourceIssues).toContain(
          "conflicting_installment_restatement",
        );
      },
    );
    const child = await run.byKey("line-1");
    await run.step(
      "owner removes remaining line",
      { remove: "line-1" },
      () =>
        db.confirmRemoval({
          transactionId: child.id,
          expectedVersion: child.version,
          reason: "Synthetic plan correction",
        }),
      (state) => {
        expect(only(state, "purchase").sourceIssues).toContain(
          "conflicting_installment_restatement",
        );
        expect(only(state, "purchase").amountMinor).toBe(-18600);
      },
    );
    await run.capture(
      "fresh source accepts non-plan",
      { rows: [restated] },
      (state) => {
        expect(only(state, "purchase")).toMatchObject({
          amountMinor: -20100,
          installmentCount: 1,
          sourceIssues: [],
        });
        expect(state.spending.totals).toEqual([
          {
            currency: "ILS",
            amountBasis: "purchase_commitment",
            amountMinor: -20100,
          },
        ]);
        expect(state.billing.totals).toEqual([
          { currency: "ILS", amountBasis: null, amountMinor: -20100 },
        ]);
      },
    );
  });

  it.each([false, true])(
    "combines automatic posting with line correction in a fresh capture (reverse=%s)",
    async (reverse) => {
      const pending = authorization("authorization", {
        amountMinor: -1250,
        merchantName: "Synthetic Grocer",
      });
      await run.capture(
        "pending and conflicted plan",
        { rows: [pending, purchase(6), line(1, 7)], adapter: postingAdapter },
        (state) => {
          expect(only(state, "purchase").sourceIssues).toContain(
            "conflicting_installment_lines",
          );
          expect(state.spending.excluded.pending).toBe(1);
        },
      );
      const pendingId = (await run.byKey("authorization")).id;
      const before = await run.snapshot();
      const rows = [
        row("posted", { amountMinor: -1250, merchantName: "Synthetic Grocer" }),
        purchase(6),
        line(),
      ];
      const after = await run.capture(
        "posting and corrected line",
        { rows: reverse ? rows.toReversed() : rows, adapter: postingAdapter },
        (state) => {
          expect(only(state, "posted").id).toBe(pendingId);
          expect(only(state, "purchase").sourceIssues).toEqual([]);
          accounting(
            state,
            -19850,
            -4350,
            ["purchase", "posted"],
            ["line-1", "posted"],
          );
        },
      );
      const events = after.events.slice(before.events.length);
      expect(
        events
          .filter(
            (event) =>
              event.type === "transaction.review_resolved" &&
              event.transactionId === only(after, "purchase").id,
          )
          .map((event) => event.actor),
      ).toEqual(["sync"]);
      expect(
        events.filter((event) => event.type === "transaction.posted"),
      ).toHaveLength(1);
    },
  );

  it("does not substitute principal for duplicate held bills, and releases a surviving line only from fresh evidence", async () => {
    const duplicate = { ...line(), sourceKey: "duplicate", amountMinor: -2900 };
    await run.capture(
      "duplicate ordinal held",
      { rows: [purchase(), line(), duplicate] },
      (state) => {
        accounting(state, -18600, null, ["purchase"], ["line-1", "duplicate"]);
        expect(state.billing).toMatchObject({
          includedCount: 0,
          excludedCount: 2,
          excluded: { unresolved: 2 },
        });
        for (const key of ["line-1", "duplicate"]) {
          expect(only(state, key).amountMinor).toBeNull();
          expect(only(state, key).sourceIssues).toContain(
            "duplicate_installment_ordinal",
          );
        }
      },
    );
    const duplicateRow = await run.byKey("duplicate");
    await run.step(
      "owner removes duplicate",
      { remove: "duplicate" },
      () =>
        db.confirmRemoval({
          transactionId: duplicateRow.id,
          expectedVersion: duplicateRow.version,
          reason: "Synthetic duplicate ordinal",
        }),
      (state) => {
        expect(only(state, "duplicate").presence).toBe("removed");
        expect(only(state, "purchase").installmentCount).toBeNull();
        expect(only(state, "line-1").amountMinor).toBeNull();
        expect(only(state, "line-1").sourceIssues).toContain(
          "duplicate_installment_ordinal",
        );
        expect(state.billing).toMatchObject({
          totals: [],
          includedCount: 0,
          excluded: { unresolved: 1 },
        });
      },
    );
    await run.capture(
      "fresh surviving line releases held amount",
      { rows: [purchase(), line()] },
      (state) => {
        expect(only(state, "line-1").amountMinor).toBe(-3100);
        expect(state.billing.totals).toEqual([
          { currency: "ILS", amountBasis: null, amountMinor: -3100 },
        ]);
        expect(only(state, "line-1").sourceIssues).not.toContain(
          "duplicate_installment_ordinal",
        );
      },
    );
  });

  it("preserves owner posting decisions and notes across later lines, unlinking and replay", async () => {
    const pending = authorization("authorization", { amountMinor: -18600 });
    await run.capture(
      "separate authorization and plan",
      { rows: [pending, purchase(6), line()], adapter: postingAdapter },
      (state) => {
        expect(state.rows).toHaveLength(3);
        expect(state.spending.excluded.pending).toBe(1);
      },
    );
    const auth = await run.byKey("authorization");
    const posted = await run.byKey("purchase");
    await run.step(
      "annotate authorization",
      { annotate: "authorization" },
      () =>
        db.editAnnotation({
          transactionId: auth.id,
          expectedVersion: 0,
          notes: "Synthetic linked purchase note",
        }),
      (state) => {
        expect(only(state, "authorization").annotation?.data.notes).toBe(
          "Synthetic linked purchase note",
        );
      },
    );
    const posting = postingHarness(db);
    await run.step(
      "owner links authorization to plan",
      { link: [auth.id, posted.id] },
      async () =>
        db.linkPendingTransaction(await posting.command(auth.id, posted.id)),
      (state) => {
        expect(only(state, "line-1").purchaseId).toBe(auth.id);
        expect(
          state.rows.find((row) => row.id === posted.id)?.supersededById,
        ).toBe(auth.id);
        expect(
          state.rows.find((row) => row.id === auth.id)?.annotation?.data.notes,
        ).toBe("Synthetic linked purchase note");
      },
    );
    await run.capture(
      "later line follows linked survivor",
      { rows: [purchase(6), line(), line(2)], adapter: postingAdapter },
      (state) => {
        for (const key of ["line-1", "line-2"]) {
          expect(only(state, key).purchaseId).toBe(auth.id);
        }
        accounting(state, -18600, -6200, ["purchase"], ["line-1", "line-2"]);
      },
    );
    await run.step(
      "owner undoes posting link",
      { unlink: [auth.id, posted.id] },
      async () =>
        db.unlinkPendingTransaction(await posting.command(auth.id, posted.id)),
      (state) => {
        for (const key of ["line-1", "line-2"]) {
          expect(only(state, key).purchaseId).toBe(posted.id);
        }
        expect(
          state.rows.find((row) => row.id === auth.id)?.annotation?.data.notes,
        ).toBe("Synthetic linked purchase note");
      },
    );
    await run.capture(
      "later source keeps owner split",
      {
        rows: [purchase(6), line(), line(2), line(3)],
        adapter: postingAdapter,
      },
      (state) => {
        expect(only(state, "purchase").id).toBe(posted.id);
        for (const key of ["authorization", "purchase"]) {
          expect(only(state, key).pendingPostingCandidates).toEqual([]);
          expect(only(state, key).sourceIssues).not.toContain(
            "possible_pending_posted_match",
          );
        }
        for (const key of ["line-1", "line-2", "line-3"]) {
          expect(only(state, key).purchaseId).toBe(posted.id);
        }
        expect(state.billing.totals).toEqual([
          { currency: "ILS", amountBasis: null, amountMinor: -9300 },
        ]);
        expect(state.spending.totals).toEqual([
          {
            currency: "ILS",
            amountBasis: "purchase_commitment",
            amountMinor: -18600,
          },
        ]);
      },
    );
  });

  it("accepts valid rows from a partial invalid capture, then retries corrected evidence without identity churn", async () => {
    await run.capture(
      "existing conflicted plan",
      { rows: [purchase(6), line(1, 7)] },
      (state) => {
        expect(only(state, "purchase").sourceIssues).toContain(
          "conflicting_installment_lines",
        );
      },
    );
    const partial = await run.capture(
      "valid correction alongside invalid money",
      {
        rows: [line(), row("retry", { amountMinor: 0.5 })],
        expectedStatus: "partial",
        expectedUnlisted: 0,
      },
      (state) => {
        expect(state.rows).toHaveLength(2);
        expect(only(state, "purchase").presence).toBe("seen");
        expect(only(state, "purchase").sourceIssues).toEqual([]);
        accounting(state, -18600, -3100, ["purchase"], ["line-1"]);
      },
    );
    await run.capture(
      "corrected retry",
      {
        rows: [line(), row("retry", { amountMinor: -450 })],
        expectedStatus: "completed",
      },
      (state) => {
        expect(only(state, "purchase").presence).toBe("not_returned");
        expect(state.rows.map((row) => row.id)).toEqual(
          expect.arrayContaining(partial.rows.map((row) => row.id)),
        );
        accounting(state, -450, -3550, ["retry"], ["line-1", "retry"]);
      },
    );
  });
});
